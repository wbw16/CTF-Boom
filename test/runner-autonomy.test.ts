import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { submitCandidate } from "../src/candidate-submission.ts"
import { loadConsultationRequest, requestConsultation } from "../src/consultation-request.ts"
import { markAutomaticContinuation } from "../src/orchestration/progress.ts"
import { MockSubmissionGateway } from "./fixtures/mock-submission.ts"
import { GuiRunner } from "../src/runner.ts"
import type { RuntimeHandle } from "../src/runtime-contract.ts"
import { saveTaskRecord } from "../src/task.ts"
import { prepareWorkspace } from "../src/workspace.ts"

const temporary: string[] = []
afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

test("an accepted platform verdict automatically archives an offline writeup", async () => {
  const interpreter = Bun.which("python3")
  if (!interpreter) return
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-runner-autonomy-"))
  temporary.push(directory)
  const root = path.join(directory, "ctf")
  const source = path.join(root, "challenges", "simple")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "Return the supplied flag")
  await writeFile(path.join(source, "flag.txt"), "flag{l0}")

  const agents: string[] = []
  const prompts: string[] = []
  const handle: RuntimeHandle = {
    backend: "fake",
    version: "test",
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: false,
      attachments: false,
      web: false,
      cancellation: true,
      providerManagement: false,
      providerOAuth: false,
      compaction: false,
      compactionHooks: false,
    },
    agent: {
      async createConversation(input) {
        const id = `conversation-${agents.length + 1}`
        return {
          id,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(prompt) {
            agents.push(prompt.agent)
            prompts.push(prompt.text)
            if (prompt.agent === "boom") {
              if (prompt.text.includes("Confirmed flag")) {
                await writeFile(
                  path.join(input.directory, "work", "WRITEUP.md"),
                  "# Writeup\n\nRead challenge/flag.txt, reproduced the supplied value, and verified each step.\n\nFlag: flag{l0}\n",
                )
              } else {
                await submitCandidate({
                  directory: input.directory,
                  sessionID: id,
                  candidate: "flag{l0}",
                })
              }
              return {
                usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
                finish: "stop",
                parts: [{ type: "text", text: "done" }],
              }
            }
            return {
              usage: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              finish: "stop",
              parts: [{ type: "text", text: JSON.stringify({ passed: true, detail: "derivation is sufficient" }) }],
            }
          },
          async abort() {},
        }
      },
    },
    close() {},
  }
  const adapters = new MockSubmissionGateway([{
    id: "test-platform",
    async submitFlag() {
      return {
        adapter: "test-platform",
        verdict: "accepted",
        detail: "accepted by test platform",
        submittedAt: new Date().toISOString(),
      }
    },
  }])
  const runner = new GuiRunner(root, async () => handle, adapters)
  try {
    await runner.enqueue({
      challenges: [{
        slug: "simple",
        directory: source,
        description: "Return the supplied flag",
        files: ["flag.txt"],
        flagFormat: "flag\\{[^}]+\\}",
        platform: { adapter: "test-platform", challengeID: "simple-1" },
      }],
      model: "test/strong",
      modelPolicy: { economy: "test/economy", strong: "test/strong" },
      // The solve consumes this budget; the automatic writeup must still get its own bounded
      // allowance instead of being dropped as an exhausted solve continuation.
      limits: { tokens: 15, repeats: 5, timeout: 60_000 },
      flagFormat: "flag\\{[^}]+\\}",
      pythonInterpreter: interpreter,
    })
    for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1)
      await Bun.sleep(10)
    expect(runner.hasWork()).toBe(false)
    expect(agents).toEqual(["boom", "boom"])
    expect(prompts[1]).toContain("Generate work/WRITEUP.md offline")
    const [runID] = await readdir(path.join(root, "runs", "simple"))
    const run = path.join(root, "runs", "simple", runID!)
    const result = JSON.parse(await readFile(path.join(run, "result.json"), "utf8"))
    expect(result).toMatchObject({
      orchestration_variant: "autonomy-l0",
      task_status: "archived",
    })
    expect(JSON.parse(await readFile(path.join(run, "task.json"), "utf8"))).toMatchObject({
      status: "archived",
      acceptedFlag: { value: "flag{l0}", source: "test-platform" },
    })
    expect(await readFile(path.join(run, "work", "WRITEUP.md"), "utf8")).toContain("flag{l0}")
    expect(result.baseline).toBeUndefined()
    expect(result.checkpoint).toBeUndefined()
    expect(await Bun.file(path.join(run, "work", ".boom", "autonomy.json")).exists()).toBe(true)
  } finally {
    await runner.close()
  }
})

test("a model-requested consultation uses the new continuation budget and resumes the task", async () => {
  const interpreter = Bun.which("python3")
  if (!interpreter) return
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-runner-consult-"))
  temporary.push(directory)
  const root = path.join(directory, "ctf")
  const source = path.join(root, "challenges", "consult-me")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "Use a consultation, then return flag{consulted}")

  const challenge = {
    slug: "consult-me",
    directory: source,
    description: "Use a consultation, then return flag{consulted}",
    files: [],
    flagFormat: "flag\\{[^}]+\\}",
    platform: { adapter: "test-platform", challengeID: "consult-me-1" },
  }
  const workspace = await prepareWorkspace(root, challenge, "task")
  const historicalFinish = Date.now() - 1_000
  await saveTaskRecord(workspace.directory, {
    version: 1,
    id: workspace.runID,
    slug: challenge.slug,
    status: "paused",
    createdAt: new Date(historicalFinish - 120_000).toISOString(),
    updatedAt: new Date(historicalFinish).toISOString(),
    currentModel: "test/strong",
    rejectedFlags: [],
    turns: [{
      id: "historic-turn",
      model: "test/strong",
      startedAt: new Date(historicalFinish - 120_000).toISOString(),
      finishedAt: new Date(historicalFinish).toISOString(),
      stop: "completed",
      tokens: 160_000,
      billableTokens: 150_000,
      cost: 0,
      candidates: [],
    }],
  })

  const calls: Array<{ agent: string; title: string }> = []
  let solverTurns = 0
  const solverSessionID = "solver-request-original"
  const resumeCalls: string[] = []
  const conversation = (input: { directory: string; title: string }, id: string) => ({
    id,
    async events() {
      return { async *[Symbol.asyncIterator]() {} }
    },
    async prompt(prompt: { agent: string; model: string; text: string }) {
      calls.push({ agent: prompt.agent, title: input.title })
      if (prompt.agent === "boom-consultant") {
        if (prompt.model === "test/expert-b") throw new Error("expert-b unavailable")
        return {
          usage: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
          finish: "stop" as const,
          parts: [{ type: "text", text: input.title.includes("synthesis")
            ? "Validate the shortest evidence path, then submit the recovered value."
            : "Inspect the supplied statement and validate its literal candidate." }],
        }
      }
      solverTurns += 1
      let parts: Array<{ type: string; text: string }> = [{ type: "text", text: "done" }]
      if (solverTurns === 1) {
        await requestConsultation({
          directory: input.directory,
          sessionID: id,
          reason: "The current path is exhausted and needs independent hypotheses.",
        })
      } else if (prompt.text.includes("next-phase plan")) {
        // The post-consultation continuation turn carries the synthesized plan and submits.
        expect(prompt.text).toContain("next-phase plan synthesized by the multi-model consultation")
        await submitCandidate({
          directory: input.directory,
          sessionID: id,
          candidate: "flag{consulted}",
        })
      } else {
        // Automatic writeup turns (and their single retry) only produce text.
        parts = [{ type: "text", text: "WRITEUP draft noted." }]
      }
      return {
        usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        finish: "stop" as const,
        parts,
      }
    },
    async abort() {},
    async activeContext() {
      return [{
        id: "assistant-request",
        role: "assistant" as const,
        parts: [{ type: "text", text: "The literal path was checked; request independent hypotheses." }],
      }]
    },
  })
  const handle: RuntimeHandle = {
    backend: "fake",
    version: "test",
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: false,
      attachments: false,
      web: false,
      cancellation: true,
      providerManagement: false,
      providerOAuth: false,
      compaction: true,
      compactionHooks: true,
    },
    agent: {
      async createConversation(input) {
        const id = input.title.startsWith("Boom consult")
          ? `consultant-${crypto.randomUUID()}`
          : solverSessionID
        return conversation(input, id)
      },
      async resumeConversation(input) {
        resumeCalls.push(input.id)
        return conversation({ directory: input.directory, title: "Boom resumed solver" }, input.id)
      },
    },
    close() {},
  }
  const adapters = new MockSubmissionGateway([{
    id: "test-platform",
    async submitFlag() {
      return {
        adapter: "test-platform",
        verdict: "accepted",
        detail: "accepted after consultation",
        submittedAt: new Date().toISOString(),
      }
    },
  }])
  const runner = new GuiRunner(root, async () => handle, adapters)
  try {
    await runner.enqueue({
      challenges: [challenge],
      model: "test/strong",
      modelPolicy: { economy: "test/economy", strong: "test/strong" },
      consultModels: ["test/expert-a", "test/expert-b", "test/expert-c"],
      consultOnCompaction: false,
      limits: { tokens: 100_000, repeats: 5, timeout: 60_000 },
      flagFormat: "flag\\{[^}]+\\}",
      pythonInterpreter: interpreter,
      workspaces: { "consult-me": workspace.runID },
    })
    for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1)
      await Bun.sleep(10)

    expect(runner.hasWork()).toBe(false)
    expect(resumeCalls).toEqual([solverSessionID])
    // Solve turn, post-consultation continue turn, then the automatic writeup turn plus its single
    // retry (the fake conversation never produces a qualifying WRITEUP.md).
    expect(calls.filter((call) => call.agent === "boom")).toHaveLength(4)
    // Three experts, one retry for the failed expert, and one strong synthesis.
    expect(calls.filter((call) => call.agent === "boom-consultant")).toHaveLength(5)
    const run = workspace.directory
    // Follow-up turns overwrite result.json, so the durable expectations live in task.json and the
    // consultation artifacts; result.json only needs to agree on the winning candidate.
    const result = JSON.parse(await readFile(path.join(run, "result.json"), "utf8"))
    expect(result).toMatchObject({ primary_candidate: "flag{consulted}" })
    expect(JSON.parse(await readFile(path.join(run, "task.json"), "utf8"))).toMatchObject({
      status: "solved",
      acceptedFlag: { value: "flag{consulted}", source: "test-platform" },
    })
    expect(await Bun.file(path.join(run, "work", "CONSULTATION.md")).exists()).toBe(true)
    expect(await loadConsultationRequest(run)).toMatchObject({
      status: "handled",
      resolution: "queued",
      sessionID: solverSessionID,
    })
    const savedConsultation = JSON.parse(await readFile(path.join(run, "work", "consultation.json"), "utf8"))
    const parts = await readdir(path.join(run, "work", ".boom", "consultations", savedConsultation.id))
    expect(parts.sort()).toEqual(["expert-1.json", "expert-2.json", "expert-3.json"])
  } finally {
    await runner.close()
  }
})

test("continues the solver when the stagnation second opinion fails", async () => {
  const interpreter = Bun.which("python3")
  if (!interpreter) return
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-runner-l1-failure-"))
  temporary.push(directory)
  const root = path.join(directory, "ctf")
  const source = path.join(root, "challenges", "l1-failure")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "Keep solving until the flag is recovered")

  let solverPrompts = 0
  let consultantCalls = 0
  const handle: RuntimeHandle = {
    backend: "fake",
    version: "test",
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: false,
      attachments: false,
      web: false,
      cancellation: true,
      providerManagement: false,
      providerOAuth: false,
      compaction: false,
      compactionHooks: false,
    },
    agent: {
      async createConversation(input) {
        const id = `conversation-${crypto.randomUUID()}`
        return {
          id,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(prompt) {
            if (prompt.agent === "boom-consultant") {
              consultantCalls += 1
              throw new Error("economy second-opinion model unavailable")
            }
            solverPrompts += 1
            if (solverPrompts >= 3) {
              await submitCandidate({
                directory: input.directory,
                sessionID: id,
                candidate: "flag{after-l1-failure}",
              })
            }
            return {
              usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              finish: "stop",
              parts: [{
                type: "text",
                text: solverPrompts === 2
                  ? "BOOM_ESCALATE_REQUEST: current route needs an independent diagnosis"
                  : "no candidate yet",
              }],
            }
          },
          async abort() {},
        }
      },
    },
    close() {},
  }
  const adapters = new MockSubmissionGateway([{
    id: "test-platform",
    async submitFlag() {
      return {
        adapter: "test-platform",
        verdict: "accepted",
        detail: "accepted by test platform",
        submittedAt: new Date().toISOString(),
      }
    },
  }])
  const runner = new GuiRunner(root, async () => handle, adapters)
  try {
    await runner.enqueue({
      challenges: [{
        slug: "l1-failure",
        directory: source,
        description: "Keep solving until the flag is recovered",
        files: [],
        flagFormat: "flag\\{[^}]+\\}",
        platform: { adapter: "test-platform", challengeID: "l1-failure-1" },
      }],
      model: "test/strong",
      modelPolicy: { economy: "test/economy", strong: "test/strong" },
      consultModels: [],
      blindReview: false,
      limits: { tokens: 100_000, repeats: 5, timeout: 60_000 },
      flagFormat: "flag\\{[^}]+\\}",
      pythonInterpreter: interpreter,
    })
    for (let attempt = 0; attempt < 800 && runner.hasWork(); attempt += 1)
      await Bun.sleep(10)

    expect(runner.hasWork()).toBe(false)
    expect(consultantCalls).toBeGreaterThan(0)
    expect(solverPrompts).toBeGreaterThanOrEqual(3)
    const [runID] = await readdir(path.join(root, "runs", "l1-failure"))
    const result = JSON.parse(await readFile(
      path.join(root, "runs", "l1-failure", runID!, "result.json"),
      "utf8",
    ))
    expect(result).toMatchObject({
      candidates: ["flag{after-l1-failure}"],
      task_status: "solved",
      autonomy: {
        escalations: [expect.objectContaining({ status: "failed" })],
      },
    })
  } finally {
    await runner.close()
  }
})

test("a compaction consultation receives active history and resumes the original solver session", async () => {
  const interpreter = Bun.which("python3")
  if (!interpreter) return
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-runner-compact-consult-"))
  temporary.push(directory)
  const root = path.join(directory, "ctf")
  const source = path.join(root, "challenges", "compact-me")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "Resume after compaction, then return flag{resumed}")

  const originalSessionID = "solver-original"
  const calls: Array<{ agent: string; prompt: string; sessionID: string }> = []
  const resumeCalls: string[] = []
  let solverPrompts = 0
  let resolveFirstPrompt: ((result: {
    usage: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    cost: number
    finish: "stop"
    parts: Array<{ type: string; text: string }>
  }) => void) | undefined

  const solverConversation = () => ({
    id: originalSessionID,
    async events() {
      const shouldCompact = solverPrompts === 0
      return {
        async *[Symbol.asyncIterator]() {
          if (!shouldCompact) return
          while (solverPrompts === 0) await Bun.sleep(0)
          yield {
            type: "compaction",
            sessionID: originalSessionID,
            state: "completed",
          } as const
        },
      }
    },
    async prompt(prompt: { agent: string; text: string }) {
      calls.push({ agent: prompt.agent, prompt: prompt.text, sessionID: originalSessionID })
      solverPrompts += 1
      if (solverPrompts === 1) {
        return new Promise<{
          usage: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
          cost: number
          finish: "stop"
          parts: Array<{ type: string; text: string }>
        }>((resolve) => { resolveFirstPrompt = resolve })
      }
      if (prompt.text.includes("next-phase plan")) {
        // The post-compaction continuation turn carries the synthesized plan and submits.
        expect(prompt.text).toContain("next-phase plan synthesized by the multi-model consultation")
        await submitCandidate({
          directory: path.join(root, "runs", "compact-me", (await readdir(path.join(root, "runs", "compact-me")))[0]!),
          sessionID: originalSessionID,
          candidate: "flag{resumed}",
        })
        return {
          usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
          finish: "stop" as const,
          parts: [{ type: "text", text: "submitted" }],
        }
      }
      // Automatic writeup turns (and their single retry) only produce text.
      return {
        usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        finish: "stop" as const,
        parts: [{ type: "text", text: "WRITEUP draft noted." }],
      }
    },
    async abort() {
      resolveFirstPrompt?.({
        usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        finish: "stop",
        parts: [{ type: "text", text: "compacted" }],
      })
    },
    async activeContext() {
      return [{
        id: "compact-1",
        role: "compaction" as const,
        parts: [
          { type: "summary", text: "Tried the ELF route and ruled it out after checking the magic bytes." },
          { type: "recent", text: "The latest command extracted stream 7; inspect its zlib body next." },
        ],
      }]
    },
  })

  const handle: RuntimeHandle = {
    backend: "fake",
    version: "test",
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: false,
      attachments: false,
      web: false,
      cancellation: true,
      providerManagement: false,
      providerOAuth: false,
      compaction: true,
      compactionHooks: true,
    },
    agent: {
      async createConversation(input) {
        if (!input.title.startsWith("Boom consult")) return solverConversation()
        const id = `consultant-${crypto.randomUUID()}`
        return {
          id,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(prompt) {
            calls.push({ agent: prompt.agent, prompt: prompt.text, sessionID: id })
            return {
              usage: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              finish: "stop",
              parts: [{ type: "text", text: input.title.includes("synthesis")
                ? "Inspect stream 7, validate zlib output, then submit the recovered flag."
                : "Prioritize the untested stream 7 zlib path because ELF was already ruled out." }],
            }
          },
          async abort() {},
        }
      },
      async resumeConversation(input) {
        resumeCalls.push(input.id)
        return solverConversation()
      },
    },
    close() {},
  }
  const adapters = new MockSubmissionGateway([{
    id: "test-platform",
    async submitFlag() {
      return {
        adapter: "test-platform",
        verdict: "accepted",
        detail: "accepted after compacted-session resume",
        submittedAt: new Date().toISOString(),
      }
    },
  }])
  const runner = new GuiRunner(root, async () => handle, adapters)
  try {
    await runner.enqueue({
      challenges: [{
        slug: "compact-me",
        directory: source,
        description: "Resume after compaction, then return flag{resumed}",
        files: [],
        flagFormat: "flag\\{[^}]+\\}",
        platform: { adapter: "test-platform", challengeID: "compact-me-1" },
      }],
      model: "test/strong",
      modelPolicy: { economy: "test/economy", strong: "test/strong" },
      consultModels: ["test/expert-a", "test/expert-b"],
      limits: { tokens: 100_000, repeats: 5, timeout: 60_000 },
      flagFormat: "flag\\{[^}]+\\}",
      pythonInterpreter: interpreter,
    })
    for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1)
      await Bun.sleep(10)

    expect(runner.hasWork()).toBe(false)
    expect(resumeCalls).toEqual([originalSessionID])
    // Solve turn, post-consultation continue turn, then the automatic writeup turn plus its single
    // retry (the fake conversation never produces a qualifying WRITEUP.md).
    expect(calls.filter((call) => call.agent === "boom")).toHaveLength(4)
    const consultationCalls = calls.filter((call) => call.agent === "boom-consultant")
    expect(consultationCalls).toHaveLength(3)
    for (const call of consultationCalls) {
      expect(call.prompt).toContain("ELF route")
      expect(call.prompt).toContain("stream 7")
    }
    const [runID] = await readdir(path.join(root, "runs", "compact-me"))
    // Follow-up turns overwrite result.json, so durable expectations live in task.json.
    const runDirectory = path.join(root, "runs", "compact-me", runID!)
    expect(JSON.parse(await readFile(path.join(runDirectory, "result.json"), "utf8")))
      .toMatchObject({ primary_candidate: "flag{resumed}" })
    const compactTask = JSON.parse(await readFile(path.join(runDirectory, "task.json"), "utf8"))
    expect(compactTask).toMatchObject({
      status: "solved",
      acceptedFlag: { value: "flag{resumed}", source: "test-platform" },
    })
    // Solve turn, post-compaction continue turn, writeup turn, writeup retry.
    expect(compactTask.turns).toHaveLength(4)
  } finally {
    await runner.close()
  }
})

test("a manual consultation with no successful experts falls back to a new solver turn", async () => {
  const interpreter = Bun.which("python3")
  if (!interpreter) return
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-runner-manual-consult-fallback-"))
  temporary.push(directory)
  const root = path.join(directory, "ctf")
  const source = path.join(root, "challenges", "manual-fallback")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "Return flag{manual-fallback}")

  let solverCalls = 0
  let consultantCalls = 0
  const handle: RuntimeHandle = {
    backend: "fake",
    version: "test",
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: false,
      attachments: false,
      web: false,
      cancellation: true,
      providerManagement: false,
      providerOAuth: false,
      compaction: false,
    },
    agent: {
      async createConversation(input) {
        const sessionID = `manual-fallback-${crypto.randomUUID()}`
        return {
          id: sessionID,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(prompt) {
            if (prompt.agent === "boom-consultant") {
              consultantCalls += 1
              throw new Error("consultation provider unavailable")
            }
            solverCalls += 1
            if (solverCalls === 1) expect(prompt.text).toContain("Start a fresh solver turn")
            if (!prompt.text.includes("# Writeup turn")) {
              await submitCandidate({
                directory: input.directory,
                sessionID,
                candidate: "flag{manual-fallback}",
              })
            }
            return {
              usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              finish: "stop" as const,
              parts: [{ type: "text", text: "Recovered flag{manual-fallback}" }],
            }
          },
          async abort() {},
        }
      },
    },
    close() {},
  }
  const runner = new GuiRunner(
    root,
    async () => handle,
    new MockSubmissionGateway([{
      id: "test-platform",
      async submitFlag() {
        return {
          adapter: "test-platform",
          verdict: "accepted",
          detail: "accepted after consultation fallback",
          submittedAt: new Date().toISOString(),
        }
      },
    }]),
  )
  try {
    await runner.enqueue({
      challenges: [{
        slug: "manual-fallback",
        directory: source,
        description: "Return flag{manual-fallback}",
        files: [],
        flagFormat: "flag\\{[^}]+\\}",
        platform: { adapter: "test-platform", challengeID: "manual-fallback-1" },
      }],
      model: "test/solver",
      modelPolicy: { economy: "test/solver", strong: "test/solver" },
      consultModels: ["test/expert-a", "test/expert-b"],
      blindReview: false,
      consultation: {
        trigger: "manual",
        expertModels: ["test/expert-a", "test/expert-b"],
        synthesizerModel: "test/solver",
      },
      limits: { tokens: 20_000, repeats: 3, timeout: 30_000 },
      flagFormat: "flag\\{[^}]+\\}",
      pythonInterpreter: interpreter,
    })
    for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1)
      await Bun.sleep(10)

    expect(runner.hasWork()).toBe(false)
    expect(consultantCalls).toBe(4)
    // Initial solve turn + consultation-fallback solver turn + automatic writeup turn.
    expect(solverCalls).toBe(3)
    const [runID] = await readdir(path.join(root, "runs", "manual-fallback"))
    const result = JSON.parse(await readFile(
      path.join(root, "runs", "manual-fallback", runID!, "result.json"),
      "utf8",
    ))
    expect(result).toMatchObject({
      stop: "completed",
      candidates: ["flag{manual-fallback}"],
    })
  } finally {
    await runner.close()
  }
})

test("a hot-switch request arriving during turn wind-down still queues its followup", async () => {
  const interpreter = Bun.which("python3")
  if (!interpreter) return
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-runner-late-switch-"))
  temporary.push(directory)
  const root = path.join(directory, "ctf")
  const source = path.join(root, "challenges", "late-switch")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "Return flag{late}")

  // The switch lands while the first turn is already winding down inside the platform submission:
  // runChallenge has resolved, so outcome.stop stays "completed" and only the pendingSwitch field
  // carries the request. The gate must still queue the switched followup and clear the request.
  const challenge = {
    slug: "late-switch",
    directory: source,
    description: "Return flag{late}",
    files: [],
    flagFormat: "flag\\{[^}]+\\}",
    platform: { adapter: "test-platform", challengeID: "late-switch-1" },
  }
  const workspace = await prepareWorkspace(root, challenge, "task")
  // Suppress the one-shot autonomy continuation so the followup count stays deterministic.
  await markAutomaticContinuation(workspace.directory)

  const prompts: Array<{ agent: string; model: string; text: string }> = []
  let solverTurns = 0
  let submissionReached = false
  let releaseSubmission: (() => void) | undefined
  const submissionGate = new Promise<void>((resolve) => { releaseSubmission = resolve })
  const handle: RuntimeHandle = {
    backend: "fake",
    version: "test",
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: false,
      attachments: true,
      web: false,
      cancellation: true,
      providerManagement: false,
      providerOAuth: false,
      compaction: false,
      compactionHooks: false,
    },
    agent: {
      async createConversation(input) {
        const id = `conversation-${solverTurns + 1}`
        return {
          id,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(prompt) {
            prompts.push({ agent: prompt.agent, model: prompt.model, text: prompt.text })
            if (prompt.agent !== "boom") throw new Error(`unexpected agent prompt: ${prompt.agent}`)
            solverTurns += 1
            if (solverTurns === 1)
              await submitCandidate({
                directory: input.directory,
                sessionID: id,
                candidate: "flag{late}",
              })
            return {
              usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              finish: "stop" as const,
              parts: [{ type: "text", text: "done" }],
            }
          },
          async abort() {},
        }
      },
    },
    close() {},
  }
  let submissionCalls = 0
  const runner = new GuiRunner(root, async () => handle, {
    async submitFlagWithRetry() {
      submissionCalls += 1
      submissionReached = true
      await submissionGate
      return {
        adapter: "test-platform",
        verdict: "rejected" as const,
        detail: "wrong value",
        submittedAt: new Date().toISOString(),
      }
    },
  })
  try {
    await runner.enqueue({
      challenges: [challenge],
      model: "openai/old",
      modelPolicy: { economy: "openai/old", strong: "openai/old" },
      consultModels: [],
      blindReview: false,
      limits: { tokens: 100_000, repeats: 5, timeout: 60_000 },
      flagFormat: "flag\\{[^}]+\\}",
      pythonInterpreter: interpreter,
      workspaces: { "late-switch": workspace.runID },
    })
    for (let attempt = 0; attempt < 500 && !submissionReached; attempt += 1)
      await Bun.sleep(10)
    expect(submissionReached).toBe(true)

    const switched = await runner.applyLiveModelSettings({
      economyModel: "openai/old",
      strongModel: "openai/next",
      consultModels: [],
      blindReview: false,
      consultOnCompaction: false,
      network: "allow",
    })
    expect(switched.active).toBe(1)
    releaseSubmission?.()
    for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1)
      await Bun.sleep(10)
    expect(runner.hasWork()).toBe(false)

    const solvePrompts = prompts.filter((item) => item.agent === "boom")
    // The stranded request was consumed exactly once: the followup runs on the switched model and
    // carries the hot-swap handoff hint.
    expect(solvePrompts.map((item) => item.model)).toEqual(["openai/old", "openai/next"])
    expect(solvePrompts[1]?.text).toContain("Model hot-swap: openai/old -> openai/next")
    expect(solvePrompts).toHaveLength(2)

    const [runID] = await readdir(path.join(root, "runs", "late-switch"))
    const run = path.join(root, "runs", "late-switch", runID!)
    expect(JSON.parse(await readFile(path.join(run, "task.json"), "utf8"))).toMatchObject({
      turns: [
        { model: "openai/old", stop: "completed" },
        { model: "openai/next" },
      ],
    })
    // The rejected candidate entered the ledger once per live platform response.
    expect(submissionCalls).toBe(1)
    const ledger = JSON.parse(
      await readFile(path.join(root, "competition", "submissions", "late-switch.json"), "utf8"),
    )
    expect(ledger.attempts).toEqual([
      expect.objectContaining({
        value: "late",
        verdict: "rejected",
        detail: expect.stringContaining("[attempt 1]"),
      }),
    ])
    // The evaluated candidate slot is marked consumed so a later turn cannot re-offer it.
    expect(typeof JSON.parse(await readFile(path.join(run, "work", "RESULT.json"), "utf8")).consumedAt)
      .toBe("string")
  } finally {
    await runner.close()
  }
})

test("a late hot switch on an accepted flag defers to the writeup and reports the stranded request", async () => {
  const interpreter = Bun.which("python3")
  if (!interpreter) return
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-runner-late-switch-accepted-"))
  temporary.push(directory)
  const root = path.join(directory, "ctf")
  const source = path.join(root, "challenges", "late-switch-accepted")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "Return flag{late}")

  const challenge = {
    slug: "late-switch-accepted",
    directory: source,
    description: "Return flag{late}",
    files: [],
    flagFormat: "flag\\{[^}]+\\}",
    platform: { adapter: "test-platform", challengeID: "late-switch-accepted-1" },
  }
  const workspace = await prepareWorkspace(root, challenge, "task")
  await markAutomaticContinuation(workspace.directory)

  const prompts: Array<{ agent: string; model: string; text: string }> = []
  let solverTurns = 0
  let submissionReached = false
  let releaseSubmission: (() => void) | undefined
  const submissionGate = new Promise<void>((resolve) => { releaseSubmission = resolve })
  const handle: RuntimeHandle = {
    backend: "fake",
    version: "test",
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: false,
      attachments: true,
      web: false,
      cancellation: true,
      providerManagement: false,
      providerOAuth: false,
      compaction: false,
      compactionHooks: false,
    },
    agent: {
      async createConversation(input) {
        const id = `conversation-${solverTurns + 1}`
        return {
          id,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(prompt) {
            prompts.push({ agent: prompt.agent, model: prompt.model, text: prompt.text })
            if (prompt.agent !== "boom") throw new Error(`unexpected agent prompt: ${prompt.agent}`)
            solverTurns += 1
            if (solverTurns === 1)
              await submitCandidate({
                directory: input.directory,
                sessionID: id,
                candidate: "flag{late}",
              })
            else
              await writeFile(
                path.join(input.directory, "work", "WRITEUP.md"),
                "# Writeup\n\nRead challenge/README.md; the supplied value reproduces.\n\nFlag: flag{late}\n",
              )
            return {
              usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              finish: "stop" as const,
              parts: [{ type: "text", text: "done" }],
            }
          },
          async abort() {},
        }
      },
    },
    close() {},
  }
  const runner = new GuiRunner(root, async () => handle, {
    async submitFlagWithRetry() {
      submissionReached = true
      await submissionGate
      return {
        adapter: "test-platform",
        verdict: "accepted" as const,
        detail: "accepted by test platform",
        submittedAt: new Date().toISOString(),
      }
    },
  })
  try {
    await runner.enqueue({
      challenges: [challenge],
      model: "openai/old",
      modelPolicy: { economy: "openai/old", strong: "openai/old" },
      consultModels: [],
      blindReview: false,
      limits: { tokens: 100_000, repeats: 5, timeout: 60_000 },
      flagFormat: "flag\\{[^}]+\\}",
      pythonInterpreter: interpreter,
      workspaces: { "late-switch-accepted": workspace.runID },
    })
    for (let attempt = 0; attempt < 500 && !submissionReached; attempt += 1)
      await Bun.sleep(10)
    expect(submissionReached).toBe(true)

    await runner.applyLiveModelSettings({
      economyModel: "openai/old",
      strongModel: "openai/next",
      consultModels: [],
      blindReview: false,
      consultOnCompaction: false,
      network: "allow",
    })
    releaseSubmission?.()
    for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1)
      await Bun.sleep(10)
    expect(runner.hasWork()).toBe(false)

    // The switch must not hijack the solved task into a doomed solve turn: the mandatory writeup
    // runs instead and the task still reaches its archived end state.
    expect(prompts.map((item) => item.model)).toEqual(["openai/old", "openai/old"])
    expect(prompts[1]?.text).toContain("Generate work/WRITEUP.md offline")
    const [runID] = await readdir(path.join(root, "runs", "late-switch-accepted"))
    const run = path.join(root, "runs", "late-switch-accepted", runID!)
    expect(JSON.parse(await readFile(path.join(run, "task.json"), "utf8"))).toMatchObject({
      status: "archived",
      acceptedFlag: { value: "flag{late}" },
    })
    // The stranded request is reported loudly instead of dying silently.
    const events = (await readFile(path.join(run, "work", "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const warning = events.find((event) => event.status === "model.switch.not-applied")
    expect(warning).toBeDefined()
    expect(warning.text).toContain("切换请求未能生效")
    expect(warning.text).toContain("该题已有被接受的 flag")
    expect(warning.text).toContain("openai/next")
  } finally {
    await runner.close()
  }
})
