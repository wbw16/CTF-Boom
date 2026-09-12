import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  canStart,
  challengeBudgetMs,
  DEFAULT_COMPETITION_SETTINGS,
  decideGiveUp,
  matchClock,
  normalizeCompetitionSettings,
  prioritize,
  slotKindFor,
  type CompetitionSettings,
} from "../src/competition/policy.ts"
import { EnvironmentPool } from "../src/competition/environments.ts"
import {
  gateSubmission,
  loadSubmissionLedger,
  recordAttempt,
  rejectedValues,
  saveSubmissionLedger,
} from "../src/competition/submissions.ts"
import { clearCompetitionAdapterCache, loadCompetitionAdapter } from "../src/platform/registry.ts"
import { DasctfPlatformAdapter } from "../src/platform/adapters/dasctf.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const NOW = 1_800_000_000_000

function settings(overrides: Partial<CompetitionSettings> = {}): CompetitionSettings {
  return { ...DEFAULT_COMPETITION_SETTINGS, ...overrides }
}

function challenge(over: Partial<{
  slug: string
  difficulty: string
  serviceRequired: boolean
  remote: string
}> = {}) {
  return {
    slug: over.slug ?? "one",
    category: "WEB" as const,
    ...(over.difficulty === undefined ? {} : { difficulty: over.difficulty }),
    ...(over.serviceRequired === undefined ? {} : { serviceRequired: over.serviceRequired }),
    ...(over.remote === undefined ? {} : { remote: over.remote }),
  }
}

test("classifies which challenges consume a scarce remote environment", () => {
  expect(slotKindFor(challenge())).toBe("local")
  expect(slotKindFor(challenge({ serviceRequired: true }))).toBe("remote")
  expect(slotKindFor(challenge({ remote: "1.2.3.4:80" }))).toBe("remote")
})

test("defaults encode the platform rules and resist silent drift", () => {
  expect(DEFAULT_COMPETITION_SETTINGS.remoteSlots).toBe(3)
  expect(DEFAULT_COMPETITION_SETTINGS.matchMinutes).toBe(180)
  // Garbage falls back rather than disabling the cap.
  expect(normalizeCompetitionSettings({ remoteSlots: 0 }).remoteSlots).toBe(3)
  expect(normalizeCompetitionSettings({ remoteSlots: "many" }).remoteSlots).toBe(3)
  // Operators may use fewer containers, but a higher value is rejected by the contest platform.
  expect(normalizeCompetitionSettings({ remoteSlots: 4 }).remoteSlots).toBe(3)
  expect(normalizeCompetitionSettings({ localSlots: 9_999 }).localSlots).toBe(32)
})

test("tracks the match clock and the endgame window", () => {
  const idle = matchClock(settings(), NOW)
  expect(idle.started).toBe(false)
  expect(idle.endgame).toBe(false)

  const running = matchClock(settings({ deadline: NOW + 90 * 60_000 }), NOW)
  expect(running).toMatchObject({ started: true, endgame: false, over: false })
  expect(running.remainingMs).toBe(90 * 60_000)
  expect(running.elapsedMs).toBe(90 * 60_000)

  expect(matchClock(settings({ deadline: NOW + 10 * 60_000 }), NOW).endgame).toBe(true)
  expect(matchClock(settings({ deadline: NOW - 1 }), NOW)).toMatchObject({ endgame: true, over: true })
})

test("prioritizes local, easy, high-scoring challenges first", () => {
  const ordered = prioritize([
    { challenge: challenge({ slug: "hard-remote", difficulty: "HARD", serviceRequired: true }), score: 300 },
    { challenge: challenge({ slug: "easy-local", difficulty: "VERY_EASY" }), score: 50 },
    { challenge: challenge({ slug: "easy-remote", difficulty: "EASY", serviceRequired: true }), score: 100 },
    { challenge: challenge({ slug: "medium-local", difficulty: "MEDIUM" }), score: 200 },
  ], NOW).map((item) => item.challenge.slug)

  // Local work never waits behind a challenge that needs one of the three environments.
  expect(ordered.slice(0, 2)).toEqual(["easy-local", "medium-local"])
  expect(ordered.slice(2)).toEqual(["easy-remote", "hard-remote"])
})

test("orders equal challenges by score and demotes stagnating ones", () => {
  const byScore = prioritize([
    { challenge: challenge({ slug: "cheap", difficulty: "EASY" }), score: 50 },
    { challenge: challenge({ slug: "rich", difficulty: "EASY" }), score: 500 },
  ], NOW).map((item) => item.challenge.slug)
  expect(byScore).toEqual(["rich", "cheap"])

  const withStagnation = prioritize([
    { challenge: challenge({ slug: "stuck", difficulty: "EASY" }), score: 500, attempts: 4, progressed: false },
    { challenge: challenge({ slug: "fresh", difficulty: "EASY" }), score: 50 },
  ], NOW).map((item) => item.challenge.slug)
  // An untouched challenge is the better investment than one that keeps yielding nothing.
  expect(withStagnation).toEqual(["fresh", "stuck"])
})

test("scales the per-challenge budget by difficulty and never plans past the match end", () => {
  const base = settings()
  expect(challengeBudgetMs(challenge({ difficulty: "VERY_EASY" }), base, NOW)).toBe(12 * 60_000)
  expect(challengeBudgetMs(challenge({ difficulty: "HARD" }), base, NOW)).toBe(35 * 60_000)
  // Unknown labels get the default rather than an unbounded budget.
  expect(challengeBudgetMs(challenge({ difficulty: "???" }), base, NOW)).toBe(25 * 60_000)
  // Near the end, the remaining match time is the real ceiling.
  const late = settings({ deadline: NOW + 5 * 60_000 })
  expect(challengeBudgetMs(challenge({ difficulty: "HARD" }), late, NOW)).toBe(5 * 60_000)
})

test("never abandons a challenge that already holds a candidate", () => {
  const decision = decideGiveUp({
    challenge: challenge({ difficulty: "VERY_EASY" }),
    settings: settings({ deadline: NOW + 60_000 }),
    activeMs: 10 * 60 * 60_000,
    hasCandidate: true,
    yieldsWithoutProgress: 9,
    now: NOW,
  })
  // Submitting is nearly free and carries no time penalty, so a candidate is always worth finishing.
  expect(decision.action).toBe("continue")
})

test("does not apply match-only time budgets before the competition clock starts", () => {
  expect(decideGiveUp({
    challenge: challenge({ difficulty: "VERY_EASY" }),
    settings: settings(),
    activeMs: 10 * 60 * 60_000,
    hasCandidate: false,
    yieldsWithoutProgress: 9,
    now: NOW,
  })).toEqual({ action: "continue" })
})

test("gives up on a challenge that exhausted its time budget without a candidate", () => {
  const decision = decideGiveUp({
    challenge: challenge({ difficulty: "EASY" }),
    settings: settings({ deadline: NOW + 120 * 60_000 }),
    activeMs: 19 * 60_000,
    hasCandidate: false,
    yieldsWithoutProgress: 0,
    now: NOW,
  })
  expect(decision.action).toBe("give-up")
  expect(decision).toMatchObject({ reason: expect.stringContaining("时间预算") })
})

test("gives up during the endgame and when the submission cap is reached", () => {
  expect(decideGiveUp({
    challenge: challenge({ difficulty: "EASY" }),
    settings: settings({ deadline: NOW + 5 * 60_000 }),
    activeMs: 60_000,
    hasCandidate: false,
    yieldsWithoutProgress: 0,
    now: NOW,
  }).action).toBe("give-up")

  const capped = decideGiveUp({
    challenge: challenge({ difficulty: "EASY" }),
    settings: settings({ deadline: NOW + 120 * 60_000 }),
    activeMs: 60_000,
    hasCandidate: false,
    yieldsWithoutProgress: 0,
    submissions: 15,
    maxSubmissions: 15,
    now: NOW,
  })
  expect(capped.action).toBe("give-up")
  expect(capped).toMatchObject({ reason: expect.stringContaining("爆破") })
})

test("deprioritizes rather than abandons a challenge that merely stalled", () => {
  const decision = decideGiveUp({
    challenge: challenge({ difficulty: "MEDIUM" }),
    settings: settings({ deadline: NOW + 120 * 60_000 }),
    activeMs: 60_000,
    hasCandidate: false,
    yieldsWithoutProgress: 3,
    now: NOW,
  })
  expect(decision.action).toBe("deprioritize")
})

test("admits work only within slot limits and outside the endgame", () => {
  const base = settings({ deadline: NOW + 120 * 60_000 })
  expect(canStart({ kind: "remote", usage: { local: 0, remote: 2 }, settings: base, now: NOW }).allowed).toBe(true)
  // The three-environment limit is a platform rule, not a tuning knob.
  const full = canStart({ kind: "remote", usage: { local: 0, remote: 3 }, settings: base, now: NOW })
  expect(full.allowed).toBe(false)
  expect(full.reason).toContain("3/3")

  expect(canStart({ kind: "local", usage: { local: 5, remote: 0 }, settings: base, now: NOW }).allowed).toBe(false)

  const endgame = settings({ deadline: NOW + 5 * 60_000 })
  expect(canStart({ kind: "local", usage: { local: 0, remote: 0 }, settings: endgame, now: NOW }).allowed).toBe(false)
  // Work that is finishing something already in hand is still allowed.
  expect(canStart({ kind: "local", usage: { local: 0, remote: 0 }, settings: endgame, finishing: true, now: NOW }).allowed)
    .toBe(true)
  expect(canStart({ kind: "local", usage: { local: 0, remote: 0 }, settings: settings({ deadline: NOW - 1 }), finishing: true, now: NOW }).allowed)
    .toBe(false)
})

test("environment pool never exceeds capacity and reuses a challenge's own lease", async () => {
  const recovered: string[] = []
  const pool = new EnvironmentPool(3, async (id) => { recovered.push(id) }, () => NOW)

  expect(pool.acquire("a", "1")).toBeDefined()
  expect(pool.acquire("b", "2")).toBeDefined()
  expect(pool.acquire("c", "3")).toBeDefined()
  // A fourth challenge must wait rather than exceed the platform limit.
  expect(pool.acquire("d", "4")).toBeUndefined()
  // Re-acquiring for a challenge already holding a lease must not consume a second slot.
  expect(pool.acquire("a", "1")).toBeDefined()
  expect(pool.size).toBe(3)

  await pool.release("a")
  expect(recovered).toEqual(["1"])
  expect(pool.acquire("d", "4")).toBeDefined()
})

test("releasing is idempotent and frees the slot even when recovery fails", async () => {
  let calls = 0
  const pool = new EnvironmentPool(1, async () => {
    calls += 1
    throw new Error("platform unreachable")
  }, () => NOW)

  pool.acquire("a", "1")
  const first = await pool.release("a")
  // Losing track of the remote environment must not strand the local slot forever.
  expect(first.released).toBe(true)
  expect(first.error?.message).toContain("platform unreachable")
  expect(pool.size).toBe(0)

  // A second release, e.g. from a finally block, is a no-op rather than a double recovery.
  const second = await pool.release("a")
  expect(second.released).toBe(false)
  expect(calls).toBe(1)
  expect(pool.acquire("b", "2")).toBeDefined()
})

test("treats an environment near its expiry as expired", () => {
  let now = NOW
  const pool = new EnvironmentPool(3, async () => {}, () => now)
  pool.acquire("a", "1")
  // Without a reported expiry the lease is simply live.
  expect(pool.expired("a")).toBe(false)
  pool.update("a", { remote: "1.2.3.4:80", expireTime: NOW + 10 * 60_000 })
  expect(pool.expired("a")).toBe(false)
  expect(pool.held("a")?.remote).toBe("1.2.3.4:80")
  // Inside the safety margin it must be refreshed rather than handed to a solver.
  now = NOW + 10 * 60_000 - 30_000
  expect(pool.expired("a")).toBe(true)
  expect(pool.expired("missing")).toBe(true)
})

test("submission gate blocks duplicates, respects the cap, and compares unwrapped values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-comp-"))
  roots.push(root)

  let ledger = await loadSubmissionLedger(root, "shopping")
  expect(ledger.attempts).toEqual([])

  const first = gateSubmission({ ledger, candidate: "DASCTF{abc}", maxSubmissions: 3 })
  expect(first).toEqual({ allowed: true, value: "abc" })

  ledger = recordAttempt(ledger, { value: "abc", verdict: "rejected", at: "2026-01-01T00:00:00.000Z" })
  // A wrapped and a bare form of the same flag are the same attempt.
  expect(gateSubmission({ ledger, candidate: "flag{abc}", maxSubmissions: 3 }).allowed).toBe(false)
  expect(gateSubmission({ ledger, candidate: "abc", maxSubmissions: 3 }).allowed).toBe(false)
  expect(gateSubmission({ ledger, candidate: "", maxSubmissions: 3 }).allowed).toBe(false)

  ledger = recordAttempt(ledger, { value: "def", verdict: "pending", at: "2026-01-01T00:01:00.000Z" })
  ledger = recordAttempt(ledger, { value: "ghi", verdict: "rejected", at: "2026-01-01T00:02:00.000Z" })
  const capped = gateSubmission({ ledger, candidate: "jkl", maxSubmissions: 3 })
  expect(capped.allowed).toBe(false)
  expect(capped).toMatchObject({ reason: expect.stringContaining("上限 3") })

  expect(rejectedValues(ledger)).toEqual(["abc", "ghi"])

  // The ledger survives a restart, so the cap cannot be reset by relaunching Boom.
  await saveSubmissionLedger(root, ledger)
  const reloaded = await loadSubmissionLedger(root, "shopping")
  expect(reloaded.attempts).toHaveLength(3)
  expect(gateSubmission({ ledger: reloaded, candidate: "jkl", maxSubmissions: 3 }).allowed).toBe(false)
})

test("stops submitting once a flag was accepted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-comp-"))
  roots.push(root)
  const ledger = recordAttempt(await loadSubmissionLedger(root, "one"), {
    value: "win",
    verdict: "accepted",
    at: "2026-01-01T00:00:00.000Z",
  })
  const gate = gateSubmission({ ledger, candidate: "another", maxSubmissions: 15 })
  expect(gate.allowed).toBe(false)
  expect(gate).toMatchObject({ reason: expect.stringContaining("已有被平台接受") })
})

test("concurrent first adapter loads share one construction instead of a fake undefined", async () => {
  const previousHome = process.env.BOOM_HOME
  const previousKey = process.env.BOOM_DASCTF_ACCESS_KEY
  const home = await mkdtemp(path.join(os.tmpdir(), "boom-adapter-cache-"))
  roots.push(home)
  process.env.BOOM_HOME = home
  process.env.BOOM_DASCTF_ACCESS_KEY = "adapter-cache-fixture"
  try {
    clearCompetitionAdapterCache()
    // Both calls start in the same tick, i.e. inside the await window of the first load.
    const [first, second] = await Promise.all([loadCompetitionAdapter(), loadCompetitionAdapter()])

    // One shared promise means the factory ran exactly once and both awaiters observe it.
    expect(first).toBeInstanceOf(DasctfPlatformAdapter)
    expect(second).toBe(first)

    clearCompetitionAdapterCache()
    const recreated = await loadCompetitionAdapter()
    expect(recreated).not.toBe(first)
  } finally {
    if (previousKey === undefined) delete process.env.BOOM_DASCTF_ACCESS_KEY
    else process.env.BOOM_DASCTF_ACCESS_KEY = previousKey
    if (previousHome === undefined) delete process.env.BOOM_HOME
    else process.env.BOOM_HOME = previousHome
    clearCompetitionAdapterCache()
  }
})
