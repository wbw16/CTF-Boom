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
  providerFetch,
  providerUsageCost,
  serverSentEvents,
  type ProviderHTTPClientOptions,
  type ProviderModelPricing,
} from "./provider-http.ts"

type OpenAICompatibleDriverOptions = ProviderHTTPClientOptions & {
  pricing?: ProviderModelPricing
  streamUsage?: boolean
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function messages(input: readonly NativeProviderMessage[]) {
  return input.map((message) => {
    if (message.role === "user") return { role: "user", content: message.content }
    if (message.role === "tool") return {
      role: "tool",
      tool_call_id: message.toolCallID,
      content: message.content,
    }
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      } : {}),
    }
  })
}

function finish(value: unknown): RuntimeFinishReason {
  if (value === "stop") return "stop"
  if (value === "length") return "length"
  if (value === "tool_calls" || value === "function_call") return "tool-calls"
  if (value === "content_filter") return "content-filter"
  return "unknown"
}

/** OpenAI Chat Completions-compatible SSE Driver for explicitly configured third-party endpoints. */
export class OpenAICompatibleProviderDriver implements NativeProviderDriver {
  readonly id = "openai-compatible"
  readonly version = "1"
  #options: OpenAICompatibleDriverOptions

  constructor(options: OpenAICompatibleDriverOptions) {
    this.#options = options
  }

  async *stream(request: NativeProviderRequest): AsyncIterable<NativeProviderEvent> {
    const response = await providerFetch({
      ...this.#options,
      endpoint: "chat/completions",
      body: {
        model: request.model,
        stream: true,
        ...(this.#options.streamUsage === false ? {} : { stream_options: { include_usage: true } }),
        messages: [{ role: "system", content: request.system }, ...messages(request.messages)],
        ...(request.tools.length ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        } : {}),
      },
      signal: request.signal,
      accept: "text/event-stream",
    })
    let latestRequestID: string | undefined
    for await (const event of serverSentEvents(response, request.signal)) {
      if (event.data === "[DONE]") continue
      const chunk = parseProviderJSON(event.data, "OpenAI-compatible stream event")
      if (typeof chunk.id === "string") latestRequestID = chunk.id
      const usage = object(chunk.usage)
      if (usage) {
        const promptDetails = object(usage.prompt_tokens_details)
        const completionDetails = object(usage.completion_tokens_details)
        const normalized = normalizedProviderUsage({
          input: Number(usage.prompt_tokens ?? 0),
          output: Number(usage.completion_tokens ?? 0),
          reasoning: Number(completionDetails?.reasoning_tokens ?? 0),
          cacheRead: Number(promptDetails?.cached_tokens ?? 0),
        })
        yield {
          type: "usage",
          usage: normalized,
          cost: providerUsageCost(normalized, this.#options.pricing),
          ...(latestRequestID ? { requestID: latestRequestID } : {}),
        }
      }
      const choice = Array.isArray(chunk.choices) ? object(chunk.choices[0]) : undefined
      if (!choice) continue
      const delta = object(choice.delta)
      if (typeof delta?.content === "string" && delta.content)
        yield { type: "text-delta", delta: delta.content }
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (typeof reasoning === "string" && reasoning)
        yield { type: "reasoning-delta", delta: reasoning }
      if (Array.isArray(delta?.tool_calls)) {
        for (const raw of delta.tool_calls) {
          const call = object(raw)
          const fn = object(call?.function)
          if (!call || typeof call.index !== "number") continue
          yield {
            type: "tool-call-delta",
            index: call.index,
            ...(typeof call.id === "string" ? { id: call.id } : {}),
            ...(typeof fn?.name === "string" ? { name: fn.name } : {}),
            ...(typeof fn?.arguments === "string" ? { arguments: fn.arguments } : {}),
          }
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined)
        yield { type: "finish", reason: finish(choice.finish_reason) }
    }
  }
}

export type { OpenAICompatibleDriverOptions }
