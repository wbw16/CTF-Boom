import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { submitCandidate } from "../src/candidate-submission.ts"
import { requestConsultation } from "../src/consultation-request.ts"
import { runChallenge, type RunEvent } from "../src/session.ts"
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeMessage,
  RuntimePrompt,
  RuntimePromptResult,
} from "../src/runtime-contract.ts"

type PromptResult = RuntimePromptResult

const finished: PromptResult = {
  usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0.25,
  finish: "stop",
  parts: [{ type: "text", text: "FINAL_FLAG: flag{mocked}" }],
}

let promptBodies: RuntimePrompt[] = []
let abortCalls = 0
let subscribeCalls = 0
let pendingCreate = false
let pendingPrompt = false
let resolveCreate: (() => void) | undefined
let resolvePrompt: ((value: PromptResult) => void) | undefined
let eventStream: AsyncIterable<RuntimeEvent>
let promptResults: Array<PromptResult | Error> = []
let activeContextMessages: RuntimeMessage[] = []
let activeContextCalls = 0
let resumeCalls: string[] = []
let subscribeFailures = 0
/** Liveness probe answer for the no-activity watchdog; undefined = probe absent. */
let busyProbe: boolean | undefined = undefined
let busyProbeCalls = 0
let busyProbeDelayMs = 0
const temporary: string[] = []

afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

function fakeConversation(id = "session-1") {
  return {
    id,
    async events() {
      subscribeCalls += 1
      if (subscribeFailures > 0) {
        subscribeFailures -= 1
        throw new Error("event subscription failed")
      }
      return eventStream
    },
    async prompt(request: RuntimePrompt) {
      promptBodies.push(request)
      if (!pendingPrompt) {
        const result = promptResults.shift() ?? finished
        if (result instanceof Error) throw result
        return result
      }
      return new Promise<PromptResult>((resolve) => { resolvePrompt = resolve })
    },
    async abort() {
      abortCalls += 1
      resolvePrompt?.(finished)
    },
    async activeContext() {
      activeContextCalls += 1
      return activeContextMessages
    },
    ...(busyProbe === undefined ? {} : {
      async isBusy() {
        busyProbeCalls += 1
        const answer = busyProbe === true
        if (busyProbeDelayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, busyProbeDelayMs))
        return answer
      },
    }),
  }
}

const runtime: AgentRuntime = {
  async createConversation() {
    if (pendingCreate) await new Promise<void>((resolve) => { resolveCreate = resolve })
    return fakeConversation()
  },
  async resumeConversation(input) {
    resumeCalls.push(input.id)
    return fakeConversation(input.id)
  },
}

function events(items: RuntimeEvent[] = []): AsyncIterable<RuntimeEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items
    },
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    runtime,
    challenge: {
      slug: "mocked",
      directory: "/tmp/mock-source",
      description: "",
      files: [],
      flagFormat: "",
    },
    workspace: {
      directory: "/tmp/mock-workspace-does-not-exist",
      runID: "mock-run",
      extracted: [],
    },
    model: "free/test",
    limits: { tokens: 1_000, repeats: 5, timeout: 10_000 },
    ...overrides,
  }
}

beforeEach(() => {
  promptBodies = []
  abortCalls = 0
  subscribeCalls = 0
  pendingCreate = false
  pendingPrompt = false
  resolveCreate = undefined
  resolvePrompt = undefined
  eventStream = events()
  promptResults = []
  activeContextMessages = []
  activeContextCalls = 0
  resumeCalls = []
  subscribeFailures = 0
  busyProbe = undefined
  busyProbeCalls = 0
  busyProbeDelayMs = 0
})

describe("runChallenge integration seam", () => {
  test("passes the hint to the first prompt and forwards normalized runtime events", async () => {
    eventStream = events([
      {
        type: "text-delta",
        sessionID: "session-1",
        delta: "正在检查",
      },
      {
        type: "tool-state",
        sessionID: "session-1",
        callID: "call-1",
        tool: "bash",
        state: { status: "running", input: { command: "file challenge/*" } },
      },
      {
        type: "step-finish",
        sessionID: "session-1",
        reason: "stop",
        cost: 0.25,
        usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ])
    const seen: RunEvent[] = []

    const outcome = await runChallenge(
      input({
        hint: "  先检查文件类型  ",
        onEvent: (event: RunEvent) => seen.push(event),
      }),
    )

    const firstPrompt = promptBodies[0]!
    expect(firstPrompt.text).toEndWith("User-added hint: 先检查文件类型")
    expect(seen.map((event) => event.type)).toEqual(["session", "text", "tool", "usage", "status"])
    expect(seen.find((event) => event.type === "usage")).toMatchObject({
      tokens: 12,
      billable: 12,
      cost: 0.25,
    })
    expect(outcome).toMatchObject({
      stop: "completed",
      candidates: [],
    })
  })

  test("accepts only the current session's structured candidate slot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-session-submit-"))
    temporary.push(directory)
    await mkdir(path.join(directory, "work"))
    await submitCandidate({
      directory,
      sessionID: "session-1",
      candidate: "flag{from_slot}",
    })

    const outcome = await runChallenge(input({
      workspace: { directory, runID: "mock-run", extracted: [] },
    }))

    expect(outcome).toMatchObject({
      candidates: ["flag{from_slot}"],
      primaryCandidate: "flag{from_slot}",
      candidateSource: "submission",
    })
    expect(outcome.verification).toBeUndefined()
  })

  test("ends the solver turn as soon as ctf-submit completes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-session-immediate-submit-"))
    temporary.push(directory)
    await mkdir(path.join(directory, "work"))
    pendingPrompt = true
    eventStream = {
      async *[Symbol.asyncIterator]() {
        while (promptBodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        await submitCandidate({
          directory,
          sessionID: "session-1",
          candidate: "flag{immediate}",
        })
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "submit-1",
          tool: "ctf-submit",
          state: { status: "completed", title: "stored" },
        } as RuntimeEvent
      },
    }

    const outcome = await runChallenge(input({
      workspace: { directory, runID: "mock-run", extracted: [] },
    }))

    expect(abortCalls).toBe(1)
    expect(outcome).toMatchObject({
      stop: "completed",
      candidates: ["flag{immediate}"],
      primaryCandidate: "flag{immediate}",
      detail: "candidate submitted; solver turn ended for platform or user verification",
    })
  })

  test("ends the turn and returns a session-scoped proactive consultation request", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-session-immediate-consult-"))
    temporary.push(directory)
    await mkdir(path.join(directory, "work"))
    pendingPrompt = true
    eventStream = {
      async *[Symbol.asyncIterator]() {
        while (promptBodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        await requestConsultation({
          directory,
          sessionID: "session-1",
          reason: "Two remaining hypotheses need an independent experimental plan.",
        })
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "consult-1",
          tool: "ctf-consult",
          state: { status: "completed", title: "stored" },
        } as RuntimeEvent
      },
    }

    const outcome = await runChallenge(input({
      workspace: { directory, runID: "mock-run", extracted: [] },
    }))

    expect(abortCalls).toBe(1)
    expect(outcome).toMatchObject({
      stop: "completed",
      detail: "solver requested an independent multi-model consultation",
      consultationRequest: {
        trigger: "agent-request",
        reason: "Two remaining hypotheses need an independent experimental plan.",
        resumeSessionID: "session-1",
      },
    })
    expect(activeContextCalls).toBe(1)
  })

  test("turns every completed context compaction into a mandatory consultation transition", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-session-compaction-"))
    temporary.push(directory)
    await mkdir(path.join(directory, "work"))
    pendingPrompt = true
    activeContextMessages = [{
      id: "compact-1",
      role: "compaction",
      parts: [
        { type: "summary", text: "Tried XOR key 0x41; ELF hypothesis was ruled out." },
        { type: "recent", text: "Next inspect the final PCAP stream." },
      ],
    }]
    eventStream = {
      async *[Symbol.asyncIterator]() {
        while (promptBodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        yield {
          type: "compaction",
          sessionID: "session-1",
          state: "completed",
        } as RuntimeEvent
      },
    }
    const seen: RunEvent[] = []

    const outcome = await runChallenge(input({
      workspace: { directory, runID: "mock-run", extracted: [] },
      onEvent: (event: RunEvent) => seen.push(event),
    }))

    expect(abortCalls).toBe(1)
    expect(outcome).toMatchObject({
      stop: "completed",
      compactions: 1,
      consultationRequest: {
        trigger: "compaction",
        resumeSessionID: "session-1",
        history: [expect.objectContaining({ id: "compact-1", role: "compaction" })],
      },
    })
    expect(activeContextCalls).toBe(1)
    expect(seen).toContainEqual(expect.objectContaining({
      type: "status",
      status: "context.compaction.completed",
    }))
  })

  test("records and honors a direct-resume compaction policy", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-session-compact-direct-"))
    temporary.push(directory)
    await mkdir(path.join(directory, "work"))
    activeContextMessages = [{
      id: "after-compact",
      role: "compaction",
      parts: [{ type: "summary", text: "continue directly" }],
    }]
    eventStream = events([{
      type: "compaction",
      sessionID: "session-1",
      state: "completed",
    }])

    const outcome = await runChallenge(input({
      workspace: { directory, runID: "mock-run", extracted: [] },
      consultOnCompaction: false,
    }))

    expect(abortCalls).toBe(0)
    expect(outcome).toMatchObject({
      stop: "completed",
      compactions: 1,
      consultOnCompaction: false,
    })
    expect(outcome.consultationRequest).toBeUndefined()
  })

  test("resumes the requested durable conversation instead of creating a new one", async () => {
    const outcome = await runChallenge(input({ resumeSessionID: "session-1" }))

    expect(resumeCalls).toEqual(["session-1"])
    expect(outcome.stop).toBe("completed")
  })

  test("aborts the live runtime conversation when an external signal fires", async () => {
    pendingPrompt = true
    const controller = new AbortController()
    const seen: RunEvent[] = []
    const running = runChallenge(
      input({
        signal: controller.signal,
        onEvent: (event: RunEvent) => seen.push(event),
      }),
    )

    while (promptBodies.length === 0) await Promise.resolve()
    controller.abort()
    const outcome = await running

    expect(abortCalls).toBe(1)
    expect(outcome.stop).toBe("aborted")
    expect(outcome.detail).toBe("aborted by user")
    expect(seen).toContainEqual(
      expect.objectContaining({ type: "status", status: "aborted", text: "aborted by user" }),
    )
  })

  test("waits for a completed tool boundary before exporting a live model handoff", async () => {
    pendingPrompt = true
    const controller = new AbortController()
    let releaseTool: (() => void) | undefined
    const toolMayFinish = new Promise<void>((resolve) => { releaseTool = resolve })
    eventStream = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-1",
          tool: "bash",
          state: { status: "running", input: { command: "solve" } },
        } as RuntimeEvent
        await toolMayFinish
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-1",
          tool: "bash",
          state: { status: "completed", title: "solver finished" },
        } as RuntimeEvent
      },
    }
    activeContextMessages = [{
      id: "tool-result-1",
      role: "tool",
      parts: [{
        type: "tool",
        tool: "bash",
        callID: "call-1",
        state: "completed",
        input: '{"command":"solve"}',
        output: "durable result",
      }],
    }]
    const seen: RunEvent[] = []
    const running = runChallenge(input({
      handoffSignal: controller.signal,
      onEvent: (event: RunEvent) => seen.push(event),
    }))

    while (
      promptBodies.length === 0 ||
      !seen.some((event) => event.type === "tool" && event.status === "running")
    ) await Promise.resolve()
    controller.abort()
    await Promise.resolve()
    expect(abortCalls).toBe(0)

    releaseTool?.()
    const outcome = await running

    expect(abortCalls).toBe(1)
    expect(outcome).toMatchObject({
      stop: "switched",
      handoff: {
        resumeSessionID: "session-1",
        history: [expect.objectContaining({ id: "tool-result-1" })],
      },
    })
    expect(seen).toContainEqual(expect.objectContaining({
      type: "status",
      status: "model.switch.waiting-boundary",
      text: "等待当前工具返回",
    }))
    expect(seen).toContainEqual(expect.objectContaining({
      type: "status",
      status: "model.switch.boundary",
      text: "tool · session-1",
    }))
  })

  test("does not subscribe or prompt when abort arrives while creating the session", async () => {
    pendingCreate = true
    const controller = new AbortController()
    const running = runChallenge(input({ signal: controller.signal }))

    while (!resolveCreate) await Promise.resolve()
    controller.abort()
    resolveCreate()
    const outcome = await running

    expect(outcome.stop).toBe("aborted")
    expect(outcome.detail).toBe("aborted by user")
    expect(abortCalls).toBe(1)
    expect(subscribeCalls).toBe(0)
    expect(promptBodies).toHaveLength(0)
  })

  const spend = (billable: number): RuntimeEvent => ({
    type: "step-finish",
    sessionID: "session-1",
    usage: { input: billable, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    reason: "tool-calls",
  })

  const toolCall = (callID: string, tool: string, status: "running" | "completed"): RuntimeEvent => ({
    type: "tool-state",
    sessionID: "session-1",
    callID,
    tool,
    state: status === "running"
      ? { status, input: { command: `probe ${callID}` } }
      : { status, title: `${tool} done` },
  })

  async function brakeWorkspace(name: string) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `boom-session-${name}-`))
    temporary.push(directory)
    await mkdir(path.join(directory, "work"))
    return directory
  }

  describe("in-turn dead-end brake", () => {
    test("stops a turn that burned its brake budget with no durable signal", async () => {
      const directory = await brakeWorkspace("brake-stall")
      eventStream = events([spend(60), spend(60)])

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 10_000, stalledInTurnTokens: 100 },
      }))

      expect(outcome.stop).toBe("stalled")
      expect(outcome.detail).toContain("no durable progress")
      expect(abortCalls).toBe(1)
    })

    test("keeps solving when tool calls burn tokens but a note records progress", async () => {
      const directory = await brakeWorkspace("brake-note")
      // The dead-end case and this one differ only in the ctf-note: plain tool traffic must never
      // count as progress, a durable note must.
      eventStream = events([
        spend(60),
        toolCall("call-1", "bash", "running"),
        toolCall("call-1", "bash", "completed"),
        toolCall("call-2", "ctf-note", "completed"),
        spend(60),
      ])

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 10_000, stalledInTurnTokens: 100 },
      }))

      expect(outcome.stop).not.toBe("stalled")
    })

    test("does not brake a turn that is writing artifacts without notes", async () => {
      const directory = await brakeWorkspace("brake-artifact")
      eventStream = {
        async *[Symbol.asyncIterator]() {
          yield spend(60)
          // An artifact write produces no runtime event, so only the confirmation stage can see it.
          await Bun.write(path.join(directory, "work", "decoded.bin"), "recovered bytes")
          yield spend(60)
        },
      }

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 10_000, stalledInTurnTokens: 100 },
      }))

      expect(outcome.stop).not.toBe("stalled")
    })

    test("exempts a turn whose tool is still running", async () => {
      const directory = await brakeWorkspace("brake-longrunning")
      eventStream = events([
        spend(60),
        toolCall("call-1", "bash", "running"),
        spend(60),
      ])

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 10_000, stalledInTurnTokens: 100 },
      }))

      expect(outcome.stop).not.toBe("stalled")
    })

    test("stays disabled when no brake budget is configured", async () => {
      const directory = await brakeWorkspace("brake-off")
      eventStream = events([spend(60), spend(60), spend(60)])

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 10_000 },
      }))

      expect(outcome.stop).not.toBe("stalled")
    })

    test("brakes through repeated bare artifact writes once the reprieves run out", async () => {
      const directory = await brakeWorkspace("brake-reprieve")
      // A solver that touches a file every step — a downloaded tool, a scratch script — resets the
      // brake forever if mtime alone counts as progress. Four writes exceed the three reprieves.
      eventStream = {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 5; index += 1) {
            yield spend(60)
            await Bun.write(path.join(directory, "work", `scratch-${index}.bin`), `pass ${index}`)
            yield spend(60)
          }
        },
      }

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 100_000, repeats: 5, timeout: 10_000, stalledInTurnTokens: 100 },
      }))

      expect(outcome.stop).toBe("stalled")
      expect(outcome.detail).toContain("no durable progress")
    })

    test("keeps granting reprieves when notes accompany the artifact writes", async () => {
      const directory = await brakeWorkspace("brake-reprieve-note")
      // Same write cadence as the previous test, but each round records a durable note. Notes reset the
      // brake without consuming a reprieve, so this must never stall.
      eventStream = {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 5; index += 1) {
            yield spend(60)
            await Bun.write(path.join(directory, "work", `derived-${index}.bin`), `pass ${index}`)
            yield toolCall(`note-${index}`, "ctf-note", "completed")
            yield spend(60)
          }
        },
      }

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 100_000, repeats: 5, timeout: 10_000, stalledInTurnTokens: 100 },
      }))

      expect(outcome.stop).not.toBe("stalled")
    })
  })

  describe("no-activity watchdog", () => {
    test("ends a turn as silent when the runtime stops emitting events", async () => {
      const directory = await brakeWorkspace("silence-hang")
      pendingPrompt = true
      // One event, then nothing: the shape of a hung provider or agent loop.
      eventStream = {
        async *[Symbol.asyncIterator]() {
          yield spend(10)
          await new Promise(() => {})
        },
      }
      const seen: RunEvent[] = []

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 30_000, silenceMs: 60 },
        onEvent: (event: RunEvent) => seen.push(event),
      }))

      expect(outcome.stop).toBe("silent")
      expect(outcome.detail).toContain("no runtime activity")
      expect(abortCalls).toBe(1)
      expect(seen).toContainEqual(expect.objectContaining({ type: "status", status: "silent" }))
    })

    test("exports a bounded context snapshot for the recovery turn", async () => {
      const directory = await brakeWorkspace("silence-snapshot")
      pendingPrompt = true
      activeContextMessages = [{
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "text", text: "关键结论：校验逻辑在 sub_A780" }],
      }]
      eventStream = {
        async *[Symbol.asyncIterator]() {
          yield spend(10)
          await new Promise(() => {})
        },
      }

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 30_000, silenceMs: 60 },
      }))

      expect(outcome.stop).toBe("silent")
      expect(outcome.recoveryContext?.summary).toContain("关键结论：校验逻辑在 sub_A780")
      expect(activeContextCalls).toBe(1)
    })

    test("never cuts a turn while a tool is still running", async () => {
      const directory = await brakeWorkspace("silence-longrunning")
      pendingPrompt = true
      // A brute-force or large parse emits nothing for minutes. The watchdog must stay out of its way,
      // leaving the wall-clock timeout as the only backstop.
      eventStream = {
        async *[Symbol.asyncIterator]() {
          yield toolCall("call-1", "bash", "running")
          await new Promise(() => {})
        },
      }

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 400, silenceMs: 60 },
      }))

      expect(outcome.stop).toBe("timeout")
    })

    test("rearms on every event so a slow but live runtime is left alone", async () => {
      const directory = await brakeWorkspace("silence-live")
      // Reasoning deltas alone keep the watchdog armed: a model thinking for a long time before its
      // first text is still alive.
      eventStream = {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 6; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20))
            yield { type: "reasoning-delta", sessionID: "session-1", delta: "thinking" } as RuntimeEvent
          }
        },
      }

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 10_000, silenceMs: 60 },
      }))

      expect(outcome.stop).toBe("completed")
    })

    test("keeps a silent turn alive while the backend reports a step in flight", async () => {
      const directory = await brakeWorkspace("silence-busy")
      pendingPrompt = true
      busyProbe = true
      // No events after the first usage tick: the shape of a provider that batches reasoning
      // deltas. The backend still reports an in-flight step, so the watchdog must leave it alone
      // and the wall-clock timeout becomes the backstop.
      eventStream = {
        async *[Symbol.asyncIterator]() {
          yield spend(10)
          await new Promise(() => {})
        },
      }
      const seen: RunEvent[] = []

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 400, silenceMs: 60 },
        onEvent: (event: RunEvent) => seen.push(event),
      }))

      expect(outcome.stop).toBe("timeout")
      expect(busyProbeCalls).toBeGreaterThan(0)
      expect(seen).not.toContainEqual(expect.objectContaining({ status: "silent" }))
    })

    test("kills once the backend stops reporting a step in flight", async () => {
      const directory = await brakeWorkspace("silence-busy-then-idle")
      pendingPrompt = true
      busyProbe = true
      setTimeout(() => { busyProbe = false }, 150)
      eventStream = {
        async *[Symbol.asyncIterator]() {
          yield spend(10)
          await new Promise(() => {})
        },
      }

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 30_000, silenceMs: 60 },
      }))

      expect(outcome.stop).toBe("silent")
      expect(outcome.detail).toContain("no runtime activity")
    })

    test("ignores an idle probe made stale by newer runtime activity", async () => {
      const directory = await brakeWorkspace("silence-stale-probe")
      pendingPrompt = true
      busyProbe = false
      busyProbeDelayMs = 80
      eventStream = {
        async *[Symbol.asyncIterator]() {
          yield spend(10)
          // The first probe captures idle. This newer event re-arms the watchdog before it resolves,
          // and later probes see the still-running backend.
          await new Promise((resolve) => setTimeout(resolve, 45))
          busyProbe = true
          yield { type: "reasoning-delta", sessionID: "session-1", delta: "still thinking" } as RuntimeEvent
          await new Promise(() => {})
        },
      }

      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 250, silenceMs: 30 },
      }))

      expect(outcome.stop).toBe("timeout")
      expect(busyProbeCalls).toBeGreaterThan(1)
    })

    test("stays disabled when no silence budget is configured", async () => {
      const directory = await brakeWorkspace("silence-off")
      pendingPrompt = true
      eventStream = {
        async *[Symbol.asyncIterator]() {
          yield spend(10)
          await new Promise(() => {})
        },
      }
      const seen: RunEvent[] = []

      // With no silence budget the same hang must reach the wall-clock backstop instead. The fake
      // runtime resolves its pending prompt from `abort()`, so the turn reports the prompt's own
      // result; what matters is that the watchdog never classified it.
      const outcome = await runChallenge(input({
        workspace: { directory, runID: "mock-run", extracted: [] },
        limits: { tokens: 10_000, repeats: 5, timeout: 300 },
        onEvent: (event: RunEvent) => seen.push(event),
      }))

      expect(outcome.stop).not.toBe("silent")
      expect(seen).not.toContainEqual(expect.objectContaining({ status: "silent" }))
      expect(seen.length).toBeGreaterThan(0)
    })
  })

  test("aborts a live generation at Boom's own output ceiling", async () => {
    pendingPrompt = true
    eventStream = events([{
      type: "text-delta",
      sessionID: "session-1",
      delta: "x".repeat(8_001),
    }])
    const outcome = await runChallenge(input({
      limits: { tokens: 1_000, repeats: 5, timeout: 10_000, outputChars: 8_000 },
    }))
    expect(abortCalls).toBe(1)
    expect(outcome).toMatchObject({
      stop: "stalled",
      detail: "Boom output ceiling exceeded: 8001 > 8000 characters",
    })
  })

  test("retries a length-truncated response once with a concise recovery prompt", async () => {
    promptResults = [
      {
        usage: { input: 20, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.5,
        finish: "length",
        parts: [{ type: "text", text: "long repeated output" }],
      },
      finished,
    ]
    const seen: RunEvent[] = []

    const outcome = await runChallenge(
      input({ onEvent: (event: RunEvent) => seen.push(event) }),
    )

    expect(promptBodies).toHaveLength(2)
    const recovery = promptBodies[1]!
    expect(recovery.text).toContain("single-turn output length cap")
    expect(recovery.text).toContain("into work/")
    expect(seen).toContainEqual(
      expect.objectContaining({ type: "retry", status: "length-recovery" }),
    )
    expect(outcome).toMatchObject({
      stop: "completed",
      finish: "stop",
      retries: ["1:length-recovery"],
    })
  })

  test("waits and retries when the provider throws a transient error", async () => {
    promptResults = [
      Object.assign(new Error("Service Unavailable"), { statusCode: 503 }),
      finished,
    ]
    const seen: RunEvent[] = []

    const outcome = await runChallenge(input({
      limits: { tokens: 1_000, repeats: 5, timeout: 10_000, retryBaseMs: 0 },
      onEvent: (event: RunEvent) => seen.push(event),
    }))

    expect(promptBodies).toHaveLength(2)
    expect(promptBodies[1]!.text).toContain("interrupted by a runtime fault")
    expect(seen).toContainEqual(expect.objectContaining({ type: "retry", status: "transient" }))
    expect(outcome).toMatchObject({ stop: "completed", finish: "stop" })
  })

  test("continues once when a compatible provider reports an unknown finish", async () => {
    promptResults = [
      {
        usage: { input: 20, output: 20, reasoning: 10, cache: { read: 0, write: 0 } },
        cost: 0.1,
        finish: "unknown",
        parts: [{ type: "reasoning", text: "partial investigation" }],
      },
      finished,
    ]
    const seen: RunEvent[] = []

    const outcome = await runChallenge(input({ onEvent: (event: RunEvent) => seen.push(event) }))

    expect(promptBodies).toHaveLength(2)
    expect(promptBodies[1]!.text).toContain("finish state was ambiguous")
    expect(seen).toContainEqual(expect.objectContaining({ type: "retry", status: "unknown-recovery" }))
    expect(outcome).toMatchObject({
      stop: "completed",
      finish: "stop",
      retries: ["1:unknown-recovery"],
    })
  })

  test("keeps an unknown finish as an error after the bounded recovery is exhausted", async () => {
    const unknown: PromptResult = {
      usage: { input: 20, output: 20, reasoning: 10, cache: { read: 0, write: 0 } },
      cost: 0.1,
      finish: "unknown",
      parts: [{ type: "reasoning", text: "still incomplete" }],
    }
    promptResults = [unknown, unknown, finished]

    const outcome = await runChallenge(input())

    expect(promptBodies).toHaveLength(2)
    expect(outcome).toMatchObject({
      stop: "error",
      finish: "unknown",
      detail: "provider finish reason: unknown",
      retries: ["1:unknown-recovery"],
    })
  })

  test("reports an error when the single length recovery is also truncated", async () => {
    const truncated: PromptResult = {
      usage: { input: 20, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.5,
      finish: "length",
      parts: [{ type: "text", text: "still repeating" }],
    }
    promptResults = [truncated, truncated, finished]

    const outcome = await runChallenge(input())

    expect(promptBodies).toHaveLength(2)
    expect(outcome).toMatchObject({
      stop: "error",
      finish: "length",
      detail: "provider finish reason: length",
      retries: ["1:length-recovery"],
    })
  })

  test("retries a content-safety refusal instead of ending the turn", async () => {
    promptResults = [
      {
        usage: { input: 20, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.1,
        finish: "content-filter",
        parts: [],
      },
      finished,
    ]
    const seen: RunEvent[] = []

    const outcome = await runChallenge(input({ onEvent: (event: RunEvent) => seen.push(event) }))

    expect(promptBodies).toHaveLength(2)
    expect(promptBodies[1]!.text).toContain("blocked by a content-safety policy")
    expect(seen).toContainEqual(expect.objectContaining({ type: "retry", status: "content-filter-recovery" }))
    expect(outcome).toMatchObject({
      stop: "completed",
      finish: "stop",
      retries: ["1:content-filter-recovery"],
    })
  })

  test("retries a provider-cancelled response in the same session", async () => {
    promptResults = [
      {
        usage: { input: 20, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.1,
        finish: "cancelled",
        parts: [],
      },
      finished,
    ]
    const seen: RunEvent[] = []

    const outcome = await runChallenge(input({ onEvent: (event: RunEvent) => seen.push(event) }))

    expect(promptBodies).toHaveLength(2)
    expect(promptBodies[1]!.text).toContain("provider cancelled the previous turn's response")
    expect(seen).toContainEqual(expect.objectContaining({ type: "retry", status: "cancelled-recovery" }))
    expect(outcome).toMatchObject({
      stop: "completed",
      finish: "stop",
      retries: ["1:cancelled-recovery"],
    })
  })

  test("re-establishes a failed event subscription before prompting", async () => {
    subscribeFailures = 1

    const outcome = await runChallenge(input())

    expect(subscribeCalls).toBe(2)
    expect(promptBodies).toHaveLength(1)
    expect(outcome).toMatchObject({ stop: "completed", finish: "stop" })
  })

  test("keeps solving when the structured candidate slot is unreadable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-session-invalid-candidate-"))
    temporary.push(directory)
    await mkdir(path.join(directory, "work"))
    await writeFile(path.join(directory, "work", "RESULT.json"), "{ not valid json", "utf8")
    const seen: RunEvent[] = []

    const outcome = await runChallenge(input({
      workspace: { directory, runID: "mock-run", extracted: [] },
      onEvent: (event: RunEvent) => seen.push(event),
    }))

    expect(outcome).toMatchObject({ stop: "completed", candidates: [] })
    expect(seen).toContainEqual(expect.objectContaining({ status: "candidate.slot.invalid" }))
  })

  test("does not attempt length recovery after the billable budget is exhausted", async () => {
    promptResults = [{
      usage: { input: 20, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.5,
      finish: "length",
      parts: [{ type: "text", text: "truncated at the budget boundary" }],
    }]
    const outcome = await runChallenge(input({ limits: { tokens: 100, repeats: 5, timeout: 10_000 } }))
    expect(promptBodies).toHaveLength(1)
    expect(outcome).toMatchObject({
      stop: "budget",
      detail: "length recovery skipped because no billable token budget remains",
      retries: [],
    })
  })

  test("uses the time limit without a token ceiling when tokens are omitted", async () => {
    promptResults = [{
      usage: { input: 20, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.5,
      finish: "length",
      parts: [{ type: "text", text: "truncated but still within the time limit" }],
    }]
    const outcome = await runChallenge(input({ limits: { repeats: 5, timeout: 10_000 } }))
    expect(promptBodies).toHaveLength(2)
    expect(outcome).toMatchObject({
      stop: "completed",
      finish: "stop",
      retries: ["1:length-recovery"],
    })
  })

  test("emits a heartbeat when tool activity outlives model text", async () => {
    pendingPrompt = true
    eventStream = {
      async *[Symbol.asyncIterator]() {
        while (promptBodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-1",
          tool: "bash",
          state: { status: "running", input: { command: "cd work && ./solve" } },
        } as RuntimeEvent
        await new Promise((resolve) => setTimeout(resolve, 80))
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-1",
          tool: "bash",
          state: { status: "completed", title: "bash · exit 0" },
        } as RuntimeEvent
      },
    }
    const seen: RunEvent[] = []
    const outcomePromise = runChallenge(input({
      limits: {
        tokens: 1_000,
        repeats: 5,
        timeout: 10_000,
        heartbeatTextSilenceMs: 20,
        heartbeatMinIntervalMs: 10,
      },
      onEvent: (event: RunEvent) => seen.push(event),
    }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    resolvePrompt?.(finished)
    const outcome = await outcomePromise

    const heartbeats = seen.filter((event) => event.type === "status" && event.status === "heartbeat")
    expect(heartbeats.length).toBe(1)
    expect(heartbeats[0]!.text).toContain("仍在运行")
    expect(heartbeats[0]!.text).toContain("工具调用")
    expect(outcome).toMatchObject({ stop: "completed" })
  })

  test("heartbeat is throttled and reset by model text", async () => {
    pendingPrompt = true
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    eventStream = {
      async *[Symbol.asyncIterator]() {
        while (promptBodies.length === 0) await pause()
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-1",
          tool: "bash",
          state: { status: "running", input: { command: "one" } },
        } as RuntimeEvent
        await new Promise((resolve) => setTimeout(resolve, 60))
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-1",
          tool: "bash",
          state: { status: "completed", title: "bash · exit 0" },
        } as RuntimeEvent
        // Model text resets the silence clock: a tool finishing right after must not beat again.
        yield { type: "text-delta", sessionID: "session-1", delta: "仍在分析" } as RuntimeEvent
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-2",
          tool: "bash",
          state: { status: "running", input: { command: "two" } },
        } as RuntimeEvent
        await new Promise((resolve) => setTimeout(resolve, 10))
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-2",
          tool: "bash",
          state: { status: "completed", title: "bash · exit 0" },
        } as RuntimeEvent
        // Silence again: the second heartbeat fires once, not per tool call.
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-3",
          tool: "bash",
          state: { status: "running", input: { command: "three" } },
        } as RuntimeEvent
        await new Promise((resolve) => setTimeout(resolve, 70))
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "call-3",
          tool: "bash",
          state: { status: "completed", title: "bash · exit 0" },
        } as RuntimeEvent
      },
    }
    const seen: RunEvent[] = []
    const outcomePromise = runChallenge(input({
      limits: {
        tokens: 1_000,
        repeats: 5,
        timeout: 10_000,
        heartbeatTextSilenceMs: 20,
        heartbeatMinIntervalMs: 10,
      },
      onEvent: (event: RunEvent) => seen.push(event),
    }))
    await new Promise((resolve) => setTimeout(resolve, 350))
    resolvePrompt?.(finished)
    await outcomePromise

    const heartbeats = seen.filter((event) => event.type === "status" && event.status === "heartbeat")
    expect(heartbeats.length).toBe(2)
  })

  test("note gate hard-stops a turn when many tools run without a durable note", async () => {
    pendingPrompt = true
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    eventStream = {
      async *[Symbol.asyncIterator]() {
        while (promptBodies.length === 0) await pause()
        for (let index = 1; index <= 3; index += 1) {
          yield {
            type: "tool-state",
            sessionID: "session-1",
            callID: `call-${index}`,
            tool: "bash",
            state: { status: "running", input: { command: `cmd ${index}` } },
          } as RuntimeEvent
          yield {
            type: "tool-state",
            sessionID: "session-1",
            callID: `call-${index}`,
            tool: "bash",
            state: { status: "completed", title: "bash · exit 0" },
          } as RuntimeEvent
        }
      },
    }
    const seen: RunEvent[] = []
    const outcomePromise = runChallenge(input({
      purpose: "solve",
      limits: { tokens: 1_000, repeats: 5, timeout: 10_000, noteGateToolCalls: 3 },
      onEvent: (event: RunEvent) => seen.push(event),
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    resolvePrompt?.(finished)
    const outcome = await outcomePromise

    // The gate no longer asks in the same session; it ends the turn so the next round must checkpoint.
    expect(promptBodies).toHaveLength(1)
    expect(seen).toContainEqual(expect.objectContaining({ type: "status", status: "note-gate" }))
    expect(seen).toContainEqual(expect.objectContaining({ type: "status", status: "note-gate.hard" }))
    expect(outcome).toMatchObject({
      stop: "stalled",
      detail: expect.stringContaining("note-gate"),
    })
  })

  test("note gate is cancelled by a durable write and does not re-fire in the same turn", async () => {
    pendingPrompt = true
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    eventStream = {
      async *[Symbol.asyncIterator]() {
        while (promptBodies.length === 0) await pause()
        // Two plain tools, then a durable note: the counter resets at the note, so the gate's
        // threshold of three is never reached even though the turn runs many tools in total.
        for (let index = 1; index <= 2; index += 1) {
          yield {
            type: "tool-state",
            sessionID: "session-1",
            callID: `call-${index}`,
            tool: "bash",
            state: { status: "running", input: { command: `cmd ${index}` } },
          } as RuntimeEvent
          yield {
            type: "tool-state",
            sessionID: "session-1",
            callID: `call-${index}`,
            tool: "bash",
            state: { status: "completed", title: "bash · exit 0" },
          } as RuntimeEvent
        }
        yield {
          type: "tool-state",
          sessionID: "session-1",
          callID: "note-1",
          tool: "ctf-note",
          state: { status: "completed", title: "note -> NOTES.md" },
        } as RuntimeEvent
        for (let index = 3; index <= 4; index += 1) {
          yield {
            type: "tool-state",
            sessionID: "session-1",
            callID: `call-${index}`,
            tool: "bash",
            state: { status: "running", input: { command: `cmd ${index}` } },
          } as RuntimeEvent
          yield {
            type: "tool-state",
            sessionID: "session-1",
            callID: `call-${index}`,
            tool: "bash",
            state: { status: "completed", title: "bash · exit 0" },
          } as RuntimeEvent
        }
      },
    }
    const outcomePromise = runChallenge(input({
      purpose: "solve",
      limits: { tokens: 1_000, repeats: 5, timeout: 10_000, noteGateToolCalls: 3 },
    }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    resolvePrompt?.(finished)
    const outcome = await outcomePromise

    expect(promptBodies).toHaveLength(1)
    expect(outcome).toMatchObject({ stop: "completed" })
  })
})
