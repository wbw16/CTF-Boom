import { readFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { discoverChallenges, loadAnswers } from "./challenge.ts"
import { readChallengeRuns, taskDirectoryFromRoot } from "./history.ts"
import { parseExperiment, type ExperimentConditions } from "./experiment.ts"

export type EvaluationVariant = "autonomy-l0" | "autonomy-escalated" | "consultation" | "single-model" |
  "v1-consultation" | "v2-mode-a" | "v2-full" | "automatic-recovery"

export type EvaluationSample = {
  variant: EvaluationVariant
  group: string
  runID: string
  slug: string
  category: string
  model: string
  experiment?: string
  conditions?: ExperimentConditions
  trial?: number
  comparisonKey?: string
  correct?: boolean
  scoringSource?: "answer" | "accepted-verdict"
  candidateCount: number
  judgedCandidates: number
  wrongCandidates: number
  firstToolMs?: number
  firstCorrectCandidateMs?: number
  activeSolveMs: number
  failure?: "runtime" | "prerequisite" | "budget" | "no-candidate"
  tokens: number
  cost: number
}

export type EvaluationSummary = {
  group: string
  runs: number
  scored: number
  successes: number
  successRate?: number
  judgedCandidates: number
  wrongCandidates: number
  wrongCandidateRate?: number
  medianFirstToolMs?: number
  medianFirstCorrectCandidateMs?: number
  medianActiveSolveMs?: number
  runtimeFailures: number
  tokens: number
  cost: number
  costPerSuccess?: number
}

function median(values: number[]) {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function aggregateEvaluation(samples: EvaluationSample[]): EvaluationSummary[] {
  return [...new Set(samples.map((item) => item.group))].sort().map((group) => {
    const rows = samples.filter((item) => item.group === group)
    const scored = rows.filter((item) => item.correct !== undefined)
    const successes = scored.filter((item) => item.correct).length
    const judgedCandidates = rows.reduce((sum, item) => sum + item.judgedCandidates, 0)
    const wrongCandidates = rows.reduce((sum, item) => sum + item.wrongCandidates, 0)
    const cost = rows.reduce((sum, item) => sum + item.cost, 0)
    return {
      group, runs: rows.length, scored: scored.length, successes,
      successRate: scored.length ? successes / scored.length : undefined,
      judgedCandidates, wrongCandidates,
      wrongCandidateRate: judgedCandidates ? wrongCandidates / judgedCandidates : undefined,
      medianFirstToolMs: median(rows.flatMap((item) => item.firstToolMs ?? [])),
      medianFirstCorrectCandidateMs: median(rows.flatMap((item) => item.firstCorrectCandidateMs ?? [])),
      medianActiveSolveMs: median(rows.map((item) => item.activeSolveMs)),
      runtimeFailures: rows.filter((item) => item.failure === "runtime").length,
      tokens: rows.reduce((sum, item) => sum + item.tokens, 0), cost,
      costPerSuccess: scored.length === rows.length && successes ? cost / successes : undefined,
    }
  })
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function variant(result: Record<string, unknown>): EvaluationVariant {
  const variants = ["autonomy-l0", "autonomy-escalated", "consultation", "single-model", "v1-consultation", "v2-mode-a", "v2-full", "automatic-recovery"]
  if (variants.includes(String(result.orchestration_variant))) return result.orchestration_variant as EvaluationVariant
  if (result.consultation) return "v1-consultation"
  if (Array.isArray(result.branches) && result.branches.length) return "v2-full"
  if (result.checkpoint) return "v2-mode-a"
  return "single-model"
}

export async function collectEvaluationSamples(root: string, options: { label?: string; slugs?: string[] } = {}) {
  const answers = await loadAnswers(root)
  const samples: EvaluationSample[] = []
  for (const challenge of await discoverChallenges(root)) {
    if (options.slugs && !options.slugs.includes(challenge.slug)) continue
    for (const run of await readChallengeRuns(root, challenge.slug)) {
      const directory = await taskDirectoryFromRoot(root, challenge.slug, run.id)
      const raw = await readFile(path.join(directory, "result.json"), "utf8").catch(() => undefined)
      if (!raw) continue
      let result: Record<string, unknown>
      try { result = object(JSON.parse(raw)) } catch { continue }
      const experiment = parseExperiment(result.experiment)
      const label = experiment?.label
      if (options.label && label !== options.label) continue
      const trial = experiment?.trial
      const limits = object(result.experiment_limits ?? result.limits)
      const policy = object(result.model_policy)
      const configuration = experiment?.conditions
      const model = configuration?.model ?? run.model
      const commonConfiguration = configuration ? { ...configuration, inputFingerprint: undefined } : undefined
      const conditions = JSON.stringify(commonConfiguration ?? [model, policy.economy, policy.strong, limits.tokens,
        limits.timeout_ms, limits.repeats, result.execution_mode, result.environment_fingerprint])
      const conditionID = createHash("sha256").update(conditions).digest("hex").slice(0, 12)
      const attempts = run.turns?.flatMap((turn) => turn.purpose === "writeup" ? [] :
        turn.primaryCandidate ? [turn.primaryCandidate] : turn.candidates) ?? run.candidateHistory ?? run.candidates
      const candidates = run.candidateHistory ?? run.candidates
      const answer = answers.get(challenge.slug)
      const accepted = run.acceptedFlag ?? run.confirmedFlag
      const correct = answer !== undefined ? candidates.includes(answer) : accepted ? true : undefined
      const judged = attempts.filter((candidate) => answer !== undefined || candidate === accepted || run.rejectedFlags?.includes(candidate))
      const wrong = judged.filter((candidate) => answer !== undefined ? candidate !== answer : candidate !== accepted)
      const firstTool = run.events.find((event) => event.type === "tool" && event.status === "completed")
      const start = run.startedAt ? Date.parse(run.startedAt) : undefined
      const correctFlag = answer ?? accepted
      const correctTurn = correctFlag ? run.turns?.find((turn) => turn.purpose !== "writeup" &&
        (turn.primaryCandidate === correctFlag || turn.candidates.includes(correctFlag))) : undefined
      const activeSolveMs = run.turns?.reduce((sum, turn) => turn.purpose === "writeup" ? sum :
        sum + Math.max(0, Date.parse(turn.finishedAt) - Date.parse(turn.startedAt)), 0) ?? run.durationMs ?? 0
      samples.push({
        variant: variant(result), group: `${label ?? variant(result)} · ${model} · ${conditionID}`,
        runID: run.id, slug: challenge.slug, category: challenge.category ?? "OTHER", model, trial,
        experiment: label, conditions: configuration,
        ...(configuration && trial && !experiment?.invalidated
          ? { comparisonKey: JSON.stringify([challenge.slug, trial, configuration.inputFingerprint, conditions]) } : {}),
        correct, scoringSource: answer !== undefined ? "answer" : accepted ? "accepted-verdict" : undefined,
        candidateCount: attempts.length, judgedCandidates: judged.length, wrongCandidates: wrong.length,
        firstToolMs: firstTool && start !== undefined ? Math.max(0, firstTool.at - start) : undefined,
        firstCorrectCandidateMs: correctTurn && start !== undefined ? Math.max(0, Date.parse(correctTurn.finishedAt) - start) : undefined,
        activeSolveMs,
        failure: correct === true ? undefined : run.stop === "error" || run.stop === "silent" || run.stop === "empty" ? "runtime" :
          run.stop === "blocked" ? "prerequisite" : run.stop === "budget" || run.stop === "timeout" ? "budget" : attempts.length === 0 ? "no-candidate" : undefined,
        tokens: run.tokens, cost: run.cost,
      })
    }
  }
  return samples
}

/** Pair only independent trials with matching input, model policy, budget and environment. */
export function compareEvaluationSamples(baseline: EvaluationSample[], current: EvaluationSample[]) {
  const byKey = (rows: EvaluationSample[]) => {
    const groups = new Map<string, EvaluationSample[]>()
    for (const row of rows) if (row.comparisonKey) groups.set(row.comparisonKey, [...(groups.get(row.comparisonKey) ?? []), row])
    return groups
  }
  const left = byKey(baseline), right = byKey(current)
  const pairs = [...right.entries()].flatMap(([key, rows]) => {
    const previous = left.get(key)
    return previous?.length === 1 && rows.length === 1 && previous[0]!.correct !== undefined && rows[0]!.correct !== undefined
      ? [{ baseline: previous[0]!, current: rows[0]! }] : []
  })
  const challenges = [...new Set(pairs.map((pair) => pair.current.slug))]
  const success = (side: "baseline" | "current") => challenges.length ?
    challenges.reduce((sum, slug) => {
      const rows = pairs.filter((pair) => pair.current.slug === slug)
      return sum + rows.filter((pair) => pair[side].correct).length / rows.length
    }, 0) / challenges.length : undefined
  return {
    pairedTrials: pairs.length, pairedChallenges: challenges.length,
    excludedBaseline: baseline.length - pairs.length, excludedCurrent: current.length - pairs.length,
    baselineSuccessRate: success("baseline"), currentSuccessRate: success("current"),
    wins: pairs.filter((pair) => pair.current.correct && !pair.baseline.correct).length,
    losses: pairs.filter((pair) => pair.baseline.correct && !pair.current.correct).length,
    medianTokenDelta: median(pairs.map((pair) => pair.current.tokens - pair.baseline.tokens)),
    medianCostDelta: median(pairs.map((pair) => pair.current.cost - pair.baseline.cost)),
  }
}

export function evaluationMarkdown(summaries: EvaluationSummary[]) {
  const percent = (value?: number) => value === undefined ? "—" : `${(value * 100).toFixed(1)}%`
  const seconds = (value?: number) => value === undefined ? "—" : `${(value / 1_000).toFixed(1)}s`
  return [
    "# Boom 效果评估", "",
    "| 实验与条件 | 运行/已评分 | 正确率 | 错误候选/已判定 | 首工具耗时 | 首正确候选耗时 | 运行故障 | 成本/成功 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...summaries.map((item) => `| ${item.group.replaceAll("|", "\\|")} | ${item.runs}/${item.scored} | ${percent(item.successRate)} | ${item.wrongCandidates}/${item.judgedCandidates} (${percent(item.wrongCandidateRate)}) | ${seconds(item.medianFirstToolMs)} | ${seconds(item.medianFirstCorrectCandidateMs)} | ${item.runtimeFailures} | ${item.costPerSuccess === undefined ? "—" : `$${item.costPerSuccess.toFixed(4)}`} |`),
    "", "首工具耗时只表示开始执行；首次有效证据尚无可靠自动判定，因此不计作证据指标。",
    "正确率的分母包含所有已评分任务，含运行故障和预算耗尽。未评分任务单列，成本/成功仅在整组已评分时报告。",
    "候选按解题回合记录计数，含最终成功前的错误候选；不等同于平台实际提交次数。Strong token 占比不再从旧编排结构推算。",
    "宿主只读取答案评分，不把答案或官方解法写入运行工作区。",
  ].join("\n")
}
