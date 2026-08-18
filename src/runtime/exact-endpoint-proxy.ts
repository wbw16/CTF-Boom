import { exactEndpointURL, isExactEndpoint } from "./provider-http.ts"

export type ExactEndpointProxy = {
  /** Origin consumed by OpenCode as the prefix of an OpenAI-compatible Base URL. */
  baseURL: string
  close(): void
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HOP_BY_HOP_HEADERS = [
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

function targetURL(value: string) {
  const target = new URL(value)
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username || target.password || target.search || target.hash
  ) throw new Error("完整 Provider 端点必须是无凭证、无查询参数的 HTTP(S) URL")
  return target.toString()
}

function forwardedRequestHeaders(source: Headers) {
  const headers = new Headers(source)
  for (const name of [...HOP_BY_HOP_HEADERS, "content-length"]) headers.delete(name)
  return headers
}

function forwardedResponseHeaders(source: Headers) {
  const headers = new Headers(source)
  // Fetch may transparently decode an upstream body. Avoid retaining headers that would describe
  // the pre-decoded representation when streaming that body back to OpenCode.
  for (const name of [...HOP_BY_HOP_HEADERS, "content-encoding", "content-length"]) headers.delete(name)
  return headers
}

/**
 * Adapt OpenCode's fixed OpenAI-compatible `/v1/chat/completions` request to providers whose
 * configured URL is itself the complete endpoint. The target URLs stay in this loopback server's
 * closure and never enter OpenCode's configuration or a task workspace.
 */
export function startExactEndpointProxy(endpoints: Readonly<Record<string, string>>): ExactEndpointProxy | undefined {
  const targets = new Map<string, string>()
  for (const [providerID, value] of Object.entries(endpoints)) {
    if (!PROVIDER_ID.test(providerID) || !isExactEndpoint(value))
      throw new Error(`完整 Provider 端点配置非法: ${providerID}`)
    targets.set(providerID, targetURL(exactEndpointURL(value)))
  }
  if (targets.size === 0) return undefined

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const match = /^\/providers\/([a-z0-9][a-z0-9._-]{0,63})\/v1\/chat\/completions$/.exec(url.pathname)
      const target = match ? targets.get(match[1]!) : undefined
      if (!target) return Response.json({ error: "not found" }, { status: 404 })
      if (request.method !== "POST")
        return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "POST" } })

      try {
        const upstream = await fetch(target, {
          method: "POST",
          headers: forwardedRequestHeaders(request.headers),
          body: request.body,
          signal: request.signal,
          redirect: "manual",
        })
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: forwardedResponseHeaders(upstream.headers),
        })
      } catch {
        // The complete endpoint can include a capability path. Never reflect it in a local error.
        return Response.json({ error: "provider gateway unavailable" }, { status: 502 })
      }
    },
  })

  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    close() {
      server.stop(true)
    },
  }
}
