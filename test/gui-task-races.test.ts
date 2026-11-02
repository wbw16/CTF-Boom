import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadChallenge } from "../src/challenge.ts"
import { bindTaskEnvironment } from "../src/environment.ts"
import { DEFAULT_GUI_SETTINGS } from "../src/gui-state.ts"
import { startGuiServer } from "../src/gui.ts"
import { PentestAgentManager } from "../src/pentest/agent.ts"
import { createEngagement, loadEngagement } from "../src/pentest/store.ts"
import { GuiRunner } from "../src/runner.ts"
import type { RuntimeHandle } from "../src/runtime-contract.ts"
import { loadOrCreateTask, loadTaskRecord, saveTaskRecord } from "../src/task.ts"
import { prepareWorkspace } from "../src/workspace.ts"

const capabilities = { eventStreaming: true, toolCalls: true, reasoning: false, attachments: false, web: false, cancellation: true, providerManagement: false, providerOAuth: false, compaction: false }
const usage = { input: 2, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
async function wait(predicate: () => boolean) {
  const deadline = Date.now() + 5_000
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for fake runtime"); await Bun.sleep(5) }
}

for (const correct of [true, false]) test(`manual ${correct ? "acceptance" : "rejection"} survives a live turn's final write`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-gui-task-race-"))
  const previousHome = process.env.BOOM_HOME
  process.env.BOOM_HOME = path.join(root, "home")
  let release: (() => void) | undefined
  let started = false
  let prompts = 0
  const handle: RuntimeHandle = {
    backend: "fake", version: "test", capabilities,
    agent: { async createConversation() { return {
      id: "race-session", async events() { return { async *[Symbol.asyncIterator]() {} } },
      async prompt() {
        if (prompts++ === 0) { started = true; await new Promise<void>((resolve) => { release = resolve }) }
        return { finish: "stop", usage, cost: 0, parts: [{ type: "text", text: "turn finished" }] }
      }, async abort() { release?.() },
    } } }, close() { release?.() },
  }
  const runner = new GuiRunner(root, async () => handle)
  let gui: Awaited<ReturnType<typeof startGuiServer>> | undefined
  try {
    const source = path.join(root, "challenges", "sample")
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, "README.md"), "offline fixture")
    const challenge = await loadChallenge(source, new Map())
    const workspace = await prepareWorkspace(root, challenge, "task")
    const interpreter = Bun.which("python3")
    if (!interpreter) throw new Error("python3 is required for the task fixture")
    await bindTaskEnvironment({ directory: workspace.directory, source: "task-override", profile: { id: "fixture-python", displayName: "Fixture", kind: "python", interpreter, pythonVersion: "3", architecture: process.arch, packages: {}, installPolicy: "deny", fingerprint: "fixture", status: "ready" } })
    const task = await loadOrCreateTask(workspace.directory, { id: workspace.runID, slug: challenge.slug, model: "test/model" })
    const at = new Date().toISOString()
    task.turns.push({ id: "prior", model: "test/model", startedAt: at, finishedAt: at, stop: "completed", tokens: 0, billableTokens: 0, cost: 0, candidates: ["flag{reviewed}"], primaryCandidate: "flag{reviewed}" })
    task.status = "candidate-found"
    await saveTaskRecord(workspace.directory, task)
    gui = await startGuiServer({ root, hostname: "127.0.0.1", port: 0, open: false, runner, startRuntime: false, tokenAuth: false })
    await runner.enqueue({ challenges: [challenge], model: "test/model", limits: { tokens: 100, repeats: 5, timeout: 30_000 }, flagFormat: "", workspaces: { sample: workspace.runID } })
    await wait(() => started)
    const response = await fetch(new URL("/api/flags", gui.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "sample", runID: workspace.runID, flag: "flag{reviewed}", correct }) })
    expect(response.status).toBe(202)
    await wait(() => !runner.hasWork())
    const after = await loadTaskRecord(workspace.directory)
    expect(after?.turns.length).toBeGreaterThan(1)
    if (correct) expect(after).toMatchObject({ status: "solved", acceptedFlag: { value: "flag{reviewed}" } })
    else { expect(after?.acceptedFlag).toBeUndefined(); expect(after?.rejectedFlags).toContain("flag{reviewed}") }
  } finally {
    release?.()
    if (gui) await gui.close(); else await runner.close()
    if (previousHome === undefined) delete process.env.BOOM_HOME; else process.env.BOOM_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test("pentest retains its runtime generation while network settings reload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-pentest-lease-"))
  let generation = 0
  const live = new Map<number, { closed: boolean; started: boolean }>()
  const runner = new GuiRunner(root, async () => {
    const id = ++generation
    const state = { closed: false, started: false }
    live.set(id, state)
    return { backend: "fake", version: String(id), capabilities, agent: { async createConversation() { return {
      id: `pentest-${id}`, async events() { return { async *[Symbol.asyncIterator]() {} } },
      async prompt(request) {
        state.started = true
        await new Promise<void>((resolve) => { if (request.signal?.aborted) resolve(); else request.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        return { cost: 0, parts: [], finish: "cancelled" }
      }, async abort() {},
    } } }, close() { state.closed = true } } satisfies RuntimeHandle
  })
  const manager = new PentestAgentManager({ root: () => root, ensureRuntime: () => runner.ensureRuntime(), acquireRuntime: () => runner.acquireRuntime(), model: () => "test/model", probeTools: async () => [], ensureEnvironment: async () => ({}) })
  try {
    const settings = { ...DEFAULT_GUI_SETTINGS, economyModel: "test/model", strongModel: "test/model", visionModel: "" }
    await runner.applyLiveModelSettings(settings)
    const engagement = await createEngagement(root, { target: "fixture.invalid", objective: "offline lifecycle test", authorization: "fake runtime only", scope: ["fixture.invalid"] })
    await manager.start(engagement.slug)
    await wait(() => !!live.get(generation)?.started)
    const held = generation
    await runner.applyLiveModelSettings({ ...settings, network: "deny" })
    expect(live.get(held)?.closed).toBe(false)
    expect(manager.isLive(engagement.slug)).toBe(true)
    await manager.stopAll()
    expect(live.get(held)?.closed).toBe(true)
    expect((await loadEngagement(root, engagement.slug)).run?.phase).toBe("paused")
  } finally { await manager.stopAll(); await runner.close(); await rm(root, { recursive: true, force: true }) }
})
