import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { consumeCandidateSubmission, submitCandidate } from "./candidate-submission.ts"
import { normalizeChallengeCategory, updateChallengeRemote, type Challenge } from "./challenge.ts"
import {
  addConsultationUsage,
  allocateConsultationBudgets,
  consultationHint,
  remainingLimits,
  runConsultation,
  ConsultationExecutionError,
  type Consultation,
  type ConsultationTrigger,
  type ConsultationWindows,
} from "./consultation.ts"
import {
  handleConsultationRequest,
  type ConsultationRequestReference,
} from "./consultation-request.ts"
import {
  appendRunEvent,
  assertPathWithin,
  readRunHistory,
  type RunHistory,
  writeRunResultAtomic,
} from "./history.ts"
import type { ModelPolicy } from "./model-policy.ts"
import {
  bindTaskEnvironment,
  loadTaskEnvironment,
  resolveEnvironmentProfile,
  type ExecutionMode,
} from "./environment.ts"
import {
  decideAutonomy,
  runAutonomyEscalation,
  withStallBrake,
  type AutonomyDecision,
  type AutonomyEscalationResult,
} from "./orchestration/escalation.ts"
import {
  activeSolveTimeMs,
  captureProgressSnapshot,
  hasProductiveLongRunningTool,
  loadOrCreateAutonomyState,
  markAutomaticContinuation,
  recordTurnProgress,
  type ProgressSnapshot,
} from "./orchestration/progress.ts"
import { buildHandoffSummary } from "./orchestration/handoff.ts"
import {
  reviewCandidateBlind,
  selectReviewer,
} from "./orchestration/second-opinion.ts"
import {
  canStart,
  challengeBudgetMs,
  DEFAULT_COMPETITION_SETTINGS,
  decideGiveUp,
  matchClock,
  normalizeCompetitionSettings,
  priorityOf,
  slotKindFor,
  type CompetitionSettings,
  type SlotUsage,
} from "./competition/policy.ts"
import { EnvironmentPool, type EnvironmentLease } from "./competition/environments.ts"
import {
  gateSubmission,
  loadSubmissionLedger,
  recordAttempt,
  saveSubmissionLedger,
} from "./competition/submissions.ts"
import { loadCompetitionAdapter } from "./competition/adapter.ts"
import {
  MAX_SUBMISSIONS_PER_CHALLENGE,
  XIHULUNJIAN_ADAPTER_ID,
} from "./xihulunjian-platform-adapter.ts"
import {
  BOOM_CONTEXT_LIMIT,
  loadProviderStore,
  normalizeManagedProvider,
  normalizeProviderDiscovery,
  replaceArmorPromptPresets,
  saveProviderStore,
  type ArmorPromptPreset,
  type ManagedModelConfig,
  type ManagedProviderConfig,
  type ManagedProviderDriver,
  type ProviderStore,
} from "./provider-config.ts"
import {
  loadMcpStore,
  managedMcpAvailableToAgent,
  normalizeManagedMcpServer,
  saveMcpStore,
  type ManagedMcpServer,
} from "./mcp-config.ts"
import {
  publicRuntimeModel,
  startOpenCodeRuntime,
} from "./runtime.ts"
import { importOpenCodeCredentials } from "./runtime/credential-store.ts"
import type {
  RuntimeHandle,
  RuntimeLauncher,
  RuntimeAuthMethod,
  RuntimeMessage,
  RuntimeMcpStatus,
  RuntimeProviderCatalog,
} from "./runtime-contract.ts"
import { runChallenge, type Limits, type Outcome, type RunEvent } from "./session.ts"
import {
  acceptTaskFlag,
  archiveTask,
  loadOrCreateTask,
  rejectTaskFlag,
  saveTaskRecord,
  taskTotals,
  type TaskRecord,
  type TaskTurn,
} from "./task.ts"
import { prepareWorkspace, type Workspace } from "./workspace.ts"

export type ModelInfo = {
  id: string
  name: string
  connected: boolean
  attachment?: boolean
}

export type ProviderSummary = {
  id: string
  name: string
  connected: boolean
  configured: boolean
  custom: boolean
  disabled: boolean
  modelCount: number
  visibleModelCount: number
  authMethods: Array<{ type: "api" | "oauth"; label: string; index: number }>
}

export type ProviderModelInfo = ManagedModelConfig & {
  enabled: boolean
  source: "catalog" | "custom"
}

export type ProviderDetails = ProviderSummary & {
  npm?: string
  api?: string
  baseURL?: string
  driver?: ManagedProviderDriver
  models: ProviderModelInfo[]
}

type ProviderSnapshot = {
  listed: RuntimeProviderCatalog
  authentication: Record<string, RuntimeAuthMethod[]>
  store: ProviderStore
}

export type ProviderSaveOptions = {
  /**
   * Apply the saved provider definition to the live compatibility runtime immediately.
   * Omitting this option preserves the historical eager-apply behavior for non-GUI callers.
   */
  apply?: boolean
}

export type McpServerDetails = ManagedMcpServer & {
  runtime: RuntimeMcpStatus
}

export type RuntimeState = {
  status: "starting" | "ready" | "error"
  active: number
  queued: number
  concurrency: number
  backend?: string
  version?: string
  promptVersion?: string
  capabilities?: RuntimeHandle["capabilities"]
  error?: string
}

export type RunnerNotification = {
  at: number
  type: string
  slug?: string
  runID?: string
  event?: RunEvent
  detail?: string
}

export type EnqueueRunsInput = {
  challenges: Challenge[]
  model: string
  models?: Record<string, string>
  limits: Limits
  flagFormat: string
  flagFormats?: Record<string, string>
  hint?: string
  /** Internal/manual transition: solve for a candidate, or finalize an already accepted flag. */
  purpose?: "solve" | "writeup"
  /** Existing task workspace to continue, keyed by challenge slug. */
  workspaces?: Record<string, string>
  modelPolicy?: ModelPolicy
  /** Optional image-capable model for on-demand inspection by a text-only solver. */
  visionModel?: string
  /** Shared second-opinion model pool; empty or absent means no blind review is possible. */
  consultModels?: string[]
  /** Defaults to true: review a candidate automatically when the pool allows it. */
  blindReview?: boolean
  /** Explicit context experiment policy; defaults to true. */
  consultOnCompaction?: boolean
  environmentProfileId?: string
  environmentProfileIds?: Record<string, string>
  pythonInterpreter?: string
  pythonInterpreters?: Record<string, string>
  executionMode?: ExecutionMode
  consultation?: {
    trigger: ConsultationTrigger
    expertModels: string[]
    synthesizerModel: string
    sourceRunID?: string
    sourceNotes?: string
    stopDetail?: string
    resumeSessionID?: string
    history?: RuntimeMessage[]
    contextWarning?: string
    /** Durable agent request whose lifecycle is owned by this consultation job. */
    request?: ConsultationRequestReference
  }
}

type AutonomyBaseline = {
  billableTokens: number
  activeSolveMs: number
}

type FlagSubmissionResult = {
  adapter: string
  verdict: "accepted" | "rejected" | "pending"
  detail: string
  submittedAt: string
}

type TestPlatformAdapters = {
  submitFlagWithRetry(
    input: {
      root: string
      challenge: Challenge
      workspace: Workspace
      candidate: string
      signal?: AbortSignal
    },
    options?: { attempts?: number; retryDelayMs?: number },
  ): Promise<FlagSubmissionResult>
}

type Job = {
  queueID: string
  challenge: Challenge
  model: string
  limits: Limits
  hint?: string
  resumeRunID?: string
  continuation: boolean
  purpose: "solve" | "writeup"
  writeupAttempts: number
  /** Consecutive host-level recovery turns; reset by non-recovery transitions. */
  recoveryAttempts: number
  modelPolicy: ModelPolicy
  /** Shared second-opinion pool. A blind review draws one reviewer from it; empty disables review. */
  consultModels: string[]
  /** Whether a candidate is reviewed automatically. Independent of the pool being non-empty. */
  blindReview: boolean
  consultOnCompaction: boolean
  environmentProfileId?: string
  pythonInterpreter?: string
  executionMode: ExecutionMode
  autonomyBudget: Pick<Limits, "tokens" | "timeout">
  /** Task totals at the start of this user-authorized run chain. */
  autonomyBaseline?: AutonomyBaseline
  autonomyEscalations: AutonomyEscalationResult[]
  autonomyDecision?: AutonomyDecision
  progressBefore?: ProgressSnapshot
  progressEventOffset?: number
  runtimeBackend?: string
  runtimeVersion?: string
  promptVersion?: string
  consultationInput?: NonNullable<EnqueueRunsInput["consultation"]>
  consultationPhase?: "queued" | "running" | "complete"
  consultation?: Consultation
  flagFormat: string
  controller: AbortController
  queuedAt: number
  startedAt?: number
  workspace?: Workspace
  task?: TaskRecord
  turnID?: string
  priorTokens: number
  priorBillableTokens: number
  priorCost: number
  events: RunEvent[]
  tokens: number
  billableTokens: number
  cost: number
  lastTool?: string
  platformSubmission?: FlagSubmissionResult
  eventWrites: Promise<void>
  /** Runtime generation pinned for this job so a live Provider reload cannot invalidate it. */
  runtime?: RuntimeHandle
  /** Separate from user cancellation: observed only at a safe message/tool boundary. */
  switchController: AbortController
  pendingSwitch?: ModelSwitchRequest
  /** User-requested task environment rebind; observed at the same safe boundary as a model switch. */
  pendingEnvironmentSwitch?: EnvironmentSwitchRequest
  /** User-requested consultation captured while this job is already running. */
  pendingConsultation?: ManualConsultationRequest
  /** Durable session/context exported by the previous model during a hot switch. */
  resumeSessionID?: string
  handoffHistory?: RuntimeMessage[]
  handoffWarning?: string
  /** Why this queued job was passed over, surfaced so a waiting challenge is never silently stuck. */
  admissionHold?: string
  /** Remote environment lease held for this job, released when it finishes. */
  environmentLease?: EnvironmentLease
}

/** Platform points recorded when the challenge was synchronized, used for scheduling order. */
function challengeScore(challenge: Challenge) {
  const value = challenge.platform?.options?.score
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

type ModelSwitchRequest = {
  model: string
  policy: ModelPolicy
  consultModels: string[]
  blindReview: boolean
  consultOnCompaction: boolean
  requestedAt: number
  reason: string
  warnings: string[]
}

type EnvironmentSwitchRequest = {
  profileId: string
  executionMode: ExecutionMode
  requestedAt: number
  reason: string
}

export type ManualConsultationRequest = {
  slug: string
  sourceRunID?: string
  expertModels: string[]
  synthesizerModel: string
  solverModel: string
  modelPolicy: ModelPolicy
  consultModels: string[]
  blindReview: boolean
  consultOnCompaction: boolean
  limits: Limits
  flagFormat: string
  requestedAt: number
}

export type ManualConsultationSchedule = {
  mode: "before-start" | "live-handoff"
  runID: string
  model: string
}

export type LiveModelSettings = {
  economyModel: string
  strongModel: string
  visionModel?: string
  consultModels: string[]
  blindReview: boolean
  consultOnCompaction: boolean
  /** Host-wide network switch; changing it regenerates the runtime so sandboxes and permissions follow. */
  network: "allow" | "deny"
}

export type LiveSwitchResult = {
  active: number
  queued: number
  warnings: string[]
}

const FALLBACK_MODELS: ModelInfo[] = [
  { id: "free/deepseek-v4-flash-free", name: "DeepSeek V4 Flash (free)", connected: true, attachment: false },
]

const RUN_RECOVERY_ATTEMPTS = 2
const REMOTE_URL_MISSING = "missing remote URL"

/**
 * A challenge waiting for one of the three scarce environments still gets a local-first turn.
 *
 * In the competition build this is real work rather than triage: reversing the binary and developing
 * an exploit offline is exactly what keeps the environment slots turning over quickly, so the budget
 * is larger than the general-purpose build's "wait for a human URL" pass.
 */
const LOCAL_FIRST_TURN_TOKENS = 120_000
const LOCAL_FIRST_TURN_TIMEOUT_MS = 12 * 60_000

/** A confirmed flag frees the target; its offline report gets a small fresh budget. */
const WRITEUP_TURN_TOKENS = 24_000
const WRITEUP_TURN_TIMEOUT_MS = 5 * 60_000

/**
 * Legacy manual-URL block detection. The competition build provisions environments automatically, so
 * nothing produces this stop any more; it is still recognized so a task carried over from a run made
 * by the general-purpose build keeps its existing follow-up behavior.
 */
function isRemoteURLBlocked(outcome: Pick<Outcome, "stop" | "detail">) {
  return outcome.stop === "blocked" && outcome.detail?.includes(REMOTE_URL_MISSING) === true
}

/** Infrastructure and loop-guard stops that are safe to resume in a fresh turn. */
export function recoverableRunOutcome(
  outcome: Pick<Outcome, "stop" | "detail" | "finish">,
) {
  if (outcome.stop === "silent" || outcome.stop === "empty") return true
  const detail = outcome.detail ?? ""
  if (
    outcome.stop === "stalled" &&
    /(?:repeated the same|degenerate text repetition|output ceiling exceeded|note-gate)/i.test(detail)
  ) return true
  if (outcome.stop !== "error") return false
  if (["unknown", "empty", "length", "content-filter", "cancelled"].includes(outcome.finish ?? "")) return true
  // Task-time errors are recoverable by default: the workspace, NOTES.md, and the durable session
  // are preserved, so a fresh turn can continue from the last completed step. Only configuration or
  // policy failures that will repeat identically are excluded.
  return !/(?:invalid api key|invalid provider|no such provider|no such model|model .*not found|archived tasks cannot|already has an accepted flag|no environment binding|not in boom's .*allowlist|unknown boom agent|unknown configured provider|path escapes|symbolic link|permission denied|no such armor prompt|no such mcp)/i
    .test(detail)
}

function recoveryHint(
  outcome: Pick<Outcome, "stop" | "detail" | "recoveryContext">,
  attempt: number,
) {
  const action = outcome.stop === "stalled"
    ? /note-gate/i.test(outcome.detail ?? "")
      ? "The previous turn ended after repeated tool calls with no durable record. This turn, first call ctf-note kind=checkpoint to write the current goal, facts, assumptions, ruled-out directions, and next step into NOTES.md, then continue solving."
      : "The previous turn tripped the anti-loop guard. Skip the call or output pattern that caused the loop; do not repeat the same action."
    : outcome.stop === "silent"
      ? "The previous turn's provider was unresponsive for a long time; a fresh session was used to resume."
      : "The previous turn hit a recoverable provider/runtime error; a fresh session was used to resume."
  const summary = outcome.recoveryContext?.summary.trim()
  const snapshot = summary
    ? "Activity-context snapshot auto-exported before the stall (tool calls and key results, truncated):\n\n" + summary
    : outcome.recoveryContext?.contextWarning
      ? `Failed to export activity context before the stall: ${outcome.recoveryContext.contextWarning}`
      : ""
  return [
    action,
    `This is recovery attempt ${attempt}/${RUN_RECOVERY_ATTEMPTS}; prior results in work/ and NOTES.md are unchanged.`,
    outcome.detail ? `Original stop reason: ${outcome.detail}` : "",
    "Check the durable state first and continue from the last incomplete step; do not redo from scratch.",
    snapshot,
  ].filter(Boolean).join("\n")
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function solverPromptCapabilities(runtime: RuntimeHandle, category?: string) {
  const normalized = category?.trim() ? normalizeChallengeCategory(category) : undefined
  if ((normalized !== "REVERSE" && normalized !== "PWN") || !runtime.mcp) return {}
  try {
    const [store, statuses] = await Promise.all([
      loadMcpStore(),
      runtime.mcp.status(),
    ])
    return {
      headlessIda: managedMcpAvailableToAgent(store, statuses, "idalib", "boom"),
    }
  } catch {
    // Capability hints fail closed: solving must continue if MCP status inspection is unavailable.
    return {}
  }
}

/**
 * Best-effort context windows for consultation budgets, resolved from the runtime's provider
 * catalog. An unresolved or unexposed window never caps a budget; the consultation prompt ladder
 * remains the fit guarantee. Catalog entries may report Boom's own floor instead of the true
 * window, in which case the cap is a no-op.
 */
async function consultationModelWindows(
  runtime: RuntimeHandle,
  input: { experts: string[]; synthesizer: string },
): Promise<ConsultationWindows> {
  const windows: ConsultationWindows = {}
  try {
    if (!runtime.provider) return windows
    const catalog = await runtime.provider.listProviders()
    const resolve = (model: string): number | undefined => {
      const [providerID, ...rest] = model.split("/")
      const modelID = rest.join("/")
      for (const candidate of [providerID, providerID === "free" ? "opencode" : providerID]) {
        const provider = catalog.all.find((item) => item.id === candidate)
        const context = provider?.models[modelID]?.limit?.context
        if (context !== undefined && Number.isFinite(context) && context > 0) return context
      }
      return undefined
    }
    const expertWindows = input.experts.map(resolve).filter((window): window is number => window !== undefined)
    if (expertWindows.length > 0) windows.expert = Math.min(...expertWindows)
    const synthesizerWindow = resolve(input.synthesizer)
    if (synthesizerWindow !== undefined) windows.synthesizer = synthesizerWindow
  } catch {
    // Provider catalogs are advisory; an unreachable runtime must not block a consultation.
  }
  return windows
}

function clampConcurrency(value: number) {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(32, Math.floor(value)))
}

function automaticConsultModels(job: Job) {
  const configured = job.consultModels
    .filter((model) => model.includes("/"))
    .slice(0, 4)
  if (configured.length >= 2) return configured
  if (configured.length === 1) return [configured[0]!, job.modelPolicy.strong]
  // Repeated models are intentionally supported by the consultation layer. This fallback keeps the
  // proactive path operational before the GUI model pool has been configured, while its synthesis
  // explicitly warns that same-model agreement is not independent corroboration.
  return [job.modelPolicy.economy, job.modelPolicy.strong]
}

function legacyTurn(run: RunHistory): TaskTurn | undefined {
  if (
    !run.startedAt ||
    !run.finishedAt ||
    !["completed", "budget", "stalled", "error", "empty", "timeout", "aborted", "silent", "blocked", "switched"].includes(run.stop)
  )
    return undefined
  return {
    id: "legacy-1",
    model: run.model,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    stop: run.stop as Outcome["stop"],
    tokens: run.tokens,
    billableTokens: run.billableTokens,
    cost: run.cost,
    candidates: run.candidates,
    ...(run.primaryCandidate ? { primaryCandidate: run.primaryCandidate } : {}),
    ...(run.detail ? { detail: run.detail } : {}),
  }
}

async function settleWithin(promises: Promise<unknown>[], timeoutMs: number) {
  if (promises.length === 0) return true
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(promises).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function finalWriteupReady(directory: string, acceptedFlag: string) {
  const target = path.join(directory, "work", "WRITEUP.md")
  const info = await lstat(target).catch(() => undefined)
  if (!info?.isFile() || info.isSymbolicLink() || info.size === 0) return false
  const text = await readFile(target, "utf8")
  return text.includes(acceptedFlag) && text.trim().length >= acceptedFlag.length + 40
}

function writeupLimits(job: Pick<Job, "limits">): Limits {
  return {
    ...job.limits,
    // The runtime cannot reliably complete even a tiny turn below this floor.  It is independent
    // of a solve budget that may have been consumed exactly when the flag was accepted.
    ...(job.limits.tokens === undefined
      ? {}
      : { tokens: Math.max(1_000, Math.min(job.limits.tokens, WRITEUP_TURN_TOKENS)) }),
    timeout: Math.min(job.limits.timeout, WRITEUP_TURN_TIMEOUT_MS),
  }
}

function asResult(job: Job, outcome: Outcome, finishedAt: number) {
  const totals = job.task ? taskTotals(job.task) : {
    tokens: outcome.tokens,
    billableTokens: outcome.billable,
    cost: outcome.cost,
  }
  // A writeup is a later turn in the same task. Keep the already accepted candidate and platform
  // verdict visible in result.json rather than making the final report look like it has no answer.
  const accepted = job.task?.acceptedFlag
  const candidates = outcome.candidates.length > 0
    ? outcome.candidates
    : accepted ? [accepted.value] : []
  const primaryCandidate = outcome.primaryCandidate ?? accepted?.value
  const platformSubmission = job.platformSubmission ?? (accepted
    ? {
        adapter: accepted.source,
        verdict: "accepted" as const,
        detail: accepted.detail,
        submittedAt: accepted.acceptedAt,
      }
    : undefined)
  return {
    slug: job.challenge.slug,
    run_id: job.workspace!.runID,
    model: job.model,
    runtime_backend: job.runtimeBackend,
    runtime_version: job.runtimeVersion,
    prompt_version: job.promptVersion,
    orchestration_variant: job.consultation
      ? "consultation"
      : job.autonomyEscalations.length > 0
        ? "autonomy-escalated"
        : "autonomy-l0",
    stop: outcome.stop,
    tokens: totals.tokens,
    billable_tokens: totals.billableTokens,
    cost: totals.cost,
    candidates,
    primary_candidate: primaryCandidate,
    alternatives: outcome.alternatives ?? [],
    candidate_source: outcome.candidateSource,
    verification: outcome.verification,
    platform_submission: platformSubmission === undefined
      ? undefined
      : {
          adapter: platformSubmission.adapter,
          verdict: platformSubmission.verdict,
          detail: platformSubmission.detail,
          submitted_at: platformSubmission.submittedAt,
        },
    flag_format: job.flagFormat,
    started_at: new Date(job.startedAt!).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: Math.max(0, finishedAt - job.startedAt!),
    last_tool: job.lastTool,
    limits: {
      // null is deliberate JSON: it distinguishes an unlimited run from an omitted legacy field.
      tokens: job.limits.tokens ?? null,
      repeats: job.limits.repeats,
      timeout_ms: job.limits.timeout,
    },
    hint: job.hint?.trim() || undefined,
    task_status: job.task?.status,
    turn_count: job.task?.turns.length,
    consultation:
      job.consultation === undefined
        ? undefined
        : {
            trigger: job.consultation.trigger,
            source_run_id: job.consultation.sourceRunID,
            expert_models: job.consultation.plans.map((plan) => plan.model),
            synthesizer_model: job.consultation.merged.model,
            plans: job.consultation.plans.map((plan) => ({
              model: plan.model,
              text: plan.text,
            })),
            merged: {
              model: job.consultation.merged.model,
              text: job.consultation.merged.text,
            },
            degraded: job.consultation.degraded,
            failures: job.consultation.failures,
            budgets: job.consultation.budgets,
            tokens: job.consultation.tokens,
            billable_tokens: job.consultation.billable,
            cost: job.consultation.cost,
          },
    context_policy: {
      consult_on_compaction: job.consultOnCompaction,
      compactions: outcome.compactions ?? 0,
    },
    autonomy:
      job.autonomyEscalations.length === 0 && !job.autonomyDecision
        ? undefined
        : {
            decision: job.autonomyDecision,
            escalations: job.autonomyEscalations.map((item) => ({
              id: item.id,
              level: item.level,
              status: item.status,
              tokens: item.tokens,
              billable_tokens: item.billable,
              cost: item.cost,
            })),
          },
    finish: outcome.finish,
    parts: outcome.parts,
    retries: outcome.retries?.length ? outcome.retries : undefined,
    detail: outcome.detail,
    reply: outcome.reply,
  }
}

export class GuiRunner {
  private root: string
  private runtime?: RuntimeHandle
  private runtimePromise?: Promise<RuntimeHandle>
  private retiredRuntimes = new Set<RuntimeHandle>()
  private launchRuntime: RuntimeLauncher
  /** Host-wide network switch applied to the runtime and its tool sandboxes. */
  private network: "allow" | "deny" = "allow"
  /** Last applied economy/strong policy; resolved into tier-declared agent resources on launch. */
  private runtimeModelPolicy?: ModelPolicy
  /** Present only when the selected solver is text-only and a vision model is configured. */
  private runtimeVisionModel?: string
  /** Optional legacy injection retained for isolated runner tests; the product has no generic adapter path. */
  private testPlatformAdapters?: TestPlatformAdapters
  private runtimeStatus: RuntimeState["status"] = "starting"
  private runtimeError?: string
  private models: ModelInfo[] = FALLBACK_MODELS
  /**
   * A dialog list request is immediately followed by a details request. Share that snapshot for a
   * very short window so opening Provider settings does not issue the same two RPCs twice.
   */
  private providerSnapshotCache?: { expiresAt: number; value: ProviderSnapshot }
  private providerSnapshotRequest?: { generation: number; value: Promise<ProviderSnapshot> }
  private providerSnapshotGeneration = 0
  private queue: Job[] = []
  private active = new Map<string, Job>()
  private executions = new Set<Promise<void>>()
  private concurrency = 1
  /**
   * Competition scheduling state. The platform allows only three challenge environments at once and
   * the match is short, so admission is resource-aware rather than a single global concurrency cap.
   */
  private competition: CompetitionSettings = DEFAULT_COMPETITION_SETTINGS
  private environments?: EnvironmentPool
  private listeners = new Set<(notification: RunnerNotification) => void>()
  private closed = false
  private platformSubmissionRetryDelayMs: number

  constructor(
    root: string,
    // Boom owns Provider credentials; the compatibility adapter may reuse OpenCode's built-in
    // model catalog. Native remains available only through an injected launcher in protocol tests.
    launchRuntime: RuntimeLauncher = startOpenCodeRuntime,
    platformAdapters?: TestPlatformAdapters,
    options: { platformSubmissionRetryDelayMs?: number; network?: "allow" | "deny" } = {},
  ) {
    this.root = root
    this.launchRuntime = launchRuntime
    this.testPlatformAdapters = platformAdapters
    this.platformSubmissionRetryDelayMs = options.platformSubmissionRetryDelayMs ?? 5_000
    this.network = options.network ?? "allow"
  }

  getRoot() {
    return this.root
  }

  setRoot(root: string) {
    if (this.active.size > 0 || this.queue.length > 0) throw new Error("Cannot change root while runs are active")
    this.root = root
    this.notify({ at: Date.now(), type: "root.changed" })
  }

  setConcurrency(value: number) {
    const concurrency = clampConcurrency(value)
    if (concurrency === this.concurrency) return concurrency
    this.concurrency = concurrency
    this.notify({
      at: Date.now(),
      type: "scheduler.concurrency.changed",
      detail: String(concurrency),
    })
    this.pump()
    return concurrency
  }

  /** Apply competition scheduling settings. Safe to call while work is in flight. */
  setCompetitionSettings(value: unknown) {
    this.competition = normalizeCompetitionSettings(value, this.competition)
    this.environmentPool().setCapacity(this.competition.remoteSlots)
    this.notify({
      at: Date.now(),
      type: "competition.settings.changed",
      detail: JSON.stringify(this.competition),
    })
    this.pump()
    return this.competition
  }

  getCompetitionSettings() {
    return this.competition
  }

  /**
   * Environment leases, created lazily so a runner without a competition adapter never allocates one.
   * Recovery goes through the configured platform adapter; a failure frees the local slot anyway
   * because holding it after losing track of the remote state would strand it for the whole match.
   */
  private environmentPool() {
    if (!this.environments) {
      this.environments = new EnvironmentPool(
        this.competition.remoteSlots,
        async (exerciseId) => {
          const adapter = await this.competitionAdapter()
          if (adapter) await adapter.recoverEnvironment(exerciseId)
        },
      )
    }
    return this.environments
  }

  /** The fixed 西湖论剑 adapter, when an AccessKey is configured. */
  private async competitionAdapter() {
    const adapter = await loadCompetitionAdapter()
    return adapter
  }

  /**
   * Candidate submission is deliberately single-platform in the product build. A supplied adapter
   * is accepted only as a test fixture so the runner's verdict state machine can remain unit-tested
   * without making a live 西湖论剑 request.
   */
  private async submitCandidateToPlatform(input: {
    challenge: Challenge
    workspace: Workspace
    candidate: string
    signal?: AbortSignal
    /** Invoked after every live adapter response; each response consumes a platform submission. */
    onAttempt?: (result: FlagSubmissionResult, attempt: number) => Promise<void> | void
  }): Promise<FlagSubmissionResult> {
    if (input.challenge.platform?.adapter === XIHULUNJIAN_ADAPTER_ID) {
      const adapter = await this.competitionAdapter().catch(() => undefined)
      if (!adapter) {
        return {
          adapter: XIHULUNJIAN_ADAPTER_ID,
          verdict: "pending",
          detail: "西湖论剑 AccessKey 未配置；等待人工确认",
          submittedAt: new Date().toISOString(),
        }
      }
      let last: FlagSubmissionResult | undefined
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt > 1) await new Promise<void>((resolve) => setTimeout(resolve, this.platformSubmissionRetryDelayMs))
        if (input.signal?.aborted) break
        try {
          const result = await adapter.submitFlag(input)
          last = result
          await input.onAttempt?.(result, attempt)
          if (result.verdict !== "pending" || attempt === 2) return result
        } catch (error) {
          if (attempt === 2) {
            return {
              adapter: XIHULUNJIAN_ADAPTER_ID,
              verdict: "pending",
              detail: `西湖论剑提交失败；等待人工确认：${errorText(error)}`,
              submittedAt: new Date().toISOString(),
            }
          }
        }
      }
      return last ?? {
        adapter: XIHULUNJIAN_ADAPTER_ID,
        verdict: "pending",
        detail: "自动提交已取消；等待人工确认",
        submittedAt: new Date().toISOString(),
      }
    }

    // Kept unreachable in normal product setup: no UI, API route, or CLI command can configure a
    // generic adapter. It only supports the repository's injected unit-test fakes.
    if (this.testPlatformAdapters) {
      const result = await this.testPlatformAdapters.submitFlagWithRetry({ root: this.root, ...input }, {
        retryDelayMs: this.platformSubmissionRetryDelayMs,
      })
      await input.onAttempt?.(result, 1)
      return result
    }
    return {
      adapter: "manual",
      verdict: "pending",
      detail: "未配置西湖论剑题目；等待人工确认",
      submittedAt: new Date().toISOString(),
    }
  }

  getCompetitionState() {
    const clock = matchClock(this.competition, Date.now())
    const pool = this.environmentPool()
    return {
      settings: this.competition,
      clock,
      environments: {
        used: pool.size,
        limit: pool.limit,
        leases: pool.active().map((lease) => ({
          slug: lease.slug,
          exerciseId: lease.exerciseId,
          ...(lease.remote ? { remote: lease.remote } : {}),
          ...(lease.expireTime === undefined ? {} : { expireTime: lease.expireTime }),
        })),
      },
      usage: this.slotUsage(),
    }
  }

  /**
   * Bring up this challenge's environment if it needs one, taking a lease from the scarce pool.
   *
   * Never throws: a platform outage or a stuck environment must not fail the challenge outright,
   * because the solver can still make offline progress. The returned detail explains what happened so
   * it can be recorded and surfaced.
   */
  private async provisionEnvironment(job: Job): Promise<{ remote?: string; detail?: string }> {
    if (job.purpose !== "solve") return {}
    if (slotKindFor(job.challenge) !== "remote") return {}
    const exerciseId = job.challenge.platform?.challengeID
    if (!exerciseId) return {}
    const adapter = await this.competitionAdapter().catch(() => undefined)
    if (!adapter) return {}

    const pool = this.environmentPool()
    // A live, unexpired lease is reused as-is; re-provisioning would waste match time.
    const existing = pool.held(job.challenge.slug)
    if (existing?.remote && !pool.expired(job.challenge.slug)) {
      job.environmentLease = existing
      return { remote: existing.remote }
    }
    // An expired lease must be recovered before a new one is requested, or the slot leaks.
    if (existing && pool.expired(job.challenge.slug)) {
      const released = await pool.release(job.challenge.slug)
      if (released.error)
        this.recordEvent(job, {
          at: Date.now(),
          type: "status",
          status: "environment.recover.failed",
          text: released.error.message,
        })
    }

    const lease = pool.acquire(job.challenge.slug, exerciseId)
    if (!lease)
      return { detail: `线上环境已占满 ${pool.size}/${pool.limit}，本轮先做本地分析` }
    job.environmentLease = lease
    this.recordEvent(job, {
      at: Date.now(),
      type: "status",
      status: "environment.starting",
      text: `申请靶机环境（${pool.size}/${pool.limit} 占用）`,
    })
    try {
      const detail = await adapter.ensureEnvironment(exerciseId, { signal: job.controller.signal })
      const remote = detail.endpoint?.remote
      pool.update(job.challenge.slug, {
        ...(remote ? { remote } : {}),
        ...(detail.endpoint?.expireTime === undefined
          ? {}
          : { expireTime: detail.endpoint.expireTime }),
      })
      if (!remote) {
        await pool.release(job.challenge.slug)
        delete job.environmentLease
        return { detail: "平台未返回可用的靶机地址，本轮先做本地分析" }
      }
      // Persist so a later turn and the GUI both see the address.
      await updateChallengeRemote(job.challenge, remote).catch(() => {})
      this.recordEvent(job, {
        at: Date.now(),
        type: "status",
        status: "environment.ready",
        text: `靶机地址 ${remote}${
          detail.endpoint?.expireTime
            ? `，过期时间 ${new Date(detail.endpoint.expireTime).toISOString()}`
            : ""
        }`,
      })
      return { remote }
    } catch (error) {
      // Free the slot: a failed start must not hold one of three environments hostage.
      await pool.release(job.challenge.slug)
      delete job.environmentLease
      const message = errorText(error)
      this.recordEvent(job, {
        at: Date.now(),
        type: "status",
        status: "environment.start.failed",
        text: message,
      })
      return { detail: `靶机环境启动失败，本轮先做本地分析：${message}` }
    }
  }

  /**
   * Whether the competition clock says to stop solving this challenge, and why.
   *
   * Returns undefined while the challenge is still worth pursuing. A challenge holding a candidate is
   * never stopped here, because submitting is cheap and a wrong flag costs no time in this competition.
   */
  private competitionStop(job: Job) {
    if (!job.task) return undefined
    const activeMs = activeSolveTimeMs(job.task.turns)
    const hasCandidate = Boolean(
      job.task.acceptedFlag ??
        job.task.turns.some((turn) => turn.candidates.length > 0),
    )
    const decision = decideGiveUp({
      challenge: job.challenge,
      settings: this.competition,
      activeMs,
      hasCandidate,
      // Progress bookkeeping lives in the autonomy state; turns without candidates are the signal
      // available here without another disk read on the scheduling path.
      yieldsWithoutProgress: 0,
      now: Date.now(),
    })
    return decision.action === "give-up" ? decision.reason : undefined
  }

  /**
   * Give back this job's environment.
   *
   * A challenge keeps its environment while a follow-up turn for the same challenge is already queued
   * (the common local-first -> remote-solve transition), because recovering and re-provisioning would
   * waste both match time and a slot handoff. Anything else releases immediately.
   */
  private async releaseEnvironmentFor(job: Job) {
    if (!job.environmentLease) return
    const pool = this.environmentPool()
    // A writeup is offline: do not keep a scarce target alive merely to document a solved task.
    const stillNeeded = this.queue.some((queued) =>
      queued.challenge.slug === job.challenge.slug && queued.purpose === "solve",
    )
    if (stillNeeded) return
    const result = await pool.release(job.challenge.slug)
    if (result.error) {
      this.notify({
        at: Date.now(),
        type: "environment.recover.failed",
        slug: job.challenge.slug,
        detail: result.error.message,
      })
    } else if (result.released) {
      this.notify({
        at: Date.now(),
        type: "environment.recovered",
        slug: job.challenge.slug,
        detail: `已回收靶机环境（${pool.size}/${pool.limit} 占用）`,
      })
    }
    delete job.environmentLease
  }

  /**
   * Stop only work that could use a remote target, then recover every lease owned by this runner.
   * Local analysis and an already-offline writeup are deliberately left alone.
   */
  async closeAllEnvironments() {
    const pool = this.environmentPool()
    const leases = pool.active()
    const remoteJob = (job: Job) => job.purpose === "solve" && slotKindFor(job.challenge) === "remote"
    let stopped = 0

    const retained: Job[] = []
    for (const job of this.queue) {
      if (!remoteJob(job)) {
        retained.push(job)
        continue
      }
      job.controller.abort()
      stopped += 1
      this.notify({ at: Date.now(), type: "run.aborted", slug: job.challenge.slug, runID: job.queueID })
    }
    this.queue = retained

    for (const job of this.active.values()) {
      if (!remoteJob(job)) continue
      job.controller.abort()
      stopped += 1
    }

    const errors = await pool.releaseAll()
    for (const job of this.active.values()) delete job.environmentLease
    const detail = errors.length === 0
      ? `已关闭 ${leases.length} 个靶机环境，停止 ${stopped} 个远程任务`
      : `已请求关闭 ${leases.length} 个靶机环境；${errors.length} 个回收请求失败`
    this.notify({ at: Date.now(), type: "environments.closed", detail })
    this.pump()
    return {
      stopped,
      released: leases.length,
      errors: errors.map((error) => error.message),
    }
  }

  /** How many local and remote slots the currently active jobs occupy. */
  private slotUsage(): SlotUsage {
    let local = 0
    let remote = 0
    for (const job of this.active.values()) {
      if (job.purpose === "solve" && slotKindFor(job.challenge) === "remote") remote += 1
      else local += 1
    }
    return { local, remote }
  }

  hasWork() {
    return this.active.size > 0 || this.queue.length > 0
  }

  private closeUnusedRetiredRuntimes() {
    const pinned = new Set(
      [...this.active.values()].flatMap((job) => job.runtime ? [job.runtime] : []),
    )
    for (const runtime of this.retiredRuntimes) {
      if (pinned.has(runtime)) continue
      this.retiredRuntimes.delete(runtime)
      try {
        void Promise.resolve(runtime.close()).catch((error) => {
          this.notify({
            at: Date.now(),
            type: "runtime.retired.close-error",
            detail: errorText(error),
          })
        })
      } catch (error) {
        this.notify({
          at: Date.now(),
          type: "runtime.retired.close-error",
          detail: errorText(error),
        })
      }
    }
  }

  getRuntimeState(): RuntimeState {
    return {
      status: this.runtimeStatus,
      active: this.active.size,
      queued: this.queue.length,
      concurrency: this.concurrency,
      ...(this.runtime
        ? {
            backend: this.runtime.backend,
            version: this.runtime.version,
            ...(this.runtime.promptVersion ? { promptVersion: this.runtime.promptVersion } : {}),
            capabilities: this.runtime.capabilities,
          }
        : {}),
      ...(this.runtimeError ? { error: this.runtimeError } : {}),
    }
  }

  subscribe(listener: (notification: RunnerNotification) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(notification: RunnerNotification) {
    for (const listener of this.listeners) {
      try {
        listener(notification)
      } catch {
        // One disconnected GUI client must not affect a run.
      }
    }
  }

  async ensureRuntime() {
    if (this.closed) throw new Error("GUI runner is closed")
    if (this.runtime) return this.runtime
    if (this.runtimePromise) return this.runtimePromise

    this.runtimeStatus = "starting"
    this.runtimeError = undefined
    this.notify({ at: Date.now(), type: "runtime.starting" })
    this.runtimePromise = this.launchRuntime({
      models: this.runtimeModelPolicy,
      ...(this.runtimeVisionModel ? { visionModel: this.runtimeVisionModel } : {}),
      network: this.network,
    })
      .then(async (started) => {
        if (this.closed) {
          await started.close()
          throw new Error("GUI runner closed while the runtime was starting")
        }
        this.runtime = started
        this.runtimeStatus = "ready"
        this.runtimeError = undefined
        await this.refreshModels().catch(() => {})
        this.runtimePromise = undefined
        this.notify({ at: Date.now(), type: "runtime.ready" })
        return started
      })
      .catch((error) => {
        this.runtimePromise = undefined
        if (!this.closed) {
          this.runtimeStatus = "error"
          this.runtimeError = errorText(error)
          this.notify({ at: Date.now(), type: "runtime.error", detail: this.runtimeError })
        }
        throw error
      })
    return this.runtimePromise
  }

  private async refreshModels() {
    if (!this.runtime?.provider) return
    const [catalog, store] = await Promise.all([
      this.runtime.provider.listProviders(),
      loadProviderStore(),
    ])
    const connected = new Set(catalog.connected)
    const models: ModelInfo[] = []
    for (const provider of catalog.all) {
      // The provider manager exposes the full catalog. The run settings remain intentionally small:
      // only providers that the active runtime reports ready are selectable for an actual task.
      if (!connected.has(provider.id)) continue
      const configured = new Map(
        (store.providers[provider.id]?.models ?? []).map((model) => [model.id, model]),
      )
      for (const model of Object.values(provider.models)) {
        models.push({
          id: publicRuntimeModel(provider.id, model.id),
          name: `${provider.name} · ${model.name}`,
          connected: true,
          attachment: configured.get(model.id)?.attachment ?? model.attachment,
        })
      }
    }
    if (models.length > 0) this.models = models.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async providerRuntime() {
    const runtime = await this.ensureRuntime()
    if (!runtime.provider)
      throw new Error(`Runtime backend ${runtime.backend} does not support provider management`)
    return runtime.provider
  }

  private async mcpRuntime() {
    const runtime = await this.ensureRuntime()
    if (!runtime.mcp)
      throw new Error(`Runtime backend ${runtime.backend} does not support MCP management`)
    return runtime.mcp
  }

  async getMcpServers(): Promise<McpServerDetails[]> {
    const [store, runtime] = await Promise.all([
      loadMcpStore(),
      this.mcpRuntime(),
    ])
    const statuses = await runtime.status()
    return Object.values(store.servers)
      .map((server) => ({
        ...server,
        runtime: statuses[server.id] ?? { status: server.enabled ? "failed" : "disabled", ...(
          server.enabled ? { error: "Runtime did not report this configured MCP server" } : {}
        ) } as RuntimeMcpStatus,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async saveMcpServer(input: ManagedMcpServer) {
    const server = normalizeManagedMcpServer(input)
    const store = await loadMcpStore()
    store.servers[server.id] = server
    await saveMcpStore(store)
    await this.restartRuntime()
    this.notify({ at: Date.now(), type: "mcp.changed" })
    const saved = (await this.getMcpServers()).find((item) => item.id === server.id)
    if (!saved) throw new Error(`MCP server disappeared after save: ${server.id}`)
    return saved
  }

  async deleteMcpServer(serverID: string) {
    const store = await loadMcpStore()
    if (!store.servers[serverID]) throw new Error(`No such MCP server: ${serverID}`)
    await (await this.mcpRuntime()).removeAuth(serverID).catch(() => {})
    delete store.servers[serverID]
    await saveMcpStore(store)
    await this.restartRuntime()
    this.notify({ at: Date.now(), type: "mcp.changed" })
  }

  async testMcpServer(serverID: string) {
    const store = await loadMcpStore()
    const server = store.servers[serverID]
    if (!server) throw new Error(`No such MCP server: ${serverID}`)
    const runtime = await this.mcpRuntime()
    await runtime.connect(serverID)
    const status = (await runtime.status())[serverID]
    if (!server.enabled) await runtime.disconnect(serverID)
    if (!status) throw new Error(`Runtime did not report MCP server ${serverID}`)
    return status
  }

  async startMcpOAuth(serverID: string) {
    return (await this.mcpRuntime()).startAuth(serverID)
  }

  async completeMcpOAuth(serverID: string, code: string) {
    const status = await (await this.mcpRuntime()).completeAuth(serverID, code)
    this.notify({ at: Date.now(), type: "mcp.changed" })
    return status
  }

  async removeMcpOAuth(serverID: string) {
    await (await this.mcpRuntime()).removeAuth(serverID)
    this.notify({ at: Date.now(), type: "mcp.changed" })
  }

  private async providerSnapshot(): Promise<ProviderSnapshot> {
    const now = Date.now()
    if (this.providerSnapshotCache && this.providerSnapshotCache.expiresAt > now)
      return this.providerSnapshotCache.value

    const generation = this.providerSnapshotGeneration
    const pending = this.providerSnapshotRequest
    if (pending?.generation === generation) return pending.value

    const value = (async () => {
      const runtime = await this.providerRuntime()
      const [listed, authentication, store] = await Promise.all([
        runtime.listProviders(),
        runtime.listProviderAuth(),
        loadProviderStore(),
      ])
      const snapshot = { listed, authentication, store }
      // A dialog loads the Provider list and then its selected Provider. Coalesce those duplicate
      // runtime RPCs, while keeping the cache short-lived and invalidating it on every mutation.
      if (generation === this.providerSnapshotGeneration)
        this.providerSnapshotCache = { value: snapshot, expiresAt: Date.now() + 1_500 }
      return snapshot
    })()
    this.providerSnapshotRequest = { generation, value }
    try {
      return await value
    } finally {
      if (this.providerSnapshotRequest?.value === value)
        this.providerSnapshotRequest = undefined
    }
  }

  async getProviders(): Promise<ProviderSummary[]> {
    const { listed, authentication, store } = await this.providerSnapshot()
    const connected = new Set(listed.connected)
    const catalogIDs = new Set(listed.all.map((provider) => provider.id))
    const summaries: ProviderSummary[] = listed.all.map((provider) => {
      const managed = store.providers[provider.id]
      const hidden = new Set(managed?.hiddenModels ?? [])
      const modelIDs = new Set(Object.keys(provider.models))
      const extraModels =
        managed?.models.filter((item) => !modelIDs.has(item.id)) ?? []
      const methods = authentication[provider.id] ?? []
      return {
        id: provider.id,
        name: managed?.name ?? provider.name,
        connected: connected.has(provider.id),
        configured: connected.has(provider.id) || managed !== undefined,
        custom: managed?.custom === true,
        disabled: managed?.disabled === true,
        modelCount: modelIDs.size + extraModels.length,
        visibleModelCount:
          [...modelIDs].filter((id) => !hidden.has(id)).length +
          extraModels.filter((item) => !hidden.has(item.id)).length,
        authMethods: methods.map((method, index) => ({ ...method, index })),
      }
    })
    for (const managed of Object.values(store.providers)) {
      if (catalogIDs.has(managed.id)) continue
      const hidden = new Set(managed.hiddenModels)
      summaries.push({
        id: managed.id,
        name: managed.name ?? managed.id,
        connected: connected.has(managed.id),
        configured: true,
        custom: managed.custom,
        disabled: managed.disabled,
        modelCount: managed.models.length,
        visibleModelCount: managed.models.filter((item) => !hidden.has(item.id))
          .length,
        authMethods: [{ type: "api", label: "API Key", index: 0 }],
      })
    }
    return summaries.sort(
      (a, b) =>
        Number(b.configured) - Number(a.configured) ||
        a.name.localeCompare(b.name),
    )
  }

  async getProvider(providerID: string): Promise<ProviderDetails> {
    const { listed, authentication, store } = await this.providerSnapshot()
    const catalog = listed.all.find((provider) => provider.id === providerID)
    const managed = store.providers[providerID]
    if (!catalog && !managed) throw new Error(`No such provider: ${providerID}`)
    const hidden = new Set(managed?.hiddenModels ?? [])
    const catalogModels = new Map(
      Object.values(catalog?.models ?? {}).map((item) => [item.id, item]),
    )
    const managedModels = new Map(
      (managed?.models ?? []).map((item) => [item.catalogID ?? item.id, item]),
    )
    const renamedCatalogIDs = new Set(
      (managed?.models ?? [])
        .filter((item) => item.catalogID && item.catalogID !== item.id)
        .map((item) => item.id),
    )
    const modelsByID = new Map<string, ProviderModelInfo>()
    for (const item of catalogModels.values()) {
      // A renamed catalog model is rendered once using its saved ID, instead of also exposing the
      // runtime's original catalog entry as a duplicate.
      if (renamedCatalogIDs.has(item.id) && !managedModels.has(item.id)) continue
      const configured = managedModels.get(item.id)
      const id = configured?.id ?? item.id
      modelsByID.set(id, {
        id,
        ...(configured ? { catalogID: item.id } : {}),
        name: configured?.name ?? item.name,
        context: BOOM_CONTEXT_LIMIT,
        output: configured?.output ?? item.limit.output,
        reasoning: configured?.reasoning ?? item.reasoning,
        attachment: configured?.attachment ?? item.attachment,
        ...(configured?.pricing ?? item.pricing
          ? { pricing: configured?.pricing ?? item.pricing }
          : {}),
        ...(configured?.armorPrompt
          ? { armorPrompt: configured.armorPrompt }
          : {}),
        enabled: !hidden.has(id),
        source: "catalog",
      })
    }
    for (const item of managed?.models ?? []) {
      if (catalogModels.has(item.catalogID ?? item.id)) continue
      modelsByID.set(item.id, {
        ...item,
        enabled: !hidden.has(item.id),
        source: "custom",
      })
    }
    const models = [...modelsByID.values()].sort((a, b) => a.name.localeCompare(b.name))
    const methods = authentication[providerID] ?? []
    const connected = new Set(listed.connected)
    const catalogDriver = catalog?.driver === "openai-compatible" || catalog?.driver === "openai" || catalog?.driver === "anthropic"
      ? catalog.driver
      : undefined
    const selectedDriver = managed?.driver ?? catalogDriver
    return {
      id: providerID,
      name: managed?.name ?? catalog?.name ?? providerID,
      connected: connected.has(providerID),
      configured: connected.has(providerID) || managed !== undefined,
      custom: managed?.custom === true,
      disabled: managed?.disabled === true,
      modelCount: models.length,
      visibleModelCount: models.filter((item) => item.enabled).length,
      authMethods: methods.map((method, index) => ({ ...method, index })),
        ...(managed?.npm ?? catalog?.packageName
          ? { npm: managed?.npm ?? catalog?.packageName }
        : {}),
      ...(managed?.api ?? catalog?.api
        ? { api: managed?.api ?? catalog?.api }
        : {}),
      ...(managed?.baseURL ?? catalog?.baseURL
        ? { baseURL: managed?.baseURL ?? catalog?.baseURL }
        : {}),
      ...(selectedDriver ? { driver: selectedDriver } : {}),
      models,
    }
  }

  async discoverProviderModels(input: ManagedProviderConfig, apiKey?: string) {
    const provider = normalizeProviderDiscovery(input)
    const secret = apiKey?.trim()
    if (apiKey !== undefined && (!secret || secret.length > 16_384 || secret.includes("\0")))
      throw new Error("Provider API key is invalid")
    const runtime = await this.providerRuntime()
    const models = await runtime.discoverModels({
      providerID: provider.id,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      ...(provider.driver ? { driver: provider.driver } : {}),
      ...(secret ? { apiKey: secret } : {}),
    })
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      context: BOOM_CONTEXT_LIMIT,
      output: model.limit.output,
      reasoning: model.reasoning,
      attachment: model.attachment,
      ...(model.pricing ? { pricing: model.pricing } : {}),
    } satisfies ManagedModelConfig))
  }

  private async restartRuntime() {
    // Runtime generations are immutable from a running job's perspective. Provider edits install a
    // fresh generation immediately; active jobs retain the old handle only until their switch
    // boundary, then the final owner closes it.
    // A concurrent read may still be starting the first generation. Let that launch settle before
    // detaching it, otherwise its late completion could overwrite the freshly configured handle.
    this.invalidateProviderSnapshot()
    if (!this.runtime && this.runtimePromise)
      await this.runtimePromise.catch(() => undefined)
    if (this.runtime) this.retiredRuntimes.add(this.runtime)
    this.runtime = undefined
    this.runtimePromise = undefined
    this.models = FALLBACK_MODELS
    try {
      await this.ensureRuntime()
    } finally {
      this.closeUnusedRetiredRuntimes()
    }
  }

  private invalidateProviderSnapshot() {
    this.providerSnapshotGeneration += 1
    this.providerSnapshotCache = undefined
  }

  async getArmorPrompts(): Promise<ArmorPromptPreset[]> {
    return (await loadProviderStore()).armorPrompts
  }

  async saveArmorPrompts(input: ArmorPromptPreset[]) {
    const store = replaceArmorPromptPresets(await loadProviderStore(), input)
    const saved = await saveProviderStore(store)
    await this.restartRuntime()
    await this.requestProviderHandoff(undefined, "模型系统提示词已更新")
    this.notify({ at: Date.now(), type: "armor-prompts.changed" })
    return saved.armorPrompts
  }

  async saveProvider(
    input: ManagedProviderConfig,
    apiKey?: string,
    options: ProviderSaveOptions = {},
  ): Promise<ProviderDetails | undefined> {
    const normalized = normalizeManagedProvider(input)
    // Reuse the list that populated the settings dialog rather than making another RPC solely to
    // save a local draft. The cache is invalidated below before any subsequent read.
    const { listed, store } = await this.providerSnapshot()
    const catalog = listed.all.find((provider) => provider.id === normalized.id)
    const armorPrompts = new Set(store.armorPrompts.map((item) => item.id))
    const unknownArmorPrompt = normalized.models.find(
      (item) => item.armorPrompt && !armorPrompts.has(item.armorPrompt),
    )?.armorPrompt
    if (unknownArmorPrompt)
      throw new Error(`No such armor prompt: ${unknownArmorPrompt}`)
    const previous = store.providers[normalized.id]
    if (normalized.custom && catalog && previous?.custom !== true)
      throw new Error(`Provider ID already belongs to the active runtime catalog: ${normalized.id}`)
    if (!normalized.custom && !catalog)
      throw new Error(`No runtime provider with ID: ${normalized.id}`)
    store.providers[normalized.id] = normalized
    await saveProviderStore(store)
    this.invalidateProviderSnapshot()
    const secret = apiKey?.trim()
    if (secret) {
      // Credentials are stored in Boom's private credential store. They are injected into the
      // compatibility process on its next launch, so saving a key does not itself need a restart.
      await (await this.providerRuntime()).setProviderCredential(normalized.id, secret)
    }
    if (options.apply === false) return undefined
    await this.restartRuntime()
    await this.requestProviderHandoff(normalized.id, `Provider ${normalized.id} 配置已更新`)
    this.notify({ at: Date.now(), type: "providers.changed" })
    return this.getProvider(normalized.id)
  }

  async startProviderOAuth(providerID: string, method: number) {
    const runtime = await this.providerRuntime()
    const methods = await runtime.listProviderAuth()
    const selected = methods[providerID]?.[method]
    if (!selected || selected.type !== "oauth")
      throw new Error("Selected authentication method is not available")
    return runtime.authorizeProviderOAuth(providerID, method)
  }

  async completeProviderOAuth(
    providerID: string,
    method: number,
    code?: string,
  ) {
    const runtime = await this.providerRuntime()
    await runtime.completeProviderOAuth(providerID, method, code)
    await this.restartRuntime()
    await this.requestProviderHandoff(providerID, `Provider ${providerID} OAuth 凭据已更新`)
    this.notify({ at: Date.now(), type: "providers.changed" })
    return this.getProvider(providerID)
  }

  async deleteProvider(providerID: string) {
    const store = await loadProviderStore()
    const existing = store.providers[providerID]
    await (await this.providerRuntime()).removeProviderCredential(providerID).catch((error) => {
      if (!/(?:unknown configured provider|unknown provider credential)/i.test(errorText(error))) throw error
    })
    if (existing?.custom) delete store.providers[providerID]
    else {
      store.providers[providerID] = {
        id: providerID,
        custom: false,
        disabled: true,
        models: existing?.models ?? [],
        hiddenModels: existing?.hiddenModels ?? [],
        ...(existing?.name ? { name: existing.name } : {}),
        ...(existing?.npm ? { npm: existing.npm } : {}),
        ...(existing?.api ? { api: existing.api } : {}),
        ...(existing?.baseURL ? { baseURL: existing.baseURL } : {}),
        ...(existing?.driver ? { driver: existing.driver } : {}),
      }
    }
    await saveProviderStore(store)
    await this.restartRuntime()
    await this.requestProviderHandoff(providerID, `Provider ${providerID} 已移除或禁用`)
    this.notify({ at: Date.now(), type: "providers.changed" })
  }

  async removeProviderCredential(providerID: string) {
    await (await this.providerRuntime()).removeProviderCredential(providerID)
    await this.restartRuntime()
    await this.requestProviderHandoff(providerID, `Provider ${providerID} 凭据已移除`)
    this.notify({ at: Date.now(), type: "providers.changed" })
  }

  async importOpenCodeProviderCredentials() {
    const result = await importOpenCodeCredentials()
    if (result.imported.length > 0) {
      await this.restartRuntime()
      await this.requestProviderHandoff(
        undefined,
        `已从 OpenCode 迁移 ${result.imported.length} 个 Provider 凭据`,
      )
      this.notify({ at: Date.now(), type: "providers.changed" })
    }
    return result
  }

  async getModels() {
    return this.models
  }

  private visionModelFor(workModel: string, requested?: string) {
    if (!requested) return undefined
    const vision = this.models.find((model) => model.id === requested)
    if (!vision?.connected || vision.attachment !== true)
      throw new Error(`Vision model must be a connected image-capable model: ${requested}`)
    const work = this.models.find((model) => model.id === workModel)
    return work?.attachment === false ? requested : undefined
  }

  private async compatibilityWarnings(model: string) {
    const [providerID, ...modelParts] = model.split("/")
    const modelID = modelParts.join("/")
    const warnings: string[] = []
    if (!this.runtime?.capabilities.toolCalls)
      warnings.push("The new runtime does not support tool calls; only existing context and file state are available")
    if (!this.runtime?.capabilities.web)
      warnings.push("The new runtime has no web capability; use local tools or existing network evidence instead")
    try {
      const provider = await this.getProvider(providerID!)
      const selected = provider.models.find((item) => item.id === modelID)
      if (provider.disabled || !provider.connected)
        warnings.push(`Provider ${providerID} is not connected; the new turn may need additional auth or permissions`)
      if (!selected)
        warnings.push(`Model ${modelID} is not present in Provider ${providerID}'s current catalog`)
      else if (!selected.attachment)
        warnings.push("The new model does not support image attachments; read relevant content via files or command-line tools")
    } catch (error) {
      warnings.push(`Could not confirm the new provider's compatibility: ${errorText(error)}`)
    }
    return [...new Set(warnings)]
  }

  private requestSwitch(job: Job, request: ModelSwitchRequest) {
    if (!job.runtime) {
      // The scheduler has claimed the job, but no provider call has begun. Apply the new selection
      // directly so there is no empty handoff turn and no old runtime to preserve.
      job.model = request.model
      job.modelPolicy = request.policy
      job.consultModels = [...request.consultModels]
      job.blindReview = request.blindReview
      job.consultOnCompaction = request.consultOnCompaction
      this.recordEvent(job, {
        at: request.requestedAt,
        type: "status",
        status: "model.switch.applied-before-call",
        text: [
          `${request.model} · ${request.reason}`,
          ...request.warnings.map((warning) => `兼容性：${warning}`),
        ].join("\n"),
      })
      return false
    }
    job.pendingSwitch = request
    this.recordEvent(job, {
      at: request.requestedAt,
      type: "status",
      status: "model.switch.requested",
      text: [
        `${job.model} -> ${request.model} · ${request.reason}`,
        ...request.warnings.map((warning) => `兼容性：${warning}`),
      ].join("\n"),
    })
    if (!job.switchController.signal.aborted)
      job.switchController.abort(new Error(request.reason))
    return true
  }

  async applyLiveModelSettings(settings: LiveModelSettings): Promise<LiveSwitchResult> {
    await this.ensureRuntime()
    const policy = { economy: settings.economyModel, strong: settings.strongModel }
    const visionModel = this.visionModelFor(policy.strong, settings.visionModel)
    // Worker agent resources resolve their tier at runtime launch. A changed tier policy therefore
    // needs a fresh runtime generation; active jobs re-bind it at their next safe boundary. The
    // network switch is compile-time too: sandboxes and web-tool permissions only follow a restart.
    const runtimePolicyChanged =
      this.runtimeModelPolicy === undefined ||
      this.runtimeModelPolicy.economy !== policy.economy ||
      this.runtimeModelPolicy.strong !== policy.strong ||
      this.runtimeVisionModel !== visionModel ||
      this.network !== settings.network
    if (runtimePolicyChanged) {
      this.runtimeModelPolicy = policy
      this.runtimeVisionModel = visionModel
      this.network = settings.network
      await this.restartRuntime()
    }
    const targets = new Set<string>()
    for (const job of this.active.values())
      targets.add(job.purpose === "writeup" ? policy.economy : policy.strong)
    const warningMap = new Map<string, string[]>()
    await Promise.all([...targets].map(async (model) => {
      warningMap.set(model, await this.compatibilityWarnings(model))
    }))

    let active = 0
    let queued = 0
    const warnings = new Set<string>()
    for (const job of this.queue) {
      const model = job.purpose === "writeup" ? policy.economy : policy.strong
      job.model = model
      job.modelPolicy = policy
      job.consultModels = [...settings.consultModels]
      job.blindReview = settings.blindReview
      job.consultOnCompaction = settings.consultOnCompaction
      queued += 1
    }
    for (const job of this.active.values()) {
      const model = job.purpose === "writeup" ? policy.economy : policy.strong
      const modelWarnings = warningMap.get(model) ?? []
      modelWarnings.forEach((warning) => warnings.add(warning))
      if (model === job.model && !runtimePolicyChanged) {
        job.modelPolicy = policy
        job.consultModels = [...settings.consultModels]
        job.blindReview = settings.blindReview
        job.consultOnCompaction = settings.consultOnCompaction
        continue
      }
      const needsBoundary = this.requestSwitch(job, {
        model,
        policy,
        consultModels: [...settings.consultModels],
        blindReview: settings.blindReview,
        consultOnCompaction: settings.consultOnCompaction,
        requestedAt: Date.now(),
        reason: runtimePolicyChanged && model === job.model
          ? "用户修改了运行模型或 Vision 设置"
          : "用户修改了运行模型策略",
        warnings: modelWarnings,
      })
      if (needsBoundary) active += 1
    }
    return { active, queued, warnings: [...warnings] }
  }

  private async requestProviderHandoff(providerID: string | undefined, reason: string) {
    const matching = [...this.active.values()].filter((job) =>
      providerID === undefined || job.model.split("/")[0] === providerID,
    )
    const warningMap = new Map<string, string[]>()
    await Promise.all([...new Set(matching.map((job) => job.model))].map(async (model) => {
      warningMap.set(model, await this.compatibilityWarnings(model))
    }))
    for (const job of matching) {
      this.requestSwitch(job, {
        model: job.model,
        policy: job.modelPolicy,
        consultModels: [...job.consultModels],
        blindReview: job.blindReview,
        consultOnCompaction: job.consultOnCompaction,
        requestedAt: Date.now(),
        reason,
        warnings: warningMap.get(job.model) ?? [],
      })
    }
  }

  async enqueue(input: EnqueueRunsInput) {
    if (input.challenges.length === 0) throw new Error("No challenges selected")
    // Validate models and adopt the explicit policy before the runtime launches, so tier-declared
    // worker agents resolve to this policy's models. Duplicate checks stay in the queueing loop.
    for (const challenge of input.challenges) {
      const model = input.models?.[challenge.slug] ?? input.model
      if (!model.includes("/")) throw new Error(`Model must be "provider/model", got: ${model}`)
      const policy = input.modelPolicy ?? { economy: model, strong: model }
      if (!policy.economy.includes("/") || !policy.strong.includes("/"))
        throw new Error("Model policy requires provider/model values")
    }
    const desiredPolicy = input.modelPolicy ?? {
      economy: input.model,
      strong: input.model,
    }
    const runtimeAlreadyStarted = this.runtime !== undefined
    const policyChanged =
      this.runtimeModelPolicy === undefined ||
      this.runtimeModelPolicy.economy !== desiredPolicy.economy ||
      this.runtimeModelPolicy.strong !== desiredPolicy.strong
    if (policyChanged) this.runtimeModelPolicy = desiredPolicy
    await this.ensureRuntime()
    const visionModel = this.visionModelFor(input.model, input.visionModel)
    if ((runtimeAlreadyStarted && policyChanged) || this.runtimeVisionModel !== visionModel) {
      this.runtimeVisionModel = visionModel
      await this.restartRuntime()
    }
    if (this.closed) throw new Error("GUI runner is closed")
    const seen = new Set<string>()
    for (const challenge of input.challenges) {
      if (seen.has(challenge.slug)) throw new Error(`Duplicate challenge: ${challenge.slug}`)
      seen.add(challenge.slug)
      if (this.active.has(challenge.slug) || this.queue.some((job) => job.challenge.slug === challenge.slug))
        throw new Error(`Challenge is already running or queued: ${challenge.slug}`)
    }

    const queued = input.challenges.map((challenge) => {
      const model = input.models?.[challenge.slug] ?? input.model
      const event: RunEvent = { at: Date.now(), type: "status", status: "queued" }
      const job: Job = {
        queueID: `queued-${crypto.randomUUID()}`,
        challenge,
        model,
        limits: input.limits,
        hint: input.hint,
        resumeRunID: input.workspaces?.[challenge.slug],
        continuation: input.workspaces?.[challenge.slug] !== undefined,
        purpose: input.purpose ?? "solve",
        writeupAttempts: input.purpose === "writeup" ? 1 : 0,
        recoveryAttempts: 0,
        modelPolicy: input.modelPolicy ?? { economy: model, strong: model },
        consultModels: input.consultModels ?? [],
        blindReview: input.blindReview !== false,
        consultOnCompaction: input.consultOnCompaction !== false,
        environmentProfileId: input.environmentProfileIds?.[challenge.slug] ?? input.environmentProfileId,
        pythonInterpreter: input.pythonInterpreters?.[challenge.slug] ?? input.pythonInterpreter,
        executionMode: input.executionMode ?? "managed",
        consultationInput: input.consultation,
        consultationPhase: input.consultation ? "queued" : undefined,
        flagFormat: input.flagFormats?.[challenge.slug] ?? input.flagFormat,
        controller: new AbortController(),
        switchController: new AbortController(),
        queuedAt: event.at,
        events: [event],
        priorTokens: 0,
        priorBillableTokens: 0,
        priorCost: 0,
        tokens: 0,
        billableTokens: 0,
        cost: 0,
        eventWrites: Promise.resolve(),
        autonomyBudget: { tokens: input.limits.tokens, timeout: input.limits.timeout },
        autonomyEscalations: [],
      }
      this.queue.push(job)
      this.notify({ at: event.at, type: "run.queued", slug: challenge.slug, runID: job.queueID, event })
      return { slug: challenge.slug, id: job.queueID, model }
    })
    this.pump()
    return queued
  }

  /**
   * Attach a manual consultation to work that is already queued or running for this challenge.
   *
   * A live solver is handed off only at a complete message/tool-result boundary. This preserves
   * completed tool output and the runtime's active context, then the follow-up job runs the expert
   * panel before resuming the same task. Returning `undefined` means there is no in-flight job and
   * the caller should enqueue a normal manual-consultation turn instead.
   */
  requestConsultation(input: ManualConsultationRequest): ManualConsultationSchedule | undefined {
    const candidate = this.active.get(input.slug)
    const active = candidate && (
      input.sourceRunID === undefined ||
      input.sourceRunID === candidate.queueID ||
      input.sourceRunID === candidate.workspace?.runID ||
      input.sourceRunID === candidate.resumeRunID
    ) ? candidate : undefined
    if (active) {
      if (
        active.pendingConsultation ||
        active.consultationPhase === "queued" ||
        active.consultationPhase === "running"
      ) throw new Error(`Consultation is already queued or running: ${input.slug}`)

      const runID = active.workspace?.runID ?? active.queueID
      if (!active.runtime) {
        active.model = input.solverModel
        active.modelPolicy = input.modelPolicy
        active.consultModels = [...input.consultModels]
        active.blindReview = input.blindReview
        active.consultOnCompaction = input.consultOnCompaction
        active.limits = input.limits
        active.autonomyBudget = { tokens: input.limits.tokens, timeout: input.limits.timeout }
        if (active.task) {
          const totals = taskTotals(active.task)
          active.autonomyBaseline = {
            billableTokens: totals.billableTokens,
            activeSolveMs: activeSolveTimeMs(active.task.turns),
          }
        } else delete active.autonomyBaseline
        active.flagFormat = input.flagFormat
        active.consultationInput = {
          trigger: "manual",
          expertModels: [...input.expertModels],
          synthesizerModel: input.synthesizerModel,
          sourceRunID: active.workspace?.runID ?? active.resumeRunID ?? input.sourceRunID,
        }
        active.consultationPhase = "queued"
        this.recordEvent(active, {
          at: input.requestedAt,
          type: "status",
          status: "consultation.manual.queued",
          text: "用户发起多模型会诊；将在 solver 首次调用前执行",
        })
        return { mode: "before-start", runID, model: input.solverModel }
      }

      active.pendingConsultation = input
      this.recordEvent(active, {
        at: input.requestedAt,
        type: "status",
        status: "consultation.manual.requested",
        text: "用户在运行中发起多模型会诊；等待当前工具或消息到达安全边界",
      })
      if (!active.switchController.signal.aborted)
        active.switchController.abort(new Error("用户在运行中发起多模型会诊"))
      return { mode: "live-handoff", runID, model: input.solverModel }
    }

    const queued = this.queue.find((job) => job.challenge.slug === input.slug)
    if (!queued) return undefined
    if (queued.consultationInput)
      throw new Error(`Consultation is already queued or running: ${input.slug}`)
    queued.model = input.solverModel
    queued.modelPolicy = input.modelPolicy
    queued.consultModels = [...input.consultModels]
    queued.blindReview = input.blindReview
    queued.consultOnCompaction = input.consultOnCompaction
    queued.limits = input.limits
    queued.autonomyBudget = { tokens: input.limits.tokens, timeout: input.limits.timeout }
    delete queued.autonomyBaseline
    queued.flagFormat = input.flagFormat
    queued.consultationInput = {
      trigger: "manual",
      expertModels: [...input.expertModels],
      synthesizerModel: input.synthesizerModel,
      sourceRunID: queued.resumeRunID ?? input.sourceRunID,
    }
    queued.consultationPhase = "queued"
    const event: RunEvent = {
      at: input.requestedAt,
      type: "status",
      status: "consultation.manual.queued",
      text: "用户发起多模型会诊；将在 solver 首次调用前执行",
    }
    queued.events.push(event)
    this.notify({
      at: event.at,
      type: "run.consultation.queued",
      slug: queued.challenge.slug,
      runID: queued.queueID,
      event,
    })
    return { mode: "before-start", runID: queued.queueID, model: input.solverModel }
  }

  /**
   * Pick the next admissible job.
   *
   * Ordering is by competition priority rather than enqueue order, so a locally solvable easy
   * challenge is never stuck behind one waiting for a scarce environment. A job that cannot start
   * right now (its slot class is full, or the endgame has begun) is skipped rather than blocking the
   * queue, which is what keeps a saturated remote pool from starving local work.
   */
  private nextAdmissible() {
    const now = Date.now()
    const usage = this.slotUsage()
    const candidates = this.queue
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => job.controller.signal.aborted || !this.active.has(job.challenge.slug))
    if (candidates.length === 0) return undefined

    const ranked = candidates
      .map((entry) => ({
        ...entry,
        priority: entry.job.controller.signal.aborted
          ? Number.NEGATIVE_INFINITY
          : priorityOf({
              challenge: entry.job.challenge,
              score: challengeScore(entry.job.challenge),
              attempts: entry.job.task?.turns.length ?? 0,
              progressed: entry.job.continuation ? undefined : true,
            }, now),
      }))
      .sort((left, right) => left.priority - right.priority || left.index - right.index)

    for (const entry of ranked) {
      // An aborted job is drained immediately: it consumes no slot and must not linger.
      if (entry.job.controller.signal.aborted) return entry
      // The final report never talks to a target, so it must not wait for or consume a remote slot.
      const kind = entry.job.purpose === "writeup" ? "local" : slotKindFor(entry.job.challenge)
      const admission = canStart({
        kind,
        usage,
        settings: this.competition,
        // Continuations and writeups are finishing existing work, so the endgame does not block them.
        finishing: entry.job.continuation || entry.job.purpose === "writeup",
        now,
      })
      if (admission.allowed) return entry
      entry.job.admissionHold = admission.reason
    }
    return undefined
  }

  private pump() {
    while (!this.closed && this.active.size < this.concurrency && this.queue.length > 0) {
      const chosen = this.nextAdmissible()
      if (!chosen) break
      const [job] = this.queue.splice(chosen.index, 1)
      if (!job) break
      if (job.controller.signal.aborted) continue
      delete job.admissionHold
      this.active.set(job.challenge.slug, job)
      const execution = this.execute(job)
        .catch((error) => {
          this.notify({
            at: Date.now(),
            type: "run.error",
            slug: job.challenge.slug,
            runID: job.workspace?.runID ?? job.queueID,
            detail: errorText(error),
          })
        })
        .finally(() => {
          if (this.active.get(job.challenge.slug) === job)
            this.active.delete(job.challenge.slug)
          this.notify({
            at: Date.now(),
            type: "state.changed",
            slug: job.challenge.slug,
            runID: job.workspace?.runID,
          })
          this.closeUnusedRetiredRuntimes()
          // Release the environment before pumping so the freed slot is visible to the next job.
          // This runs on every terminal path, including a thrown error, which is what prevents one
          // of the three scarce environments from leaking for the rest of the match.
          void this.releaseEnvironmentFor(job).finally(() => this.pump())
        })
      this.executions.add(execution)
      void execution.then(
        () => this.executions.delete(execution),
        () => this.executions.delete(execution),
      )
    }
    this.notify({ at: Date.now(), type: "state.changed" })
  }

  private recordEvent(job: Job, event: RunEvent) {
    job.events.push(event)
    if (event.tokens !== undefined) job.tokens = event.tokens
    if (event.billable !== undefined) job.billableTokens = event.billable
    if (event.cost !== undefined) job.cost = event.cost
    if (event.tool) job.lastTool = event.tool
    if (job.workspace) {
      job.eventWrites = job.eventWrites
        .then(() => appendRunEvent(job.workspace!.directory, event))
        .catch(() => {})
    }
    this.notify({
      at: event.at,
      type: "run.event",
      slug: job.challenge.slug,
      runID: job.workspace?.runID ?? job.queueID,
      event,
    })
    if (event.type === "tool" && event.tool === "ctf-submit" && event.status === "completed")
      this.notify({
        at: event.at,
        type: "run.candidate-submitted",
        slug: job.challenge.slug,
        runID: job.workspace?.runID ?? job.queueID,
      })
  }

  private remainingAutonomyLimits(job: Job) {
    if (!job.task) return undefined
    const totals = taskTotals(job.task)
    const baseline = job.autonomyBaseline ?? { billableTokens: 0, activeSolveMs: 0 }
    const tokens = job.autonomyBudget.tokens === undefined
      ? undefined
      : Math.floor(
        job.autonomyBudget.tokens - Math.max(0, totals.billableTokens - baseline.billableTokens),
      )
    const timeout = Math.floor(
      job.autonomyBudget.timeout -
        Math.max(0, activeSolveTimeMs(job.task.turns) - baseline.activeSolveMs),
    )
    if ((tokens !== undefined && tokens < 1_000) || timeout < 1_000) return undefined
    return { ...job.limits, ...(tokens === undefined ? {} : { tokens }), timeout } satisfies Limits
  }

  private async handleAgentConsultationRequest(
    job: Job,
    resolution: "queued" | "blocked",
    detail: string,
    request: ConsultationRequestReference,
  ) {
    if (!job.workspace) return
    try {
      await handleConsultationRequest({
        directory: job.workspace.directory,
        request,
        resolution,
        detail,
      })
    } catch (error) {
      this.recordEvent(job, {
        at: Date.now(),
        type: "status",
        status: "consultation.request.state-error",
        text: errorText(error),
      })
    }
  }

  /**
   * Blind second opinion on a candidate. Advisory only: it never changes the candidate's disposition,
   * because acceptance comes from a platform verdict or the user. A failure here is reported and
   * swallowed — losing the review must not lose the candidate.
   */
  private async reviewCandidate(job: Job, candidate: string) {
    if (!job.blindReview || job.consultModels.length === 0 || !job.workspace) return undefined
    const reviewer = selectReviewer({ pool: job.consultModels, solverModel: job.model })
    this.recordEvent(job, {
      at: Date.now(),
      type: "status",
      status: "candidate.review.started",
      text: `${reviewer.model}${reviewer.sameModelAsSolver ? " (same model as solver)" : ""}`,
    })
    try {
      const review = await reviewCandidateBlind({
        runtime: (job.runtime ?? await this.ensureRuntime()).agent,
        workspace: job.workspace,
        model: reviewer.model,
        candidate,
        sameModelAsSolver: reviewer.sameModelAsSolver,
        signal: job.controller.signal,
        timeout: Math.min(job.limits.timeout, 5 * 60_000),
      })
      this.recordEvent(job, {
        at: Date.now(),
        type: "status",
        status: `candidate.review.${review.passed ? "passed" : "failed"}`,
        text: review.detail.slice(0, 2_000),
      })
      return review
    } catch (error) {
      this.recordEvent(job, {
        at: Date.now(),
        type: "status",
        status: "candidate.review.error",
        text: errorText(error),
      })
      return undefined
    }
  }

  private queueTaskFollowup(input: {
    source: Job
    purpose: "solve" | "writeup"
    hint: string
    status: string
    writeupAttempts?: number
    recoveryAttempts?: number
    consultation?: NonNullable<Outcome["consultationRequest"]>
  }) {
    const job = input.source
    if (!job.workspace || !job.task || job.controller.signal.aborted) return false
    const limits = input.purpose === "writeup"
      ? writeupLimits(job)
      : this.remainingAutonomyLimits(job)
    if (!limits) return false
    // Competition time discipline: a writeup is required for scoring and always proceeds, but more
    // solving is only worth queueing while this challenge still deserves the match clock.
    if (input.purpose === "solve") {
      const stop = this.competitionStop(job)
      if (stop) {
        this.recordEvent(job, {
          at: Date.now(),
          type: "status",
          status: "competition.give-up",
          text: stop,
        })
        return false
      }
    }
    const at = Date.now()
    const event: RunEvent = {
      at,
      type: "status",
      status: input.status,
      text: input.hint.slice(0, 2_000),
    }
    const followup: Job = {
      queueID: `queued-${crypto.randomUUID()}`,
      challenge: job.challenge,
      model: input.purpose === "writeup" ? job.modelPolicy.economy : job.model,
      limits,
      hint: input.hint,
      resumeRunID: job.workspace.runID,
      continuation: true,
      purpose: input.purpose,
      writeupAttempts: input.writeupAttempts ?? job.writeupAttempts,
      recoveryAttempts: input.recoveryAttempts ?? 0,
      modelPolicy: job.modelPolicy,
      consultModels: job.consultModels,
      blindReview: job.blindReview,
      consultOnCompaction: job.consultOnCompaction,
      executionMode: job.executionMode,
      autonomyBudget: input.purpose === "writeup"
        ? { tokens: limits.tokens, timeout: limits.timeout }
        : job.autonomyBudget,
      autonomyBaseline: input.purpose === "writeup"
        ? {
            billableTokens: taskTotals(job.task).billableTokens,
            activeSolveMs: activeSolveTimeMs(job.task.turns),
          }
        : job.autonomyBaseline,
      autonomyEscalations: [...job.autonomyEscalations],
      ...(input.consultation
        ? {
            consultationInput: {
              trigger: input.consultation.trigger,
              expertModels: automaticConsultModels(job),
              synthesizerModel: job.modelPolicy.strong,
              sourceRunID: job.workspace.runID,
              stopDetail: input.consultation.reason,
              ...(input.consultation.resumeSessionID
                ? { resumeSessionID: input.consultation.resumeSessionID }
                : {}),
              ...(input.consultation.history
                ? { history: input.consultation.history }
                : {}),
              ...(input.consultation.contextWarning
                ? { contextWarning: input.consultation.contextWarning }
                : {}),
              ...(input.consultation.request
                ? { request: input.consultation.request }
                : {}),
            },
            consultationPhase: "queued" as const,
          }
        : {}),
      flagFormat: job.flagFormat,
      controller: new AbortController(),
      switchController: new AbortController(),
      queuedAt: at,
      events: [event],
      priorTokens: 0,
      priorBillableTokens: 0,
      priorCost: 0,
      tokens: 0,
      billableTokens: 0,
      cost: 0,
      eventWrites: Promise.resolve(),
      // A hot-switch request that arrived during the previous turn's wind-down can still sit on the
      // source job when another product followup won the race (writeup, rejection retry, recovery).
      // Carry it onto this solve continuation so a later gate applies it instead of dropping it;
      // writeup turns deliberately leave it behind to be reported as unapplied instead.
      ...(input.purpose === "solve" && job.pendingSwitch ? { pendingSwitch: job.pendingSwitch } : {}),
      ...(input.purpose === "solve" && job.pendingEnvironmentSwitch
        ? { pendingEnvironmentSwitch: job.pendingEnvironmentSwitch }
        : {}),
      ...(input.purpose === "solve" && job.pendingConsultation
        ? { pendingConsultation: job.pendingConsultation }
        : {}),
    }
    this.queue.push(followup)
    if (input.purpose === "solve") {
      // Transferred onto the followup above; drop the source copies so this run's stranded-request
      // accounting does not double-report them.
      job.pendingSwitch = undefined
      job.pendingEnvironmentSwitch = undefined
      job.pendingConsultation = undefined
    }
    this.notify({
      at,
      type: input.purpose === "writeup"
        ? "run.writeup.queued"
        : input.consultation
          ? "run.consultation.queued"
          : input.status.startsWith("run.recovery")
            ? "run.recovery.queued"
          : "run.candidate-retry.queued",
      slug: job.challenge.slug,
      runID: job.workspace.runID,
      event,
      detail: input.hint,
    })
    return true
  }

  private queueAutonomyJob(job: Job, limits: Limits, hint: string, at: number) {
    const event: RunEvent = {
      at,
      type: "status",
      status: "autonomy.followup.queued",
      text: hint.slice(0, 2_000),
    }
    const followup: Job = {
      queueID: `queued-${crypto.randomUUID()}`,
      challenge: job.challenge,
      model: job.model,
      limits,
      hint,
      resumeRunID: job.workspace!.runID,
      continuation: true,
      purpose: "solve",
      writeupAttempts: job.writeupAttempts,
      recoveryAttempts: 0,
      modelPolicy: job.modelPolicy,
      consultModels: job.consultModels,
      blindReview: job.blindReview,
      consultOnCompaction: job.consultOnCompaction,
      executionMode: job.executionMode,
      autonomyBudget: job.autonomyBudget,
      autonomyBaseline: job.autonomyBaseline,
      autonomyEscalations: [...job.autonomyEscalations],
      flagFormat: job.flagFormat,
      controller: new AbortController(),
      switchController: new AbortController(),
      queuedAt: at,
      events: [event],
      priorTokens: 0,
      priorBillableTokens: 0,
      priorCost: 0,
      tokens: 0,
      billableTokens: 0,
      cost: 0,
      eventWrites: Promise.resolve(),
    }
    this.queue.push(followup)
    this.notify({
      at,
      type: "run.autonomy.queued",
      slug: job.challenge.slug,
      runID: job.workspace!.runID,
      event,
      detail: hint,
    })
  }

  private async queueAutonomyFollowup(job: Job, outcome: Outcome) {
    if (
      !job.workspace ||
      !job.task ||
      !job.turnID ||
      !job.progressBefore ||
      job.controller.signal.aborted ||
      job.task.status === "archived" ||
      job.task.status === "solved"
    ) return false
    const turnEvents = job.events.slice(job.progressEventOffset ?? 0)
    const totals = taskTotals(job.task)
    const progress = await recordTurnProgress({
      directory: job.workspace.directory,
      before: job.progressBefore,
      outcome,
      events: turnEvents,
      cumulativeBillable: totals.billableTokens,
    })
    const decision = decideAutonomy({
      state: progress.state,
      outcome,
      activeSolveMs: activeSolveTimeMs(job.task.turns),
      cumulativeBillable: totals.billableTokens,
      challengeTokenBudget: job.autonomyBudget.tokens,
      productiveLongRunningTool: hasProductiveLongRunningTool(turnEvents),
    })
    job.autonomyDecision = decision
    if (decision.action === "none") return false
    this.recordEvent(job, {
      at: Date.now(),
      type: "status",
      status: decision.action === "continue" ? "autonomy.continuation" : `autonomy.l${decision.level}`,
      text: decision.reason,
    })
    if (decision.action === "continue") {
      await markAutomaticContinuation(job.workspace.directory)
      const limits = this.remainingAutonomyLimits(job)
      if (!limits) return false
      this.queueAutonomyJob(
        job,
        limits,
        "Boom is continuing the same main agent once after a normal yield without a candidate.",
        Date.now(),
      )
      return true
    }

    const limits = this.remainingAutonomyLimits(job)
    if (!limits) return false
    this.recordEvent(job, {
      at: Date.now(),
      type: "status",
      status: `autonomy.l${decision.level}.started`,
      text: `${decision.reason} [${decision.fingerprint}]`,
    })
    let escalation: AutonomyEscalationResult
    try {
      escalation = await runAutonomyEscalation({
        runtime: (job.runtime ?? await this.ensureRuntime()).agent,
        challenge: { ...job.challenge, flagFormat: job.flagFormat },
        workspace: job.workspace,
        task: job.task,
        policy: job.modelPolicy,
        limits,
        decision,
        signal: job.controller.signal,
      })
    } catch (error) {
      if (job.controller.signal.aborted) throw error
      // A stagnation diagnosis is advisory. Losing it must not discard the solve state or stop the
      // task: the next turn continues from the same workspace with the failure recorded as a hint.
      escalation = {
        id: `failed-${crypto.randomUUID()}`,
        level: 1,
        status: "failed",
        hint: [
          "The stall-triggered consultation produced no usable conclusion, but the task continues.",
          `Failure reason: ${errorText(error)}`,
          "Check work/ and NOTES.md first and continue from the last incomplete step; do not treat the consultation failure as the challenge being done.",
        ].join("\n"),
        tokens: 0,
        billable: 0,
        cost: 0,
      }
    }
    job.autonomyEscalations.push(escalation)
    outcome.tokens += escalation.tokens
    outcome.billable += escalation.billable
    outcome.cost += escalation.cost
    const turn = job.task.turns.find((item) => item.id === job.turnID)
    if (turn) {
      turn.tokens += escalation.tokens
      turn.billableTokens += escalation.billable
      turn.cost += escalation.cost
      job.task.updatedAt = new Date().toISOString()
      await saveTaskRecord(job.workspace.directory, job.task)
    }
    this.recordEvent(job, {
      at: Date.now(),
      type: "status",
      status: `autonomy.l${decision.level}.${escalation.status}`,
      text: escalation.hint.slice(0, 2_000),
      tokens: outcome.tokens,
      billable: outcome.billable,
      cost: outcome.cost,
    })
    const afterEscalation = this.remainingAutonomyLimits(job)
    if (!afterEscalation || escalation.status === "cancelled")
      return false
    this.queueAutonomyJob(job, afterEscalation, escalation.hint, Date.now())
    return true
  }

  private async execute(job: Job) {
    let outcome: Outcome = {
      stop: "error",
      tokens: 0,
      billable: 0,
      cost: 0,
      reply: "",
      candidates: [],
      detail: "run ended before producing an outcome",
    }
    try {
      if (job.controller.signal.aborted) return
      const challenge = { ...job.challenge, flagFormat: job.flagFormat }
      await assertPathWithin(this.root, challenge.directory)
      await assertPathWithin(this.root, path.join(this.root, "runs", challenge.slug), true)
      for (const file of challenge.files)
        await assertPathWithin(challenge.directory, path.join(challenge.directory, file))
      if (job.resumeRunID) {
        const directory = await assertPathWithin(
          this.root,
          path.join(this.root, "runs", challenge.slug, job.resumeRunID),
        )
        job.workspace = { directory, runID: job.resumeRunID, extracted: [] }
      } else {
        // A model belongs to a turn, not to a task. Keep the task directory stable when the user
        // switches models on a later turn.
        job.workspace = await prepareWorkspace(this.root, challenge, "task", {
          initialNotes: job.consultationInput?.sourceNotes,
        })
      }
      job.startedAt = Date.now()
      const legacy = job.resumeRunID
        ? await readRunHistory(this.root, challenge.slug, job.resumeRunID).catch(() => undefined)
        : undefined
      job.task = await loadOrCreateTask(job.workspace.directory, {
        id: job.workspace.runID,
        slug: challenge.slug,
        model: job.model,
        createdAt: legacy?.startedAt,
        legacyTurn: legacy ? legacyTurn(legacy) : undefined,
      })
      if (job.task.status === "archived")
        throw new Error("Archived tasks cannot be continued; start a new task instead")
      if (job.task.status === "solved" && job.purpose !== "writeup")
        throw new Error("This task already has an accepted flag and is waiting for its final writeup")
      let environment = await loadTaskEnvironment(job.workspace.directory)
      if (!environment) {
        if (job.continuation && !job.environmentProfileId && !job.pythonInterpreter)
          throw new Error("This older task has no environment binding. Select or confirm a Python environment before continuing; existing artifacts were left unchanged.")
        const selected = await resolveEnvironmentProfile({
          profileId: job.environmentProfileId,
          interpreter: job.pythonInterpreter,
        })
        environment = await bindTaskEnvironment({
          directory: job.workspace.directory,
          profile: selected.profile,
          source: selected.source,
          executionMode: job.executionMode,
        })
      }
      const prior = taskTotals(job.task)
      job.autonomyBaseline ??= {
        billableTokens: prior.billableTokens,
        activeSolveMs: activeSolveTimeMs(job.task.turns),
      }
      job.priorTokens = prior.tokens
      job.priorBillableTokens = prior.billableTokens
      job.priorCost = prior.cost
      job.turnID = `turn-${job.task.turns.length + 1}-${crypto.randomUUID().slice(0, 8)}`
      job.task.status = job.purpose === "writeup" ? "solved" : "active"
      job.task.currentModel = job.model
      job.task.updatedAt = new Date(job.startedAt).toISOString()
      await saveTaskRecord(job.workspace.directory, job.task)
      await loadOrCreateAutonomyState(job.workspace.directory, job.startedAt)
      for (const event of job.events) await appendRunEvent(job.workspace.directory, event)
      const started: RunEvent = {
        at: job.startedAt,
        type: "status",
        status: "turn.started",
        text: `${job.turnID} · ${job.model}`,
      }
      this.recordEvent(job, started)
      this.notify({
        at: job.startedAt,
        type: "run.started",
        slug: challenge.slug,
        runID: job.workspace.runID,
        event: started,
      })

      if (job.controller.signal.aborted) {
        outcome = {
          stop: "aborted",
          tokens: job.tokens,
          billable: job.billableTokens,
          cost: job.cost,
          reply: "",
          candidates: [],
          detail: "aborted by user",
        }
      } else {
        // Competition build: an environment is provisioned automatically instead of waiting for a
        // human to paste a URL. The lease is taken here, at solve time, so the three scarce slots are
        // held only while a challenge is actually being worked on.
        const provisioned = await this.provisionEnvironment(job)
        if (provisioned.remote) challenge.remote = provisioned.remote
        const localFirstWithoutRemote =
          job.purpose === "solve" &&
          challenge.serviceRequired === true &&
          !challenge.remote?.trim()
        // Without an environment the solver still gets a bounded local pass: attachments and source
        // usually carry real progress, and exploit development does not need the target yet.
        let canSolve = true
        if (localFirstWithoutRemote) {
          this.recordEvent(job, {
            at: Date.now(),
            type: "status",
            status: "service.remote-missing.local-first",
            text: provisioned.detail ?? "暂无可用靶机环境；本轮先进行本地分析与 exp 开发",
          })
        }
        let runtime: RuntimeHandle | undefined
        if (canSolve) {
          runtime = await this.ensureRuntime()
          job.runtime = runtime
          job.runtimeBackend = runtime.backend
          job.runtimeVersion = runtime.version
          job.promptVersion = runtime.promptVersion
        }
        let limits = job.limits
        if (localFirstWithoutRemote) {
          limits = {
            ...limits,
            ...(limits.tokens === undefined
              ? {}
              : { tokens: Math.min(limits.tokens, LOCAL_FIRST_TURN_TOKENS) }),
            timeout: Math.min(limits.timeout, LOCAL_FIRST_TURN_TIMEOUT_MS),
          }
        }
        let hint = job.hint
        let preprocessingTokens = 0
        let preprocessingBillable = 0
        let preprocessingCost = 0
        if (canSolve && runtime && job.consultationInput) {
          job.consultationPhase = "running"
          const consultationWindows = await consultationModelWindows(runtime, {
            experts: job.consultationInput.expertModels,
            synthesizer: job.consultationInput.synthesizerModel,
          })
          const consultationBudgets = limits.tokens === undefined
            ? undefined
            : allocateConsultationBudgets(
              limits.tokens,
              job.consultationInput.expertModels.length,
              consultationWindows,
            )
          const solverTimeout = Math.max(1, Math.floor(limits.timeout * 0.5))
          this.recordEvent(job, {
            at: Date.now(),
            type: "status",
            status: "consulting",
            text: `${job.consultationInput.expertModels.join(" + ")} -> ${job.model}`,
          })
          try {
            job.consultation = await runConsultation({
              runtime: runtime.agent,
              challenge,
              workspace: job.workspace,
              trigger: job.consultationInput.trigger,
              expertModels: job.consultationInput.expertModels,
              synthesizerModel: job.consultationInput.synthesizerModel,
              notes: job.consultationInput.sourceNotes,
              stopDetail: job.consultationInput.stopDetail,
              history: job.consultationInput.history,
              contextWarning: job.consultationInput.contextWarning,
              rejectedFlags: job.task.rejectedFlags,
              sourceRunID: job.consultationInput.sourceRunID,
              budgets: consultationBudgets,
              signal: job.controller.signal,
              timeout: Math.max(1, Math.floor(limits.timeout * 0.5)),
            })
            preprocessingTokens += job.consultation.tokens
            preprocessingBillable += job.consultation.billable
            preprocessingCost += job.consultation.cost
            job.tokens = preprocessingTokens
            job.billableTokens = preprocessingBillable
            job.cost = preprocessingCost
            this.recordEvent(job, {
              at: Date.now(),
              type: "text",
              status: "consultation",
              text: `${job.consultation.degraded ? "会诊降级计划" : "会诊综合计划"}` +
                `（${job.consultation.merged.model}）\n${job.consultation.merged.text}`,
              tokens: job.tokens,
              billable: job.billableTokens,
              cost: job.cost,
            })
            hint = [consultationHint(job.consultation), job.hint?.trim()]
              .filter(Boolean)
              .join("\n\nUser-added hint: ")
            const remaining = remainingLimits(limits, job.consultation)
            if (!remaining) {
              canSolve = false
              outcome = {
                stop: "budget",
                tokens: preprocessingTokens,
                billable: preprocessingBillable,
                cost: preprocessingCost,
                reply: job.consultation.merged.text,
                candidates: [],
                detail: "run budget exhausted by multi-model consultation",
              }
            } else {
              limits = {
                ...remaining,
                ...(consultationBudgets === undefined
                  ? {}
                  : { tokens: Math.min(remaining.tokens!, consultationBudgets.solverTokens) }),
                timeout: Math.min(remaining.timeout, solverTimeout),
              }
            }
          } catch (error) {
            // Consultation is advisory. If every expert failed, keep the task alive with the solver's
            // reserved budget; a resumed session keeps its context, while a manual run starts a new
            // turn over the same durable task workspace.
            if (error instanceof ConsultationExecutionError) {
              preprocessingTokens += error.tokens
              preprocessingBillable += error.billable
              preprocessingCost += error.cost
              job.tokens = preprocessingTokens
              job.billableTokens = preprocessingBillable
              job.cost = preprocessingCost
            }
            // Consultation is advisory even for a fresh manual turn. Authentication failures,
            // provider policy refusals, and timeouts must not discard the solver budget. A user
            // cancellation is the only consultation failure that still stops the task.
            if (job.controller.signal.aborted) throw error
            const failure = errorText(error)
            this.recordEvent(job, {
              at: Date.now(),
              type: "status",
              status: "consultation.partial-failure",
              text: failure,
            })
            hint = [
              "The multi-model consultation produced no usable expert plans; each failure was saved under work/.boom/consultations/.",
              job.consultationInput.resumeSessionID
                ? "Resume the original solver session directly, reusing its history and current work state to continue."
                : "Start a fresh solver turn, reusing the same task's NOTES.md and workspace state to continue.",
              failure,
              job.hint?.trim(),
            ].filter(Boolean).join("\n\n")
            limits = {
              ...limits,
              ...(consultationBudgets === undefined ? {} : { tokens: consultationBudgets.solverTokens }),
              timeout: solverTimeout,
            }
          }
          job.consultationPhase = "complete"
        }
        if (canSolve && runtime) {
          const resumeSessionID = job.resumeSessionID ?? job.consultationInput?.resumeSessionID
          const needsFreshContinuationHandoff =
            job.continuation && job.purpose === "solve" && !resumeSessionID
          if (job.purpose === "solve" && challenge.remote?.trim() && !needsFreshContinuationHandoff) {
            hint = [
              `Remote service address: ${JSON.stringify(challenge.remote.trim())}`,
              hint,
            ].filter(Boolean).join("\n\n")
          }
          if (localFirstWithoutRemote) {
            hint = [
              "This challenge needs a target environment, but no address is available yet (the online environment has a concurrency cap and is queuing). This turn, do everything that does not need the target: analyze attachments and source, reverse-engineer, build and locally self-test an exploit, and write reusable scripts and conclusions into NOTES.md. Do not wait or declare failure just because the address is missing; once the environment is allocated a later turn will do the live integration directly.",
              hint,
            ].filter(Boolean).join("\n\n")
          }
          if (needsFreshContinuationHandoff) {
            const handoff = await buildHandoffSummary({
              directory: job.workspace.directory,
              challenge,
              task: job.task,
            })
            hint = [hint, handoff].filter(Boolean).join("\n\n")
          }
          job.progressBefore = await captureProgressSnapshot(job.workspace.directory)
          job.progressEventOffset = job.events.length
          // The in-turn dead-end brake applies to solving only. A writeup turn legitimately produces
          // nothing durable until it finishes, and the second-opinion role is separately bounded.
          const solveLimits = job.purpose === "solve"
            ? withStallBrake(limits, job.autonomyBudget.tokens)
            : limits
          const solved = await runChallenge({
            runtime: runtime.agent,
            challenge,
            workspace: job.workspace,
            model: job.model,
            limits: solveLimits,
            hint,
            continuation: job.continuation || job.task.turns.length > 0,
            promptCapabilities: await solverPromptCapabilities(runtime, challenge.category),
            resumeSessionID,
            handoffHistory: job.handoffHistory,
            handoffWarning: job.handoffWarning,
            handoffSignal: job.switchController.signal,
            handoffKind: () => job.pendingConsultation ? "consultation" : "model-switch",
            consultOnCompaction: job.consultOnCompaction,
            purpose: job.purpose,
            acceptedFlag: job.task.acceptedFlag?.value,
            signal: job.controller.signal,
            onEvent: (event) =>
              this.recordEvent(job, {
                ...event,
                ...(event.tokens === undefined
                  ? {}
                  : { tokens: event.tokens + preprocessingTokens }),
                ...(event.billable === undefined
                  ? {}
                  : { billable: event.billable + preprocessingBillable }),
                ...(event.cost === undefined
                  ? {}
                  : { cost: event.cost + preprocessingCost }),
              }),
          })
          outcome = solved
          if (job.consultation)
            outcome = addConsultationUsage(outcome, job.consultation)
          else if (preprocessingTokens > 0 || preprocessingBillable > 0 || preprocessingCost > 0)
            outcome = {
              ...outcome,
              tokens: outcome.tokens + preprocessingTokens,
              billable: outcome.billable + preprocessingBillable,
              cost: outcome.cost + preprocessingCost,
            }
        }
        // The local-first pass is finished. In the competition build this is not a dead end waiting on
        // a human: the challenge goes back to the queue to claim an environment slot when one frees up.
        if (
          localFirstWithoutRemote &&
          outcome.stop !== "aborted" &&
          outcome.stop !== "switched" &&
          outcome.candidates.length === 0
        ) {
          this.recordEvent(job, {
            at: Date.now(),
            type: "status",
            status: "service.remote.queued",
            text: "本地分析结束，等待线上环境槽位后继续联调",
          })
        }
      }
    } catch (error) {
      this.notify({
        at: Date.now(),
        type: "run.error",
        slug: job.challenge.slug,
        runID: job.workspace?.runID ?? job.queueID,
        detail: errorText(error),
      })
      if (!job.workspace) return
      job.startedAt ??= Date.now()
      outcome = {
        stop: job.controller.signal.aborted ? "aborted" : "error",
        tokens: job.tokens,
        billable: job.billableTokens,
        cost: job.cost,
        reply: "",
        candidates: [],
        detail: errorText(error),
      }
    }

    let candidateDisposition: "none" | "pending" | "accepted" | "rejected" = "none"
    let finishedAt = Date.now()
    await job.eventWrites
    if (job.task && job.turnID) {
      if (outcome.primaryCandidate && !job.controller.signal.aborted) {
        // Anti-brute-force gate. The platform allows 50 submissions per challenge and forbids
        // brute-forcing, so Boom keeps a far lower ceiling and never resends a value it already tried.
        // The ledger is durable, so restarting mid-match cannot reset the count.
        let ledger = await loadSubmissionLedger(this.root, job.challenge.slug).catch(() =>
          ({ version: 1 as const, slug: job.challenge.slug, attempts: [] }))
        const gate = gateSubmission({
          ledger,
          candidate: outcome.primaryCandidate,
          maxSubmissions: MAX_SUBMISSIONS_PER_CHALLENGE,
        })
        if (!gate.allowed) {
          job.platformSubmission = {
            adapter: job.challenge.platform?.adapter ?? "manual",
            verdict: "pending",
            detail: `未提交：${gate.reason}`,
            submittedAt: new Date().toISOString(),
          }
          this.recordEvent(job, {
            at: Date.now(),
            type: "status",
            status: "candidate.submission.skipped",
            text: gate.reason,
          })
        } else try {
          // Every adapter response is a real platform submission, so each one enters the ledger as
          // it happens — the first pending verdict included, tagged with its attempt number.
          // Recording only the final verdict used to undercount whenever the pending retry re-sent
          // the same flag and burned double quota for a single ledger row.
          job.platformSubmission = await this.submitCandidateToPlatform({
            challenge: { ...job.challenge, flagFormat: job.flagFormat },
            workspace: job.workspace!,
            candidate: outcome.primaryCandidate,
            signal: job.controller.signal,
            onAttempt: async (result, attempt) => {
              ledger = recordAttempt(ledger, {
                value: gate.value,
                verdict: result.verdict,
                at: result.submittedAt,
                detail: `[attempt ${attempt}] ${result.detail}`.slice(0, 500),
              })
              await saveSubmissionLedger(this.root, ledger).catch(() => {})
            },
          })
        } catch (error) {
          job.platformSubmission = {
            adapter: job.challenge.platform?.adapter ?? "manual",
            verdict: "pending",
            detail: `Automatic submission failed; waiting for manual confirmation: ${errorText(error)}`,
            submittedAt: new Date().toISOString(),
          }
        }
        this.recordEvent(job, {
          at: Date.now(),
          type: "status",
          status: `candidate.${job.platformSubmission.verdict}`,
          text: `${job.platformSubmission.adapter}: ${job.platformSubmission.detail}`,
        })
        if (job.platformSubmission.verdict === "pending") {
          // No verdict from the platform: the candidate goes to manual review. The solver's own
          // local verification is deliberately not used as an acceptance substitute.
          // A blind review runs here precisely because nothing else will check this candidate — it
          // stays advisory and never changes the disposition, but without it the common no-adapter
          // case gets no independent look at all.
          const review = await this.reviewCandidate(job, outcome.primaryCandidate)
          outcome = {
            ...outcome,
            tokens: outcome.tokens + (review?.tokens ?? 0),
            billable: outcome.billable + (review?.billable ?? 0),
            cost: outcome.cost + (review?.cost ?? 0),
            verification: {
              level: "unverified",
              detail: [
                `${job.platformSubmission.adapter}: ${job.platformSubmission.detail}`,
                review
                  ? `盲审（${review.model}${review.sameModelAsSolver ? "，与解题同模型，独立性有限" : ""}）：` +
                    `${review.passed ? "复核通过" : "未能复核通过"} — ${review.detail}`
                  : "",
              ].filter(Boolean).join(" | "),
            },
          }
          candidateDisposition = "pending"
        } else {
          outcome = {
            ...outcome,
            verification: {
              level: "remote",
              detail: `${job.platformSubmission.adapter}: ${job.platformSubmission.verdict} — ${job.platformSubmission.detail}`,
            },
          }
          candidateDisposition = job.platformSubmission.verdict
        }
        // The gate has now evaluated this candidate slot one way or another — accepted, rejected, or
        // held for manual review. Mark the durable slot consumed so a resumed followup of the same
        // session cannot re-offer the old flag as a fresh submission. Best-effort: a failure here is
        // reported but must not lose the candidate.
        try {
          await consumeCandidateSubmission(job.workspace!.directory)
        } catch (error) {
          this.recordEvent(job, {
            at: Date.now(),
            type: "status",
            status: "candidate.slot.consume-failed",
            text: errorText(error),
          })
        }
        finishedAt = Date.now()
      }
      job.task.turns.push({
        id: job.turnID,
        model: job.model,
        ...(job.hint?.trim() ? { prompt: job.hint.trim() } : {}),
        startedAt: new Date(job.startedAt!).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        stop: outcome.stop,
        tokens: outcome.tokens,
        billableTokens: outcome.billable,
        cost: outcome.cost,
        candidates: outcome.candidates,
        ...(outcome.primaryCandidate ? { primaryCandidate: outcome.primaryCandidate } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      })
      job.task.status = job.purpose === "writeup" && job.task.acceptedFlag
        ? "solved"
        : candidateDisposition === "accepted"
          ? "solved"
          : candidateDisposition === "pending"
            ? "candidate-found"
            : "paused"
      job.task.currentModel = job.model
      job.task.updatedAt = new Date(finishedAt).toISOString()
      await saveTaskRecord(job.workspace!.directory, job.task)

      if (outcome.primaryCandidate && candidateDisposition === "accepted") {
        const platformAccepted = job.platformSubmission?.verdict === "accepted"
        job.task = await acceptTaskFlag({
          directory: job.workspace!.directory,
          flag: outcome.primaryCandidate,
          source: platformAccepted
            ? job.platformSubmission!.adapter
            : outcome.verification?.level ?? "local",
          detail: platformAccepted
            ? job.platformSubmission!.detail
            : outcome.verification?.detail ?? "Candidate accepted",
        })
      } else if (outcome.primaryCandidate && candidateDisposition === "rejected") {
        job.task = await rejectTaskFlag(
          job.workspace!.directory,
          outcome.primaryCandidate,
          `${job.platformSubmission?.adapter ?? "platform"} judged the flag incorrect`,
        )
      }
    }

    let queuedProductFollowup = false
    const remoteURLBlocked = isRemoteURLBlocked(outcome)
    // A hot-switch request can arrive while the turn is already winding down — platform submission
    // backoff, blind review, ledger writes — after `runChallenge` has resolved, so `outcome.stop`
    // never becomes "switched". Queueing therefore must not hinge on that stop reason alone: any
    // pending switch/environment/consultation request left on the job queues a followup here, no
    // matter whether the turn ended normally or wound down on budget/stall. Hard aborts and blocked
    // remote URLs still never queue (unconsumed requests are reported below instead).
    const solvedTaskNeedsNoSolveTurn = job.purpose === "solve" && job.task?.status === "solved"
    if (
      job.task &&
      job.workspace &&
      !solvedTaskNeedsNoSolveTurn &&
      !remoteURLBlocked &&
      !job.controller.signal.aborted &&
      (
        outcome.stop === "switched" ||
        job.pendingSwitch ||
        job.pendingEnvironmentSwitch ||
        Boolean(job.pendingConsultation && job.task.status !== "solved")
      )
    ) {
      const request = job.pendingSwitch
      const environment = job.pendingEnvironmentSwitch
      const manualConsultation = job.pendingConsultation
      const limits = manualConsultation?.limits ?? this.remainingAutonomyLimits(job)
      if (limits) {
        const at = Date.now()
        const warning = request?.warnings.length
          ? `Compatibility impact: ${request.warnings.join("; ")}`
          : "No known compatibility degradation"
        const transitionHint = request && environment
          ? [
              `Model hot-swap: ${job.model} -> ${request.model}.`,
              `Task environment switch: ${job.executionMode} -> ${environment.executionMode} (${environment.profileId}).`,
              warning,
              "Preserve the prior task context, work/, NOTES.md, and completed tool results; continue from the step after the boundary.",
            ].join("\n")
          : request
            ? request.model === job.model
              ? [
                  "Worker model tier updated: the next boom-worker / boom-worker-pro delegation will use the new economy/strong model.",
                  warning,
                  "Preserve the prior task context, work/, NOTES.md, and completed tool results; continue from the step after the boundary.",
                ].join("\n")
              : [
                  `Model hot-swap: ${job.model} -> ${request.model}.`,
                  warning,
                  "Preserve the prior task context, work/, NOTES.md, and completed tool results; continue from the step after the boundary.",
                ].join("\n")
            : environment
              ? [
                  "Task environment switched; the next session uses the new environment declaration.",
                  "Preserve the prior task context, work/, NOTES.md, and completed tool results; continue from the step after the boundary.",
                ].join("\n")
              : "Preserve the prior task activity context, work/, NOTES.md, and completed tool results."
        const hint = manualConsultation
          ? [
              "The user started a multi-model consultation while the main agent was running.",
              "Complete the consultation from the just-exported activity context, then hand the synthesized plan back to the main agent to continue the task.",
              transitionHint,
            ].join("\n")
          : transitionHint
        const event: RunEvent = {
          at,
          type: "status",
          status: manualConsultation
            ? "consultation.manual.queued"
            : environment && !request
              ? "environment.switch.queued"
              : "model.switch.queued",
          text: hint,
        }
        const followup: Job = {
          queueID: `queued-${crypto.randomUUID()}`,
          challenge: job.challenge,
          model: request?.model ?? manualConsultation?.solverModel ?? job.model,
          limits,
          hint,
          resumeRunID: job.workspace.runID,
          continuation: true,
          purpose: job.purpose,
          writeupAttempts: job.writeupAttempts,
          recoveryAttempts: 0,
          modelPolicy: request?.policy ?? manualConsultation?.modelPolicy ?? job.modelPolicy,
          consultModels: request
            ? [...request.consultModels]
            : manualConsultation
              ? [...manualConsultation.consultModels]
              : [...job.consultModels],
          blindReview: request?.blindReview ?? manualConsultation?.blindReview ?? job.blindReview,
          consultOnCompaction:
            request?.consultOnCompaction ??
            manualConsultation?.consultOnCompaction ??
            job.consultOnCompaction,
          environmentProfileId: environment?.profileId ?? job.environmentProfileId,
          executionMode: environment?.executionMode ?? job.executionMode,
          autonomyBudget: manualConsultation
            ? { tokens: limits.tokens, timeout: limits.timeout }
            : job.autonomyBudget,
          autonomyBaseline: manualConsultation
            ? {
                billableTokens: taskTotals(job.task).billableTokens,
                activeSolveMs: activeSolveTimeMs(job.task.turns),
              }
            : job.autonomyBaseline,
          autonomyEscalations: manualConsultation ? [] : [...job.autonomyEscalations],
          flagFormat: manualConsultation?.flagFormat ?? job.flagFormat,
          controller: new AbortController(),
          switchController: new AbortController(),
          queuedAt: at,
          events: [event],
          priorTokens: 0,
          priorBillableTokens: 0,
          priorCost: 0,
          tokens: 0,
          billableTokens: 0,
          cost: 0,
          eventWrites: Promise.resolve(),
          ...(manualConsultation
            ? {
                consultationInput: {
                  trigger: "manual" as const,
                  expertModels: [...manualConsultation.expertModels],
                  synthesizerModel: manualConsultation.synthesizerModel,
                  sourceRunID: job.workspace.runID,
                  ...(outcome.handoff?.resumeSessionID
                    ? { resumeSessionID: outcome.handoff.resumeSessionID }
                    : {}),
                  ...(outcome.handoff?.history
                    ? { history: outcome.handoff.history }
                    : {}),
                  ...(outcome.handoff?.contextWarning
                    ? { contextWarning: outcome.handoff.contextWarning }
                    : {}),
                },
                consultationPhase: "queued" as const,
              }
            : {}),
          ...(outcome.handoff?.resumeSessionID
            ? { resumeSessionID: outcome.handoff.resumeSessionID }
            : {}),
          ...(outcome.handoff?.history
            ? { handoffHistory: outcome.handoff.history }
            : {}),
          ...(request?.warnings.length || outcome.handoff?.contextWarning
            ? {
                handoffWarning: [
                  ...(request?.warnings ?? []),
                  outcome.handoff?.contextWarning
                    ? `Prior-session context snapshot notice: ${outcome.handoff.contextWarning}`
                    : "",
                ].filter(Boolean).join("; "),
              }
            : {}),
        }
        this.queue.push(followup)
        this.notify({
          at,
          type: manualConsultation
            ? "run.consultation.queued"
            : environment && !request
              ? "run.environment-switch.queued"
              : "run.model-switch.queued",
          slug: job.challenge.slug,
          runID: job.workspace.runID,
          event,
          detail: hint,
        })
        // The followup above already adopts everything the requests asked for (model, policy,
        // consult pool, environment binding, consultation input), so the pending fields are consumed
        // now. Clear them so this turn's final accounting does not report them stranded and a later
        // gate cannot queue the same request twice.
        job.pendingSwitch = undefined
        job.pendingEnvironmentSwitch = undefined
        job.pendingConsultation = undefined
        queuedProductFollowup = true
      }
    }
    if (
      !queuedProductFollowup &&
      job.task &&
      job.workspace &&
      job.purpose === "solve" &&
      candidateDisposition === "accepted"
    ) {
      const accepted = job.task.acceptedFlag?.value
      if (accepted) {
        queuedProductFollowup = this.queueTaskFollowup({
          source: job,
          purpose: "writeup",
          writeupAttempts: 1,
          status: "writeup.queued",
          hint: [
            `Confirmed flag: ${accepted}. The target environment will be released immediately.`,
            "Now generate the Chinese WRITEUP.md offline from challenge/, work/, and NOTES.md only.",
            "If a PoC/script was actually used, include its path, invocation, and complete source; if not, do not invent one — just write the core idea, evidence, and reproduction steps.",
          ].join("\n"),
        })
      }
    }
    if (!queuedProductFollowup && job.task && job.workspace && job.purpose === "writeup") {
      const accepted = job.task.acceptedFlag?.value
      if (accepted) {
        // A writeup turn is not allowed to replace the already accepted candidate, even if the
        // model ignores its prompt and calls ctf-submit again.
        await submitCandidate({
          directory: job.workspace.directory,
          sessionID: `accepted:${job.task.id}`,
          candidate: accepted,
        })
      }
      if (accepted && await finalWriteupReady(job.workspace.directory, accepted)) {
        job.task = await archiveTask(job.workspace.directory)
        this.notify({
          at: Date.now(),
          type: "task.archived",
          slug: job.challenge.slug,
          runID: job.workspace.runID,
          detail: "accepted flag writeup completed",
        })
      } else if (!job.controller.signal.aborted && job.writeupAttempts < 2) {
        queuedProductFollowup = this.queueTaskFollowup({
          source: job,
          purpose: "writeup",
          writeupAttempts: job.writeupAttempts + 1,
          status: "writeup.retry.queued",
          hint: "The final Chinese WRITEUP.md does not yet contain the confirmed flag or enough derivation. If there is no PoC, do not invent one; just write the verified reasoning and reproduction steps, then finish.",
        })
      }
    } else if (
      !queuedProductFollowup &&
      !remoteURLBlocked &&
      job.task &&
      outcome.primaryCandidate &&
      candidateDisposition === "rejected"
    ) {
      queuedProductFollowup = this.queueTaskFollowup({
        source: job,
        purpose: "solve",
        status: "candidate.rejected.continue",
        hint: [
          `Candidate ${JSON.stringify(outcome.primaryCandidate)} was judged incorrect; do not submit it again.`,
          `Platform verdict: ${job.platformSubmission?.adapter ?? "platform"} — ${outcome.verification?.detail ?? job.platformSubmission?.detail ?? "no further info"}`,
          "Check the error in the prior derivation and keep looking for a new flag; call ctf-submit as soon as you have a new candidate.",
        ].join("\n"),
      })
    }

    if (
      !queuedProductFollowup &&
      !remoteURLBlocked &&
      candidateDisposition === "none" &&
      job.purpose === "solve" &&
      outcome.consultationRequest
    ) {
      const request = outcome.consultationRequest
      const alreadyHandled =
        request.trigger === "agent-request" &&
        request.request !== undefined &&
        job.consultationInput?.request?.sessionID === request.request.sessionID &&
        job.consultationInput.request.requestedAt === request.request.requestedAt
      if (alreadyHandled) {
        // The durable latch is best-effort. This in-memory identity check keeps a harmless state-file
        // write failure from recursively scheduling the same consultation in the current process.
        await this.handleAgentConsultationRequest(
          job,
          "queued",
          "duplicate request ignored after its consultation already ran",
          request.request!,
        )
      } else {
        queuedProductFollowup = this.queueTaskFollowup({
          source: job,
          purpose: "solve",
          status: `consultation.${request.trigger}.queued`,
          hint: request.trigger === "compaction"
            ? "The context has been compacted. Run the multi-model consultation first, then continue solving from NOTES.md and the workspace state per the synthesized plan."
            : `The main model proactively requested a multi-model consultation: ${request.reason}`,
          consultation: request,
        })
      }
      if (!alreadyHandled && request.trigger === "agent-request" && request.request) {
        const detail = queuedProductFollowup
          ? "multi-model consultation is queued"
          : job.controller.signal.aborted
            ? "consultation was not queued because the task was cancelled"
            : "consultation was not queued because the authorized run budget is exhausted"
        await this.handleAgentConsultationRequest(
          job,
          queuedProductFollowup ? "queued" : "blocked",
          detail,
          request.request,
        )
        if (!queuedProductFollowup) {
          this.recordEvent(job, {
            at: Date.now(),
            type: "status",
            status: "consultation.agent-request.blocked",
            text: detail,
          })
        }
      }
    }

    if (
      !queuedProductFollowup &&
      !remoteURLBlocked &&
      candidateDisposition === "none" &&
      job.purpose === "solve" &&
      job.recoveryAttempts < RUN_RECOVERY_ATTEMPTS &&
      recoverableRunOutcome(outcome)
    ) {
      const attempt = job.recoveryAttempts + 1
      queuedProductFollowup = this.queueTaskFollowup({
        source: job,
        purpose: "solve",
        status: "run.recovery.queued",
        hint: recoveryHint(outcome, attempt),
        recoveryAttempts: attempt,
      })
    }

    if (!queuedProductFollowup && !remoteURLBlocked && candidateDisposition === "none" && job.purpose === "solve") {
      await this.queueAutonomyFollowup(job, outcome).catch((error) => {
        this.notify({
          at: Date.now(),
          type: "run.autonomy.error",
          slug: job.challenge.slug,
          runID: job.workspace!.runID,
          detail: errorText(error),
        })
      })
    }

    // Last-chance accounting for hot-switch requests. Every path above that consumes or transfers a
    // pending request clears it; reaching this point with one still attached means nothing will ever
    // apply it — hard abort, blocked remote URL, exhausted autonomy budget, competition give-up.
    // That must never die silently: broadcast a warning so the user can retry after the pause.
    if ((job.pendingSwitch || job.pendingEnvironmentSwitch) && job.task && job.workspace) {
      const giveUp = this.competitionStop(job)
      const reason = job.controller.signal.aborted
        ? "任务已被中止"
        : remoteURLBlocked
          ? "远端靶机地址被安全策略阻止"
          : giveUp
            ? `比赛收盘（${giveUp}）`
            : job.task.status === "solved"
              ? "该题已有被接受的 flag，无需切换模型继续解题"
              : this.remainingAutonomyLimits(job) === undefined
                ? "授权运行预算已耗尽，无法排队续作回合"
                : "收尾阶段无法排队续作回合"
      const detail = [
        `切换请求未能生效：${reason}，请在任务暂停后手动重试。`,
        ...(job.pendingSwitch ? [`模型切换目标：${job.pendingSwitch.model}`] : []),
        ...(job.pendingEnvironmentSwitch
          ? [`环境切换目标：${job.pendingEnvironmentSwitch.executionMode} (${job.pendingEnvironmentSwitch.profileId})`]
          : []),
      ].join("\n")
      console.warn(`[boom] ${job.challenge.slug}: ${detail.split("\n").join(" ")}`)
      this.recordEvent(job, {
        at: Date.now(),
        type: "status",
        status: "model.switch.not-applied",
        text: detail,
      })
    }
    finishedAt = Date.now()
    await job.eventWrites
    const finished: RunEvent = {
      at: finishedAt,
      type: "status",
      status: "turn.finished",
      text: outcome.detail,
      tokens: job.priorTokens + outcome.tokens,
      billable: job.priorBillableTokens + outcome.billable,
      cost: job.priorCost + outcome.cost,
    }
    // A damaged or agent-replaced event log must not prevent the authoritative result from landing.
    await appendRunEvent(job.workspace!.directory, finished).catch(() => {})
    await writeRunResultAtomic(job.workspace!.directory, asResult(job, outcome, finishedAt))
    this.notify({
      at: finishedAt,
      type: "run.finished",
      slug: job.challenge.slug,
      runID: job.workspace!.runID,
      event: finished,
    })
  }

  stop(slug?: string) {
    let stopped = 0
    const kept: Job[] = []
    for (const job of this.queue) {
      if (slug === undefined || job.challenge.slug === slug) {
        job.controller.abort()
        stopped += 1
        this.notify({ at: Date.now(), type: "run.aborted", slug: job.challenge.slug, runID: job.queueID })
      } else kept.push(job)
    }
    this.queue = kept
    for (const [activeSlug, job] of this.active) {
      if (slug === undefined || activeSlug === slug) {
        job.controller.abort()
        stopped += 1
      }
    }
    this.notify({ at: Date.now(), type: "state.changed", slug })
    return stopped
  }

  getTransientRuns(slug: string): RunHistory[] {
    const jobs = [
      ...this.queue.filter((job) => job.challenge.slug === slug),
      ...[this.active.get(slug)].filter((job): job is Job => job !== undefined),
    ]
    return jobs.map((job) => ({
      id: job.workspace?.runID ?? job.queueID,
      model: job.model,
      stop: job.workspace ? "running" : "queued",
      tokens: job.priorTokens + job.tokens,
      billableTokens: job.priorBillableTokens + job.billableTokens,
      cost: job.priorCost + job.cost,
      candidates: [],
      alternatives: [],
      flagFormat: job.flagFormat,
      reply: "",
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
      durationMs: job.startedAt ? Date.now() - job.startedAt : undefined,
      lastTool: job.lastTool,
      events: job.events,
      notes: "",
      files: [],
      taskStatus: job.task?.status ?? (job.workspace ? "active" : undefined),
      turns: job.task?.turns ?? [],
      rejectedFlags: job.task?.rejectedFlags ?? [],
      acceptedFlag: job.task?.acceptedFlag?.value,
      platformSubmission: job.platformSubmission,
      consultation:
        job.consultation === undefined
          ? undefined
          : {
              trigger: job.consultation.trigger,
              sourceRunID: job.consultation.sourceRunID,
              expertModels: job.consultation.plans.map((plan) => plan.model),
              synthesizerModel: job.consultation.merged.model,
              tokens: job.consultation.tokens,
              billableTokens: job.consultation.billable,
              cost: job.consultation.cost,
              plans: job.consultation.plans.map((plan) => ({
                model: plan.model,
                text: plan.text,
              })),
              merged: {
                model: job.consultation.merged.model,
                text: job.consultation.merged.text,
              },
              degraded: job.consultation.degraded,
            },
    }))
  }

  /**
   * Apply a task environment switch without requiring the user to stop the task first.
   *
   * Queued jobs take the new profile immediately. An active job is handed off at the next message or
   * tool-result boundary, mirroring the model hot-switch path, so the current turn keeps its own
   * environment for work already in flight.
   */
  switchTaskEnvironment(input: {
    slug: string
    profileId: string
    executionMode: ExecutionMode
  }) {
    let queued = 0
    let active = 0
    for (const job of this.queue) {
      if (job.challenge.slug !== input.slug) continue
      job.environmentProfileId = input.profileId
      job.executionMode = input.executionMode
      queued += 1
    }
    const job = this.active.get(input.slug)
    if (job) {
      if (!job.runtime) {
        job.environmentProfileId = input.profileId
        job.executionMode = input.executionMode
      } else {
        job.pendingEnvironmentSwitch = {
          profileId: input.profileId,
          executionMode: input.executionMode,
          requestedAt: Date.now(),
          reason: "用户切换了任务环境",
        }
        if (!job.switchController.signal.aborted)
          job.switchController.abort(new Error(job.pendingEnvironmentSwitch.reason))
        active += 1
      }
    }
    return { queued, active }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.stop()
    const starting = this.runtimePromise
    const executions = [...this.executions]
    const settled = await settleWithin(executions, 2_000)
    const runtimes = [
      ...(this.runtime ? [this.runtime] : []),
      ...this.retiredRuntimes,
    ]
    this.runtime = undefined
    this.retiredRuntimes.clear()
    await Promise.allSettled(runtimes.map(async (runtime) => runtime.close()))
    if (!settled) await settleWithin(executions, 1_000)
    if (starting) await settleWithin([starting], 1_000)
    this.runtimePromise = undefined
  }
}
