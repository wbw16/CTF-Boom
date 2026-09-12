export type ExecutionMode = "managed" | "isolated" | "static-only"

export type PentestAssetType = "root-domain" | "subdomain" | "ip" | "service" | "app" | "endpoint"
export type PentestSeverity = "critical" | "high" | "medium" | "low" | "info"
export type PentestObservationKind = "port" | "service" | "http" | "vuln" | "info"
export type PentestFindingStatus = "candidate" | "confirmed" | "rejected"

export type PentestEngagementSummary = {
  slug: string
  target: string
  objective: string
  authorization: string
  scope: string[]
  mode: "assessment" | "flag-hunt"
  status: "active" | "abandoned" | "archived"
  run: {
    phase: PentestAgentPhase
    turns: number
    lastEndedAt?: string
    lastError?: string
  }
  counts: {
    assets: number
    observations: number
    findings: number
    candidates: number
    confirmed: number
    runs: number
    flags: number
    flagCandidates: number
    flagsConfirmed: number
  }
  createdAt: string
  updatedAt: string
}

export type PentestEngagement = {
  version: 1
  slug: string
  target: string
  objective: string
  authorization: string
  scope: string[]
  /** Fixed operator notes captured at creation; re-stated on every agent turn. */
  userNotes?: string
  mode: "assessment" | "flag-hunt"
  status: "active" | "abandoned" | "archived"
  counters: { asset: number; observation: number; finding: number; evidence: number; run: number }
  createdAt: string
  updatedAt: string
  assets: Array<{
    id: string
    type: PentestAssetType
    value: string
    meta: string
    parentId?: string
    runId?: string
    at: string
  }>
  observations: Array<{
    id: string
    kind: PentestObservationKind
    target: string
    detail: string
    confidence: number
    runId?: string
    at: string
  }>
  evidence: Array<{
    id: string
    provenance: "tool-run" | "external-import"
    path?: string
    excerpt?: string
    note: string
    runId?: string
    at: string
  }>
  findings: Array<{
    id: string
    title: string
    severity: PentestSeverity
    status: PentestFindingStatus
    description: string
    evidenceIds: string[]
    reproducibleSteps: string[]
    affectedAssetId?: string
    at: string
    decidedAt?: string
    decisionNote?: string
  }>
  flagObjectives: Array<{
    id: string
    label: string
    hint: string
    submissions: Array<{
      id: string
      value: string
      status: "candidate" | "confirmed" | "rejected"
      evidenceIds: string[]
      findingIds: string[]
      source: "agent" | "operator"
      note: string
      at: string
      decidedAt?: string
      decisionNote?: string
    }>
  }>
  run?: {
    phase: PentestAgentPhase
    turns: number
    startedAt?: string
    lastEndedAt?: string
    lastError?: string
    lastReply?: string
    checkpointAt?: string
    checkpointNote?: string
  }
}

export type PentestToolRunStatus = "running" | "done" | "failed" | "interrupted"

export type PentestToolRunDetail = {
  run: PentestToolRun
  stdout: string
  stderr: string
}

export type PentestToolRun = {
  version: 1
  id: string
  tool: string
  args: string[]
  reason: string
  presetId?: string
  status: PentestToolRunStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  interruption?: "stopped" | "timeout" | "orphaned"
  error?: string
  parsed?: { assets: number; observations: number; error?: string }
}

export type PentestToolPresetSummary = { id: string; title: string; description: string }

export type PentestToolSummary = {
  name: string
  displayName: string
  parses: "nmap-xml" | "none"
  unattended: boolean
  note?: string
  installed: boolean
  presets: PentestToolPresetSummary[]
}

export type PentestHostTool = {
  name: string
  version?: string
}

export type PentestAgentPhase = "idle" | "running" | "pausing" | "paused" | "failed"

/**
 * One activity line. `status`/`text`/`error` carry their payload in `text`; a current `tool`
 * entry carries structured fields instead (`title` = one-line command summary, `argv` for
 * click-to-expand, `detail` = completion title, `status` = running/completed/error).
 */
export type PentestActivityEntry = {
  at: string
  kind: "status" | "text" | "tool" | "error"
  text?: string
  callID?: string
  tool?: string
  title?: string
  argv?: Record<string, unknown>
  status?: "running" | "completed" | "error"
  detail?: string
  endedAt?: string
}

/** Agent run view returned by the engagement detail endpoint. */
export type PentestAgentView = {
  phase: PentestAgentPhase
  turns: number
  startedAt?: string
  lastEndedAt?: string
  lastError?: string
  lastReply?: string
  checkpointAt?: string
  checkpointNote?: string
  live?: boolean
  activity: PentestActivityEntry[]
  liveText?: string
}

export type GuiSettings = {
  /** Product mode: "ctf" solves challenges; "pentest" emphasizes the authorized penetration console. */
  mode: "ctf" | "pentest"
  economyModel: string
  strongModel: string
  visionModel?: string
  tokens: number
  /** When false, per-turn safeguards self-recover and the task keeps running without a total ceiling. */
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
  /** Adapter id of the competition platform this root syncs challenges from. */
  platformId?: string
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

/** One competition platform adapter as listed by `GET /api/platform`. */
export type PlatformSummary = {
  id: string
  displayName: string
  defaultServerHost: string
  credential: { configured: boolean; serverHost: string }
}

export type PlatformRegistry = {
  active: PlatformSummary
  platforms: PlatformSummary[]
}

export type PlatformNotice = {
  id: number
  title: string
  content?: string
  createdAt?: string
  createdTime?: number
  userName?: string
}

export type PlatformNoticeDetail = PlatformNotice & {
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
  /** The folder Boom opens on a first launch; the workbench names it and can return to it. */
  defaultRoot?: string
  settings: GuiSettings
  models: ModelInfo[]
  runtime: RuntimeState
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
