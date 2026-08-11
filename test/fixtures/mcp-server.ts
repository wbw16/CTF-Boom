#!/usr/bin/env bun

let buffer = ""

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function handle(message: Record<string, unknown>) {
  if (typeof message.id !== "number" && typeof message.id !== "string") return
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "boom-test-mcp", version: "1.0.0" },
      },
    })
    return
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "ping",
          description: "Return a deterministic test marker.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      },
    })
    return
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "pong" }] },
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
