import { readFile } from "node:fs/promises"
import path from "node:path"
import { discoverChallenges, loadAnswers } from "./challenge.ts"
import { readChallengeRuns } from "./history.ts"

export type EvaluationVariant =
  | "autonomy-l0"
  | "autonomy-escalated"
  | "consultation"
  | "single-model"
  | "v1-consultation"
  | "v2-mode-a"
  | "v2-full"
  | "automatic-recovery"

const EVALUATION_VARIANTS: EvaluationVariant[] = [
  "autonomy-l0",
  "autonomy-escalated",
  "consultation",
  // Historical variants remain readable so old result.json files can still be compared.
  "single-model",
  "v1-consultation",
  "v2-mode-a",
  "v2-full",
  "automatic-recovery",
]

export type EvaluationSample = {
  variant: EvaluationVariant
  slug: string
  correct?: boolean
  candidateCount: number
  firstEvidenceMs?: number
  tokens: number
  cost: number
  strongTokens: number
}

export type EvaluationSummary = {
  variant: EvaluationVariant
  runs: number
  scored: number
  successes: number
  successRate?: number
  wrongCandidates: number
  wrongCandidateRate: number
  medianFirstEvidenceMs?: number
  tokens: number
  cost: number
  costPerSuccess?: number
  strongTokenShare: number
}

function median(values: number[]) {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function aggregateEvaluation(samples: EvaluationSample[]) {
  return EVALUATION_VARIANTS.flatMap((variant): EvaluationSummary[] => {
    const rows = samples.filter((item) => item.variant === variant)
    if (!rows.length) return []
    const scored = rows.filter((item) => item.correct !== undefined)
    const successes = scored.filter((item) => item.correct).length
    const wrongCandidates = scored.filter((item) => item.correct === false && item.candidateCount > 0).length
    const tokens = rows.reduce((sum, item) => sum + item.tokens, 0)
    const cost = rows.reduce((sum, item) => sum + item.cost, 0)
    const strongTokens = rows.reduce((sum, item) => sum + item.strongTokens, 0)
    return [{
      variant,
      runs: rows.length,
      scored: scored.length,
      successes,
      ...(scored.length ? { successRate: successes / scored.length } : {}),
      wrongCandidates,
      wrongCandidateRate: scored.length ? wrongCandidates / scored.length : 0,
      ...(median(rows.flatMap((item) => item.firstEvidenceMs ?? [])) === undefined
        ? {}
        : { medianFirstEvidenceMs: median(rows.flatMap((item) => item.firstEvidenceMs ?? [])) }),
      tokens,
      cost,
      ...(successes ? { costPerSuccess: cost / successes } : {}),
      strongTokenShare: tokens ? strongTokens / tokens : 0,
    }]
  })
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function variant(result: Record<string, unknown>): EvaluationVariant {
  if (
    typeof result.orchestration_variant === "string" &&
    EVALUATION_VARIANTS.includes(result.orchestration_variant as EvaluationVariant)
  )
    return result.orchestration_variant as EvaluationVariant
  if (result.consultation) return "v1-consultation"
  if (Array.isArray(result.branches) && result.branches.length) return "v2-full"
  if (result.checkpoint) return "v2-mode-a"
  return "single-model"
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function strongTokenEstimate(result: Record<string, unknown>) {
  const total = number(result.tokens)
  const model = typeof result.model === "string" ? result.model : ""
  let economy = 0
  const baseline = object(result.baseline)
  if (baseline.model && baseline.model !== model) economy += number(baseline.tokens)
  for (const branchValue of Array.isArray(result.branches) ? result.branches : []) {
    const branch = object(branchValue)
    if (branch.model && branch.model !== model) economy += number(branch.tokens)
  }
  const checkpoint = object(result.checkpoint)
  for (const role of ["analyzer", "challenger", "arbiter"]) {
    const entry = object(checkpoint[role])
    const reply = object(entry.reply)
    if (reply.model && reply.model !== model) economy += number(reply.tokens)
  }
  return Math.max(0, total - economy)
}

export async function collectEvaluationSamples(root: string) {
  const answers = await loadAnswers(root)
  const samples: EvaluationSample[] = []
  for (const challenge of await discoverChallenges(root)) {
    for (const run of await readChallengeRuns(root, challenge.slug)) {
      const raw = await readFile(path.join(root, "runs", challenge.slug, run.id, "result.json"), "utf8").catch(() => undefined)
      if (!raw) continue
      let result: Record<string, unknown>
      try { result = object(JSON.parse(raw)) } catch { continue }
      const firstEvidence = run.events.find((event) => event.type === "tool" && event.status === "completed")
      const started = run.startedAt ? new Date(run.startedAt).valueOf() : undefined
      const answer = answers.get(challenge.slug)
      samples.push({
        variant: variant(result),
        slug: challenge.slug,
        ...(answer === undefined ? {} : { correct: run.candidates.includes(answer) }),
        candidateCount: run.candidates.length,
        ...(firstEvidence && started ? { firstEvidenceMs: Math.max(0, firstEvidence.at - started) } : {}),
        tokens: run.tokens,
        cost: run.cost,
        strongTokens: strongTokenEstimate(result),
      })
    }
  }
  return samples
}

export function evaluationMarkdown(summaries: EvaluationSummary[]) {
  return [
    "# Boom 效果评估",
    "",
    "| 变体 | 运行 | 成功率 | 错误候选率 | 首证据中位耗时 | 成本/成功 | strong token 占比 |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...summaries.map((item) =>
      `| ${item.variant} | ${item.runs} | ${item.successRate === undefined ? "—" : `${(item.successRate * 100).toFixed(1)}%`} | ${(item.wrongCandidateRate * 100).toFixed(1)}% | ${item.medianFirstEvidenceMs === undefined ? "—" : `${Math.round(item.medianFirstEvidenceMs)} ms`} | ${item.costPerSuccess === undefined ? "—" : `$${item.costPerSuccess.toFixed(4)}`} | ${(item.strongTokenShare * 100).toFixed(1)}% |`,
    ),
    "",
    "同一题目和预算的变体运行可累积在同一 challenge root 下；本报告只读取宿主答案做评分，不把答案写入运行工作区。",
  ].join("\n")
}
