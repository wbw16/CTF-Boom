import { lookup } from "node:dns/promises"
import http from "node:http"
import https from "node:https"
import { isIP } from "node:net"
import { appendFile, lstat, mkdir, realpath } from "node:fs/promises"
import path from "node:path"

export type NetworkResponse = {
  url: string
  status: number
  headers: Record<string, string>
  body: Buffer
  redirects: number
  durationMs: number
}

export type NetworkTransportInput = {
  url: URL
  address: string
  family: 4 | 6
  method: "GET" | "POST"
  headers: Record<string, string>
  body?: string
  maximumBytes: number
  signal: AbortSignal
}

export type NetworkSearchRequest = {
  query: string
  numResults: number
  livecrawl: "fallback" | "preferred"
  type: "auto" | "fast" | "deep"
  contextMaxCharacters: number
  signal?: AbortSignal
}

export type BoomNetworkBroker = {
  fetch(input: {
    directory: string
    sessionID?: string
    url: string
    timeoutMs?: number
    maximumBytes?: number
    signal?: AbortSignal
  }): Promise<NetworkResponse>
  search(input: {
    directory: string
    sessionID?: string
    request: NetworkSearchRequest
  }): Promise<{ provider: string; output: string }>
}

type TransportResponse = {
  status: number
  headers: Record<string, string>
  body: Buffer
}

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_SESSION_BYTES = 50 * 1024 * 1024
const MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const USER_AGENT = "Boom/0.1 CTF Network Broker"

function ipv4Private(address: string): boolean {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19))
}

/** Reject host-local, private, metadata, documentation, multicast, and unspecified destinations. */
export function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return ipv4Private(address)
  if (family !== 6) return true
  const normalized = address.toLowerCase().split("%")[0]!
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (mapped) return ipv4Private(mapped)
  return normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
}

async function resolveAddresses(hostname: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const literal = isIP(hostname)
  const addresses = literal
    ? [{ address: hostname, family: literal as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true }) as Array<{ address: string; family: 4 | 6 }>
  if (addresses.length === 0) throw new Error(`Network broker could not resolve: ${hostname}`)
  return addresses
}

function headerRecord(headers: http.IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) => {
    if (typeof value === "string") return [[key.toLowerCase(), value]]
    if (Array.isArray(value)) return [[key.toLowerCase(), value.join(", ")]]
    return []
  }))
}

async function pinnedTransport(input: NetworkTransportInput): Promise<TransportResponse> {
  return await new Promise<TransportResponse>((resolve, reject) => {
    const client = input.url.protocol === "https:" ? https : http
    const request = client.request({
      protocol: input.url.protocol,
      hostname: input.url.hostname,
      port: input.url.port || undefined,
      path: `${input.url.pathname}${input.url.search}`,
      method: input.method,
      headers: input.headers,
      servername: input.url.protocol === "https:" ? input.url.hostname : undefined,
      lookup: ((_hostname: string, options: { all?: boolean } | number, callback: (...args: any[]) => void) => {
        if (typeof options === "object" && options.all)
          callback(null, [{ address: input.address, family: input.family }])
        else callback(null, input.address, input.family)
      }) as any,
      signal: input.signal,
    }, (response) => {
      const declared = Number(response.headers["content-length"] ?? 0)
      if (Number.isFinite(declared) && declared > input.maximumBytes) {
        response.destroy()
        reject(new Error(`Network response exceeds ${input.maximumBytes} bytes`))
        return
      }
      const chunks: Buffer[] = []
      let observed = 0
      response.on("data", (chunk: Buffer | Uint8Array) => {
        const bytes = Buffer.from(chunk)
        observed += bytes.byteLength
        if (observed > input.maximumBytes) {
          response.destroy(new Error(`Network response exceeds ${input.maximumBytes} bytes`))
          return
        }
        chunks.push(bytes)
      })
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: headerRecord(response.headers),
        body: Buffer.concat(chunks),
      }))
      response.on("error", reject)
    })
    request.on("error", reject)
    if (input.body !== undefined) request.write(input.body)
    request.end()
  })
}

function safeURL(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid network URL: ${value}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`Network URL must use http or https: ${value}`)
  if (url.username || url.password) throw new Error("Network URL must not contain credentials")
  return url
}

function auditURL(url: URL): string {
  const copy = new URL(url)
  for (const key of [...copy.searchParams.keys()]) {
    if (/key|token|secret|password|auth/i.test(key)) copy.searchParams.set(key, "[redacted]")
  }
  return copy.toString()
}

async function audit(directory: string, event: Record<string, unknown>): Promise<void> {
  const root = await realpath(path.resolve(directory))
  const work = path.join(root, "work")
  const workInfo = await lstat(work)
  if (!workInfo.isDirectory() || workInfo.isSymbolicLink()) throw new Error("Task work path is not a real directory")
  const boom = path.join(work, ".boom")
  await mkdir(boom, { recursive: true, mode: 0o700 })
  const info = await lstat(boom)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Task network audit path is not a real directory")
  await appendFile(
    path.join(boom, "network-events.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
}

function parseSearchResponse(body: string): string | undefined {
  const parse = (value: string) => {
    try {
      const input = JSON.parse(value) as { result?: { content?: Array<{ type?: string; text?: string }> } }
      return input.result?.content?.find((item) => item.type === "text" && item.text)?.text
    } catch {
      return undefined
    }
  }
  const direct = parse(body.trim())
  if (direct) return direct
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue
    const result = parse(line.slice(6))
    if (result) return result
  }
  return undefined
}

export function createBoomNetworkBroker(options: {
  concurrency?: number
  sessionByteLimit?: number
  resolver?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>
  transport?: (input: NetworkTransportInput) => Promise<TransportResponse>
  searchProvider?: (request: NetworkSearchRequest) => Promise<{ provider: string; output: string }>
  /** Optional enterprise/hosted profile. CTF tasks default to open destinations, including RFC1918. */
  privateNetwork?: "allow" | "deny"
  /** Exact Boom-owned HTTP control-plane origins that remain unavailable even in the open CTF profile. */
  deniedOrigins?: ReadonlySet<string>
} = {}): BoomNetworkBroker {
  const concurrency = Math.max(1, Math.min(16, Math.floor(options.concurrency ?? 4)))
  const sessionByteLimit = Math.max(MAX_RESPONSE_BYTES, options.sessionByteLimit ?? MAX_SESSION_BYTES)
  const resolver = options.resolver ?? resolveAddresses
  const transport = options.transport ?? pinnedTransport
  const usage = new Map<string, number>()
  let active = 0
  const waiters: Array<() => void> = []

  const slot = async <T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted()
    if (active >= concurrency) await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", cancelled)
        resolve()
      }
      const cancelled = () => {
        const index = waiters.indexOf(ready)
        if (index >= 0) waiters.splice(index, 1)
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
      }
      waiters.push(ready)
      signal?.addEventListener("abort", cancelled, { once: true })
    })
    active += 1
    try {
      return await operation()
    } finally {
      active -= 1
      waiters.shift()?.()
    }
  }

  const request = async (input: {
    directory: string
    sessionID?: string
    url: string
    method: "GET" | "POST"
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
    maximumBytes?: number
    signal?: AbortSignal
  }): Promise<NetworkResponse> => slot(input.signal, async () => {
    const started = Date.now()
    const timeoutMs = Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(input.timeoutMs ?? DEFAULT_TIMEOUT_MS)))
    const maximumBytes = Math.max(1_024, Math.min(MAX_RESPONSE_BYTES, Math.floor(input.maximumBytes ?? MAX_RESPONSE_BYTES)))
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    let current = safeURL(input.url)
    let redirects = 0
    try {
      while (true) {
        signal.throwIfAborted()
        if (options.deniedOrigins?.has(current.origin))
          throw new Error(`Network broker denied Boom control-plane origin: ${current.origin}`)
        const addresses = await resolver(current.hostname)
        if (addresses.length === 0) throw new Error(`Network broker could not resolve: ${current.hostname}`)
        if (options.privateNetwork === "deny" && addresses.some((item) => isPrivateNetworkAddress(item.address)))
          throw new Error(`Network broker denied non-public destination: ${current.hostname}`)
        const selected = addresses[0]!
        const response = await transport({
          url: current,
          address: selected.address,
          family: selected.family,
          method: input.method,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.1",
            "Accept-Encoding": "identity",
            ...(input.body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(input.body)) }),
            ...input.headers,
          },
          body: input.body,
          maximumBytes,
          signal,
        })
        if (response.body.byteLength > maximumBytes)
          throw new Error(`Network response exceeds ${maximumBytes} bytes`)
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
          if (redirects >= MAX_REDIRECTS) throw new Error(`Network redirect limit exceeded: ${MAX_REDIRECTS}`)
          current = safeURL(new URL(response.headers.location, current).toString())
          redirects += 1
          continue
        }
        if (response.status < 200 || response.status >= 300)
          throw new Error(`Network request failed with HTTP ${response.status}`)
        const scope = `${await realpath(input.directory)}\0${input.sessionID ?? "task"}`
        const consumed = (usage.get(scope) ?? 0) + response.body.byteLength
        if (consumed > sessionByteLimit) throw new Error(`Network session traffic exceeds ${sessionByteLimit} bytes`)
        usage.set(scope, consumed)
        const result = {
          url: current.toString(),
          status: response.status,
          headers: response.headers,
          body: response.body,
          redirects,
          durationMs: Date.now() - started,
        }
        await audit(input.directory, {
          type: "network.request",
          sessionID: input.sessionID,
          method: input.method,
          url: auditURL(current),
          status: response.status,
          bytes: response.body.byteLength,
          redirects,
          durationMs: result.durationMs,
        })
        return result
      }
    } catch (error) {
      await audit(input.directory, {
        type: "network.error",
        sessionID: input.sessionID,
        method: input.method,
        url: auditURL(current),
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      }).catch(() => {})
      throw error
    }
  })

  return {
    fetch(input) {
      return request({ ...input, method: "GET" })
    },
    async search(input) {
      if (options.searchProvider) return slot(input.request.signal, async () => {
        const started = Date.now()
        const result = await options.searchProvider!(input.request)
        const bytes = Buffer.byteLength(result.output)
        const maximum = Math.min(MAX_RESPONSE_BYTES, input.request.contextMaxCharacters * 4)
        if (bytes > maximum) throw new Error(`Search response exceeds ${maximum} bytes`)
        const scope = `${await realpath(input.directory)}\0${input.sessionID ?? "task"}`
        const consumed = (usage.get(scope) ?? 0) + bytes
        if (consumed > sessionByteLimit) throw new Error(`Network session traffic exceeds ${sessionByteLimit} bytes`)
        usage.set(scope, consumed)
        await audit(input.directory, {
          type: "network.search",
          sessionID: input.sessionID,
          provider: result.provider,
          queryBytes: Buffer.byteLength(input.request.query),
          bytes,
          durationMs: Date.now() - started,
        })
        return result
      })
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: input.request.query,
            type: input.request.type,
            numResults: input.request.numResults,
            livecrawl: input.request.livecrawl,
            contextMaxCharacters: input.request.contextMaxCharacters,
          },
        },
      })
      const response = await request({
        directory: input.directory,
        sessionID: input.sessionID,
        url: "https://mcp.exa.ai/mcp",
        method: "POST",
        headers: { Accept: "application/json, text/event-stream" },
        body,
        timeoutMs: 25_000,
        maximumBytes: Math.min(MAX_RESPONSE_BYTES, input.request.contextMaxCharacters * 4),
        signal: input.request.signal,
      })
      return {
        provider: "exa",
        output: parseSearchResponse(response.body.toString("utf8")) ?? "No search results found.",
      }
    },
  }
}
