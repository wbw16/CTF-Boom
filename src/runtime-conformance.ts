import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeFailure,
  RuntimePromptResult,
  RuntimeResponsePart,
  RuntimeToolState,
  RuntimeUsage,
} from "./runtime-contract.ts"
import { realpath } from "node:fs/promises"

export type RuntimeConformanceCaseID = `C${
  | "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09"
  | "10" | "11" | "12" | "13" | "14" | "15" | "16" | "17" | "18" | "19" | "20" | "21"}`

export type RuntimeConformanceCase = {
  id: RuntimeConformanceCaseID
  title: string
  milestone: "M1" | "M2" | "M3" | "M4" | "M5" | "M6"
  capabilities: Array<keyof RuntimeCapabilities>
  acceptance: readonly string[]
}

export const RUNTIME_CONFORMANCE_CASES: readonly RuntimeConformanceCase[] = [
  {
    id: "C01",
    title: "tool-free role prompt isolation",
    milestone: "M1",
    capabilities: ["eventStreaming"],
    acceptance: ["role receives no tools", "text and finish are normalized"],
  },
  {
    id: "C02",
    title: "bounded read/list/glob/grep paths",
    milestone: "M1",
    capabilities: ["toolCalls"],
    acceptance: ["workspace reads succeed", "path escape is rejected"],
  },
  {
    id: "C03",
    title: "work-only edits and symlink escape rejection",
    milestone: "M1",
    capabilities: ["toolCalls"],
    acceptance: ["work writes succeed", "challenge writes and symlink escapes fail"],
  },
  {
    id: "C04",
    title: "controlled execution audit, truncation, and cancellation",
    milestone: "M1",
    capabilities: ["toolCalls", "cancellation"],
    acceptance: ["environment is constrained", "large output is bounded", "process tree is cancellable"],
  },
  {
    id: "C05",
    title: "atomic durable note operations",
    milestone: "M1",
    capabilities: ["toolCalls"],
    acceptance: ["note and ruled-out append", "checkpoint atomically replaces task memory"],
  },
  {
    id: "C06",
    title: "multi-tool and multi-step agent loop",
    milestone: "M1",
    capabilities: ["eventStreaming", "toolCalls"],
    acceptance: ["call IDs are unique", "each result matches one call", "tool results reach the next step"],
  },
  {
    id: "C07",
    title: "streamed text, reasoning, usage, cost, and finish",
    milestone: "M1",
    capabilities: ["eventStreaming"],
    acceptance: ["chunk boundaries normalize away", "step usage is counted once", "finish is unique"],
  },
  {
    id: "C08",
    title: "cancellation at every active phase",
    milestone: "M1",
    capabilities: ["cancellation"],
    acceptance: ["pre-prompt cancel works", "generation and tool cancel work", "abort is idempotent"],
  },
  {
    id: "C09",
    title: "failure, retry, length, empty, and malformed responses",
    milestone: "M1",
    capabilities: ["eventStreaming"],
    acceptance: ["transient failures are classified", "terminal failures stay explicit", "malformed tools never execute"],
  },
  {
    id: "C10",
    title: "attachments and rejection recovery",
    milestone: "M6",
    capabilities: ["attachments"],
    acceptance: ["supported media is delivered", "unsupported media fails explicitly"],
  },
  {
    id: "C11",
    title: "context threshold and compaction recovery",
    milestone: "M6",
    capabilities: ["compaction"],
    acceptance: ["compaction boundaries are visible", "failure rebuilds from durable state"],
  },
  {
    id: "C12",
    title: "run-owned conversation access, fork, and task continuation",
    milestone: "M4",
    capabilities: ["eventStreaming"],
    acceptance: [
      "prompts are sequential and Runtime restart rebuilds from Boom's durable run state",
      "full history and active context remain separately visible",
      "tool use/results retain call IDs and pairing",
      "fork only accepts complete API-round boundaries",
      "new turns reuse durable task state",
    ],
  },
  {
    id: "C13",
    title: "role permission and tool isolation",
    milestone: "M1",
    capabilities: ["toolCalls"],
    acceptance: ["each role sees only allowed tools", "denied tools cannot be invoked"],
  },
  {
    id: "C14",
    title: "network target authorization",
    milestone: "M3",
    capabilities: ["web"],
    acceptance: ["unknown public, private, and loopback CTF targets work by default", "DNS and redirects remain pinned, bounded, and audited"],
  },
  {
    id: "C15",
    title: "provider catalog and credentials",
    milestone: "M5",
    capabilities: ["providerManagement"],
    acceptance: [
      "catalog and model pricing are normalized",
      "registered protocol Drivers complete streamed tool round trips",
      "credential removal affects the real store and secrets never enter task state",
    ],
  },
  {
    id: "C16",
    title: "isolated concurrent worker tasks",
    milestone: "M6",
    capabilities: ["eventStreaming"],
    acceptance: ["events and files stay child-workspace-scoped", "partial failure does not cancel siblings"],
  },
  {
    id: "C17",
    title: "stable layered prompt composition",
    milestone: "M1",
    capabilities: ["eventStreaming"],
    acceptance: ["stable prefix is invariant", "environment, skill, and turn inputs remain separable"],
  },
  {
    id: "C18",
    title: "redaction, bounds, and backend provenance",
    milestone: "M4",
    capabilities: ["eventStreaming"],
    acceptance: ["secrets are redacted", "diagnostics are bounded", "backend provenance is durable"],
  },
  {
    id: "C19",
    title: "stable tool catalog and schema compatibility",
    milestone: "M2",
    capabilities: ["toolCalls"],
    acceptance: ["tool IDs and schemas are snapshot-stable", "compatibility agents derive tool profiles from Boom resources"],
  },
  {
    id: "C20",
    title: "Boom Tool Host, Policy, Shell, bridge, and network parity",
    milestone: "M3",
    capabilities: ["toolCalls", "cancellation", "web"],
    acceptance: [
      "Native and compatibility tools consume one Registry and Policy Engine",
      "task filesystem, full Shell, environment, process, and output boundaries hold",
      "network requests are bounded, audited, redirect-validated, and isolated from host credentials",
    ],
  },
  {
    id: "C21",
    title: "bounded recursive task tree",
    milestone: "M4",
    capabilities: ["eventStreaming", "toolCalls", "cancellation"],
    acceptance: [
      "subagents have isolated workspaces and ledgers",
      "depth, total concurrency, and cumulative budget are enforced",
      "results return to the matching parent call and parent cancellation reaches the full tree",
    ],
  },
] as const

export const M1_CONFORMANCE_CASES = RUNTIME_CONFORMANCE_CASES.filter((item) => item.milestone === "M1")
export const M2_CONFORMANCE_CASES = RUNTIME_CONFORMANCE_CASES.filter((item) =>
  ["C01", "C13", "C17", "C19"].includes(item.id)
)
export const M3_CONFORMANCE_CASES = RUNTIME_CONFORMANCE_CASES.filter((item) =>
  ["C02", "C03", "C04", "C05", "C13", "C14", "C18", "C19", "C20"].includes(item.id)
)
export const M4_CONFORMANCE_CASES = RUNTIME_CONFORMANCE_CASES.filter((item) =>
  [
    "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09",
    "C12", "C13", "C16", "C17", "C18", "C19", "C20", "C21",
  ].includes(item.id)
)
export const M5_CONFORMANCE_CASES = RUNTIME_CONFORMANCE_CASES.filter((item) =>
  ["C06", "C07", "C09", "C15", "C18"].includes(item.id)
)

type TraceFailure = Pick<RuntimeFailure, "name" | "message" | "category" | "statusCode" | "retryable">

export type NormalizedRuntimeTraceEntry =
  | { kind: "state"; conversation: string; state: string }
  | { kind: "text" | "reasoning"; conversation: string; text: string }
  | {
      kind: "tool"
      conversation: string
      call: string
      tool: string
      state: RuntimeToolState["status"]
      input?: Record<string, unknown>
      title?: string
      error?: string
    }
  | {
      kind: "usage"
      conversation: string
      usage: RuntimeUsage
      cost: number
      reason?: string
    }
  | { kind: "retry"; conversation: string; attempt: number; delayMs?: number; error: TraceFailure }
  | { kind: "compaction"; conversation: string; state: string; error?: TraceFailure }
  | { kind: "diagnostic"; conversation: string; level: string; error: TraceFailure }
  | {
      kind: "task"
      conversation: string
      task: string
      parent?: string
      state: string
      depth: number
      title: string
      directory?: string
      usage?: RuntimeUsage
      cost?: number
      error?: string
    }
  | { kind: "cancelled"; conversation: string; reason?: string }
  | { kind: "finish"; conversation: string; reason: string; error?: TraceFailure }
  | {
      kind: "result"
      parts: Array<Record<string, unknown>>
      usage?: RuntimeUsage
      cost: number
      finish?: string
      error?: TraceFailure
      request?: string
    }

type NormalizationState = {
  conversations: Map<string, string>
  calls: Map<string, string>
  tasks: Map<string, string>
  requests: Map<string, string>
  workspace?: string
}

function alias(map: Map<string, string>, value: string, prefix: string) {
  const found = map.get(value)
  if (found) return found
  const next = `${prefix}-${map.size + 1}`
  map.set(value, next)
  return next
}

function redact(value: string, workspace?: string) {
  const withoutWorkspace = workspace ? value.split(workspace).join("<workspace>") : value
  return withoutWorkspace
    .replace(
      /((?:authorization|api[-_ ]?key|token|secret|password)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"'\s,;}]+/gi,
      "$1[redacted]",
    )
    .slice(0, 2_000)
}

function stableValue(value: unknown, state: NormalizationState): unknown {
  if (typeof value === "string") return redact(value, state.workspace)
  if (Array.isArray(value)) return value.map((item) => stableValue(item, state))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item, state)]),
  )
}

function traceFailure(error: RuntimeFailure | undefined, state: NormalizationState) {
  if (!error) return undefined
  return {
    ...(error.name ? { name: redact(error.name, state.workspace) } : {}),
    message: redact(error.message, state.workspace),
    ...(error.category ? { category: error.category } : {}),
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
  } satisfies TraceFailure
}

function normalizedPart(part: RuntimeResponsePart, state: NormalizationState) {
  return {
    type: part.type,
    ...(part.text === undefined ? {} : { text: redact(part.text, state.workspace) }),
    ...(part.tool === undefined ? {} : { tool: part.tool }),
    ...(part.callID === undefined ? {} : { call: alias(state.calls, part.callID, "call") }),
    ...(part.state === undefined ? {} : { state: stableValue(part.state, state) }),
    ...(part.mime === undefined ? {} : { mime: part.mime }),
    ...(part.filename === undefined ? {} : { filename: redact(part.filename, state.workspace) }),
    ...(part.reference === undefined ? {} : { reference: redact(part.reference, state.workspace) }),
  }
}

/**
 * Convert runtime events and the final prompt result into a backend-neutral, snapshot-safe trace.
 * Adjacent text/reasoning deltas are coalesced because transport chunk boundaries are not semantic.
 */
export function normalizeRuntimeTrace(input: {
  events: RuntimeEvent[]
  result?: RuntimePromptResult
  workspace?: string
}): NormalizedRuntimeTraceEntry[] {
  const state: NormalizationState = {
    conversations: new Map(),
    calls: new Map(),
    tasks: new Map(),
    requests: new Map(),
    workspace: input.workspace,
  }
  const output: NormalizedRuntimeTraceEntry[] = []
  const conversation = (id: string) => alias(state.conversations, id, "conversation")
  const appendText = (kind: "text" | "reasoning", id: string, text: string) => {
    const normalized = redact(text, state.workspace)
    const previous = output.at(-1)
    if (previous?.kind === kind && previous.conversation === conversation(id)) previous.text += normalized
    else output.push({ kind, conversation: conversation(id), text: normalized })
  }

  for (const event of input.events) {
    if (event.type === "conversation-state") {
      const normalized = { kind: "state", conversation: conversation(event.sessionID), state: event.state } as const
      const previous = output.at(-1)
      if (
        previous?.kind !== "state" ||
        previous.conversation !== normalized.conversation ||
        previous.state !== normalized.state
      ) output.push(normalized)
      continue
    }
    if (event.type === "text-delta" || event.type === "reasoning-delta") {
      appendText(event.type === "text-delta" ? "text" : "reasoning", event.sessionID, event.delta)
      continue
    }
    if (event.type === "tool-state") {
      output.push({
        kind: "tool",
        conversation: conversation(event.sessionID),
        call: alias(state.calls, event.callID, "call"),
        tool: event.tool,
        state: event.state.status,
        ...(event.state.input ? { input: stableValue(event.state.input, state) as Record<string, unknown> } : {}),
        ...(event.state.title ? { title: redact(event.state.title, state.workspace) } : {}),
        ...(event.state.error ? { error: redact(event.state.error, state.workspace) } : {}),
      })
      continue
    }
    if (event.type === "step-finish") {
      output.push({
        kind: "usage",
        conversation: conversation(event.sessionID),
        usage: event.usage,
        cost: event.cost,
        ...(event.reason ? { reason: event.reason } : {}),
      })
      continue
    }
    if (event.type === "retry") {
      output.push({
        kind: "retry",
        conversation: conversation(event.sessionID),
        attempt: event.attempt,
        ...(event.delayMs === undefined ? {} : { delayMs: event.delayMs }),
        error: traceFailure(event.error, state)!,
      })
      continue
    }
    if (event.type === "compaction") {
      output.push({
        kind: "compaction",
        conversation: conversation(event.sessionID),
        state: event.state,
        ...(event.error ? { error: traceFailure(event.error, state) } : {}),
      })
      continue
    }
    if (event.type === "provider-diagnostic") {
      output.push({
        kind: "diagnostic",
        conversation: conversation(event.sessionID),
        level: event.level,
        error: traceFailure(event.error, state)!,
      })
      continue
    }
    if (event.type === "task-state") {
      output.push({
        kind: "task",
        conversation: conversation(event.sessionID),
        task: alias(state.tasks, event.taskID, "task"),
        ...(event.parentTaskID
          ? { parent: alias(state.tasks, event.parentTaskID, "task") }
          : {}),
        state: event.state,
        depth: event.depth,
        title: redact(event.title, state.workspace),
        ...(event.directory ? { directory: redact(event.directory, state.workspace) } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.cost === undefined ? {} : { cost: event.cost }),
        ...(event.error ? { error: redact(event.error, state.workspace) } : {}),
      })
      continue
    }
    if (event.type === "cancelled") {
      output.push({
        kind: "cancelled",
        conversation: conversation(event.sessionID),
        ...(event.reason ? { reason: redact(event.reason, state.workspace) } : {}),
      })
      continue
    }
    output.push({
      kind: "finish",
      conversation: conversation(event.sessionID),
      reason: event.reason,
      ...(event.error ? { error: traceFailure(event.error, state) } : {}),
    })
  }

  if (input.result) {
    output.push({
      kind: "result",
      parts: input.result.parts.map((part) => normalizedPart(part, state)),
      ...(input.result.usage ? { usage: input.result.usage } : {}),
      cost: input.result.cost,
      ...(input.result.finish ? { finish: input.result.finish } : {}),
      ...(input.result.error ? { error: traceFailure(input.result.error, state) } : {}),
      ...(input.result.requestID
        ? { request: alias(state.requests, input.result.requestID, "request") }
        : {}),
    })
  }
  return output
}

/** Subscribe before prompting and capture one complete prompt as a normalized conformance trace. */
export async function captureRuntimeTrace(input: {
  runtime: AgentRuntime
  directory: string
  title: string
  agent: string
  model: string
  prompt: string
  signal?: AbortSignal
}) {
  const conversation = await input.runtime.createConversation({
    directory: input.directory,
    title: input.title,
    signal: input.signal,
  })
  const subscription = new AbortController()
  const stream = await conversation.events(subscription.signal)
  const events: RuntimeEvent[] = []
  let terminal = false
  let resolveTerminal: (() => void) | undefined
  const terminalEvent = new Promise<void>((resolve) => { resolveTerminal = resolve })
  const watching = (async () => {
    try {
      for await (const event of stream) {
        events.push(event)
        if (
          event.type === "finish" ||
          event.type === "conversation-state" &&
            ["completed", "cancelled", "failed"].includes(event.state)
        ) {
          terminal = true
          resolveTerminal?.()
        }
      }
    } catch (error) {
      if (!subscription.signal.aborted) throw error
    }
  })()
  try {
    const result = await conversation.prompt({
      agent: input.agent,
      model: input.model,
      text: input.prompt,
      signal: input.signal,
    })
    if (!terminal) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        terminalEvent,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000) }),
      ])
      if (timer) clearTimeout(timer)
    }
    subscription.abort()
    await watching
    const workspace = await realpath(input.directory).catch(() => input.directory)
    return normalizeRuntimeTrace({ events, result, workspace })
  } finally {
    subscription.abort()
    await watching.catch(() => {})
    await conversation.close?.().catch(() => {})
  }
}
