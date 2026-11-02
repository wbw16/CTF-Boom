import { afterEach, expect, test } from "bun:test"
import path from "node:path"

const ROOT = path.join(import.meta.dir, "..")
const BRIDGE = path.join(ROOT, "src", "runtime", "rea-bridge.ts")
const UPSTREAM = path.join(ROOT, "test", "fixtures", "rea-upstream.ts")

type Rpc = {
  id?: number | string
  method?: string
  result?: unknown
  error?: { code: number; message: string }
}

const children: Array<ReturnType<typeof Bun.spawn>> = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited.catch(() => undefined)
  }
})

async function* lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf("\n")
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
      if (line) yield line
    }
  }
  const tail = buffer.trim()
  if (tail) yield tail
}

async function start() {
  const child = Bun.spawn([process.execPath, BRIDGE, process.execPath, UPSTREAM], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  const iterator = lines(child.stdout)[Symbol.asyncIterator]()
  let nextID = 1
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextID++
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return id
  }
  const receive = async (): Promise<Rpc> => {
    const item = await iterator.next()
    if (item.done) throw new Error("bridge closed stdout")
    return JSON.parse(item.value) as Rpc
  }
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = send(method, params)
    const message = await receive()
    expect(message.id).toBe(id)
    return message
  }
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "boom-test", version: "0" },
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`)
  return { child, request }
}

function textOf(message: Rpc) {
  const result = message.result as { content?: Array<{ type: string; text?: string }> } | undefined
  return result?.content?.flatMap((item) => item.type === "text" && item.text ? [item.text] : []).join("\n") ?? ""
}

test("REA bridge advertises only discovery and invocation tools", async () => {
  const { request } = await start()
  const response = await request("tools/list")
  const tools = ((response.result as { tools: Array<{ name: string }> }).tools)
  expect(tools.map((tool) => tool.name)).toEqual(["tools", "call"])
  expect(JSON.stringify(response.result).length).toBeLessThan(5_000)
})

test("REA bridge lists, describes, paginates, and calls upstream tools", async () => {
  const { request } = await start()

  const listed = await request("tools/call", {
    name: "tools",
    arguments: { query: "echo" },
  })
  const catalog = JSON.parse(textOf(listed)) as { total: number; matched: number; tools: Array<{ name: string }> }
  expect(catalog.total).toBe(4)
  expect(catalog.matched).toBe(1)
  expect(catalog.tools[0]?.name).toBe("echo")
  expect(JSON.stringify(listed.result)).not.toContain("inputSchema")

  const schema = JSON.parse(textOf(await request("tools/call", {
    name: "tools",
    arguments: { tool: "echo" },
  }))) as { name: string; inputSchema: { required: string[] } }
  expect(schema.name).toBe("echo")
  expect(schema.inputSchema.required).toEqual(["value"])

  const paged = JSON.parse(textOf(await request("tools/call", {
    name: "tools",
    arguments: {},
  }))) as { tools: Array<{ name: string }> }
  // tools/list is paginated by the upstream fixture; the bridge must collect every page.
  expect(paged.tools.map((tool) => tool.name)).toEqual(["ping", "echo", "fail", "paged"])

  const echo = await request("tools/call", {
    name: "call",
    arguments: { tool: "echo", arguments: { value: "hello", extra: { nested: true } } },
  })
  expect(JSON.parse(textOf(echo))).toEqual({ value: "hello", extra: { nested: true } })

  const upstreamFailure = await request("tools/call", {
    name: "call",
    arguments: { tool: "fail" },
  })
  expect((upstreamFailure.result as { isError?: boolean }).isError).toBe(true)
  expect(textOf(upstreamFailure)).toContain("tool failed on purpose")
})

test("REA bridge rejects bridge recursion, unknown tools, and malformed arguments", async () => {
  const { request } = await start()
  for (const args of [
    { tool: "tools" },
    { tool: "call" },
    { tool: "missing" },
    { tool: "echo", arguments: "not-an-object" },
    {},
  ]) {
    const response = await request("tools/call", { name: "call", arguments: args })
    expect((response.result as { isError?: boolean }).isError).toBe(true)
  }
}, 30_000)
