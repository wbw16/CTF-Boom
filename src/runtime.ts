import { createOpencodeClient } from "@opencode-ai/sdk"
import { createOpencodeClient as createOpencodeClientV2 } from "@opencode-ai/sdk/v2"
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  compileOpenCodeMcpConfig,
  loadMcpStore,
  wrapLocalIdaProxy,
  type McpStore,
} from "./mcp-config.ts"
import {
  BOOM_CONTEXT_LIMIT,
  loadProviderStore,
  mergeRuntimeProviderConfig,
  type RuntimeProviderConfig,
} from "./provider-config.ts"
import type { ModelPolicy } from "./model-policy.ts"
import { installOpenCodeAgentResources } from "./runtime/agent.ts"
import { startBoomToolBridge } from "./runtime/tool-bridge.ts"
import { createNativeRuntime, type NativeRuntimeOptions } from "./runtime/native-runtime.ts"
import { anthropicProviderBaseURL } from "./runtime/provider-http.ts"
import {
  createManagedNativeRuntime,
  inspectManagedNativeProviders,
  type ManagedNativeRuntimeOptions,
} from "./runtime/managed-native-runtime.ts"
import type {
  AgentRuntime,
  RuntimeAuthMethod,
  RuntimeEvent,
  RuntimeFailure,
  RuntimeFailureCategory,
  RuntimeFinishReason,
  RuntimeHandle,
  RuntimeMessage,
  RuntimePromptResult,
  RuntimeProviderCatalog,
  RuntimeResponsePart,
  RuntimeMcpStatus,
  RuntimeToolState,
  RuntimeUsage,
} from "./runtime-contract.ts"
import { resolveRuntimeForkBoundary } from "./runtime-messages.ts"
import {
  boomOpenCodeAuthContent,
  captureRuntimeProviderCredential,
  removeProviderAPIKey,
  setProviderAPIKey,
} from "./runtime/credential-store.ts"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
const RESOURCE_ROOT = path.join(PACKAGE_ROOT, "resources")
const RUNTIME_FILES = [
  { source: "runtime/skills/ctf-workflow/SKILL.md", target: "skills/ctf-workflow/SKILL.md" },
  { source: "plugin/armor-prompt.ts", target: "plugin/armor-prompt.ts" },
  { source: "plugin/boom-bridge.ts", target: "plugin/boom-bridge.ts" },
]
const LEGACY_TOOL_PLUGINS = ["plugin/boom-exec.ts", "plugin/ctf-note.ts", "plugin/ctf-submit.ts"]

/** Translate Boom's public model aliases only at the runtime boundary. */
export function resolveRuntimeModel(model: string) {
  if (model.startsWith("free/")) return `opencode/${model.slice("free/".length)}`
  return model
}

/** Keep the compatibility provider name out of Boom's public model picker and persisted GUI state. */
export function publicRuntimeModel(providerID: string, modelID: string) {
  return `${providerID === "opencode" ? "free" : providerID}/${modelID}`
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function redactedSummary(value: string) {
  return redactedText(value, 2_000)
}

function redactedText(value: string, maximum: number) {
  return value
    .replace(
      /((?:authorization|api[-_ ]?key|token|secret|password)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"'\s,;}]+/gi,
      "$1[redacted]",
    )
    .slice(0, maximum)
}

function contextValue(value: unknown, maximum = 128_000) {
  if (value === undefined) return undefined
  if (typeof value === "string") return redactedText(value, maximum)
  try {
    return redactedText(JSON.stringify(value), maximum)
  } catch {
    return redactedText(String(value), maximum)
  }
}

function normalizeOpenCodeToolPart(value: unknown): RuntimeMessage["parts"][number] | undefined {
  const part = object(value)
  const state = object(part?.state)
  const tool = part?.name ?? part?.tool
  if (!part || part.type !== "tool" || typeof tool !== "string") return undefined
  const status = state?.status
  const normalizedState =
    status === "pending" || status === "running" || status === "completed" || status === "error"
      ? status
      : undefined
  const output = contextValue(
    state?.output ??
      state?.result ??
      (Array.isArray(state?.content) && state.content.length > 0 ? state.content : undefined) ??
      (Array.isArray(state?.outputPaths) && state.outputPaths.length > 0 ? state.outputPaths : undefined),
  )
  const toolInput = contextValue(state?.input, 32_000)
  const toolError = contextValue(state?.error, 16_000)
  return {
    type: "tool",
    tool,
    ...(typeof part.callID === "string" ? { callID: part.callID } : {}),
    ...(normalizedState ? { state: normalizedState } : {}),
    ...(toolInput ? { input: toolInput } : {}),
    ...(output ? { output } : {}),
    ...(toolError ? { error: toolError } : {}),
  }
}

function normalizeOpenCodeStoredPart(value: unknown): RuntimeMessage["parts"] {
  const part = object(value)
  if (!part || typeof part.type !== "string") return []
  if (part.type === "text" || part.type === "reasoning")
    return typeof part.text === "string"
      ? [{ type: part.type, text: redactedText(part.text, 128_000) }]
      : []
  const tool = normalizeOpenCodeToolPart(part)
  if (tool) return [tool]
  if (part.type === "file") {
    const reference = contextValue({
      ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
      ...(typeof part.mime === "string" ? { mime: part.mime } : {}),
    }, 32_000)
    return reference ? [{ type: "file", text: reference }] : []
  }
  if (part.type === "subtask") {
    const text = contextValue({
      ...(typeof part.description === "string" ? { description: part.description } : {}),
      ...(typeof part.prompt === "string" ? { prompt: part.prompt } : {}),
      ...(typeof part.agent === "string" ? { agent: part.agent } : {}),
    }, 32_000)
    return text ? [{ type: "subtask", text }] : []
  }
  return []
}

/** Convert one SDK session message without allowing SDK metadata, paths, headers, or credentials out. */
export function normalizeOpenCodeStoredMessage(value: unknown): RuntimeMessage | undefined {
  const input = object(value)
  const info = object(input?.info)
  if (
    !info || typeof info.id !== "string" ||
    (info.role !== "user" && info.role !== "assistant") || !Array.isArray(input?.parts)
  ) return undefined
  const createdAt = object(info.time)?.created
  const parts = input.parts.flatMap(normalizeOpenCodeStoredPart)
  if (info.role === "assistant" && info.error !== undefined) {
    const failure = runtimeFailure(info.error)
    parts.push({
      type: "error",
      error: redactedText([
        failure.name,
        failure.message,
        failure.statusCode === undefined ? undefined : `status=${failure.statusCode}`,
      ].filter(Boolean).join(": "), 16_000),
    })
  }
  return {
    id: info.id,
    role: info.role,
    ...(typeof createdAt === "number" ? { createdAt } : {}),
    parts,
  }
}

/** Convert the v2 active-context shape without allowing SDK-owned metadata past the adapter. */
export function normalizeOpenCodeContextMessage(value: unknown): RuntimeMessage | undefined {
  const input = object(value)
  const id = input?.id
  const type = input?.type
  if (!input || typeof id !== "string" || typeof type !== "string") return undefined
  const createdAt = object(input.time)?.created
  const timestamp = typeof createdAt === "number" ? { createdAt } : {}

  if (type === "compaction") {
    return {
      id,
      role: "compaction",
      ...timestamp,
      parts: [
        ...(typeof input.summary === "string"
          ? [{ type: "summary", text: redactedText(input.summary, 128_000) }]
          : []),
        ...(typeof input.recent === "string"
          ? [{ type: "recent", text: redactedText(input.recent, 128_000) }]
          : []),
      ],
    }
  }
  if (type === "user" || type === "system" || type === "synthetic") {
    return {
      id,
      role: type,
      ...timestamp,
      parts: typeof input.text === "string"
        ? [{ type: "text", text: redactedText(input.text, 128_000) }]
        : [],
    }
  }
  if (type === "shell") {
    return {
      id,
      role: "tool",
      ...timestamp,
      parts: [{
        type: "tool",
        tool: "shell",
        ...(typeof input.callID === "string" ? { callID: input.callID } : {}),
        state: "completed",
        ...(typeof input.command === "string" ? { input: redactedText(input.command, 32_000) } : {}),
        ...(typeof input.output === "string" ? { output: redactedText(input.output, 128_000) } : {}),
      }],
    }
  }
  if (type === "agent-switched" || type === "model-switched") {
    const switched = type === "agent-switched" ? input.agent : input.model
    const switchedText = contextValue(switched, 4_000)
    return {
      id,
      role: "system",
      ...timestamp,
      parts: [{ type, ...(switchedText ? { text: switchedText } : {}) }],
    }
  }
  if (type !== "assistant") return undefined

  const parts = Array.isArray(input.content)
    ? input.content.flatMap((item): RuntimeMessage["parts"] => {
        const part = object(item)
        if (!part || typeof part.type !== "string") return []
        if (part.type === "text" || part.type === "reasoning")
          return typeof part.text === "string"
            ? [{ type: part.type, text: redactedText(part.text, 128_000) }]
            : []
        const tool = normalizeOpenCodeToolPart(part)
        return tool ? [tool] : []
      })
    : []
  return { id, role: "assistant", ...timestamp, parts }
}

function failureCategory(input: Record<string, unknown> | undefined, statusCode?: number): RuntimeFailureCategory {
  const data = object(input?.data)
  const text = `${input?.name ?? ""} ${input?.message ?? ""} ${data?.message ?? ""}`.toLowerCase()
  if (/abort|cancel/.test(text)) return "cancelled"
  if (statusCode === 401 || /authenticat|invalid.?api.?key/.test(text)) return "authentication"
  if (statusCode === 403 || /forbidden|authoriz/.test(text)) return "authorization"
  if (statusCode === 429 || /rate.?limit|too many requests/.test(text)) return "rate-limit"
  if (statusCode !== undefined && statusCode >= 500) return "server"
  if (/context.{0,20}(limit|length|overflow|window)/.test(text)) return "context-overflow"
  if (/content.?filter|safety/.test(text)) return "content-filter"
  if (/unsupported|not supported/.test(text)) return "unsupported"
  if (statusCode !== undefined && statusCode >= 400) return "invalid-request"
  if (/network|socket|connect|econn|dns|tls|fetch failed/.test(text)) return "network"
  return "unknown"
}

function runtimeFailure(value: unknown): RuntimeFailure {
  const input = object(value)
  const data = object(input?.data)
  const message = data?.message ?? input?.message ?? input?.name
  const statusCode = typeof data?.statusCode === "number" ? data.statusCode : undefined
  return {
    ...(typeof input?.name === "string" ? { name: input.name } : {}),
    message:
      typeof message === "string"
        ? redactedSummary(message)
        : redactedSummary(JSON.stringify(value)?.slice(0, 2_000) ?? String(value)),
    category: failureCategory(input, statusCode),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(typeof data?.isRetryable === "boolean" ? { retryable: data.isRetryable } : {}),
    ...(typeof data?.responseBody === "string" ? { responseBody: redactedSummary(data.responseBody) } : {}),
    ...(typeof data?.requestID === "string" ? { requestID: data.requestID } : {}),
  }
}

export function normalizeRuntimeFinish(value: unknown): RuntimeFinishReason | undefined {
  if (typeof value !== "string" || value === "") return undefined
  if (value === "stop" || value === "end-turn" || value === "end_turn") return "stop"
  if (value === "length" || value === "max-tokens" || value === "max_tokens") return "length"
  if (value === "tool-calls" || value === "tool_calls" || value === "tool_use") return "tool-calls"
  if (value === "content-filter" || value === "content_filter") return "content-filter"
  if (value === "cancelled" || value === "canceled" || value === "abort") return "cancelled"
  if (value === "error") return "error"
  if (value === "empty") return "empty"
  return "unknown"
}

function runtimeUsage(value: unknown): RuntimeUsage | undefined {
  const input = object(value)
  const cache = object(input?.cache)
  if (!input || !cache) return undefined
  const numbers = [input.input, input.output, input.reasoning, cache.read, cache.write]
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) return undefined
  return {
    input: input.input as number,
    output: input.output as number,
    reasoning: input.reasoning as number,
    cache: { read: cache.read as number, write: cache.write as number },
  }
}

function toolState(value: unknown): RuntimeToolState | undefined {
  const input = object(value)
  if (!input || !["pending", "running", "completed", "error"].includes(String(input.status)))
    return undefined
  return {
    status: input.status as RuntimeToolState["status"],
    ...(object(input.input) ? { input: object(input.input) } : {}),
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(typeof input.error === "string" ? { error: input.error } : {}),
  }
}

function responsePart(value: unknown): RuntimeResponsePart | undefined {
  const input = object(value)
  if (!input || typeof input.type !== "string") return undefined
  const state = toolState(input.state)
  return {
    type: input.type,
    ...(typeof input.text === "string" ? { text: input.text } : {}),
    ...(typeof input.tool === "string" ? { tool: input.tool } : {}),
    ...(typeof input.callID === "string" ? { callID: input.callID } : {}),
    ...(state ? { state } : {}),
    ...(typeof input.mime === "string" ? { mime: input.mime } : {}),
    ...(typeof input.filename === "string" ? { filename: input.filename } : {}),
    ...(typeof input.url === "string" ? { reference: input.url } : {}),
  }
}

function promptResult(value: unknown): RuntimePromptResult {
  const input = object(value)
  const data = object(input?.data)
  const info = object(data?.info)
  const parts = Array.isArray(data?.parts)
    ? data.parts.flatMap((item) => responsePart(item) ?? [])
    : []
  const usage = runtimeUsage(info?.tokens)
  const error = input?.error ?? info?.error
  const finish = normalizeRuntimeFinish(info?.finish)
  return {
    parts,
    ...(usage ? { usage } : {}),
    cost: typeof info?.cost === "number" ? info.cost : 0,
    ...(finish ? { finish } : {}),
    ...(error === undefined ? {} : { error: runtimeFailure(error) }),
  }
}

type OpenCodeEventState = {
  accumulatedParts: Map<string, string>
  messageRoles: Map<string, string>
}

export function normalizeOpenCodeRuntimeEvent(
  value: unknown,
  context?: OpenCodeEventState,
): RuntimeEvent | undefined {
  const input = object(value)
  const properties = object(input?.properties)
  if (input?.type === "message.updated") {
    const info = object(properties?.info)
    if (context && typeof info?.id === "string" && typeof info?.role === "string")
      context.messageRoles.set(info.id, info.role)
    return undefined
  }
  if (input?.type === "session.status") {
    const status = object(properties?.status)
    if (typeof properties?.sessionID !== "string" || typeof status?.type !== "string") return undefined
    if (status.type === "retry") {
      const message = typeof status.message === "string" ? status.message : "Provider request is retrying"
      return {
        type: "retry",
        sessionID: properties.sessionID,
        attempt: typeof status.attempt === "number" ? status.attempt : 1,
        error: runtimeFailure({ message }),
      }
    }
    const state = status.type === "busy" ? "generating" : "completed"
    return { type: "conversation-state", sessionID: properties.sessionID, state }
  }
  if (input?.type === "session.idle" && typeof properties?.sessionID === "string")
    return { type: "conversation-state", sessionID: properties.sessionID, state: "completed" }
  if (input?.type === "session.compacted" && typeof properties?.sessionID === "string")
    return { type: "compaction", sessionID: properties.sessionID, state: "completed" }
  if (input?.type === "session.error") {
    const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : undefined
    if (!sessionID) return undefined
    return {
      type: "provider-diagnostic",
      sessionID,
      level: "error",
      error: runtimeFailure(properties?.error),
    }
  }
  if (input?.type !== "message.part.updated") return undefined
  const part = object(properties?.part)
  if (!part || typeof part.sessionID !== "string" || typeof part.type !== "string") return undefined
  if (part.type === "step-finish") {
    const usage = runtimeUsage(part.tokens)
    if (!usage) return undefined
    return {
      type: "step-finish",
      sessionID: part.sessionID,
      usage,
      cost: typeof part.cost === "number" ? part.cost : 0,
      ...(normalizeRuntimeFinish(part.reason) ? { reason: normalizeRuntimeFinish(part.reason) } : {}),
    }
  }
  if (part.type === "text" || part.type === "reasoning") {
    let delta = typeof properties?.delta === "string" ? properties.delta : undefined
    const role = typeof part.messageID === "string" ? context?.messageRoles.get(part.messageID) : undefined
    if (role !== undefined && role !== "assistant") return undefined
    if (context && typeof part.text === "string") {
      // Accumulate regardless of whether the message role was observed yet: `part.updated` can
      // precede `message.updated`, and the accumulated delta is the only one we can compute when the
      // provider sends whole-part updates. Text and reasoning parts only exist on assistant messages,
      // so an unknown role is treated as assistant; known non-assistant roles are filtered above.
      const key = typeof part.id === "string"
        ? part.id
        : `${part.sessionID}:${String(part.messageID ?? "unknown")}:${part.type}`
      const previous = context.accumulatedParts.get(key) ?? ""
      if (delta === undefined)
        delta = part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text
      context.accumulatedParts.set(key, part.text)
    }
    if (delta === undefined || delta === "") return undefined
    return {
      type: part.type === "text" ? "text-delta" : "reasoning-delta",
      sessionID: part.sessionID,
      delta,
    }
  }
  if (part.type === "retry" && typeof part.attempt === "number")
    return {
      type: "retry",
      sessionID: part.sessionID,
      attempt: part.attempt,
      error: runtimeFailure(part.error),
    }
  if (part.type === "compaction")
    return { type: "compaction", sessionID: part.sessionID, state: "started" }
  if (part.type !== "tool") return undefined
  const state = toolState(part.state)
  if (!state || typeof part.callID !== "string" || typeof part.tool !== "string") return undefined
  return {
    type: "tool-state",
    sessionID: part.sessionID,
    callID: part.callID,
    tool: part.tool,
    state,
  }
}

/** The OpenCode adapter is the only place where Boom's turn contract touches the SDK client. */
export function createOpenCodeAgentRuntime(baseUrl: string): AgentRuntime {
  const conversation = (directory: string, id: string): import("./runtime-contract.ts").RuntimeConversation => {
    const client = createOpencodeClient({ baseUrl, directory })
    const contextClient = createOpencodeClientV2({ baseUrl, directory })
    const readMessages = async () => {
      const result = await client.session.messages({ path: { id } })
      if (result.error || !result.data || !Array.isArray(result.data))
        throw new Error(`Failed to read runtime conversation messages: ${JSON.stringify(result.error)}`)
      return result.data
        .map((item, index) => ({ index, message: normalizeOpenCodeStoredMessage(item) }))
        .filter((item): item is { index: number; message: RuntimeMessage } => item.message !== undefined)
        .sort((left, right) => {
          const leftTime = left.message.createdAt
          const rightTime = right.message.createdAt
          return leftTime === undefined || rightTime === undefined || leftTime === rightTime
            ? left.index - right.index
            : leftTime - rightTime
        })
        .map((item) => item.message)
    }
    return {
      id,
      async events(signal) {
        const subscription = await client.event.subscribe({ signal })
        const stream = subscription.stream
        const eventState: OpenCodeEventState = {
          accumulatedParts: new Map(),
          messageRoles: new Map(),
        }
        return {
          async *[Symbol.asyncIterator]() {
            for await (const event of stream) {
              const normalized = normalizeOpenCodeRuntimeEvent(event, eventState)
              if (normalized?.sessionID === id) yield normalized
            }
          },
        }
      },
      async prompt(request) {
        const [providerID, ...modelParts] = resolveRuntimeModel(request.model).split("/")
        const modelID = modelParts.join("/")
        if (!providerID || !modelID)
          throw new Error(`Model must be "provider/model", got: ${request.model}`)
        const result = await client.session.prompt({
          path: { id },
          signal: request.signal,
          body: {
            agent: request.agent,
            model: { providerID, modelID },
            parts: [{ type: "text", text: request.text }],
          },
        })
        return promptResult(result)
      },
      async abort() {
        await client.session.abort({ path: { id } })
      },
      async activeContext() {
        const result = await contextClient.v2.session.context({ sessionID: id })
        if (result.error || !result.data || !Array.isArray(result.data.data))
          throw new Error(`Failed to read runtime active context: ${JSON.stringify(result.error)}`)
        const active = result.data.data.flatMap((item) => normalizeOpenCodeContextMessage(item) ?? [])
        // Some compatible OpenCode builds return an empty context projection until the first
        // compaction. In that state the next prompt still sees the complete transcript.
        return active.length > 0 ? active : readMessages()
      },
      messages: readMessages,
      async isBusy(signal) {
        // The status endpoint reports the whole server, keyed by session ID. `busy` means a step is
        // actively being processed; `retry` is a backoff wait between provider attempts. Both are
        // alive states that may legitimately emit no events while a reasoning model thinks.
        try {
          const result = await client.session.status({ query: { directory }, signal })
          if (result.error || !result.data || typeof result.data !== "object") return false
          const status = (result.data as Record<string, { type?: string } | undefined>)[id]?.type
          return status === "busy" || status === "retry"
        } catch {
          return false
        }
      },
      async fork(input = {}) {
        input.signal?.throwIfAborted()
        const messages = await readMessages()
        const messageID = resolveRuntimeForkBoundary(messages, input.messageID)
        const boundary = messages.findIndex((message) => message.id === messageID)
        // OpenCode's fork cursor is exclusive: it names the first message not copied. Translate
        // Boom's public "fork after message" boundary to that backend convention.
        const backendCursor = messages[boundary + 1]?.id
        const result = await client.session.fork({
          path: { id },
          body: backendCursor ? { messageID: backendCursor } : {},
          signal: input.signal,
        })
        if (result.error || !result.data)
          throw new Error(`Failed to fork runtime conversation ${id}: ${JSON.stringify(result.error)}`)
        return conversation(directory, result.data.id)
      },
    }
  }
  return {
    async createConversation(input) {
      const directory = await realpath(input.directory)
      const client = createOpencodeClient({ baseUrl, directory })
      const created = await client.session.create({ body: { title: input.title }, signal: input.signal })
      if (created.error || !created.data)
        throw new Error(`Failed to create runtime conversation: ${JSON.stringify(created.error)}`)
      const id = created.data.id
      return conversation(directory, id)
    },
    async resumeConversation(input) {
      const directory = await realpath(input.directory)
      const client = createOpencodeClient({ baseUrl, directory })
      const existing = await client.session.get({ path: { id: input.id }, signal: input.signal })
      if (existing.error || !existing.data)
        throw new Error(`Failed to resume runtime conversation ${input.id}: ${JSON.stringify(existing.error)}`)
      return conversation(directory, input.id)
    },
  }
}

function engineExecutable() {
  return path.join(
    path.dirname(Bun.resolveSync("opencode-ai/package.json", PACKAGE_ROOT)),
    "bin",
    "opencode.exe",
  )
}

function compatibilityEnvironment() {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("OPENCODE_") ||
      /(?:^|_)(?:API_?KEY|API_?TOKEN|AUTH_?TOKEN|ACCESS_?TOKEN|TOKEN|ACCESS_?KEY_?ID|SECRET(?:_ACCESS)?_KEY|PASSWORD|PAT|CREDENTIALS?)$/.test(name)
    ) delete environment[name]
  }
  environment.PATH = `${path.join(PACKAGE_ROOT, "node_modules", ".bin")}${path.delimiter}${environment.PATH ?? ""}`
  return environment
}

async function startOpenCodeCompatibility(runtime: {
  directory: string
  executable: string
  providerIDs: string[]
  agentRegistry: Awaited<ReturnType<typeof installOpenCodeAgentResources>>
}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "boom-runtime-"))
  const isolatedConfigHome = path.join(temporaryRoot, "config")
  const isolatedDataHome = path.join(temporaryRoot, "data")
  const isolatedCacheHome = path.join(temporaryRoot, "cache")
  const isolatedStateHome = path.join(temporaryRoot, "state")
  const isolatedRuntimeHome = path.join(temporaryRoot, "home")
  await Promise.all([
    isolatedConfigHome,
    isolatedDataHome,
    isolatedCacheHome,
    isolatedStateHome,
    isolatedRuntimeHome,
  ].map((directory) => mkdir(directory, { recursive: true })))
  const hostCacheHome = process.env.XDG_CACHE_HOME?.trim()
    ? path.resolve(process.env.XDG_CACHE_HOME)
    : path.join(os.homedir(), ".cache")
  const reusableModels = path.join(hostCacheHome, "opencode", "models.json")
  const reusableModelsInfo = await lstat(reusableModels).catch(() => undefined)
  const modelCatalog = reusableModelsInfo?.isFile() && !reusableModelsInfo.isSymbolicLink()
    ? reusableModels
    : undefined
  const bridge = startBoomToolBridge(runtime.agentRegistry)
  const child = Bun.spawn(
    [runtime.executable, "serve", "--hostname=127.0.0.1", "--port=0"],
    {
      env: {
        ...compatibilityEnvironment(),
        // The compatibility runtime receives its own complete XDG tree. Only the read-only model
        // catalog may be reused; credentials are copied into memory and every session is ephemeral.
        XDG_CONFIG_HOME: isolatedConfigHome,
        XDG_DATA_HOME: isolatedDataHome,
        XDG_CACHE_HOME: isolatedCacheHome,
        XDG_STATE_HOME: isolatedStateHome,
        OPENCODE_TEST_HOME: isolatedRuntimeHome,
        OPENCODE_DB: ":memory:",
        OPENCODE_AUTH_CONTENT: await boomOpenCodeAuthContent(runtime.providerIDs),
        OPENCODE_CONFIG: path.join(runtime.directory, "boom.json"),
        OPENCODE_CONFIG_DIR: runtime.directory,
        OPENCODE_CONFIG_CONTENT: "{}",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        ...(modelCatalog ? { OPENCODE_MODELS_PATH: modelCatalog } : {}),
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_SHARE: "1",
        OPENCODE_DISABLE_CHANNEL_DB: "1",
        BOOM_TOOL_BRIDGE_URL: bridge.url,
        BOOM_TOOL_BRIDGE_TOKEN: bridge.token,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  let diagnostics = ""
  let listenOutput = ""
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const listening = new Promise<string>((resolve, reject) => {
    const consume = async (stream: ReadableStream<Uint8Array>, inspect: boolean) => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const item = await reader.read()
        if (item.done) break
        const text = decoder.decode(item.value, { stream: true })
        diagnostics = `${diagnostics}${text}`.slice(-4_000)
        if (!inspect || settled) continue
        listenOutput = `${listenOutput}${text}`.slice(-4_000)
        const match = listenOutput.match(/opencode server listening.*?on\s+(https?:\/\/[^\s]+)/)
        if (!match?.[1]) continue
        settled = true
        resolve(match[1])
      }
    }
    void consume(child.stdout, true).catch((error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    void consume(child.stderr, false).catch(() => {})
    void child.exited.then((code) => {
      if (settled) return
      settled = true
      reject(new Error(`Boom compatibility runtime exited with code ${code}: ${redactedSummary(diagnostics.trim())}`))
    })
    timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`Timed out starting Boom compatibility runtime: ${redactedSummary(diagnostics.trim())}`))
    }, 10_000)
  })
  let url: string
  let closePromise: Promise<void> | undefined
  const close = () => closePromise ??= (async () => {
    child.kill()
    bridge.close()
    await child.exited.catch(() => undefined)
    await rm(temporaryRoot, { recursive: true, force: true })
  })()
  try {
    url = await listening
    bridge.denyOrigin(url)
  } catch (error) {
    await close()
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  return {
    client: createOpencodeClient({ baseUrl: url }),
    authFile: path.join(isolatedDataHome, "opencode", "auth.json"),
    server: {
      url,
      close,
    },
  }
}

/**
 * Write `boom.json` for the internal runtime, declaring Boom's extra model providers.
 *
 * API keys are never written here. Boom injects its private credential store into the child process
 * as memory-only authentication content; an unconfigured Provider remains visible to `doctor`.
 */
async function installProviders(directory: string, mcpStore: McpStore) {
  const source = Bun.file(path.join(RESOURCE_ROOT, "providers.json"))
  const packaged = (await source.exists())
    ? ((await source.json()) as RuntimeProviderConfig)
    : {}
  const config = mergeRuntimeProviderConfig(packaged, await loadProviderStore()) as {
    provider: Record<string, { options?: Record<string, unknown> }>
    [key: string]: unknown
  }
  config.compaction = {
    ...object(config.compaction),
    auto: true,
  }
  // The strong worker may delegate mechanical subtasks to the economy worker, so the runtime must
  // allow one level of nested subagent dispatch below the main solver.
  config.subagent_depth = 2
  const idaProxyScript = path.join(PACKAGE_ROOT, "src", "runtime", "ida-proxy.ts")
  const idaProxyAvailable = await lstat(idaProxyScript)
    .then((info) => info.isFile() && !info.isSymbolicLink())
    .catch(() => false)
  config.mcp = wrapLocalIdaProxy(compileOpenCodeMcpConfig(mcpStore), {
    bunExecutable: process.execPath,
    proxyScript: idaProxyAvailable ? idaProxyScript : "",
  })
  await Bun.write(path.join(directory, "boom.json"), JSON.stringify(config, undefined, 2) + "\n")
  return Object.keys(config.provider)
}

async function installRuntime(models?: ModelPolicy) {
  const directory = path.resolve(
    process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"),
    "runtime",
  )
  // These exact paths were generated by older Boom versions. Removing them prevents stale keys,
  // logs, and compatibility-branded directories from surviving the isolation migration.
  await Promise.all([
    rm(path.join(directory, "opencode.json"), { force: true }),
    rm(path.join(directory, "xdg-config"), { recursive: true, force: true }),
    rm(path.join(directory, "home"), { recursive: true, force: true }),
    rm(path.join(directory, "bin"), { recursive: true, force: true }),
  ])
  const mcpStore = await loadMcpStore()
  for (const file of RUNTIME_FILES) {
    const source = Bun.file(path.join(RESOURCE_ROOT, file.source))
    if (!(await source.exists())) throw new Error(`Boom installation is missing runtime resource: ${file.source}`)
    await mkdir(path.dirname(path.join(directory, file.target)), { recursive: true })
    await Bun.write(path.join(directory, file.target), source)
  }
  await Promise.all(LEGACY_TOOL_PLUGINS.map((target) => unlink(path.join(directory, target)).catch(() => {})))
  const agents = await installOpenCodeAgentResources(
    RESOURCE_ROOT,
    directory,
    Object.values(mcpStore.servers),
    models,
  )
  const providerIDs = await installProviders(directory, mcpStore)

  const executable = engineExecutable()
  if (!(await Bun.file(executable).exists()))
    throw new Error("Boom's bundled execution runtime is missing. Reinstall Boom.")

  if (process.platform !== "win32") await chmod(executable, 0o755)
  return {
    directory,
    executable,
    providerIDs,
    promptVersion: agents.promptVersion,
    agentRegistry: agents,
  }
}

export async function configureRuntime(models?: ModelPolicy) {
  return installRuntime(models)
}

export async function startOpenCodeRuntime(options?: { models?: ModelPolicy }) {
  const configured = await configureRuntime(options?.models)
  const started = await startOpenCodeCompatibility(configured)
  const runtimePackage = await Bun.file(
    path.join(path.dirname(Bun.resolveSync("opencode-ai/package.json", PACKAGE_ROOT)), "package.json"),
  ).json() as { version?: string }
  const listProviders = async (): Promise<RuntimeProviderCatalog> => {
    const response = await started.client.provider.list()
    if (response.error || !response.data)
      throw new Error(`Failed to list runtime providers: ${JSON.stringify(response.error)}`)
    return {
      connected: [...response.data.connected],
      all: response.data.all.map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, {
          id: model.id,
          name: model.name,
          limit: { context: BOOM_CONTEXT_LIMIT, output: model.limit.output },
          reasoning: model.reasoning,
          attachment: model.attachment,
        }])),
        ...(provider.npm ? { packageName: provider.npm } : {}),
        ...(provider.api ? { api: provider.api } : {}),
      })),
    }
  }
  const listProviderAuth = async (): Promise<Record<string, RuntimeAuthMethod[]>> => {
    const response = await started.client.provider.auth()
    if (response.error || !response.data)
      throw new Error(`Failed to list runtime authentication methods: ${JSON.stringify(response.error)}`)
    return Object.fromEntries(Object.entries(response.data).map(([providerID, methods]) => [
      providerID,
      methods.flatMap((method) =>
        method.type === "api" || method.type === "oauth"
          ? [{ type: method.type, label: method.label } satisfies RuntimeAuthMethod]
          : [],
      ),
    ]))
  }
  const listMcpStatus = async (): Promise<Record<string, RuntimeMcpStatus>> => {
    const response = await started.client.mcp.status()
    if (response.error || !response.data)
      throw new Error(`Failed to list MCP server status: ${JSON.stringify(response.error)}`)
    return response.data
  }
  const handle: RuntimeHandle = {
    backend: "opencode",
    version: runtimePackage.version ?? "unknown",
    promptVersion: configured.promptVersion,
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: true,
      attachments: true,
      web: true,
      cancellation: true,
      providerManagement: true,
      providerOAuth: true,
      compaction: true,
      compactionHooks: true,
      mcp: true,
    },
    agent: createOpenCodeAgentRuntime(started.server.url),
    close: () => started.server.close(),
    provider: {
      listProviders,
      async discoverModels(input) {
        const catalog = await listProviders()
        const provider = catalog.all.find((item) => item.id === input.providerID)
        if (!provider)
          throw new Error(`No such OpenCode Provider: ${input.providerID}`)
        const models = Object.values(provider.models)
        if (models.length === 0)
          throw new Error(`OpenCode Provider ${input.providerID} has no usable models`)
        return models
      },
      listProviderAuth,
      async setProviderCredential(providerID, key) {
        await setProviderAPIKey(providerID, key)
      },
      async authorizeProviderOAuth(providerID, method) {
        const response = await started.client.provider.oauth.authorize({
          path: { id: providerID },
          body: { method },
        })
        if (response.error || !response.data)
          throw new Error(`Failed to start provider OAuth: ${JSON.stringify(response.error)}`)
        return response.data
      },
      async completeProviderOAuth(providerID, method, code) {
        const response = await started.client.provider.oauth.callback({
          path: { id: providerID },
          body: { method, ...(code?.trim() ? { code: code.trim() } : {}) },
        })
        if (response.error || response.data !== true)
          throw new Error(`Failed to complete provider OAuth: ${JSON.stringify(response.error)}`)
        await captureRuntimeProviderCredential(started.authFile, providerID)
      },
      removeProviderCredential: removeRuntimeCredential,
    },
    mcp: {
      status: listMcpStatus,
      async connect(serverID) {
        const response = await started.client.mcp.connect({ path: { name: serverID } })
        if (response.error || response.data !== true)
          throw new Error(`Failed to connect MCP server ${serverID}: ${JSON.stringify(response.error)}`)
      },
      async disconnect(serverID) {
        const response = await started.client.mcp.disconnect({ path: { name: serverID } })
        if (response.error || response.data !== true)
          throw new Error(`Failed to disconnect MCP server ${serverID}: ${JSON.stringify(response.error)}`)
      },
      async startAuth(serverID) {
        const response = await started.client.mcp.auth.start({ path: { name: serverID } })
        if (response.error || !response.data)
          throw new Error(`Failed to start MCP authentication for ${serverID}: ${JSON.stringify(response.error)}`)
        return response.data
      },
      async completeAuth(serverID, code) {
        const response = await started.client.mcp.auth.callback({
          path: { name: serverID },
          body: { code },
        })
        if (response.error || !response.data)
          throw new Error(`Failed to complete MCP authentication for ${serverID}: ${JSON.stringify(response.error)}`)
        return response.data
      },
      async removeAuth(serverID) {
        const response = await started.client.mcp.auth.remove({ path: { name: serverID } })
        if (response.error || response.data?.success !== true)
          throw new Error(`Failed to remove MCP authentication for ${serverID}: ${JSON.stringify(response.error)}`)
      },
    },
  }
  return handle
}

export type RuntimeBackendSelection = "opencode" | "native"
export type RuntimeStartOptions = {
  /** Internal development selector. Product calls remain on OpenCode until Native clears migration gates. */
  backend?: RuntimeBackendSelection
  native?: NativeRuntimeOptions
  managedNative?: ManagedNativeRuntimeOptions
}

export function selectRuntimeBackend(value = process.env.BOOM_RUNTIME_BACKEND): RuntimeBackendSelection {
  if (value === undefined || value === "" || value === "opencode") return "opencode"
  if (value === "native") return "native"
  throw new Error(`Unknown Boom Runtime backend: ${value}`)
}

function anthropicCompatibility(): Pick<
  ManagedNativeRuntimeOptions,
  "providerOverrides" | "providerCredentials"
> {
  const rawBaseURL = process.env.ANTHROPIC_BASE_URL?.trim()
  let baseURL: string | undefined
  if (rawBaseURL) {
    try {
      baseURL = anthropicProviderBaseURL(rawBaseURL)
    } catch {
      throw new Error("Anthropic compatibility Base URL must be a credential-free HTTP(S) URL")
    }
  }

  const boomCredential = process.env.BOOM_ANTHROPIC_API_KEY?.trim()
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim()
  const compatibility = !boomCredential
    ? apiKey
      ? { key: apiKey, style: "api-key" as const }
      : authToken
        ? { key: authToken, style: "bearer" as const }
        : undefined
    : undefined
  if (compatibility && (compatibility.key.length > 16_384 || compatibility.key.includes("\0")))
    throw new Error("Anthropic compatibility credential is invalid")
  return {
    ...(baseURL ? { providerOverrides: { anthropic: { baseURL } } } : {}),
    ...(compatibility ? { providerCredentials: { anthropic: compatibility } } : {}),
  }
}

function managedNativeOptions(
  configured: ManagedNativeRuntimeOptions | undefined,
): ManagedNativeRuntimeOptions {
  const compatibility = anthropicCompatibility()
  return {
    ...compatibility,
    ...configured,
    providerOverrides: {
      ...compatibility.providerOverrides,
      ...configured?.providerOverrides,
      ...(compatibility.providerOverrides?.anthropic || configured?.providerOverrides?.anthropic
        ? {
            anthropic: {
              ...compatibility.providerOverrides?.anthropic,
              ...configured?.providerOverrides?.anthropic,
            },
          }
        : {}),
    },
    providerCredentials: {
      ...compatibility.providerCredentials,
      ...configured?.providerCredentials,
    },
  }
}

/** Native doctor view with compatibility inputs translated only at the runtime boundary. */
export async function inspectNativeProviders() {
  const options = managedNativeOptions(undefined)
  return inspectManagedNativeProviders(undefined, options)
}

/** Start the selected Boom Runtime while retaining OpenCode as the product default during migration. */
export async function startRuntime(options: RuntimeStartOptions = {}) {
  const backend = options.backend ?? selectRuntimeBackend()
  if (backend === "opencode") return startOpenCodeRuntime()
  if (options.native) return createNativeRuntime(options.native)
  return createManagedNativeRuntime(managedNativeOptions(options.managedNative))
}

export async function removeRuntimeCredential(providerID: string) {
  await removeProviderAPIKey(providerID)
}

export async function packageVersion() {
  return ((await Bun.file(path.join(PACKAGE_ROOT, "package.json")).json()) as { version: string }).version
}

export async function inspectRuntime() {
  const runtime = await configureRuntime()
  const version = await Bun.$`${runtime.executable} --version`.quiet().text()
  const started = await startOpenCodeCompatibility(runtime)
  try {
    const [agents, tools, skills, providers, mcp] = await Promise.all([
      started.client.app.agents(),
      started.client.tool.ids(),
      fetch(`${started.server.url}/skill`).then(
        (response) => response.json() as Promise<Array<{ name: string }>>,
      ),
      started.client.provider.list(),
      started.client.mcp.status(),
    ])
    if (
      agents.error ||
      !agents.data?.some((agent) => agent.name === "boom") ||
      !agents.data?.some((agent) => agent.name === "boom-worker") ||
      !agents.data?.some((agent) => agent.name === "boom-worker-pro") ||
      !agents.data?.some((agent) => agent.name === "boom-consultant")
    )
      throw new Error("Boom's solver, worker, and consultant agents were not registered by Boom's runtime.")
    if (
      tools.error ||
      !tools.data?.includes("ctf-note") ||
      !tools.data?.includes("ctf-submit") ||
      !tools.data?.includes("boom-exec")
    )
      throw new Error("Boom's controlled execution and persistence tools were not registered by Boom's runtime.")
    if (!skills.some((skill) => skill.name === "ctf-workflow"))
      throw new Error("The ctf-workflow skill was not registered by Boom's runtime.")
    if (providers.error || !providers.data)
      throw new Error(`Failed to list OpenCode Providers: ${JSON.stringify(providers.error)}`)
    if (mcp.error || !mcp.data)
      throw new Error(`Failed to list MCP servers: ${JSON.stringify(mcp.error)}`)
    const connected = new Set(providers.data.connected)
    return {
      directory: runtime.directory,
      version: version.trim(),
      promptVersion: runtime.promptVersion,
      providers: providers.data.all.map((provider) => ({
        id: provider.id,
        name: provider.name,
        connected: connected.has(provider.id),
        models: Object.keys(provider.models).length,
      })),
      mcp: mcp.data,
    }
  } finally {
    await started.server.close()
  }
}
