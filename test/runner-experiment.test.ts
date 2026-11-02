import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GuiRunner } from "../src/runner.ts"
import { submitCandidate } from "../src/candidate-submission.ts"
import { loadTaskRecord } from "../src/task.ts"
import type { RuntimeHandle } from "../src/runtime-contract.ts"

test("experiment trials use fresh tasks and persist their original solver conditions", async () => {
  const interpreter = Bun.which("python3")
  if (!interpreter) throw new Error("This test requires Python 3 for task environment binding")
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-runner-experiment-"))
  const source = path.join(root, "challenges", "alpha")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "Analyze the handout")
  const challenge = { slug: "alpha", directory: source, description: "Analyze the handout", files: [], flagFormat: "" }
  const handle: RuntimeHandle = {
    backend: "fake", version: "test", capabilities: { eventStreaming: true, toolCalls: true, reasoning: false,
      attachments: false, web: false, cancellation: true, providerManagement: false, providerOAuth: false, compaction: false },
    agent: { async createConversation(input) {
      const id = crypto.randomUUID()
      return { id, async events() { return { async *[Symbol.asyncIterator]() {} } },
        async prompt(prompt) {
          expect(prompt.text).not.toContain("trial-artifact.txt")
          await writeFile(path.join(input.directory, "work", "trial-artifact.txt"), id)
          await submitCandidate({ directory: input.directory, sessionID: id, candidate: `candidate-${id}` })
          return { finish: "stop" as const, cost: 0, parts: [{ type: "text" as const, text: "done" }],
            usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }
        }, async abort() {} }
    } }, close() {},
  }
  const runner = new GuiRunner(root, async () => handle)
  try {
    const input = { challenges: [challenge], model: "test/strong", modelPolicy: { economy: "test/economy", strong: "test/strong" },
      blindReview: false, limits: { tokens: 10_000, timeout: 30_000, repeats: 3 }, flagFormat: "", pythonInterpreter: interpreter }
    await expect(runner.enqueue({ ...input, experiment: { label: "baseline", trial: 1 }, limits: { timeout: 30_000, repeats: 3 } }))
      .rejects.toThrow("finite token budget")
    await expect(runner.enqueue({ ...input, experiment: { label: "baseline", trial: 1 }, challenges: [{ ...challenge, platform: { adapter: "live" } }] }))
      .rejects.toThrow("without a live submission adapter")
    for (const trial of [1, 2]) {
      await runner.enqueue({ ...input, experiment: { label: "baseline", trial } })
      for (let i = 0; i < 500 && runner.hasWork(); i += 1) await Bun.sleep(10)
      expect(runner.hasWork()).toBe(false)
    }
    const ids = await readdir(path.join(root, "tasks", "alpha"))
    expect(ids).toHaveLength(2)
    const tasks = await Promise.all(ids.map((id) => loadTaskRecord(path.join(root, "tasks", "alpha", id))))
    expect(tasks.map((task) => task?.experiment?.trial).sort()).toEqual([1, 2])
    for (const task of tasks) {
      expect(task).toMatchObject({ status: "candidate-found", currentModel: "test/strong", experiment: { label: "baseline",
        conditions: { model: "test/strong", tokens: 10_000, timeoutMs: 30_000, repeats: 3 } } })
      expect(task?.experiment?.invalidated).toBeUndefined()
    }
    expect(tasks[0]?.experiment?.conditions?.inputFingerprint).toBe(tasks[1]?.experiment?.conditions?.inputFingerprint)
    const results = await Promise.all(ids.map((id) => readFile(path.join(root, "tasks", "alpha", id, "result.json"), "utf8")))
    expect(JSON.parse(results[0]!).experiment.conditions.model).toBe("test/strong")
    await expect(runner.enqueue({ ...input, experiment: { label: "baseline", trial: 3 }, workspaces: { alpha: ids[0]! } }))
      .rejects.toThrow("fresh independent tasks")
  } finally { await runner.close(); await rm(root, { recursive: true, force: true }) }
}, 15_000)
