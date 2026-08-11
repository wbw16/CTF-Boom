import {
  BOOM_MCP_AGENT_IDS,
  loadMcpStore,
  normalizeManagedMcpServer,
  saveMcpStore,
  type BoomMcpAgentID,
  type ManagedMcpServer,
} from "./mcp-config.ts"
import { startOpenCodeRuntime } from "./runtime.ts"

function usage(): never {
  process.stderr.write([
    "Usage: boom mcp <action> [options]",
    "",
    "Actions:",
    "  list                              list Boom-managed MCP servers and runtime status",
    "  add <id> --url <url> [options]    add or replace a remote MCP server",
    "  add <id> [options] -- <command>   add or replace a local MCP server",
    "  enable <id>                       enable a configured MCP server",
    "  disable <id>                      disable a configured MCP server",
    "  test <id>                         connect and report the Boom Runtime MCP status",
    "  remove <id>                       remove a configured MCP server",
    "",
    "Add options:",
    "  --name <label>          display name",
    "  --timeout <ms>          request timeout, 100..120000 (default: 5000)",
    "  --agent <boom-agent>    allow this Boom role; may be repeated",
    "  --disabled              save without connecting on runtime startup",
    "  --header <NAME=VALUE>   remote header; secrets must use {env:NAME}",
    "  --oauth                 enable remote OAuth auto-detection",
    "  --env <TARGET=SOURCE>   local environment mapping; may be repeated",
    "",
    `Agents: ${BOOM_MCP_AGENT_IDS.join(", ")}`,
    "",
  ].join("\n"))
  process.exit(1)
}

function entry(value: string, kind: string) {
  const index = value.indexOf("=")
  if (index < 1 || index === value.length - 1)
    throw new Error(`Invalid ${kind}: expected NAME=VALUE`)
  return [value.slice(0, index), value.slice(index + 1)] as const
}

function id(argv: string[]) {
  const value = argv[1]
  if (!value) usage()
  return value
}

async function add(argv: string[]) {
  const serverID = id(argv)
  const separator = argv.indexOf("--", 2)
  const optionArgs = separator === -1 ? argv.slice(2) : argv.slice(2, separator)
  const command = separator === -1 ? [] : argv.slice(separator + 1)
  let url: string | undefined
  let name = serverID
  let requestTimeout = 5_000
  let enabled = true
  let useOAuth = false
  const headers: Record<string, string> = {}
  const environment: Record<string, string> = {}
  const agents: BoomMcpAgentID[] = []
  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index]!
    const value = () => {
      const next = optionArgs[++index]
      if (!next) usage()
      return next
    }
    if (option === "--url") url = value()
    else if (option === "--name") name = value()
    else if (option === "--timeout") requestTimeout = Number(value())
    else if (option === "--disabled") enabled = false
    else if (option === "--oauth") useOAuth = true
    else if (option === "--header") {
      const [key, item] = entry(value(), "MCP header")
      headers[key] = item
    } else if (option === "--env") {
      const [target, source] = entry(value(), "MCP environment mapping")
      environment[target] = source
    } else if (option === "--agent") agents.push(value() as BoomMcpAgentID)
    else usage()
  }
  if (!!url === (command.length > 0))
    throw new Error("Provide either --url <url> or a local command after --")
  if (url && Object.keys(environment).length)
    throw new Error("--env is only valid for local MCP servers")
  if (command.length && (Object.keys(headers).length || useOAuth))
    throw new Error("--header and --oauth are only valid for remote MCP servers")
  const base = {
    id: serverID,
    name,
    enabled,
    timeout: requestTimeout,
    ...(agents.length ? { agents } : {}),
  }
  const server = normalizeManagedMcpServer(url
    ? { ...base, type: "remote", url, headers, oauth: useOAuth ? {} : false }
    : { ...base, type: "local", command, environment })
  const store = await loadMcpStore()
  store.servers[server.id] = server
  await saveMcpStore(store)
  process.stdout.write(`Saved MCP server ${server.id} (${server.type}, ${server.enabled ? "enabled" : "disabled"})\n`)
}

async function setEnabled(argv: string[], enabled: boolean) {
  const serverID = id(argv)
  if (argv.length !== 2) usage()
  const store = await loadMcpStore()
  const current = store.servers[serverID]
  if (!current) throw new Error(`No such MCP server: ${serverID}`)
  store.servers[serverID] = normalizeManagedMcpServer({ ...current, enabled })
  await saveMcpStore(store)
  process.stdout.write(`${enabled ? "Enabled" : "Disabled"} MCP server ${serverID}\n`)
}

async function list() {
  const store = await loadMcpStore()
  const servers = Object.values(store.servers).sort((a, b) => a.name.localeCompare(b.name))
  if (servers.length === 0) {
    process.stdout.write("No Boom-managed MCP servers configured.\n")
    return
  }
  const runtime = await startOpenCodeRuntime()
  try {
    if (!runtime.mcp) throw new Error("The active runtime does not support MCP")
    const statuses = await runtime.mcp.status()
    for (const server of servers) {
      const status = statuses[server.id]
      const detail = status?.status === "failed" || status?.status === "needs_client_registration"
        ? ` — ${status.error}`
        : ""
      process.stdout.write(
        `${server.id}\t${status?.status ?? "unknown"}\t${server.type}\t${server.name}${detail}\n`,
      )
    }
  } finally {
    runtime.close()
  }
}

async function test(argv: string[]) {
  const serverID = id(argv)
  if (argv.length !== 2) usage()
  const store = await loadMcpStore()
  const server = store.servers[serverID]
  if (!server) throw new Error(`No such MCP server: ${serverID}`)
  const runtime = await startOpenCodeRuntime()
  try {
    if (!runtime.mcp) throw new Error("The active runtime does not support MCP")
    await runtime.mcp.connect(serverID)
    const status = (await runtime.mcp.status())[serverID]
    if (!server.enabled) await runtime.mcp.disconnect(serverID)
    if (!status) throw new Error(`Runtime did not report MCP server ${serverID}`)
    if (status.status !== "connected")
      throw new Error(`MCP server ${serverID} is ${status.status}${"error" in status ? `: ${status.error}` : ""}`)
    process.stdout.write(`MCP server ${serverID} connected.\n`)
  } finally {
    runtime.close()
  }
}

async function remove(argv: string[]) {
  const serverID = id(argv)
  if (argv.length !== 2) usage()
  const store = await loadMcpStore()
  if (!store.servers[serverID]) throw new Error(`No such MCP server: ${serverID}`)
  delete store.servers[serverID]
  await saveMcpStore(store)
  process.stdout.write(`Removed MCP server ${serverID}.\n`)
}

export async function mcpCommand(argv: string[]) {
  const action = argv[0]
  if (!action || action === "help" || action === "--help" || action === "-h") usage()
  if (action === "list") {
    if (argv.length !== 1) usage()
    return list()
  }
  if (action === "add") return add(argv)
  if (action === "enable") return setEnabled(argv, true)
  if (action === "disable") return setEnabled(argv, false)
  if (action === "test") return test(argv)
  if (action === "remove") return remove(argv)
  usage()
}
