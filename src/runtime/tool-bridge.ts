import type { CompiledBoomAgentRegistry } from "./agent.ts"
import { createBoomToolHost, type BoomToolName } from "../tool-runtime.ts"
import { createBoomNetworkBroker } from "./network-broker.ts"

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Expose the Boom Tool Host only to the private compatibility child.
 *
 * The random bearer token never enters a task process environment. The child adapter receives no
 * implementation code or policy authority; it only translates its tool context into this endpoint.
 */
export function startBoomToolBridge(registry: CompiledBoomAgentRegistry) {
  const token = crypto.randomUUID() + crypto.randomUUID()
  const profiles = new Map(registry.agents.map((agent) => [agent.resource.id, agent.resource.toolProfile]))
  const deniedOrigins = new Set<string>()
  const host = createBoomToolHost(registry.catalog, {
    networkBroker: createBoomNetworkBroker({ deniedOrigins }),
    network: registry.network,
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return Response.json({ error: "unauthorized" }, { status: 401 })
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/registry")
        return Response.json(registry.catalog)
      if (request.method !== "POST" || url.pathname !== "/execute")
        return Response.json({ error: "not found" }, { status: 404 })
      const declared = Number(request.headers.get("content-length") ?? 0)
      if (declared > 3 * 1024 * 1024)
        return Response.json({ error: "request too large" }, { status: 413 })
      try {
        const body = object(await request.json())
        const args = object(body?.arguments)
        const name = body?.name
        const directory = body?.directory
        const agent = body?.agent
        if (typeof name !== "string" || typeof directory !== "string" || typeof agent !== "string" || !args)
          throw new Error("Invalid Boom tool bridge request")
        const profileID = profiles.get(agent)
        if (!profileID) throw new Error(`Unknown Boom agent: ${agent}`)
        const result = await host.execute({
          name: name as BoomToolName,
          arguments: args,
          directory,
          profileID,
          ...(typeof body?.sessionID === "string" ? { sessionID: body.sessionID } : {}),
          signal: request.signal,
        })
        return Response.json({ result })
      } catch (error) {
        return Response.json({
          error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
        }, { status: 400 })
      }
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  deniedOrigins.add(origin)
  return {
    url: origin,
    token,
    denyOrigin(value: string) {
      deniedOrigins.add(new URL(value).origin)
    },
    close() {
      server.stop(true)
    },
  }
}
