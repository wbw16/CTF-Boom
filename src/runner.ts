import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { submitCandidate } from "./candidate-submission.ts"
import type { Challenge } from "./challenge.ts"
import {
  addConsultationUsage,
  allocateConsultationBudgets,
  consultationHint,
  remainingLimits,
  runConsultation,
  ConsultationExecutionError,
  type Consultation,
  type ConsultationTrigger,
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
  PlatformAdapterRegistry,
  type FlagSubmissionResult,
} from "./platform-adapter.ts"
import { configuredPlatformAdapterRegistry } from "./http-platform-adapter.ts"
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
} from "./provider-config.ts"
import {
  loadMcpStore,
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
  RuntimeMessage,
  RuntimeMcpStatus,
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
  consultModels: string[]
  blindReview: boolean
  consultOnCompaction: boolean
}

export type LiveSwitchResult = {
  active: number
  queued: number
  warnings: string[]
}

const FALLBACK_MODELS: ModelInfo[] = [
  { id: "free/deepseek-v4-flash-free", name: "DeepSeek V4 Flash (free)", connected: true },
]

const RUN_RECOVERY_ATTEMPTS = 2
const REMOTE_URL_MISSING = "missing remote URL"

function remoteURLBlockedDetail(continuation: boolean) {
  return continuation
    ? `${REMOTE_URL_MISSING}: 该题需要远程服务，但尚未填写服务地址；本轮不会启动解题模型，请填写 URL 后再继续。`
    : `${REMOTE_URL_MISSING}: 本地分析已完成，但尚未填写服务地址；请填写 URL 后再继续。`
}

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
    /(?:repeated the same|degenerate text repetition|output ceiling exceeded)/i.test(detail)
  ) return true
  if (outcome.stop !== "error") return false
  if (["unknown", "empty", "length", "content-filter", "cancelled"].includes(outcome.finish ?? "")) return true
  // Task-time errors are recoverable by default: the workspace, NOTES.md, and the durable session
  // are preserved, so a fresh turn can continue from the last completed step. Only configuration or
  // policy failures that will repeat identically are excluded.
  return !/(?:invalid api key|invalid provider|no such provider|no such model|model .*not found|archived tasks cannot|already has an accepted flag|no environment binding|not in boom's .*allowlist|unknown boom agent|unknown configured provider|path escapes|symbolic link|permission denied|no such armor prompt|no such mcp)/i
    .test(detail)
}

function recoveryHint(outcome: Pick<Outcome, "stop" | "detail">, attempt: number) {
  const action = outcome.stop === "stalled"
    ? "上一轮触发了防循环保护。跳过导致循环的调用或输出方式，不要重复相同动作。"
    : outcome.stop === "silent"
      ? "上一轮 Provider 长时间无响应，现已使用新会话恢复。"
      : "上一轮遇到可恢复的 Provider/运行时异常，现已使用新会话恢复。"
  return [
    action,
    `这是第 ${attempt}/${RUN_RECOVERY_ATTEMPTS} 次自动恢复；work/ 与 NOTES.md 中的已有成果保持不变。`,
    outcome.detail ? `原停止原因：${outcome.detail}` : "",
    "先检查持久状态，从最后一个未完成步骤继续；不要从头重做。",
  ].filter(Boolean).join("\n")
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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

function asResult(job: Job, outcome: Outcome, finishedAt: number) {
  const totals = job.task ? taskTotals(job.task) : {
    tokens: outcome.tokens,
    billableTokens: outcome.billable,
    cost: outcome.cost,
  }
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
    candidates: outcome.candidates,
    primary_candidate: outcome.primaryCandidate,
    alternatives: outcome.alternatives ?? [],
    candidate_source: outcome.candidateSource,
    verification: outcome.verification,
    platform_submission: job.platformSubmission === undefined
      ? undefined
      : {
          adapter: job.platformSubmission.adapter,
          verdict: job.platformSubmission.verdict,
          detail: job.platformSubmission.detail,
          submitted_at: job.platformSubmission.submittedAt,
        },
    flag_format: job.flagFormat,
    started_at: new Date(job.startedAt!).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: Math.max(0, finishedAt - job.startedAt!),
    last_tool: job.lastTool,
    limits: {
      tokens: job.limits.tokens,
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
  private platformAdapters: PlatformAdapterRegistry
  private runtimeStatus: RuntimeState["status"] = "starting"
  private runtimeError?: string
  private models: ModelInfo[] = FALLBACK_MODELS
  private queue: Job[] = []
  private active = new Map<string, Job>()
  private executions = new Set<Promise<void>>()
  private concurrency = 1
  private listeners = new Set<(notification: RunnerNotification) => void>()
  private closed = false
  private platformSubmissionRetryDelayMs: number

  constructor(
    root: string,
    // Boom owns Provider credentials; the compatibility adapter may reuse OpenCode's built-in
    // model catalog. Native remains available only through an injected launcher in protocol tests.
    launchRuntime: RuntimeLauncher = startOpenCodeRuntime,
    platformAdapters: PlatformAdapterRegistry = configuredPlatformAdapterRegistry(),
    options: { platformSubmissionRetryDelayMs?: number } = {},
  ) {
    this.root = root
    this.launchRuntime = launchRuntime
    this.platformAdapters = platformAdapters
    this.platformSubmissionRetryDelayMs = options.platformSubmissionRetryDelayMs ?? 5_000
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
    this.runtimePromise = this.launchRuntime()
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
    const catalog = await this.runtime.provider.listProviders()
    const connected = new Set(catalog.connected)
    const models: ModelInfo[] = []
    for (const provider of catalog.all) {
      // The provider manager exposes the full catalog. The run settings remain intentionally small:
      // only providers that the active runtime reports ready are selectable for an actual task.
      if (!connected.has(provider.id)) continue
      for (const model of Object.values(provider.models)) {
        models.push({
          id: publicRuntimeModel(provider.id, model.id),
          name: `${provider.name} · ${model.name}`,
          connected: true,
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

  private async providerSnapshot() {
    const runtime = await this.providerRuntime()
    const [listed, authentication, store] = await Promise.all([
      runtime.listProviders(),
      runtime.listProviderAuth(),
      loadProviderStore(),
    ])
    return { listed, authentication, store }
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
      (managed?.models ?? []).map((item) => [item.id, item]),
    )
    const models: ProviderModelInfo[] = [
      ...[...catalogModels.values()].map((item) => ({
        id: item.id,
        name: managedModels.get(item.id)?.name ?? item.name,
        context: BOOM_CONTEXT_LIMIT,
        output: managedModels.get(item.id)?.output ?? item.limit.output,
        reasoning: managedModels.get(item.id)?.reasoning ?? item.reasoning,
        attachment: managedModels.get(item.id)?.attachment ?? item.attachment,
        ...(managedModels.get(item.id)?.pricing ?? item.pricing
          ? { pricing: managedModels.get(item.id)?.pricing ?? item.pricing }
          : {}),
        ...(managedModels.get(item.id)?.armorPrompt
          ? { armorPrompt: managedModels.get(item.id)?.armorPrompt }
          : {}),
        enabled: !hidden.has(item.id),
        source: "catalog" as const,
      })),
      ...(managed?.models ?? [])
        .filter((item) => !catalogModels.has(item.id))
        .map((item) => ({
          ...item,
          enabled: !hidden.has(item.id),
          source: "custom" as const,
        })),
    ].sort((a, b) => a.name.localeCompare(b.name))
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
      ...(catalog?.baseURL ?? managed?.baseURL
        ? { baseURL: catalog?.baseURL ?? managed?.baseURL }
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

  async saveProvider(input: ManagedProviderConfig, apiKey?: string) {
    const normalized = normalizeManagedProvider(input)
    const runtime = await this.providerRuntime()
    const listed = await runtime.listProviders()
    const catalog = listed.all.find((provider) => provider.id === normalized.id)
    const store = await loadProviderStore()
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
    let restarted = false
    if (normalized.custom && !catalog) {
      await this.restartRuntime()
      restarted = true
    }
    const secret = apiKey?.trim()
    if (secret) {
      const credentialRuntime = await this.ensureRuntime()
      if (!credentialRuntime.provider)
        throw new Error(`Runtime backend ${credentialRuntime.backend} does not support provider credentials`)
      await credentialRuntime.provider.setProviderCredential(normalized.id, secret)
    }
    if (!restarted) await this.restartRuntime()
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

  private async compatibilityWarnings(model: string) {
    const [providerID, ...modelParts] = model.split("/")
    const modelID = modelParts.join("/")
    const warnings: string[] = []
    if (!this.runtime?.capabilities.toolCalls)
      warnings.push("新 Runtime 不支持工具调用，只能使用已有上下文与文件状态")
    if (!this.runtime?.capabilities.web)
      warnings.push("新 Runtime 不提供 Web 能力，需要改用本地工具或已有网络证据")
    try {
      const provider = await this.getProvider(providerID!)
      const selected = provider.models.find((item) => item.id === modelID)
      if (provider.disabled || !provider.connected)
        warnings.push(`Provider ${providerID} 当前未连接，新轮次可能需要补充认证或权限`)
      if (!selected)
        warnings.push(`模型 ${modelID} 未出现在 Provider ${providerID} 的当前目录中`)
      else if (!selected.attachment)
        warnings.push("新模型不支持图片附件；需要通过文件或命令行工具读取相关内容")
    } catch (error) {
      warnings.push(`无法确认新 Provider 的兼容性：${errorText(error)}`)
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
    const policy = { economy: settings.economyModel, strong: settings.strongModel }
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
      if (model === job.model) {
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
        reason: "用户修改了运行模型策略",
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
    await this.ensureRuntime()
    if (this.closed) throw new Error("GUI runner is closed")
    const seen = new Set<string>()
    for (const challenge of input.challenges) {
      if (seen.has(challenge.slug)) throw new Error(`Duplicate challenge: ${challenge.slug}`)
      seen.add(challenge.slug)
      if (this.active.has(challenge.slug) || this.queue.some((job) => job.challenge.slug === challenge.slug))
        throw new Error(`Challenge is already running or queued: ${challenge.slug}`)
      const model = input.models?.[challenge.slug] ?? input.model
      if (!model.includes("/")) throw new Error(`Model must be "provider/model", got: ${model}`)
      const policy = input.modelPolicy ?? { economy: model, strong: model }
      if (!policy.economy.includes("/") || !policy.strong.includes("/"))
        throw new Error("Model policy requires provider/model values")
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

  private pump() {
    while (!this.closed && this.active.size < this.concurrency && this.queue.length > 0) {
      const next = this.queue.findIndex(
        (queued) => queued.controller.signal.aborted || !this.active.has(queued.challenge.slug),
      )
      if (next < 0) break
      const [job] = this.queue.splice(next, 1)
      if (!job) break
      if (job.controller.signal.aborted) continue
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
          this.pump()
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
    const tokens = Math.floor(
      job.autonomyBudget.tokens - Math.max(0, totals.billableTokens - baseline.billableTokens),
    )
    const timeout = Math.floor(
      job.autonomyBudget.timeout -
        Math.max(0, activeSolveTimeMs(job.task.turns) - baseline.activeSolveMs),
    )
    if (tokens < 1_000 || timeout < 1_000) return undefined
    return { ...job.limits, tokens, timeout } satisfies Limits
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
    const limits = this.remainingAutonomyLimits(job)
    if (!limits) return false
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
      autonomyBudget: job.autonomyBudget,
      autonomyBaseline: job.autonomyBaseline,
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
    }
    this.queue.push(followup)
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
          "自动停滞会诊没有取得可用结论，但任务继续。",
          `失败原因：${errorText(error)}`,
          "先检查 work/ 与 NOTES.md，从最后一个未完成步骤继续；不要把会诊失败当作题目完成。",
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
        const localFirstWithoutRemote =
          job.purpose === "solve" &&
          challenge.serviceRequired === true &&
          !challenge.remote?.trim()
        const mustWaitForRemote = localFirstWithoutRemote && job.continuation
        let canSolve = !mustWaitForRemote
        if (mustWaitForRemote) {
          outcome = {
            stop: "blocked",
            tokens: 0,
            billable: 0,
            cost: 0,
            reply: "",
            candidates: [],
            detail: remoteURLBlockedDetail(true),
          }
          this.recordEvent(job, {
            at: Date.now(),
            type: "status",
            status: "service.remote.blocked",
            text: outcome.detail,
          })
        } else if (localFirstWithoutRemote) {
          // A missing service address is not a scheduler prerequisite. Attachments and source often
          // support substantial offline progress. This is the one local-first turn; once it ends,
          // the task enters the explicit remote-address block until the user supplies an endpoint.
          this.recordEvent(job, {
            at: Date.now(),
            type: "status",
            status: "service.remote-missing.local-first",
            text: "未配置服务地址；本轮先进行本地分析，结束后等待用户填写 URL",
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
        let hint = job.hint
        let preprocessingTokens = 0
        let preprocessingBillable = 0
        let preprocessingCost = 0
        if (canSolve && runtime && job.consultationInput) {
          job.consultationPhase = "running"
          const consultationBudgets = allocateConsultationBudgets(
            limits.tokens,
            job.consultationInput.expertModels.length,
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
              .join("\n\n用户追加提示：")
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
                tokens: Math.min(remaining.tokens, consultationBudgets.solverTokens),
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
              "多模型会诊没有取得任何可用专家方案；失败结果已逐份保存在 work/.boom/consultations/。",
              job.consultationInput.resumeSessionID
                ? "直接恢复原 solver session，沿用其中的历史与当前工作状态继续。"
                : "启动新的 solver turn，沿用同一任务的 NOTES.md 与工作区状态继续。",
              failure,
              job.hint?.trim(),
            ].filter(Boolean).join("\n\n")
            limits = {
              ...limits,
              tokens: consultationBudgets.solverTokens,
              timeout: solverTimeout,
            }
          }
          job.consultationPhase = "complete"
        }
        if (canSolve && runtime) {
          if (challenge.remote?.trim()) {
            hint = [
              `远程服务地址：${JSON.stringify(challenge.remote.trim())}`,
              hint,
            ].filter(Boolean).join("\n\n")
          }
          if (localFirstWithoutRemote) {
            hint = [
              "该题标记为可能需要外部服务，但当前没有配置 URL 或 host:port。先完成附件、源码、静态分析和所有可离线验证；不要因为缺少地址而等待或立即判定失败。只有在证据表明确实必须连接服务时，才在 NOTES.md 中记录具体阻塞点、所需协议和地址类型，随后结束本轮等待用户补充地址。",
              hint,
            ].filter(Boolean).join("\n\n")
          }
          if (
            job.continuation &&
            job.purpose === "solve" &&
            !job.consultationInput?.resumeSessionID
          ) {
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
            resumeSessionID: job.resumeSessionID ?? job.consultationInput?.resumeSessionID,
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
        if (
          localFirstWithoutRemote &&
          !mustWaitForRemote &&
          outcome.stop !== "aborted" &&
          outcome.stop !== "switched"
        ) {
          outcome = {
            ...outcome,
            stop: "blocked",
            detail: remoteURLBlockedDetail(false),
          }
          this.recordEvent(job, {
            at: Date.now(),
            type: "status",
            status: "service.remote.blocked",
            text: outcome.detail,
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
        try {
          job.platformSubmission = await this.platformAdapters.submitFlagWithRetry(
            {
              root: this.root,
              challenge: { ...job.challenge, flagFormat: job.flagFormat },
              workspace: job.workspace!,
              candidate: outcome.primaryCandidate,
              signal: job.controller.signal,
            },
            { retryDelayMs: this.platformSubmissionRetryDelayMs },
          )
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
          `${job.platformSubmission?.adapter ?? "platform"} 已判定错误`,
        )
      }
    }

    let queuedProductFollowup = false
    const remoteURLBlocked = isRemoteURLBlocked(outcome)
    if (
      job.task &&
      job.workspace &&
      (
        (outcome.stop === "switched" &&
          (job.pendingSwitch || job.pendingEnvironmentSwitch || job.pendingConsultation)) ||
        (job.pendingConsultation && job.task.status !== "solved")
      ) &&
      !remoteURLBlocked &&
      !job.controller.signal.aborted
    ) {
      const request = job.pendingSwitch
      const environment = job.pendingEnvironmentSwitch
      const manualConsultation = job.pendingConsultation
      const limits = manualConsultation?.limits ?? this.remainingAutonomyLimits(job)
      if (limits) {
        const at = Date.now()
        const warning = request?.warnings.length
          ? `兼容性影响：${request.warnings.join("；")}`
          : "未发现已知兼容性降级"
        const transitionHint = request && environment
          ? [
              `模型热切换：${job.model} -> ${request.model}。`,
              `任务环境切换：${job.executionMode} -> ${environment.executionMode}（${environment.profileId}）。`,
              warning,
              "保留原任务上下文、work/、NOTES.md 与已完成工具结果，从边界后的下一步继续。",
            ].join("\n")
          : request
            ? [
                `模型热切换：${job.model} -> ${request.model}。`,
                warning,
                "保留原任务上下文、work/、NOTES.md 与已完成工具结果，从边界后的下一步继续。",
              ].join("\n")
            : environment
              ? [
                  "任务环境已切换，下一次会话使用新环境声明。",
                  "保留原任务上下文、work/、NOTES.md 与已完成工具结果，从边界后的下一步继续。",
                ].join("\n")
              : "保留原任务活动上下文、work/、NOTES.md 与已完成工具结果。"
        const hint = manualConsultation
          ? [
              "用户在主 agent 运行过程中发起了多模型会诊。",
              "先基于刚刚导出的活动上下文完成会诊，再把综合计划交还主 agent 继续当前任务。",
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
                    ? `旧会话上下文快照提示：${outcome.handoff.contextWarning}`
                    : "",
                ].filter(Boolean).join("；"),
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
        queuedProductFollowup = true
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
          hint: "最终中文 WRITEUP.md 尚未包含已确认 flag 和完整可复现步骤，请只补全 Writeup 后结束。",
        })
      }
    } else if (!remoteURLBlocked && job.task && outcome.primaryCandidate && candidateDisposition === "rejected") {
      queuedProductFollowup = this.queueTaskFollowup({
        source: job,
        purpose: "solve",
        status: "candidate.rejected.continue",
        hint: [
          `候选 ${JSON.stringify(outcome.primaryCandidate)} 已被判定错误，不要再次提交。`,
          `平台判定：${job.platformSubmission?.adapter ?? "platform"} — ${outcome.verification?.detail ?? job.platformSubmission?.detail ?? "无更多信息"}`,
          "检查此前推导中的错误并继续寻找新的 flag；获得新候选后立刻调用 ctf-submit。",
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
            ? "上下文已完成压缩。先执行多模型会诊，再依据综合计划从 NOTES.md 与工作区状态继续求解。"
            : `主模型主动请求多模型会诊：${request.reason}`,
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
