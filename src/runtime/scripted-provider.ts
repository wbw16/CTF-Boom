import type { RuntimeFinishReason, RuntimeUsage } from "../runtime-contract.ts"
import {
  NativeProviderFailure,
  emptyRuntimeUsage,
  type NativeProviderDriver,
  type NativeProviderEvent,
  type NativeProviderRequest,
} from "./native-provider.ts"

export type NativeScriptedToolCall = {
  id: string
  name: string
  arguments: string | string[]
}

export type NativeScriptedTurn =
  | {
      type: "completion"
      text?: string | string[]
      reasoning?: string | string[]
      tools?: NativeScriptedToolCall[]
      finish?: RuntimeFinishReason
      usage?: RuntimeUsage
      cost?: number
      requestID?: string
      delayMs?: number
      waitForAbort?: boolean
      disconnectAfterEvents?: number
    }
  | {
      type: "error"
      message: string
      category?: "authentication" | "authorization" | "rate-limit" | "server" | "network" |
        "invalid-request" | "content-filter" | "context-overflow" | "unsupported" |
        "malformed-response" | "cancelled" | "unknown"
      statusCode?: number
      retryable?: boolean
      requestID?: string
    }

function chunks(value: string | string[] | undefined) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function abortError(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException("The operation was aborted", "AbortError")
}

function delay(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted()
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener("abort", aborted, { once: true })
  })
}

function requestSnapshot(request: NativeProviderRequest): Omit<NativeProviderRequest, "signal"> {
  return structuredClone({
    conversationID: request.conversationID,
    step: request.step,
    agent: request.agent,
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  })
}

/** Deterministic, in-process Provider Driver used by Native conformance without network or cost. */
export class ScriptedNativeProviderDriver implements NativeProviderDriver {
  readonly id = "scripted"
  readonly version = "1"
  readonly requests: Array<Omit<NativeProviderRequest, "signal">> = []
  readonly abortedRequests: number[] = []
  #turns: NativeScriptedTurn[]
  #active = 0
  #maxActive = 0

  constructor(turns: NativeScriptedTurn[] = []) {
    this.#turns = [...turns]
  }

  get remaining() {
    return this.#turns.length
  }

  get active() {
    return this.#active
  }

  get maxActive() {
    return this.#maxActive
  }

  enqueue(...turns: NativeScriptedTurn[]) {
    this.#turns.push(...turns)
  }

  async *stream(request: NativeProviderRequest): AsyncIterable<NativeProviderEvent> {
    const requestIndex = this.requests.length
    this.requests.push(requestSnapshot(request))
    const turn = this.#turns.shift()
    if (!turn) throw new NativeProviderFailure({
      message: "Native scripted Provider exhausted",
      category: "server",
      retryable: false,
    })
    if (turn.type === "error") throw new NativeProviderFailure({
      message: turn.message,
      category: turn.category ?? "unknown",
      ...(turn.statusCode === undefined ? {} : { statusCode: turn.statusCode }),
      retryable: turn.retryable ?? false,
      ...(turn.requestID ? { requestID: turn.requestID } : {}),
    })

    const onAbort = () => this.abortedRequests.push(requestIndex)
    request.signal.addEventListener("abort", onAbort, { once: true })
    this.#active += 1
    this.#maxActive = Math.max(this.#maxActive, this.#active)
    let emitted = 0
    const emit = async (event: NativeProviderEvent) => {
      await delay(turn.delayMs ?? 0, request.signal)
      request.signal.throwIfAborted()
      emitted += 1
      if (turn.disconnectAfterEvents === emitted) throw new NativeProviderFailure({
        message: "Native scripted Provider disconnected",
        category: "network",
        retryable: true,
      })
      return event
    }
    try {
      for (const delta of chunks(turn.reasoning))
        yield await emit({ type: "reasoning-delta", delta })
      for (const delta of chunks(turn.text))
        yield await emit({ type: "text-delta", delta })
      for (const [index, tool] of (turn.tools ?? []).entries()) {
        for (const [fragmentIndex, fragment] of chunks(tool.arguments).entries()) {
          yield await emit({
            type: "tool-call-delta",
            index,
            ...(fragmentIndex === 0 ? { id: tool.id, name: tool.name } : {}),
            arguments: fragment,
          })
        }
      }
      if (turn.waitForAbort) {
        if (!request.signal.aborted) {
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(abortError(request.signal)), { once: true })
          })
        }
        request.signal.throwIfAborted()
      }
      yield await emit({
        type: "usage",
        usage: turn.usage ?? emptyRuntimeUsage(),
        cost: turn.cost ?? 0,
        ...(turn.requestID ? { requestID: turn.requestID } : {}),
      })
      yield await emit({
        type: "finish",
        reason: turn.finish ?? (turn.tools?.length ? "tool-calls" : "stop"),
      })
    } finally {
      request.signal.removeEventListener("abort", onAbort)
      this.#active -= 1
    }
  }
}
