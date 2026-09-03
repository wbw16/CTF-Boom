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

/** Parse a Retry-After header value (delta-seconds or HTTP-date) into milliseconds. */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(600_000, Math.ceil(seconds * 1_000))
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, Math.min(600_000, date - Date.now()))
  return undefined
}

function statusFailure(status: number, message: string, requestID?: string, retryAfter?: number): RuntimeFailure {
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
    ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
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
  let completed = false
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
    completed = true
  } finally {
    // An error or early exit must not leave the connection draining until GC.
    if (!completed) await reader.cancel().catch(() => {})
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

/**
 * Marker for a Base URL that is already a complete endpoint rather than a prefix.
 *
 * Some gateways expose one fixed URL that accepts the chat-completions body directly and reject any
 * sub-path. A competition LLM gateway is the motivating case: POST to its root returns 200 while
 * `<root>/chat/completions` returns 404, so no prefix value can work. Appending `!` opts that URL out
 * of path joining; the marker is stripped before the request is made.
 */
export const EXACT_ENDPOINT_MARKER = "!"

export function isExactEndpoint(baseURL: string) {
  return baseURL.trimEnd().endsWith(EXACT_ENDPOINT_MARKER)
}

/** The URL to call, with the exact-endpoint marker removed. */
export function exactEndpointURL(baseURL: string) {
  const trimmed = baseURL.trimEnd()
  return trimmed.endsWith(EXACT_ENDPOINT_MARKER)
    ? trimmed.slice(0, -EXACT_ENDPOINT_MARKER.length)
    : trimmed
}

export function providerEndpoint(baseURL: string, endpoint: string) {
  // An exact endpoint is used verbatim: the caller's path would otherwise be appended to a URL that
  // only answers at its own address.
  if (isExactEndpoint(baseURL)) return safeBaseURL(exactEndpointURL(baseURL)).toString().replace(/\/+$/, "")
  const base = safeBaseURL(baseURL)
  return new URL(endpoint.replace(/^\/+/, ""), base).toString()
}

export async function providerFetch(input: ProviderHTTPClientOptions & {
  endpoint: string
  method?: "GET" | "POST"
  body?: unknown
  signal?: AbortSignal
  accept?: string
  /** Hard ceiling on time-to-response-headers only; streaming bodies are never cut by it. */
  connectTimeoutMs?: number
}) {
  const request = input.fetch ?? fetch
  // The connect timeout must not bound the whole exchange: LLM streams legitimately run for minutes.
  // Its timer is cleared as soon as headers arrive, leaving only the caller's signal downstream.
  const connectController = new AbortController()
  const connectTimeoutMs = Math.max(0, input.connectTimeoutMs ?? 30_000)
  const connectTimer = connectTimeoutMs > 0
    ? setTimeout(() => connectController.abort(new Error("connect timed out")), connectTimeoutMs)
    : undefined
  const combined = input.signal
    ? AbortSignal.any([input.signal, connectController.signal])
    : connectController.signal
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
      signal: combined,
    })
  } catch (error) {
    if (input.signal?.aborted) throw providerFailure({
      name: "AbortError",
      message: input.signal.reason instanceof Error ? input.signal.reason.message : "Provider request cancelled",
      category: "cancelled",
    })
    if (!input.signal?.aborted && connectController.signal.aborted) throw providerFailure({
      message: `Provider did not respond within ${Math.round(connectTimeoutMs / 1_000)}s`,
      category: "network",
      retryable: true,
    })
    throw providerFailure({
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      category: "network",
      retryable: true,
    })
  } finally {
    if (connectTimer !== undefined) clearTimeout(connectTimer)
  }
  if (!response.ok) {
    const body = await boundedResponseText(response, MAX_ERROR_BODY_BYTES, true).catch(() => "")
    const requestID = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined
    const retryAfter = retryAfterMs(response.headers.get("retry-after"))
    const headerSecrets = Object.entries(input.headers ?? {}).flatMap(([name, value]) =>
      /authorization|api[-_]?key|token|secret/i.test(name) ? [value] : [],
    )
    throw new NativeProviderFailure(statusFailure(
      response.status,
      redactKnownSecrets(body, [input.apiKey, ...headerSecrets]),
      requestID,
      retryAfter,
    ))
  }
  return response
}

/** Parse SSE framing without exposing transport chunk boundaries to a Provider Driver. */
export async function* serverSentEvents(
  response: Response,
  signal?: AbortSignal,
  /**
   * Reset on every received chunk. A gateway that accepts the connection and then goes silent must
   * not hold a provider slot forever; LLM streams legitimately pause between tokens, so this bounds
   * idleness rather than total duration.
   */
  idleTimeoutMs = 120_000,
): AsyncIterable<ServerSentEvent> {
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
  let parsedEvents = 0
  let stallReject: ((reason?: unknown) => void) | undefined
  const stalled = new Promise<never>((_, reject) => {
    stallReject = reject
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const armIdleTimer = () => {
    if (idleTimeoutMs <= 0) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      stallReject?.(providerFailure({
        message: `Provider stream went silent for over ${Math.round(idleTimeoutMs / 1_000)}s`,
        category: "network",
        retryable: true,
      }))
    }, idleTimeoutMs)
  }
  // Whether the stream reached its natural end. Anything else (consumer break/return, throw, stall)
  // must cancel the body so the underlying HTTP connection is not left draining until GC.
  let completed = false
  try {
    while (true) {
      signal?.throwIfAborted()
      armIdleTimer()
      const item = await Promise.race([reader.read(), stalled])
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
        if (data) {
          parsedEvents += 1
          yield { ...(event ? { event } : {}), data }
        }
      }
      if (Buffer.byteLength(buffer) > MAX_SSE_EVENT_BYTES)
        throw providerFailure({ message: "Provider SSE event exceeded Boom's limit", category: "malformed-response" })
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      // A half-delivered final event means the connection was cut mid-write. When this attempt has
      // already produced events, replaying the whole step would double-bill the prefix; only a
      // connection that died before its first event is worth retrying.
      throw providerFailure({
        message: "Provider SSE stream ended with an incomplete event",
        category: "network",
        retryable: parsedEvents === 0,
      })
    }
    completed = true
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
    if (timer !== undefined) clearTimeout(timer)
    if (!completed) await reader.cancel().catch(() => {})
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
