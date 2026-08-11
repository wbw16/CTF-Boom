import type { ChallengeGui, GuiState, RunEvent, RunHistory } from "./types"

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

export const isLegacyMissingRemoteBlock = (run?: RunHistory | null) =>
  run?.stop === "blocked" &&
  /(?:requires an external service|no reachable remote endpoint|missing remote)/i.test(run.detail ?? "")

export const confirmedRun = (challenge: ChallengeGui) =>
  [...challenge.runs].reverse().find(
    (run) => run.taskStatus === "archived" || run.confirmedFlag,
  )

export const candidateValues = (run?: RunHistory | null) =>
  [
    run?.primaryCandidate,
    ...(run?.candidates ?? []),
    ...(run?.alternatives ?? []),
    ...(run?.candidateHistory ?? []),
    run?.acceptedFlag,
  ].filter((value): value is string => typeof value === "string" && value.trim() !== "")

export const primary = (run?: RunHistory | null) => candidateValues(run)[0] ?? ""
export const alternatives = (run?: RunHistory | null) => candidateValues(run).slice(1)

export const activeCandidate = (run?: RunHistory | null) => run?.primaryCandidate || run?.candidates?.[0] || ""

export const latestFlagRun = (challenge: ChallengeGui) =>
  [...challenge.runs].reverse().find((run) => candidateValues(run).length > 0)

export const displayFlagRun = (challenge: ChallengeGui) => {
  const run = last(challenge)
  return candidateValues(run).length ? run : latestFlagRun(challenge)
}

export const flagEntries = (challenge: ChallengeGui) => {
  const newest = last(challenge)
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
  !activeCandidate(last(challenge)) &&
  !isLive(last(challenge))

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
  const run = last(challenge)
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
  const run = last(challenge)
  if (!run) return ["未运行", "c-dim"] as const
  if (run.stop === "queued") return ["排队中", "c-run"] as const
  if (run.stop === "running") return ["运行中", "c-run"] as const
  if (isLegacyMissingRemoteBlock(run)) return ["待继续", "c-warn"] as const
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
  const run = last(challenge)
  if (!run) return challenge.state ? "—" : "尚未运行"
  if (run.stop === "queued") return "等待运行槽位"
  if (run.stop === "running") return run.lastTool || "正在分析"
  if (isLegacyMissingRemoteBlock(run)) return "旧版本因未填服务地址提前停止；现在可直接继续本地分析"
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

export function applyRunEvent(data: GuiState, update: { slug?: string; runID?: string; event?: RunEvent }) {
  if (!update.slug || !update.event) return data
  const challenge = data.challenges.find((item) => item.slug === update.slug)
  if (!challenge) return data
  const run =
    challenge.runs.find((item) => item.id === update.runID) ??
    [...challenge.runs].reverse().find((item) => item.stop === "running" || item.stop === "queued")
  if (!run) return data
  const event = update.event
  const duplicate = run.events.some(
    (item) =>
      item.at === event.at &&
      item.type === event.type &&
      item.status === event.status &&
      item.tool === event.tool &&
      item.text === event.text,
  )
  const nextRun: RunHistory = {
    ...run,
    events: duplicate ? run.events : [...run.events, event],
    ...(event.tokens != null ? { tokens: event.tokens } : {}),
    ...(event.billable != null ? { billableTokens: event.billable } : {}),
    ...(event.cost != null ? { cost: event.cost } : {}),
    ...(event.tool ? { lastTool: event.tool } : {}),
  }
  const nextChallenge: ChallengeGui = {
    ...challenge,
    runs: challenge.runs.map((item) => (item.id === nextRun.id ? nextRun : item)),
  }
  return {
    ...data,
    challenges: data.challenges.map((item) => (item.slug === nextChallenge.slug ? nextChallenge : item)),
  }
}
