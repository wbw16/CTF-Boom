import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { RuntimeMcpStatus } from "./runtime-contract.ts"

export const BOOM_MCP_AGENT_IDS = [
  "boom",
  "boom-worker",
  "boom-consultant",
] as const

export type BoomMcpAgentID = (typeof BOOM_MCP_AGENT_IDS)[number]

type ManagedMcpBase = {
  id: string
  name: string
  enabled: boolean
  timeout: number
  agents: BoomMcpAgentID[]
}

export type ManagedMcpLocalServer = ManagedMcpBase & {
  type: "local"
  command: string[]
  /** Target environment variable -> source host environment variable. */
  environment: Record<string, string>
}

export type ManagedMcpRemoteServer = ManagedMcpBase & {
  type: "remote"
  url: string
  /** Header values may reference host variables with OpenCode's `{env:NAME}` syntax. */
  headers: Record<string, string>
  oauth: false | {
    clientId?: string
    scope?: string
  }
}

export type ManagedMcpServer = ManagedMcpLocalServer | ManagedMcpRemoteServer

export type McpStore = {
  version: 1
  servers: Record<string, ManagedMcpServer>
}

export type OpenCodeMcpConfig = Record<
  string,
  | {
      type: "local"
      command: string[]
      environment?: Record<string, string>
      enabled: boolean
      timeout: number
    }
  | {
      type: "remote"
      url: string
      headers?: Record<string, string>
      oauth?: false | { clientId?: string; scope?: string }
      enabled: boolean
      timeout: number
    }
>

const MCP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const ENVIRONMENT_REFERENCE = /\{env:([^}]+)\}/g
const SENSITIVE_HEADER = /(?:authorization|proxy-authorization|api[-_]?key|token|secret|cookie)/i
const SENSITIVE_QUERY = /(?:auth|api[-_]?key|token|secret|password)/i
const agentIDs = new Set<string>(BOOM_MCP_AGENT_IDS)

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown, maximum: number) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maximum && !trimmed.includes("\0")
    ? trimmed
    : undefined
}

function timeout(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 120_000
    ? value
    : undefined
}

function agents(value: unknown): BoomMcpAgentID[] | undefined {
  if (value === undefined) return ["boom", "boom-worker"]
  if (!Array.isArray(value) || value.length === 0) return undefined
  const parsed = value.flatMap((item) => typeof item === "string" && agentIDs.has(item)
    ? [item as BoomMcpAgentID]
    : [])
  if (parsed.length !== value.length) return undefined
  return [...new Set(parsed)]
}

function validEnvironmentReferences(value: string) {
  const references = [...value.matchAll(ENVIRONMENT_REFERENCE)]
  ENVIRONMENT_REFERENCE.lastIndex = 0
  if (value.includes("{env:") && references.length === 0) return false
  const withoutReferences = value.replace(ENVIRONMENT_REFERENCE, "")
  ENVIRONMENT_REFERENCE.lastIndex = 0
  return !withoutReferences.includes("{env:") && references.every((match) => ENVIRONMENT_NAME.test(match[1] ?? ""))
}

function environmentMap(value: unknown) {
  const input = object(value) ?? {}
  const result: Record<string, string> = {}
  for (const [target, sourceValue] of Object.entries(input)) {
    const source = text(sourceValue, 200)
    if (!ENVIRONMENT_NAME.test(target) || !source || !ENVIRONMENT_NAME.test(source)) return undefined
    result[target] = source
  }
  return result
}

function headerMap(value: unknown) {
  const input = object(value) ?? {}
  const result: Record<string, string> = {}
  for (const [name, raw] of Object.entries(input)) {
    const value = text(raw, 4_096)
    if (!HEADER_NAME.test(name) || !value || !validEnvironmentReferences(value)) return undefined
    if (SENSITIVE_HEADER.test(name) && !value.includes("{env:")) return undefined
    result[name] = value
  }
  return result
}

function remoteURL(value: unknown) {
  const raw = text(value, 2_048)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      return undefined
    if ([...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function oauth(value: unknown): ManagedMcpRemoteServer["oauth"] | undefined {
  if (value === undefined || value === false) return false
  const input = object(value)
  if (!input || "clientSecret" in input) return undefined
  const clientId = input.clientId === undefined ? undefined : text(input.clientId, 500)
  const scope = input.scope === undefined ? undefined : text(input.scope, 1_000)
  if (input.clientId !== undefined && !clientId) return undefined
  if (input.scope !== undefined && !scope) return undefined
  return {
    ...(clientId ? { clientId } : {}),
    ...(scope ? { scope } : {}),
  }
}

function server(value: unknown, key?: string): ManagedMcpServer | undefined {
  const input = object(value)
  const id = text(input?.id, 64) ?? key
  const name = text(input?.name, 120) ?? id
  const requestTimeout = timeout(input?.timeout ?? 5_000)
  const allowedAgents = agents(input?.agents)
  if (!input || !id || !MCP_ID.test(id) || !name || !requestTimeout || !allowedAgents) return undefined
  const base: ManagedMcpBase = {
    id,
    name,
    enabled: input.enabled !== false,
    timeout: requestTimeout,
    agents: allowedAgents,
  }
  if (input.type === "local") {
    const rawCommand = Array.isArray(input.command) ? input.command : []
    const command = Array.isArray(input.command)
      ? rawCommand.flatMap((item) => text(item, 4_096) ?? [])
      : []
    const environment = environmentMap(input.environment)
    if (command.length === 0 || command.length > 64 || command.length !== rawCommand.length || !environment)
      return undefined
    return { ...base, type: "local", command, environment }
  }
  if (input.type === "remote") {
    const url = remoteURL(input.url)
    const headers = headerMap(input.headers)
    const auth = oauth(input.oauth)
    if (!url || !headers || auth === undefined) return undefined
    return { ...base, type: "remote", url, headers, oauth: auth }
  }
  return undefined
}

export function initialMcpStore(): McpStore {
  return { version: 1, servers: {} }
}

/** True only when a configured server is enabled, connected, and exposed to this Boom role. */
export function managedMcpAvailableToAgent(
  store: McpStore,
  statuses: Record<string, RuntimeMcpStatus>,
  serverID: string,
  agentID: BoomMcpAgentID,
) {
  const server = store.servers[serverID]
  return !!server?.enabled &&
    server.agents.includes(agentID) &&
    statuses[serverID]?.status === "connected"
}

export function parseMcpStore(value: unknown): McpStore | undefined {
  const input = object(value)
  if (!input || input.version !== 1) return undefined
  const result: Record<string, ManagedMcpServer> = {}
  for (const [id, value] of Object.entries(object(input.servers) ?? {})) {
    const parsed = server(value, id)
    if (parsed) result[parsed.id] = parsed
  }
  return { version: 1, servers: result }
}

export function normalizeManagedMcpServer(value: unknown) {
  const parsed = server(value)
  if (!parsed)
    throw new Error(
      "Invalid MCP server configuration: check ID, transport, timeout, credential references, and Boom agent scope",
    )
  return parsed
}

export function mcpStorePath() {
  const home = path.resolve(process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"))
  return path.join(home, "mcp.json")
}

export async function loadMcpStore() {
  const target = mcpStorePath()
  const info = await lstat(target).catch(() => undefined)
  if (!info) return initialMcpStore()
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`MCP configuration is not a real file: ${target}`)
  try {
    const parsed = parseMcpStore(JSON.parse(await readFile(target, "utf8")))
    if (!parsed) throw new Error("unsupported MCP store format")
    return parsed
  } catch (error) {
    throw new Error(
      `Failed to read MCP configuration at ${target}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function saveMcpStore(store: McpStore) {
  const normalized = parseMcpStore(store)
  if (!normalized || Object.keys(normalized.servers).length !== Object.keys(store.servers).length)
    throw new Error("Invalid MCP store")
  const target = mcpStorePath()
  await mkdir(path.dirname(target), { recursive: true })
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`MCP configuration is not a real file: ${target}`)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(normalized, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
  return normalized
}

export function compileOpenCodeMcpConfig(store: McpStore): OpenCodeMcpConfig {
  return Object.fromEntries(Object.values(store.servers).map((entry) => {
    if (entry.type === "local") {
      const environment = Object.fromEntries(
        Object.entries(entry.environment).map(([target, source]) => [target, `{env:${source}}`]),
      )
      return [entry.id, {
        type: "local" as const,
        command: [...entry.command],
        ...(Object.keys(environment).length ? { environment } : {}),
        enabled: entry.enabled,
        timeout: entry.timeout,
      }]
    }
    return [entry.id, {
      type: "remote" as const,
      url: entry.url,
      ...(Object.keys(entry.headers).length ? { headers: { ...entry.headers } } : {}),
      ...(entry.oauth === false ? { oauth: false as const } : { oauth: { ...entry.oauth } }),
      enabled: entry.enabled,
      timeout: entry.timeout,
    }]
  }))
}

/**
 * 把 Boom 托管的 `idalib` 本地服务器包进 IDA 结果薄代理。
 *
 * OpenCode 以 stdio 拉起该命令；代理在前面透传并归档超大的 IDA 工具结果。包装只作用于
 * 名字固定为 `idalib` 的本地服务器，其余服务器原样保留，因此用户自定义 MCP 不受影响。
 */
export function wrapLocalIdaProxy(
  config: OpenCodeMcpConfig,
  options: { bunExecutable: string; proxyScript: string },
): OpenCodeMcpConfig {
  const server = config["idalib"]
  if (!options.bunExecutable || !options.proxyScript || !server || server.type !== "local" || !server.enabled)
    return config
  return {
    ...config,
    idalib: {
      ...server,
      command: [options.bunExecutable, options.proxyScript, ...server.command],
    },
  }
}

export function openCodeMcpToolPattern(serverID: string) {
  return `${serverID.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`
}
