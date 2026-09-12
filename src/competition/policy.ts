import type { Challenge } from "../challenge.ts"

/**
 * Competition scheduling policy: a short timed match with a few concurrent remote environments.
 *
 * Everything here is a pure decision function so the scheduling rules can be tested without a
 * runtime, a platform, or a clock. The runner owns the side effects; this module owns the judgement.
 *
 * The defaults encode a 3-hour agent-style CTF (three concurrent target environments, batched
 * challenge releases); see docs/PLATFORMS.md for how a platform adapter relates to these knobs.
 */

/** Default remote slots; agent CTF platforms typically allow only three concurrent targets. */
export const DEFAULT_REMOTE_SLOTS = 3

/**
 * Local solve concurrency. Bounded by this machine's CPU/memory rather than by any platform rule,
 * because reversing, brute-forcing and container work are the real constraint.
 */
export const DEFAULT_LOCAL_SLOTS = 5

export const DEFAULT_MATCH_MINUTES = 180

/** Default catalog refresh cadence for the contest's batched releases. */
export const DEFAULT_REFRESH_INTERVAL_MINUTES = 10

/**
 * Once this little time remains, stop opening new challenges and spend what is left finishing work
 * that already has something to show. Scores decay as more teams solve a challenge, so a late start
 * is worth far less than converting an existing near-miss.
 */
export const DEFAULT_ENDGAME_MINUTES = 20

/**
 * Per-challenge wall-clock ceilings. A 3-hour match allows roughly one pass over the challenge set,
 * so a challenge that resists this long is costing more than the next untouched one is worth.
 */
export const DIFFICULTY_BUDGET_MINUTES: Record<string, number> = {
  VERY_EASY: 12,
  EASY: 18,
  MEDIUM: 28,
  HARD: 35,
  VERY_HARD: 35,
}

export const DEFAULT_CHALLENGE_BUDGET_MINUTES = 25

/** Ordering of the platform's difficulty labels; lower solves faster and is worth attempting first. */
const DIFFICULTY_RANK: Record<string, number> = {
  VERY_EASY: 0,
  EASY: 1,
  MEDIUM: 2,
  HARD: 3,
  VERY_HARD: 4,
}

export type CompetitionSettings = {
  /** Adapter id of the competition platform this root syncs challenges from. */
  platformId?: string
  remoteSlots: number
  /** How often unattended mode checks the platform for newly released challenges. */
  refreshIntervalMinutes?: number
  localSlots: number
  matchMinutes: number
  endgameMinutes: number
  /** Epoch ms when the match ends; absent until the operator starts the clock. */
  deadline?: number
  /** Persisted intent to resume unattended catalog polling when the desktop server restarts. */
  autopilotEnabled?: boolean
}

export const DEFAULT_COMPETITION_SETTINGS: CompetitionSettings = {
  remoteSlots: DEFAULT_REMOTE_SLOTS,
  refreshIntervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
  localSlots: DEFAULT_LOCAL_SLOTS,
  matchMinutes: DEFAULT_MATCH_MINUTES,
  endgameMinutes: DEFAULT_ENDGAME_MINUTES,
  autopilotEnabled: false,
}

export function normalizeCompetitionSettings(
  value: unknown,
  fallback: CompetitionSettings = DEFAULT_COMPETITION_SETTINGS,
): CompetitionSettings {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const positive = (candidate: unknown, base: number, maximum: number) => {
    const parsed = typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.floor(candidate)
      : Number.NaN
    if (!Number.isFinite(parsed) || parsed < 1) return base
    return Math.min(maximum, parsed)
  }
  const deadline = typeof input.deadline === "number" && Number.isFinite(input.deadline) && input.deadline > 0
    ? Math.floor(input.deadline)
    : undefined
  const platformId = typeof input.platformId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(input.platformId)
    ? input.platformId
    : undefined
  return {
    ...(platformId === undefined ? {} : { platformId }),
    // The default platform permits at most three target environments. Operators may intentionally
    // use fewer slots, but a higher value would only turn into rejected API requests.
    remoteSlots: positive(input.remoteSlots, fallback.remoteSlots, DEFAULT_REMOTE_SLOTS),
    refreshIntervalMinutes: positive(
      input.refreshIntervalMinutes,
      fallback.refreshIntervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES,
      60,
    ),
    localSlots: positive(input.localSlots, fallback.localSlots, 32),
    matchMinutes: positive(input.matchMinutes, fallback.matchMinutes, 24 * 60),
    endgameMinutes: positive(input.endgameMinutes, fallback.endgameMinutes, 120),
    autopilotEnabled:
      typeof input.autopilotEnabled === "boolean"
        ? input.autopilotEnabled
        : fallback.autopilotEnabled === true,
    ...(deadline === undefined ? {} : { deadline }),
  }
}

/** Which resource a challenge consumes while being solved. */
export type SlotKind = "local" | "remote"

/**
 * A challenge needs a remote slot only for the phase that actually talks to the target. Attachment
 * and source analysis, including exploit development, runs without one. `endpointType: "none"`
 * challenges never need a slot at all.
 */
export function slotKindFor(challenge: Pick<Challenge, "serviceRequired" | "remote">): SlotKind {
  return challenge.serviceRequired === true || Boolean(challenge.remote?.trim()) ? "remote" : "local"
}

export type MatchClock = {
  /** Whether the match clock has been started. */
  started: boolean
  remainingMs: number
  elapsedMs: number
  /** True once only the endgame window remains: finish work, do not start new challenges. */
  endgame: boolean
  /** True once the match is over: nothing further may be submitted. */
  over: boolean
}

export function matchClock(settings: CompetitionSettings, now: number): MatchClock {
  if (settings.deadline === undefined)
    return {
      started: false,
      remainingMs: settings.matchMinutes * 60_000,
      elapsedMs: 0,
      endgame: false,
      over: false,
    }
  const remainingMs = settings.deadline - now
  const totalMs = settings.matchMinutes * 60_000
  return {
    started: true,
    remainingMs: Math.max(0, remainingMs),
    elapsedMs: Math.max(0, totalMs - Math.max(0, remainingMs)),
    endgame: remainingMs <= settings.endgameMinutes * 60_000,
    over: remainingMs <= 0,
  }
}

export type PriorityInput = {
  challenge: Pick<Challenge, "slug" | "category" | "difficulty" | "serviceRequired" | "remote">
  /** Platform points, from the challenge's persisted platform options. */
  score?: number
  /** Turns already spent on this challenge. */
  attempts?: number
  /** Wall-clock already spent solving this challenge. */
  activeMs?: number
  /** Whether any durable progress has been recorded. */
  progressed?: boolean
}

/**
 * Rank a challenge for scheduling. Lower sorts earlier.
 *
 * The ordering reflects what maximizes score in a short match: a locally solvable challenge is free
 * to start, easy challenges convert fastest, and points break ties. Work that has already consumed
 * time without progress is pushed back so an untouched challenge — whose expected value is much
 * higher — gets the resource instead.
 */
export function priorityOf(input: PriorityInput, now = Date.now()): number {
  void now
  const kind = slotKindFor(input.challenge)
  const difficulty = input.challenge.difficulty?.trim().toUpperCase().replace(/[\s-]+/g, "_")
  const difficultyRank = difficulty !== undefined && difficulty in DIFFICULTY_RANK
    ? DIFFICULTY_RANK[difficulty]!
    : 2
  // A local challenge starts without competing for one of the three scarce environments.
  const local = kind === "local" ? 0 : 1_000
  const byDifficulty = difficultyRank * 100
  // Higher score sorts earlier; scale keeps it subordinate to difficulty.
  const byScore = -Math.min(500, Math.max(0, input.score ?? 0)) / 10
  const attempts = Math.max(0, input.attempts ?? 0)
  // Sunk time without durable progress is a demotion, not a reason to keep going.
  const stagnation = input.progressed === false || input.progressed === undefined
    ? attempts * 60
    : attempts * 15
  const spentMinutes = Math.floor(Math.max(0, input.activeMs ?? 0) / 60_000)
  return local + byDifficulty + byScore + stagnation + spentMinutes
}

/** Sort challenges into the order the scheduler should attempt them. */
export function prioritize<T extends PriorityInput>(items: T[], now = Date.now()): T[] {
  return [...items].sort((left, right) => {
    const difference = priorityOf(left, now) - priorityOf(right, now)
    if (difference !== 0) return difference
    return left.challenge.slug.localeCompare(right.challenge.slug)
  })
}

export function challengeBudgetMs(
  challenge: Pick<Challenge, "difficulty">,
  settings: CompetitionSettings,
  now = Date.now(),
) {
  const difficulty = challenge.difficulty?.trim().toUpperCase().replace(/[\s-]+/g, "_")
  const minutes = difficulty !== undefined && difficulty in DIFFICULTY_BUDGET_MINUTES
    ? DIFFICULTY_BUDGET_MINUTES[difficulty]!
    : DEFAULT_CHALLENGE_BUDGET_MINUTES
  const budget = minutes * 60_000
  const clock = matchClock(settings, now)
  // Never plan past the end of the match.
  return clock.started ? Math.max(60_000, Math.min(budget, clock.remainingMs)) : budget
}

export type GiveUpInput = {
  challenge: Pick<Challenge, "slug" | "difficulty">
  settings: CompetitionSettings
  /** Wall-clock already spent solving this challenge. */
  activeMs: number
  /** Whether a candidate flag exists; a challenge with one is never abandoned. */
  hasCandidate: boolean
  /** Consecutive turns that produced no durable progress. */
  yieldsWithoutProgress: number
  /** Submissions already sent for this challenge. */
  submissions?: number
  maxSubmissions?: number
  now?: number
}

export type GiveUpDecision =
  | { action: "continue" }
  | { action: "give-up"; reason: string }
  | { action: "deprioritize"; reason: string }

/**
 * Decide whether to keep spending the match clock on a challenge.
 *
 * A challenge holding a candidate is never abandoned, because submitting it costs almost nothing and
 * a wrong flag carries no time penalty in this competition. Otherwise the ceiling is the point at
 * which an untouched challenge is the better investment.
 */
export function decideGiveUp(input: GiveUpInput): GiveUpDecision {
  const now = input.now ?? Date.now()
  const clock = matchClock(input.settings, now)
  if (input.hasCandidate) return { action: "continue" }

  // Match-only time allocation must not become a hidden ceiling for ordinary projects. Until an
  // operator starts the competition clock, the general runner's own budget/autonomy mode decides.
  if (!clock.started) return { action: "continue" }

  if (clock.over)
    return { action: "give-up", reason: "比赛已结束" }

  const submissions = input.submissions ?? 0
  const maxSubmissions = input.maxSubmissions ?? Number.POSITIVE_INFINITY
  if (submissions >= maxSubmissions)
    return {
      action: "give-up",
      reason: `已达到该题提交次数上限 ${maxSubmissions}，停止继续尝试以避免被判定为爆破`,
    }

  const budget = challengeBudgetMs(input.challenge, input.settings, now)
  if (input.activeMs >= budget)
    return {
      action: "give-up",
      reason: `已用满该题时间预算 ${Math.round(budget / 60_000)} 分钟且没有候选 flag，转向其他题目`,
    }

  // During the endgame a challenge with nothing to show is not worth a slot.
  if (clock.endgame)
    return {
      action: "give-up",
      reason: "已进入收尾阶段且该题没有候选 flag，让出资源用于收束已有结果",
    }

  if (input.yieldsWithoutProgress >= 3)
    return {
      action: "deprioritize",
      reason: `连续 ${input.yieldsWithoutProgress} 轮没有实质进展，降低优先级让未尝试的题目先获得资源`,
    }

  return { action: "continue" }
}

export type SlotUsage = { local: number; remote: number }

/**
 * Whether a challenge may start now, given current slot usage and the match clock.
 *
 * The remote cap is a platform rule, so exceeding it is not a tuning question: the platform would
 * reject the environment request.
 */
export function canStart(input: {
  kind: SlotKind
  usage: SlotUsage
  settings: CompetitionSettings
  /** A challenge that already has work to finish may still run during the endgame. */
  finishing?: boolean
  now?: number
}): { allowed: boolean; reason?: string } {
  const clock = matchClock(input.settings, input.now ?? Date.now())
  if (clock.over) return { allowed: false, reason: "比赛已结束" }
  if (clock.endgame && !input.finishing)
    return { allowed: false, reason: "已进入收尾阶段，不再启动新题目" }
  const limit = input.kind === "remote" ? input.settings.remoteSlots : input.settings.localSlots
  const used = input.kind === "remote" ? input.usage.remote : input.usage.local
  if (used >= limit)
    return {
      allowed: false,
      reason: input.kind === "remote"
        ? `已占用 ${used}/${limit} 个线上环境槽位，等待回收后再启动`
        : `本地并发已达 ${used}/${limit}，等待空闲后再启动`,
    }
  return { allowed: true }
}
