import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadCandidateSubmission } from "../src/candidate-submission.ts"
import { compileBoomAgentRegistry } from "../src/runtime/agent.ts"
import {
  captureRuntimeTrace,
  M1_CONFORMANCE_CASES,
  M2_CONFORMANCE_CASES,
  M3_CONFORMANCE_CASES,
  M4_CONFORMANCE_CASES,
  M5_CONFORMANCE_CASES,
  normalizeRuntimeTrace,
  RUNTIME_CONFORMANCE_CASES,
} from "../src/runtime-conformance.ts"
import type { AgentRuntime, RuntimeEvent } from "../src/runtime-contract.ts"
import {
  normalizeOpenCodeContextMessage,
  normalizeOpenCodeRuntimeEvent,
  createOpenCodeConversationEventRouter,
  normalizeOpenCodeStoredMessage,
  startRuntime,
} from "../src/runtime.ts"
import { ScriptedProvider } from "./runtime-scripted-provider.ts"

const temporaryDirectories: string[] = []

async function temporary(prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe("runtime conformance specification", () => {
  test("defines the complete C01-C21 catalog and milestone subsets", () => {
    expect(RUNTIME_CONFORMANCE_CASES.map((item) => item.id)).toEqual(
      [
        "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09",
        "C10", "C11", "C12", "C13", "C14", "C15", "C16", "C17", "C18", "C19", "C20", "C21",
      ],
    )
    expect(M1_CONFORMANCE_CASES.map((item) => item.id)).toEqual([
      "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C13", "C17",
    ])
    expect(M2_CONFORMANCE_CASES.map((item) => item.id)).toEqual(["C01", "C13", "C17", "C19"])
    expect(M3_CONFORMANCE_CASES.map((item) => item.id)).toEqual([
      "C02", "C03", "C04", "C05", "C13", "C14", "C18", "C19", "C20",
    ])
    expect(M4_CONFORMANCE_CASES.map((item) => item.id)).toEqual([
      "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09",
      "C12", "C13", "C16", "C17", "C18", "C19", "C20", "C21",
    ])
    expect(M5_CONFORMANCE_CASES.map((item) => item.id)).toEqual([
      "C06", "C07", "C09", "C15", "C18",
    ])
    for (const item of RUNTIME_CONFORMANCE_CASES) {
      expect(item.acceptance.length).toBeGreaterThan(0)
      expect(item.capabilities.length).toBeGreaterThan(0)
    }
  })

  test("normalizes IDs, chunk boundaries, paths, secrets, and result references", () => {
    const workspace = "/tmp/boom-conformance-secret-workspace"
    const events: RuntimeEvent[] = [
      { type: "conversation-state", sessionID: "native-92", state: "generating" },
      { type: "text-delta", sessionID: "native-92", delta: "hel" },
      { type: "text-delta", sessionID: "native-92", delta: "lo" },
      { type: "reasoning-delta", sessionID: "native-92", delta: "inspect " },
      { type: "reasoning-delta", sessionID: "native-92", delta: "evidence" },
      {
        type: "tool-state",
        sessionID: "native-92",
        callID: "provider-call-77",
        tool: "read",
        state: { status: "running", input: { path: `${workspace}/challenge/a`, token: "token=abc" } },
      },
      {
        type: "step-finish",
        sessionID: "native-92",
        reason: "stop",
        cost: 0.2,
        usage: { input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
      },
    ]
    const trace = normalizeRuntimeTrace({
      workspace,
      events,
      result: {
        parts: [{
          type: "tool",
          tool: "read",
          callID: "provider-call-77",
          state: { status: "completed", input: { path: `${workspace}/challenge/a` }, title: "done" },
        }],
        cost: 0.2,
        finish: "stop",
        requestID: "backend-request-random",
      },
    })

    expect(trace).toEqual([
      { kind: "state", conversation: "conversation-1", state: "generating" },
      { kind: "text", conversation: "conversation-1", text: "hello" },
      { kind: "reasoning", conversation: "conversation-1", text: "inspect evidence" },
      {
        kind: "tool",
        conversation: "conversation-1",
        call: "call-1",
        tool: "read",
        state: "running",
        input: { path: "<workspace>/challenge/a", token: "token=[redacted]" },
      },
      {
        kind: "usage",
        conversation: "conversation-1",
        reason: "stop",
        cost: 0.2,
        usage: { input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
      },
      {
        kind: "result",
        parts: [{
          type: "tool",
          tool: "read",
          call: "call-1",
          state: { input: { path: "<workspace>/challenge/a" }, status: "completed", title: "done" },
        }],
        cost: 0.2,
        finish: "stop",
        request: "request-1",
      },
    ])
  })

  test("subscribes before prompt and captures a backend-neutral trace", async () => {
    const order: string[] = []
    const runtime: AgentRuntime = {
      async createConversation() {
        return {
          id: "scripted-conversation",
          async events() {
            order.push("subscribe")
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: "text-delta", sessionID: "scripted-conversation", delta: "portable" } as const
                yield {
                  type: "conversation-state",
                  sessionID: "scripted-conversation",
                  state: "completed",
                } as const
              },
            }
          },
          async prompt() {
            order.push("prompt")
            return { parts: [{ type: "text", text: "portable" }], cost: 0, finish: "stop" }
          },
          async abort() {},
        }
      },
    }
    const trace = await captureRuntimeTrace({
      runtime,
      directory: "/tmp/portable-conformance",
      title: "portable",
      agent: "boom-consultant",
      model: "scripted/model",
      prompt: "inspect",
    })
    expect(order).toEqual(["subscribe", "prompt"])
    expect(trace).toEqual([
      { kind: "text", conversation: "conversation-1", text: "portable" },
      { kind: "state", conversation: "conversation-1", state: "completed" },
      {
        kind: "result",
        parts: [{ type: "text", text: "portable" }],
        cost: 0,
        finish: "stop",
      },
    ])
  })
})

describe("OpenCode adapter normalization", () => {
  test("preserves compaction summary, recent tail, and completed tool results without provider metadata", () => {
    expect(normalizeOpenCodeContextMessage({
      id: "compact-1",
      type: "compaction",
      time: { created: 42 },
      reason: "auto",
      summary: "Tried RSA factoring and ruled out small primes.",
      recent: "Next recover the nonce from trace 9.",
      providerMetadata: { authorization: "Bearer should-not-cross" },
    })).toEqual({
      id: "compact-1",
      role: "compaction",
      createdAt: 42,
      parts: [
        { type: "summary", text: "Tried RSA factoring and ruled out small primes." },
        { type: "recent", text: "Next recover the nonce from trace 9." },
      ],
    })

    expect(normalizeOpenCodeContextMessage({
      id: "assistant-1",
      type: "assistant",
      agent: "boom",
      model: { providerID: "secret", modelID: "hidden" },
      content: [{
        id: "tool-1",
        type: "tool",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "strings challenge.bin", apiKey: "abc123" },
          result: "candidate bytes: 66 6c 61 67",
          providerMetadata: { token: "do-not-copy" },
        },
      }],
    })).toEqual({
      id: "assistant-1",
      role: "assistant",
      parts: [{
        type: "tool",
        tool: "bash",
        state: "completed",
        input: '{"command":"strings challenge.bin","apiKey":"[redacted]"}',
        output: "candidate bytes: 66 6c 61 67",
      }],
    })
  })

  test("preserves stored message IDs, call pairing, tool errors, and sanitized provider failures", () => {
    expect(normalizeOpenCodeStoredMessage({
      info: {
        id: "assistant-stored",
        role: "assistant",
        time: { created: 84 },
        error: {
          name: "APIError",
          data: {
            message: "request failed token=secret-value",
            statusCode: 500,
            responseHeaders: { authorization: "Bearer must-not-cross" },
          },
        },
      },
      parts: [{
        type: "tool",
        callID: "call-stored",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "false" },
          error: "exit 1 apiKey=hidden",
        },
      }],
    })).toEqual({
      id: "assistant-stored",
      role: "assistant",
      createdAt: 84,
      parts: [
        {
          type: "tool",
          tool: "bash",
          callID: "call-stored",
          state: "error",
          input: '{"command":"false"}',
          error: "exit 1 apiKey=[redacted]",
        },
        { type: "error", error: "APIError: request failed token=[redacted] status=500" },
      ],
    })
  })

  test("maps lifecycle, reasoning, compaction, error, and finish events", () => {
    expect(normalizeOpenCodeRuntimeEvent({
      type: "session.status",
      properties: { sessionID: "ses", status: { type: "busy" } },
    })).toEqual({ type: "conversation-state", sessionID: "ses", state: "generating" })
    expect(normalizeOpenCodeRuntimeEvent({
      type: "message.part.updated",
      properties: {
        delta: "visible summary",
        part: { type: "reasoning", sessionID: "ses" },
      },
    })).toEqual({ type: "reasoning-delta", sessionID: "ses", delta: "visible summary" })
    expect(normalizeOpenCodeRuntimeEvent({
      type: "message.part.updated",
      properties: { part: { type: "compaction", sessionID: "ses" } },
    })).toEqual({ type: "compaction", sessionID: "ses", state: "started" })
    expect(normalizeOpenCodeRuntimeEvent({
      type: "session.error",
      properties: {
        sessionID: "ses",
        error: { name: "ApiError", data: { statusCode: 429, message: "rate limited" } },
      },
    })).toEqual({
      type: "provider-diagnostic",
      sessionID: "ses",
      level: "error",
      error: {
        name: "ApiError",
        message: "rate limited",
        category: "rate-limit",
        statusCode: 429,
      },
    })
    expect(normalizeOpenCodeRuntimeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "ses",
          reason: "max_tokens",
          cost: 1,
          tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 0 } },
        },
      },
    })).toEqual({
      type: "step-finish",
      sessionID: "ses",
      reason: "length",
      cost: 1,
      usage: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 0 } },
    })
  })

  test("routes descendant task usage into the root budget without leaking worker chatter", () => {
    const descendants = new Set<string>()
    const route = createOpenCodeConversationEventRouter("root", descendants)
    expect(route({
      type: "session.created",
      properties: { info: { id: "worker", parentID: "root" } },
    })).toBeUndefined()
    expect(route({
      type: "message.part.updated",
      properties: {
        delta: "worker private analysis",
        part: { type: "text", sessionID: "worker" },
      },
    })).toBeUndefined()
    expect(route({
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "root",
          cost: 0.2,
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    })).toMatchObject({ sessionID: "root", cost: 0.2, usage: { input: 10, output: 2 } })
    expect(route({
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "worker",
          cost: 0.3,
          tokens: { input: 20, output: 4, reasoning: 1, cache: { read: 0, write: 0 } },
        },
      },
    })).toMatchObject({ sessionID: "root", cost: 0.5, usage: { input: 20, output: 4, reasoning: 1 } })
    // The conversation can abort the workers it discovered; a pause must not leave one behind.
    expect(descendants).toEqual(new Set(["worker"]))
  })

  test("derives reasoning deltas from whole-part updates before the message role is known", () => {
    const context = { accumulatedParts: new Map<string, string>(), messageRoles: new Map<string, string>() }
    expect(normalizeOpenCodeRuntimeEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "p1", type: "reasoning", sessionID: "ses", messageID: "msg-1", text: "step one" },
      },
    }, context)).toEqual({ type: "reasoning-delta", sessionID: "ses", delta: "step one" })
    expect(normalizeOpenCodeRuntimeEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "p1", type: "reasoning", sessionID: "ses", messageID: "msg-1", text: "step one, step two" },
      },
    }, context)).toEqual({ type: "reasoning-delta", sessionID: "ses", delta: ", step two" })

    // A role that is known to be non-assistant stays filtered even once parts accumulated.
    const filtered = { accumulatedParts: new Map<string, string>(), messageRoles: new Map([["msg-2", "user"]]) }
    expect(normalizeOpenCodeRuntimeEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "p2", type: "text", sessionID: "ses", messageID: "msg-2", text: "user text" },
      },
    }, filtered)).toBeUndefined()
  })

  test("filters events from other sessions in a real scripted-provider turn", async () => {
    const provider = new ScriptedProvider([{
      type: "completion",
      text: ["hello", " from scripted provider"],
      usage: { input: 11, output: 4, reasoning: 0, cacheRead: 2 },
    }])
    const boomHome = await temporary("boom-m1-home-")
    const workspace = await temporary("boom-m1-workspace-")
    await mkdir(path.join(workspace, "work"), { recursive: true })
    await writeFile(path.join(workspace, "NOTES.md"), "# NOTES\n")
    await writeFile(path.join(boomHome, "providers.json"), `${JSON.stringify({
      version: 1,
      armorPrompts: [],
      providers: {
        scripted: {
          id: "scripted",
          custom: true,
          disabled: false,
          name: "Boom Scripted Provider",
          npm: "@ai-sdk/openai-compatible",
          baseURL: provider.baseURL,
          models: [{
            id: "conformance",
            name: "Conformance",
            context: 32_768,
            output: 4_096,
            reasoning: false,
            attachment: false,
          }],
          hiddenModels: [],
        },
      },
    }, undefined, 2)}\n`)

    const foreignConfigHome = await temporary("boom-m2-foreign-opencode-")
    await mkdir(path.join(foreignConfigHome, "opencode"), { recursive: true })
    await writeFile(path.join(foreignConfigHome, "opencode", "opencode.json"), `${JSON.stringify({
      agent: {
        "boom-consultant": {
          prompt: "LEAKED FOREIGN AGENT PROMPT",
          tools: { bash: false },
        },
      },
    })}\n`)

    const keys = [
      "BOOM_HOME", "BOOM_SCRIPTED_API_KEY", "OPENCODE_CONFIG_DIR",
      "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_AUTOUPDATE", "PATH", "XDG_CONFIG_HOME",
    ] as const
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    process.env.BOOM_HOME = boomHome
    process.env.BOOM_SCRIPTED_API_KEY = "scripted-test-key"
    process.env.XDG_CONFIG_HOME = foreignConfigHome
    let handle: Awaited<ReturnType<typeof startRuntime>> | undefined
    try {
      handle = await startRuntime()
      const trace = await captureRuntimeTrace({
        runtime: handle.agent,
        directory: workspace,
        title: "M1 C07 scripted baseline",
        agent: "boom-consultant",
        model: "scripted/conformance",
        prompt: "Reply with a short conformance marker.",
      })
      expect(provider.remaining).toBe(0)
      expect(provider.requests).toHaveLength(1)
      expect(provider.requests[0]?.pathname).toBe("/v1/chat/completions")
      expect(trace).toContainEqual({
        kind: "text",
        conversation: "conversation-1",
        text: "hello from scripted provider",
      })
      expect(trace).toContainEqual(expect.objectContaining({
        kind: "usage",
        conversation: "conversation-1",
        usage: expect.objectContaining({ input: 9, output: 4, cache: { read: 2, write: 0 } }),
      }))
      expect(trace.at(-1)).toEqual(expect.objectContaining({
        kind: "result",
        finish: "stop",
      }))
      const tools = provider.requests[0]?.body?.tools
      expect(Array.isArray(tools)).toBe(true)
      const exposed = JSON.stringify(tools)
      for (const name of ["bash", "read", "glob", "grep", "task"])
        expect(exposed).toContain(`\"${name}\"`)
      expect(JSON.stringify(provider.requests[0]?.body?.messages)).not.toContain("LEAKED FOREIGN AGENT PROMPT")

      provider.enqueue(
        {
          type: "completion",
          tools: [{ id: "stored-read", name: "read", arguments: '{"filePath":"NOTES.md"}' }],
        },
        { type: "completion", text: "durable session marker", usage: { input: 12, output: 3 } },
      )
      const conversation = await handle.agent.createConversation({ directory: workspace, title: "C12 full access" })
      const turn = await conversation.prompt({
        agent: "boom",
        model: "scripted/conformance",
        text: "Read the notes and report the durable marker.",
      })
      expect(turn.finish).toBe("stop")
      const full = await conversation.messages!()
      expect(full[0]?.role).toBe("user")
      expect(full.at(-1)?.role).toBe("assistant")
      const storedTool = full.flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.callID === "stored-read")
      expect(storedTool).toEqual(expect.objectContaining({
        tool: "read",
        callID: "stored-read",
        state: "completed",
      }))
      expect(storedTool?.output).toContain("# NOTES")
      expect(await conversation.activeContext!()).not.toEqual([])
      await expect(conversation.fork!({ messageID: full[0]!.id }))
        .rejects.toThrow("not a complete API-round boundary")

      const toolBoundary = full.findIndex((message) =>
        message.role === "assistant" && message.parts.some((part) => part.callID === "stored-read")
      )
      expect(toolBoundary).toBeGreaterThan(0)
      const earlyFork = await conversation.fork!({ messageID: full[toolBoundary]!.id })
      expect((await earlyFork.messages!()).map(({ role, parts }) => ({ role, parts })))
        .toEqual(full.slice(0, toolBoundary + 1).map(({ role, parts }) => ({ role, parts })))

      const forked = await conversation.fork!()
      expect(forked.id).not.toBe(conversation.id)
      expect((await forked.messages!()).map(({ role, parts }) => ({ role, parts })))
        .toEqual(full.map(({ role, parts }) => ({ role, parts })))

      const originalID = conversation.id
      await conversation.close?.()
      await handle.close()
      handle = undefined
      handle = await startRuntime()
      await expect(handle.agent.resumeConversation!({ directory: workspace, id: originalID }))
        .rejects.toThrow("Session not found")
    } finally {
      await handle?.close()
      provider.stop()
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 50_000)

  test("replays the M1 OpenCode behavior matrix against one scripted provider", async () => {
    const provider = new ScriptedProvider([])
    const boomHome = await temporary("boom-m1-matrix-home-")
    const project = await temporary("boom-m1-matrix-project-")
    const workspace = path.join(project, "tasks", "case-task")
    await mkdir(path.join(workspace, "input"), { recursive: true })
    await mkdir(path.join(workspace, "work", ".boom"), { recursive: true })
    await writeFile(path.join(workspace, "input", "challenge.json"), '{"slug":"case","description":"fixture"}\n')
    await writeFile(path.join(workspace, "work", "edit.txt"), "before\n")
    await writeFile(path.join(workspace, "NOTES.md"), "# NOTES\n")
    await writeFile(path.join(workspace, "work", ".boom", "environment.json"), `${JSON.stringify({
      profileId: "m1-scripted-python",
      displayName: "M1 fixture",
      kind: "python",
      interpreter: "/usr/bin/python3",
      pythonVersion: "3",
      architecture: process.arch,
      packages: {},
      installPolicy: "deny",
      fingerprint: "m1-scripted-environment",
      source: "task-override",
      executionMode: "managed",
      boundAt: "2026-08-03T00:00:00Z",
    })}\n`)
    const initialized = Bun.spawn(["git", "init", "--quiet", project], { stdout: "ignore", stderr: "ignore" })
    expect(await initialized.exited).toBe(0)
    const canonicalWorkspace = await realpath(workspace)
    await writeFile(path.join(boomHome, "providers.json"), `${JSON.stringify({
      version: 1,
      armorPrompts: [],
      providers: {
        scripted: {
          id: "scripted",
          custom: true,
          disabled: false,
          name: "Boom Scripted Provider",
          npm: "@ai-sdk/openai-compatible",
          baseURL: provider.baseURL,
          models: [{
            id: "conformance",
            name: "Conformance",
            context: 32_768,
            output: 4_096,
            reasoning: false,
            attachment: false,
          }],
          hiddenModels: [],
        },
      },
    }, undefined, 2)}\n`)

    const keys = [
      "BOOM_HOME", "BOOM_SCRIPTED_API_KEY", "OPENCODE_CONFIG_DIR",
      "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_AUTOUPDATE", "PATH",
    ] as const
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    process.env.BOOM_HOME = boomHome
    process.env.BOOM_SCRIPTED_API_KEY = "scripted-test-key"
    let handle: Awaited<ReturnType<typeof startRuntime>> | undefined
    try {
      handle = await startRuntime()
      const run = async (
        prompt: string,
        turns: Parameters<ScriptedProvider["enqueue"]>,
        agent = "boom",
      ) => {
        const requestStart = provider.requests.length
        provider.enqueue(...turns)
        const trace = await captureRuntimeTrace({
          runtime: handle!.agent,
          directory: workspace,
          title: `M1 ${prompt.slice(0, 24)}`,
          agent,
          model: "scripted/conformance",
          prompt,
        })
        return { trace, requests: provider.requests.slice(requestStart) }
      }

      // C02 + C06: two calls in one step, including an escape attempt, then a second model step.
      const files = await run("C02 C06", [
        {
          type: "completion",
          tools: [
            {
              id: "read-ok",
              name: "read",
              arguments: JSON.stringify({ filePath: "NOTES.md" }),
            },
            {
              id: "read-escape",
              name: "read",
              arguments: JSON.stringify({ filePath: "../outside.txt" }),
            },
          ],
        },
        { type: "completion", text: "file checks complete", usage: { input: 20, output: 3 } },
      ])
      expect(files.requests).toHaveLength(2)
      // Legal workspace reads use the native tool; an escape remains denied by the runtime boundary.
      expect(files.trace).toContainEqual(expect.objectContaining({
        kind: "tool", tool: "read", call: "call-1", state: "completed",
      }))
      expect(files.trace).toContainEqual(expect.objectContaining({
        kind: "tool", tool: "read", call: "call-2", state: "error",
      }))
      expect(JSON.stringify(files.requests[1]?.body?.messages)).toContain("tool")

      // C03: permitted work edit and denied challenge edit are observable in one trace.
      const edits = await run("C03", [
        {
          type: "completion",
          tools: [
            {
              id: "edit-work",
              name: "edit",
              arguments: JSON.stringify({
                filePath: path.join(canonicalWorkspace, "work", "edit.txt"),
                oldString: "before",
                newString: "after",
              }),
            },
            {
              id: "edit-challenge",
              name: "edit",
              arguments: JSON.stringify({
                filePath: path.join(canonicalWorkspace, "input", "challenge.json"),
                oldString: "fixture",
                newString: "changed",
              }),
            },
          ],
        },
        { type: "completion", text: "edit checks complete" },
      ])
      expect(await readFile(path.join(workspace, "work", "edit.txt"), "utf8")).toBe("after\n")
      expect(await readFile(path.join(workspace, "input", "challenge.json"), "utf8")).toContain("fixture")
      expect(edits.trace).toContainEqual(expect.objectContaining({
        kind: "tool", tool: "edit", call: "call-1", state: "completed",
      }))
      expect(edits.trace).toContainEqual(expect.objectContaining({
        kind: "tool", tool: "edit", call: "call-2", state: "error",
      }))

      // C04: controlled execution truncates visible output and leaves a durable audit record.
      const execution = await run("C04", [
        {
          type: "completion",
          tools: [{
            id: "exec-truncated",
            name: "boom-exec",
            arguments: JSON.stringify({
              program: "python",
              args: ["-c", "import time; time.sleep(0.05); print('x' * 40000)"],
            }),
          }],
        },
        { type: "completion", text: "execution complete" },
      ])
      expect(execution.trace).toContainEqual(expect.objectContaining({
        kind: "tool", tool: "boom-exec", state: "completed",
      }))
      const commandEvents = await readFile(
        path.join(workspace, "work", ".boom", "command-events.jsonl"),
        "utf8",
      )
      expect(commandEvents).toContain('"truncated":true')
      expect(commandEvents).toContain('"timedOut":false')
      expect(commandEvents).toContain('"requestedMaxOutputBytes":32768')
      expect(commandEvents).toContain('"environmentFingerprint":"m1-scripted-environment"')

      // C05: plugin path preserves the same durable note semantics exposed by the native host.
      const notes = await run("C05", [
        {
          type: "completion",
          tools: [{
            id: "note-one",
            name: "ctf-note",
            arguments: '{"kind":"note","text":"M1 conformance evidence in work/edit.txt"}',
          }],
        },
        { type: "completion", text: "note complete" },
      ])
      expect(notes.trace).toContainEqual(expect.objectContaining({
        kind: "tool", tool: "ctf-note", state: "completed",
      }))
      expect(await readFile(path.join(workspace, "NOTES.md"), "utf8")).toContain("M1 conformance evidence")

      // C05: candidate output is a structured, session-scoped durable tool result, not reply text.
      const submitted = await run("C05 submit", [
        {
          type: "completion",
          tools: [{
            id: "submit-one",
            name: "ctf-submit",
            arguments: JSON.stringify({
              candidate: "flag{m1_structured}",
            }),
          }],
        },
        { type: "completion", text: "submission complete" },
      ])
      expect(submitted.trace).toContainEqual(expect.objectContaining({
        kind: "tool", tool: "ctf-submit", state: "completed",
      }))
      expect(await loadCandidateSubmission(workspace)).toMatchObject({
        status: "ready",
        flag: "flag{m1_structured}",
      })
      expect(await loadCandidateSubmission(workspace)).not.toHaveProperty("verification")

      // C09: adapter exposes Provider retry and normalizes length/empty final responses.
      const retried = await run("C09 retry", [
        { type: "error", status: 429, message: "scripted rate limit", retryAfterMs: 1 },
        { type: "completion", text: "recovered", usage: { input: 7, output: 1 } },
      ], "boom-consultant")
      expect(retried.trace).toContainEqual(expect.objectContaining({
        kind: "retry",
        attempt: 1,
        error: expect.objectContaining({ category: "rate-limit" }),
      }))
      const length = await run("C09 length", [
        { type: "completion", text: "partial", finish: "length", usage: { input: 4, output: 8 } },
      ], "boom-consultant")
      expect(length.trace.at(-1)).toEqual(expect.objectContaining({ kind: "result", finish: "length" }))
      const empty = await run("C09 empty", [
        { type: "completion", usage: { input: 4, output: 0 } },
      ], "boom-consultant")
      expect(empty.trace.at(-1)).toEqual(expect.objectContaining({
        kind: "result",
        finish: "stop",
        parts: expect.not.arrayContaining([expect.objectContaining({ type: "text" })]),
      }))

      // C01 + C13 + C17 + C19: Boom roles receive stable prompt and tool inputs across conversations.
      const stableOne = await run("C01 C13 C17 C19", [
        { type: "completion", text: "stable one" },
      ], "boom-consultant")
      const stableTwo = await run("C01 C13 C17 C19", [
        { type: "completion", text: "stable two" },
      ], "boom-consultant")
      const firstBody = stableOne.requests[0]?.body
      const secondBody = stableTwo.requests[0]?.body
      expect(Array.isArray(firstBody?.tools)).toBe(true)
      expect(Array.isArray(secondBody?.tools)).toBe(true)
      expect(JSON.stringify(firstBody?.tools)).toBe(JSON.stringify(secondBody?.tools))
      const neutralRegistry = await compileBoomAgentRegistry(path.join(import.meta.dir, "..", "resources"))
      const toolDefinitions = Object.fromEntries(
        (Array.isArray(firstBody?.tools) ? firstBody.tools : []).flatMap((item) => {
          if (!item || typeof item !== "object") return []
          const fn = (item as { function?: unknown }).function
          if (!fn || typeof fn !== "object" || typeof (fn as { name?: unknown }).name !== "string") return []
          return [[(fn as { name: string }).name, fn]]
        }),
      ) as Record<string, { parameters?: unknown }>
      expect(Object.keys(toolDefinitions).sort()).toEqual([
        "bash", "boom-exec", "ctf-consult", "ctf-note", "ctf-submit", "edit", "glob", "grep", "list",
        "read", "skill", "task", "todowrite", "webfetch", "write",
      ])
      const neutralCatalog = neutralRegistry.catalog
      // Bridged tools must appear in the provider tool list of the agent under test; pentest-mode
      // tools are boom-implemented but belong to the pentest profile, not the solver's.
      const solverProfileTools = new Set(
        neutralRegistry.agents.find((agent) => agent.resource.id === "boom")!.profile.tools,
      )
      const bridgedBoomTools = Object.entries(neutralCatalog.tools)
        .filter(([name, descriptor]) =>
          descriptor.implementation === "boom" && name !== "websearch" && solverProfileTools.has(name))
        .map(([name]) => name)
      for (const name of bridgedBoomTools)
        expect(toolDefinitions[name]).toBeDefined()
      for (const name of bridgedBoomTools) {
        const publicSchema = neutralCatalog.tools[name]!.schema as {
          required?: string[]
          properties?: Record<string, { enum?: string[]; type?: string; minimum?: number; maximum?: number }>
        }
        const providerSchema = toolDefinitions[name]?.parameters as {
          required?: string[]
          properties?: Record<string, { enum?: string[]; type?: string; minimum?: number; maximum?: number }>
          additionalProperties?: boolean
        }
        expect(Object.keys(providerSchema.properties ?? {})).toEqual(Object.keys(publicSchema.properties ?? {}))
        expect(providerSchema.required ?? []).toEqual(publicSchema.required ?? [])
        expect(providerSchema.additionalProperties).toBe(false)
        for (const [property, schema] of Object.entries(publicSchema.properties ?? {})) {
          if (schema.enum) expect(providerSchema.properties?.[property]?.enum).toEqual(schema.enum)
          if (schema.minimum !== undefined) expect(providerSchema.properties?.[property]?.minimum).toBe(schema.minimum)
          if (schema.maximum !== undefined) expect(providerSchema.properties?.[property]?.maximum).toBe(schema.maximum)
        }
      }
      const submitProperties = neutralCatalog.tools["ctf-submit"]!.schema.properties as {
        candidate: Record<string, unknown>
      }
      expect(toolDefinitions["ctf-submit"]?.parameters).toEqual(expect.objectContaining({
        required: ["candidate"],
        properties: expect.objectContaining({
          candidate: expect.objectContaining(submitProperties.candidate),
        }),
      }))
      expect(toolDefinitions["ctf-note"]?.parameters).toEqual(expect.objectContaining({
        required: expect.arrayContaining(["kind", "text"]),
        properties: expect.objectContaining({
          kind: expect.objectContaining({ enum: ["note", "ruled-out", "checkpoint"] }),
        }),
      }))
      expect(toolDefinitions["boom-exec"]?.parameters).toEqual(expect.objectContaining({
        required: expect.arrayContaining(["program"]),
        properties: expect.objectContaining({
          mode: expect.objectContaining({ enum: ["managed", "isolated", "static-only"] }),
          purpose: expect.objectContaining({ enum: ["analysis", "install"] }),
        }),
      }))
      const systemMessages = (body: Record<string, unknown> | undefined) =>
        (Array.isArray(body?.messages) ? body.messages : []).filter(
          (message) => message && typeof message === "object" && (message as { role?: string }).role === "system",
        )
      expect(systemMessages(firstBody)).toEqual(systemMessages(secondBody))

      // C08: abort is idempotent and reaches an active Provider stream.
      provider.enqueue({
        type: "completion",
        text: Array.from({ length: 100 }, () => "slow"),
        delayMs: 25,
        waitForAbort: true,
      })
      const requestCountBeforeAbortCase = provider.requests.length
      const conversation = await handle.agent.createConversation({ directory: workspace, title: "M1 C08" })
      const active = conversation.prompt({
        agent: "boom-consultant",
        model: "scripted/conformance",
        text: "C08",
      }).catch((error) => error)
      while (provider.requests.length <= requestCountBeforeAbortCase)
        await new Promise((resolve) => setTimeout(resolve, 5))
      await new Promise((resolve) => setTimeout(resolve, 75))
      await conversation.abort()
      await conversation.abort()
      await active
      expect(provider.abortedRequests.length).toBeGreaterThan(0)
    } finally {
      handle?.close()
      provider.stop()
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 90_000)
})

describe("scripted provider", () => {
  test("streams deterministic chunks and injectable failures without outbound access", async () => {
    const provider = new ScriptedProvider([
      { type: "error", status: 429, message: "try later", retryAfterMs: 1 },
      { type: "completion", text: ["a", "b"], finish: "length", usage: { input: 3, output: 2 } },
    ])
    try {
      const failed = await fetch(`${provider.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer must-not-be-recorded" },
        body: JSON.stringify({ model: "conformance", stream: true, messages: [] }),
      })
      expect(failed.status).toBe(429)
      expect(provider.requests[0]?.headers.authorization).toBeUndefined()
      const streamed = await fetch(`${provider.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "conformance", stream: true, messages: [] }),
      })
      const text = await streamed.text()
      expect(text).toContain('"content":"a"')
      expect(text).toContain('"content":"b"')
      expect(text).toContain('"finish_reason":"length"')
      expect(text).toEndWith("data: [DONE]\n\n")
      expect(provider.remaining).toBe(0)
    } finally {
      provider.stop()
    }
  })
})
