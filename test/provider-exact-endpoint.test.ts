import { afterEach, expect, test } from "bun:test"
import { OpenAICompatibleProviderDriver } from "../src/runtime/openai-compatible-driver.ts"
import {
  exactEndpointURL,
  isExactEndpoint,
  providerEndpoint,
} from "../src/runtime/provider-http.ts"
import { startExactEndpointProxy } from "../src/runtime/exact-endpoint-proxy.ts"
import { assertProviderBaseURL, normalizeManagedProvider } from "../src/provider-config.ts"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/**
 * A competition LLM gateway exposes one fixed URL that takes the chat-completions body directly and
 * returns 404 for any sub-path, so the Base URL must be usable as an exact endpoint. Verified against
 * the live gateway: POST at its root answers 200 while `<root>/chat/completions` answers 404.
 */
const GATEWAY = "https://llm-gateway.example.com/llm-gateway/proxy/e/token123"

test("appends the endpoint to a prefix Base URL", () => {
  expect(providerEndpoint("https://api.example.com/v1", "chat/completions"))
    .toBe("https://api.example.com/v1/chat/completions")
  // A trailing slash must not double up.
  expect(providerEndpoint("https://api.example.com/v1/", "chat/completions"))
    .toBe("https://api.example.com/v1/chat/completions")
})

test("uses a marked Base URL verbatim instead of appending a path", () => {
  expect(isExactEndpoint(`${GATEWAY}!`)).toBe(true)
  expect(isExactEndpoint(GATEWAY)).toBe(false)
  expect(exactEndpointURL(`${GATEWAY}!`)).toBe(GATEWAY)
  // Without this the request would go to <gateway>/chat/completions, which the gateway rejects.
  expect(providerEndpoint(`${GATEWAY}!`, "chat/completions")).toBe(GATEWAY)
})

test("recognizes the 西湖论剑 gateway root as a complete endpoint without a marker", () => {
  const gateway = "https://llm-gateway.dasctf.com/llm-gateway/proxy/e/token123"
  expect(isExactEndpoint(gateway)).toBe(true)
  expect(exactEndpointURL(gateway)).toBe(gateway)
  expect(providerEndpoint(gateway, "chat/completions")).toBe(gateway)
})

test("accepts a marked Base URL in provider configuration", () => {
  expect(assertProviderBaseURL(`${GATEWAY}!`)).toBe(`${GATEWAY}!`)
  const provider = normalizeManagedProvider({
    id: "gateway",
    name: "Competition Gateway",
    custom: true,
    driver: "openai-compatible",
    baseURL: `${GATEWAY}!`,
    models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
  })
  expect(provider.baseURL).toBe(`${GATEWAY}!`)
  // The marker must not smuggle past the credential-free URL rules.
  expect(() => assertProviderBaseURL("https://user:pass@example.com/x!")).toThrow(/credential-free/)
  expect(() => assertProviderBaseURL("ftp://example.com/x!")).toThrow(/credential-free/)
})

test("streams tool calls and usage from a gateway that only answers at its root", async () => {
  const paths: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      paths.push(url.pathname)
      // Mirror the real gateway: only the exact root accepts the request.
      if (url.pathname !== "/llm-gateway/proxy/e/token123")
        return new Response("not found", { status: 404 })
      const events = [
        {
          id: "chunk-1",
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        },
        {
          id: "chunk-2",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: "{\"command\":\"echo boom\"}" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          id: "chunk-3",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 292, completion_tokens: 43 },
        },
        "[DONE]" as const,
      ]
      return new Response(
        events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`).join(""),
        { headers: { "content-type": "text/event-stream; charset=utf-8" } },
      )
    },
  })
  servers.push(server)

  const driver = new OpenAICompatibleProviderDriver({
    baseURL: `http://127.0.0.1:${server.port}/llm-gateway/proxy/e/token123!`,
    apiKey: "sk-test",
  })

  const toolCalls: string[] = []
  let finish: string | undefined
  let usage: { input: number; output: number } | undefined
  for await (const event of driver.stream({
    model: "deepseek-chat",
    conversationID: "test-conv",
    step: 1,
    agent: "boom",
    system: "solve the challenge",
    signal: new AbortController().signal,
    messages: [{ role: "user", content: "run echo boom" }],
    tools: [{
      name: "bash",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }],
  })) {
    if (event.type === "tool-call-delta" && event.name) toolCalls.push(event.name)
    if (event.type === "finish") finish = event.reason
    if (event.type === "usage") usage = { input: event.usage.input, output: event.usage.output }
  }

  expect(toolCalls).toEqual(["bash"])
  expect(finish).toBe("tool-calls")
  expect(usage).toEqual({ input: 292, output: 43 })
  // The driver must never have tried a sub-path.
  expect(paths).toEqual(["/llm-gateway/proxy/e/token123"])
})

test("adapts OpenCode's compatibility path to a marked gateway root without buffering its SSE stream", async () => {
  const paths: string[] = []
  let authorization: string | null = null
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      paths.push(url.pathname)
      authorization = request.headers.get("authorization")
      if (request.method !== "POST" || url.pathname !== "/llm-gateway/proxy/e/token123")
        return new Response("not found", { status: 404 })
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  servers.push(server)
  const proxy = startExactEndpointProxy({
    gateway: `http://127.0.0.1:${server.port}/llm-gateway/proxy/e/token123!`,
  })!
  try {
    const driver = new OpenAICompatibleProviderDriver({
      baseURL: `${proxy.baseURL}/providers/gateway/v1`,
      apiKey: "gateway-test-key",
    })
    const events = await Array.fromAsync(driver.stream({
      model: "deepseek-chat",
      conversationID: "proxy-test",
      step: 1,
      agent: "boom",
      system: "solve",
      signal: new AbortController().signal,
      messages: [{ role: "user", content: "test" }],
      tools: [],
    }))

    expect(paths).toEqual(["/llm-gateway/proxy/e/token123"])
    expect(authorization as string | null).toBe("Bearer gateway-test-key")
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool-call-delta", name: "bash" }),
      expect.objectContaining({ type: "usage", usage: expect.objectContaining({ input: 4, output: 2 }) }),
      expect.objectContaining({ type: "finish", reason: "tool-calls" }),
    ]))
    const rejected = await fetch(`${proxy.baseURL}/providers/gateway/v1/models`)
    expect(rejected.status).toBe(404)
  } finally {
    proxy.close()
  }
})
