#!/usr/bin/env bun

let buffer = ""

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function tools() {
  return [
    {
      name: "ping",
      description: "Return a deterministic marker.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "echo",
      description: "Echo the supplied value and extra arguments.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" }, extra: { type: "object" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    {
      name: "fail",
      description: "Return a tool-level error.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "paged",
      description: "Tool that only appears on the second tools/list page.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ]
}

function handle(message: Record<string, unknown>) {
  if (message.method === "notifications/initialized") return
  if (message.method === "notifications/cancelled") return
  if (typeof message.id !== "number" && typeof message.id !== "string") return
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "rea-test-upstream", version: "1.0.0" },
      },
    })
    return
  }
  if (message.method === "tools/list") {
    const params = (message.params ?? {}) as { cursor?: string }
    const all = tools()
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: params.cursor === "page-2"
        ? { tools: all.filter((tool) => tool.name === "paged") }
        : { tools: all.filter((tool) => tool.name !== "paged"), nextCursor: "page-2" },
    })
    return
  }
  if (message.method === "tools/call") {
    const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
    if (params.name === "ping") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "pong" }] },
      })
      return
    }
    if (params.name === "echo") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(params.arguments ?? {}) }] },
      })
      return
    }
    if (params.name === "fail") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "tool failed on purpose" }], isError: true },
      })
      return
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found", data: { tool: params.name } },
    })
    return
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  while (true) {
    const newline = buffer.indexOf("\n")
    if (newline === -1) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    handle(JSON.parse(line) as Record<string, unknown>)
  }
})

export {}
