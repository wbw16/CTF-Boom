import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Challenge } from "./challenge.ts"
import {
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
import { budgetTokens, isTransient, messageTokens, type Limits } from "./session.ts"
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
const MAX_WORK = 24_000
const MAX_CLUES = 32_000
const MAX_DETAIL = 4_000
const MAX_ARTIFACTS = 20
export const DEFAULT_CONSULTATION_HISTORY_TOKENS = 48_000

function bounded(text: string | undefined, maximum: number) {
  const value = text?.trim() ?? ""
  if (value.length <= maximum) return value
  return `${value.slice(0, maximum)}\n\n[内容已截断，共 ${value.length} 字符]`
}

function challengeSummary(challenge: Challenge) {
  return [
    `题目：${challenge.slug}`,
    `分类：${challenge.category ?? "OTHER"}`,
    `Flag 格式：${challenge.flagFormat.trim() || "由求解模型判断"}`,
    `附件：${challenge.files.length === 0 ? "无" : challenge.files.join(", ")}`,
    challenge.remote ? `远程目标：${JSON.stringify(challenge.remote)}` : "",
    "",
    "题目说明：",
    bounded(challenge.description, MAX_DESCRIPTION) || "（无）",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function boundedHeadAndTail(text: string, maximum: number) {
  const value = text.trim()
  if (value.length <= maximum) return value
  if (maximum < 80) return value.slice(0, maximum)
  const marker = `\n...[内容已截断，共 ${value.length} 字符]...\n`
  const available = maximum - marker.length
  const head = Math.ceil(available * 0.6)
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (available - head))}`
}

function renderHistoryMessage(message: RuntimeMessage) {
  const lines: string[] = []
  for (const part of message.parts) {
    if (part.type === "tool") {
      lines.push(`工具：${part.tool ?? "unknown"}${part.state ? `（${part.state}）` : ""}`)
      if (part.input) lines.push(`输入：${boundedHeadAndTail(part.input, 1_500)}`)
      if (part.output) lines.push(`输出：${boundedHeadAndTail(part.output, 3_000)}`)
      if (part.error) lines.push(`错误：${boundedHeadAndTail(part.error, 1_500)}`)
    } else if (part.text) {
      lines.push(boundedHeadAndTail(part.text, 4_000))
    }
  }
  return lines.join("\n")
}

/**
 * Produce a consultation-only view of recent work without mutating the solver conversation. Manual
 * and post-compaction consultations both reduce their available snapshot here. The result is plain
 * text, so a very large API round can be shortened safely instead of erasing all consultation history.
 */
export function compressConsultationHistory(messages: RuntimeMessage[], maximum = MAX_WORK) {
  const limit = Math.max(0, Math.floor(maximum))
  if (limit === 0 || messages.length === 0) return "（暂无已完成的工作记录）"
  const selected: string[] = []
  let used = 0
  let omitted = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const rendered = renderHistoryMessage(messages[index]!)
    if (!rendered) continue
    const separator = selected.length === 0 ? 0 : 2
    const remaining = limit - used - separator
    if (remaining <= 0) {
      omitted = index + 1
      break
    }
    if (rendered.length > remaining) {
      selected.unshift(boundedHeadAndTail(rendered, remaining))
      omitted = index
      break
    }
    selected.unshift(rendered)
    used += separator + rendered.length
  }
  const body = selected.join("\n\n") || "（暂无已完成的工作记录）"
  return omitted > 0 ? `[较早的 ${omitted} 条记录已省略]\n${body}` : body
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
}): ConsultationContext {
  const historyMaximum = Math.min(
    MAX_WORK,
    Math.max(1, Math.floor(input.historyTokenBudget ?? DEFAULT_CONSULTATION_HISTORY_TOKENS)) * 4,
  )
  const recentWork = compressConsultationHistory(input.history ?? [], historyMaximum)
  const status = bounded(input.stopDetail, MAX_DETAIL)
  const work = [
    ...(status ? [`当前状态：${status}`, ""] : []),
    recentWork,
  ].join("\n")
  const clues = [
    bounded(input.notes, MAX_CLUES) || "（暂无线索记录）",
    ...(input.artifacts?.length
      ? ["", "相关产物：", ...input.artifacts.map((artifact) => `- ${artifact}`)]
      : []),
    ...(input.rejectedFlags?.length
      ? ["", "已拒绝 flag（不得重复提交）：", ...input.rejectedFlags.map((flag) => `- ${flag}`)]
      : []),
    ...(input.contextWarning
      ? ["", `上下文读取提示：${bounded(input.contextWarning, MAX_DETAIL)}`]
      : []),
  ].join("\n")
  return {
    challenge: challengeSummary(input.challenge),
    work,
    clues,
  }
}

export function renderConsultationContext(context: ConsultationContext) {
  return [
    "## 题目摘要",
    context.challenge,
    "",
    "## 已经完成的工作",
    context.work,
    "",
    "## 获得的线索",
    context.clues,
  ].join("\n")
}

function expertPrompt(context: ConsultationContext) {
  return [
    "你是一名 CTF 专家。请根据题目摘要、已经完成的工作和获得的线索，给出你对这道题的解决思路和下一步建议，避免重复已经尝试过的内容。",
    "",
    renderConsultationContext(context),
  ].join("\n")
}

function expertLabel(index: number) {
  return `专家 ${index + 1}`
}

function synthesisPrompt(context: ConsultationContext, plans: ConsultationReply[]) {
  return [
    "下面是几位 CTF 专家给出的思路。请结合题目摘要和当前进展，整理出最可行的解题方案。",
    "",
    renderConsultationContext(context),
    ...plans.flatMap((plan, index) => [
      "",
      `${expertLabel(index)}（${plan.model}）：`,
      plan.text,
    ]),
  ].join("\n")
}

export function allocateConsultationBudgets(totalTokens: number, expertCount: number): ConsultationBudgets {
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
  ))
  const expertPool = total - solverTokens - synthesizerTokens
  return {
    expertTokens: Math.max(1, Math.floor(expertPool / expertCount)),
    synthesizerTokens,
    solverTokens,
  }
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

function degradedPlan(
  plans: ConsultationReply[],
  degradation: ConsultationDegradation,
): ConsultationReply {
  const introduction = degradation.reason === "insufficient-experts"
    ? "会诊未取得足够的独立专家方案，无法形成多专家共识。以下仅存方案未经综合，请逐项验证后再执行。"
    : "综合模型未能完成语义合并。以下成功专家方案保持原样，请比较其证据依赖并逐项验证。"
  return {
    model: "boom/degraded",
    text: [
      introduction,
      `降级原因：${degradation.detail}`,
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
  const prompt = expertPrompt(input.context)
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
      let lastError = "unknown expert failure"
      let attempts = 0
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const remaining = input.budgets
          ? Math.max(0, input.budgets.expertTokens - billable)
          : undefined
        if (remaining !== undefined && remaining <= 0) break
        let completed: ConsultationReply
        try {
          attempts += 1
          completed = await input.ask({
            model,
            title: attempt === 0
              ? `Boom consult ${index + 1}/${input.expertModels.length}`
              : `Boom consult ${index + 1}/${input.expertModels.length} retry ${attempt}`,
            prompt,
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
          if (deadline?.aborted || !retryableConsultationFailure(error)) break
          if (attempt < retries && retryDelayMs > 0)
            await new Promise((resume) => setTimeout(resume, retryDelayMs * 2 ** attempt))
          continue
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
        detail: `仅 ${plans.length} 位专家成功，综合至少需要 ${CONSULT_EXPERTS.minimum} 位`,
      }
      merged = degradedPlan(plans, degraded)
    } else if (deadline?.aborted) {
      degraded = {
        reason: "synthesis-failed",
        detail: `Consultation timed out after ${Math.round(input.timeout! / 1000)}s; preserving completed expert plans`,
      }
      merged = degradedPlan(plans, degraded)
    } else {
      try {
        merged = await input.ask({
          model: input.synthesizerModel,
          title: "Boom consult synthesis",
          prompt: synthesisPrompt(input.context, plans),
          ...(input.budgets ? { tokenBudget: input.budgets.synthesizerTokens } : {}),
          signal,
        })
      } catch (error) {
        if (input.signal?.aborted) throw error
        degradationUsage = failedUsage(error)
        degraded = {
          reason: "synthesis-failed",
          detail: deadline?.aborted
            ? `Consultation timed out after ${Math.round(input.timeout! / 1000)}s during synthesis; preserving completed expert plans`
            : errorText(error),
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
  const context = buildConsultationContext({
    ...input,
    notes,
    history,
    contextWarning: [input.contextWarning, storedWarning].filter(Boolean).join("; ") || undefined,
    historyTokenBudget:
      input.historyTokenBudget ??
      (input.budgets
        ? Math.max(1, Math.floor(input.budgets.expertTokens * 0.5))
        : DEFAULT_CONSULTATION_HISTORY_TOKENS),
    artifacts,
  })
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
    "本次多模型会诊已降级，未形成可靠的多专家综合结论。先读 work/CONSULTATION.md。",
    "把保留下来的专家方案视为待验证假设；自行比较证据成本，不要把单一意见当作共识。",
    `降级原因：${consultation.degraded.detail}`,
    "",
    consultation.merged.text,
  ].join("\n")
  return [
    "这是多模型会诊综合出的下一阶段计划。先读 work/CONSULTATION.md。",
    "把计划当作需要用证据检验的路线，而不是已经成立的结论；发现前提不成立时应调整。",
    "",
    consultation.merged.text,
  ].join("\n")
}

export async function persistConsultation(directory: string, consultation: Consultation) {
  const work = path.join(directory, "work")
  await mkdir(work, { recursive: true })
  await writeFile(
    path.join(work, "consultation.json"),
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
    "utf8",
  )
  await writeFile(
    path.join(work, "CONSULTATION.md"),
    [
      "# 多模型会诊",
      "",
      `- 触发：${consultation.trigger}`,
      `- 会诊 ID：${consultation.id}`,
      ...(consultation.sourceRunID ? [`- 来源运行：${consultation.sourceRunID}`] : []),
      `- 专家：${consultation.plans.map((plan) => plan.model).join("、")}`,
      `- 综合：${consultation.merged.model}`,
      ...(consultation.degraded ? [`- 降级：${consultation.degraded.detail}`] : []),
      ...(consultation.failures.length > 0
        ? [`- 失败专家：${consultation.failures.map((failure) => failure.model).join("、")}`]
        : []),
      ...consultation.plans.flatMap((plan, index) => [
        "",
        `## ${expertLabel(index)}：${plan.model}`,
        "",
        plan.text,
      ]),
      ...consultation.failures.flatMap((failure) => [
        "",
        `## 专家失败：${failure.model}`,
        "",
        failure.error,
      ]),
      "",
      `${consultation.degraded ? "## 降级计划" : "## 综合计划"}：${consultation.merged.model}`,
      "",
      consultation.merged.text,
      "",
    ].join("\n"),
    "utf8",
  )
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
  const tokens = limits.tokens - consultation.billable
  const elapsed =
    new Date(consultation.finishedAt).valueOf() -
    new Date(consultation.startedAt).valueOf()
  const timeout = limits.timeout - Math.max(0, elapsed)
  if (tokens <= 0 || timeout <= 0) return undefined
  return { ...limits, tokens, timeout }
}
