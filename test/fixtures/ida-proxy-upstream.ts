#!/usr/bin/env bun
// 模拟上游 idalib-mcp 的 stdio MCP server，供 ida-proxy 测试使用。
import { appendFileSync } from "node:fs"

let buffer = ""

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function logCall(name: string, args: unknown) {
  const target = process.env.BOOM_TEST_CALL_LOG
  if (!target) return
  try {
    appendFileSync(target, `${JSON.stringify({ name, arguments: args })}\n`, "utf8")
  } catch {
    // 日志失败不影响测试主体。
  }
}

function result(content: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: content }],
    isError: false,
    ...extra,
  }
}

function handle(message: Record<string, unknown>) {
  if (typeof message.id !== "number" && typeof message.id !== "string") return
  const params = (message.params ?? {}) as Record<string, unknown>
  const name = message.method === "tools/call" && typeof params.name === "string" ? params.name : ""
  const args = params.arguments && typeof params.arguments === "object"
    ? params.arguments as Record<string, unknown>
    : {}

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-idalib", version: "1.0.0" },
      },
    })
    return
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "idalib_analyze_batch",
            description: "Batch analysis fixture",
            inputSchema: {
              type: "object",
              properties: {
                database: { type: "string" },
                queries: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { addr: { type: "string" } },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: "idalib_decompile",
            description: "Decompile fixture",
            inputSchema: {
              type: "object",
              properties: { function: { type: "string" } },
              additionalProperties: false,
            },
          },
          {
            name: "idalib_get_bytes",
            description: "Byte read fixture",
            inputSchema: {
              type: "object",
              properties: { fail: { type: "boolean" } },
              additionalProperties: false,
            },
          },
        ],
      },
    })
    return
  }
  if (message.method === "tools/call") {
    logCall(name, args)
    if (name === "idalib_decompile") {
      if (args.function === "big") {
        const body = "ABCDEFGH\n".repeat(200)
        send({ jsonrpc: "2.0", id: message.id, result: result(`BIG_BODY\n${body}`) })
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: result("small decompile body") })
      }
      return
    }
    if (name === "idalib_analyze_batch") {
      const queries = Array.isArray(args.queries) ? args.queries : []
      if (queries.length > 1) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: result("preview of batch result", {
            _meta: { ida_mcp: { output_truncated: true, total_chars: 120_000 } },
          }),
        })
      } else {
        const query = queries[0] as { addr?: string } | undefined
        const addr = typeof query?.addr === "string" ? query.addr : "unknown"
        send({ jsonrpc: "2.0", id: message.id, result: result(`decompiled ${addr} body`) })
      }
      return
    }
    if (name === "idalib_get_bytes") {
      if (args.fail === true) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "upstream failed" }], isError: true },
        })
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: result("00 11 22 33") })
      }
      return
    }
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
    try {
      handle(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // 忽略坏帧。
    }
  }
})
