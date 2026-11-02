#!/usr/bin/env bun
/**
 * Boom REA bridge.
 *
 * REA exposes ~170 MCP tools whose JSON schemas total close to 2 MB. Advertising all of them
 * would consume most of a model's context before the first task message, so Boom sits a small
 * stdio bridge between OpenCode and the upstream REA MCP server:
 *
 * 1. `tools/list` advertises exactly two local tools: `tools` and `call` (`rea_tools` /
 *    `rea_call` after OpenCode namespaces them with the server ID).
 * 2. `tools` lists REA tool names/descriptions or returns one tool's input schema on demand.
 * 3. `call` forwards one `tools/call` request to the upstream server and passes its result
 *    through unchanged, preserving MCP content blocks and error markers.
 *
 * Every other request needed for the MCP session (initialize, ping, cancellation) is handled
 * here. Diagnostics go to stderr; stdout is reserved for newline-delimited JSON-RPC.
 *
 * Invocation: `bun rea-bridge.ts <upstream-command> [args...]` (Bun consumes a leading `--`).
 */
import { spawn, type ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"

type RpcID = number | string

type Rpc = {
  jsonrpc?: "2.0"
  id?: RpcID
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type UpstreamTool = {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

type ToolResult = {
  content?: Array<Record<string, unknown>>
  structuredContent?: unknown
  isError?: boolean
  _meta?: unknown
}

type Pending = {
  resolve: (message: Rpc) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

const INITIALIZE_TIMEOUT_MS = 110_000
const LIST_TIMEOUT_MS = 30_000
const SHUTDOWN_GRACE_MS = 2_000
const DEFAULT_LISTED_TOOLS = 60
const MAX_LISTED_TOOLS = 200
const MAX_DESCRIPTION_CHARS = 240
const MAX_TOOL_PAGES = 100

const BRIDGE_INSTRUCTIONS = [
  "REA reverse-engineering tools are exposed through two bridge tools.",
  "Call rea_tools first: with no arguments to list tool names, with query to search, or with tool=<name> to fetch that tool's input schema.",
  "Then call rea_call with {tool, arguments} to invoke it. Do not call rea_tools or rea_call through rea_call.",
  "REA is managed by Boom; do not run `rea setup` or edit other client configuration.",
].join("\n")

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function parseMessage(line: string): Rpc | undefined {
  try {
    const value = JSON.parse(line) as Rpc
    return value && typeof value === "object" ? value : undefined
  } catch {
    return undefined
  }
}

function rpcError(message: Rpc["error"]) {
  if (!message) return "REA returned an unknown error"
  return message.data === undefined
    ? `${message.message} (code ${message.code})`
    : `${message.message} (code ${message.code}): ${JSON.stringify(message.data)}`
}

/** Read newline-delimited JSON from a child stream without assuming chunk boundaries. */
class LineReader {
  private buffer = ""
  private ended = false
  private readonly pending: string[] = []
  private readonly waiters: Array<(line: string | null) => void> = []

  constructor(stream: Readable) {
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      this.buffer += chunk
      let index = this.buffer.indexOf("\n")
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim()
        this.buffer = this.buffer.slice(index + 1)
        index = this.buffer.indexOf("\n")
        if (line) this.push(line)
      }
    })
    stream.on("end", () => this.finish())
    stream.on("error", () => this.finish())
  }

  private push(line: string) {
    const waiter = this.waiters.shift()
    if (waiter) waiter(line)
    else this.pending.push(line)
  }

  private finish() {
    if (this.ended) return
    this.ended = true
    const tail = this.buffer.trim()
    if (tail) this.push(tail)
    for (const waiter of this.waiters.splice(0)) waiter(null)
  }

  async next(): Promise<string | null> {
    if (this.pending.length > 0) return this.pending.shift()!
    if (this.ended) return null
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

const state = {
  upstream: undefined as ChildProcess | undefined,
  upstreamReady: false,
  initializing: undefined as Promise<void> | undefined,
  initializeParams: undefined as Record<string, unknown> | undefined,
  protocolVersion: "2024-11-05",
  nextID: 1,
  pending: new Map<string, Pending>(),
  tools: undefined as UpstreamTool[] | undefined,
  downstreamCalls: new Map<string, string>(),
  exiting: false,
}

function sendDown(message: Rpc) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendUp(message: Rpc) {
  const upstream = state.upstream
  if (!upstream?.stdin?.writable) throw new Error("REA upstream is not running")
  upstream.stdin.write(`${JSON.stringify(message)}\n`)
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] }
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

function clip(text: string, maximum: number) {
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`
}

function failPending(error: Error) {
  for (const pending of state.pending.values()) {
    if (pending.timer) clearTimeout(pending.timer)
    pending.reject(error)
  }
  state.pending.clear()
}

function handleUpstream(line: string) {
  const message = parseMessage(line)
  if (!message) return

  if (message.id !== undefined && message.method === undefined) {
    const key = String(message.id)
    const pending = state.pending.get(key)
    if (!pending) return
    state.pending.delete(key)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(message)
    return
  }

  if (message.id !== undefined && message.method !== undefined) {
    // REA does not need sampling or roots. Refuse rather than leaving the upstream waiting.
    try {
      sendUp({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method is not supported by the Boom REA bridge" },
      })
    } catch {
      // Upstream exited between reading and writing; its exit handler reports the failure.
    }
    return
  }

  if (message.method === "notifications/tools/list_changed") state.tools = undefined
}

function startUpstream() {
  if (state.upstream) return state.upstream
  const [executable, ...args] = process.argv.slice(2)
  if (!executable) throw new Error("usage: rea-bridge.ts <upstream-command> [args...]")
  const child = spawn(executable, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  })
  state.upstream = child
  state.upstreamReady = false
  state.tools = undefined

  const reader = new LineReader(child.stdout)
  void (async () => {
    while (true) {
      const line = await reader.next()
      if (line === null) break
      handleUpstream(line)
    }
  })().catch((error) => {
    process.stderr.write(`[rea-bridge] upstream reader failed: ${errorText(error)}\n`)
  })

  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString().trim()
    if (text) process.stderr.write(`[rea-bridge] ${text}\n`)
  })
  child.stdin.on("error", (error) => {
    process.stderr.write(`[rea-bridge] upstream stdin failed: ${errorText(error)}\n`)
  })
  child.on("error", (error) => {
    if (state.upstream === child) state.upstream = undefined
    state.upstreamReady = false
    state.tools = undefined
    failPending(new Error(
      `Failed to start the REA MCP server (${executable}). REA requires Node.js 22.19+, 24.11+ or 26+, ` +
        `and npx on PATH; alternatively register a built REA checkout. ${errorText(error)}`,
    ))
  })
  child.on("exit", (code, signal) => {
    if (state.upstream === child) state.upstream = undefined
    state.upstreamReady = false
    state.tools = undefined
    failPending(new Error(
      `REA MCP server exited before completing the request (${signal ?? `code ${code}`}).`,
    ))
  })
  return child
}

async function ensureUpstreamInitialized() {
  if (state.upstreamReady) return
  if (!state.initializeParams)
    throw new Error("The REA bridge was not initialized by the MCP client")
  if (state.initializing) return state.initializing

  state.initializing = (async () => {
    startUpstream()
    const { response } = beginUpstreamRequest("initialize", state.initializeParams!, INITIALIZE_TIMEOUT_MS)
    const message = await response
    if (message.error) throw new Error(`REA initialize failed: ${rpcError(message.error)}`)
    const result = object(message.result)
    if (typeof result?.protocolVersion === "string") state.protocolVersion = result.protocolVersion
    state.upstreamReady = true
    sendUp({ jsonrpc: "2.0", method: "notifications/initialized" })
  })().finally(() => {
    state.initializing = undefined
  })
  return state.initializing
}

function beginUpstreamRequest(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) {
  const id = state.nextID++
  const key = String(id)
  const response = new Promise<Rpc>((resolve, reject) => {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          state.pending.delete(key)
          reject(new Error(`REA upstream timed out after ${Math.round(timeoutMs / 1_000)}s while handling ${method}`))
        }, timeoutMs)
      : undefined
    state.pending.set(key, { resolve, reject, ...(timer ? { timer } : {}) })
  })
  try {
    sendUp({ jsonrpc: "2.0", id, method, params })
  } catch (error) {
    const pending = state.pending.get(key)
    state.pending.delete(key)
    if (pending?.timer) clearTimeout(pending.timer)
    throw error
  }
  return { id, response }
}

async function loadTools() {
  if (state.tools) return state.tools
  await ensureUpstreamInitialized()

  const collected: UpstreamTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const { response } = beginUpstreamRequest(
      "tools/list",
      cursor === undefined ? {} : { cursor },
      LIST_TIMEOUT_MS,
    )
    const message = await response
    if (message.error) throw new Error(`REA tools/list failed: ${rpcError(message.error)}`)
    const result = object(message.result)
    const tools = Array.isArray(result?.tools) ? result.tools : []
    for (const item of tools) {
      const tool = object(item)
      if (tool && typeof tool.name === "string" && tool.name.trim())
        collected.push(tool as UpstreamTool)
    }
    const next = result?.nextCursor
    if (typeof next !== "string" || next === cursor) break
    cursor = next
  }
  state.tools = collected
  return collected
}

function bridgeToolDefinitions() {
  return [
    {
      name: "tools",
      description:
        "List REA's reverse-engineering tools, or return one tool's input schema. Call rea_tools before " +
        "rea_call when the exact arguments are unknown. REA covers native binaries, JavaScript/Electron, " +
        ".NET, Android, firmware, browser pages, captures, and runtime evidence.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Case-insensitive substring matched against REA tool names and descriptions.",
          },
          tool: {
            type: "string",
            description: "Return the full description and input schema for this exact REA tool name.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LISTED_TOOLS,
            default: DEFAULT_LISTED_TOOLS,
            description: "Maximum number of tools to list.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "call",
      description:
        "Invoke one REA tool by exact name with its input arguments. Fetch the schema with rea_tools first. " +
        "Results preserve REA's evidence, target scope, and stated limitations.",
      inputSchema: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            description: "Exact REA tool name, for example open_binary or analyze_javascript_application.",
          },
          arguments: {
            type: "object",
            description: "Arguments object matching the tool's input schema.",
            additionalProperties: true,
          },
        },
        required: ["tool"],
        additionalProperties: false,
      },
    },
  ]
}

async function bridgeTools(args: Record<string, unknown>): Promise<ToolResult> {
  const tools = await loadTools()
  const requested = typeof args.tool === "string" ? args.tool.trim() : ""
  if (requested) {
    const found = tools.find((tool) => tool.name === requested)
    if (!found)
      return toolError(
        `Unknown REA tool "${requested}". Call rea_tools with a query to search the available tools.`,
      )
    return textResult(JSON.stringify({
      name: found.name,
      ...(found.title ? { title: found.title } : {}),
      ...(found.description ? { description: found.description } : {}),
      ...(found.inputSchema ? { inputSchema: found.inputSchema } : {}),
    }, undefined, 2))
  }

  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : ""
  const requestedLimit = typeof args.limit === "number" && Number.isFinite(args.limit)
    ? Math.trunc(args.limit)
    : DEFAULT_LISTED_TOOLS
  const limit = Math.max(1, Math.min(MAX_LISTED_TOOLS, requestedLimit))
  const matches = tools.filter((tool) =>
    !query ||
    tool.name.toLowerCase().includes(query) ||
    (tool.description ?? "").toLowerCase().includes(query)
  )
  const listed = matches.slice(0, limit).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: clip(tool.description, MAX_DESCRIPTION_CHARS) } : {}),
  }))
  return textResult(JSON.stringify({
    total: tools.length,
    matched: matches.length,
    returned: listed.length,
    ...(matches.length === 0
      ? { hint: "No REA tool matched. Call rea_tools without a query to see the catalog." }
      : matches.length > listed.length
        ? { hint: `Only the first ${listed.length} matches are shown. Narrow with query or raise limit.` }
        : {}),
    tools: listed,
  }, undefined, 2))
}

async function bridgeCall(
  args: Record<string, unknown>,
  downstreamID: RpcID,
): Promise<ToolResult> {
  const tool = typeof args.tool === "string" ? args.tool.trim() : ""
  if (!tool) return toolError("rea_call requires a non-empty tool name.")
  if (tool === "tools" || tool === "call")
    return toolError(
      "rea_call cannot invoke the bridge itself. Pass an REA tool name such as open_binary or binary_session.",
    )

  const tools = await loadTools()
  if (!tools.some((item) => item.name === tool))
    return toolError(
      `Unknown REA tool "${tool}". Call rea_tools with a query to search the available tools.`,
    )

  const input = args.arguments === undefined ? {} : object(args.arguments)
  if (!input) return toolError("rea_call.arguments must be an object.")

  await ensureUpstreamInitialized()
  const { id, response } = beginUpstreamRequest("tools/call", { name: tool, arguments: input }, 0)
  state.downstreamCalls.set(String(downstreamID), String(id))
  try {
    const message = await response
    if (message.error) return toolError(`REA tool "${tool}" failed: ${rpcError(message.error)}`)
    const result = object(message.result)
    if (!result) return toolError(`REA tool "${tool}" returned an invalid result.`)
    return result as ToolResult
  } finally {
    state.downstreamCalls.delete(String(downstreamID))
  }
}

async function handleToolCall(message: Rpc) {
  const params = object(message.params) ?? {}
  const name = params.name
  const args = object(params.arguments) ?? {}
  try {
    const result = name === "tools"
      ? await bridgeTools(args)
      : name === "call"
        ? await bridgeCall(args, message.id!)
        : toolError(`Unknown Boom REA bridge tool "${String(name)}".`)
    sendDown({ jsonrpc: "2.0", id: message.id, result })
  } catch (error) {
    sendDown({ jsonrpc: "2.0", id: message.id, result: toolError(errorText(error)) })
  }
}

async function handleInitialize(message: Rpc) {
  state.initializeParams = object(message.params) ?? {}
  try {
    await ensureUpstreamInitialized()
    sendDown({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: state.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "boom-rea-bridge", version: "1.0.0" },
        instructions: BRIDGE_INSTRUCTIONS,
      },
    })
  } catch (error) {
    sendDown({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32603, message: errorText(error) },
    })
  }
}

function handleDownstream(line: string) {
  const message = parseMessage(line)
  if (!message) return

  if (message.id === undefined) {
    if (message.method === "notifications/cancelled") {
      const params = object(message.params) ?? {}
      const upstreamID = state.downstreamCalls.get(String(params.requestId))
      if (upstreamID) {
        try {
          sendUp({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: {
              requestId: Number(upstreamID),
              ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
            },
          })
        } catch {
          // Upstream is gone; its pending call already rejects.
        }
      }
    }
    return
  }

  if (message.method === "initialize") {
    void handleInitialize(message)
    return
  }
  if (message.method === "ping") {
    sendDown({ jsonrpc: "2.0", id: message.id, result: {} })
    return
  }
  if (message.method === "tools/list") {
    sendDown({ jsonrpc: "2.0", id: message.id, result: { tools: bridgeToolDefinitions() } })
    return
  }
  if (message.method === "tools/call") {
    void handleToolCall(message)
    return
  }
  if (message.method === "prompts/list") {
    sendDown({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } })
    return
  }
  if (message.method === "resources/list") {
    sendDown({ jsonrpc: "2.0", id: message.id, result: { resources: [] } })
    return
  }
  if (message.method === "resources/templates/list") {
    sendDown({ jsonrpc: "2.0", id: message.id, result: { resourceTemplates: [] } })
    return
  }
  sendDown({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Method not found: ${String(message.method)}` },
  })
}

function shutdown() {
  if (state.exiting) return
  state.exiting = true
  const upstream = state.upstream
  if (!upstream) {
    process.exit(0)
    return
  }
  try {
    upstream.stdin?.end()
  } catch {
    // Already closed.
  }
  const force = setTimeout(() => {
    upstream.kill("SIGKILL")
    process.exit(0)
  }, SHUTDOWN_GRACE_MS)
  force.unref?.()
  upstream.once("exit", () => {
    clearTimeout(force)
    process.exit(0)
  })
}

process.stdin.setEncoding("utf8")
let downstreamBuffer = ""
process.stdin.on("data", (chunk: string) => {
  downstreamBuffer += chunk
  let index = downstreamBuffer.indexOf("\n")
  while (index !== -1) {
    const line = downstreamBuffer.slice(0, index).trim()
    downstreamBuffer = downstreamBuffer.slice(index + 1)
    index = downstreamBuffer.indexOf("\n")
    if (line) handleDownstream(line)
  }
})
process.stdin.on("end", shutdown)
process.stdin.on("error", shutdown)
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
