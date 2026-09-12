import { describe, expect, test } from "bun:test"
import { GuiRunner } from "../src/runner.ts"
import type {
  AgentRuntime,
  RuntimeHandle,
  RuntimePrompt,
} from "../src/runtime-contract.ts"
import { completeRuntimePrompt, RuntimePromptFailure, runtimeFailureUsage, runtimeReplyText } from "../src/runtime-turn.ts"
import { resolveRuntimeForkBoundary, runtimeForkBoundaries } from "../src/runtime-messages.ts"

function fakeAgent(seen: RuntimePrompt[]): AgentRuntime {
  return {
    async createConversation() {
      return {
        id: "fake-conversation",
        async events() {
          return { async *[Symbol.asyncIterator]() {} }
        },
        async prompt(input) {
          seen.push(input)
          return {
            parts: [{ type: "text", text: "portable reply" }],
            usage: { input: 4, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
            cost: 0.01,
            finish: "stop",
          }
        },
        async abort() {},
      }
    },
  }
}

describe("Boom runtime contract", () => {
  test("accepts only complete API-round fork boundaries without orphaning tool pairs", () => {
    const native = [
      { id: "user-1", role: "user" as const, parts: [{ type: "text", text: "inspect" }] },
      {
        id: "assistant-tools",
        role: "assistant" as const,
        parts: [{ type: "tool", tool: "read", callID: "call-1", state: "pending" as const }],
      },
      {
        id: "tool-1",
        role: "tool" as const,
        parts: [{ type: "tool", tool: "read", callID: "call-1", state: "completed" as const }],
      },
      { id: "assistant-final", role: "assistant" as const, parts: [{ type: "text", text: "done" }] },
    ]
    expect(runtimeForkBoundaries(native)).toEqual(["tool-1", "assistant-final"])
    expect(resolveRuntimeForkBoundary(native)).toBe("assistant-final")
    expect(() => resolveRuntimeForkBoundary(native, "assistant-tools"))
      .toThrow("not a complete API-round boundary")
    expect(() => resolveRuntimeForkBoundary(native, "missing")).toThrow("does not exist")

    const opencode = [{
      id: "assistant-combined",
      role: "assistant" as const,
      parts: [{
        type: "tool",
        tool: "read",
        callID: "call-combined",
        state: "completed" as const,
        output: "evidence",
      }],
    }]
    expect(runtimeForkBoundaries(opencode)).toEqual(["assistant-combined"])
  })

  test("runs a model turn without exposing backend-native model or session shapes", async () => {
    const seen: RuntimePrompt[] = []
    const result = await completeRuntimePrompt({
      runtime: fakeAgent(seen),
      directory: "/tmp/portable-runtime-test",
      title: "portable",
      agent: "boom-worker",
      model: "any-backend/model-a",
      prompt: "inspect evidence",
    })
    expect(seen).toEqual([{
      agent: "boom-worker",
      model: "any-backend/model-a",
      text: "inspect evidence",
      signal: undefined,
    }])
    expect(runtimeReplyText(result.parts)).toBe("portable reply")
    expect(result.usage?.reasoning).toBe(1)
  })

  test("subscribes before prompt, filters foreign sessions, drains terminal events, and closes", async () => {
    let subscribed = false
    let closed = 0
    const seen: string[] = []
    const runtime: AgentRuntime = {
      async createConversation() {
        return {
          id: "owned",
          async events() {
            subscribed = true
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: "text-delta", sessionID: "foreign", delta: "wrong" } as const
                yield { type: "text-delta", sessionID: "owned", delta: "live" } as const
                yield { type: "finish", sessionID: "owned", reason: "stop" } as const
              },
            }
          },
          async prompt() {
            expect(subscribed).toBe(true)
            return { parts: [{ type: "text", text: "final" }], cost: 0, finish: "stop" }
          },
          async abort() {},
          async close() { closed += 1 },
        }
      },
    }
    const result = await completeRuntimePrompt({
      runtime,
      directory: "/tmp/streamed-runtime-test",
      title: "streamed",
      agent: "boom-consultant",
      model: "test/model",
      prompt: "inspect",
      onEvent: ({ event }) => seen.push(`${event.sessionID}:${event.type}`),
    })
    expect(runtimeReplyText(result.parts)).toBe("final")
    expect(seen).toEqual(["owned:text-delta", "owned:finish"])
    expect(closed).toBe(1)
  })

  test("enforces a hard token ceiling from live multi-step usage and preserves failed usage", async () => {
    let aborted = 0
    const runtime: AgentRuntime = {
      async createConversation() {
        return {
          id: "budgeted",
          async events() {
            return {
              async *[Symbol.asyncIterator]() {
                const usage = { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
                yield { type: "step-finish", sessionID: "budgeted", usage, cost: 0.1 } as const
                yield { type: "step-finish", sessionID: "budgeted", usage, cost: 0.2 } as const
                yield { type: "finish", sessionID: "budgeted", reason: "cancelled" } as const
              },
            }
          },
          async prompt() {
            await new Promise((resolve) => setTimeout(resolve, 0))
            return { parts: [], cost: 0.2, finish: "cancelled" as const }
          },
          async abort() { aborted += 1 },
        }
      },
    }
    let failure: unknown
    try {
      await completeRuntimePrompt({
        runtime,
        directory: "/tmp/budgeted-runtime-test",
        title: "budgeted",
        agent: "boom-worker",
        model: "test/model",
        prompt: "objective",
        tokenBudget: 10,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(runtimeFailureUsage(failure)).toMatchObject({
      usage: { input: 8, output: 4 },
      cost: 0.2,
    })
    expect(aborted).toBeGreaterThan(0)
  })

  test("enforces the ask ceiling from result usage when no step events arrive", async () => {
    const runtime: AgentRuntime = {
      async createConversation() {
        return {
          id: "silent-budget",
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt() {
            return {
              parts: [{ type: "text", text: "expensive answer" }],
              usage: { input: 600, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0.5,
              finish: "stop" as const,
            }
          },
          async abort() {},
        }
      },
    }
    let failure: unknown
    try {
      await completeRuntimePrompt({
        runtime,
        directory: "/tmp/silent-budget-runtime-test",
        title: "silent",
        agent: "boom-worker",
        model: "test/model",
        prompt: "objective",
        tokenBudget: 500,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(RuntimePromptFailure)
    expect((failure as Error).message).toContain("runtime prompt token budget exceeded: 700 > 500")
    expect(runtimeFailureUsage(failure)).toMatchObject({
      usage: { input: 600, output: 100 },
      cost: 0.5,
    })
  })

  test("lets the GUI inject an agent-only backend without provider management", async () => {
    let closed = 0
    const handle: RuntimeHandle = {
      backend: "fake",
      version: "test",
      capabilities: {
        eventStreaming: true,
        toolCalls: true,
        reasoning: true,
        attachments: false,
        web: false,
        cancellation: true,
        providerManagement: false,
        providerOAuth: false,
        compaction: false,
        compactionHooks: false,
      },
      agent: fakeAgent([]),
      close() { closed += 1 },
    }
    const runner = new GuiRunner("/tmp", async () => handle)
    expect((await runner.ensureRuntime()).backend).toBe("fake")
    expect(await runner.getModels()).toEqual([
      expect.objectContaining({ id: "free/deepseek-v4-flash-free" }),
    ])
    await expect(runner.getProviders()).rejects.toThrow("does not support provider management")
    await runner.close()
    expect(closed).toBe(1)
  })
})

describe("Boom runtime turn sessions", () => {
  const DIRECTORY = "/tmp/portable-session-test"

  function resumableAgent(options: { fail?: string } = {}) {
    const created: string[] = []
    const resumed: string[] = []
    const prompts: string[] = []
    const agent: AgentRuntime = {
      async createConversation() {
        const id = `conv-${created.length}`
        created.push(id)
        return {
          id,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(input) {
            prompts.push(input.text)
            return { parts: [{ type: "text", text: "ok" }], usage: undefined, cost: 0, finish: "stop" }
          },
          async abort() {},
        }
      },
      async resumeConversation(input: { id: string }) {
        if (options.fail) throw new Error(options.fail)
        resumed.push(input.id)
        return {
          id: input.id,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(input2) {
            prompts.push(input2.text)
            return { parts: [{ type: "text", text: "resumed" }], usage: undefined, cost: 0, finish: "stop" }
          },
          async abort() {},
        }
      },
    }
    return { agent, created, resumed, prompts }
  }

  test("resumes the durable session and reports the outcome before the prompt is sent", async () => {
    const { agent, created, resumed, prompts } = resumableAgent()
    const seen: Array<{ id: string; resumed: boolean; reason?: string }> = []
    const result = await completeRuntimePrompt({
      runtime: agent,
      directory: DIRECTORY,
      title: "portable",
      agent: "boom",
      model: "test/model",
      prompt: (session) => `mode=${session.resumed ? "resume" : "fresh"}`,
      resumeSessionID: "conv-durable",
      onSession: (info) => seen.push(info),
    })
    expect(resumed).toEqual(["conv-durable"])
    expect(created).toEqual([])
    expect(seen).toEqual([{ id: "conv-durable", resumed: true }])
    // The prompt saw the real outcome, so a resumed turn can be assembled differently.
    expect(prompts).toEqual(["mode=resume"])
    expect(runtimeReplyText(result.parts)).toBe("resumed")
  })

  test("falls back to a fresh session and reports why resumption was impossible", async () => {
    const { agent, created, prompts } = resumableAgent({ fail: "Session not found" })
    const seen: Array<{ id: string; resumed: boolean; reason?: string }> = []
    await completeRuntimePrompt({
      runtime: agent,
      directory: DIRECTORY,
      title: "portable",
      agent: "boom",
      model: "test/model",
      prompt: (session) => `mode=${session.resumed ? "resume" : "fresh"}`,
      resumeSessionID: "conv-gone",
      onSession: (info) => seen.push(info),
    })
    expect(created).toEqual(["conv-0"])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: "conv-0", resumed: false })
    expect(seen[0]!.reason).toContain("conv-gone")
    expect(seen[0]!.reason).toContain("Session not found")
    expect(prompts).toEqual(["mode=fresh"])
  })

  test("reports a runtime without resume support instead of silently starting over", async () => {
    const seen: Array<{ id: string; resumed: boolean; reason?: string }> = []
    const result = await completeRuntimePrompt({
      runtime: fakeAgent([]),
      directory: DIRECTORY,
      title: "portable",
      agent: "boom",
      model: "test/model",
      prompt: "plain prompt",
      resumeSessionID: "conv-unsupported",
      onSession: (info) => seen.push(info),
    })
    expect(seen[0]).toMatchObject({ id: "fake-conversation", resumed: false })
    expect(seen[0]!.reason).toContain("does not support session resume")
    expect(runtimeReplyText(result.parts)).toBe("portable reply")
  })
})
