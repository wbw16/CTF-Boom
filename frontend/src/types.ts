export type ExecutionMode = "managed" | "isolated" | "static-only"

export type GuiSettings = {
  economyModel: string
  strongModel: string
  visionModel?: string
  tokens: number
  /** When false, a run is governed by time/repeat safeguards but has no token ceiling. */
  tokenBudgetEnabled: boolean
  repeats: number
  minutes: number
  concurrency: number
  flagFormat: string
  executionMode: ExecutionMode
  consultModels: string[]
  blindReview: boolean
  consultOnCompaction: boolean
  /** Host-wide network switch; "deny" refuses web tools and isolates bash/boom-exec sandboxes. */
  network: "allow" | "deny"
  competition: CompetitionSettings
}

export type CompetitionSettings = {
  /** Platform rule: how many challenge environments may exist at once. */
  remoteSlots: number
  /** How often unattended mode checks for new released challenges. */
  refreshIntervalMinutes?: number
  /** Local solve concurrency, bounded by this machine's CPU/memory. */
  localSlots: number
  matchMinutes: number
  endgameMinutes: number
  /** Epoch ms when the match ends; absent until the clock is started. */
  deadline?: number
  autopilotEnabled?: boolean
}

export type CompetitionState = {
  settings: CompetitionSettings
  clock: {
    started: boolean
    remainingMs: number
    elapsedMs: number
    endgame: boolean
    over: boolean
  }
  environments: {
    used: number
    limit: number
    leases: Array<{
      slug: string
      exerciseId: string
      remote?: string
      expireTime?: number
    }>
  }
  usage: { local: number; remote: number }
  autopilot?: {
    enabled: boolean
    syncing: boolean
    retries: number
    nextSyncAt?: number
    lastSyncAt?: number
    lastSuccessAt?: number
    lastError?: string
    lastResult?: { downloaded: number; queued: number; skipped: number }
  }
  unavailable?: boolean
}

export type DistributedSessionState = {
  role: "inactive" | "master" | "worker"
  status: "idle" | "connecting" | "running" | "error"
  relayURL?: string
  device?: {
    id: string
    name: string
    role: "worker" | "master-worker"
    maxSlots: number
  }
  worker?: {
    activeAssignments: number
    assignmentSlugs: string[]
    lastPollAt?: string
  }
  master?: {
    pendingFlags: number
    readyOnline: number
    activeRemote: number
    pendingWriteups: number
    lastCycleAt?: string
  }
  lastError?: string
}

export type XihulunjianNotice = {
  id: number
  title: string
  content?: string
  createdAt?: string
  createdTime?: number
  userName?: string
}

export type XihulunjianNoticeDetail = XihulunjianNotice & {
  isFile: boolean
  files: Array<{ name: string; url: string; ext?: string }>
  url?: string
}

export type ModelInfo = {
  id: string
  name: string
  connected: boolean
  attachment?: boolean
}

export type RuntimeState = {
  status: "starting" | "ready" | "error"
  active: number
  queued: number
  concurrency: number
  backend?: string
  version?: string
  promptVersion?: string
  error?: string
}

export type PythonEnvironmentProfile = {
  id: string
  displayName: string
  kind: "conda" | "python"
  interpreter: string
  prefix?: string
  pythonVersion: string
  architecture: string
  packages: Record<string, string | undefined>
  installPolicy: "deny" | "allow"
  fingerprint: string
  status: "ready" | "missing" | "invalid"
  detail?: string
}

export type EnvironmentStore = {
  version: 1
  defaultProfileId?: string
  profiles: PythonEnvironmentProfile[]
}

export type TaskEnvironmentBinding = {
  profileId: string
  displayName: string
  kind: "conda" | "python"
  interpreter: string
  prefix?: string
  pythonVersion: string
  architecture: string
  packages: Record<string, string | undefined>
  installPolicy: "deny" | "allow"
  fingerprint: string
  source: "default" | "task-override"
  executionMode: ExecutionMode
  boundAt: string
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

export type TaskTurn = {
  id: string
  model: string
  prompt?: string
  startedAt: string
  finishedAt: string
  stop: string
  tokens: number
  billableTokens: number
  cost: number
  candidates: string[]
  primaryCandidate?: string
  detail?: string
}

export type Verification = {
  level: "remote" | "local-checker" | "offline-derivation" | "model-review" | "unverified"
  detail: string
}

export type PlatformSubmission = {
  adapter: string
  verdict: "accepted" | "rejected" | "pending"
  detail: string
  submittedAt: string
}

export type RunFile = {
  path: string
  size: number
  directory: boolean
}

export type Consultation = {
  trigger: string
  sourceRunID?: string
  expertModels: string[]
  synthesizerModel?: string
  tokens: number
  billableTokens: number
  cost: number
  plans: Array<{ model: string; text: string }>
  merged?: { model: string; text: string }
  degraded?: {
    reason: "insufficient-experts" | "synthesis-failed"
    detail: string
  }
}

export type RunHistory = {
  id: string
  model: string
  runtimeBackend?: string
  runtimeVersion?: string
  promptVersion?: string
  stop: string
  tokens: number
  billableTokens: number
  cost: number
  candidates: string[]
  primaryCandidate?: string
  alternatives: string[]
  candidateSource?: "regex" | "model" | "submission"
  verification?: Verification
  platformSubmission?: PlatformSubmission
  flagFormat: string
  reply: string
  detail?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  lastTool?: string
  events: RunEvent[]
  notes: string
  writeup?: string
  files: RunFile[]
  taskStatus?: string
  turns?: TaskTurn[]
  candidateHistory?: string[]
  rejectedFlags?: string[]
  confirmedFlag?: string
  acceptedFlag?: string
  consultation?: Consultation
  environment?: TaskEnvironmentBinding
}

export type ChallengeState = "given-up" | "removed"

export type ChallengeGui = {
  slug: string
  category: string
  storagePath: string
  difficulty?: string
  description?: string
  files: RunFile[]
  flagFormat?: string
  remote?: string
  serviceRequired?: boolean
  platform?: {
    adapter: string
    challengeID?: string
  }
  state?: ChallengeState
  runs: RunHistory[]
}

export type GuiState = {
  instanceID?: string
  sequence?: number
  root: string
  settings: GuiSettings
  models: ModelInfo[]
  runtime: RuntimeState
  distributed?: DistributedSessionState
  environments: EnvironmentStore
  challenges: ChallengeGui[]
}

export type ProviderAuthMethod = {
  type: "api" | "oauth"
  label: string
  index: number
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
  authMethods: ProviderAuthMethod[]
}

export type ProviderModel = {
  id: string
  /** Runtime catalog ID this row originated from; retained when the visible Model ID is replaced. */
  catalogID?: string
  name: string
  context: number
  output: number
  reasoning: boolean
  attachment: boolean
  armorPrompt?: string
  pricing?: { input: number; output: number }
  enabled: boolean
  source: "catalog" | "custom"
}

export type ProviderDetails = ProviderSummary & {
  npm?: string
  api?: string
  baseURL?: string
  driver?: "openai-compatible" | "openai" | "anthropic"
  models: ProviderModel[]
}

export type ManagedProviderConfig = {
  id: string
  custom: boolean
  disabled: boolean
  name?: string
  npm?: string
  api?: string
  baseURL?: string
  driver?: "openai-compatible" | "openai" | "anthropic"
  models: Array<Omit<ProviderModel, "enabled" | "source">>
  hiddenModels: string[]
}

export type ArmorPromptPreset = {
  id: string
  name: string
  prompt: string
}

export type McpRuntimeStatus = {
  status: string
  error?: string
}

export type McpBase = {
  id: string
  name: string
  enabled: boolean
  timeout: number
  agents: string[]
}

export type McpLocalServer = McpBase & {
  type: "local"
  command: string[]
  environment: Record<string, string>
}

export type McpRemoteServer = McpBase & {
  type: "remote"
  url: string
  headers: Record<string, string>
  oauth: false | Record<string, unknown>
}

export type McpServer = McpLocalServer | McpRemoteServer

export type McpServerDetails = McpServer & {
  runtime: McpRuntimeStatus
}

export type RunnerNotification = {
  instanceID?: string
  at: number
  sequence?: number
  type: string
  slug?: string
  runID?: string
  event?: RunEvent
  detail?: string
}
