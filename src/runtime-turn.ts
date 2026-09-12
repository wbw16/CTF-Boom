import type {
  AgentRuntime,
  RuntimeConversation,
  RuntimeEvent,
  RuntimePromptResult,
  RuntimeResponsePart,
  RuntimeUsage,
} from "./runtime-contract.ts"

export type RuntimeTurnEvent = {
  event: RuntimeEvent
  agent: string
  model: string
  title: string
}

export type RuntimeTurnEventHandler = (input: RuntimeTurnEvent) => unknown

function trailingEventWindow() {
  return new Promise<void>((resolve) => setTimeout(resolve, 250))
}

const EMPTY_USAGE = (): RuntimeUsage => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

function addUsage(target: RuntimeUsage, usage: RuntimeUsage) {
  target.input += usage.input
  target.output += usage.output
  target.reasoning += usage.reasoning
  target.cache.read += usage.cache.read
  target.cache.write += usage.cache.write
}

function maxUsage(left: RuntimeUsage, right: RuntimeUsage): RuntimeUsage {
  return {
    input: Math.max(left.input, right.input),
    output: Math.max(left.output, right.output),
    reasoning: Math.max(left.reasoning, right.reasoning),
    cache: {
      read: Math.max(left.cache.read, right.cache.read),
      write: Math.max(left.cache.write, right.cache.write),
    },
  }
}

function billableUsage(usage: RuntimeUsage) {
  return usage.input + usage.output + usage.reasoning + usage.cache.write + usage.cache.read * 0.1
}

/**
 * One billable-token number for a usage snapshot, using the same weighting the runtime budget
 * check applies. Exported so callers that persist consumption records stay consistent with it.
 */
export function billableTokens(usage: RuntimeUsage): number {
  return Math.round(billableUsage(usage))
}

export class RuntimePromptFailure extends Error {
  constructor(
    message: string,
    readonly usage: RuntimeUsage,
    readonly cost: number,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = "RuntimePromptFailure"
  }
}

export function runtimeFailureUsage(error: unknown) {
  return error instanceof RuntimePromptFailure
    ? { usage: error.usage, cost: error.cost }
    : { usage: undefined, cost: 0 }
}

export type RuntimeSessionInfo = {
  /** Durable conversation id the caller should persist for later resumes. */
  id: string
  /** True when an existing durable session was resumed; false when a fresh one was created. */
  resumed: boolean
  /** Why resumption was impossible (resume failure, or runtime without resume support). */
  reason?: string
}

/**
 * Open the conversation for one prompt: the durable session when it can be resumed, otherwise a
 * fresh one. A runtime without resume support is not an error, but the caller still learns why the
 * session changed.
 */
async function openConversation(input: {
  runtime: AgentRuntime
  directory: string
  title: string
  signal?: AbortSignal
  tokenBudget?: number
  resumeSessionID?: string
}): Promise<{ conversation: RuntimeConversation; resumed: boolean; reason?: string }> {
  if (input.resumeSessionID !== undefined && input.resumeSessionID !== "") {
    if (!input.runtime.resumeConversation)
      return {
        conversation: await input.runtime.createConversation({
          directory: input.directory,
          title: input.title,
          signal: input.signal,
          tokenBudget: input.tokenBudget,
        }),
        resumed: false,
        reason: "the runtime does not support session resume; a fresh session was started",
      }
    try {
      return {
        conversation: await input.runtime.resumeConversation({
          directory: input.directory,
          id: input.resumeSessionID,
          signal: input.signal,
          tokenBudget: input.tokenBudget,
        }),
        resumed: true,
      }
    } catch (error) {
      return {
        conversation: await input.runtime.createConversation({
          directory: input.directory,
          title: input.title,
          signal: input.signal,
          tokenBudget: input.tokenBudget,
        }),
        resumed: false,
        reason: `the previous session ${input.resumeSessionID} could not be resumed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }
  return {
    conversation: await input.runtime.createConversation({
      directory: input.directory,
      title: input.title,
      signal: input.signal,
      tokenBudget: input.tokenBudget,
    }),
    resumed: false,
  }
}

export async function completeRuntimePrompt(input: {
  runtime: AgentRuntime
  directory: string
  title: string
  agent: string
  model: string
  /**
   * The turn's prompt. A function is resolved once the conversation exists and receives the actual
   * session outcome, so a caller can assemble a smaller continuation prompt when the durable
   * session really resumed, and a full overview when resumption failed.
   */
  prompt: string | ((session: RuntimeSessionInfo) => string)
  signal?: AbortSignal
  /** Hard billable-token ceiling for this one conversation, enforced from live step events. */
  tokenBudget?: number
  /** Resume this durable session instead of creating a disconnected new conversation. */
  resumeSessionID?: string
  /** Notified once the conversation exists and the prompt is resolved, before it is sent. */
  onSession?: (info: RuntimeSessionInfo) => unknown
  onEvent?: RuntimeTurnEventHandler
}) {
  const budgetAbort = input.tokenBudget === undefined ? undefined : new AbortController()
  const signal = budgetAbort
    ? input.signal
      ? AbortSignal.any([input.signal, budgetAbort.signal])
      : budgetAbort.signal
    : input.signal
  // Resume the durable session when the runtime supports it; a resume failure falls back to a
  // fresh conversation with the reason reported, so callers can persist both outcomes.
  const opened = await openConversation(input)
  const conversation = opened.conversation
  const sessionInfo: RuntimeSessionInfo = {
    id: conversation.id,
    resumed: opened.resumed,
    ...(opened.reason !== undefined ? { reason: opened.reason } : {}),
  }
  await Promise.resolve(input.onSession?.(sessionInfo)).catch(() => {})
  const promptText = typeof input.prompt === "function" ? input.prompt(sessionInfo) : input.prompt
  const subscription = new AbortController()
  let watching: Promise<void> | undefined
  let terminal: (() => void) | undefined
  const terminalEvent = new Promise<void>((resolve) => { terminal = resolve })
  const abort = () => {
    subscription.abort()
    void conversation.abort().catch(() => {})
  }
  const usage = EMPTY_USAGE()
  let usageSteps = 0
  let observedCost = 0
  let budgetError: string | undefined
  input.signal?.addEventListener("abort", abort, { once: true })
  try {
    input.signal?.throwIfAborted()
    if (input.onEvent || input.tokenBudget !== undefined) {
      // Subscribe before prompt so a fast provider cannot win the handshake and lose its first delta.
      const events = await conversation.events(subscription.signal)
      watching = (async () => {
        for await (const event of events) {
          if (event.sessionID !== conversation.id) continue
          if (event.type === "step-finish") {
            usageSteps += 1
            addUsage(usage, event.usage)
            observedCost = Math.max(observedCost, event.cost)
            const billable = billableUsage(usage)
            if (input.tokenBudget !== undefined && billable > input.tokenBudget && !budgetError) {
              budgetError = `runtime prompt token budget exceeded: ${Math.round(billable)} > ${input.tokenBudget}`
              budgetAbort?.abort(new Error(budgetError))
              void conversation.abort().catch(() => {})
            }
          }
          await Promise.resolve(input.onEvent?.({
            event,
            agent: input.agent,
            model: input.model,
            title: input.title,
          })).catch(() => {})
          if (
            event.type === "finish" ||
            event.type === "cancelled" ||
            (event.type === "conversation-state" && ["completed", "cancelled", "failed"].includes(event.state))
          ) terminal?.()
        }
      })().catch(() => {
        // The final prompt response remains authoritative. A transport-specific stream failure is
        // surfaced by the adapter as a diagnostic/result error when it changes the turn outcome.
      })
    }
    let result: RuntimePromptResult
    try {
      result = await conversation.prompt({
        agent: input.agent,
        model: input.model,
        text: promptText,
        signal,
      })
    } catch (error) {
      throw new RuntimePromptFailure(
        budgetError ?? (error instanceof Error ? error.message : String(error)),
        usage,
        observedCost,
        error,
      )
    }
    if (watching) {
      // A final response settles the turn, while a short bounded drain retains terminal/trailing events
      // without allowing an instance-wide SSE subscription to keep a one-shot stage open forever.
      await Promise.race([terminalEvent, watching, trailingEventWindow()]).catch(() => {})
    }
    if (budgetError) throw new RuntimePromptFailure(budgetError, usage, observedCost)
    if (usageSteps === 0) {
      // Providers that emit no step events must still respect the ask ceiling: fall back to the
      // result's own usage so a silent single-shot provider cannot dodge the budget check.
      if (input.tokenBudget !== undefined && result.usage) {
        const billable = billableUsage(result.usage)
        if (billable > input.tokenBudget)
          throw new RuntimePromptFailure(
            `runtime prompt token budget exceeded: ${Math.round(billable)} > ${input.tokenBudget}`,
            result.usage,
            result.cost,
          )
      }
      return result
    }
    // Native results include descendant task usage while root events contain only root steps. Use a
    // component-wise reconciliation so neither that aggregate nor compatibility event usage is lost
    // or double-counted.
    return {
      ...result,
      usage: result.usage ? maxUsage(usage, result.usage) : usage,
      cost: Math.max(result.cost, observedCost),
    }
  } finally {
    input.signal?.removeEventListener("abort", abort)
    subscription.abort()
    // A runtime that ignores its subscription abort must not pin the caller forever. The final
    // prompt result/error is authoritative; trailing events are useful but strictly best-effort.
    if (watching)
      await Promise.race([watching.catch(() => {}), trailingEventWindow()]).catch(() => {})
    const closing = conversation.close?.().catch(() => {})
    if (closing) await Promise.race([closing, trailingEventWindow()]).catch(() => {})
  }
}

export function runtimeReplyText(parts: RuntimeResponsePart[]) {
  const text = parts
    .flatMap((part) => part.type === "text" && part.text ? [part.text] : [])
    .join("\n")
    .trim()
  if (text !== "") return text
  return parts
    .flatMap((part) => part.type === "reasoning" && part.text ? [part.text] : [])
    .join("\n")
    .trim()
}

export function assertRuntimeResult(
  result: RuntimePromptResult,
  label: string,
  allowedFinishes: string[] = ["stop"],
) {
  if (result.error)
    throw new RuntimePromptFailure(
      `${label} failed: ${result.error.message}`,
      result.usage ?? EMPTY_USAGE(),
      result.cost,
      result.error,
    )
  if (result.finish !== undefined && !allowedFinishes.includes(result.finish))
    throw new RuntimePromptFailure(
      `${label} ended with finish reason: ${result.finish}`,
      result.usage ?? EMPTY_USAGE(),
      result.cost,
    )
  return result
}
