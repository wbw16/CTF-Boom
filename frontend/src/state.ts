import type { ChallengeGui, GuiState, RunEvent, RunHistory, RunnerNotification } from "./types"

export type RunDetailSnapshot = {
  instanceID?: string
  slug: string
  run: RunHistory
  sequence?: number
}

export const CATEGORY_ORDER = [
  "WEB", "PWN", "REVERSE", "CRYPTO", "MISC", "MOBILE", "FORENSICS",
  "AI", "HARDWARE", "BLOCKCHAIN", "OSINT", "OTHER",
] as const

export const BUCKETS: Array<[string, string]> = [
  ["got", "待确认 Flag"],
  ["solved", "已确认归档"],
  ["attn", "需要处理"],
  ["running", "运行中"],
  ["queued", "未运行"],
  ["gaveup", "已放弃"],
  ["removed", "已移出批次"],
]

export const categoryOf = (challenge: ChallengeGui) =>
  (CATEGORY_ORDER as readonly string[]).includes(challenge.category) ? challenge.category : "OTHER"

export const last = (challenge?: ChallengeGui | null) =>
  challenge?.runs?.length ? challenge.runs[challenge.runs.length - 1] : undefined

export const isLive = (run?: RunHistory | null) =>
  run?.stop === "running" || run?.stop === "queued"

export const currentRun = (challenge?: ChallengeGui | null) =>
  [...(challenge?.runs ?? [])].reverse().find((run) => run.stop === "running") ??
  [...(challenge?.runs ?? [])].reverse().find((run) => run.stop === "queued") ??
  last(challenge)

export const isLegacyMissingRemoteBlock = (run?: RunHistory | null) =>
  run?.stop === "blocked" &&
  /(?:requires an external service|no reachable remote endpoint)/i.test(run.detail ?? "")

export const isRemoteURLBlocked = (run?: RunHistory | null) =>
  run?.stop === "blocked" &&
  /(?:requires an external service|no reachable remote endpoint|missing remote|服务地址)/i.test(run.detail ?? "")

export const confirmedRun = (challenge: ChallengeGui) =>
  [...challenge.runs].reverse().find(
    (run) => run.taskStatus === "archived" || run.confirmedFlag,
  )

export const candidateValues = (run?: RunHistory | null) =>
  [...new Set([
    run?.confirmedFlag,
    run?.acceptedFlag,
    run?.primaryCandidate,
    ...(run?.candidates ?? []),
    ...(run?.alternatives ?? []),
    ...(run?.candidateHistory ?? []),
  ].filter((value): value is string => typeof value === "string" && value.trim() !== ""))]

/**
 * Values that may still drive the UI's current-flag presentation. `candidateHistory` deliberately
 * remains excluded: it is an immutable audit trail and can contain flags the platform rejected.
 */
export const activeCandidateValues = (run?: RunHistory | null) => {
  const rejected = new Set(run?.rejectedFlags ?? [])
  return [...new Set([
    run?.confirmedFlag,
    run?.acceptedFlag,
    run?.primaryCandidate,
    ...(run?.candidates ?? []),
    ...(run?.alternatives ?? []),
  ].filter((value): value is string =>
    typeof value === "string" && value.trim() !== "" && !rejected.has(value)))]
}

export const primary = (run?: RunHistory | null) => activeCandidateValues(run)[0] ?? ""
export const alternatives = (run?: RunHistory | null) => activeCandidateValues(run).slice(1)

export const activeCandidate = (run?: RunHistory | null) => activeCandidateValues(run)[0] ?? ""

export const latestFlagRun = (challenge: ChallengeGui) =>
  [...challenge.runs].reverse().find((run) => activeCandidateValues(run).length > 0)

export const displayFlagRun = (challenge: ChallengeGui, preferred = currentRun(challenge)) => {
  const confirmed = confirmedRun(challenge)
  if (confirmed) return confirmed
  const accepted = [...challenge.runs].reverse().find((run) => !!run.acceptedFlag)
  if (accepted) return accepted
  const run = preferred
  return activeCandidateValues(run).length ? run : latestFlagRun(challenge)
}

export const flagEntries = (challenge: ChallengeGui, preferred = currentRun(challenge)) => {
  const newest = preferred
  const seen = new Set<string>()
  return [...challenge.runs].reverse().flatMap((run) =>
    candidateValues(run)
      .filter((value) => {
        if (seen.has(value)) return false
        seen.add(value)
        return true
      })
      .map((value) => ({ value, run, historical: run !== newest })),
  )
}

export const isRunnableChallenge = (challenge: ChallengeGui) =>
  !challenge.state &&
  !confirmedRun(challenge) &&
  !activeCandidate(currentRun(challenge)) &&
  !isLive(currentRun(challenge)) &&
  !(isRemoteURLBlocked(currentRun(challenge)) && !challenge.remote?.trim())

export const runnableChallenges = (challenges: ChallengeGui[], category?: string) =>
  challenges.filter(
    (challenge) =>
      (category === undefined || categoryOf(challenge) === category) &&
      isRunnableChallenge(challenge),
  )

export function formatRegex(source: string) {
  const value = source.trim()
  if (!value) return null
  try {
    return new RegExp(`^(?:${value})$`)
  } catch {
    return false
  }
}

export function formatMismatch(
  run: RunHistory | undefined | null,
  candidate = primary(run),
  flagFormat = "",
) {
  const regex = formatRegex(flagFormat)
  return !!(regex && candidate && !regex.test(candidate))
}

export function bucket(challenge: ChallengeGui, flagFormat = "") {
  if (challenge.state === "removed") return "removed"
  if (challenge.state === "given-up") return "gaveup"
  const run = currentRun(challenge)
  if (!run) return "queued"
  if (run.stop === "running" || run.stop === "queued") return "running"
  if (confirmedRun(challenge)) return "solved"
  if (run.taskStatus === "solved") return "attn"
  if (activeCandidate(run)) return formatMismatch(run, activeCandidate(run), flagFormat) ? "attn" : "got"
  return "attn"
}

const BUCKET_RANK = new Map(BUCKETS.map(([key], index) => [key, index]))

export function orderedChallenges(
  source: ChallengeGui[],
  flagFormat: string,
): ChallengeGui[] {
  return (CATEGORY_ORDER as readonly string[]).flatMap((category) =>
    source
      .filter((challenge) => categoryOf(challenge) === category)
      .sort((left, right) => {
        const leftRank = BUCKET_RANK.get(bucket(left, flagFormat)) ?? 99
        const rightRank = BUCKET_RANK.get(bucket(right, flagFormat)) ?? 99
        return leftRank - rightRank || left.slug.localeCompare(right.slug)
      }),
  )
}

export function label(challenge: ChallengeGui, flagFormat = "") {
  if (challenge.state === "given-up") return ["已放弃", "c-dim"] as const
  if (challenge.state === "removed") return ["已移出", "c-dim"] as const
  const run = currentRun(challenge)
  if (!run) return ["未运行", "c-dim"] as const
  if (run.stop === "queued") return ["排队中", "c-run"] as const
  if (run.stop === "running") return ["运行中", "c-run"] as const
  if (isLegacyMissingRemoteBlock(run)) return ["待继续", "c-warn"] as const
  if (isRemoteURLBlocked(run))
    return [challenge.remote?.trim() ? "待继续" : "等待服务地址", "c-warn"] as const
  if (confirmedRun(challenge)) return ["已归档", "c-ok"] as const
  if (run.taskStatus === "solved") return ["写作中", "c-warn"] as const
  if (activeCandidate(run))
    return [formatMismatch(run, activeCandidate(run), flagFormat) ? "格式不符" : "待确认", "c-warn"] as const
  return (
    {
      budget: ["超预算", "c-warn"],
      stalled: ["卡死", "c-warn"],
      timeout: ["超时", "c-warn"],
      error: ["错误", "c-err"],
      empty: ["空响应", "c-warn"],
      aborted: ["已停止", "c-dim"],
      interrupted: ["曾中断", "c-warn"],
      completed: ["无结果", "c-dim"],
    } as Record<string, readonly [string, string]>
  )[run.stop] ?? [run.stop || "无结果", "c-dim"]
}

export function why(challenge: ChallengeGui, flagFormat = "") {
  const run = currentRun(challenge)
  if (!run) return challenge.state ? "—" : "尚未运行"
  if (run.stop === "queued") return "等待运行槽位"
  if (run.stop === "running") return run.lastTool || "正在分析"
  if (isLegacyMissingRemoteBlock(run)) return "旧版本因未填服务地址提前停止；现在可直接继续本地分析"
  if (isRemoteURLBlocked(run))
    return challenge.remote?.trim()
      ? "服务地址已填写，点击继续任务"
      : "本地分析已完成，请填写服务地址后再继续"
  if (activeCandidate(run) && formatMismatch(run, activeCandidate(run), flagFormat))
    return `${primary(run)} 不符合你设定的格式`
  if (run.detail) return run.detail.split("\n")[0] ?? ""
  if (activeCandidate(run)) return run.verification?.detail || run.reply || "已得到候选 flag"
  return run.reply || "未得到 flag"
}

export function matches(challenge: ChallengeGui, filter: string) {
  if (!filter) return true
  const query = filter.toLowerCase()
  const haystack = [
    challenge.slug,
    challenge.category,
    challenge.difficulty,
    challenge.description,
    ...challenge.runs.flatMap((run) => [
      ...candidateValues(run),
      run.detail,
      run.reply,
      run.lastTool,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return haystack.includes(query)
}

export function flagHistoryStatus(entry: { run: RunHistory; value: string }) {
  if (entry.run.acceptedFlag === entry.value || entry.run.confirmedFlag === entry.value)
    return ["已确认", "ok"] as const
  if (entry.run.rejectedFlags?.includes(entry.value)) return ["已否定", "rejected"] as const
  return ["待确认", ""] as const
}

export function isUnconfirmedFlag(entry: { run: RunHistory; value: string }) {
  return (
    entry.run.acceptedFlag !== entry.value &&
    entry.run.confirmedFlag !== entry.value &&
    !entry.run.rejectedFlags?.includes(entry.value)
  )
}

function runEventKey(event: RunEvent) {
  return JSON.stringify([
    event.at,
    event.type,
    event.status ?? null,
    event.tool ?? null,
    event.text ?? null,
    event.tokens ?? null,
    event.billable ?? null,
    event.cost ?? null,
  ])
}

export function mergeRunEvents(...sources: Array<RunEvent[] | undefined>) {
  const seen = new Set<string>()
  return sources
    .flatMap((events) => events ?? [])
    .filter((event) => {
      const key = runEventKey(event)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => left.at - right.at)
}

export function applyEventToRun(run: RunHistory, event: RunEvent): RunHistory {
  const duplicate = run.events.some((item) => runEventKey(item) === runEventKey(event))
  const tokens = event.tokens ?? run.tokens
  const billableTokens = event.billable ?? run.billableTokens
  const cost = event.cost ?? run.cost
  const lastTool = event.tool ?? run.lastTool
  if (
    duplicate &&
    tokens === run.tokens &&
    billableTokens === run.billableTokens &&
    cost === run.cost &&
    lastTool === run.lastTool
  ) return run
  return {
    ...run,
    events: duplicate ? run.events : [...run.events, event],
    tokens,
    billableTokens,
    cost,
    ...(lastTool ? { lastTool } : {}),
  }
}

export function mergeRunEventState(
  authoritative: RunHistory,
  ...liveSources: Array<RunHistory | null | undefined>
): RunHistory {
  const matching = liveSources.filter(
    (run): run is RunHistory => !!run && run.id === authoritative.id,
  )
  const authoritativeKeys = new Set(authoritative.events.map(runEventKey))
  const latestAuthoritativeAt = authoritative.events.reduce(
    (latest, event) => Math.max(latest, event.at),
    Number.NEGATIVE_INFINITY,
  )
  const liveEvents = matching.flatMap((run) => run.events).sort((left, right) => left.at - right.at)
  let merged = authoritative
  for (const event of liveEvents) {
    if (!authoritativeKeys.has(runEventKey(event)) && event.at >= latestAuthoritativeAt)
      merged = applyEventToRun(merged, event)
  }
  merged = {
    ...merged,
    events: mergeRunEvents(authoritative.events, ...matching.map((run) => run.events)),
  }
  return merged
}

export function mergeRunDetail(
  authoritative: RunHistory,
  ...newerSummaries: Array<RunHistory | null | undefined>
): RunHistory {
  const matching = newerSummaries.filter(
    (run): run is RunHistory => !!run && run.id === authoritative.id,
  )
  const merged = mergeRunEventState(authoritative, ...matching)
  const summary = matching[matching.length - 1]
  return summary
    ? {
        ...merged,
        model: summary.model,
        runtimeBackend: summary.runtimeBackend,
        runtimeVersion: summary.runtimeVersion,
        promptVersion: summary.promptVersion,
        stop: summary.stop,
        tokens: summary.tokens,
        billableTokens: summary.billableTokens,
        cost: summary.cost,
        candidates: summary.candidates,
        primaryCandidate: summary.primaryCandidate,
        alternatives: summary.alternatives,
        candidateSource: summary.candidateSource,
        verification: summary.verification,
        platformSubmission: summary.platformSubmission,
        flagFormat: summary.flagFormat,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        durationMs: summary.durationMs,
        lastTool: summary.lastTool ?? merged.lastTool,
        detail: summary.detail ?? merged.detail,
        taskStatus: summary.taskStatus,
        candidateHistory: summary.candidateHistory,
        rejectedFlags: summary.rejectedFlags,
        confirmedFlag: summary.confirmedFlag,
        acceptedFlag: summary.acceptedFlag,
        environment: summary.environment,
      }
    : merged
}

export function withRunDetail(challenge: ChallengeGui, detail?: RunHistory | null): ChallengeGui {
  if (!detail || !challenge.runs.some((run) => run.id === detail.id)) return challenge
  return {
    ...challenge,
    runs: challenge.runs.map((run) => run.id === detail.id ? detail : run),
  }
}

export function resolveRunDetail(
  data: GuiState | null,
  selected: string,
  detail: RunDetailSnapshot | null,
) {
  if (!detail || detail.slug !== selected) return null
  const summary = data?.challenges
    .find((challenge) => challenge.slug === selected)?.runs
    .find((run) => run.id === detail.run.id)
  return summary && data?.instanceID === detail.instanceID && (data?.sequence ?? -1) > (detail.sequence ?? -1)
    ? mergeRunDetail(detail.run, summary)
    : detail.run
}

export function applyRunEventToDetail(
  detail: RunDetailSnapshot | null,
  update: { sequence?: number; slug?: string; runID?: string; event?: RunEvent },
) {
  if (
    !detail ||
    !update.slug ||
    !update.runID ||
    !update.event ||
    detail.slug !== update.slug ||
    detail.run.id !== update.runID
  ) return detail
  const run = applyEventToRun(detail.run, update.event)
  return run === detail.run ? detail : { ...detail, run }
}

export function shouldRevalidateRunDetail(event?: RunEvent) {
  if (!event) return false
  if (event.type === "tool") return event.status !== "running" && event.status !== "pending"
  return event.status === "consultation" ||
    event.status?.startsWith("consultation.") === true ||
    event.status?.startsWith("candidate.") === true
}

export function applyRunnerNotification(
  data: GuiState | null,
  detail: RunDetailSnapshot | null,
  selected: string,
  update: RunnerNotification,
) {
  const challenge = data?.challenges.find((item) => item.slug === update.slug)
  const dataTargetKnown = !!challenge && !!update.event &&
    challenge.runs.some((run) => run.id === update.runID)
  const detailTargetKnown = !!detail && !!update.event && detail.slug === update.slug && detail.run.id === update.runID
  const nextData = data && update.slug && update.event ? applyRunEvent(data, update) : data
  const nextDetail = update.slug && update.event
    ? applyRunEventToDetail(detail, update)
    : detail
  const handled = nextData !== data || nextDetail !== detail || dataTargetKnown || detailTargetKnown
  const revalidate = update.type === "run.event" && handled
    ? update.slug === selected && shouldRevalidateRunDetail(update.event)
      ? "detail" as const
      : "none" as const
    : "state" as const
  return { data: nextData, detail: nextDetail, revalidate }
}

export function applyRunEvent(
  data: GuiState,
  update: { sequence?: number; slug?: string; runID?: string; event?: RunEvent },
) {
  if (!update.slug || !update.event) return data
  const challenge = data.challenges.find((item) => item.slug === update.slug)
  if (!challenge) return data
  const run = challenge.runs.find((item) => item.id === update.runID)
  if (!run) return data
  const nextRun = applyEventToRun(run, update.event)
  if (nextRun === run) return data
  const nextChallenge: ChallengeGui = {
    ...challenge,
    runs: challenge.runs.map((item) => (item.id === nextRun.id ? nextRun : item)),
  }
  return {
    ...data,
    challenges: data.challenges.map((item) => (item.slug === nextChallenge.slug ? nextChallenge : item)),
  }
}
