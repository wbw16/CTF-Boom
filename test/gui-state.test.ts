import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_GUI_SETTINGS,
  loadLastGuiRoot,
  loadRootGuiState,
  saveLastGuiRoot,
  saveRootGuiState,
} from "../src/gui-state.ts"
import {
  activeCandidate,
  applyRunnerNotification,
  candidateValues,
  displayFlagRun,
  label,
  latestFlagRun,
  primary,
  resolveRunDetail,
  withRunDetail,
  why,
} from "../frontend/src/state.ts"
import type { ChallengeGui, GuiState, RunHistory, RunnerNotification } from "../frontend/src/types.ts"

describe("GUI state", () => {
  test("remembers the last active workspace root across saves of per-root state", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "boom-gui-state-"))
    const previous = process.env.BOOM_HOME
    process.env.BOOM_HOME = home
    try {
      expect(await loadLastGuiRoot()).toBeUndefined()
      const root = path.join(home, "题库")
      await saveLastGuiRoot(root)
      // A relative spelling resolves to the same remembered absolute root, and rewriting the same
      // value must not clobber per-root state saved between the two calls.
      await saveRootGuiState(root, {
        settings: DEFAULT_GUI_SETTINGS,
        challenges: { alpha: { state: "given-up" } },
      })
      await saveLastGuiRoot(path.join(home, ".", "题库"))
      expect(await loadLastGuiRoot()).toBe(path.resolve(root))
      expect((await loadRootGuiState(root)).challenges.alpha).toEqual({ state: "given-up" })
    } finally {
      if (previous === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })

  test("isolates settings and challenge lifecycle by canonical root", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "boom-gui-state-"))
    const previous = process.env.BOOM_HOME
    process.env.BOOM_HOME = home
    try {
      const rootA = path.join(home, "contest-a")
      const rootB = path.join(home, "contest-b")
      await saveRootGuiState(rootA, {
        settings: {
          ...DEFAULT_GUI_SETTINGS,
          economyModel: "openai/gpt-a-mini",
          strongModel: "openai/gpt-a",
          tokens: 123_000,
          flagFormat: "A\\{[^}]*\\}",
        },
        challenges: {
          alpha: { state: "given-up" },
        },
      })
      await saveRootGuiState(rootB, {
        settings: {
          ...DEFAULT_GUI_SETTINGS,
          economyModel: "openai/gpt-b-mini",
          strongModel: "openai/gpt-b",
          repeats: 9,
          network: "deny",
        },
        challenges: {
          beta: { state: "removed" },
        },
      })

      expect(await loadRootGuiState(rootA)).toMatchObject({
        settings: {
          economyModel: "openai/gpt-a-mini",
          strongModel: "openai/gpt-a",
          visionModel: "",
          tokens: 123_000,
          flagFormat: "A\\{[^}]*\\}",
          network: "allow",
        },
        challenges: {
          alpha: { state: "given-up" },
        },
      })
      expect((await loadRootGuiState(rootA)).challenges.beta).toBeUndefined()
      expect(await loadRootGuiState(rootB)).toMatchObject({
        settings: {
          economyModel: "openai/gpt-b-mini",
          strongModel: "openai/gpt-b",
          repeats: 9,
          network: "deny",
        },
        challenges: { beta: { state: "removed" } },
      })
      expect((await loadRootGuiState(rootB)).challenges.alpha).toBeUndefined()
      expect(await loadRootGuiState(path.join(home, "unseen"))).toEqual({
        settings: DEFAULT_GUI_SETTINGS,
        challenges: {},
      })
    } finally {
      if (previous === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })

  test("persists an explicitly disabled token budget", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "boom-gui-time-only-"))
    const previous = process.env.BOOM_HOME
    process.env.BOOM_HOME = home
    try {
      const root = path.join(home, "contest")
      await saveRootGuiState(root, {
        settings: { ...DEFAULT_GUI_SETTINGS, tokenBudgetEnabled: false },
        challenges: {},
      })
      expect((await loadRootGuiState(root)).settings).toMatchObject({
        tokenBudgetEnabled: false,
        tokens: DEFAULT_GUI_SETTINGS.tokens,
      })
      expect(DEFAULT_GUI_SETTINGS.tokenBudgetEnabled).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("GUI challenge presentation", () => {
  test("presents a legacy missing-remote block as resumable", () => {
    const run = {
      id: "legacy-run",
      model: "test/model",
      stop: "blocked",
      tokens: 0,
      billableTokens: 0,
      cost: 0,
      candidates: [],
      alternatives: [],
      flagFormat: "",
      reply: "",
      detail: "challenge requires an external service, but meta.json has no reachable remote endpoint",
      events: [],
      notes: "",
      files: [],
    } satisfies RunHistory
    const challenge = {
      slug: "service-task",
      category: "CRYPTO",
      storagePath: "CRYPTO/service-task",
      files: [],
      serviceRequired: true,
      runs: [run],
    } satisfies ChallengeGui

    expect(label(challenge)).toEqual(["待继续", "c-warn"])
    expect(why(challenge)).toContain("直接继续本地分析")
  })
})

function runFixture(overrides: Partial<RunHistory> = {}): RunHistory {
  return {
    id: "run-1",
    model: "test/model",
    stop: "running",
    tokens: 0,
    billableTokens: 0,
    cost: 0,
    candidates: [],
    alternatives: [],
    flagFormat: "",
    reply: "",
    events: [],
    notes: "",
    files: [],
    ...overrides,
  }
}

function liveState(...runs: RunHistory[]): GuiState {
  return {
    root: "/tmp/boom-live-detail",
    settings: {
      mode: "ctf",
      economyModel: "test/model",
      strongModel: "test/model",
      tokens: 10_000,
      tokenBudgetEnabled: true,
      repeats: 3,
      minutes: 5,
      concurrency: 1,
      flagFormat: "",
      executionMode: "managed",
      consultModels: [],
      blindReview: true,
      consultOnCompaction: true,
      network: "allow",
      competition: { remoteSlots: 3, localSlots: 5, matchMinutes: 180, endgameMinutes: 20 },
    },
    models: [{ id: "test/model", name: "Test", connected: true }],
    runtime: { status: "ready", active: 1, queued: 0, concurrency: 1 },
    environments: { version: 1, profiles: [] },
    challenges: [{
      slug: "alpha",
      category: "MISC",
      storagePath: "MISC/alpha",
      files: [],
      runs,
    }],
  }
}

describe("GUI live task detail", () => {
  test("applies run events to both the summary and rich detail without a list click", () => {
    const summary = runFixture()
    const rich = runFixture({ notes: "durable evidence", files: [{ path: "work/proof.txt", size: 5, directory: false }] })
    const update = {
      at: 100,
      type: "run.event",
      slug: "alpha",
      runID: "run-1",
      event: { at: 100, type: "usage", tokens: 42, billable: 21, cost: 0.25 },
    } satisfies RunnerNotification

    const result = applyRunnerNotification(
      liveState(summary),
      { slug: "alpha", run: rich },
      "alpha",
      update,
    )

    expect(result.revalidate).toBe("none")
    expect(result.data?.challenges[0]!.runs[0]).toMatchObject({
      tokens: 42,
      billableTokens: 21,
      cost: 0.25,
      events: [update.event],
    })
    expect(result.detail?.run).toMatchObject({
      notes: "durable evidence",
      tokens: 42,
      billableTokens: 21,
      cost: 0.25,
      events: [update.event],
    })

    const duplicate = applyRunnerNotification(result.data, result.detail, "alpha", update)
    expect(duplicate.data).toBe(result.data)
    expect(duplicate.detail).toBe(result.detail)
    expect(duplicate.revalidate).toBe("none")
  })

  test("revalidates rich evidence after terminal tools and full state after lifecycle events", () => {
    const summary = runFixture()
    const detail = { slug: "alpha", run: runFixture({ notes: "before" }) }
    const completedTool = {
      at: 200,
      type: "run.event",
      slug: "alpha",
      runID: "run-1",
      event: { at: 200, type: "tool", tool: "ctf-note", status: "completed", text: "saved" },
    } satisfies RunnerNotification
    expect(applyRunnerNotification(liveState(summary), detail, "alpha", completedTool).revalidate)
      .toBe("detail")

    const consultation = {
      ...completedTool,
      event: { at: 201, type: "text", status: "consultation", text: "merged plan" },
    } satisfies RunnerNotification
    expect(applyRunnerNotification(liveState(summary), detail, "alpha", consultation).revalidate)
      .toBe("detail")

    const platformVerdict = {
      ...completedTool,
      event: { at: 202, type: "status", status: "candidate.accepted" },
    } satisfies RunnerNotification
    expect(applyRunnerNotification(liveState(summary), detail, "alpha", platformVerdict).revalidate)
      .toBe("detail")

    const finished = {
      ...completedTool,
      type: "run.finished",
      event: { at: 201, type: "status", status: "turn.finished" },
    } satisfies RunnerNotification
    const lifecycle = applyRunnerNotification(liveState(summary), detail, "alpha", finished)
    expect(lifecycle.detail?.run.events).toContainEqual(finished.event)
    expect(lifecycle.revalidate).toBe("state")
  })

  test("keeps other tasks isolated and reconciles an unknown live run", () => {
    const detail = { slug: "alpha", run: runFixture({ notes: "alpha only" }) }
    const data = liveState(runFixture())
    data.challenges.push({
      slug: "beta",
      category: "MISC",
      storagePath: "MISC/beta",
      files: [],
      runs: [runFixture({ id: "run-2" })],
    })
    const other = {
      at: 300,
      type: "run.event",
      slug: "beta",
      runID: "run-2",
      event: { at: 300, type: "tool", tool: "bash", status: "completed" },
    } satisfies RunnerNotification
    const result = applyRunnerNotification(data, detail, "alpha", other)
    expect(result.detail).toBe(detail)
    expect(result.revalidate).toBe("none")

    const unknown = { ...other, slug: "gamma", runID: "run-3" }
    expect(applyRunnerNotification(result.data, result.detail, "alpha", unknown).revalidate)
      .toBe("state")

    const wrongRun = { ...other, slug: "alpha", runID: "missing-run" }
    const before = result.data?.challenges[0]!.runs[0]!.events
    const reconciled = applyRunnerNotification(result.data, result.detail, "alpha", wrongRun)
    expect(reconciled.revalidate).toBe("state")
    expect(reconciled.data?.challenges[0]!.runs[0]!.events).toBe(before)
  })

  test("hydrates activity, evidence, and results from the matching rich run", () => {
    const summary = runFixture({
      stop: "running",
      tokens: 50,
      primaryCandidate: "flag{live}",
      candidates: ["flag{live}"],
      writeup: "",
    })
    const rich = runFixture({
      stop: "completed",
      tokens: 40,
      primaryCandidate: "flag{live}",
      candidates: ["flag{live}"],
      notes: "proof notes",
      writeup: "# Solution\nflag{live}",
      files: [{ path: "work/exploit.py", size: 12, directory: false }],
      events: [{ at: 10, type: "text", text: "working" }],
    })
    const challenge = liveState(summary).challenges[0]!
    const hydrated = withRunDetail(challenge, rich)

    expect(hydrated.runs[0]).toMatchObject({
      stop: "completed",
      tokens: 40,
      notes: "proof notes",
      writeup: "# Solution\nflag{live}",
      files: [{ path: "work/exploit.py" }],
      events: [{ text: "working" }],
    })
  })

  test("uses snapshot sequences to prevent stale state from rolling back a newer detail", () => {
    const rich = runFixture({
      stop: "completed",
      tokens: 20,
      notes: "new proof",
      candidates: ["flag{new}"],
      primaryCandidate: "flag{new}",
    })
    const stale = liveState(runFixture({ stop: "running", tokens: 10 }))
    stale.sequence = 9
    expect(resolveRunDetail(stale, "alpha", { slug: "alpha", run: rich, sequence: 10 }))
      .toMatchObject({ stop: "completed", tokens: 20, primaryCandidate: "flag{new}", notes: "new proof" })

    const newer = liveState(runFixture({
      stop: "completed",
      tokens: 30,
      candidates: ["flag{accepted}"],
      primaryCandidate: "flag{accepted}",
      taskStatus: "solved",
      acceptedFlag: "flag{accepted}",
    }))
    newer.sequence = 11
    expect(resolveRunDetail(newer, "alpha", { slug: "alpha", run: rich, sequence: 10 }))
      .toMatchObject({
        stop: "completed",
        tokens: 30,
        primaryCandidate: "flag{accepted}",
        acceptedFlag: "flag{accepted}",
        notes: "new proof",
      })
  })

  test("shows the accepted or archived flag before stale candidates", () => {
    expect(candidateValues(runFixture({
      candidates: ["flag{wrong}"],
      primaryCandidate: "flag{wrong}",
      acceptedFlag: "flag{right}",
    }))[0]).toBe("flag{right}")
    expect(candidateValues(runFixture({ confirmedFlag: "flag{archive}" }))[0])
      .toBe("flag{archive}")
  })

  test("keeps a platform-rejected flag in history but never presents it as current", () => {
    const rejected = runFixture({
      stop: "completed",
      candidates: ["DASCTF{ni_cai?}"],
      primaryCandidate: "DASCTF{ni_cai?}",
      candidateHistory: ["DASCTF{ni_cai?}"],
      rejectedFlags: ["DASCTF{ni_cai?}"],
    })
    const challenge = liveState(rejected).challenges[0]!

    expect(candidateValues(rejected)).toContain("DASCTF{ni_cai?}")
    expect(activeCandidate(rejected)).toBe("")
    expect(primary(rejected)).toBe("")
    expect(latestFlagRun(challenge)).toBeUndefined()
    expect(displayFlagRun(challenge, rejected)).toBeUndefined()
  })

  test("prefers a confirmed flag across runs over a newer pending candidate", () => {
    const accepted = runFixture({
      id: "accepted",
      stop: "completed",
      candidates: ["flag{right}"],
      acceptedFlag: "flag{right}",
      taskStatus: "solved",
    })
    const pending = runFixture({
      id: "pending",
      candidates: ["flag{pending}"],
      primaryCandidate: "flag{pending}",
    })
    const challenge = liveState(accepted, pending).challenges[0]!
    expect(displayFlagRun(withRunDetail(challenge, pending), pending)?.id).toBe("accepted")
    expect(candidateValues(accepted)[0]).toBe("flag{right}")
  })
})

describe("GUI state durability", () => {
  test("quarantines a corrupt state file instead of silently wiping it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "boom-gui-state-"))
    const previous = process.env.BOOM_HOME
    process.env.BOOM_HOME = home
    try {
      const target = path.join(home, "gui-state.json")
      const corrupt = '{"version":2,"roots":{"broken":'
      await writeFile(target, corrupt, "utf8")
      expect(loadRootGuiState(path.join(home, "any-root"))).rejects.toThrow("GUI state")
      const entries = await readdir(home)
      const backup = entries.find((name) => name.startsWith("gui-state.json.corrupt-"))
      expect(backup).toBeDefined()
      expect(await readFile(path.join(home, backup!), "utf8")).toBe(corrupt)
      expect(existsSync(target)).toBe(false)
      // The quarantined store behaves like a fresh install on the next load.
      expect(await loadRootGuiState(path.join(home, "any-root"))).toMatchObject({ challenges: {} })
    } finally {
      process.env.BOOM_HOME = previous
    }
  })
})
