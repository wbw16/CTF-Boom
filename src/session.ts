import { lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { loadCandidateSubmission } from "./candidate-submission.ts"
import { normalizeChallengeCategory, type Challenge } from "./challenge.ts"
import { persistConsultationHistory } from "./consultation-context.ts"
import { loadConsultationRequest } from "./consultation-request.ts"
import { latestArtifactWrite } from "./orchestration/artifacts.ts"
import type {
  AgentRuntime,
  RuntimeFailure,
  RuntimeMessage,
  RuntimePromptResult,
  RuntimeUsage,
} from "./runtime-contract.ts"
import { compilePromptText, createPromptBundle } from "./runtime/prompt.ts"
import type { Workspace } from "./workspace.ts"

export type Limits = {
  /** Abort once total tokens across the session exceed this. */
  tokens: number
  /** Abort after the same tool call is repeated this many times consecutively. */
  repeats: number
  /** Abort after this many milliseconds of wall-clock time. */
  timeout: number
  /** Boom's own per-turn text ceiling, independent of provider model metadata. */
  outputChars?: number
  /**
   * In-turn dead-end brake. Abort as `stalled` once this many billable tokens are spent without any
   * durable progress. Absent or non-positive disables the brake; the runner derives it from
   * `AUTONOMY_THRESHOLDS.stalledInTurnBudgetRatio` and the challenge budget.
   */
  stalledInTurnTokens?: number
  /**
   * No-activity watchdog. Abort as `silent` after this many milliseconds with no runtime event at all
   * while no tool is running. Absent or non-positive disables it.
   */
  silenceMs?: number
  /** Base delay for provider retries. Primarily injectable so conformance tests do not sleep. */
  retryBaseMs?: number
}

export type Outcome = {
  /**
   * Why the run ended. `empty` means the model returned without producing text or calling a single
   * tool — a silent early exit that must never be reported as success. `silent` means the runtime
   * stopped emitting events mid-turn with no tool running: a hung provider or agent loop, not a
   * judgement about the solving itself.
   */
  stop: "completed" | "budget" | "stalled" | "error" | "empty" | "timeout" | "aborted" | "silent" | "blocked" | "switched"
  /** True consumption, every category at face value. This is the number to report. */
  tokens: number
  /** Same usage with cache reads discounted; this is what the budget limit is compared against. */
  billable: number
  cost: number
  reply: string
  candidates: string[]
  primaryCandidate?: string
  alternatives?: string[]
  candidateSource?: "regex" | "model" | "submission"
  verification?: {
    level: "remote" | "local-checker" | "offline-derivation" | "unverified"
    detail: string
  }
  detail?: string
  /** Provider finish reason. Only `stop` is a normal ending; `length` means truncated or throttled. */
  finish?: string
  /** Part-type histogram for the final message, for diagnosing runs that produced nothing. */
  parts?: Record<string, number>
  /** One entry per retry, recording what failed. Empty when the run needed none. */
  retries?: string[]
  /** A host-owned transition that must run before the next solve turn. */
  consultationRequest?: {
    trigger: "agent-request" | "compaction"
    reason: string
    /** Exact durable request consumed by the host; absent for compaction-triggered consultations. */
    request?: {
      sessionID: string
      requestedAt: string
    }
    /** Durable solver session to resume after a live-session consultation. */
    resumeSessionID?: string
    /** Provider-neutral history seen by the live solver, preserved as complete messages. */
    history?: RuntimeMessage[]
    contextWarning?: string
  }
  /**
   * A user-requested live model/provider handoff captured at a complete message or tool boundary.
   * The next runtime should resume the durable session when possible, otherwise inject `history`
   * into a fresh conversation while retaining the same task workspace.
   */
  handoff?: {
    resumeSessionID: string
    history?: RuntimeMessage[]
    contextWarning?: string
  }
  /**
   * Bounded provider-neutral summary of the active context, exported when a turn dies mid-flight
   * (`silent` or `stalled`). The host injects it into the recovery turn so a fresh session can
   * continue from prior findings instead of redoing the analysis that preceded the failure.
   */
  recoveryContext?: {
    summary: string
    contextWarning?: string
  }
  /** Number of runtime context compactions completed during this turn. */
  compactions?: number
  /** Recorded experiment policy for this turn. */
  consultOnCompaction?: boolean
}

export type RunEvent = {
  at: number
  type: "session" | "text" | "tool" | "usage" | "retry" | "status"
  text?: string
  tool?: string
  status?: string
  tokens?: number
  billable?: number
  cost?: number
}

const AGENT = "boom"

/** How many times to retry a prompt that failed for a reason unrelated to the challenge. */
const RETRIES = 3

/** A truncated model response gets one bounded chance to recover without repeating bulk output. */
const LENGTH_RECOVERY_RETRIES = 1

/** Ambiguous or empty terminal responses get one bounded chance to continue in the same session. */
const AMBIGUOUS_FINISH_RECOVERY_RETRIES = 1
/** A content-safety refusal is often one rephrase away from a usable answer. */
const CONTENT_FILTER_RECOVERY_RETRIES = 2
/** A provider that cancels its own response may recover with a short resume prompt. */
const CANCELLED_RECOVERY_RETRIES = 2
/** Re-establishing an event subscription is cheaper than terminating the whole turn. */
const EVENT_SUBSCRIPTION_RETRIES = 2
const EVENT_SUBSCRIPTION_RETRY_MS = 500
const DEFAULT_OUTPUT_CHARS = 200_000

/**
 * How many times a bare `work/` mtime change may reset the in-turn brake within one turn.
 *
 * Unbounded, any file write keeps a dead end alive forever: a solver that downloads a tool or writes a
 * scratch script every few steps never accumulates the token gap the brake measures. `ctf-note` and
 * `ctf-submit` are exempt — they are durable by construction — so this only bounds the weak signal.
 */
const ARTIFACT_REPRIEVES = 3

/**
 * Default no-activity watchdog interval.
 *
 * Short enough to rescue a hung provider long before the wall-clock backstop, long enough that a slow
 * first token or an in-flight provider retry never trips it. Only consulted when nothing is running:
 * any pending or running tool call suppresses the watchdog outright, so this bounds idle silence only.
 */
export const DEFAULT_SILENCE_MS = 150_000

/**
 * How long to wait for the event watcher to finish after the subscription is aborted, before
 * abandoning it. Only reached when a runtime ignores its own abort signal.
 */
const WATCHER_DRAIN_MS = 250
const CONTEXT_SNAPSHOT_TIMEOUT_MS = 10_000
const MAX_CONTEXT_SNAPSHOT_CHARS = 200_000

function boundedHeadAndTail(value: string, maximum: number) {
  if (value.length <= maximum) return value
  const head = Math.floor(maximum * 0.6)
  const tail = maximum - head
  return [
    value.slice(0, head),
    `\n\n[活动上下文过长，中间 ${value.length - maximum} 个字符未导出]\n\n`,
    value.slice(-tail),
  ].join("")
}

/** Render only the provider-neutral fields preserved by the runtime adapter. */
export function renderRuntimeContext(messages: RuntimeMessage[]) {
  const rendered = messages.flatMap((message) => {
    const lines = [`### ${message.role} · ${message.id}`]
    for (const part of message.parts) {
      if (part.type === "tool") {
        lines.push(
          `- tool: ${part.tool ?? "unknown"}` +
          `${part.callID ? ` #${part.callID}` : ""}${part.state ? ` (${part.state})` : ""}`,
        )
        if (part.input) lines.push("  input:", part.input)
        if (part.output) lines.push("  output:", part.output)
        if (part.error) lines.push("  error:", part.error)
        continue
      }
      if (part.text) lines.push(`- ${part.type}:`, part.text)
    }
    return lines.length === 1 ? [] : [lines.join("\n")]
  }).join("\n\n")
  return boundedHeadAndTail(rendered, MAX_CONTEXT_SNAPSHOT_CHARS)
}

async function readActiveContext(
  conversation: import("./runtime-contract.ts").RuntimeConversation,
) {
  if (!conversation.activeContext)
    throw new Error("runtime does not expose the active context after compaction")
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const messages = await Promise.race([
      conversation.activeContext(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`active context snapshot timed out after ${CONTEXT_SNAPSHOT_TIMEOUT_MS}ms`)),
          CONTEXT_SNAPSHOT_TIMEOUT_MS,
        )
        timeout.unref?.()
      }),
    ])
    if (!renderRuntimeContext(messages))
      throw new Error("runtime returned an empty active context snapshot")
    return messages
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export class TextLoopDetector {
  private buffer = ""
  private lines = new Map<string, number>()

  push(delta: string) {
    this.buffer = (this.buffer + delta).slice(-32_768)
    for (const raw of delta.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.length < 24) continue
      const count = (this.lines.get(line) ?? 0) + 1
      this.lines.set(line, count)
      if (count >= 8) return `same non-trivial line repeated ${count} times`
    }
    for (const width of [64, 128, 256, 512, 1024, 2048]) {
      if (this.buffer.length < width * 5) continue
      const suffix = this.buffer.slice(-width)
      if (suffix.trim().length < width / 3) continue
      let repeats = 1
      while (repeats < 8 && this.buffer.slice(-(repeats + 1) * width, -repeats * width) === suffix) repeats += 1
      if (repeats >= 5) return `${width}-character block repeated ${repeats} times`
    }
    return undefined
  }
}

/** Flatten a provider error into one line for the run's `detail`. */
export function describe(error: unknown): string {
  const input = error as (RuntimeFailure & { data?: { message?: string } }) | undefined
  return input?.message ?? input?.data?.message ?? input?.name ?? JSON.stringify(error).slice(0, 160)
}

/**
 * Whether the provider refused an attachment the agent tried to send — typically a PDF or image that
 * is too large or that it cannot parse. Retrying the same request is futile, but the challenge is
 * still solvable: the agent needs to reach that content with a tool instead.
 */
export function isRejectedAttachment(error: unknown) {
  const info = error as RuntimeFailure & { data?: { message?: string; responseBody?: string } }
  const text = `${info?.message ?? info?.data?.message ?? ""} ${info?.responseBody ?? info?.data?.responseBody ?? ""}`.toLowerCase()
  return (
    text.includes("invalid_file") ||
    text.includes("badly formatted or corrupted") ||
    (text.includes("image") && text.includes("too large")) ||
    text.includes("unsupported image")
  )
}

/**
 * Whether a failure is worth retrying: caused by the transport or the provider's capacity rather than
 * by anything about this challenge. A malformed request will fail identically every time, so those
 * are left alone.
 */
export function isTransient(error: unknown): boolean {
  const info = error as RuntimeFailure & {
    cause?: unknown
    data?: { message?: string; statusCode?: number; isRetryable?: boolean; category?: string }
  }
  if (info?.retryable === true || info?.data?.isRetryable === true) return true
  if (["rate-limit", "server", "network", "malformed-response"].includes(
    String(info?.category ?? info?.data?.category),
  )) return true
  const status = info?.statusCode ?? info?.data?.statusCode
  if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500
  const message = (info?.message ?? info?.data?.message ?? info?.name ?? "").toLowerCase()
  if ([
    "certificate",
    "tls",
    "econnreset",
    "econnrefused",
    "etimedout",
    "enotfound",
    "socket hang up",
    "network",
    "fetch failed",
    "stream error",
    "overloaded",
    "temporarily",
    "service unavailable",
    "unavailable",
    "gateway timeout",
  ].some((pattern) => message.includes(pattern))) return true
  return info?.cause !== undefined && info.cause !== error && isTransient(info.cause)
}

export function classifyProviderFailure(error: unknown) {
  const info = error as RuntimeFailure & { data?: { message?: string; statusCode?: number } }
  const text = `${info?.name ?? ""} ${info?.message ?? info?.data?.message ?? ""}`.toLowerCase()
  if (/context.{0,20}(?:length|window|overflow)|too many input tokens|prompt is too long/.test(text)) return "input-context-overflow"
  if ((info?.statusCode ?? info?.data?.statusCode) === 429 || /rate.?limit|too many requests/.test(text)) return "provider-rate-limit"
  if (/empty response|no content/.test(text)) return "provider-empty-response"
  return isTransient(error) ? "provider-transient" : "provider-error"
}

export type Usage = RuntimeUsage

/** What a cached prompt token costs relative to a fresh one, for budget purposes. */
const CACHE_READ_WEIGHT = 0.1

/** Raw usage for one step: every category at face value. This is what gets reported. */
export function messageTokens(tokens: Usage) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/**
 * Usage for one step with cache reads discounted, for deciding whether a run has exhausted its
 * budget. A cache hit costs a fraction of a fresh prompt token, so charging it at face value would
 * cut off long tool-heavy runs — exactly the ones that legitimately re-send a large context each step.
 * Reporting still uses {@link messageTokens} so the displayed number stays the true consumption.
 */
export function budgetTokens(tokens: Usage) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.write + tokens.cache.read * CACHE_READ_WEIGHT
}

function callSignature(tool: string, input: Record<string, unknown>) {
  return `${tool}\u0000${JSON.stringify(input)}`
}

/**
 * Reject strings that match the flag format but are obviously the shape of a flag rather than a flag.
 * Agents routinely write the format out while explaining it, and those literals would otherwise be
 * reported as candidates alongside the real answer.
 */
function isPlaceholder(candidate: string) {
  const body = /\{(.*)\}$/s.exec(candidate)?.[1]
  if (body === undefined) return false
  if (body.trim() === "") return true
  // Ellipses, repeated fill characters, and the usual stand-in words.
  if (/^[.\s]*$/.test(body) || /^\.{2,}$/.test(body.trim())) return true
  if (/^[xX?*_\-\s]+$/.test(body)) return true
  return /^(your[_\s-]?flag([_\s-]?here)?|flag[_\s-]?here|redacted|placeholder|todo|xxx+)$/i.test(body.trim())
}

export function findCandidates(text: string, flagFormat: string) {
  if (flagFormat.trim() === "") return []
  let pattern: RegExp
  try {
    pattern = new RegExp(flagFormat, "g")
  } catch {
    return []
  }
  return [...new Set(text.match(pattern) ?? [])].filter((candidate) => !isPlaceholder(candidate))
}

// The task prompt is a contract, not a lesson. Domain strategies and tool sequences belong to the
// model; Boom supplies only the input locations and required durable outputs.
const PROMPT = [
  "当前工作目录包含一道 CTF 题目：challenge/ 是只读输入，work/ 是工作目录，NOTES.md 是跨轮次持久记录。",
  "目标是获得 flag。得到一个可信候选后立刻通过 ctf-submit 提交，不要等待 Writeup；宿主会立即结束本轮并判定候选。",
  "只有宿主在后续轮次明确告知候选正确后，才生成可复现的 work/WRITEUP.md。候选被拒绝时继续解题，不要重复提交已否定值。",
  "关键突破、已确认事实和有证据的排除结论需要保存在 NOTES.md。如何解题和使用工具完全由你决定。",
  "长任务中不要只追加流水账；需要交接时用 ctf-note kind=checkpoint 把当前目标、事实、假设、排除方向和下一步压缩成一份紧凑摘要。",
].join("")

const CATEGORY_GUIDANCE = {
  WEB: "优先检查 HTTP 行为、路由、参数、会话与鉴权、前后端源码及 Web 输入边界；没有证据时不要先投入二进制利用。",
  PWN: "优先确认架构、保护、输入输出协议、内存破坏面和可复现利用链。",
  REVERSE: "优先确认架构与运行时，结合静态和动态分析还原校验逻辑或数据变换。",
  CRYPTO: "优先区分编码与密码算法，整理参数、数学关系和实现缺陷，并用可复现实验验证推导。",
  MISC: "优先做文件类型、元数据、编码、隐写、取证和协议流量分诊，再沿已有证据深入。",
  MOBILE: "优先确认平台与包结构，检查清单、资源、存储、网络行为、原生库和运行时校验。",
  FORENSICS: "优先保护证据完整性，梳理时间线、文件系统、内存或流量中的可验证痕迹。",
  AI: "优先明确模型、数据、输入输出和评分边界，再检查提示注入、数据处理或模型实现缺陷。",
  HARDWARE: "优先确认器件、固件、接口和信号协议，从可观测输入输出建立证据链。",
  BLOCKCHAIN: "优先检查合约状态、权限、调用路径、数值边界和可复现交易序列。",
  OSINT: "优先从题目给出的公开线索建立来源可靠、时间一致且可交叉验证的证据链。",
  OTHER: "先完成题型分诊，再依据题目文件、服务和实验结果选择方向。",
} as const

export type SolverPromptCapabilities = {
  /** A connected, Boom-managed headless IDA MCP is callable by the primary solver. */
  headlessIda?: boolean
}

const HEADLESS_IDA_GUIDANCE = [
  "本题可使用 headless IDA Pro MCP（idalib）。处理原生可执行文件时，优先将目标从 challenge/ 复制到 work/ida/，再使用 idb_open 的 force_headless 模式完成自动分析，并结合 survey_binary、list_funcs、decompile、xrefs_to、callees 和 callgraph 恢复程序逻辑；不要直接在 challenge/ 下生成 IDB。",
  "若 IDA 打开、自动分析或反编译失败，记录具体错误，再回退到 objdump、LLDB、Python、angr 等工具；不要仅因 shell 工具可用就跳过 IDA。成功打开 IDB 后应围绕入口、校验路径、关键字符串及其交叉引用查询相关函数，避免无目的地反编译全部函数。",
  "IDA 的大型查询结果会自动归档到 work/ida/results/，上下文里只保留摘要与文件指针：用 idalib_boom_ida_get 按行分段读取细节，用 idalib_boom_ida_list 查看已归档查询。归档属于持久产物，恢复回合应优先读取，不要重复查询同样的函数。",
].join("")

/** Give the solver a bounded prior without overriding contrary evidence from the challenge. */
export function challengeCategoryPrompt(
  category?: string,
  capabilities: SolverPromptCapabilities = {},
) {
  if (!category?.trim()) return ""
  const normalized = normalizeChallengeCategory(category)
  return [
    `你现在正在解一道 CTF ${normalized} 类型题目。`,
    CATEGORY_GUIDANCE[normalized],
    capabilities.headlessIda && (normalized === "REVERSE" || normalized === "PWN")
      ? HEADLESS_IDA_GUIDANCE
      : "",
    "分类只用于安排排查优先级；如果与题目文件、服务或实验结果冲突，以实际证据为准。",
  ].filter(Boolean).join("")
}

function withCategoryPrompt(
  prompt: string,
  category?: string,
  capabilities: SolverPromptCapabilities = {},
) {
  const context = challengeCategoryPrompt(category, capabilities)
  return context ? `${context}\n\n${prompt}` : prompt
}

export function buildPrompt(
  hint?: string,
  category?: string,
  capabilities: SolverPromptCapabilities = {},
) {
  const trimmed = hint?.trim()
  const prompt = trimmed ? `${PROMPT}\n\n用户追加提示：${trimmed}` : PROMPT
  return compileTurnPrompt("turn:solve", withCategoryPrompt(prompt, category, capabilities))
}

const CONTINUE_PROMPT = [
  "继续完成同一道题。challenge/ 是只读输入，work/ 和 NOTES.md 包含此前工作。",
  "目标仍是获得 flag；得到可信候选后立刻通过 ctf-submit 提交。候选正确前不要生成最终 Writeup。",
  "保留关键进展和有证据的排除结论；如何继续完全由你决定。",
  "本轮开始时已自动注入紧凑交接摘要，先按摘要恢复；若与工作区实际文件冲突，以实际文件为准。",
].join("")

export function buildContinuationPrompt(
  hint?: string,
  category?: string,
  capabilities: SolverPromptCapabilities = {},
) {
  const trimmed = hint?.trim()
  return compileTurnPrompt(
    "turn:continue",
    withCategoryPrompt(
      trimmed ? `${CONTINUE_PROMPT}\n\n用户追加提示：${trimmed}` : CONTINUE_PROMPT,
      category,
      capabilities,
    ),
  )
}

const WRITEUP_PROMPT = [
  "平台或用户已经确认候选 flag 正确。现在停止继续猜测或提交 flag。",
  "请根据 challenge/、work/ 与 NOTES.md 中已有证据生成最终 work/WRITEUP.md，包含正确 flag、完整推导和可复现步骤。",
  "Writeup 必须使用中文撰写：标题、说明、推导和复现步骤均使用中文；命令、代码、文件路径与 flag 保持原样。",
  "如果存在实际用于求解或验证 flag 的脚本，必须在 Writeup 中标明脚本路径和运行方式，并用代码块嵌入脚本的完整源码；不得只引用脚本文件，也不得省略、截断或用省略号代替任何代码。",
  "不要调用 ctf-submit；完成 Writeup 后简短结束本轮。",
].join("")

export function buildWriteupPrompt(flag: string, hint?: string, category?: string) {
  const extra = hint?.trim()
  return compileTurnPrompt(
    "turn:writeup",
    withCategoryPrompt(
      `${WRITEUP_PROMPT}\n\n已确认 flag：${flag}${extra ? `\n\n补充说明：${extra}` : ""}`,
      category,
    ),
  )
}

function compileTurnPrompt(source: string, content: string) {
  return compilePromptText(createPromptBundle({
    turn: [{ source, content, stability: "turn", cacheable: false, sensitivity: "task" }],
  }), ["turn"])
}

// Sent when a transient provider failure interrupted the previous turn. The session is the same one,
// so this resumes rather than restarts: work/ and NOTES.md still hold everything done so far.
const RESUME = [
  "上一轮因运行服务故障中断。work/ 和 NOTES.md 保留了已有工作，请继续完成原目标。",
].join("")

// A `length` finish is a completed provider call, not a transport failure. Re-sending the original
// prompt encourages a degenerated model to emit the same long sequence again, so recovery explicitly
// redirects bulk data to disk and asks for a durable checkpoint before continuing.
const LENGTH_RECOVERY = [
  "上一回复因达到 Provider 单次输出长度上限而被截断。",
  "请将需要保留的已有进展写入 work/ 和 NOTES.md，并继续完成原目标。",
].join("")

const UNKNOWN_RECOVERY = [
  "上一回复的 Provider 结束状态不明确，可能被中途截断。原始输出已保存在 work/.boom/recovery/。",
  "不要重复大段输出；先核对 work/、NOTES.md 和已完成的工具结果，然后从中断处继续。若已有可信候选，立即调用 ctf-submit。",
].join("")

const EMPTY_RECOVERY = [
  "上一轮 Provider 没有返回可用内容。这是运行故障，不代表题目已经完成。",
  "请基于 work/ 与 NOTES.md 中的现有状态继续原目标，不要重新执行已有证据表明无效的动作。",
].join("")

const CONTENT_FILTER_RECOVERY = [
  "上一回复因内容安全策略被拦截，没有任何可用输出。这是运行故障，不代表题目已经完成。",
  "请换一种中性措辞，避免重复触发过滤；基于 work/ 与 NOTES.md 中的现有状态继续原目标。",
].join("")

const CANCELLED_RECOVERY = [
  "上一轮 Provider 在返回完整结果前主动取消了响应。这是运行故障，不代表题目已经完成。",
  "请基于 work/ 与 NOTES.md 中的现有状态从中断处继续，不要重做已有证据表明无效的动作。",
].join("")

const PROVIDER_HANDOFF = [
  "用户刚刚切换了当前任务使用的模型或 Provider。",
  "这是同一任务的受控交接：work/、NOTES.md、已完成的工具结果和下面的活动上下文都属于此前进展。",
  "先从最后一个未完成步骤继续，不要重做已完成工作；如果兼容性提示指出某项能力不可用，请改用现有工具或文件状态完成目标。",
].join("")

// Sent when the provider rejected a file the agent attached. Naming the cause matters: otherwise it
// retries the same read and loses the run to a failure it could have worked around.
const REJECTED = [
  "上一轮提交给 Provider 的文件附件被拒收。该附件无法按原方式传入模型，请继续完成原目标。",
].join("")

/** Drive one challenge while enforcing token and repeated-call limits from the live event stream. */
export async function runChallenge(input: {
  runtime: AgentRuntime
  challenge: Challenge
  workspace: Workspace
  model: string
  limits: Limits
  hint?: string
  continuation?: boolean
  /** Runtime capabilities that are both connected and callable by the primary solver. */
  promptCapabilities?: SolverPromptCapabilities
  /** Resume this durable runtime session instead of creating a disconnected solver session. */
  resumeSessionID?: string
  /** Provider-neutral context used only when the new runtime cannot resume the durable session. */
  handoffHistory?: RuntimeMessage[]
  /** Non-blocking capability differences to surface to the replacement model. */
  handoffWarning?: string
  /** Request a live handoff at the next complete assistant-message or tool-result boundary. */
  handoffSignal?: AbortSignal
  /** Resolve user-facing events for the reason that requested this otherwise generic handoff. */
  handoffKind?: () => "model-switch" | "consultation"
  /** Explicit experiment policy. Defaults to the repaired-Boom baseline: consult after compaction. */
  consultOnCompaction?: boolean
  purpose?: "solve" | "writeup"
  acceptedFlag?: string
  signal?: AbortSignal
  onEvent?: (event: RunEvent) => unknown
}): Promise<Outcome> {
  if (input.signal?.aborted)
    return {
      stop: "aborted",
      tokens: 0,
      billable: 0,
      cost: 0,
      reply: "",
      candidates: [],
      detail: "aborted by user",
    }

  if (input.handoffSignal?.aborted && !input.resumeSessionID)
    return {
      stop: "switched",
      tokens: 0,
      billable: 0,
      cost: 0,
      reply: "",
      candidates: [],
      detail: input.handoffKind?.() === "consultation"
        ? "consultation requested before the previous model started"
        : "model/provider switch requested before the previous model started",
    }

  let resumeWarning: string | undefined
  let resumed = false
  let conversation: import("./runtime-contract.ts").RuntimeConversation
  if (input.resumeSessionID && input.runtime.resumeConversation) {
    try {
      conversation = await input.runtime.resumeConversation({
        directory: input.workspace.directory,
        id: input.resumeSessionID,
      })
      resumed = true
    } catch (error) {
      resumeWarning = `原会话无法由新 Runtime 恢复：${describe(error)}`
      conversation = await input.runtime.createConversation({
        directory: input.workspace.directory,
        title: `Boom: ${input.challenge.slug}`,
      })
    }
  } else {
    if (input.resumeSessionID)
      resumeWarning = "新 Runtime 不支持恢复原会话，已使用活动上下文建立同任务的新会话"
    conversation = await input.runtime.createConversation({
      directory: input.workspace.directory,
      title: `Boom: ${input.challenge.slug}`,
    })
  }
  const sessionID = conversation.id
  const emit = async (event: Omit<RunEvent, "at"> & { at?: number }) => {
    if (!input.onEvent) return
    await Promise.resolve(input.onEvent({ ...event, at: event.at ?? Date.now() })).catch(() => {})
  }
  await emit({ type: "session", status: resumed ? "resumed" : "created", text: sessionID })
  if (resumeWarning)
    await emit({ type: "status", status: "model.switch.context-fallback", text: resumeWarning })

  let tokens = 0
  /** Same usage with cache reads discounted; only this is compared against the limit. */
  let billable = 0
  let cost = 0
  let steps = 0
  let stop: Outcome["stop"] | undefined
  let detail: string | undefined
  let previous: string | undefined
  let repeats = 1
  const seenCalls = new Set<string>()
  const seenToolStates = new Set<string>()
  const subscription = new AbortController()
  const loopDetector = new TextLoopDetector()
  let outputChars = 0
  const outputLimit = Math.max(8_000, Math.floor(input.limits.outputChars ?? DEFAULT_OUTPUT_CHARS))
  const runStarted = Date.now()

  // In-turn dead-end brake state. `billableAtDurable` moves only on a durable signal, never on a plain
  // tool call, so a solver that keeps calling tools while producing nothing still drifts away from it.
  const brakeLimit = Math.floor(input.limits.stalledInTurnTokens ?? 0)
  let billableAtDurable = 0
  let artifactFloor = brakeLimit > 0
    ? await latestArtifactWrite(input.workspace.directory).catch(() => 0)
    : 0
  let brakeUsed = false
  let artifactReprieves = 0
  let compactions = 0
  const consultOnCompaction = input.consultOnCompaction !== false
  let consultationHistory: RuntimeMessage[] | undefined
  let contextWarning: string | undefined
  let contextCaptureAttempted = false
  const runningCalls = new Set<string>()
  let handoffRequested = input.handoffSignal?.aborted === true
  let handoff: Outcome["handoff"]
  let recoveryContext: Outcome["recoveryContext"]
  const captureConsultationHistory = async (reportFailure = true) => {
    if (contextCaptureAttempted) return consultationHistory
    contextCaptureAttempted = true
    try {
      const messages = await readActiveContext(conversation)
      consultationHistory = messages
      try {
        await persistConsultationHistory({
          directory: input.workspace.directory,
          sessionID,
          messages,
        })
      } catch (error) {
        // The in-memory snapshot is still sufficient for an immediate runtime handoff. Persistence
        // failure is a compatibility warning, not a reason to discard context already exported.
        contextWarning = describe(error)
        if (reportFailure)
          await emit({
            type: "status",
            status: "context.snapshot.persist-failed",
            text: contextWarning,
          })
      }
      return messages
    } catch (error) {
      contextWarning = describe(error)
      if (reportFailure)
        await emit({
          type: "status",
          status: "context.snapshot.failed",
          text: contextWarning,
        })
      return undefined
    }
  }
  /**
   * Record a durable signal: a completed `ctf-note` or `ctf-submit`. Besides sliding the token gap this
   * restores the reprieve budget, because a solver that is recording real progress must not be starved
   * of reprieves by the incidental file writes that accompany it.
   */
  const markDurable = () => {
    billableAtDurable = billable
    artifactReprieves = 0
  }

  /**
   * Stage two of the brake. Stage one (the token counter) is only a suspicion: artifact writes emit no
   * runtime event, so spend alone cannot distinguish a solver stuck in a dead end from one quietly
   * producing files. Confirm against the filesystem, and never cut a turn while a tool is still
   * running — brute force and large parses are legitimately slow, and the wall-clock timeout already
   * covers a genuinely hung one.
   *
   * A bare file write is weak evidence of progress: downloading a tool or emitting a scratch script
   * moves the newest mtime without advancing the solve. `ctf-note` and `ctf-submit` are durable by
   * construction and reset the brake without limit, but mtime alone only buys a bounded number of
   * reprieves per turn, after which the brake is allowed to fire through it.
   */
  const brakeConfirms = async () => {
    if (runningCalls.size > 0) return false
    const newest = await latestArtifactWrite(input.workspace.directory).catch(() => 0)
    if (newest > artifactFloor) {
      artifactFloor = newest
      if (artifactReprieves >= ARTIFACT_REPRIEVES) return true
      artifactReprieves += 1
      // Slide the token gap without going through `markDurable`: a bare write is not durable progress
      // and must not refund the reprieve it just consumed.
      billableAtDurable = billable
      return false
    }
    return true
  }

  // No-activity watchdog. The wall-clock deadline is the only other backstop for a runtime that stops
  // responding mid-turn, and on a long challenge that means waiting out the whole budget in silence.
  // This fires far sooner, but only when nothing is running: a slow tool (brute force, a large parse)
  // emits no events for minutes at a time and is legitimate, so a pending or running call suppresses
  // it entirely. Reset by every event of any kind, including reasoning deltas, so a model that thinks
  // for a long time before answering is never cut off.
  //
  // Declared before `abort` because `abort` clears it and can run before the prompt is ever sent.
  const silenceLimit = Math.floor(input.limits.silenceMs ?? 0)
  let silence: ReturnType<typeof setTimeout> | undefined
  const clearSilence = () => {
    if (silence) clearTimeout(silence)
    silence = undefined
  }
  const armSilence = () => {
    if (silenceLimit <= 0 || stop !== undefined) return
    clearSilence()
    silence = setTimeout(() => {
      if (stop !== undefined) return
      if (runningCalls.size > 0) {
        armSilence()
        return
      }
      void abort(
        "silent",
        `no runtime activity for ${Math.round(silenceLimit / 1000)}s with no tool running: ` +
          `provider or agent loop stopped responding`,
      )
    }, silenceLimit)
    // Never hold the process open on the watchdog alone.
    silence.unref?.()
  }

  const abort = async (reason: Outcome["stop"], why: string) => {
    // Also break an event-stream handshake that is still in flight. Without this, a stop received
    // between conversation creation and event subscription could wait forever without a prompt.
    subscription.abort()
    if (stop !== undefined) return
    stop = reason
    detail = why
    clearSilence()
    // A `silent` or `stalled` stop abandons the in-session analysis. Export a bounded summary before
    // aborting the provider so the recovery turn can resume from it instead of redoing the work.
    // The runtime may already be unresponsive, so this is best-effort and strictly time-boxed.
    if ((reason === "silent" || reason === "stalled") && recoveryContext === undefined) {
      await captureConsultationHistory(false)
      const summary = consultationHistory ? renderRuntimeContext(consultationHistory) : ""
      recoveryContext = summary.trim() || contextWarning
        ? { summary, ...(contextWarning ? { contextWarning } : {}) }
        : undefined
    }
    await conversation.abort().catch(() => {})
    await emit({ type: "status", status: reason, text: why })
  }

  const handoffAtBoundary = async (boundary: "message" | "tool") => {
    if (!handoffRequested || stop !== undefined || runningCalls.size > 0) return false
    // Stop the old provider before reading its durable context. This prevents it from beginning the
    // next model step while the snapshot request is in flight; completed tool results remain durable.
    const consultation = input.handoffKind?.() === "consultation"
    await abort(
      "switched",
      consultation
        ? `consultation accepted at ${boundary} boundary`
        : `model/provider switch accepted at ${boundary} boundary`,
    )
    await captureConsultationHistory(false)
    handoff = {
      resumeSessionID: sessionID,
      ...(consultationHistory ? { history: consultationHistory } : {}),
      ...(contextWarning ? { contextWarning } : {}),
    }
    await emit({
      type: "status",
      status: consultation ? "consultation.manual.boundary" : "model.switch.boundary",
      text: `${boundary} · ${sessionID}`,
    })
    return true
  }

  const externalAbort = () => {
    void abort("aborted", "aborted by user")
  }
  const externalHandoff = () => {
    handoffRequested = true
    const consultation = input.handoffKind?.() === "consultation"
    void emit({
      type: "status",
      status: consultation ? "consultation.manual.waiting-boundary" : "model.switch.waiting-boundary",
      text: runningCalls.size > 0 ? "等待当前工具返回" : "等待当前消息完成",
    })
  }
  input.signal?.addEventListener("abort", externalAbort, { once: true })
  input.handoffSignal?.addEventListener("abort", externalHandoff, { once: true })
  // The signal may have fired while conversation creation was in flight, before the listener existed.
  // Re-check immediately after registering so that window cannot lose a stop request.
  if (input.signal?.aborted) await abort("aborted", "aborted by user")
  const beforePromptOutcome = (): Outcome => ({
    stop: stop ?? "error",
    tokens,
    billable: Math.round(billable),
    cost,
    reply: "",
    candidates: [],
    detail,
  })
  if (stop !== undefined) {
    input.signal?.removeEventListener("abort", externalAbort)
    input.handoffSignal?.removeEventListener("abort", externalHandoff)
    return beforePromptOutcome()
  }

  // A wall-clock ceiling is the only backstop that covers stalls the token and repeat limits cannot
  // see — a hung tool, a provider that stops responding, or a permission request with nobody to
  // answer it. Without it an unattended batch can block indefinitely on one challenge.
  const deadline = setTimeout(() => {
    void abort("timeout", `wall-clock timeout after ${Math.round(input.limits.timeout / 1000)}s`)
  }, input.limits.timeout)

  // Start the no-activity watchdog only once the turn is actually about to run.
  armSilence()

  let events: AsyncIterable<import("./runtime-contract.ts").RuntimeEvent> | undefined
  for (let attempt = 0; attempt <= EVENT_SUBSCRIPTION_RETRIES; attempt += 1) {
    try {
      events = await conversation.events(subscription.signal)
      break
    } catch (error) {
      if (attempt >= EVENT_SUBSCRIPTION_RETRIES) {
        if (stop === undefined)
          await abort("error", `event subscription failed after ${EVENT_SUBSCRIPTION_RETRIES + 1} attempts: ${describe(error)}`)
        clearTimeout(deadline)
        clearSilence()
        input.signal?.removeEventListener("abort", externalAbort)
        input.handoffSignal?.removeEventListener("abort", externalHandoff)
        return beforePromptOutcome()
      }
      await emit({
        type: "retry",
        status: `event-subscription-${attempt + 1}`,
        text: describe(error),
      })
      if (EVENT_SUBSCRIPTION_RETRY_MS > 0)
        await new Promise((resume) => setTimeout(resume, EVENT_SUBSCRIPTION_RETRY_MS * 2 ** attempt))
    }
  }
  if (!events) {
    clearTimeout(deadline)
    clearSilence()
    input.signal?.removeEventListener("abort", externalAbort)
    input.handoffSignal?.removeEventListener("abort", externalHandoff)
    return beforePromptOutcome()
  }
  const watching = (async () => {
    for await (const event of events) {
      if (event.sessionID !== sessionID) continue
      // Any event at all is proof the runtime is still alive, so the watchdog restarts here rather
      // than per event type.
      armSilence()
      if (event.type === "compaction") {
        await emit({
          type: "status",
          status: `context.compaction.${event.state}`,
          text: event.error ? describe(event.error) : undefined,
        })
        if (
          event.state === "completed" &&
          input.purpose !== "writeup" &&
          stop === undefined
        ) {
          compactions += 1
          if (consultOnCompaction) {
            await captureConsultationHistory()
            await abort(
              "completed",
              "runtime context compacted; policy requires multi-model consultation before continuing",
            )
          }
        }
        continue
      }
      if (event.type === "step-finish") {
        // Each step-finish reports that step's own usage — upstream overwrites `tokens` per step and
        // only accumulates `cost`. Summing is therefore required to bound a whole session; taking the
        // maximum would charge a multi-step run for its single largest step.
        steps += 1
        tokens += messageTokens(event.usage)
        billable += budgetTokens(event.usage)
        cost = Math.max(cost, event.cost)
        if (billable > input.limits.tokens)
          await abort(
            "budget",
            `token budget exceeded: ${Math.round(billable)} > ${input.limits.tokens} ` +
              `(cache reads weighted ${CACHE_READ_WEIGHT}; ${tokens} raw)`,
          )
        if (
          brakeLimit > 0 &&
          !brakeUsed &&
          stop === undefined &&
          billable - billableAtDurable >= brakeLimit &&
          await brakeConfirms()
        ) {
          brakeUsed = true
          await abort(
            "stalled",
            `no durable progress for ${Math.round(billable - billableAtDurable)} billable tokens ` +
              `(limit ${brakeLimit}): no artifact, note, or candidate. Likely a dead end rather than ` +
              `slow progress.`,
          )
        }
        await emit({
          type: "usage",
          status: event.reason,
          tokens,
          billable: Math.round(billable),
          cost,
        })
        await handoffAtBoundary("message")
        continue
      }

      if (event.type === "text-delta") {
        outputChars += event.delta.length
        await emit({ type: "text", text: event.delta })
        if (outputChars > outputLimit) {
          await abort("stalled", `Boom output ceiling exceeded: ${outputChars} > ${outputLimit} characters`)
          continue
        }
        const loop = loopDetector.push(event.delta)
        if (loop) await abort("stalled", `degenerate text repetition detected: ${loop}`)
        continue
      }

      if (event.type === "retry") {
        await emit({
          type: "retry",
          status: String(event.attempt),
          text: describe(event.error),
        })
        continue
      }

      if (event.type !== "tool-state") continue
      // Update boundary state before yielding the visible event. A settings request can arrive from
      // the UI as soon as that event renders; it must already see the tool as in flight.
      if (event.state.status === "running" || event.state.status === "pending")
        runningCalls.add(event.callID)
      else runningCalls.delete(event.callID)
      const toolState = `${event.callID}:${event.state.status}`
      if (!seenToolStates.has(toolState)) {
        seenToolStates.add(toolState)
        const stateText =
          event.state.status === "error"
            ? event.state.error
            : event.state.status === "running" || event.state.status === "pending"
              ? event.tool === "ctf-submit"
                ? "structured candidate submission"
                : JSON.stringify(event.state.input).slice(0, 500)
              : event.state.title
        await emit({
          type: "tool",
          tool: event.tool,
          status: event.state.status,
          text: stateText,
        })
      }
      // These tools write host-validated durable state. No title matching is needed.
      if (
        (event.tool === "ctf-note" || event.tool === "ctf-consult" || event.tool === "ctf-submit") &&
        event.state.status === "completed"
      ) markDurable()
      if (
        event.state.status !== "running" &&
        event.state.status !== "pending" &&
        await handoffAtBoundary("tool")
      ) continue
      if (
        event.tool === "ctf-consult" &&
        event.state.status === "completed" &&
        input.purpose !== "writeup" &&
        stop === undefined
      ) {
        await captureConsultationHistory()
        await abort("completed", "solver requested an independent multi-model consultation")
        continue
      }
      if (
        event.tool === "ctf-submit" &&
        event.state.status === "completed" &&
        input.purpose !== "writeup" &&
        stop === undefined
      ) {
        await abort("completed", "candidate submitted; solver turn ended for platform or user verification")
        continue
      }
      if (event.state.status !== "running" || seenCalls.has(event.callID)) continue
      seenCalls.add(event.callID)
      const signature = callSignature(event.tool, event.state.input ?? {})
      if (signature === previous) repeats += 1
      else {
        previous = signature
        repeats = 1
      }
      if (repeats >= input.limits.repeats)
        await abort("stalled", `repeated the same ${event.tool} call ${repeats}x: ${signature.slice(0, 120)}`)
    }
  })()

  // Transient provider failures — a TLS handshake, a 5xx, a rate limit — otherwise kill the whole
  // challenge on first contact and burn its entire budget for nothing. Retrying continues the same
  // session, so every file and note the agent already produced stays in place.
  // Abort can also arrive while the event subscription is being established. Never send a prompt
  // after the session has already been stopped.
  if (input.signal?.aborted && stop === undefined) await abort("aborted", "aborted by user")
  const sendPrompt = (text: string) =>
    conversation.prompt({ agent: AGENT, model: input.model, text })
  const retried: string[] = []
  const retryBaseMs = Math.max(0, Math.floor(input.limits.retryBaseMs ?? 2_000))
  const promptWithProviderRecovery = async (initialText: string, label: string) => {
    let nextText = initialText
    let lastResult: RuntimePromptResult | undefined
    for (let attempt = 0; stop === undefined; attempt += 1) {
      let thrown: unknown
      try {
        lastResult = await sendPrompt(nextText)
      } catch (error) {
        thrown = error
        lastResult = undefined
      }
      const failure = thrown ?? lastResult?.error
      if (failure === undefined) return lastResult

      // A rejected attachment is permanent for that file but not for the challenge: the agent can
      // continue through a tool. Transport and capacity failures wait, then resume the same session.
      const rejected = isRejectedAttachment(failure)
      const transient = isTransient(failure)
      if (!rejected && !transient) {
        if (thrown !== undefined)
          await abort(
            "error",
            `${label} failed (${classifyProviderFailure(failure)}): ${describe(failure)}`,
          )
        return lastResult
      }
      if (attempt >= RETRIES) {
        if (thrown !== undefined)
          await abort("error", `${label} failed after ${RETRIES} retries: ${describe(failure)}`)
        return lastResult
      }

      const retry = attempt + 1
      const kind = rejected ? "rejected-attachment" : "transient"
      retried.push(`${retry}:${kind}(${describe(failure)})`)
      await emit({ type: "retry", status: kind, text: describe(failure) })
      if (transient && retryBaseMs > 0)
        await new Promise((resume) => setTimeout(resume, retryBaseMs * 2 ** attempt))
      if (stop !== undefined) return undefined
      nextText = rejected ? REJECTED : RESUME
    }
    return lastResult
  }

  let result: RuntimePromptResult | undefined
  if (stop === undefined) {
    const fallbackContext = !resumed && input.handoffHistory?.length
      ? renderRuntimeContext(input.handoffHistory)
      : ""
    const handoffHint = [
      input.resumeSessionID ? PROVIDER_HANDOFF : "",
      resumeWarning,
      input.handoffWarning,
      fallbackContext ? `以下是旧 Runtime 导出的活动上下文：\n\n${fallbackContext}` : "",
      input.hint,
    ].filter(Boolean).join("\n\n")
    const prompt = input.purpose === "writeup"
      ? buildWriteupPrompt(input.acceptedFlag ?? "[missing accepted flag]", handoffHint, input.challenge.category)
      : input.continuation
        ? buildContinuationPrompt(handoffHint, input.challenge.category, input.promptCapabilities)
        : buildPrompt(handoffHint, input.challenge.category, input.promptCapabilities)
    result = await promptWithProviderRecovery(prompt, "prompt")
  }

  // Some providers do not emit a step-finish event for their terminal message. The resolved prompt
  // is still a complete message boundary, so a pending switch must take precedence over classifying
  // the old model's natural finish.
  if (stop === undefined && handoffRequested) await handoffAtBoundary("message")

  for (
    let attempt = 1;
    attempt <= Math.max(
      LENGTH_RECOVERY_RETRIES,
      AMBIGUOUS_FINISH_RECOVERY_RETRIES,
      CONTENT_FILTER_RECOVERY_RETRIES,
      CANCELLED_RECOVERY_RETRIES,
    ) && stop === undefined;
    attempt += 1
  ) {
    const finish = result?.finish
    const recoverable =
      finish === "length" ||
      finish === "unknown" ||
      finish === "empty" ||
      finish === "content-filter" ||
      finish === "cancelled"
    if (!recoverable) break
    const allowedRetries = finish === "length"
      ? LENGTH_RECOVERY_RETRIES
      : finish === "content-filter"
        ? CONTENT_FILTER_RECOVERY_RETRIES
        : finish === "cancelled"
          ? CANCELLED_RECOVERY_RETRIES
          : AMBIGUOUS_FINISH_RECOVERY_RETRIES
    if (attempt > allowedRetries) break
    await saveRecoveryDiagnostic(
      input.workspace.directory,
      finish,
      result?.parts ?? [],
    ).catch(() => {})
    const finalUsage = result?.usage
    const estimatedBillable = billable + (steps === 0 && finalUsage ? budgetTokens(finalUsage) : 0)
    const remainingTime = input.limits.timeout - (Date.now() - runStarted)
    if (estimatedBillable >= input.limits.tokens) {
      await abort("budget", `${finish} recovery skipped because no billable token budget remains`)
      break
    }
    if (remainingTime < 5_000) {
      await abort("timeout", `${finish} recovery skipped because fewer than 5 seconds remain`)
      break
    }
    const status = `${finish}-recovery`
    retried.push(`${attempt}:${status}`)
    await emit({
      type: "retry",
      status,
      text: finish === "length"
        ? "provider output reached its length limit; retrying once with a concise recovery prompt"
        : `provider ended with ${finish}; retrying once in the same session`,
    })
    const recoveryPrompt = finish === "length"
      ? LENGTH_RECOVERY
      : finish === "unknown"
        ? UNKNOWN_RECOVERY
        : finish === "content-filter"
          ? CONTENT_FILTER_RECOVERY
          : finish === "cancelled"
            ? CANCELLED_RECOVERY
            : EMPTY_RECOVERY
    result = await promptWithProviderRecovery(recoveryPrompt, `${finish} recovery prompt`)
  }

  clearTimeout(deadline)
  clearSilence()
  input.signal?.removeEventListener("abort", externalAbort)
  input.handoffSignal?.removeEventListener("abort", externalHandoff)
  subscription.abort()
  // Draining the watcher is best-effort. A well-behaved runtime ends its stream when the subscription
  // aborts, but a hung provider is precisely the case the watchdog exists to escape, and awaiting a
  // generator that ignores the signal would hand the hang straight back. Bound the wait instead: every
  // value the outcome needs is already accumulated, so abandoning a stuck iterator costs nothing.
  await Promise.race([
    watching.catch(() => {}),
    new Promise<void>((resolve) => {
      const drain = setTimeout(resolve, WATCHER_DRAIN_MS)
      drain.unref?.()
    }),
  ])

  const message = result
  if (message) {
    // `message.tokens` holds only the final step's usage, so it must not overwrite the running sum.
    // It is the sole source when no step-finish event arrived — a single-step or aborted run.
    if (steps === 0) {
      tokens = message.usage ? messageTokens(message.usage) : 0
      billable = message.usage ? budgetTokens(message.usage) : 0
    }
    cost = Math.max(cost, message.cost)
  }
  if (result?.error && stop === undefined) {
    stop = "error"
    detail = `${classifyProviderFailure(result.error)}: ${describe(result.error)}`
  }
  const parts = result?.parts ?? []
  const histogram: Record<string, number> = {}
  for (const part of parts) histogram[part.type] = (histogram[part.type] ?? 0) + 1

  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim()
  // Reasoning models can finish a step with reasoning only and no text. Recovering that text keeps a
  // flag the model already stated from being thrown away.
  const reasoning = parts
    .flatMap((part) => (part.type === "reasoning" ? [part.text] : []))
    .join("\n")
    .trim()
  const reply = text === "" ? reasoning : text

  // The provider's finish reason is the only reliable signal for truncation and throttling, both of
  // which otherwise arrive with no error attached.
  const finish = message?.finish
  if (stop === undefined && finish !== undefined && finish !== "stop" && finish !== "tool-calls") {
    stop = "error"
    detail = `provider finish reason: ${finish}`
  }
  // Zero text and zero tool calls means the model never engaged with the challenge. Reporting that as
  // `completed` hid roughly a fifth of all runs as "finished with no result".
  if (stop === undefined && text === "" && (histogram["tool"] ?? 0) === 0) {
    stop = "empty"
    detail =
      `model produced no text and called no tools` +
      `${finish === undefined ? "" : ` (finish: ${finish})`}` +
      `${reasoning === "" ? "" : `; ${reasoning.length} chars of reasoning only`}`
  }

  let submission = undefined
  try {
    const stored = await loadCandidateSubmission(input.workspace.directory)
    // The slot is task-durable, but a result belongs only to the conversation that called the tool.
    // This prevents a continuation from silently reusing a previous turn's candidate.
    if (stored?.sessionID === sessionID && input.purpose !== "writeup") submission = stored
  } catch (error) {
    await emit({
      type: "status",
      status: "candidate.slot.invalid",
      text: `Structured candidate submission could not be read; continuing without it: ${describe(error)}`,
    })
  }
  const candidates = submission ? [submission.flag] : []
  const verification = submission?.verification

  // Keep the newest active history available for a later manual consultation, which has no live
  // conversation handle. Runtime support remains optional until the full messages API lands in 1C.
  if (
    input.purpose !== "writeup" &&
    !consultationHistory &&
    conversation.activeContext
  ) await captureConsultationHistory(false)

  let consultationRequest: Outcome["consultationRequest"]
  if (compactions > 0 && consultOnCompaction && input.purpose !== "writeup") {
    consultationRequest = {
      trigger: "compaction",
      reason: detail ?? "runtime context was compacted",
      resumeSessionID: sessionID,
      ...(consultationHistory ? { history: consultationHistory } : {}),
      ...(contextWarning ? { contextWarning } : {}),
    }
  } else if (input.purpose !== "writeup") {
    try {
      const stored = await loadConsultationRequest(input.workspace.directory)
      if (stored?.status === "ready" && stored.sessionID === sessionID) {
        if (!consultationHistory) await captureConsultationHistory()
        consultationRequest = {
          trigger: "agent-request",
          reason: stored.reason,
          request: {
            sessionID: stored.sessionID,
            requestedAt: stored.requestedAt,
          },
          resumeSessionID: sessionID,
          ...(consultationHistory ? { history: consultationHistory } : {}),
          ...(contextWarning ? { contextWarning } : {}),
        }
      }
    } catch (error) {
      await emit({
        type: "status",
        status: "consultation.request.invalid",
        text: `Structured consultation request could not be read; continuing without it: ${describe(error)}`,
      })
    }
  }

  await emit({ type: "status", status: stop ?? "completed", text: detail })
  return {
    stop: stop ?? "completed",
    tokens,
    billable: Math.round(billable),
    cost,
    reply,
    candidates,
    primaryCandidate: candidates[0],
    alternatives: candidates.slice(1),
    candidateSource: candidates.length === 0 ? undefined : "submission",
    verification,
    detail,
    finish,
    parts: histogram,
    retries: retried,
    consultationRequest,
    handoff,
    ...(recoveryContext ? { recoveryContext } : {}),
    ...(compactions > 0 ? { compactions } : {}),
    consultOnCompaction,
  }
}

async function saveRecoveryDiagnostic(
  directory: string,
  reason: "length" | "unknown" | "empty" | "content-filter" | "cancelled",
  parts: Array<{ type: string; text?: string }>,
) {
  const root = await realpath(directory)
  const targetDirectory = path.join(root, "work", ".boom", "recovery")
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  const info = await lstat(targetDirectory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Recovery artifact path is not a real directory")
  const text = parts.flatMap((part) => part.text ? [`[${part.type}]\n${part.text}`] : []).join("\n\n")
  const target = path.join(targetDirectory, `${reason}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.txt`)
  await writeFile(target, text, { encoding: "utf8", mode: 0o600 })
  return path.relative(root, target).split(path.sep).join("/")
}

export function findDeclaredCandidates(text: string) {
  const candidates: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const explicit = /^\s*(?:FINAL_FLAG|最终\s*FLAG|最终答案)\s*[:：]\s*`?(\S+?)`?\s*$/i.exec(line)
    const labelBold = /^\s*\*\*Flag\s*[:：]\*\*\s*(?:`([^`\r\n]+)`|(\S+))\s*$/i.exec(line)
    const wholeBold = /^\s*\*\*Flag\s*[:：]\s*(?:`([^`\r\n]+)`|(\S+?))\s*\*\*\s*$/i.exec(line)
    const candidate = explicit?.[1] ?? labelBold?.[1] ?? labelBold?.[2] ?? wholeBold?.[1] ?? wholeBold?.[2]
    if (candidate) candidates.push(candidate.trim())
  }
  return [...new Set(candidates)]
}

export function parseWriteup(text: string) {
  const flag = findDeclaredCandidates(text)[0]
  const labelBold = /^\s*\*\*Verification\s*[:：]\*\*\s*(.+?)\s*$/im.exec(text)
  const wholeBold = /^\s*\*\*Verification\s*[:：]\s*(.+?)\s*\*\*\s*$/im.exec(text)
  const verification = (labelBold?.[1] ?? wholeBold?.[1])?.trim()
  return { flag, verification }
}

export function classifyVerification(detail?: string): NonNullable<Outcome["verification"]> {
  const text = detail?.trim() || "模型未提供可验证性说明"
  const lower = text.toLowerCase()
  const deniesVerifier =
    /(?:\bno\b|\bnot\b|\bwithout\b|unverified|未|无).{0,24}(?:remote|checker|verif|校验|验证|服务)/i.test(
      lower,
    )
  const offline = /offline|decode|deriv|离线|推导|解码|format/.test(lower)
  const level =
    deniesVerifier && !offline
      ? "unverified"
      : /remote|远程|远端|服务/.test(lower) && !deniesVerifier
      ? "remote"
      : /local checker|checker|本地校验|本地检查/.test(lower) && !deniesVerifier
        ? "local-checker"
        : offline
          ? "offline-derivation"
          : "unverified"
  return { level, detail: text }
}
