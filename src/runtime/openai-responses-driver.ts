import type { RuntimeFinishReason } from "../runtime-contract.ts"
import type {
  NativeProviderDriver,
  NativeProviderEvent,
  NativeProviderMessage,
  NativeProviderRequest,
} from "./native-provider.ts"
import {
  normalizedProviderUsage,
  parseProviderJSON,
  providerFailure,
  providerFetch,
  providerUsageCost,
  serverSentEvents,
  type ProviderHTTPClientOptions,
  type ProviderModelPricing,
} from "./provider-http.ts"

type OpenAIResponsesDriverOptions = ProviderHTTPClientOptions & {
  pricing?: ProviderModelPricing
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function inputItems(messages: readonly NativeProviderMessage[]) {
  const output: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === "user") output.push({ role: "user", content: message.content })
    else if (message.role === "tool") output.push({
      type: "function_call_output",
      call_id: message.toolCallID,
      output: message.content,
    })
    else {
      if (message.content) output.push({ role: "assistant", content: message.content })
      for (const call of message.toolCalls ?? []) output.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      })
    }
  }
  return output
}

function completedFinish(response: Record<string, unknown>): RuntimeFinishReason {
  if (Array.isArray(response.output) && response.output.some((item) => object(item)?.type === "function_call"))
    return "tool-calls"
  if (Array.isArray(response.output) && response.output.some((item) => {
    const output = object(item)
    return Array.isArray(output?.content) && output.content.some((content) => object(content)?.type === "refusal")
  })) return "content-filter"
  const incomplete = object(response.incomplete_details)
  if (response.status === "incomplete") {
    if (incomplete?.reason === "content_filter") return "content-filter"
    return "length"
  }
  return response.status === "completed" ? "stop" : "unknown"
}

function streamFailure(error: Record<string, unknown> | undefined) {
  const code = `${error?.code ?? ""} ${error?.type ?? ""}`.toLowerCase()
  if (/auth|api.?key/.test(code)) return { category: "authentication" as const, retryable: false }
  if (/rate.?limit/.test(code)) return { category: "rate-limit" as const, retryable: true }
  if (/content.?filter|safety/.test(code)) return { category: "content-filter" as const, retryable: false }
  if (/server|overload|temporar/.test(code)) return { category: "server" as const, retryable: true }
  return { category: "invalid-request" as const, retryable: false }
}

/** Official OpenAI Responses API Driver. It uses item/call IDs, not Chat Completions message shapes. */
export class OpenAIResponsesProviderDriver implements NativeProviderDriver {
  readonly id = "openai"
  readonly version = "1"
  #options: OpenAIResponsesDriverOptions

  constructor(options: OpenAIResponsesDriverOptions) {
    this.#options = options
  }

  async *stream(request: NativeProviderRequest): AsyncIterable<NativeProviderEvent> {
    const response = await providerFetch({
      ...this.#options,
      endpoint: "responses",
      body: {
        model: request.model,
        instructions: request.system,
        input: inputItems(request.messages),
        stream: true,
        store: false,
        ...(request.tools.length ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false,
          })),
        } : {}),
      },
      signal: request.signal,
      accept: "text/event-stream",
    })
    for await (const frame of serverSentEvents(response, request.signal)) {
      if (frame.data === "[DONE]") continue
      const event = parseProviderJSON(frame.data, "OpenAI Responses stream event")
      const type = typeof event.type === "string" ? event.type : frame.event
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        yield { type: "text-delta", delta: event.delta }
        continue
      }
      if (
        (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") &&
        typeof event.delta === "string"
      ) {
        yield { type: "reasoning-delta", delta: event.delta }
        continue
      }
      if (type === "response.refusal.delta" && typeof event.delta === "string") {
        yield { type: "text-delta", delta: event.delta }
        continue
      }
      if (type === "response.output_item.added") {
        const item = object(event.item)
        if (item?.type === "function_call" && typeof event.output_index === "number") {
          yield {
            type: "tool-call-delta",
            index: event.output_index,
            ...(typeof item.call_id === "string" ? { id: item.call_id } : {}),
            ...(typeof item.name === "string" ? { name: item.name } : {}),
            ...(typeof item.arguments === "string" && item.arguments ? { arguments: item.arguments } : {}),
          }
        }
        continue
      }
      if (type === "response.function_call_arguments.delta" && typeof event.output_index === "number") {
        yield {
          type: "tool-call-delta",
          index: event.output_index,
          ...(typeof event.delta === "string" ? { arguments: event.delta } : {}),
        }
        continue
      }
      if (type === "response.failed" || type === "error") {
        const failed = object(event.response) ?? event
        const error = object(failed.error) ?? object(event.error)
        const classification = streamFailure(error)
        throw providerFailure({
          message: typeof error?.message === "string" ? error.message : "OpenAI response failed",
          ...classification,
          requestID: typeof failed.id === "string" ? failed.id : undefined,
        })
      }
      if (type !== "response.completed" && type !== "response.incomplete") continue
      const completed = object(event.response)
      if (!completed) throw providerFailure({
        message: "OpenAI completion event omitted its response",
        category: "malformed-response",
      })
      const rawUsage = object(completed.usage)
      const inputDetails = object(rawUsage?.input_tokens_details)
      const outputDetails = object(rawUsage?.output_tokens_details)
      const usage = normalizedProviderUsage({
        input: Number(rawUsage?.input_tokens ?? 0),
        output: Number(rawUsage?.output_tokens ?? 0),
        reasoning: Number(outputDetails?.reasoning_tokens ?? 0),
        cacheRead: Number(inputDetails?.cached_tokens ?? 0),
      })
      yield {
        type: "usage",
        usage,
        cost: providerUsageCost(usage, this.#options.pricing),
        ...(typeof completed.id === "string" ? { requestID: completed.id } : {}),
      }
      yield { type: "finish", reason: completedFinish(completed) }
    }
  }
}

export type { OpenAIResponsesDriverOptions }
