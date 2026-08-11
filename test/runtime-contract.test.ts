import { describe, expect, test } from "bun:test"
import { GuiRunner } from "../src/runner.ts"
import type {
  AgentRuntime,
  RuntimeHandle,
  RuntimePrompt,
} from "../src/runtime-contract.ts"
import { completeRuntimePrompt, runtimeFailureUsage, runtimeReplyText } from "../src/runtime-turn.ts"
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
