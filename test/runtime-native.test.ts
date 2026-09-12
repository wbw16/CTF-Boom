import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type {
  RuntimeConversation,
  RuntimeEvent,
  RuntimeHandle,
  RuntimePrompt,
} from "../src/runtime-contract.ts"
import { NativeMessageLedger } from "../src/runtime/native-storage.ts"
import { DEFAULT_NATIVE_KERNEL_LIMITS } from "../src/runtime/native-runtime.ts"
import { ScriptedNativeProviderDriver } from "../src/runtime/scripted-provider.ts"
import { selectRuntimeBackend, startRuntime } from "../src/runtime.ts"

const temporaryDirectories: string[] = []
const handles: RuntimeHandle[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

async function workspace(prefix = "boom-native-") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  await mkdir(path.join(directory, "input"), { recursive: true })
  await mkdir(path.join(directory, "work", ".boom"), { recursive: true })
  await writeFile(
    path.join(directory, "input", "challenge.json"),
    '{"slug":"native","description":"Native conformance fixture"}\n',
  )
  await writeFile(path.join(directory, "input", "evidence.txt"), "evidence\n")
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n\nroot evidence\n")
  await writeFile(path.join(directory, "work", "edit.txt"), "before\n")
  await writeFile(path.join(directory, "work", ".boom", "environment.json"), `${JSON.stringify({
    profileId: "native-scripted-python",
    displayName: "Native scripted fixture",
    kind: "python",
    interpreter: "/usr/bin/python3",
    pythonVersion: "3",
    architecture: process.arch,
    packages: {},
    installPolicy: "deny",
    fingerprint: "native-scripted-environment",
    source: "task-override",
    executionMode: "managed",
    boundAt: "2026-08-04T00:00:00Z",
  })}\n`)
  return directory
}

async function native(driver: ScriptedNativeProviderDriver, options: {
  limits?: Parameters<typeof startRuntime>[0] extends infer _T ? Partial<typeof DEFAULT_NATIVE_KERNEL_LIMITS> : never
} = {}) {
  const handle = await startRuntime({
    backend: "native",
    native: { provider: driver, ...(options.limits ? { limits: options.limits } : {}) },
  })
  handles.push(handle)
  return handle
}

async function runPrompt(conversation: RuntimeConversation, input: RuntimePrompt) {
  const subscription = new AbortController()
  const stream = await conversation.events(subscription.signal)
  const events: RuntimeEvent[] = []
  let resolveTerminal: (() => void) | undefined
  const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })
  const watching = (async () => {
    for await (const event of stream) {
      events.push(event)
      if (event.type === "finish") {
        resolveTerminal?.()
        break
      }
    }
  })()
  const result = await conversation.prompt(input)
  await terminal
  subscription.abort()
  await watching
  return { result, events }
}

function usage(input: number, output = 1) {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const handle of handles.splice(0)) handle.close()
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe("Boom Native Agent Kernel", () => {
  test("runs a multi-tool, multi-step turn from neutral prompts and persists provenance", async () => {
    const driver = new ScriptedNativeProviderDriver([
      {
        type: "completion",
        reasoning: ["inspect ", "evidence"],
        tools: [
          { id: "read-notes", name: "read", arguments: ['{"filePath":', '"NOTES.md"}'] },
          { id: "list-challenge", name: "list", arguments: '{"path":"input"}' },
        ],
        usage: usage(10, 2),
        cost: 0.1,
        requestID: "script-request-1",
      },
      {
        type: "completion",
        text: ["native ", "complete"],
        usage: usage(5, 2),
        cost: 0.2,
        requestID: "script-request-2",
      },
      { type: "completion", text: "verified", usage: usage(2) },
    ])
    const directory = await workspace()
    const handle = await native(driver)
    expect(handle.backend).toBe("native")
    expect(handle.capabilities.attachments).toBe(false)
    const conversation = await handle.agent.createConversation({ directory, title: "C01 C06 C07" })
    const { result, events } = await runPrompt(conversation, {
      agent: "boom",
      model: "scripted/conformance",
      text: "Inspect the fixture.",
    })

    expect(result.finish).toBe("stop")
    expect(result.error).toBeUndefined()
    expect(result.usage).toEqual(usage(15, 4))
    expect(result.cost).toBeCloseTo(0.3)
    expect(events).toContainEqual({
      type: "reasoning-delta",
      sessionID: conversation.id,
      delta: "inspect ",
    })
    expect(events.filter((event) => event.type === "tool-state" && event.state.status === "completed"))
      .toHaveLength(2)
    expect(events.filter((event) => event.type === "finish")).toHaveLength(1)
    expect(driver.requests).toHaveLength(2)
    expect(driver.requests[1]?.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "tool", "tool",
    ])
    const definitions = driver.requests[0]?.tools ?? []
    expect(definitions.map((tool) => tool.name)).toContain("task")
    expect(definitions.map((tool) => tool.name)).not.toContain("write")
    expect(definitions.find((tool) => tool.name === "task")?.parameters).toEqual(
      expect.objectContaining({ type: "object", required: ["description", "prompt", "subagent_type"] }),
    )
    expect(driver.requests[0]?.system).toContain("Boom")
    expect(driver.requests[0]?.system).not.toContain("OpenCode")

    const stateRoot = path.join(directory, "work", ".boom", "native", "conversations", conversation.id)
    const manifest = JSON.parse(await readFile(path.join(stateRoot, "manifest.json"), "utf8"))
    expect(manifest).toEqual(expect.objectContaining({
      backend: "native",
      conversationID: conversation.id,
      provider: { id: "scripted", version: "1" },
      promptVersion: handle.promptVersion,
    }))
    expect((await readFile(path.join(stateRoot, "messages.jsonl"), "utf8")).trim().split("\n"))
      .toHaveLength(5)
    const transcript = await conversation.messages!()
    expect(transcript.map((message) => message.role)).toEqual([
      "user", "assistant", "tool", "tool", "assistant",
    ])
    const toolUse = transcript[1]!.parts.filter((part) => part.type === "tool")
    const toolResults = transcript.slice(2, 4).flatMap((message) => message.parts)
    expect(toolUse.map((part) => part.callID)).toEqual(["read-notes", "list-challenge"])
    expect(toolResults.map((part) => part.callID)).toEqual(["read-notes", "list-challenge"])
    expect(toolResults.every((part) => part.state === "completed" && Boolean(part.output))).toBe(true)
    await expect(conversation.fork!({ messageID: transcript[1]!.id }))
      .rejects.toThrow("not a complete API-round boundary")

    const verifier = await handle.agent.createConversation({ directory, title: "C13" })
    await runPrompt(verifier, {
      agent: "boom-consultant",
      model: "scripted/conformance",
      text: "Verify only.",
    })
    expect(driver.requests[2]?.tools.map((tool) => tool.name)).toEqual(["read", "list", "glob", "grep"])
  })

  test("continues and resumes one durable conversation without losing message order", async () => {
    const driver = new ScriptedNativeProviderDriver([
      { type: "completion", text: "first", usage: usage(1) },
      { type: "completion", text: "second", usage: usage(2) },
      { type: "completion", text: "resumed", usage: usage(3) },
      { type: "completion", text: "forked", usage: usage(4) },
    ])
    const directory = await workspace("boom-native-resume-")
    const handle = await native(driver)
    const conversation = await handle.agent.createConversation({ directory, title: "C12" })
    await runPrompt(conversation, { agent: "boom", model: "scripted/model", text: "turn one" })
    await runPrompt(conversation, { agent: "boom", model: "scripted/model", text: "turn two" })
    expect(driver.requests[1]?.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "user",
    ])
    const beforeRestart = await conversation.messages!()
    expect(await conversation.activeContext!()).toEqual(beforeRestart)
    await conversation.close?.()
    handle.close()

    const restarted = await native(driver)
    const resumed = await restarted.agent.resumeConversation!({ directory, id: conversation.id })
    expect(await resumed.messages!()).toEqual(beforeRestart)
    expect(await resumed.activeContext!()).toEqual(beforeRestart)
    const third = await runPrompt(resumed, { agent: "boom", model: "scripted/model", text: "turn three" })
    expect(third.result.parts).toContainEqual({ type: "text", text: "resumed" })
    expect(driver.requests[2]?.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant", "user",
    ])
    const ledger = await readFile(
      path.join(directory, "work", ".boom", "native", "conversations", conversation.id, "messages.jsonl"),
      "utf8",
    )
    expect(ledger.trim().split("\n")).toHaveLength(6)

    const secondBoundary = beforeRestart.findLast((message) => message.role === "assistant")!
    const forked = await resumed.fork!({ messageID: secondBoundary.id })
    expect(forked.id).not.toBe(resumed.id)
    expect(await forked.messages!()).toEqual(beforeRestart)
    const forkTurn = await runPrompt(forked, {
      agent: "boom",
      model: "scripted/model",
      text: "fork turn",
    })
    expect(forkTurn.result.parts).toContainEqual({ type: "text", text: "forked" })
    expect(driver.requests[3]?.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "user", "assistant", "user",
    ])
    expect(JSON.stringify(driver.requests[3]?.messages)).not.toContain("turn three")
    const forkManifest = JSON.parse(await readFile(path.join(
      directory,
      "work",
      ".boom",
      "native",
      "conversations",
      forked.id,
      "manifest.json",
    ), "utf8"))
    expect(forkManifest.forkedFrom).toEqual({
      conversationID: resumed.id,
      messageID: secondBoundary.id,
    })
  })

  test("routes file, memory, Shell, and network calls through the M3 host and policy", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("native-loopback-evidence", { headers: { "content-type": "text/plain" } }),
    })
    servers.push(server)
    const driver = new ScriptedNativeProviderDriver([
      {
        type: "completion",
        tools: [
          { id: "read-ok", name: "read", arguments: '{"filePath":"NOTES.md"}' },
          { id: "read-escape", name: "read", arguments: '{"filePath":"../outside"}' },
          {
            id: "edit-ok",
            name: "edit",
            arguments: '{"filePath":"work/edit.txt","oldString":"before","newString":"after"}',
          },
          {
            id: "edit-denied",
            name: "edit",
            arguments: '{"filePath":"challenge/evidence.txt","oldString":"evidence","newString":"changed"}',
          },
          { id: "note", name: "ctf-note", arguments: '{"kind":"note","text":"native durable fact"}' },
          { id: "shell", name: "bash", arguments: '{"command":"printf native-shell-ok"}' },
        ],
        usage: usage(3),
      },
      {
        type: "completion",
        tools: [{
          id: "fetch-loopback",
          name: "webfetch",
          arguments: JSON.stringify({ url: `http://127.0.0.1:${server.port}/evidence`, format: "text" }),
        }],
        usage: usage(2),
      },
      { type: "completion", text: "host checks complete", usage: usage(1) },
    ])
    const directory = await workspace("boom-native-host-")
    const handle = await native(driver)
    const conversation = await handle.agent.createConversation({ directory, title: "C02-C05 C20" })
    const turn = await runPrompt(conversation, {
      agent: "boom",
      model: "scripted/model",
      text: "exercise the host",
    })
    expect(turn.result.finish).toBe("stop")
    const toolParts = turn.result.parts.filter((part) => part.type === "tool")
    expect(toolParts.find((part) => part.callID === "read-ok")?.state?.status).toBe("completed")
    expect(toolParts.find((part) => part.callID === "read-escape")?.state?.status).toBe("error")
    expect(toolParts.find((part) => part.callID === "edit-ok")?.state?.status).toBe("completed")
    expect(toolParts.find((part) => part.callID === "edit-denied")?.state?.status).toBe("error")
    expect(toolParts.find((part) => part.callID === "shell")?.state?.status).toBe("completed")
    expect(toolParts.find((part) => part.callID === "fetch-loopback")?.state?.status).toBe("completed")
    expect(await readFile(path.join(directory, "work", "edit.txt"), "utf8")).toBe("after\n")
    expect(await readFile(path.join(directory, "input", "evidence.txt"), "utf8")).toBe("evidence\n")
    expect(await readFile(path.join(directory, "NOTES.md"), "utf8")).toContain("native durable fact")
    expect(JSON.stringify(driver.requests[1]?.messages)).toContain("native-shell-ok")
    expect(JSON.stringify(driver.requests[2]?.messages)).toContain("native-loopback-evidence")
  })

  test("retries transient failures, recovers length and malformed tools, and rejects empty replies", async () => {
    const driver = new ScriptedNativeProviderDriver([
      { type: "error", message: "temporary outage", category: "server", statusCode: 503, retryable: true },
      { type: "completion", text: "partial", finish: "length", usage: usage(2) },
      {
        type: "completion",
        tools: [{ id: "bad-note", name: "ctf-note", arguments: '{"kind":"note"' }],
        usage: usage(2),
      },
      { type: "completion", text: "recovered", usage: usage(2) },
      { type: "completion", usage: usage(1) },
    ])
    const directory = await workspace("boom-native-recovery-")
    const handle = await native(driver)
    const conversation = await handle.agent.createConversation({ directory, title: "C09" })
    const recovered = await runPrompt(conversation, {
      agent: "boom",
      model: "scripted/model",
      text: "recover",
    })
    expect(recovered.result.finish).toBe("stop")
    expect(recovered.result.parts).toContainEqual({ type: "text", text: "partial" })
    expect(recovered.result.parts).toContainEqual({ type: "text", text: "recovered" })
    expect(recovered.result.parts).toContainEqual(expect.objectContaining({
      type: "tool",
      tool: "ctf-note",
      state: expect.objectContaining({ status: "error" }),
    }))
    expect(recovered.events).toContainEqual(expect.objectContaining({
      type: "retry",
      attempt: 1,
      error: expect.objectContaining({ category: "server", statusCode: 503 }),
    }))
    expect(await readFile(path.join(directory, "NOTES.md"), "utf8")).not.toContain("## [")
    expect(driver.requests[1]?.step).toBe(driver.requests[0]?.step)
    expect(JSON.stringify(driver.requests[2]?.messages)).toContain("output limit")
    expect(JSON.stringify(driver.requests[3]?.messages)).toContain("Malformed tool arguments")

    const emptyConversation = await handle.agent.createConversation({ directory, title: "C09 empty" })
    const empty = await runPrompt(emptyConversation, {
      agent: "boom",
      model: "scripted/model",
      text: "empty",
    })
    expect(empty.result.finish).toBe("error")
    expect(empty.result.error).toEqual(expect.objectContaining({ category: "malformed-response" }))
  })

  test("cancels generation idempotently with one terminal finish", async () => {
    const driver = new ScriptedNativeProviderDriver([{
      type: "completion",
      text: "started",
      waitForAbort: true,
    }])
    const directory = await workspace("boom-native-cancel-")
    const handle = await native(driver)
    const conversation = await handle.agent.createConversation({ directory, title: "C08" })
    const subscription = new AbortController()
    const stream = await conversation.events(subscription.signal)
    const events: RuntimeEvent[] = []
    let started: (() => void) | undefined
    const sawText = new Promise<void>((resolve) => { started = resolve })
    const watching = (async () => {
      for await (const event of stream) {
        events.push(event)
        if (event.type === "text-delta") started?.()
        if (event.type === "finish") break
      }
    })()
    const pending = conversation.prompt({ agent: "boom", model: "scripted/model", text: "wait" })
    await sawText
    await Promise.all([conversation.abort(), conversation.abort()])
    const result = await pending
    subscription.abort()
    await watching
    expect(result.finish).toBe("cancelled")
    expect(result.error?.category).toBe("cancelled")
    expect(events.filter((event) => event.type === "cancelled")).toHaveLength(1)
    expect(events.filter((event) => event.type === "finish")).toHaveLength(1)
    expect(driver.abortedRequests).toEqual([0])

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(handle.agent.createConversation({
      directory,
      title: "pre-cancelled",
      signal: cancelled.signal,
    })).rejects.toThrow()
  })

  test("runs task calls with default total concurrency four and isolated durable workspaces", async () => {
    const calls = Array.from({ length: 5 }, (_, index) => ({
      id: `worker-${index + 1}`,
      name: "task",
      arguments: JSON.stringify({
        description: `worker ${index + 1}`,
        prompt: `inspect branch ${index + 1}`,
        subagent_type: "boom-worker",
      }),
    }))
    const driver = new ScriptedNativeProviderDriver([
      { type: "completion", tools: calls, usage: usage(1) },
      ...Array.from({ length: 5 }, (_, index) => ({
        type: "completion" as const,
        text: `worker report ${index + 1}`,
        usage: usage(1),
        delayMs: 20,
      })),
      { type: "completion", text: "parent received all reports", usage: usage(1) },
    ])
    const directory = await workspace("boom-native-tasks-")
    const handle = await native(driver)
    const conversation = await handle.agent.createConversation({ directory, title: "C16 C21" })
    const turn = await runPrompt(conversation, {
      agent: "boom",
      model: "scripted/model",
      text: "delegate five branches",
    })
    expect(turn.result.finish).toBe("stop")
    expect(turn.result.usage).toEqual(usage(7, 7))
    expect(driver.maxActive).toBe(4)
    expect(driver.requests.filter((request) => request.agent === "boom-worker")).toHaveLength(5)
    expect(driver.requests.at(-1)?.messages.filter((message) => message.role === "tool")).toHaveLength(5)
    expect(JSON.stringify(driver.requests.at(-1)?.messages)).toContain("worker report")

    const stateRoot = path.join(directory, "work", ".boom", "native", "conversations", conversation.id)
    const audit = (await readFile(path.join(stateRoot, "task-tree.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line))
    expect(audit.filter((entry) => entry.state === "queued")).toHaveLength(5)
    expect(audit.filter((entry) => entry.state === "running")).toHaveLength(5)
    expect(audit.filter((entry) => entry.state === "completed")).toHaveLength(5)
    const directories = new Set(audit.filter((entry) => entry.state === "queued").map((entry) => entry.directory))
    expect(directories.size).toBe(5)
    for (const relative of directories) {
      expect(await readFile(path.join(directory, relative as string, "input", "evidence.txt"), "utf8"))
        .toBe("evidence\n")
      const nativeRoot = path.join(directory, relative as string, "work", ".boom", "native", "conversations")
      expect((await Array.fromAsync(new Bun.Glob("*/messages.jsonl").scan({ cwd: nativeRoot })))).toHaveLength(1)
    }
  })

  test("keeps sibling tasks alive after one partial failure and redacts durable Native state", async () => {
    const taskCall = (id: string, title: string) => ({
      id,
      name: "task",
      arguments: JSON.stringify({ description: title, prompt: title, subagent_type: "boom-worker" }),
    })
    const driver = new ScriptedNativeProviderDriver([
      {
        type: "completion",
        tools: [taskCall("fails", "failing worker"), taskCall("succeeds", "successful worker")],
        usage: usage(1),
      },
      { type: "completion", usage: usage(1) },
      { type: "completion", text: "sibling evidence", usage: usage(1), delayMs: 5 },
      {
        type: "completion",
        tools: [{
          id: "redacted-call",
          name: "read",
          arguments: '{"filePath":"NOTES.md","token":"super-secret-native-value"}',
        }],
        usage: usage(1),
      },
      { type: "completion", text: "parent recovered", usage: usage(1) },
    ])
    const directory = await workspace("boom-native-partial-")
    const handle = await native(driver)
    const conversation = await handle.agent.createConversation({ directory, title: "C16 C18" })
    const turn = await runPrompt(conversation, {
      agent: "boom",
      model: "scripted/model",
      text: "partial failure",
    })
    expect(turn.result.finish).toBe("stop")
    expect(turn.result.parts).toContainEqual({ type: "text", text: "parent recovered" })
    const stateRoot = path.join(directory, "work", ".boom", "native", "conversations", conversation.id)
    const audit = await readFile(path.join(stateRoot, "task-tree.jsonl"), "utf8")
    expect(audit).toContain('"state":"failed"')
    expect(audit).toContain('"state":"completed"')
    const durable = [
      await readFile(path.join(stateRoot, "events.jsonl"), "utf8"),
      await readFile(path.join(stateRoot, "messages.jsonl"), "utf8"),
    ].join("\n")
    expect(durable).not.toContain("super-secret-native-value")
    expect(durable).toContain("[redacted]")
  })

  test("enforces recursive depth two and returns nested results to the matching parents", async () => {
    const task = (id: string, description: string) => ({
      id,
      name: "task",
      arguments: JSON.stringify({ description, prompt: description, subagent_type: "boom-worker" }),
    })
    const driver = new ScriptedNativeProviderDriver([
      { type: "completion", tools: [task("root-child", "depth one")], usage: usage(1) },
      { type: "completion", tools: [task("child-grandchild", "depth two")], usage: usage(1) },
      { type: "completion", tools: [task("too-deep", "depth three denied")], usage: usage(1) },
      { type: "completion", text: "depth two recovered", usage: usage(1) },
      { type: "completion", text: "depth one received nested report", usage: usage(1) },
      { type: "completion", text: "root received nested report", usage: usage(1) },
    ])
    const directory = await workspace("boom-native-depth-")
    const handle = await native(driver, { limits: { maxTaskDepth: 2 } })
    const conversation = await handle.agent.createConversation({ directory, title: "C21 depth" })
    const result = await runPrompt(conversation, {
      agent: "boom",
      model: "scripted/model",
      text: "nested delegation",
    })
    expect(result.result.finish).toBe("stop")
    expect(result.result.parts).toContainEqual({ type: "text", text: "root received nested report" })
    expect(JSON.stringify(driver.requests[3]?.messages)).toContain("task depth limit reached")
    expect(JSON.stringify(driver.requests[4]?.messages)).toContain("depth two recovered")
    expect(JSON.stringify(driver.requests[5]?.messages)).toContain("depth one received nested report")
    const audit = (await readFile(
      path.join(directory, "work", ".boom", "native", "conversations", conversation.id, "task-tree.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line))
    expect(audit.filter((entry) => entry.state === "completed").map((entry) => entry.depth).sort())
      .toEqual([1, 2])
    const nested = audit.find((entry) => entry.depth === 2 && entry.state === "queued")
    expect(nested.parentTaskID).toBeString()
  })

  test("cumulative task-tree budget and parent cancellation terminate descendants", async () => {
    const taskCalls = [1, 2].map((index) => ({
      id: `cancel-child-${index}`,
      name: "task",
      arguments: JSON.stringify({
        description: `cancel child ${index}`,
        prompt: "wait",
        subagent_type: "boom-worker",
      }),
    }))
    const cancelDriver = new ScriptedNativeProviderDriver([
      { type: "completion", tools: taskCalls, usage: usage(1) },
      { type: "completion", waitForAbort: true },
      { type: "completion", waitForAbort: true },
    ])
    const cancelDirectory = await workspace("boom-native-tree-cancel-")
    const cancelHandle = await native(cancelDriver)
    const cancelling = await cancelHandle.agent.createConversation({
      directory: cancelDirectory,
      title: "C21 cancellation",
    })
    const pending = cancelling.prompt({ agent: "boom", model: "scripted/model", text: "delegate" })
    const deadline = Date.now() + 5_000
    while (cancelDriver.active < 2 && Date.now() < deadline) await Bun.sleep(2)
    expect(cancelDriver.active).toBe(2)
    await cancelling.abort()
    const cancelled = await pending
    expect(cancelled.finish).toBe("cancelled")
    const cancelAudit = (await readFile(
      path.join(cancelDirectory, "work", ".boom", "native", "conversations", cancelling.id, "task-tree.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line))
    expect(cancelAudit.filter((entry) => entry.state === "cancelled")).toHaveLength(2)
    expect(cancelDriver.abortedRequests).toHaveLength(2)

    const budgetDriver = new ScriptedNativeProviderDriver([
      {
        type: "completion",
        tools: [{
          id: "budget-child",
          name: "task",
          arguments: JSON.stringify({
            description: "budget child",
            prompt: "spend",
            subagent_type: "boom-worker",
          }),
        }],
        usage: usage(1),
      },
      { type: "completion", text: "expensive child", usage: usage(6) },
    ])
    const budgetDirectory = await workspace("boom-native-tree-budget-")
    const budgetHandle = await native(budgetDriver)
    const budget = await budgetHandle.agent.createConversation({
      directory: budgetDirectory,
      title: "C21 budget",
      tokenBudget: 5,
    })
    const exceeded = await runPrompt(budget, {
      agent: "boom",
      model: "scripted/model",
      text: "enforce budget",
    })
    expect(exceeded.result.finish).toBe("error")
    expect(exceeded.result.error).toEqual(expect.objectContaining({
      category: "invalid-request",
      message: expect.stringContaining("token budget exceeded"),
    }))
    const budgetState = JSON.parse(await readFile(
      path.join(budgetDirectory, "work", ".boom", "native", "conversations", budget.id, "budget.json"),
      "utf8",
    ))
    expect(budgetState.limit).toBe(5)
    expect(budgetState.usage.input).toBe(7)
    const budgetAudit = await readFile(
      path.join(budgetDirectory, "work", ".boom", "native", "conversations", budget.id, "task-tree.jsonl"),
      "utf8",
    )
    expect(budgetAudit).toContain('"state":"failed"')
  })

  test("keeps the internal selector explicit while product default remains compatibility", () => {
    expect(selectRuntimeBackend(undefined)).toBe("opencode")
    expect(selectRuntimeBackend("native")).toBe("native")
    expect(() => selectRuntimeBackend("other")).toThrow("Unknown Boom Runtime backend")
    expect(DEFAULT_NATIVE_KERNEL_LIMITS.maxConcurrency).toBe(4)
    expect(DEFAULT_NATIVE_KERNEL_LIMITS.maxTaskDepth).toBe(2)
  })
})

describe("M15 native message ledger resilience", () => {
  function ledgerLine(id: string) {
    return JSON.stringify({
      version: 1,
      id,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: `payload-${id}` },
    })
  }

  test("skips a torn trailing line so the ledger stays recoverable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-ledger-tail-"))
    temporaryDirectories.push(directory)
    await writeFile(
      path.join(directory, "messages.jsonl"),
      `${ledgerLine("message-1")}\n${ledgerLine("message-2")}\n${ledgerLine("message-3").slice(0, 40)}`,
    )
    const warn = spyOn(console, "warn")
    try {
      const ledger = await NativeMessageLedger.open(directory)

      expect(ledger.length).toBe(2)
      expect(ledger.entries().map((entry) => entry.id)).toEqual(["message-1", "message-2"])
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/offset \d+/))
    } finally {
      warn.mockRestore()
    }
  })

  test("still rejects corruption before the tail", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-ledger-middle-"))
    temporaryDirectories.push(directory)
    await writeFile(
      path.join(directory, "messages.jsonl"),
      // The damaged line is followed by more records and is newline-terminated: real corruption.
      `${ledgerLine("message-1")}\n{"version":1,"id":"broken"\n${ledgerLine("message-3")}\n`,
    )

    await expect(NativeMessageLedger.open(directory))
      .rejects.toThrow("Invalid Boom Native message ledger JSON at line 2")
  })

  test("keeps structural corruption fatal even when it sits in the final record", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-ledger-final-"))
    temporaryDirectories.push(directory)
    // Terminated by a newline and parseable JSON — not a torn write — so it stays an error.
    await writeFile(
      path.join(directory, "messages.jsonl"),
      `${ledgerLine("message-1")}\n${JSON.stringify({ version: 2 })}\n`,
    )

    await expect(NativeMessageLedger.open(directory))
      .rejects.toThrow("Invalid Boom Native message ledger entry at line 2")
  })
})
