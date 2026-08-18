import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EnvironmentPool } from "../src/competition/environments.ts"
import { GuiRunner } from "../src/runner.ts"
import type { RuntimeHandle } from "../src/runtime-contract.ts"

const temporary: string[] = []

afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

/**
 * A runtime that reports when each challenge's prompt starts and blocks until released, so the test
 * can observe how many challenges the scheduler admits concurrently.
 */
function gatedRuntime() {
  const started: string[] = []
  const release = new Map<string, () => void>()
  const waiting: Array<() => void> = []

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
      async createConversation(options: { title?: string }) {
        // The conversation title is `Boom: <slug>`, which is how the test attributes each prompt.
        const slug = options.title?.replace(/^Boom:\s*/, "").trim() || "unknown"
        return {
          id: `conversation-${slug}`,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt() {
            started.push(slug)
            for (const notify of waiting.splice(0)) notify()
            await new Promise<void>((resolve) => release.set(slug, resolve))
            return {
              usage: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              finish: "stop" as const,
              parts: [{ type: "text" as const, text: "done" }],
            }
          },
          async abort() {},
        }
      },
    },
    close() {},
  }

  return {
    handle,
    started,
    releaseAll() {
      for (const [, resolve] of release) resolve()
      release.clear()
    },
    /** Wait until at least `count` prompts have begun, or the timeout expires. */
    async settle(count: number, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs
      while (started.length < count && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve)
          setTimeout(resolve, 25)
        })
      }
      // Let the scheduler attempt any further admissions it believes are allowed.
      await Bun.sleep(120)
    },
  }
}

async function challengeAt(root: string, category: string, slug: string, meta: Record<string, unknown>) {
  const directory = path.join(root, "challenges", category, slug)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "README.md"), `# ${slug}`)
  await writeFile(path.join(directory, "meta.json"), JSON.stringify({ category, ...meta }, undefined, 2))
  return {
    slug,
    category: category as "WEB",
    directory,
    sourceDirectory: directory,
    description: `# ${slug}`,
    files: [],
    flagFormat: "",
    ...(meta.service_required === true ? { serviceRequired: true as const } : {}),
    ...(typeof meta.remote === "string" ? { remote: meta.remote } : {}),
    ...(typeof meta.difficulty === "string" ? { difficulty: meta.difficulty } : {}),
  }
}

describe("competition scheduling", () => {
  test("bulk environment close recovers every held lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-comp-close-all-"))
    temporary.push(root)
    const recovered: string[] = []
    const runner = new GuiRunner(root, async () => gatedRuntime().handle)
    const pool = new EnvironmentPool(3, async (exerciseId) => { recovered.push(exerciseId) })
    ;(runner as unknown as { environments: EnvironmentPool }).environments = pool
    pool.acquire("web-a", "101")
    pool.acquire("web-b", "102")

    try {
      await expect(runner.closeAllEnvironments()).resolves.toEqual({
        stopped: 0,
        released: 2,
        errors: [],
      })
      expect(recovered).toEqual(["101", "102"])
      expect(runner.getCompetitionState().environments.used).toBe(0)
    } finally {
      await runner.close()
    }
  })

  test("admits no more than the configured number of remote-environment challenges", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-comp-slots-"))
    temporary.push(root)

    // Five challenges that all need a target service; the platform allows only three environments.
    const challenges = []
    for (const slug of ["r1", "r2", "r3", "r4", "r5"])
      challenges.push(await challengeAt(root, "WEB", slug, { service_required: true, remote: "1.2.3.4:80" }))

    const runtime = gatedRuntime()
    const runner = new GuiRunner(root, async () => runtime.handle)
    // Generous global concurrency: the remote cap must be what limits admission, not this.
    runner.setConcurrency(16)
    runner.setCompetitionSettings({ remoteSlots: 3, localSlots: 8, matchMinutes: 180, endgameMinutes: 20 })
    try {
      await runner.enqueue({
        challenges,
        model: "test/solver",
        limits: { tokens: 10_000, repeats: 3, timeout: 30_000 },
        flagFormat: "",
        pythonInterpreter: interpreter,
      })
      await runtime.settle(3)
      expect(runtime.started).toHaveLength(3)
      expect(runner.getCompetitionState().usage.remote).toBe(3)

      runtime.releaseAll()
      for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1) {
        runtime.releaseAll()
        await Bun.sleep(10)
      }
      // Every challenge still runs eventually; the cap paces them rather than dropping them.
      // (A challenge may take more than one turn, so compare the distinct set, not the total count.)
      expect(new Set(runtime.started)).toEqual(new Set(["r1", "r2", "r3", "r4", "r5"]))
    } finally {
      runtime.releaseAll()
      await runner.close()
    }
  })

  test("runs local challenges without consuming the remote environment budget", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-comp-local-"))
    temporary.push(root)

    const challenges = [
      await challengeAt(root, "MISC", "local-a", { difficulty: "VERY_EASY" }),
      await challengeAt(root, "MISC", "local-b", { difficulty: "VERY_EASY" }),
      await challengeAt(root, "MISC", "local-c", { difficulty: "VERY_EASY" }),
      await challengeAt(root, "WEB", "remote-a", { service_required: true, remote: "1.2.3.4:80" }),
    ]

    const runtime = gatedRuntime()
    const runner = new GuiRunner(root, async () => runtime.handle)
    runner.setConcurrency(16)
    // Only one environment, but local work must not be throttled by that.
    runner.setCompetitionSettings({ remoteSlots: 1, localSlots: 8, matchMinutes: 180, endgameMinutes: 20 })
    try {
      await runner.enqueue({
        challenges,
        model: "test/solver",
        limits: { tokens: 10_000, repeats: 3, timeout: 30_000 },
        flagFormat: "",
        pythonInterpreter: interpreter,
      })
      await runtime.settle(4)
      const state = runner.getCompetitionState()
      // The single environment bounds only the remote challenge; local work runs at full width.
      expect(state.usage.local).toBe(3)
      expect(state.usage.remote).toBe(1)
      // All three local challenges get going despite the environment budget being fully consumed.
      expect(new Set(runtime.started)).toEqual(
        new Set(["local-a", "local-b", "local-c", "remote-a"]),
      )
    } finally {
      runtime.releaseAll()
      await runner.close()
    }
  })

  test("does not start new challenges once the endgame window is reached", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-comp-endgame-"))
    temporary.push(root)
    const challenge = await challengeAt(root, "MISC", "late", { difficulty: "VERY_EASY" })

    const runtime = gatedRuntime()
    const runner = new GuiRunner(root, async () => runtime.handle)
    runner.setConcurrency(4)
    // Deadline inside the endgame window: finishing existing work is fine, starting fresh work is not.
    runner.setCompetitionSettings({
      remoteSlots: 3,
      localSlots: 8,
      matchMinutes: 180,
      endgameMinutes: 20,
      deadline: Date.now() + 5 * 60_000,
    })
    try {
      await runner.enqueue({
        challenges: [challenge],
        model: "test/solver",
        limits: { tokens: 10_000, repeats: 3, timeout: 30_000 },
        flagFormat: "",
        pythonInterpreter: interpreter,
      })
      await Bun.sleep(250)
      // The challenge stays queued rather than burning the last minutes on a fresh start.
      expect(runtime.started).toHaveLength(0)
      expect(runner.getCompetitionState().clock.endgame).toBe(true)
    } finally {
      runtime.releaseAll()
      await runner.close()
    }
  })

  test("reports the match clock and environment capacity", () => {
    const runner = new GuiRunner("/tmp/does-not-matter", async () => {
      throw new Error("runtime must not start for a settings-only assertion")
    })
    try {
      const applied = runner.setCompetitionSettings({
        remoteSlots: 3,
        localSlots: 6,
        matchMinutes: 180,
        endgameMinutes: 20,
      })
      expect(applied).toMatchObject({ remoteSlots: 3, localSlots: 6, matchMinutes: 180 })
      const idle = runner.getCompetitionState()
      expect(idle.clock.started).toBe(false)
      expect(idle.environments).toMatchObject({ used: 0, limit: 3 })

      runner.setCompetitionSettings({
        remoteSlots: 2,
        localSlots: 6,
        matchMinutes: 180,
        endgameMinutes: 20,
        deadline: Date.now() + 60 * 60_000,
      })
      const running = runner.getCompetitionState()
      expect(running.clock).toMatchObject({ started: true, endgame: false, over: false })
      expect(running.environments.limit).toBe(2)
    } finally {
      void runner.close()
    }
  })
})
