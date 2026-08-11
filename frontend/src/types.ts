export type ExecutionMode = "managed" | "isolated" | "static-only"

export type GuiSettings = {
  economyModel: string
  strongModel: string
  tokens: number
  repeats: number
  minutes: number
  concurrency: number
  flagFormat: string
  executionMode: ExecutionMode
  consultModels: string[]
  blindReview: boolean
  consultOnCompaction: boolean
}

export type ModelInfo = {
  id: string
  name: string
  connected: boolean
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
  root: string
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

export type PlatformSummary = {
  id: string
  name: string
  status: "draft" | "ready" | "invalid"
  profile?: string
  listChallenges: boolean
  acquireChallenges: boolean
  submitFlag: boolean
  credential?: { env: string; configured: boolean }
  error?: string
}

export type PlatformManifest = {
  version: 1
  id: string
  name?: string
  profile?: string
  status: "draft" | "ready"
  baseURL: string
  auth?: { env: string; location: string; name: string; prefix?: string }
  variables?: Record<string, unknown>
  operations: {
    listChallenges: unknown
    getChallenge?: unknown
    submitFlag?: unknown
  }
}

export type PlatformCredential = {
  env: string
  configured: boolean
}

export type PlatformCatalogItem = {
  id: string
  title: string
  challengeID?: string
  category?: string
  difficulty?: string
  points?: number
  solved?: boolean
  group?: { name: string }
}

export type PlatformCatalog = {
  items: PlatformCatalogItem[]
  page: number
  pageSize: number
  total: number
  categories: string[]
  difficulties: string[]
}

export type RunnerNotification = {
  at: number
  sequence?: number
  type: string
  slug?: string
  runID?: string
  event?: RunEvent
  detail?: string
}
