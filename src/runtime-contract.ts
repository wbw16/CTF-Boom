/**
 * Boom-owned execution contracts.
 *
 * Core orchestration depends on these types instead of a concrete agent SDK. A runtime adapter is
 * responsible for translating its native sessions, events, model responses, and provider control
 * plane into this vocabulary.
 */

export type RuntimeUsage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type RuntimeFailureCategory =
  | "authentication"
  | "authorization"
  | "rate-limit"
  | "server"
  | "network"
  | "invalid-request"
  | "content-filter"
  | "context-overflow"
  | "unsupported"
  | "malformed-response"
  | "cancelled"
  | "unknown"

export type RuntimeFailure = {
  name?: string
  message: string
  category?: RuntimeFailureCategory
  statusCode?: number
  retryable?: boolean
  /** Bounded and redacted at the adapter boundary. Never contains headers or credentials. */
  responseBody?: string
  requestID?: string
}

export type RuntimeToolState = {
  status: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>
  title?: string
  error?: string
}

export type RuntimeConversationState =
  | "created"
  | "preparing"
  | "generating"
  | "retrying"
  | "compacting"
  | "completed"
  | "cancelled"
  | "failed"

export type RuntimeFinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "cancelled"
  | "error"
  | "empty"
  | "unknown"

export type RuntimeEvent =
  | {
      type: "conversation-state"
      sessionID: string
      state: RuntimeConversationState
    }
  | {
      type: "step-finish"
      sessionID: string
      usage: RuntimeUsage
      cost: number
      reason?: RuntimeFinishReason
    }
  | { type: "text-delta"; sessionID: string; delta: string }
  | { type: "reasoning-delta"; sessionID: string; delta: string }
  | {
      type: "tool-state"
      sessionID: string
      callID: string
      tool: string
      state: RuntimeToolState
    }
  | {
      type: "retry"
      sessionID: string
      attempt: number
      error: RuntimeFailure
      delayMs?: number
    }
  | {
      type: "compaction"
      sessionID: string
      state: "started" | "completed" | "failed"
      error?: RuntimeFailure
    }
  | {
      type: "provider-diagnostic"
      sessionID: string
      level: "warning" | "error"
      error: RuntimeFailure
    }
  | {
      type: "task-state"
      sessionID: string
      taskID: string
      parentTaskID?: string
      state: "queued" | "running" | "completed" | "failed" | "cancelled"
      depth: number
      title: string
      /** Task-root-relative durable workspace reference; never a host absolute path. */
      directory?: string
      usage?: RuntimeUsage
      cost?: number
      error?: string
    }
  | { type: "cancelled"; sessionID: string; reason?: string }
  | {
      type: "finish"
      sessionID: string
      reason: RuntimeFinishReason
      error?: RuntimeFailure
    }

export type RuntimeResponsePart = {
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: RuntimeToolState
  mime?: string
  filename?: string
  reference?: string
}

export type RuntimePromptResult = {
  parts: RuntimeResponsePart[]
  usage?: RuntimeUsage
  cost: number
  finish?: RuntimeFinishReason
  error?: RuntimeFailure
  requestID?: string
}

export type RuntimePrompt = {
  agent: string
  model: string
  text: string
  signal?: AbortSignal
}

/**
 * A provider-neutral projection used by both active-context snapshots and complete transcripts.
 * Adapters deliberately expose strings instead of provider-owned metadata so a snapshot can be
 * handed to another model without leaking SDK types, headers, or credentials.
 */
export type RuntimeMessage = {
  id: string
  role: "user" | "assistant" | "tool" | "system" | "synthetic" | "compaction"
  createdAt?: number
  parts: Array<{
    type: string
    text?: string
    tool?: string
    /** Stable provider-neutral tool-call identity used to pair tool use with its result. */
    callID?: string
    state?: "pending" | "running" | "completed" | "error"
    input?: string
    output?: string
    error?: string
  }>
}

export type RuntimeForkInput = {
  /** Fork after this message. When omitted, the latest complete API-round boundary is used. */
  messageID?: string
  signal?: AbortSignal
  /** Optional cumulative billable-token ceiling for the new conversation. */
  tokenBudget?: number
}

export interface RuntimeConversation {
  readonly id: string
  events(signal?: AbortSignal): Promise<AsyncIterable<RuntimeEvent>>
  prompt(input: RuntimePrompt): Promise<RuntimePromptResult>
  abort(): Promise<void>
  /** Ordered messages in the context the next prompt would see, including any compaction summary. */
  activeContext?(): Promise<RuntimeMessage[]>
  /** Complete ordered durable transcript; unlike activeContext(), this is not reduced by compaction. */
  messages?(): Promise<RuntimeMessage[]>
  /** Fork only at a complete API-round boundary, optionally selected by stable message ID. */
  fork?(input?: RuntimeForkInput): Promise<RuntimeConversation>
  /** Releases adapter resources without deleting the durable session. Idempotent when implemented. */
  close?(): Promise<void>
}

export interface AgentRuntime {
  createConversation(input: {
    directory: string
    title: string
    signal?: AbortSignal
    /** Optional cumulative billable-token ceiling shared by the conversation's task tree. */
    tokenBudget?: number
  }): Promise<RuntimeConversation>
  /** Resume a durable conversation when the backend supports it. */
  resumeConversation?(input: {
    directory: string
    id: string
    signal?: AbortSignal
    tokenBudget?: number
  }): Promise<RuntimeConversation>
}

export type RuntimeModelPricing = {
  /** USD per one million tokens for the matching normalized bucket. */
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

export type RuntimeProviderModel = {
  id: string
  name: string
  limit: { context: number; output: number }
  reasoning: boolean
  attachment: boolean
  pricing?: RuntimeModelPricing
}

export type RuntimeProvider = {
  id: string
  name: string
  models: Record<string, RuntimeProviderModel>
  packageName?: string
  api?: string
  /** Non-secret HTTP endpoint used for model discovery when exposed by the backend. */
  baseURL?: string
  /** Boom protocol Driver ID when the backend exposes one. */
  driver?: string
}

export type RuntimeProviderDiscoveryInput = {
  providerID: string
  baseURL?: string
  driver?: "openai-compatible" | "openai" | "anthropic"
  /** Transient override used only for this discovery request. */
  apiKey?: string
}

export type RuntimeProviderCatalog = {
  connected: string[]
  all: RuntimeProvider[]
}

export type RuntimeAuthMethod = {
  type: "api" | "oauth"
  label: string
}

export type RuntimeOAuthAuthorization = {
  url: string
  [key: string]: unknown
}

export type RuntimeMcpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

export type RuntimeCapabilities = {
  eventStreaming: boolean
  toolCalls: boolean
  reasoning: boolean
  attachments: boolean
  web: boolean
  cancellation: boolean
  providerManagement: boolean
  providerOAuth: boolean
  compaction: boolean
  /** Runtime exposes Boom's managed MCP control surface. */
  mcp?: boolean
  /** @deprecated Use `compaction`; retained while V2 callers migrate. */
  compactionHooks?: boolean
}

export interface ProviderRuntime {
  listProviders(): Promise<RuntimeProviderCatalog>
  discoverModels(input: RuntimeProviderDiscoveryInput): Promise<RuntimeProviderModel[]>
  listProviderAuth(): Promise<Record<string, RuntimeAuthMethod[]>>
  setProviderCredential(providerID: string, key: string): Promise<void>
  authorizeProviderOAuth(providerID: string, method: number): Promise<RuntimeOAuthAuthorization>
  completeProviderOAuth(providerID: string, method: number, code?: string): Promise<void>
  removeProviderCredential(providerID: string): Promise<void>
}

export interface McpRuntime {
  status(): Promise<Record<string, RuntimeMcpStatus>>
  connect(serverID: string): Promise<void>
  disconnect(serverID: string): Promise<void>
  startAuth(serverID: string): Promise<{ authorizationUrl: string }>
  completeAuth(serverID: string, code: string): Promise<RuntimeMcpStatus>
  removeAuth(serverID: string): Promise<void>
}

export interface RuntimeHandle {
  readonly backend: string
  readonly version: string
  /** Hash of the Boom-neutral agent registry and its stable prompt/tool layers. */
  readonly promptVersion?: string
  readonly capabilities: RuntimeCapabilities
  readonly agent: AgentRuntime
  readonly provider?: ProviderRuntime
  readonly mcp?: McpRuntime
  close(): void | Promise<void>
}

export type RuntimeLauncher = () => Promise<RuntimeHandle>
