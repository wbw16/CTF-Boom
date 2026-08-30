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
  /** Abort once total tokens across the session exceed this. Absent means no token ceiling. */
  tokens?: number
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
  /**
   * Progress heartbeat thresholds. After `heartbeatTextSilenceMs` without model text while tool
   * activity continues, emit a `status: "heartbeat"` event, throttled to once per
   * `heartbeatMinIntervalMs`. Absent values fall back to the built-in defaults; injectable so tests
   * can exercise the heartbeat without waiting minutes.
   */
  heartbeatTextSilenceMs?: number
  heartbeatMinIntervalMs?: number
  /**
   * Note-gate threshold: how many consecutive tool calls without a durable `ctf-note`/`ctf-submit`
   * force the turn to stop at the next boundary and record state first. Absent falls back to the
   * built-in default; non-positive disables the gate.
   */
  noteGateToolCalls?: number
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
 * Progress heartbeat. A solver can run tools for minutes without emitting any text, which reads as
 * "stuck" to a human watching the run. Once this much time passes since the last model text with
 * tool activity continuing, Boom emits a `status: "heartbeat"` event so the UI can distinguish a
 * working run from a dead one. The heartbeat repeats at most once per `HEARTBEAT_MIN_INTERVAL_MS`.
 */
const HEARTBEAT_TEXT_SILENCE_MS = 120_000
const HEARTBEAT_MIN_INTERVAL_MS = 60_000

/**
 * Note-gate. A solve turn that runs this many tool calls in a row without a completed `ctf-note` or
 * `ctf-submit` is forced to stop at the next turn boundary and record its state before continuing.
 * The provider's tool loop is atomic, so the gate lands as an injected prompt at the round boundary
 * rather than mid-round. The default is deliberately loose (a busy exploratory turn in this dataset
 * runs ~130 tool calls): the gate exists to guarantee *some* durable memory exists before a switch or
 * recovery, not to police every minute of work.
 */
const NOTE_GATE_TOOL_CALLS = 30

/**
 * Default no-activity watchdog interval.
 *
 * Short enough to rescue a hung provider long before the wall-clock backstop, long enough that a slow
 * first token or an in-flight provider retry never trips it. Only consulted when nothing is running:
 * any pending or running tool call suppresses the watchdog outright, so this bounds idle silence only.
 */
export const DEFAULT_SILENCE_MS = 150_000

/** How long a silence probe may take before the watchdog treats the backend as unresponsive. */
const SILENCE_PROBE_TIMEOUT_MS = 15_000

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
    `\n\n[activity context too long; ${value.length - maximum} middle characters omitted]\n\n`,
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
const PROMPT = `# Solve turn

challenge/ is read-only input; work/ is your workspace; NOTES.md is cross-turn memory.

- Act, don't narrate. Your first tool call must make concrete progress — open an attachment, connect to the service, or inspect a file. Do not plan at length before acting.
- Use tools to verify, not prose. Keep iterating with tools until you have a credible flag; do not stop to summarize without having acted.
- On a credible candidate, call ctf-submit immediately and stop. Never treat your own claim as host-confirmed, and never resubmit a value the host has rejected.
- Only generate work/WRITEUP.md after a later turn explicitly tells you the candidate was accepted.
- Cover maximum surface: hidden files, env vars, HTTP headers, alternate encodings, secondary services. Don't fixate on one path.
- If a direction produces no verifiable new fact for several turns, record it as ruled-out in NOTES.md and switch direction instead of deepening it.
- Delegate mechanical / brute-force / large-output work to boom-worker(-pro) via task; bring only conclusions back. If the whole direction looks wrong, request an independent consultation via ctf-consult.
- Record breakthroughs, confirmed facts, and ruled-out directions in NOTES.md; checkpoint with ctf-note periodically rather than waiting until handoff.
- bash runs at the task root by default; pass workdir= to work inside work/ instead of re-cd-ing.`

const CATEGORY_GUIDANCE = {
  WEB: "Prioritize HTTP behavior, routes, params, sessions, auth, frontend source, and web input boundaries; do not jump to binary exploitation without evidence.",
  PWN: "Prioritize architecture, protections, I/O protocol, memory-corruption surface, and a reproducible exploit chain.",
  REVERSE: "Prioritize architecture and runtime; combine static and dynamic analysis to recover validation logic or data transforms.",
  CRYPTO: "Distinguish encoding from cryptography; lay out parameters, math relations, and implementation flaws, and verify derivations with reproducible experiments.",
  MISC: "Triage file type, metadata, encoding, steganography, forensics, and protocol/traffic first, then follow the evidence deeper.",
  MOBILE: "Prioritize platform and package structure; check manifests, resources, storage, network behavior, native libs, and runtime checks.",
  FORENSICS: "Preserve evidence integrity; build a verifiable trail across timeline, filesystem, memory, or traffic.",
  AI: "Clarify model, data, I/O, and scoring boundaries first; then check prompt injection, data handling, or model-implementation flaws.",
  HARDWARE: "Confirm device, firmware, interfaces, and signal protocols; build an evidence chain from observable I/O.",
  BLOCKCHAIN: "Check contract state, permissions, call paths, numeric boundaries, and reproducible transaction sequences.",
  OSINT: "Build a source-reliable, time-consistent, cross-verifiable evidence chain from the public clues the challenge provides.",
  OTHER: "Triage the challenge type first, then choose a direction from the challenge files, services, and experimental results.",
} as const

export type SolverPromptCapabilities = {
  /** A connected, Boom-managed headless IDA MCP is callable by the primary solver. */
  headlessIda?: boolean
}

const HEADLESS_IDA_GUIDANCE = [
  "Headless IDA Pro MCP (idalib) is available. For native executables, copy the target from challenge/ to work/ida/ first, then use idb_open in force_headless mode to auto-analyze, and recover program logic with survey_binary, list_funcs, decompile, xrefs_to, callees, and callgraph; do not generate an IDB directly under challenge/.",
  "If IDA open, auto-analysis, or decompilation fails, record the specific error and fall back to objdump, LLDB, Python, angr, etc.; do not skip IDA merely because shell tools are available. Once an IDB is open, query functions around entry points, validation paths, and key strings and their xrefs; avoid aimlessly decompiling every function.",
  "Large IDA query results are auto-archived under work/ida/results/; the context keeps only a summary and a file pointer. Use idalib_boom_ida_get to read details line by line in segments, and idalib_boom_ida_list to view archived queries. Archives are durable artifacts — resume turns should read them first and not re-query the same functions.",
].join(" ")

/** Give the solver a bounded prior without overriding contrary evidence from the challenge. */
export function challengeCategoryPrompt(
  category?: string,
  capabilities: SolverPromptCapabilities = {},
) {
  if (!category?.trim()) return ""
  const normalized = normalizeChallengeCategory(category)
  return [
    `You are solving a CTF ${normalized} challenge.`,
    CATEGORY_GUIDANCE[normalized],
    capabilities.headlessIda && (normalized === "REVERSE" || normalized === "PWN")
      ? HEADLESS_IDA_GUIDANCE
      : "",
    "The category only orders your priorities; follow actual evidence if the files, services, or experimental results conflict.",
    "If a direction produces no verifiable new fact for several turns, record it as ruled-out and switch direction instead of deepening it.",
  ].filter(Boolean).join(" ")
}

function withCategoryPrompt(
  prompt: string,
  category?: string,
  capabilities: SolverPromptCapabilities = {},
) {
  const context = challengeCategoryPrompt(category, capabilities)
  // Keep the cross-task turn contract at the front of the user message. Category guidance is
  // stable only within one class of challenge, while the caller appends user/task state last.
  return context ? `${prompt}\n\n${context}` : prompt
}

export function buildPrompt(
  hint?: string,
  category?: string,
  capabilities: SolverPromptCapabilities = {},
) {
  const trimmed = hint?.trim()
  const prompt = withCategoryPrompt(PROMPT, category, capabilities)
  return compileTurnPrompt(
    "turn:solve",
    trimmed ? `${prompt}\n\nUser-added hint: ${trimmed}` : prompt,
  )
}

const CONTINUE_PROMPT = `# Continue turn

Same challenge. challenge/ is read-only input; work/ and NOTES.md hold prior work.

- Act, don't narrate. Make a concrete tool call first; do not plan at length before acting.
- Keep the goal: recover the flag. On a credible candidate, call ctf-submit immediately and stop; do not generate the final writeup until the candidate is confirmed.
- Never treat your own claim as host-confirmed, and never resubmit a value the host has rejected.
- Cover maximum surface; if a direction produces no verifiable new fact for several turns, record it as ruled-out in NOTES.md and switch direction instead of deepening it.
- Delegate mechanical / brute-force / large-output work to boom-worker(-pro) via task; bring only conclusions back. If the whole direction looks wrong, request an independent consultation via ctf-consult.
- Record breakthroughs, confirmed facts, and ruled-out directions in NOTES.md; checkpoint with ctf-note periodically rather than waiting until handoff.
- bash runs at the task root by default; pass workdir= to work inside work/ instead of re-cd-ing.
- A compact handoff summary was injected at the start of this turn; resume from it, but trust actual files if they conflict.`

export function buildContinuationPrompt(
  hint?: string,
  category?: string,
  capabilities: SolverPromptCapabilities = {},
) {
  const trimmed = hint?.trim()
  const prompt = withCategoryPrompt(CONTINUE_PROMPT, category, capabilities)
  return compileTurnPrompt(
    "turn:continue",
    trimmed ? `${prompt}\n\nUser-added hint: ${trimmed}` : prompt,
  )
}

const WRITEUP_PROMPT = `# Writeup turn

The candidate flag is confirmed by the platform or user. Stop guessing or submitting flags.

- Generate work/WRITEUP.md offline from challenge/, work/, and NOTES.md only. Include the confirmed flag, core idea, derivation, and reproducible steps.
- Write the writeup in Chinese. Keep commands, code, file paths, and the literal flag unchanged.
- If a PoC/script was actually used, include its path, invocation, and complete source in a fenced code block — no truncation, ellipsis, or file-reference substitutes.
- If no script/PoC was actually used, do not invent one; write the verified reasoning and manual reproduction steps.
- Do not call ctf-submit. Finish the turn shortly after the writeup.`

export function buildWriteupPrompt(flag: string, hint?: string, category?: string) {
  const extra = hint?.trim()
  const prompt = withCategoryPrompt(WRITEUP_PROMPT, category)
  return compileTurnPrompt(
    "turn:writeup",
    `${prompt}\n\nConfirmed flag: ${flag}${extra ? `\n\nAdditional note: ${extra}` : ""}`,
  )
}

function compileTurnPrompt(source: string, content: string) {
  return compilePromptText(createPromptBundle({
    turn: [{ source, content, stability: "turn", cacheable: false, sensitivity: "task" }],
  }), ["turn"])
}

// Sent when a transient provider failure interrupted the previous turn. The session is the same one,
// so this resumes rather than restarts: work/ and NOTES.md still hold everything done so far.
const RESUME = `# Resume turn

The previous turn was interrupted by a runtime fault. work/ and NOTES.md hold all prior progress.

- Continue the original goal from the last incomplete step; do not redo completed work.`

// A `length` finish is a completed provider call, not a transport failure. Re-sending the original
// prompt encourages a degenerated model to emit the same long sequence again, so recovery explicitly
// redirects bulk data to disk and asks for a durable checkpoint before continuing.
const LENGTH_RECOVERY = `# Resume turn

The previous reply hit the provider's single-turn output length cap and was truncated.

- Write anything you need to keep into work/ and NOTES.md, then continue the original goal.
- Do not repeat the same long output; redirect bulk data to disk first.`

const UNKNOWN_RECOVERY = `# Resume turn

The previous reply's provider finish state was ambiguous and may have been truncated mid-stream. The raw output was saved under work/.boom/recovery/.

- Do not repeat large outputs; check work/, NOTES.md, and existing tool results first, then continue from where it stopped.
- If you already have a credible candidate, call ctf-submit immediately.`

const EMPTY_RECOVERY = `# Resume turn

The previous turn returned no usable content. This is a runtime fault, not a sign the challenge is done.

- Continue the original goal from the current state in work/ and NOTES.md; do not redo actions the evidence already shows are dead ends.`

const CONTENT_FILTER_RECOVERY = `# Resume turn

The previous reply was blocked by a content-safety policy and produced no usable output. This is a runtime fault, not a sign the challenge is done.

- Continue the original goal from the current state in work/ and NOTES.md.
- Rephrase neutrally to avoid tripping the filter again.`

const CANCELLED_RECOVERY = `# Resume turn

The provider cancelled the previous turn's response before it completed. This is a runtime fault, not a sign the challenge is done.

- Continue from where it stopped using the current state in work/ and NOTES.md; do not redo actions the evidence already shows are dead ends.`

const PROVIDER_HANDOFF = `# Resume turn

The user just switched the model or provider for this task. This is a controlled handoff of the same task: work/, NOTES.md, completed tool results, and the activity context below are all prior progress.

- Continue from the last incomplete step; do not redo completed work.
- If a compatibility note says some capability is unavailable, fall back to existing tools or file state to finish the goal.`

// Sent when the provider rejected a file the agent attached. Naming the cause matters: otherwise it
// retries the same read and loses the run to a failure it could have worked around.
const REJECTED = `# Resume turn

A file attachment submitted to the provider last turn was rejected. It cannot be passed to the model as-is; continue the original goal without it.`

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
      resumeWarning = `The previous session could not be resumed by the new runtime: ${describe(error)}`
      conversation = await input.runtime.createConversation({
        directory: input.workspace.directory,
        title: `Boom: ${input.challenge.slug}`,
      })
    }
  } else {
    if (input.resumeSessionID)
      resumeWarning = "The new runtime cannot resume the previous session; a fresh session for the same task was started from the activity context"
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
  // Progress heartbeat state. `lastTextAt` moves on any model text; when tool activity outlives it by
  // `heartbeatTextSilence`, the harness reports that the turn is alive and working.
  const heartbeatTextSilence = Math.floor(input.limits.heartbeatTextSilenceMs ?? HEARTBEAT_TEXT_SILENCE_MS)
  const heartbeatMinInterval = Math.floor(input.limits.heartbeatMinIntervalMs ?? HEARTBEAT_MIN_INTERVAL_MS)
  let lastTextAt = runStarted
  let lastHeartbeatAt = 0
  let toolCallsThisTurn = 0
  let lastToolLabel = "无"
  // Note-gate state. The watcher counts tool calls since the last durable write; when the threshold
  // is reached it flags `noteGatePending`, and the main flow injects a record-state prompt at the
  // next turn boundary. `noteGateFiredThisTurn` bounds the gate to once per turn so a stubbornly
  // silent model cannot be pinged in an infinite loop.
  const noteGateToolCalls = Math.floor(input.limits.noteGateToolCalls ?? NOTE_GATE_TOOL_CALLS)
  let toolsSinceDurable = 0
  let noteGatePending = false
  let noteGateFiredThisTurn = false

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
  // Providers that batch reasoning deltas emit nothing at all during a long think, so the event
  // stream alone cannot distinguish "thinking" from "wedged". Before killing, the watchdog probes
  // the conversation's liveness: while the backend reports an in-flight step, silence is alive and
  // the timer re-arms. Only an idle backend with no events is a hang.
  //
  // Declared before `abort` because `abort` clears it and can run before the prompt is ever sent.
  const silenceLimit = Math.floor(input.limits.silenceMs ?? 0)
  let silence: ReturnType<typeof setTimeout> | undefined
  /** Invalidates an async probe whenever newer activity re-arms or clears the watchdog. */
  let watchdogEpoch = 0
  /** Set once the turn outcome is final; a settled turn must never arm or fire the watchdog again. */
  let finished = false
  const clearSilence = () => {
    watchdogEpoch += 1
    if (silence) clearTimeout(silence)
    silence = undefined
  }
  const armSilence = () => {
    if (silenceLimit <= 0 || stop !== undefined || finished) return
    clearSilence()
    const epoch = watchdogEpoch
    silence = setTimeout(() => {
      void probeSilence(epoch)
    }, silenceLimit)
    // Never hold the process open on the watchdog alone.
    silence.unref?.()
  }
  const probeSilence = async (epoch: number) => {
    if (epoch !== watchdogEpoch || stop !== undefined || finished) return
    if (runningCalls.size > 0) {
      armSilence()
      return
    }
    const busy = await probeConversationBusy()
    // Activity or completion may race the async backend probe. A stale idle result must never kill
    // the newer turn state that already re-armed or cleared the watchdog.
    if (epoch !== watchdogEpoch || stop !== undefined || finished || runningCalls.size > 0) return
    if (busy) {
      await emit({
        type: "status",
        status: "watchdog.busy",
        text: `backend reports an in-flight step after ${Math.round(silenceLimit / 1000)}s of silence; watchdog re-armed`,
      })
      armSilence()
      return
    }
    void abort(
      "silent",
      `no runtime activity for ${Math.round(silenceLimit / 1000)}s with no tool running and no step in flight: ` +
        `provider or agent loop stopped responding`,
    )
  }
  const probeConversationBusy = async (): Promise<boolean> => {
    if (typeof conversation.isBusy !== "function") return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        conversation.isBusy(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), SILENCE_PROBE_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      return result === true
    } catch {
      // A failed probe is not proof of life; the watchdog proceeds as if the backend were idle.
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
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
        if (input.limits.tokens !== undefined && billable > input.limits.tokens)
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
        lastTextAt = Date.now()
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
      ) {
        markDurable()
        toolsSinceDurable = 0
      }
      if (
        event.state.status !== "running" &&
        event.state.status !== "pending" &&
        await handoffAtBoundary("tool")
      ) continue
      // Progress heartbeat: tool activity continuing well past the last model text must not read as
      // a hang. Only a finished tool counts as activity (a long-running brute force is its own
      // story), and the heartbeat is throttled so a silent-but-working turn reports once a minute
      // at most instead of spamming the event stream.
      if (event.state.status === "completed" || event.state.status === "error") {
        toolCallsThisTurn += 1
        lastToolLabel = `${event.tool} · ${event.state.title ?? event.state.error ?? "完成"}`
        // The durable-write tools reset the counter above and never count toward the gate gap
        // themselves; only plain tools accumulate the gap the gate measures.
        if (
          input.purpose === "solve" &&
          noteGateToolCalls > 0 &&
          event.tool !== "ctf-note" &&
          event.tool !== "ctf-consult" &&
          event.tool !== "ctf-submit"
        ) {
          toolsSinceDurable += 1
          if (toolsSinceDurable >= noteGateToolCalls && !noteGatePending) {
            noteGatePending = true
            await emit({
              type: "status",
              status: "note-gate",
              text: `连续 ${noteGateToolCalls} 次工具调用未更新 NOTES.md；将在回合边界注入记录提醒`,
            })
          }
        }
        const now = Date.now()
        if (
          stop === undefined &&
          now - lastTextAt >= heartbeatTextSilence &&
          now - lastHeartbeatAt >= heartbeatMinInterval
        ) {
          lastHeartbeatAt = now
          await emit({
            type: "status",
            status: "heartbeat",
            text:
              `仍在运行：距上次模型文字输出 ${Math.round((now - lastTextAt) / 1000)}s；` +
              `本轮已执行 ${toolCallsThisTurn} 次工具调用，最近：${lastToolLabel}；` +
              `已消耗 ${Math.round(billable)} billable / ${tokens} raw tokens。`,
          })
        }
      }
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
  // Cancellation fast lane for the prompt itself. `subscription.signal` fires on every internal stop
  // (deadline, watchdog, stall, error) because `abort` trips it first; `input.signal` covers user
  // cancellation. Both keep their existing behaviour — the runtime-contract signal only lets an
  // in-flight prompt unwind immediately instead of waiting for the abort HTTP path.
  const cancelSources = [input.signal, subscription.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  const sendPrompt = (text: string) =>
    conversation.prompt({
      agent: AGENT,
      model: input.model,
      text,
      ...(cancelSources.length > 0 ? { signal: AbortSignal.any(cancelSources) } : {}),
    })
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
      fallbackContext ? `Activity context exported by the previous runtime:\n\n${fallbackContext}` : "",
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

  // Note-gate hard boundary. The provider's tool loop is atomic, so the gate lands at this round
  // boundary: a solve turn that ran many tools without a single durable note is ended, and the next
  // turn is required to open with a checkpoint. The message only asks for the current state
  // (confirmed facts, ruled-out directions, hypotheses, next steps) — never for a self-assessment of
  // whether there is "real progress", which would invite optimistic or evasive answers. It fires at
  // most once per turn, and a fresh durable write mid-round cancels it via the watcher reset.
  if (
    stop === undefined &&
    input.purpose === "solve" &&
    noteGatePending &&
    !noteGateFiredThisTurn &&
    !result?.error
  ) {
    noteGateFiredThisTurn = true
    noteGatePending = false
    await emit({
      type: "status",
      status: "note-gate.hard",
      text: `连续 ${noteGateToolCalls} 次工具调用未产生持久记录；本轮结束，下一轮必须以 checkpoint 开局`,
    })
    await abort(
      "stalled",
      `note-gate: 连续 ${noteGateToolCalls} 次工具调用没有持久增量，回合结束；下一轮必须先写 checkpoint`,
    )
  }

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
    if (input.limits.tokens !== undefined && estimatedBillable >= input.limits.tokens) {
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
  finished = true
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
    // The slot is task-durable, but a result belongs only to the conversation that called the tool,
    // and only until its gate evaluation consumed it. This prevents a continuation from silently
    // reusing a previous turn's candidate — including one the gate already accepted or rejected.
    if (stored?.sessionID === sessionID && !stored.consumedAt && input.purpose !== "writeup")
      submission = stored
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
