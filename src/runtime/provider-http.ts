import type { RuntimeFailure, RuntimeModelPricing, RuntimeUsage } from "../runtime-contract.ts"
import { NativeProviderFailure } from "./native-provider.ts"

const MAX_ERROR_BYTES = 2_000
const MAX_ERROR_BODY_BYTES = 8_192
const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024
const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024
const SECRET = /((?:authorization|api[-_ ]?key|token|secret|password)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"'\s,;}]+/gi

export type ProviderModelPricing = RuntimeModelPricing

export type ProviderHTTPClientOptions = {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
}

export type ServerSentEvent = {
  event?: string
  data: string
}

function boundedSecretText(value: string) {
  return value.replace(SECRET, "$1[redacted]").slice(0, MAX_ERROR_BYTES)
}

function redactKnownSecrets(value: string, values: Array<string | undefined>) {
  let output = value
  for (const secret of values) {
    if (secret) output = output.replaceAll(secret, "[redacted]")
  }
  return output
}

function statusFailure(status: number, message: string, requestID?: string): RuntimeFailure {
  const category = status === 401
    ? "authentication"
    : status === 403
      ? "authorization"
      : status === 429
        ? "rate-limit"
        : status >= 500
          ? "server"
          : "invalid-request"
  return {
    message: boundedSecretText(message || `Provider request failed with HTTP ${status}`),
    category,
    statusCode: status,
    retryable: status === 408 || status === 409 || status === 429 || status >= 500,
    ...(requestID ? { requestID } : {}),
  }
}

async function boundedResponseText(response: Response, maximumBytes: number, truncate: boolean) {
  if (!response.body) return ""
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body.cancel().catch(() => {})
    if (truncate) return `Provider response body exceeded ${maximumBytes} bytes`
    throw providerFailure({ message: `Provider JSON body exceeded ${maximumBytes} bytes`, category: "malformed-response" })
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let observed = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      observed += item.value.byteLength
      if (observed > maximumBytes) {
        await reader.cancel().catch(() => {})
        if (truncate) return `Provider response body exceeded ${maximumBytes} bytes`
        throw providerFailure({ message: `Provider JSON body exceeded ${maximumBytes} bytes`, category: "malformed-response" })
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

export function providerFailure(input: {
  message: string
  category?: RuntimeFailure["category"]
  statusCode?: number
  retryable?: boolean
  requestID?: string
  name?: string
}) {
  return new NativeProviderFailure({
    ...(input.name ? { name: input.name } : {}),
    message: boundedSecretText(input.message),
    category: input.category ?? "unknown",
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    retryable: input.retryable ?? false,
    ...(input.requestID ? { requestID: input.requestID } : {}),
  })
}

function safeBaseURL(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid Provider Base URL: ${value}`)
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Provider Base URL must be credential-free HTTP(S)")
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`
  return url
}

/** Anthropic SDK-style base URLs are prefixes; the protocol endpoints live under `/v1`. */
export function anthropicProviderBaseURL(value: string) {
  const url = safeBaseURL(value)
  const prefix = url.pathname.replace(/\/+$/, "")
  url.pathname = prefix.endsWith("/v1") ? `${prefix}/` : `${prefix}/v1/`
  return url.toString().replace(/\/+$/, "")
}

export function providerEndpoint(baseURL: string, endpoint: string) {
  const base = safeBaseURL(baseURL)
  return new URL(endpoint.replace(/^\/+/, ""), base).toString()
}

export async function providerFetch(input: ProviderHTTPClientOptions & {
  endpoint: string
  method?: "GET" | "POST"
  body?: unknown
  signal?: AbortSignal
  accept?: string
}) {
  const request = input.fetch ?? fetch
  let response: Response
  try {
    response = await request(providerEndpoint(input.baseURL, input.endpoint), {
      method: input.method ?? (input.body === undefined ? "GET" : "POST"),
      headers: {
        Accept: input.accept ?? "application/json",
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        ...input.headers,
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: input.signal,
    })
  } catch (error) {
    if (input.signal?.aborted) throw providerFailure({
      name: "AbortError",
      message: input.signal.reason instanceof Error ? input.signal.reason.message : "Provider request cancelled",
      category: "cancelled",
    })
    throw providerFailure({
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      category: "network",
      retryable: true,
    })
  }
  if (!response.ok) {
    const body = await boundedResponseText(response, MAX_ERROR_BODY_BYTES, true).catch(() => "")
    const requestID = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined
    const headerSecrets = Object.entries(input.headers ?? {}).flatMap(([name, value]) =>
      /authorization|api[-_]?key|token|secret/i.test(name) ? [value] : [],
    )
    throw new NativeProviderFailure(statusFailure(
      response.status,
      redactKnownSecrets(body, [input.apiKey, ...headerSecrets]),
      requestID,
    ))
  }
  return response
}

/** Parse SSE framing without exposing transport chunk boundaries to a Provider Driver. */
export async function* serverSentEvents(response: Response, signal?: AbortSignal): AsyncIterable<ServerSentEvent> {
  if (!response.body) throw providerFailure({
    message: "Provider returned no response stream",
    category: "malformed-response",
  })
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("text/event-stream")) throw providerFailure({
    message: `Provider returned non-SSE content type: ${contentType || "missing"}`,
    category: "malformed-response",
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      signal?.throwIfAborted()
      const item = await reader.read()
      if (item.done) break
      buffer += decoder.decode(item.value, { stream: true })
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (!boundary || boundary.index === undefined) break
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        if (Buffer.byteLength(block) > MAX_SSE_EVENT_BYTES)
          throw providerFailure({ message: "Provider SSE event exceeded Boom's limit", category: "malformed-response" })
        const lines = block.split(/\r?\n/)
        const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim()
        const data = lines.filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n")
        if (data) yield { ...(event ? { event } : {}), data }
      }
      if (Buffer.byteLength(buffer) > MAX_SSE_EVENT_BYTES)
        throw providerFailure({ message: "Provider SSE event exceeded Boom's limit", category: "malformed-response" })
    }
    buffer += decoder.decode()
    if (buffer.trim()) throw providerFailure({
      message: "Provider SSE stream ended with an incomplete event",
      category: "network",
      retryable: true,
    })
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    if (error instanceof NativeProviderFailure) throw error
    if (signal?.aborted) throw providerFailure({
      name: "AbortError",
      message: signal.reason instanceof Error ? signal.reason.message : "Provider stream cancelled",
      category: "cancelled",
    })
    throw providerFailure({
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      category: "network",
      retryable: true,
    })
  } finally {
    reader.releaseLock()
  }
}

export function parseProviderJSON(data: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(data)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object")
    return value as Record<string, unknown>
  } catch (error) {
    throw providerFailure({
      message: `${label} contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      category: "malformed-response",
    })
  }
}

export function normalizedProviderUsage(input: {
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}): RuntimeUsage {
  const finite = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
  const reasoning = finite(input.reasoning)
  const cacheRead = finite(input.cacheRead)
  return {
    input: Math.max(0, finite(input.input) - cacheRead),
    output: Math.max(0, finite(input.output) - reasoning),
    reasoning,
    cache: { read: cacheRead, write: finite(input.cacheWrite) },
  }
}

export function providerUsageCost(usage: RuntimeUsage, pricing?: ProviderModelPricing) {
  if (!pricing) return 0
  return (
    usage.input * pricing.input +
    usage.output * pricing.output +
    usage.reasoning * (pricing.reasoning ?? pricing.output) +
    usage.cache.read * (pricing.cacheRead ?? pricing.input) +
    usage.cache.write * (pricing.cacheWrite ?? pricing.input)
  ) / 1_000_000
}

export async function providerJSON(response: Response) {
  return parseProviderJSON(
    await boundedResponseText(response, MAX_JSON_BODY_BYTES, false),
    "Provider response",
  )
}
