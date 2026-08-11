import type {
  RuntimeFailure,
  RuntimeFinishReason,
  RuntimeUsage,
} from "../runtime-contract.ts"

export type NativeProviderToolCall = {
  id: string
  name: string
  /** Provider-neutral JSON source. The Kernel validates it before any execution. */
  arguments: string
}

export type NativeProviderMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant"
      content: string
      reasoning?: string
      toolCalls?: NativeProviderToolCall[]
    }
  | {
      role: "tool"
      toolCallID: string
      name: string
      content: string
      isError: boolean
    }

export type NativeProviderTool = {
  name: string
  description: string
  parameters: Readonly<Record<string, unknown>>
}

export type NativeProviderRequest = {
  conversationID: string
  step: number
  agent: string
  model: string
  system: string
  messages: readonly NativeProviderMessage[]
  tools: readonly NativeProviderTool[]
  signal: AbortSignal
}

export type NativeProviderEvent =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | {
      type: "tool-call-delta"
      index: number
      id?: string
      name?: string
      arguments?: string
    }
  | { type: "usage"; usage: RuntimeUsage; cost: number; requestID?: string }
  | { type: "finish"; reason: RuntimeFinishReason }

export interface NativeProviderDriver {
  readonly id: string
  readonly version: string
  stream(request: NativeProviderRequest): AsyncIterable<NativeProviderEvent>
}

/** A classified Provider failure that survives the Driver/Kernel boundary without raw response data. */
export class NativeProviderFailure extends Error {
  constructor(readonly failure: RuntimeFailure) {
    super(failure.message)
    this.name = "NativeProviderFailure"
  }
}

export function emptyRuntimeUsage(): RuntimeUsage {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

export function addRuntimeUsage(target: RuntimeUsage, usage: RuntimeUsage) {
  target.input += usage.input
  target.output += usage.output
  target.reasoning += usage.reasoning
  target.cache.read += usage.cache.read
  target.cache.write += usage.cache.write
  return target
}

export function subtractRuntimeUsage(current: RuntimeUsage, previous: RuntimeUsage): RuntimeUsage {
  return {
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    reasoning: Math.max(0, current.reasoning - previous.reasoning),
    cache: {
      read: Math.max(0, current.cache.read - previous.cache.read),
      write: Math.max(0, current.cache.write - previous.cache.write),
    },
  }
}

export function billableRuntimeUsage(usage: RuntimeUsage) {
  return usage.input + usage.output + usage.reasoning + usage.cache.write + usage.cache.read * 0.1
}

export function cloneRuntimeUsage(usage: RuntimeUsage): RuntimeUsage {
  return {
    input: usage.input,
    output: usage.output,
    reasoning: usage.reasoning,
    cache: { read: usage.cache.read, write: usage.cache.write },
  }
}
