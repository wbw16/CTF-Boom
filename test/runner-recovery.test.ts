import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { submitCandidate } from "../src/candidate-submission.ts"
import { GuiRunner, recoverableRunOutcome } from "../src/runner.ts"
import type { RuntimeHandle } from "../src/runtime-contract.ts"

const temporary: string[] = []

afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

describe("host-level run recovery", () => {
  test("retries provider silence, ambiguous finishes, and guard-terminated loops", () => {
    expect(recoverableRunOutcome({ stop: "silent" })).toBe(true)
    expect(recoverableRunOutcome({ stop: "error", finish: "unknown" })).toBe(true)
    expect(recoverableRunOutcome({ stop: "error", finish: "content-filter" })).toBe(true)
    expect(recoverableRunOutcome({ stop: "error", finish: "cancelled" })).toBe(true)
    expect(recoverableRunOutcome({
      stop: "error",
      detail: "prompt failed (input-context-overflow): context length exceeded",
    })).toBe(true)
    expect(recoverableRunOutcome({
      stop: "error",
      detail: "provider stream dropped unexpectedly",
    })).toBe(true)
    expect(recoverableRunOutcome({
      stop: "stalled",
      detail: "repeated the same webfetch call 5x",
    })).toBe(true)
  })

  test("does not retry permanent configuration failures or unmet prerequisites", () => {
    expect(recoverableRunOutcome({
      stop: "error",
      detail: "Invalid API Key",
    })).toBe(false)
    expect(recoverableRunOutcome({
      stop: "blocked",
      detail: "challenge requires an external service",
    })).toBe(false)
  })

  test("feeds the stalled turn's context snapshot into the recovery prompt", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-recovery-snapshot-"))
    temporary.push(root)
    const source = path.join(root, "challenges", "snapshot-task")
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, "README.md"), "reverse the binary")

    let conversations = 0
    let resolveFirstPrompt: ((value: never) => void) | undefined
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
      },
      agent: {
        async createConversation() {
          const index = conversations += 1
          const id = `recovery-snapshot-${index}`
          return {
            id,
            async events() {
              if (index !== 1)
                return { async *[Symbol.asyncIterator]() {} }
              return {
                async *[Symbol.asyncIterator]() {
                  yield {
                    type: "step-finish",
                    sessionID: id,
                    usage: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                    cost: 0,
                    reason: "tool-calls",
                  }
                  await new Promise(() => {})
                },
              }
            },
            async prompt(request) {
              prompts.push(request.text)
              if (index !== 1)
                return {
                  usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
                  cost: 0,
                  finish: "stop" as const,
                  parts: [{ type: "text" as const, text: "analysis continued from the snapshot" }],
                }
              return new Promise<never>((resolve) => { resolveFirstPrompt = resolve })
            },
            async abort() {
              resolveFirstPrompt?.({
                usage: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
                finish: "stop" as const,
                parts: [],
              } as never)
            },
            async activeContext() {
              if (index !== 1) return []
              return [{
                id: "msg-1",
                role: "assistant",
                parts: [{ type: "text", text: "关键结论：校验逻辑在 sub_A780" }],
              }]
            },
          }
        },
      },
      close() {},
    }
    const runner = new GuiRunner(root, async () => handle)
    runner.setConcurrency(8)
    try {
      await runner.enqueue({
        challenges: [{
          slug: "snapshot-task",
          directory: source,
          description: "reverse the binary",
          files: [],
          flagFormat: "flag\\{[^}]+\\}",
        }],
        model: "test/solver",
        limits: { tokens: 10_000, repeats: 3, timeout: 30_000, silenceMs: 60 },
        flagFormat: "flag\\{[^}]+\\}",
        pythonInterpreter: interpreter,
      })
      for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1)
        await Bun.sleep(10)

      expect(conversations).toBeGreaterThanOrEqual(2)
      expect(prompts.length).toBeGreaterThanOrEqual(2)
      expect(prompts[1]).toContain("活动上下文快照")
      expect(prompts[1]).toContain("关键结论：校验逻辑在 sub_A780")
    } finally {
      await runner.close()
    }
  })

  test("runs local analysis when a service-dependent challenge has no endpoint", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-blocked-service-"))
    temporary.push(root)
    const source = path.join(root, "challenges", "service-only")
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, "README.md"), "requires a live target")
    let conversations = 0
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
      },
      agent: {
        async createConversation(input) {
          conversations += 1
          const id = `local-first-${conversations}`
          return {
            id,
            async events() {
              return { async *[Symbol.asyncIterator]() {} }
            },
            async prompt(request) {
              prompts.push(request.text)
              await submitCandidate({
                directory: input.directory,
                sessionID: id,
                candidate: "flag{local-first}",
              })
              return {
                usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
                finish: "stop" as const,
                parts: [{ type: "text" as const, text: "completed local analysis" }],
              }
            },
            async abort() {},
          }
        },
      },
      close() {},
    }
    const runner = new GuiRunner(root, async () => handle)
    runner.setConcurrency(8)
    try {
      await runner.enqueue({
        challenges: [{
          slug: "service-only",
          directory: source,
          description: "requires a live target",
          files: [],
          flagFormat: "flag\\{[^}]+\\}",
          serviceRequired: true,
        }],
        model: "test/solver",
        limits: { tokens: 10_000, repeats: 3, timeout: 30_000 },
        flagFormat: "flag\\{[^}]+\\}",
        pythonInterpreter: interpreter,
      })
      for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1)
        await Bun.sleep(10)

      expect(conversations).toBe(1)
      expect(prompts[0]).toContain("先完成附件、源码、静态分析")
      expect(prompts[0]).toContain("不要因为缺少地址而等待")
      expect(runner.getRuntimeState().concurrency).toBe(8)
      const [runID] = await readdir(path.join(root, "runs", "service-only"))
      const result = JSON.parse(await readFile(
        path.join(root, "runs", "service-only", runID!, "result.json"),
        "utf8",
      ))
      expect(result).toMatchObject({
        candidates: ["flag{local-first}"],
        candidate_source: "submission",
      })
    } finally {
      await runner.close()
    }
  })

  test("blocks a service continuation until its endpoint is supplied", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-remote-continuation-"))
    temporary.push(root)
    const source = path.join(root, "challenges", "service-task")
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, "README.md"), "continue against a live target")

    let conversations = 0
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
        async createConversation() {
          conversations += 1
          return {
            id: `remote-${conversations}`,
            async events() {
              return { async *[Symbol.asyncIterator]() {} }
            },
            async prompt() {
              return {
                usage: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
                finish: "stop" as const,
                parts: [{ type: "text" as const, text: "local analysis complete" }],
              }
            },
            async abort() {},
          }
        },
      },
      close() {},
    }
    const runner = new GuiRunner(root, async () => handle)
    const challenge = {
      slug: "service-task",
      directory: source,
      description: "continue against a live target",
      files: [],
      flagFormat: "",
      serviceRequired: true,
    }
    const limits = { tokens: 10_000, repeats: 3, timeout: 30_000 }
    const waitForIdle = async () => {
      for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1)
        await Bun.sleep(10)
    }
    try {
      await runner.enqueue({
        challenges: [challenge],
        model: "test/solver",
        limits,
        flagFormat: "",
        pythonInterpreter: interpreter,
      })
      await waitForIdle()
      const [runID] = await readdir(path.join(root, "runs", challenge.slug))
      const runDirectory = path.join(root, "runs", challenge.slug, runID!)
      expect(JSON.parse(await readFile(path.join(runDirectory, "result.json"), "utf8"))).toMatchObject({
        stop: "blocked",
        detail: expect.stringContaining("missing remote URL"),
      })
      expect(conversations).toBe(1)

      await runner.enqueue({
        challenges: [challenge],
        model: "test/solver",
        limits,
        flagFormat: "",
        workspaces: { [challenge.slug]: runID! },
        pythonInterpreter: interpreter,
      })
      await waitForIdle()
      expect(conversations).toBe(1)
      expect(JSON.parse(await readFile(path.join(runDirectory, "result.json"), "utf8"))).toMatchObject({
        stop: "blocked",
        detail: expect.stringContaining("本轮不会启动解题模型"),
      })

      await runner.enqueue({
        challenges: [{ ...challenge, remote: "https://target.example/task-1" }],
        model: "test/solver",
        limits,
        flagFormat: "",
        workspaces: { [challenge.slug]: runID! },
        pythonInterpreter: interpreter,
      })
      await waitForIdle()
      expect(conversations).toBeGreaterThanOrEqual(2)
      expect(JSON.parse(await readFile(path.join(runDirectory, "result.json"), "utf8"))).toMatchObject({
        stop: "completed",
      })
    } finally {
      await runner.close()
    }
  })
})
