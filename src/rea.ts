/**
 * REA (Reverse Engineer Anything) integration.
 *
 * REA publishes a ~170-tool MCP server plus a matching agent skill. Boom treats it as a managed
 * local MCP server: the saved command points at the upstream REA process, and runtime compilation
 * wraps that command in `src/runtime/rea-bridge.ts` so OpenCode only sees `rea_tools` / `rea_call`
 * instead of two megabytes of tool schemas.
 *
 * The REA skill is materialized into the isolated runtime only while an enabled REA server exists,
 * so a removed or disabled server never leaves stale REA instructions behind.
 */
import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import type {
  BoomMcpAgentID,
  ManagedMcpLocalServer,
  ManagedMcpServer,
  OpenCodeMcpConfig,
} from "./mcp-config.ts"

export const REA_SERVER_ID = "rea"
export const REA_PACKAGE_NAME = "rea-agents"
export const REA_PACKAGE_VERSION = "6.4.0"
export const REA_SKILL_DIRECTORY = "reverse-engineer-anything"
export const REA_SOURCE_ENTRYPOINT = path.join("scripts", "rea.mjs")
export const REA_SOURCE_BUILD_OUTPUT = path.join("dist", "mcp", "main.js")

/** Solver and workers are the roles that reverse-engineer attachments; other roles opt in. */
export const REA_DEFAULT_AGENTS: readonly BoomMcpAgentID[] = [
  "boom",
  "boom-worker",
  "boom-worker-pro",
]

/** REA analyses routinely exceed the default five seconds and can use the maximum Boom allows. */
export const REA_DEFAULT_TIMEOUT = 120_000

export type ReaCommandOptions = {
  /** Built REA checkout; when set, run its Node entrypoint instead of downloading from npm. */
  sourceDirectory?: string
  nodeExecutable?: string
  platform?: NodeJS.Platform
}

export type ReaServerOptions = ReaCommandOptions & {
  agents?: readonly BoomMcpAgentID[]
  enabled?: boolean
  environment?: Record<string, string>
  name?: string
}

export type ReaSourceInspection = {
  directory: string
  entrypoint: string
  buildOutput: string
  built: boolean
  version?: string
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Build the command that starts REA's stdio MCP server. */
export function reaMcpCommand(options: ReaCommandOptions = {}): string[] {
  if (options.sourceDirectory) {
    const source = path.resolve(options.sourceDirectory)
    return [
      options.nodeExecutable ?? "node",
      path.join(source, REA_SOURCE_ENTRYPOINT),
      "mcp",
    ]
  }
  const command = [
    "npx",
    "-y",
    `${REA_PACKAGE_NAME}@${REA_PACKAGE_VERSION}`,
    "mcp",
  ]
  // Both npx and bunx may be .cmd shims on Windows, which stdio clients cannot spawn directly.
  return (options.platform ?? process.platform) === "win32"
    ? ["cmd.exe", "/d", "/c", ...command]
    : command
}

export function reaMcpServer(options: ReaServerOptions = {}): ManagedMcpLocalServer {
  return {
    id: REA_SERVER_ID,
    name: options.name ?? "REA — Reverse Engineer Anything",
    type: "local",
    enabled: options.enabled ?? true,
    timeout: REA_DEFAULT_TIMEOUT,
    agents: [...(options.agents ?? REA_DEFAULT_AGENTS)],
    command: reaMcpCommand(options),
    environment: { ...(options.environment ?? {}) },
  }
}

/** Recognize the managed preset as well as user-renamed registrations of the same upstream. */
export function commandLooksLikeRea(command: readonly string[]) {
  return command.some((part) =>
    /(?:^|[\\/])rea-agents(?:@|$)/.test(part) ||
    /(?:^|[\\/])rea\.mjs$/.test(part)
  )
}

export function isReaMcpServer(server: ManagedMcpServer) {
  return server.id === REA_SERVER_ID ||
    (server.type === "local" && commandLooksLikeRea(server.command))
}

/** Validate a REA source checkout and report whether its compiled MCP entrypoint exists. */
export async function inspectReaSource(directory: string): Promise<ReaSourceInspection> {
  const source = path.resolve(directory)
  const packagePath = path.join(source, "package.json")
  let metadata: Record<string, unknown>
  try {
    metadata = object(JSON.parse(await readFile(packagePath, "utf8"))) ?? {}
  } catch (error) {
    throw new Error(
      `Not a readable REA checkout: ${packagePath} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (metadata.name !== REA_PACKAGE_NAME)
    throw new Error(`${packagePath} is not the ${REA_PACKAGE_NAME} package`)
  const entrypoint = path.join(source, REA_SOURCE_ENTRYPOINT)
  const entrypointInfo = await lstat(entrypoint).catch(() => undefined)
  if (!entrypointInfo?.isFile())
    throw new Error(`REA checkout is missing its entrypoint: ${entrypoint}`)
  const buildOutput = path.join(source, REA_SOURCE_BUILD_OUTPUT)
  const buildInfo = await lstat(buildOutput).catch(() => undefined)
  return {
    directory: source,
    entrypoint,
    buildOutput,
    built: buildInfo?.isFile() === true,
    ...(text(metadata.version) ? { version: text(metadata.version)! } : {}),
  }
}

/**
 * Wrap every enabled local REA server in the Boom bridge. The bridge is added at compile time, so
 * persisted MCP configuration keeps pointing at the real REA command and stays portable.
 */
export function wrapLocalReaBridge(
  config: OpenCodeMcpConfig,
  options: { bunExecutable: string; bridgeScript: string },
): OpenCodeMcpConfig {
  if (!options.bunExecutable || !options.bridgeScript) return config
  let changed = false
  const next: OpenCodeMcpConfig = { ...config }
  for (const [id, server] of Object.entries(config)) {
    if (server.type !== "local" || !server.enabled) continue
    if (id !== REA_SERVER_ID && !commandLooksLikeRea(server.command)) continue
    if (server.command[0] === options.bunExecutable && server.command[1] === options.bridgeScript)
      continue
    next[id] = {
      ...server,
      command: [options.bunExecutable, options.bridgeScript, ...server.command],
    }
    changed = true
  }
  return changed ? next : config
}

/**
 * Install or remove the REA skill in the isolated runtime.
 *
 * Returns true when the skill was materialized. The caller runs this on every runtime rebuild, so
 * disabling or deleting the REA server removes its instructions instead of leaving stale tool
 * guidance in the solver's prompt.
 */
export async function installReaSkill(
  resourceRoot: string,
  runtimeRoot: string,
  servers: readonly ManagedMcpServer[],
): Promise<boolean> {
  const enabled = servers.some((server) =>
    server.enabled && server.agents.length > 0 && isReaMcpServer(server)
  )
  const source = path.join(resourceRoot, "runtime", "skills", REA_SKILL_DIRECTORY)
  const target = path.join(runtimeRoot, "skills", REA_SKILL_DIRECTORY)
  await rm(target, { recursive: true, force: true })
  if (!enabled) return false
  const sourceInfo = await lstat(source).catch(() => undefined)
  if (!sourceInfo?.isDirectory())
    throw new Error(`Boom installation is missing its REA skill resource: ${source}`)
  await mkdir(path.dirname(target), { recursive: true })
  await cp(source, target, { recursive: true })
  return true
}
