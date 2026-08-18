import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { submitCandidate } from "../src/candidate-submission.ts"
import { GuiRunner } from "../src/runner.ts"
import type {
  AgentRuntime,
  RuntimeConversation,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeLauncherOptions,
  RuntimeProviderCatalog,
} from "../src/runtime-contract.ts"

const temporary: string[] = []
afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

const usage = { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }

async function hotSwitchFixture() {
  const interpreter = Bun.which("python3")
  if (!interpreter) throw new Error("python3 is required for this test")
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-hot-switch-"))
  temporary.push(root)
  const source = path.join(root, "challenges", "sample")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "continue across a model switch")

  let releaseTool: (() => void) | undefined
  const toolMayFinish = new Promise<void>((resolve) => { releaseTool = resolve })
  let promptCount = 0
  let oldPromptResolve: (() => void) | undefined
  let oldAborts = 0
  const prompts: Array<{ model: string; text: string }> = []
  const consultationPrompts: Array<{ model: string; title: string; text: string }> = []
  const resumed: string[] = []
  const closed: number[] = []
  const launchModels: Array<{ economy: string; strong: string } | undefined> = []
  const launchVisionModels: Array<string | undefined> = []
  let generation = 0

  const catalog = (): RuntimeProviderCatalog => ({
    connected: ["openai"],
    all: [{
      id: "openai",
      name: "OpenAI",
      models: {
        old: {
          id: "old",
          name: "Old",
          limit: { context: 300_000, output: 16_384 },
          reasoning: true,
          attachment: true,
        },
        next: {
          id: "next",
          name: "Next",
          limit: { context: 300_000, output: 16_384 },
          reasoning: true,
          attachment: false,
        },
      },
    }],
  })

  const conversation = (directory: string, id: string): RuntimeConversation => ({
    id,
    async events() {
      const turn = promptCount
      return {
        async *[Symbol.asyncIterator]() {
          if (turn !== 0) return
          yield {
            type: "tool-state",
            sessionID: id,
            callID: "tool-1",
            tool: "bash",
            state: { status: "running", input: { command: "extract" } },
          } as RuntimeEvent
          await toolMayFinish
          yield {
            type: "tool-state",
            sessionID: id,
            callID: "tool-1",
            tool: "bash",
            state: { status: "completed", title: "artifact extracted" },
          } as RuntimeEvent
        },
      }
    },
    async prompt(request) {
      const turn = promptCount++
      prompts.push({ model: request.model, text: request.text })
      if (turn === 0) {
        await new Promise<void>((resolve) => { oldPromptResolve = resolve })
        return { usage, cost: 0, finish: "cancelled", parts: [{ type: "text", text: "old partial" }] }
      }
      await submitCandidate({
        directory,
        sessionID: id,
        candidate: "flag{switched}",
      })
      return { usage, cost: 0, finish: "stop", parts: [{ type: "text", text: "continued" }] }
    },
    async abort() {
      oldAborts += 1
      oldPromptResolve?.()
    },
    async activeContext() {
      return [{
        id: "tool-result-1",
        role: "tool",
        parts: [{
          type: "tool",
          tool: "bash",
          callID: "tool-1",
          state: "completed",
          input: '{"command":"extract"}',
          output: "artifact path: work/result.bin",
        }],
      }]
    },
  })

  const consultationConversation = (title: string): RuntimeConversation => ({
    id: `consult-${crypto.randomUUID()}`,
    async events() {
      return { async *[Symbol.asyncIterator]() {} }
    },
    async prompt(request) {
      consultationPrompts.push({ model: request.model, title, text: request.text })
      return {
        usage,
        cost: 0,
        finish: "stop",
        parts: [{
          type: "text",
          text: title === "Boom consult synthesis"
            ? "merged diagnosis from the live context"
            : `independent diagnosis from ${request.model}`,
        }],
      }
    },
    async abort() {},
  })

  const launcher = async (options?: RuntimeLauncherOptions): Promise<RuntimeHandle> => {
    launchModels.push(options?.models)
    launchVisionModels.push(options?.visionModel)
    const current = ++generation
    const agent: AgentRuntime = {
      async createConversation(input) {
        if (input.title.startsWith("Boom consult"))
          return consultationConversation(input.title)
        return conversation(input.directory, "session-hot")
      },
      async resumeConversation(input) {
        resumed.push(input.id)
        return conversation(input.directory, input.id)
      },
    }
    return {
      backend: `fake-${current}`,
      version: "test",
      capabilities: {
        eventStreaming: true,
        toolCalls: true,
        reasoning: true,
        attachments: true,
        web: true,
        cancellation: true,
        providerManagement: true,
        providerOAuth: true,
        compaction: false,
      },
      agent,
      provider: {
        async listProviders() { return catalog() },
        async discoverModels() { return Object.values(catalog().all[0]!.models) },
        async listProviderAuth() { return { openai: [{ type: "api", label: "API Key" }] } },
        async setProviderCredential() {},
        async authorizeProviderOAuth() { return { url: "https://example.test/oauth" } },
        async completeProviderOAuth() {},
        async removeProviderCredential() {},
      },
      close() { closed.push(current) },
    }
  }

  const runner = new GuiRunner(root, launcher)
  await runner.enqueue({
    challenges: [{
      slug: "sample",
      directory: source,
      description: "continue across a model switch",
      files: [],
      flagFormat: "flag\\{[^}]+\\}",
    }],
    model: "openai/old",
    modelPolicy: { economy: "openai/old", strong: "openai/old" },
    limits: { tokens: 100_000, repeats: 5, timeout: 60_000 },
    flagFormat: "flag\\{[^}]+\\}",
    pythonInterpreter: interpreter,
  })
  for (let attempt = 0; attempt < 1_000 && promptCount === 0; attempt += 1)
    await Bun.sleep(2)
  expect(promptCount).toBe(1)

  return {
    root,
    runner,
    releaseTool: () => releaseTool?.(),
    prompts,
    consultationPrompts,
    resumed,
    closed,
    launchModels,
    launchVisionModels,
    get oldAborts() { return oldAborts },
    get generation() { return generation },
  }
}

async function waitForIdle(runner: GuiRunner) {
  for (let attempt = 0; attempt < 1_000 && runner.hasWork(); attempt += 1)
    await Bun.sleep(5)
  expect(runner.hasWork()).toBe(false)
}

test("hot-switches an active model only after its running tool completes", async () => {
  const fixture = await hotSwitchFixture()
  try {
    const result = await fixture.runner.applyLiveModelSettings({
      economyModel: "openai/old",
      strongModel: "openai/next",
      consultModels: [],
      blindReview: false,
      consultOnCompaction: false,
      network: "allow",
    })
    expect(result.active).toBe(1)
    expect(result.warnings).toContain("The new model does not support image attachments; read relevant content via files or command-line tools")
    expect(fixture.oldAborts).toBe(0)

    fixture.releaseTool()
    await waitForIdle(fixture.runner)

    expect(fixture.oldAborts).toBe(1)
    expect(fixture.prompts.map((item) => item.model)).toEqual(["openai/old", "openai/next"])
    expect(fixture.prompts[1]?.text).toContain("Compatibility impact: The new model does not support image attachments")
    expect(fixture.prompts[1]?.text).not.toContain("Compact handoff")
    expect(fixture.resumed).toEqual(["session-hot"])
    const [runID] = await readdir(path.join(fixture.root, "runs", "sample"))
    const task = JSON.parse(await readFile(path.join(fixture.root, "runs", "sample", runID!, "task.json"), "utf8"))
    expect(task.turns).toMatchObject([
      { model: "openai/old", stop: "switched" },
      { model: "openai/next", candidates: ["flag{switched}"] },
    ])
  } finally {
    await fixture.runner.close()
  }
})

test("relaunches the runtime with the tier policy when worker model tiers change", async () => {
  const fixture = await hotSwitchFixture()
  try {
    // The CLI enqueue path adopts the explicit policy before the first runtime launch.
    expect(fixture.launchModels[0]).toEqual({ economy: "openai/old", strong: "openai/old" })

    // Only the economy tier changes; the active job keeps running on "openai/old", but the runtime
    // must relaunch so boom-worker / boom-worker-pro resolve their new tier models.
    const result = await fixture.runner.applyLiveModelSettings({
      economyModel: "openai/next",
      strongModel: "openai/old",
      consultModels: [],
      blindReview: false,
      consultOnCompaction: false,
      network: "allow",
    })
    expect(result.active).toBe(1)
    expect(fixture.oldAborts).toBe(0)

    fixture.releaseTool()
    await waitForIdle(fixture.runner)

    expect(fixture.oldAborts).toBe(1)
    expect(fixture.generation).toBe(2)
    expect(fixture.launchModels[1]).toEqual({ economy: "openai/next", strong: "openai/old" })
    // The solver model itself did not change; only the worker tier policy did.
    expect(fixture.prompts.map((item) => item.model)).toEqual(["openai/old", "openai/old"])
    expect(fixture.prompts[1]?.text).toContain("Worker model tier updated")
    expect(fixture.resumed).toEqual(["session-hot"])
  } finally {
    await fixture.runner.close()
  }
})

test("adopts an unchanged tier policy without relaunching the runtime", async () => {
  const fixture = await hotSwitchFixture()
  try {
    const result = await fixture.runner.applyLiveModelSettings({
      economyModel: "openai/old",
      strongModel: "openai/old",
      visionModel: "openai/old",
      consultModels: [],
      blindReview: false,
      consultOnCompaction: false,
      network: "allow",
    })
    expect(result.active).toBe(0)
    expect(fixture.generation).toBe(1)
    expect(fixture.oldAborts).toBe(0)
  } finally {
    await fixture.runner.close()
  }
})

test("configures on-demand vision only for a text-only solver model", async () => {
  const fixture = await hotSwitchFixture()
  try {
    const result = await fixture.runner.applyLiveModelSettings({
      economyModel: "openai/old",
      strongModel: "openai/next",
      visionModel: "openai/old",
      consultModels: [],
      blindReview: false,
      consultOnCompaction: false,
      network: "allow",
    })
    expect(result.active).toBe(1)
    expect(fixture.launchVisionModels).toEqual([undefined, "openai/old"])

    fixture.releaseTool()
    await waitForIdle(fixture.runner)
  } finally {
    await fixture.runner.close()
  }
})

test("runs a user-requested consultation at a safe boundary and resumes the live solver", async () => {
  const fixture = await hotSwitchFixture()
  try {
    const scheduled = fixture.runner.requestConsultation({
      slug: "sample",
      expertModels: ["openai/expert-a", "openai/expert-b"],
      synthesizerModel: "openai/old",
      solverModel: "openai/old",
      modelPolicy: { economy: "openai/old", strong: "openai/old" },
      consultModels: ["openai/expert-a", "openai/expert-b"],
      blindReview: false,
      consultOnCompaction: false,
      limits: { tokens: 100_000, repeats: 5, timeout: 60_000 },
      flagFormat: "flag\\{[^}]+\\}",
      requestedAt: Date.now(),
    })
    expect(scheduled).toMatchObject({ mode: "live-handoff", model: "openai/old" })
    expect(fixture.oldAborts).toBe(0)

    fixture.releaseTool()
    await waitForIdle(fixture.runner)

    expect(fixture.oldAborts).toBe(1)
    expect(fixture.consultationPrompts.map((item) => item.title)).toEqual([
      "Boom consult 1/2",
      "Boom consult 2/2",
      "Boom consult synthesis",
    ])
    for (const prompt of fixture.consultationPrompts)
      expect(prompt.text).toContain("artifact path: work/result.bin")
    expect(fixture.prompts.map((item) => item.model)).toEqual(["openai/old", "openai/old"])
    expect(fixture.prompts[1]?.text).toContain("merged diagnosis from the live context")
    expect(fixture.resumed).toEqual(["session-hot"])

    const [runID] = await readdir(path.join(fixture.root, "runs", "sample"))
    const task = JSON.parse(await readFile(path.join(fixture.root, "runs", "sample", runID!, "task.json"), "utf8"))
    expect(task.turns).toMatchObject([
      { model: "openai/old", stop: "switched" },
      { model: "openai/old", candidates: ["flag{switched}"] },
    ])
    const consultation = JSON.parse(await readFile(
      path.join(fixture.root, "runs", "sample", runID!, "work", "consultation.json"),
      "utf8",
    ))
    expect(consultation).toMatchObject({ trigger: "manual", source_run_id: runID })
  } finally {
    await fixture.runner.close()
  }
})

test("reloads an active Provider without closing the old runtime before handoff", async () => {
  const previousHome = process.env.BOOM_HOME
  const boomHome = await mkdtemp(path.join(os.tmpdir(), "boom-hot-provider-home-"))
  temporary.push(boomHome)
  process.env.BOOM_HOME = boomHome
  const fixture = await hotSwitchFixture()
  try {
    await fixture.runner.saveProvider({
      id: "openai",
      custom: false,
      disabled: false,
      name: "OpenAI updated",
      models: [],
      hiddenModels: [],
    })
    expect(fixture.generation).toBe(2)
    expect(fixture.closed).not.toContain(1)
    expect(fixture.oldAborts).toBe(0)

    fixture.releaseTool()
    await waitForIdle(fixture.runner)

    expect(fixture.resumed).toEqual(["session-hot"])
    expect(fixture.prompts.map((item) => item.model)).toEqual(["openai/old", "openai/old"])
    expect(fixture.closed).toContain(1)
  } finally {
    await fixture.runner.close()
    if (previousHome === undefined) delete process.env.BOOM_HOME
    else process.env.BOOM_HOME = previousHome
  }
})

test("saves Provider drafts without restarting until explicitly applied", async () => {
  const previousHome = process.env.BOOM_HOME
  const boomHome = await mkdtemp(path.join(os.tmpdir(), "boom-provider-save-home-"))
  temporary.push(boomHome)
  process.env.BOOM_HOME = boomHome
  const fixture = await hotSwitchFixture()
  try {
    const saved = await fixture.runner.saveProvider({
      id: "openai",
      custom: false,
      disabled: false,
      name: "Saved but not applied",
      models: [],
      hiddenModels: [],
    }, undefined, { apply: false })

    expect(saved).toBeUndefined()
    expect(fixture.generation).toBe(1)
    expect(fixture.oldAborts).toBe(0)
  } finally {
    await fixture.runner.close()
    if (previousHome === undefined) delete process.env.BOOM_HOME
    else process.env.BOOM_HOME = previousHome
  }
})
