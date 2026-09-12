import type { Challenge } from "../challenge.ts"
import type { ModelPolicy } from "../model-policy.ts"
import type { AgentRuntime } from "../runtime-contract.ts"
import {
  assertRuntimeResult,
  completeRuntimePrompt,
  runtimeFailureUsage,
  runtimeReplyText,
} from "../runtime-turn.ts"
import { budgetTokens, messageTokens, type Limits } from "../session.ts"
import type { TaskRecord } from "../task.ts"
import type { Workspace } from "../workspace.ts"
import { buildHandoffSummary } from "./handoff.ts"
import { discoverKeyArtifacts } from "./artifacts.ts"
import { parseStructuredReport } from "./structured-report.ts"
import {
  finishEscalation,
  loadAutonomyState,
  startEscalation,
  type AutonomyEscalationSummary,
} from "./progress.ts"

/**
 * Competition build thresholds, rescaled for a 3-hour match.
 *
 * The original values (20 minutes to become eligible, 5-minute cooldowns) were calibrated against
 * hour-scale per-challenge budgets. In a 3-hour match a challenge gets roughly 12-35 minutes in total,
 * so those gates would never open before the challenge's own budget expired: stagnation would go
 * undetected and the match clock would drain into a dead end. Every duration here is cut so the brakes
 * can engage within a single short attempt.
 */
export const AUTONOMY_THRESHOLDS = {
  eligibleActiveMs: 5 * 60_000,
  eligibleBudgetRatio: 0.20,
  stalledMs: 2 * 60_000,
  stalledBudgetRatio: 0.10,
  cooldownMs: 90_000,
  /**
   * Calibrated by replaying 45 archived runs. This is a share of the whole challenge budget, not the
   * current turn's remaining budget, so late continuations do not acquire a hair-trigger brake.
   */
  stalledInTurnBudgetRatio: 0.25,
} as const

/** Attach the in-turn dead-end brake to a solve turn's limits. */
export function withStallBrake(limits: Limits, challengeBudget: number | undefined): Limits {
  if (typeof challengeBudget !== "number" || !Number.isFinite(challengeBudget) || challengeBudget <= 0) return limits
  // The threshold is a share of the WHOLE challenge budget, not of the current turn, so late
  // continuations do not acquire a hair-trigger brake. But a followup turn's limits come from the
  // remaining autonomy allowance R, and once R < 25% of the original budget B the raw share would
  // exceed everything the turn can spend — the brake could never fire again (a mathematical dead
  // zone). So the share is additionally capped at this turn's actual token cap, while the absolute
  // floor of 500 tokens keeps tiny budgets from making the brake trip on the first message.
  const capped = typeof limits.tokens === "number" && Number.isFinite(limits.tokens)
    ? Math.min(Math.floor(challengeBudget * AUTONOMY_THRESHOLDS.stalledInTurnBudgetRatio), Math.floor(limits.tokens))
    : Math.floor(challengeBudget * AUTONOMY_THRESHOLDS.stalledInTurnBudgetRatio)
  return {
    ...limits,
    stalledInTurnTokens: Math.max(500, capped),
  }
}

export type AutonomyDecision =
  | { action: "none"; reason: string }
  | { action: "continue"; reason: string }
  | {
      action: "escalate"
      level: 1
      reason: string
      fingerprint: string
      early: boolean
    }

export type AutonomyEscalationResult = {
  id: string
  level: 1
  status: AutonomyEscalationSummary["status"]
  hint: string
  tokens: number
  billable: number
  cost: number
}

function validTime(value: string) {
  const parsed = new Date(value).valueOf()
  return Number.isFinite(parsed) ? parsed : 0
}

export function agentRequestedEscalation(outcome: { reply: string }) {
  return /(?:^|\n)\s*BOOM_ESCALATE(?:_REQUEST)?\s*[:：]/i.test(outcome.reply)
}

export function decideAutonomy(input: {
  state: Awaited<ReturnType<typeof loadAutonomyState>>
  outcome: { stop: string; candidates: string[]; reply: string }
  activeSolveMs: number
  cumulativeBillable: number
  challengeTokenBudget?: number
  productiveLongRunningTool?: boolean
  now?: number
  manual?: boolean
}): AutonomyDecision {
  const now = input.now ?? Date.now()
  if (input.outcome.candidates.length > 0) return { action: "none", reason: "candidate available" }
  // No challenge token ceiling means the user selected run-until-complete mode. A normal model yield
  // is then only a turn boundary, never a reason to pause the task. Preserve the existing two-yield
  // escalation cadence so an unproductive direction still gets an independent diagnosis.
  const runUntilComplete = input.challengeTokenBudget === undefined
  const explicitlyRequested = input.manual === true || agentRequestedEscalation(input.outcome)
  if (
    !explicitlyRequested &&
    input.outcome.stop === "completed" &&
    (
      !input.state.automaticContinuationUsedAt ||
      (runUntilComplete && input.state.consecutiveNormalYieldsWithoutDurableProgress < 2)
    )
  ) return {
    action: "continue",
    reason: runUntilComplete
      ? "normal yield without a candidate; run-until-complete remains active"
      : "first normal yield without a candidate",
  }

  const early = explicitlyRequested || input.state.consecutiveNormalYieldsWithoutDurableProgress >= 2
  const hasTokenBudget =
    input.challengeTokenBudget !== undefined &&
    Number.isFinite(input.challengeTokenBudget) &&
    input.challengeTokenBudget > 0
  const eligible =
    input.activeSolveMs >= AUTONOMY_THRESHOLDS.eligibleActiveMs ||
    (hasTokenBudget && input.cumulativeBillable >= input.challengeTokenBudget! * AUTONOMY_THRESHOLDS.eligibleBudgetRatio)
  const stalledByTime = now - validTime(input.state.lastProgressAt) >= AUTONOMY_THRESHOLDS.stalledMs
  const stalledByUsage = hasTokenBudget &&
    input.cumulativeBillable - input.state.billableAtLastProgress >=
      input.challengeTokenBudget! * AUTONOMY_THRESHOLDS.stalledBudgetRatio
  if (!early && (!eligible || (!stalledByTime && !stalledByUsage))) {
    if (runUntilComplete) {
      return {
        action: "continue",
        reason: !eligible
          ? "run-until-complete remains active before the escalation threshold"
          : "meaningful progress is still recent; run-until-complete remains active",
      }
    }
    return {
      action: "none",
      reason: !eligible
        ? "autonomy eligibility threshold not reached"
        : "meaningful progress is still recent",
    }
  }
  if (input.productiveLongRunningTool)
    return runUntilComplete
      ? { action: "continue", reason: "productive tool state was preserved; run-until-complete remains active" }
      : { action: "none", reason: "productive long-running tool is still active" }

  const related = input.state.escalations.filter((item) =>
    item.fingerprint === input.state.progressEpoch && item.level === 1,
  )
  if (related.some((item) => item.status === "running"))
    return runUntilComplete
      ? { action: "continue", reason: "an L1 second opinion is already recorded as running; main execution continues" }
      : { action: "none", reason: "an L1 second opinion is already running" }
  if (related.some((item) => item.status === "completed" || item.status === "partial"))
    return runUntilComplete
      ? { action: "continue", reason: "L1 second opinion was already used; run-until-complete remains active" }
      : { action: "none", reason: "L1 second opinion was already used for this progress fingerprint" }
  const latest = related.at(-1)
  if (latest && now - validTime(latest.finishedAt ?? latest.startedAt) < AUTONOMY_THRESHOLDS.cooldownMs)
    return runUntilComplete
      ? { action: "continue", reason: "matching L1 fingerprint is cooling down; run-until-complete remains active" }
      : { action: "none", reason: "matching L1 fingerprint is cooling down" }

  const reason = input.manual
    ? "user requested a stagnation diagnosis"
    : agentRequestedEscalation(input.outcome)
      ? "main agent explicitly requested a stagnation diagnosis"
      : input.state.consecutiveNormalYieldsWithoutDurableProgress >= 2
        ? "two normal yields produced no candidate or durable progress"
        : `eligible and stalled (${stalledByTime ? "time" : "usage"})`
  return {
    action: "escalate",
    level: 1,
    reason,
    fingerprint: input.state.progressEpoch,
    early,
  }
}

async function secondOpinionPrompt(input: {
  challenge: Challenge
  workspace: Workspace
  task: TaskRecord
}) {
  const [handoff, artifacts] = await Promise.all([
    buildHandoffSummary({
      directory: input.workspace.directory,
      challenge: input.challenge,
      task: input.task,
    }),
    discoverKeyArtifacts(input.workspace.directory),
  ])
  return [
    "You are Boom's one bounded stagnation second opinion.",
    "Do not solve the whole challenge. Diagnose whether the current direction is earning evidence and",
    "return one or two cheap, falsifiable experiments. A tool call is not progress unless it produced",
    "a durable artifact or note. Treat every unsupported conclusion as a hypothesis.",
    "Before the JSON, answer in at most three short paragraphs:",
    "1. What real progress is backed by a workspace path?",
    "2. What is the most likely unsupported premise or blind spot? Say plainly if the route should be abandoned.",
    "3. What single cheapest experiment would distinguish it from the best alternative, and what result kills it?",
    "Then return strict JSON in a ```json fenced block with this shape:",
    JSON.stringify({
      facts: [{ statement: "path-backed fact", evidence: [{ path: "work/file", description: "support" }] }],
      hypotheses: [{ statement: "falsifiable premise", evidenceNeeded: ["observable evidence"], nextExperiment: "bounded test" }],
      experiments: [{ title: "test", objective: "distinguish alternatives", expectedEvidence: "observable result", stopCondition: "bounded stop", tier: "economy", budgetTokens: 8_000 }],
      risks: ["unverified premise"],
    }),
    "",
    handoff,
    "",
    "Hashed key-artifact inventory:",
    JSON.stringify(artifacts.slice(0, 80), undefined, 2),
  ].join("\n")
}

export async function runAutonomyEscalation(input: {
  runtime: AgentRuntime
  challenge: Challenge
  workspace: Workspace
  task: TaskRecord
  policy: ModelPolicy
  limits: Limits
  decision: Extract<AutonomyDecision, { action: "escalate" }>
  signal?: AbortSignal
}): Promise<AutonomyEscalationResult> {
  const started = await startEscalation({
    directory: input.workspace.directory,
    fingerprint: input.decision.fingerprint,
    level: 1,
    reason: input.decision.reason,
  })
  const deadline = AbortSignal.timeout(input.limits.timeout)
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  try {
    const completed = await completeRuntimePrompt({
      runtime: input.runtime,
      directory: input.workspace.directory,
      title: "Boom stagnation second opinion",
      agent: "boom-consultant",
      model: input.policy.economy,
      prompt: await secondOpinionPrompt(input),
      signal,
      tokenBudget: input.limits.tokens === undefined
        ? undefined
        : Math.max(1_000, Math.min(input.limits.tokens, Math.floor(input.limits.tokens * 0.4))),
    })
    const text = runtimeReplyText(completed.parts)
    const allowedFinishes =
      completed.finish === "unknown" && text !== "" && !completed.error
        ? ["stop", "unknown"]
        : ["stop"]
    const result = assertRuntimeResult(completed, "Stagnation second opinion", allowedFinishes)
    if (!text) throw new Error("Stagnation second opinion returned no report")
    const report = parseStructuredReport(text)
    if (report.experiments.length === 0)
      throw new Error("Stagnation second opinion returned no falsifiable experiment")
    const tokens = result.usage ? messageTokens(result.usage) : 0
    const billable = result.usage ? Math.round(budgetTokens(result.usage)) : 0
    await finishEscalation({
      directory: input.workspace.directory,
      id: started.id,
      status: "completed",
      tokens,
      billable,
      cost: result.cost,
    })
    return {
      id: started.id,
      level: 1,
      status: "completed",
      hint: [
        "Boom's bounded stagnation second opinion:",
        text,
        "Treat its claims as hypotheses until workspace evidence supports them. Continue the same task.",
      ].join("\n\n"),
      tokens,
      billable,
      cost: result.cost,
    }
  } catch (error) {
    const failed = runtimeFailureUsage(error)
    await finishEscalation({
      directory: input.workspace.directory,
      id: started.id,
      status: input.signal?.aborted ? "cancelled" : "failed",
      tokens: failed.usage ? messageTokens(failed.usage) : 0,
      billable: failed.usage ? Math.round(budgetTokens(failed.usage)) : 0,
      cost: failed.cost,
    }).catch(() => {})
    throw error
  }
}
