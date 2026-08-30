import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Challenge } from "./challenge.ts"
import {
  estimateTextTokens,
  loadConsultationHistory,
  type ConsultationContext,
} from "./consultation-context.ts"
import { recentArtifacts } from "./orchestration/handoff.ts"
import type { AgentRuntime, RuntimeMessage } from "./runtime-contract.ts"
import {
  assertRuntimeResult,
  completeRuntimePrompt,
  runtimeFailureUsage,
  runtimeReplyText,
} from "./runtime-turn.ts"
import {
  budgetTokens,
  classifyProviderFailure,
  isTransient,
  messageTokens,
  type Limits,
} from "./session.ts"
import type { Workspace } from "./workspace.ts"

export type ConsultationTrigger =
  | "planning"
  | "stalled"
  | "budget"
  | "error"
  | "manual"
  | "agent-request"
  | "compaction"

/**
 * How many experts one consultation may use. Two is the floor because a single plan has no
 * disagreement to reconcile; the ceiling exists because cost grows linearly while the synthesiser has
 * to fit every plan in one context, so the marginal plan buys less than it costs.
 */
export const CONSULT_EXPERTS = { minimum: 2, maximum: 4 } as const

export type ConsultationReply = {
  model: string
  text: string
  tokens: number
  billable: number
  cost: number
  finish?: string
}

export type ConsultationFailure = {
  index: number
  model: string
  attempts: number
  error: string
  tokens: number
  billable: number
  cost: number
}

export type ConsultationBudgets = {
  /** Hard cumulative allowance for one expert role, including its retry. */
  expertTokens: number
  /** Hard allowance for the strong synthesizer. */
  synthesizerTokens: number
  /** Hard allowance reserved for the solver after consultation. */
  solverTokens: number
}

export type ConsultationDegradation = {
  reason: "insufficient-experts" | "synthesis-failed"
  detail: string
}

export type Consultation = {
  id: string
  trigger: ConsultationTrigger
  sourceRunID?: string
  /** Successful expert plans, in configured-model order; degraded consultations may keep only one. */
  plans: ConsultationReply[]
  /** Failed experts remain durable and never erase successful plans. */
  failures: ConsultationFailure[]
  merged: ConsultationReply
  /** The solver may continue with unmerged surviving plans when consensus cannot be produced. */
  degraded?: ConsultationDegradation
  budgets?: ConsultationBudgets
  tokens: number
  billable: number
  cost: number
  startedAt: string
  finishedAt: string
}

export type AskConsultant = (input: {
  model: string
  title: string
  prompt: string
  tokenBudget?: number
  signal?: AbortSignal
}) => Promise<ConsultationReply>

const MAX_DESCRIPTION = 16_000
/** Token ceiling for the rendered work section, measured with the conservative estimator. */
const MAX_WORK = 24_000
const MAX_CLUES = 32_000
const MAX_DETAIL = 4_000
const MAX_ARTIFACTS = 20
export const DEFAULT_CONSULTATION_HISTORY_TOKENS = 48_000

function bounded(text: string | undefined, maximum: number) {
  const value = text?.trim() ?? ""
  if (value.length <= maximum) return value
  return `${value.slice(0, maximum)}\n\n[truncated, ${value.length} chars total]`
}

function scaledBound(maximum: number, scale: number) {
  return Math.max(1, Math.floor(maximum * Math.min(1, Math.max(0, scale))))
}

function challengeSummary(challenge: Challenge, scale = 1) {
  return [
    `Challenge: ${challenge.slug}`,
    `Category: ${challenge.category ?? "OTHER"}`,
    `Flag format: ${challenge.flagFormat.trim() || "for the solver to determine"}`,
    `Attachments: ${challenge.files.length === 0 ? "none" : challenge.files.join(", ")}`,
    challenge.remote ? `Remote target: ${JSON.stringify(challenge.remote)}` : "",
    "",
    "Challenge statement:",
    bounded(challenge.description, scaledBound(MAX_DESCRIPTION, scale)) || "(none)",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function boundedHeadAndTail(text: string, maximum: number) {
  const value = text.trim()
  if (value.length <= maximum) return value
  if (maximum < 80) return value.slice(0, maximum)
  const marker = `\n...[truncated, ${value.length} chars total]...\n`
  const available = maximum - marker.length
  const head = Math.ceil(available * 0.6)
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`
}

function renderHistoryMessage(message: RuntimeMessage) {
  const lines: string[] = []
  for (const part of message.parts) {
    if (part.type === "tool") {
      lines.push(`Tool: ${part.tool ?? "unknown"}${part.state ? ` (${part.state})` : ""}`)
      if (part.input) lines.push(`Input: ${boundedHeadAndTail(part.input, 1_500)}`)
      if (part.output) lines.push(`Output: ${boundedHeadAndTail(part.output, 3_000)}`)
      if (part.error) lines.push(`Error: ${boundedHeadAndTail(part.error, 1_500)}`)
    } else if (part.text) {
      lines.push(boundedHeadAndTail(part.text, 4_000))
    }
  }
  return lines.join("\n")
}

/**
 * Produce a consultation-only view of recent work without mutating the solver conversation. Manual
 * and post-compaction consultations both reduce their available snapshot here. The result is plain
 * text, so a very large API round can be shortened safely instead of erasing all consultation
 * history. `maximum` is a token budget measured with {@link estimateTextTokens}, so dense logs and
 * CJK text no longer slip through a character-counting loophole.
 */
export function compressConsultationHistory(messages: RuntimeMessage[], maximum = MAX_WORK) {
  const limit = Math.max(0, Math.floor(maximum))
  if (limit === 0 || messages.length === 0) return "(no work recorded yet)"
  const selected: string[] = []
  let used = 0
  let omitted = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const rendered = renderHistoryMessage(messages[index]!)
    if (!rendered) continue
    const cost = estimateTextTokens(rendered)
    const separator = selected.length === 0 ? 0 : 1
    const remaining = limit - used - separator
    if (remaining <= 0) {
      omitted = index + 1
      break
    }
    if (cost > remaining) {
      // One character per remaining token is conservative for the estimator's densest (CJK) case;
      // the runtime's real prompt-token enforcement remains the final backstop.
      selected.unshift(boundedHeadAndTail(rendered, Math.max(1, remaining)))
      omitted = index
      break
    }
    selected.unshift(rendered)
    used += separator + cost
  }
  const body = selected.join("\n\n") || "(no work recorded yet)"
  return omitted > 0 ? `[${omitted} older entries omitted]\n${body}` : body
}

export function buildConsultationContext(input: {
  challenge: Challenge
  trigger: ConsultationTrigger
  notes?: string
  stopDetail?: string
  history?: RuntimeMessage[]
  historyTokenBudget?: number
  artifacts?: string[]
  rejectedFlags?: string[]
  contextWarning?: string
  /**
   * Shrinks every rendered bound (description, work, clues, detail) by this factor in (0, 1].
   * Retry ladders walk down the scale until the runtime accepts the prompt.
   */
  scale?: number
}): ConsultationContext {
  const scale = input.scale === undefined ? 1 : Math.min(1, Math.max(0, Number(input.scale) || 1))
  const historyMaximum = Math.min(
    MAX_WORK,
    Math.max(1, Math.floor(input.historyTokenBudget ?? DEFAULT_CONSULTATION_HISTORY_TOKENS)),
  )
  const recentWork = compressConsultationHistory(input.history ?? [], historyMaximum)
  const status = bounded(input.stopDetail, scaledBound(MAX_DETAIL, scale))
  const work = [
    ...(status ? [`Current status: ${status}`, ""] : []),
    recentWork,
  ].join("\n")
  const clues = [
    bounded(input.notes, scaledBound(MAX_CLUES, scale)) || "(no clues recorded)",
    ...(input.artifacts?.length
      ? ["", "Related artifacts:", ...input.artifacts.map((artifact) => `- ${artifact}`)]
      : []),
    ...(input.rejectedFlags?.length
      ? ["", "Rejected flags (do not resubmit):", ...input.rejectedFlags.map((flag) => `- ${flag}`)]
      : []),
    ...(input.contextWarning
      ? ["", `Context read notice: ${bounded(input.contextWarning, scaledBound(MAX_DETAIL, scale))}`]
      : []),
  ].join("\n")
  return {
    challenge: challengeSummary(input.challenge, scale),
    work,
    clues,
  }
}

export function renderConsultationContext(context: ConsultationContext) {
  return [
    "## Challenge summary",
    context.challenge,
    "",
    "## Work done so far",
    context.work,
    "",
    "## Clues",
    context.clues,
  ].join("\n")
}

function expertPrompt(context: ConsultationContext) {
  return [
    "You are a CTF expert. Given the challenge summary, work done so far, and clues below, give your solving approach and next-step recommendation; avoid repeating what was already tried.",
    "",
    renderConsultationContext(context),
  ].join("\n")
}

function expertLabel(index: number) {
  return `Expert ${index + 1}`
}

const MAX_PLAN_CHARS = 12_000

/**
 * Synthesis prompt with each expert plan bounded. Unbounded plan text is the dominant term in the
 * synthesis context: one verbose expert can single-handedly overflow the synthesizer window, and a
 * degraded consultation then inherits whatever that expert hallucinated in full.
 */
function synthesisPrompt(
  context: ConsultationContext,
  plans: ConsultationReply[],
  planChars = MAX_PLAN_CHARS,
) {
  return [
    "Several CTF experts gave the approaches below. Reconcile them with the challenge summary and current progress into the single most actionable plan.",
    "",
    renderConsultationContext(context),
    ...plans.flatMap((plan, index) => [
      "",
      `${expertLabel(index)} (${plan.model}):`,
      boundedHeadAndTail(plan.text, Math.max(1, Math.floor(planChars))),
    ]),
  ].join("\n")
}

/** Declared model context windows used to cap consultation budgets when the backend reports them. */
export type ConsultationWindows = {
  /** Context window of the smallest expert model; caps the shared per-expert budget. */
  expert?: number
  /** Context window of the synthesizer model; caps the synthesis budget. */
  synthesizer?: number
}

export function allocateConsultationBudgets(
  totalTokens: number,
  expertCount: number,
  windows: ConsultationWindows = {},
): ConsultationBudgets {
  if (expertCount < CONSULT_EXPERTS.minimum || expertCount > CONSULT_EXPERTS.maximum)
    throw new Error(`Consultation budget requires ${CONSULT_EXPERTS.minimum}-${CONSULT_EXPERTS.maximum} experts`)
  if (!Number.isFinite(totalTokens) || totalTokens < expertCount + 2)
    throw new Error(`Consultation budget requires at least ${expertCount + 2} tokens`)
  const total = Math.floor(totalTokens)
  const solverTokens = Math.max(1, Math.min(
    Math.floor(total * 0.5),
    total - expertCount - 1,
  ))
  const synthesizerTokens = Math.max(1, Math.min(
    Math.floor(total * 0.2),
    total - expertCount - solverTokens,
    windows.synthesizer === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(windows.synthesizer)),
  ))
  const expertPool = total - solverTokens - synthesizerTokens
  const expertTokens = Math.max(1, Math.min(
    Math.floor(expertPool / expertCount),
    windows.expert === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(windows.expert)),
  ))
  return {
    expertTokens,
    synthesizerTokens,
    solverTokens,
  }
}

/**
 * One rung of a consultation prompt ladder, from largest to smallest. The runtime's own
 * prompt-token enforcement is the fit oracle: a context overflow advances to the next rung
 * instead of failing the expert outright.
 */
export type ConsultationPromptRung = {
  index: number
  prompt: string
  historyTokens: number
  scale: number
}

export type ConsultationExpertSettlement =
  | { index: number; status: "success"; reply: ConsultationReply }
  | { index: number; status: "failure"; failure: ConsultationFailure }

export class ConsultationExecutionError extends Error {
  readonly tokens: number
  readonly billable: number
  readonly cost: number

  constructor(
    message: string,
    usage: { tokens: number; billable: number; cost: number },
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ConsultationExecutionError"
    this.tokens = usage.tokens
    this.billable = usage.billable
    this.cost = usage.cost
  }
}

function totalConsultationUsage(
  replies: ConsultationReply[],
  failures: ConsultationFailure[],
) {
  return {
    tokens:
      replies.reduce((sum, reply) => sum + reply.tokens, 0) +
      failures.reduce((sum, failure) => sum + failure.tokens, 0),
    billable:
      replies.reduce((sum, reply) => sum + reply.billable, 0) +
      failures.reduce((sum, failure) => sum + failure.billable, 0),
    cost:
      replies.reduce((sum, reply) => sum + reply.cost, 0) +
      failures.reduce((sum, failure) => sum + failure.cost, 0),
  }
}

function failedUsage(error: unknown) {
  const observed = runtimeFailureUsage(error)
  return {
    tokens: observed.usage ? messageTokens(observed.usage) : 0,
    billable: observed.usage ? Math.round(budgetTokens(observed.usage)) : 0,
    cost: observed.cost,
  }
}

function errorText(error: unknown) {
  return bounded(error instanceof Error ? error.message : String(error), MAX_DETAIL)
}

function retryableConsultationFailure(error: unknown) {
  if (isTransient(error)) return true
  return /(?:finish reason:\s*(?:unknown|empty)|returned no plan|empty response|malformed response)/i
    .test(errorText(error))
}

/**
 * True when the prompt itself did not fit the runtime: the provider reported an input context
 * overflow, or Boom's own post-step budget check fired while the prompt was still oversized.
 * Retrying the same rung cannot help; the ladder must shrink instead.
 */
function contextOverflowError(error: unknown) {
  return classifyProviderFailure(error) === "input-context-overflow" ||
    /prompt token budget exceeded/i.test(errorText(error))
}

function degradedPlan(
  plans: ConsultationReply[],
  degradation: ConsultationDegradation,
): ConsultationReply {
  const introduction = degradation.reason === "insufficient-experts"
    ? "The consultation did not obtain enough independent expert plans to form multi-expert consensus. The surviving plans below are unsynthesized; verify each before acting on it."
    : "The synthesizer could not complete the semantic merge. The successful expert plans below are kept as-is; compare their evidence dependencies and verify each before acting on it."
  return {
    model: "boom/degraded",
    text: [
      introduction,
      `Degradation reason: ${degradation.detail}`,
      ...plans.flatMap((plan, index) => [
        "",
        `## ${expertLabel(index)} · ${plan.model}`,
        plan.text,
      ]),
    ].join("\n"),
    tokens: 0,
    billable: 0,
    cost: 0,
  }
}

export async function conductConsultation(input: {
  id?: string
  trigger: ConsultationTrigger
  sourceRunID?: string
  expertModels: string[]
  synthesizerModel: string
  context: ConsultationContext
  ask: AskConsultant
  budgets?: ConsultationBudgets
  expertRetries?: number
  /** Exponential-backoff base for transient expert failures; zero is useful in tests. */
  expertRetryDelayMs?: number
  onExpertSettled?: (settlement: ConsultationExpertSettlement) => unknown
  signal?: AbortSignal
  timeout?: number
  /** Ordered expert prompt ladder, largest first; absent, one rung renders from `context`. */
  promptRungs?: ConsultationPromptRung[]
  /** Ordered synthesis ladder, largest first; absent, one rung renders from `context` and `plans`. */
  synthesisRungs?: ConsultationPromptRung[]
  /**
   * Contexts for the synthesis ladder, largest first. Only `plans` exist after the expert phase,
   * so the synthesis prompts are rendered from these inside the consultation run. Ignored when
   * `synthesisRungs` is provided.
   */
  synthesisContexts?: ConsultationContext[]
}): Promise<Consultation> {
  if (input.signal?.aborted) throw new Error("Consultation aborted by user")
  if (
    input.expertModels.length < CONSULT_EXPERTS.minimum ||
    input.expertModels.length > CONSULT_EXPERTS.maximum
  )
    throw new Error(
      `A consultation needs ${CONSULT_EXPERTS.minimum}-${CONSULT_EXPERTS.maximum} expert models, ` +
        `received ${input.expertModels.length}`,
    )

  const startedAt = new Date().toISOString()
  const deadline =
    input.timeout === undefined ? undefined : AbortSignal.timeout(input.timeout)
  const signal =
    input.signal && deadline
      ? AbortSignal.any([input.signal, deadline])
      : input.signal ?? deadline
  const promptRungs = input.promptRungs ?? [{ index: 0, prompt: expertPrompt(input.context), historyTokens: 0, scale: 1 }]
  let plans: ConsultationReply[] = []
  let failures: ConsultationFailure[] = []
  let merged: ConsultationReply
  let degraded: ConsultationDegradation | undefined
  let degradationUsage = { tokens: 0, billable: 0, cost: 0 }
  try {
    const retries = Math.max(0, Math.min(2, Math.floor(input.expertRetries ?? 1)))
    const retryDelayMs = Math.max(0, Math.min(30_000, Math.floor(input.expertRetryDelayMs ?? 1_000)))
    const settlements = await Promise.all(input.expertModels.map(async (model, index) => {
      let tokens = 0
      let billable = 0
      let cost = 0
      /** Billable spend of attempts rejected for context overflow. It must not consume the ask
       *  budget, or one oversized prompt would starve every smaller retry that could fit. */
      let overflowBillable = 0
      let lastError = "unknown expert failure"
      let attempts = 0
      outer: for (const rung of promptRungs) {
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          const remaining = input.budgets
            ? Math.max(0, input.budgets.expertTokens - (billable - overflowBillable))
            : undefined
          if (remaining !== undefined && remaining <= 0) break outer
          let completed: ConsultationReply
          try {
            attempts += 1
            completed = await input.ask({
              model,
              title: attempts === 1
                ? `Boom consult ${index + 1}/${input.expertModels.length}`
                : `Boom consult ${index + 1}/${input.expertModels.length} retry ${attempts - 1}`,
              prompt: rung.prompt,
              ...(remaining === undefined ? {} : { tokenBudget: remaining }),
              signal,
            })
          } catch (error) {
            lastError = errorText(error)
            const usage = failedUsage(error)
            tokens += usage.tokens
            billable += usage.billable
            cost += usage.cost
            if (input.signal?.aborted) throw error
            if (deadline?.aborted) break outer
            // A prompt that does not fit the runtime is a property of the rung, not of the model.
            // Charge it outside the budget and walk down the ladder instead of failing the expert.
            if (contextOverflowError(error) && rung.index < promptRungs.length - 1) {
              overflowBillable += usage.billable
              break
            }
            if (retryableConsultationFailure(error) && attempt < retries) {
              if (retryDelayMs > 0)
                await new Promise((resume) => setTimeout(resume, retryDelayMs * 2 ** attempt))
              continue
            }
            break outer
          }
          const reply = {
            ...completed,
            tokens: completed.tokens + tokens,
            billable: completed.billable + billable,
            cost: completed.cost + cost,
          }
          const settlement = { index, status: "success" as const, reply }
          await Promise.resolve(input.onExpertSettled?.(settlement))
          return settlement
        }
      }
      const failure: ConsultationFailure = {
        index,
        model,
        attempts,
        error: lastError,
        tokens,
        billable,
        cost,
      }
      const settlement = { index, status: "failure" as const, failure }
      await Promise.resolve(input.onExpertSettled?.(settlement))
      return settlement
    }))
    if (input.signal?.aborted) throw input.signal.reason
    plans = settlements
      .filter((item): item is Extract<ConsultationExpertSettlement, { status: "success" }> => item.status === "success")
      .sort((left, right) => left.index - right.index)
      .map((item) => item.reply)
    failures = settlements
      .filter((item): item is Extract<ConsultationExpertSettlement, { status: "failure" }> => item.status === "failure")
      .sort((left, right) => left.index - right.index)
      .map((item) => item.failure)
    if (plans.length === 0)
      throw new ConsultationExecutionError(
        "Consultation has no successful expert plans",
        totalConsultationUsage(plans, failures),
      )
    if (plans.length < CONSULT_EXPERTS.minimum) {
      degraded = {
        reason: "insufficient-experts",
        detail: `Only ${plans.length} expert(s) succeeded; synthesis needs at least ${CONSULT_EXPERTS.minimum}`,
      }
      merged = degradedPlan(plans, degraded)
    } else if (deadline?.aborted) {
      degraded = {
        reason: "synthesis-failed",
        detail: `Consultation timed out after ${Math.round(input.timeout! / 1000)}s; preserving completed expert plans`,
      }
      merged = degradedPlan(plans, degraded)
    } else {
      // The synthesis prompt carries every surviving plan, so it is the most likely ask to
      // overflow. Walk its ladder the same way the experts do: overflow advances a rung, only a
      // terminal failure on the smallest rung degrades the merge. Plan text quarters per rung.
      const synthesisRungs = input.synthesisRungs ?? (input.synthesisContexts
        ? input.synthesisContexts.map((rungContext, index) => ({
            index,
            prompt: synthesisPrompt(
              rungContext,
              plans,
              Math.max(1, Math.floor(MAX_PLAN_CHARS / 4 ** index)),
            ),
            historyTokens: 0,
            scale: 1 / 4 ** index,
          }))
        : [{
            index: 0,
            prompt: synthesisPrompt(input.context, plans),
            historyTokens: 0,
            scale: 1,
          }])
      let synthesisOverflowBillable = 0
      let synthesisBillable = 0
      let lastSynthesisError = "unknown synthesis failure"
      let mergedAsk: ConsultationReply | undefined
      for (const rung of synthesisRungs) {
        const remaining = input.budgets
          ? Math.max(0, input.budgets.synthesizerTokens - (synthesisBillable - synthesisOverflowBillable))
          : undefined
        if (remaining !== undefined && remaining <= 0) break
        try {
          mergedAsk = await input.ask({
            model: input.synthesizerModel,
            title: "Boom consult synthesis",
            prompt: rung.prompt,
            ...(remaining === undefined ? {} : { tokenBudget: remaining }),
            signal,
          })
          break
        } catch (error) {
          if (input.signal?.aborted) throw error
          const usage = failedUsage(error)
          degradationUsage.tokens += usage.tokens
          degradationUsage.billable += usage.billable
          degradationUsage.cost += usage.cost
          synthesisBillable += usage.billable
          lastSynthesisError = errorText(error)
          if (deadline?.aborted) break
          if (contextOverflowError(error) && rung.index < synthesisRungs.length - 1) {
            synthesisOverflowBillable += usage.billable
            continue
          }
          break
        }
      }
      if (mergedAsk !== undefined) {
        merged = mergedAsk
      } else {
        degraded = {
          reason: "synthesis-failed",
          detail: deadline?.aborted
            ? `Consultation timed out after ${Math.round(input.timeout! / 1000)}s during synthesis; preserving completed expert plans`
            : lastSynthesisError,
        }
        merged = degradedPlan(plans, degraded)
      }
    }
  } catch (error) {
    if (deadline?.aborted)
      throw new ConsultationExecutionError(
        `Consultation timed out after ${Math.round(input.timeout! / 1000)}s with no usable plan`,
        totalConsultationUsage(plans, failures),
        { cause: error },
      )
    if (input.signal?.aborted) throw new Error("Consultation aborted by user")
    throw error
  }
  const replies = [...plans, merged]
  const baseUsage = totalConsultationUsage(replies, failures)
  const usage = {
    tokens: baseUsage.tokens + degradationUsage.tokens,
    billable: baseUsage.billable + degradationUsage.billable,
    cost: baseUsage.cost + degradationUsage.cost,
  }
  return {
    id: input.id ?? `consult-${crypto.randomUUID()}`,
    trigger: input.trigger,
    ...(input.sourceRunID ? { sourceRunID: input.sourceRunID } : {}),
    plans,
    failures,
    merged,
    ...(degraded ? { degraded } : {}),
    ...(input.budgets ? { budgets: input.budgets } : {}),
    tokens: usage.tokens,
    billable: usage.billable,
    cost: usage.cost,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}

export function createRuntimeConsultant(input: {
  runtime: AgentRuntime
  workspace: Workspace
}): AskConsultant {
  return async ({ model, title, prompt, tokenBudget, signal }) => {
    const completed = await completeRuntimePrompt({
      runtime: input.runtime,
      directory: input.workspace.directory,
      title,
      agent: "boom-consultant",
      model,
      prompt,
      tokenBudget,
      signal,
    })
    const text = runtimeReplyText(completed.parts)
    // Some compatible providers return a complete text response but cannot map their native terminal
    // state to a known finish reason. The text remains useful for consultation; an empty or errored
    // response still fails normally.
    const allowedFinishes = completed.finish === "unknown" && text !== "" && !completed.error
      ? ["stop", "unknown"]
      : ["stop"]
    const result = assertRuntimeResult(
      completed,
      `Consultation model ${model}`,
      allowedFinishes,
    )
    if (text === "") throw new Error(`Consultation model ${model} returned no plan`)
    const usage = result.usage
    const finish = result.finish
    return {
      model,
      text,
      tokens: usage ? messageTokens(usage) : 0,
      billable: usage ? Math.round(budgetTokens(usage)) : 0,
      cost: result.cost,
      ...(finish === undefined ? {} : { finish }),
    }
  }
}

export async function runConsultation(input: {
  runtime: AgentRuntime
  challenge: Challenge
  workspace: Workspace
  trigger: ConsultationTrigger
  expertModels: string[]
  synthesizerModel: string
  notes?: string
  stopDetail?: string
  history?: RuntimeMessage[]
  historyTokenBudget?: number
  contextWarning?: string
  rejectedFlags?: string[]
  sourceRunID?: string
  budgets?: ConsultationBudgets
  signal?: AbortSignal
  timeout?: number
}) {
  const notes = input.notes ?? await readFile(
    path.join(input.workspace.directory, "NOTES.md"),
    "utf8",
  ).catch(() => undefined)
  let stored: Awaited<ReturnType<typeof loadConsultationHistory>>
  let storedWarning: string | undefined
  if (input.history === undefined) {
    try {
      stored = await loadConsultationHistory(input.workspace.directory)
    } catch (error) {
      storedWarning = `failed to load persisted consultation history: ${errorText(error)}`
    }
  }
  const history = input.history ?? stored?.messages ?? []
  const artifacts = await recentArtifacts(input.workspace.directory, MAX_ARTIFACTS)
  const contextInput = {
    ...input,
    notes,
    history,
    contextWarning: [input.contextWarning, storedWarning].filter(Boolean).join("; ") || undefined,
    artifacts,
  }
  // Prompt ladder, largest first. The runtime's own prompt-token enforcement picks the first rung
  // that fits; each rung quarters the history budget and every rendered bound. Four rungs cover a
  // ~64x spread, which absorbs the observed 2x-and-up estimator miss on dense logs and CJK notes.
  const initialHistoryTokens = input.historyTokenBudget ??
    (input.budgets
      ? Math.max(1, Math.floor(input.budgets.expertTokens * 0.5))
      : DEFAULT_CONSULTATION_HISTORY_TOKENS)
  const ladder: Array<{ context: ConsultationContext; rung: ConsultationPromptRung }> = []
  for (let index = 0; index < 4; index += 1) {
    const scale = 1 / 4 ** index
    const historyTokens = Math.max(1, Math.floor(initialHistoryTokens * scale))
    const context = buildConsultationContext({
      ...contextInput,
      historyTokenBudget: historyTokens,
      scale,
    })
    ladder.push({
      context,
      rung: { index, prompt: expertPrompt(context), historyTokens, scale },
    })
  }
  const context = ladder[0]!.context
  const id = `consult-${new Date().toISOString().replace(/[:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`
  const consultation = await conductConsultation({
    id,
    trigger: input.trigger,
    sourceRunID: input.sourceRunID,
    expertModels: input.expertModels,
    synthesizerModel: input.synthesizerModel,
    context,
    ask: createRuntimeConsultant(input),
    budgets: input.budgets,
    promptRungs: ladder.map((item) => item.rung),
    synthesisContexts: ladder.map((item) => item.context),
    onExpertSettled: (settlement) =>
      persistExpertSettlement(input.workspace.directory, id, settlement),
    signal: input.signal,
    timeout: input.timeout,
  })
  await persistConsultation(input.workspace.directory, consultation)
  return consultation
}

async function persistExpertSettlement(
  directory: string,
  consultationID: string,
  settlement: ConsultationExpertSettlement,
) {
  const work = await realpath(path.join(directory, "work"))
  const state = path.join(work, ".boom")
  const existingState = await lstat(state).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existingState?.isSymbolicLink() || (existingState && !existingState.isDirectory()))
    throw new Error("Consultation state directory is not a real directory")
  if (!existingState) await mkdir(state, { recursive: true, mode: 0o700 })
  const stateRoot = await realpath(state)
  if (path.relative(work, stateRoot).startsWith(".."))
    throw new Error("Consultation state directory escapes work")
  const parts = path.join(stateRoot, "consultations")
  const existingParts = await lstat(parts).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existingParts?.isSymbolicLink() || (existingParts && !existingParts.isDirectory()))
    throw new Error("Consultation parts directory is not a real directory")
  if (!existingParts) await mkdir(parts, { recursive: true, mode: 0o700 })
  const partsRoot = await realpath(parts)
  if (path.relative(stateRoot, partsRoot).startsWith(".."))
    throw new Error("Consultation parts directory escapes state")
  const targetDirectory = path.join(partsRoot, consultationID)
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  const target = path.join(targetDirectory, `expert-${settlement.index + 1}.json`)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(settlement, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
}

export function consultationHint(consultation: Consultation) {
  if (consultation.degraded) return [
    "This multi-model consultation was degraded; no reliable multi-expert synthesis was produced. Read work/CONSULTATION.md first.",
    "Treat the surviving expert plans as unverified hypotheses; compare their evidence costs yourself; do not treat any single opinion as consensus.",
    `Degradation reason: ${consultation.degraded.detail}`,
    "",
    consultation.merged.text,
  ].join("\n")
  return [
    "This is the next-phase plan synthesized by the multi-model consultation. Read work/CONSULTATION.md first.",
    "Treat the plan as a route to test with evidence, not a settled conclusion; adjust it when a premise turns out to be false.",
    "",
    consultation.merged.text,
  ].join("\n")
}

export async function persistConsultation(directory: string, consultation: Consultation) {
  const runRoot = await realpath(path.resolve(directory))
  const work = path.join(runRoot, "work")
  const existingWork = await lstat(work).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existingWork?.isSymbolicLink() || (existingWork && !existingWork.isDirectory()))
    throw new Error("Consultation work directory is not a real directory")
  if (!existingWork) await mkdir(work, { recursive: true, mode: 0o700 })
  const workRoot = await realpath(work)
  if (path.relative(runRoot, workRoot).startsWith(".."))
    throw new Error("Consultation work directory escapes the run")
  const files: Array<[name: string, contents: string]> = [
    [
      "consultation.json",
      `${JSON.stringify(
        {
          id: consultation.id,
          trigger: consultation.trigger,
          source_run_id: consultation.sourceRunID,
          plans: consultation.plans,
          failures: consultation.failures,
          merged: consultation.merged,
          degraded: consultation.degraded,
          budgets: consultation.budgets,
          tokens: consultation.tokens,
          billable_tokens: consultation.billable,
          cost: consultation.cost,
          started_at: consultation.startedAt,
          finished_at: consultation.finishedAt,
        },
        undefined,
        2,
      )}\n`,
    ],
    [
      "CONSULTATION.md",
      [
        "# Multi-model consultation",
        "",
        `- Trigger: ${consultation.trigger}`,
        `- Consultation ID: ${consultation.id}`,
        ...(consultation.sourceRunID ? [`- Source run: ${consultation.sourceRunID}`] : []),
        `- Experts: ${consultation.plans.map((plan) => plan.model).join(", ")}`,
        `- Synthesizer: ${consultation.merged.model}`,
        ...(consultation.degraded ? [`- Degradation: ${consultation.degraded.detail}`] : []),
        ...(consultation.failures.length > 0
          ? [`- Failed experts: ${consultation.failures.map((failure) => failure.model).join(", ")}`]
          : []),
        ...consultation.plans.flatMap((plan, index) => [
          "",
          `## ${expertLabel(index)}: ${plan.model}`,
          "",
          plan.text,
        ]),
        ...consultation.failures.flatMap((failure) => [
          "",
          `## Failed expert: ${failure.model}`,
          "",
          failure.error,
        ]),
        "",
        `${consultation.degraded ? "## Degraded plan" : "## Synthesized plan"}: ${consultation.merged.model}`,
        "",
        consultation.merged.text,
        "",
      ].join("\n"),
    ],
  ]
  for (const [name, contents] of files) {
    const target = path.join(workRoot, name)
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
      throw new Error(`Consultation artifact is not a real file: ${name}`)
    // Atomic replace instead of an in-place write: a reader never observes a half-written artifact,
    // and the rename lands on this exact path rather than following any planted link.
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, target)
  }
}

export function addConsultationUsage<T extends {
  tokens: number
  billable: number
  cost: number
}>(outcome: T, consultation: Consultation): T {
  return {
    ...outcome,
    tokens: outcome.tokens + consultation.tokens,
    billable: outcome.billable + consultation.billable,
    cost: outcome.cost + consultation.cost,
  } as T
}

export function remainingLimits(limits: Limits, consultation: Consultation): Limits | undefined {
  const tokens = limits.tokens === undefined ? undefined : limits.tokens - consultation.billable
  const elapsed =
    new Date(consultation.finishedAt).valueOf() -
    new Date(consultation.startedAt).valueOf()
  const timeout = limits.timeout - Math.max(0, elapsed)
  if ((tokens !== undefined && tokens <= 0) || timeout <= 0) return undefined
  return { ...limits, ...(tokens === undefined ? {} : { tokens }), timeout }
}
