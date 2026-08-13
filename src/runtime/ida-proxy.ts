#!/usr/bin/env bun
/**
 * Boom IDA 结果薄代理（thin result broker）。
 *
 * 位于 OpenCode 与上游 `idalib-mcp` 之间的 stdio MCP 透传层：
 * 1. 非 tools/call 的请求、响应与通知全部原样转发，工具 schema 不做任何改写；
 * 2. 拦截 tools/call 的返回：超过阈值的文本归档到 `<workspace>/work/ida/results/`，
 *    上下文只保留“指针 + 预览”，避免大结果滚入上下文或被客户端硬限截断；
 * 3. 上游会把超过 50K 字符的结构化输出替换成预览 + 一个在 headless stdio 模式下不可达的
 *    下载提示。对 `idalib_analyze_batch` 代理会按函数拆批重查，把完整结果逐份归档；
 * 4. 提供 `boom_ida_get` / `boom_ida_list` 两个分块检索工具，检索的是磁盘归档而非进程缓存；
 * 5. 工作区通过 MCP `roots/list` 发现；发现失败或写盘失败时降级为纯透传，绝不丢数据。
 *
 * 调用约定：`bun ida-proxy.ts <upstream-command> [args...]`（Bun 会吞掉紧跟脚本的 `--`，
 * 因此上游命令直接作为位置参数传入，不加分隔符）。stdout 是 MCP 协议通道，诊断只写 stderr。
 */
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"

type RpcID = number | string

type Rpc = {
  jsonrpc?: "2.0"
  id?: RpcID
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type ToolResult = {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: unknown
  isError?: boolean
  _meta?: unknown
}

type ManifestEntry = {
  v: 1
  id: string
  at: string
  tool: string
  key: string
  hash: string
  file: string
  chars: number
  lines: number
  truncated?: boolean
  functions?: string[]
  repeat?: boolean
}

const MAX_PREVIEW_CHARS = 500
const MAX_SPLIT_QUERIES = 32
const MAX_GET_LINES = 2_000
const DEFAULT_OFFLOAD_CHARS = 16_000
const UPSTREAM_TIMEOUT_MS = 120_000
const MANIFEST_NAME = "index.jsonl"
const MAX_MANIFEST_TAIL_BYTES = 2 * 1024 * 1024
const MAX_ARTIFACT_READ_BYTES = 8 * 1024 * 1024

const LOCAL_TOOLS = new Set(["boom_ida_get", "boom_ida_list"])

function usage(): never {
  process.stderr.write("usage: ida-proxy.ts <upstream-command> [args...]\n")
  process.exit(2)
}

function envInteger(name: string, fallback: number) {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function canonical(value: unknown): string {
  if (value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

/** 逐行读取一个字节流，兼容任意分块；stdout/stdin 的 MCP stdio 帧就是一行一个 JSON。 */
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
        if (!line) continue
        this.push(line)
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

type PendingCall = {
  resolve: (message: Rpc) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type ForwardedCall = {
  toolName?: string
  args?: Record<string, unknown>
  toolsList?: boolean
  initialize?: boolean
}

type ProxyState = {
  offloadChars: number
  workspace: string | undefined
  resultsDir: string | undefined
  upstream: ChildProcess | undefined
  exiting: boolean
  rootsRequested: boolean
  nextUpstreamID: number
  nextDownstreamID: number
  upstreamPending: Map<string, PendingCall>
  downstreamPending: Map<RpcID, (message: Rpc) => void>
  forwarded: Map<RpcID, ForwardedCall>
  manifestQueue: Promise<void>
}

function createState(): ProxyState {
  return {
    offloadChars: envInteger("BOOM_IDA_OFFLOAD_CHARS", DEFAULT_OFFLOAD_CHARS),
    workspace: undefined,
    resultsDir: undefined,
    upstream: undefined,
    exiting: false,
    rootsRequested: false,
    nextUpstreamID: 1,
    nextDownstreamID: 1,
    upstreamPending: new Map(),
    downstreamPending: new Map(),
    forwarded: new Map(),
    manifestQueue: Promise.resolve(),
  }
}

function sendDown(message: Rpc) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function sendUp(state: ProxyState, message: Rpc) {
  state.upstream?.stdin?.write(`${JSON.stringify(message)}\n`)
}

function parseMessage(line: string): Rpc | undefined {
  try {
    const value = JSON.parse(line) as Rpc
    return value && typeof value === "object" ? value : undefined
  } catch {
    return undefined
  }
}

function resultText(result: ToolResult) {
  const content = Array.isArray(result.content)
    ? result.content.flatMap((item) => item.type === "text" && typeof item.text === "string" ? [item.text] : [])
    : []
  const text = content.join("\n\n")
  if (text) return text
  return result.structuredContent === undefined || result.structuredContent === null
    ? ""
    : JSON.stringify(result.structuredContent)
}

function upstreamTruncated(result: ToolResult) {
  const meta = result._meta as { ida_mcp?: { output_truncated?: unknown } } | undefined
  return meta?.ida_mcp?.output_truncated === true || resultText(result).includes("Output truncated")
}

function preview(text: string) {
  if (text.length <= MAX_PREVIEW_CHARS * 2 + 60) return text
  return [
    text.slice(0, MAX_PREVIEW_CHARS),
    `\n… [中间 ${text.length - MAX_PREVIEW_CHARS * 2} 字符省略] …\n`,
    text.slice(-MAX_PREVIEW_CHARS),
  ].join("")
}

function localToolDefinitions() {
  return [
    {
      name: "boom_ida_get",
      description:
        "分段读取已归档的 IDA 查询结果。ID 来自结果指针消息或 boom_ida_list；输出按行分块，避免一次性塞满上下文。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "归档 ID（指针消息或 boom_ida_list 中的 id）" },
          start_line: { type: "integer", minimum: 1, default: 1, description: "起始行，1 开始" },
          max_lines: { type: "integer", minimum: 1, maximum: MAX_GET_LINES, default: 400, description: "返回的最大行数" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "boom_ida_list",
      description: "列出最近归档的 IDA 查询结果（工具、目标函数、文件与大小），用于恢复上下文后快速定位已有分析。",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "最多返回条数" },
        },
        additionalProperties: false,
      },
    },
  ]
}

async function ensureResultsDir(state: ProxyState) {
  if (state.resultsDir) return state.resultsDir
  if (!state.workspace) return undefined
  try {
    const directory = path.join(state.workspace, "work", "ida", "results")
    await mkdir(directory, { recursive: true })
    state.resultsDir = directory
    return directory
  } catch {
    return undefined
  }
}

function manifestPath(directory: string) {
  return path.join(directory, MANIFEST_NAME)
}

function queueManifestAppend(state: ProxyState, directory: string, entry: ManifestEntry) {
  state.manifestQueue = state.manifestQueue.then(async () => {
    await appendFile(manifestPath(directory), `${JSON.stringify(entry)}\n`, "utf8")
  }).catch(() => {})
  return state.manifestQueue
}

async function readManifestTail(directory: string, limit: number): Promise<ManifestEntry[]> {
  const target = manifestPath(directory)
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info?.isFile()) return []
  const handle = await readFile(target, "utf8").catch(() => "")
  const bounded = handle.length > MAX_MANIFEST_TAIL_BYTES ? handle.slice(-MAX_MANIFEST_TAIL_BYTES) : handle
  const entries: ManifestEntry[] = []
  for (const line of bounded.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as ManifestEntry
      if (entry.v === 1 && typeof entry.id === "string") entries.push(entry)
    } catch {
      // 半行/损坏条目不影响其余记录。
    }
  }
  return entries.slice(-limit).reverse()
}

async function writeArtifact(directory: string, id: string, text: string) {
  const file = `${id}.txt`
  const target = path.join(directory, file)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, text, "utf8")
  await rename(temporary, target)
  return { file, path: target }
}

function pointerMessage(tool: string, text: string, entry: ManifestEntry) {
  const truncated = entry.truncated ? " · 上游已截断" : ""
  const repeat = entry.repeat ? " · 与上次同参查询内容一致，未重复写盘" : ""
  const lines = text.split("\n").length
  const content = [
    `[IDA 结果已归档] work/ida/results/${entry.file}`,
    `工具 ${tool} · ${entry.chars} 字符 · ${lines} 行${truncated}${repeat}`,
    "",
    preview(text),
    "",
    `完整内容分段读取：idalib_boom_ida_get(id="${entry.id}")；最近归档列表：idalib_boom_ida_list()。`,
  ].join("\n")
  return { content: [{ type: "text", text: content }], isError: false }
}

async function archive(
  state: ProxyState,
  tool: string,
  args: Record<string, unknown>,
  text: string,
  options: { truncated?: boolean; functions?: string[] } = {},
) {
  const directory = await ensureResultsDir(state)
  if (!directory) return undefined
  const key = digest(`${tool}\u0000${canonical(args)}`)
  const hash = digest(text)
  const previous = (await readManifestTail(directory, 500)).find(
    (entry) => entry.key === key && entry.hash === hash,
  )
  const id = previous
    ? previous.id
    : `${Date.now()}-${tool.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 24)}-${hash.slice(0, 8)}`
  const file = previous ? previous.file : await writeArtifact(directory, id, text).then((written) => written.file)
  const entry: ManifestEntry = {
    v: 1,
    id,
    at: new Date().toISOString(),
    tool,
    key,
    hash,
    file,
    chars: text.length,
    lines: text.split("\n").length,
    ...(options.truncated ? { truncated: true } : {}),
    ...(options.functions?.length ? { functions: options.functions } : {}),
    ...(previous ? { repeat: true } : {}),
  }
  await queueManifestAppend(state, directory, entry)
  return entry
}

async function transformToolResult(
  state: ProxyState,
  name: string,
  args: Record<string, unknown>,
  message: Rpc,
): Promise<ToolResult | undefined> {
  const result = message.result as ToolResult | undefined
  if (message.error || !result || result.isError) return undefined
  const text = resultText(result)
  if (!text) return undefined

  const truncated = upstreamTruncated(result)
  const queries = Array.isArray(args.queries) ? args.queries : undefined
  if (
    truncated &&
    name === "idalib_analyze_batch" &&
    queries &&
    queries.length > 1
  ) {
    return splitAnalyzeBatch(state, name, args, queries)
  }
  if (truncated || text.length > state.offloadChars) {
    const entry = await archive(state, name, args, text, { truncated })
    if (entry) return pointerMessage(name, text, entry)
  }
  return undefined
}

async function splitAnalyzeBatch(
  state: ProxyState,
  name: string,
  args: Record<string, unknown>,
  queries: unknown[],
) {
  const directory = await ensureResultsDir(state)
  if (!directory) return undefined // 降级：无法归档时不重查，由调用方走预览透传
  const items = queries.slice(0, MAX_SPLIT_QUERIES)
  const lines: string[] = []
  for (let index = 0; index < items.length; index += 1) {
    const query = items[index]
    const label = queryLabel(query, index)
    try {
      const response = await callUpstream(state, {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: { ...args, queries: [query] } },
      })
      const result = response.result as ToolResult | undefined
      if (response.error || !result || result.isError)
        throw new Error(response.error?.message ?? "上游查询失败")
      const text = resultText(result)
      if (!text) throw new Error("上游返回空结果")
      const subArgs = { ...args, queries: [query] }
      const entry = await archive(state, name, subArgs, text, {
        truncated: upstreamTruncated(result),
        functions: [label],
      })
      if (!entry) throw new Error("归档失败")
      lines.push(
        `- ${label}: work/ida/results/${entry.file} (${entry.chars} 字符${entry.truncated ? " · 上游截断" : ""})`,
      )
    } catch (error) {
      lines.push(`- ${label}: 查询失败 — ${errorText(error)}`)
    }
  }
  const content = [
    `[IDA analyze_batch 拆批归档] 原批量结果超过上游输出上限，已按函数重查并归档 ${items.length} 份：`,
    ...lines,
    "",
    `用 idalib_boom_ida_get(id="<id>") 分段读取对应文件；全部列表：idalib_boom_ida_list()。`,
  ].join("\n")
  return { content: [{ type: "text", text: content }], isError: false }
}

function queryLabel(query: unknown, index: number) {
  if (query && typeof query === "object") {
    const record = query as Record<string, unknown>
    if (typeof record.addr === "string" && record.addr) return record.addr
    if (typeof record.name === "string" && record.name) return record.name
    if (typeof record.address === "number" && record.address) return `0x${record.address.toString(16)}`
  }
  return `query-${index + 1}`
}

function callUpstream(state: ProxyState, message: Rpc) {
  const id = `__boom_up_${state.nextUpstreamID++}`
  return new Promise<Rpc>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.upstreamPending.delete(id)
      reject(new Error(`上游响应超时（${UPSTREAM_TIMEOUT_MS / 1000}s）`))
    }, UPSTREAM_TIMEOUT_MS)
    state.upstreamPending.set(id, { resolve, reject, timer })
    sendUp(state, { ...message, id })
  })
}

async function handleLocalTool(state: ProxyState, message: Rpc) {
  const params = (message.params ?? {}) as Record<string, unknown>
  const name = message.method === "tools/call" && typeof params.name === "string" ? params.name : ""
  const args = params.arguments && typeof params.arguments === "object"
    ? params.arguments as Record<string, unknown>
    : {}
  try {
    if (name === "boom_ida_get") {
      const directory = state.resultsDir ?? await ensureResultsDir(state)
      const id = typeof args.id === "string" ? args.id.trim() : ""
      if (!directory) throw new Error("IDA 结果归档不可用（未发现任务工作区）")
      if (!id) throw new Error("boom_ida_get 需要 id 参数")
      const entry = (await readManifestTail(directory, 500)).find((item) => item.id === id)
      if (!entry) throw new Error(`找不到归档 ID：${id}（可用 boom_ida_list() 查看）`)
      const target = path.join(directory, entry.file)
      const info = await lstat(target)
      if (!info.isFile()) throw new Error(`归档文件不是常规文件：${entry.file}`)
      if (info.size > MAX_ARTIFACT_READ_BYTES)
        throw new Error(`归档文件过大（${info.size} 字节），请用更小的范围读取`)
      const text = await readFile(target, "utf8")
      const allLines = text.split("\n")
      const startLine = integerArg(args.start_line, 1)
      const maxLines = integerArg(args.max_lines, 400)
      const start = Math.max(1, startLine)
      const chunk = allLines.slice(start - 1, start - 1 + Math.min(maxLines, MAX_GET_LINES))
      const end = start + chunk.length - 1
      const remaining = Math.max(0, allLines.length - end)
      const body = [
        `# work/ida/results/${entry.file}`,
        `${entry.tool} · 第 ${start}-${end} 行 / 共 ${allLines.length} 行`,
        chunk.join("\n"),
        remaining > 0 ? `\n… 还有 ${remaining} 行，用 start_line=${end + 1} 继续 …` : "",
      ].filter(Boolean).join("\n")
      sendDown({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: body }], isError: false },
      })
      return
    }
    if (name === "boom_ida_list") {
      const directory = state.resultsDir ?? await ensureResultsDir(state)
      const limit = Math.max(1, Math.min(500, integerArg(args.limit, 100)))
      const entries = directory ? await readManifestTail(directory, limit) : []
      const body = entries.length === 0
        ? "暂无归档的 IDA 结果。"
        : [
            `已归档 IDA 查询结果（最近 ${entries.length} 条）：`,
            ...entries.map((entry) =>
              `- ${entry.id}  ${entry.at}  ${entry.tool}  ${entry.file}  ${entry.chars} 字符` +
              `${entry.truncated ? " · 截断" : ""}` +
              `${entry.functions?.length ? ` · ${entry.functions.join(", ")}` : ""}` +
              `${entry.repeat ? " · 重复查询" : ""}`,
            ),
          ].join("\n")
      sendDown({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: body }], isError: false },
      })
      return
    }
    throw new Error(`未知的 Boom IDA 工具：${name}`)
  } catch (error) {
    sendDown({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32602, message: errorText(error) },
    })
  }
}

function integerArg(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback
}

function requestWorkspaceRoots(state: ProxyState) {
  if (state.rootsRequested) return
  state.rootsRequested = true
  const id = `__boom_roots_${state.nextDownstreamID++}`
  state.downstreamPending.set(id, (message) => {
    const roots = (message.result as { roots?: Array<{ uri?: string }> } | undefined)?.roots ?? []
    const uri = roots.find((item) => typeof item.uri === "string" && item.uri.startsWith("file:"))?.uri
    if (!uri) return
    try {
      state.workspace = fileURLToPath(uri)
    } catch {
      // 保留未发现状态，归档降级为透传。
    }
  })
  sendDown({ jsonrpc: "2.0", id, method: "roots/list", params: {} })
}

async function handleDownstream(state: ProxyState, message: Rpc) {
  // 对我们发出的请求（roots/list）的响应。
  if (message.id !== undefined && message.method === undefined && state.downstreamPending.has(message.id)) {
    const resolve = state.downstreamPending.get(message.id)!
    state.downstreamPending.delete(message.id)
    resolve(message)
    return
  }
  // 不是我们发出的请求的响应，也不应转发给上游，直接丢弃。
  if (message.id !== undefined && message.method === undefined) return
  // 客户端通知（initialized / cancelled 等）原样转给上游。
  if (message.id === undefined) {
    sendUp(state, message)
    return
  }
  const params = message.params as Record<string, unknown> | undefined
  const toolName = message.method === "tools/call" && typeof params?.name === "string" ? params.name : undefined
  if (toolName && LOCAL_TOOLS.has(toolName)) {
    await handleLocalTool(state, message)
    return
  }
  state.forwarded.set(message.id, {
    ...(toolName ? { toolName, args: (params?.arguments ?? {}) as Record<string, unknown> } : {}),
    ...(message.method === "tools/list" ? { toolsList: true } : {}),
    ...(message.method === "initialize" ? { initialize: true } : {}),
  })
  sendUp(state, message)
}

async function handleUpstream(state: ProxyState, message: Rpc) {
  // 我们主动发出的上游子调用（拆批重查）。
  if (message.id !== undefined && typeof message.id === "string" && state.upstreamPending.has(message.id)) {
    const pending = state.upstreamPending.get(message.id)!
    state.upstreamPending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message)
    return
  }
  // 上游通知（progress 等）原样转给客户端。
  if (message.id === undefined) {
    sendDown(message)
    return
  }
  const forwarded = state.forwarded.get(message.id)
  state.forwarded.delete(message.id)
  if (forwarded?.toolsList && message.error === undefined) {
    const result = message.result as { tools?: unknown[] } | undefined
    const upstreamTools = Array.isArray(result?.tools) ? result.tools : []
    sendDown({
      ...message,
      result: { ...(result ?? {}), tools: [...upstreamTools, ...localToolDefinitions()] },
    })
    return
  }
  if (forwarded?.toolName && forwarded.args && message.error === undefined) {
    // 拆批重查需要等待后续上游响应，绝不能阻塞上游读取循环等待自己。
    void transformToolResult(state, forwarded.toolName, forwarded.args, message)
      .then((transformed) => {
        sendDown(transformed
          ? { jsonrpc: "2.0", id: message.id, result: transformed }
          : message)
      })
      .catch(() => sendDown(message))
    return
  }
  sendDown(message)
  if (forwarded?.initialize) requestWorkspaceRoots(state)
}

async function main(argv: string[]) {
  const upstreamCommand = argv
  if (upstreamCommand.length === 0) usage()
  const state = createState()
  const child = spawn(upstreamCommand[0]!, upstreamCommand.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  })
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk))
  state.upstream = child
  child.on("error", (error) => {
    process.stderr.write(`[boom-ida-proxy] 无法启动上游：${errorText(error)}\n`)
    process.exit(1)
  })
  child.on("exit", (code) => {
    if (state.exiting) return
    state.exiting = true
    process.exit(code ?? 0)
  })
  const shutdown = () => {
    if (state.exiting) return
    state.exiting = true
    child.kill()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  process.stdin.on("end", shutdown)

  const upstreamReader = new LineReader(child.stdout!)
  const downstreamReader = new LineReader(process.stdin)

  const upstreamLoop = (async () => {
    while (!state.exiting) {
      const line = await upstreamReader.next()
      if (line === null) break
      const message = parseMessage(line)
      if (message) await handleUpstream(state, message)
    }
  })()
  const downstreamLoop = (async () => {
    while (!state.exiting) {
      const line = await downstreamReader.next()
      if (line === null) break
      const message = parseMessage(line)
      if (message) await handleDownstream(state, message)
    }
  })()
  await Promise.all([upstreamLoop, downstreamLoop])
  shutdown()
}

if (import.meta.main) {
  await main(process.argv.slice(2))
}

export {
  LineReader,
  canonical,
  localToolDefinitions,
  pointerMessage,
  queryLabel,
  resultText,
  upstreamTruncated,
}
