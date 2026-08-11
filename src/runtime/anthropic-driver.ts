import type { RuntimeFinishReason, RuntimeUsage } from "../runtime-contract.ts"
import type {
  NativeProviderDriver,
  NativeProviderEvent,
  NativeProviderMessage,
  NativeProviderRequest,
} from "./native-provider.ts"
import {
  anthropicProviderBaseURL,
  normalizedProviderUsage,
  parseProviderJSON,
  providerFailure,
  providerFetch,
  providerUsageCost,
  serverSentEvents,
  type ProviderHTTPClientOptions,
  type ProviderModelPricing,
} from "./provider-http.ts"

type AnthropicMessagesDriverOptions = ProviderHTTPClientOptions & {
  maxOutputTokens?: number
  pricing?: ProviderModelPricing
  anthropicVersion?: string
  credentialStyle?: "api-key" | "bearer"
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseArguments(value: string) {
  try {
    const parsed = JSON.parse(value)
    return object(parsed) ?? {}
  } catch {
    return {}
  }
}

function anthropicMessages(input: readonly NativeProviderMessage[]) {
  const output: Array<{ role: "user" | "assistant"; content: Array<Record<string, unknown>> }> = []
  const append = (role: "user" | "assistant", block: Record<string, unknown>) => {
    const previous = output.at(-1)
    if (previous?.role === role) previous.content.push(block)
    else output.push({ role, content: [block] })
  }
  for (const message of input) {
    if (message.role === "user") append("user", { type: "text", text: message.content })
    else if (message.role === "tool") append("user", {
      type: "tool_result",
      tool_use_id: message.toolCallID,
      content: message.content,
      ...(message.isError ? { is_error: true } : {}),
    })
    else {
      if (message.content) append("assistant", { type: "text", text: message.content })
      for (const call of message.toolCalls ?? []) append("assistant", {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseArguments(call.arguments),
      })
    }
  }
  return output
}

function finish(value: unknown): RuntimeFinishReason {
  if (value === "end_turn" || value === "stop_sequence") return "stop"
  if (value === "tool_use") return "tool-calls"
  if (value === "max_tokens" || value === "pause_turn") return "length"
  if (value === "refusal") return "content-filter"
  return "unknown"
}

function addUsage(current: RuntimeUsage, raw: Record<string, unknown> | undefined) {
  if (!raw) return current
  const cacheRead = Number(raw.cache_read_input_tokens ?? current.cache.read)
  const input = Number(raw.input_tokens ?? current.input)
  const next = normalizedProviderUsage({
    // Anthropic reports uncached input separately; the shared normalizer expects
    // an OpenAI-style total that includes cache reads.
    input: input + cacheRead,
    output: Number(raw.output_tokens ?? current.output + current.reasoning),
    cacheRead,
    cacheWrite: Number(raw.cache_creation_input_tokens ?? current.cache.write),
  })
  return {
    input: Math.max(current.input, next.input),
    output: Math.max(current.output, next.output),
    reasoning: Math.max(current.reasoning, next.reasoning),
    cache: {
      read: Math.max(current.cache.read, next.cache.read),
      write: Math.max(current.cache.write, next.cache.write),
    },
  }
}

/** Official Anthropic Messages SSE Driver with content-block and tool-input delta normalization. */
export class AnthropicMessagesProviderDriver implements NativeProviderDriver {
  readonly id = "anthropic"
  readonly version = "1"
  #options: AnthropicMessagesDriverOptions

  constructor(options: AnthropicMessagesDriverOptions) {
    this.#options = options
  }

  async *stream(request: NativeProviderRequest): AsyncIterable<NativeProviderEvent> {
    const response = await providerFetch({
      ...this.#options,
      baseURL: anthropicProviderBaseURL(this.#options.baseURL),
      apiKey: undefined,
      headers: {
        ...(this.#options.credentialStyle === "bearer"
          ? { Authorization: `Bearer ${this.#options.apiKey ?? ""}` }
          : { "x-api-key": this.#options.apiKey ?? "" }),
        "anthropic-version": this.#options.anthropicVersion ?? "2023-06-01",
        ...this.#options.headers,
      },
      endpoint: "messages",
      body: {
        model: request.model,
        max_tokens: Math.max(1, Math.floor(this.#options.maxOutputTokens ?? 16_384)),
        system: request.system,
        messages: anthropicMessages(request.messages),
        stream: true,
        ...(request.tools.length ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        } : {}),
      },
      signal: request.signal,
      accept: "text/event-stream",
    })
    let usage = normalizedProviderUsage({ input: 0, output: 0 })
    let stopReason: RuntimeFinishReason | undefined
    let requestID: string | undefined
    for await (const frame of serverSentEvents(response, request.signal)) {
      const event = parseProviderJSON(frame.data, "Anthropic Messages stream event")
      const type = typeof event.type === "string" ? event.type : frame.event
      if (type === "message_start") {
        const message = object(event.message)
        if (typeof message?.id === "string") requestID = message.id
        usage = addUsage(usage, object(message?.usage))
        continue
      }
      if (type === "content_block_start") {
        const block = object(event.content_block)
        if (block?.type === "tool_use" && typeof event.index === "number") {
          const initial = object(block.input)
          yield {
            type: "tool-call-delta",
            index: event.index,
            ...(typeof block.id === "string" ? { id: block.id } : {}),
            ...(typeof block.name === "string" ? { name: block.name } : {}),
            ...(initial && Object.keys(initial).length ? { arguments: JSON.stringify(initial) } : {}),
          }
        } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
          yield { type: "text-delta", delta: block.text }
        }
        continue
      }
      if (type === "content_block_delta") {
        const delta = object(event.delta)
        if (delta?.type === "text_delta" && typeof delta.text === "string")
          yield { type: "text-delta", delta: delta.text }
        else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string")
          yield { type: "reasoning-delta", delta: delta.thinking }
        else if (
          delta?.type === "input_json_delta" && typeof delta.partial_json === "string" &&
          typeof event.index === "number"
        ) yield { type: "tool-call-delta", index: event.index, arguments: delta.partial_json }
        continue
      }
      if (type === "message_delta") {
        const delta = object(event.delta)
        if (delta?.stop_reason !== undefined) stopReason = finish(delta.stop_reason)
        usage = addUsage(usage, object(event.usage))
        continue
      }
      if (type === "error") {
        const error = object(event.error)
        const errorType = typeof error?.type === "string" ? error.type : ""
        const category = errorType.includes("auth") ? "authentication"
          : errorType.includes("permission") ? "authorization"
            : errorType.includes("rate_limit") ? "rate-limit"
              : errorType.includes("invalid_request") ? "invalid-request"
                : "server"
        throw providerFailure({
          message: typeof error?.message === "string" ? error.message : "Anthropic stream failed",
          category,
          retryable: errorType.includes("overloaded") || errorType.includes("rate_limit") || errorType.includes("api_error"),
          requestID,
        })
      }
      if (type !== "message_stop") continue
      yield {
        type: "usage",
        usage,
        cost: providerUsageCost(usage, this.#options.pricing),
        ...(requestID ? { requestID } : {}),
      }
      yield { type: "finish", reason: stopReason ?? "unknown" }
    }
  }
}

export type { AnthropicMessagesDriverOptions }
