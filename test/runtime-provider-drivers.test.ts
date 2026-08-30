import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { saveProviderStore, providerStorePath } from "../src/provider-config.ts"
import { NativeProviderFailure, type NativeProviderRequest } from "../src/runtime/native-provider.ts"
import { OpenAICompatibleProviderDriver } from "../src/runtime/openai-compatible-driver.ts"
import { providerFetch, serverSentEvents } from "../src/runtime/provider-http.ts"
import {
  credentialStorePath,
  hasProviderAPIKey,
  setProviderAPIKey,
} from "../src/runtime/credential-store.ts"
import { inspectNativeProviders, startRuntime } from "../src/runtime.ts"
import type { RuntimeHandle } from "../src/runtime-contract.ts"
import { GuiRunner } from "../src/runner.ts"

const directories: string[] = []
const handles: RuntimeHandle[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

function sse(events: Array<Record<string, unknown> | "[DONE]">) {
  return new Response(events.map((event) =>
    `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`,
  ).join(""), { headers: { "content-type": "text/event-stream; charset=utf-8" } })
}

function model(id: string) {
  return {
    id,
    name: id,
    context: 128_000,
    output: 16_384,
    reasoning: true,
    attachment: false,
    pricing: { input: 1, output: 2 },
  }
}

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-provider-driver-"))
  directories.push(directory)
  await mkdir(path.join(directory, "challenge"), { recursive: true })
  await mkdir(path.join(directory, "work"), { recursive: true })
  await writeFile(path.join(directory, "challenge", "challenge.json"), "{}\n")
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n\nprotocol evidence\n")
  return directory
}

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close()
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe("Boom first-party Provider Drivers", () => {
  test("normalizes fragmented CRLF SSE frames and rejects an incomplete stream", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of ["event: delta\r", "\ndata: {\"value\":", "1}\r\n\r", "\n"])
          controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } })
    expect(await Array.fromAsync(serverSentEvents(response))).toEqual([
      { event: "delta", data: '{"value":1}' },
    ])
    await expect(Array.fromAsync(serverSentEvents(new Response("data: {}", {
      headers: { "content-type": "text/event-stream" },
    })))).rejects.toMatchObject({ failure: { category: "network", retryable: true } })
    await expect(Array.fromAsync(serverSentEvents(new Response("{}", {
      headers: { "content-type": "application/json" },
    })))).rejects.toMatchObject({ failure: { category: "malformed-response" } })
  })

  test("runs OpenAI-compatible, OpenAI Responses, and Anthropic tool loops through the Native kernel", async () => {
    // Every provider in this test is a local scripted server. Ambient Anthropic credentials in the
    // developer's shell would otherwise let discovery reach the real endpoint, so clear them: a unit
    // test must never make an outbound request, least of all one carrying a live token.
    const managed = [
      "BOOM_HOME",
      "BOOM_ANTHROPIC_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
    ] as const
    const previousEnvironment = Object.fromEntries(managed.map((name) => [name, process.env[name]]))
    const boomHome = await mkdtemp(path.join(os.tmpdir(), "boom-provider-home-"))
    directories.push(boomHome)
    for (const name of managed) delete process.env[name]
    process.env.BOOM_HOME = boomHome
    const requests: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = []
    const searches: string[] = []
    const keys = { compat: "compat-test-secret", openai: "openai-test-secret", anthropic: "anthropic-test-secret" }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const provider = url.pathname.split("/")[1]
        const expected = keys[provider as keyof typeof keys]
        const received = provider === "anthropic"
          ? request.headers.get("x-api-key")
          : request.headers.get("authorization")?.replace(/^Bearer /, "")
        if (expected && received !== expected)
          return new Response(`credential=${received}`, { status: 401 })
        if (url.pathname.endsWith("/models"))
          return Response.json({ data: [{
            id: provider === "openai" ? "gpt-openai-discovered" : `${provider}-discovered`,
            display_name: `${provider} discovered`,
          }] })
        const body = await request.json() as Record<string, unknown>
        requests.push({ path: url.pathname, body, headers: request.headers })

        if (url.pathname.endsWith("/chat/completions")) {
          const messages = body.messages as Array<Record<string, unknown>>
          const hasToolResult = messages.some((message) => message.role === "tool")
          if (!hasToolResult) return sse([
            { id: "compat-request-1", choices: [{ delta: { tool_calls: [{ index: 0, id: "compat-call", function: { name: "read", arguments: "{\"file" } }] }, finish_reason: null }] },
            { id: "compat-request-1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "Path\":\"NOTES.md\"}" } }] }, finish_reason: null }] },
            { id: "compat-request-1", choices: [{ delta: { tool_calls: [{ index: 1, id: "search-call", function: { name: "websearch", arguments: "{\"query\":\"Boom Native\",\"numResults\":2}" } }] }, finish_reason: null }] },
            { id: "compat-request-1", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            { id: "compat-request-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 } } },
            "[DONE]",
          ])
          return sse([
            { id: "compat-request-2", choices: [{ delta: { content: "compat complete" }, finish_reason: null }] },
            { id: "compat-request-2", choices: [{ delta: {}, finish_reason: "stop" }] },
            { id: "compat-request-2", choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
            "[DONE]",
          ])
        }

        if (url.pathname.endsWith("/responses")) {
          const input = body.input as Array<Record<string, unknown>>
          const hasToolResult = input.some((item) => item.type === "function_call_output")
          if (!hasToolResult) return sse([
            { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "openai-call", name: "read", arguments: "" } },
            { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"filePath\":" },
            { type: "response.function_call_arguments.delta", output_index: 0, delta: "\"NOTES.md\"}" },
            { type: "response.completed", response: { id: "openai-request-1", status: "completed", output: [{ type: "function_call" }], usage: { input_tokens: 7, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 } } } },
          ])
          return sse([
            { type: "response.output_text.delta", delta: "openai complete" },
            { type: "response.completed", response: { id: "openai-request-2", status: "completed", output: [{ type: "message" }], usage: { input_tokens: 4, output_tokens: 2 } } },
          ])
        }

        if (url.pathname.endsWith("/messages")) {
          const messages = body.messages as Array<Record<string, unknown>>
          const hasToolResult = messages.some((message) =>
            Array.isArray(message.content) && message.content.some((item: Record<string, unknown>) => item.type === "tool_result"),
          )
          if (!hasToolResult) return sse([
            { type: "message_start", message: { id: "anthropic-request-1", usage: { input_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 0, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "anthropic-call", name: "read", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"filePath\":" } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"NOTES.md\"}" } },
            { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ])
          return sse([
            { type: "message_start", message: { id: "anthropic-request-2", usage: { input_tokens: 3, output_tokens: 0 } } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "anthropic complete" } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ])
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)

    try {
      const origin = `http://${server.hostname}:${server.port}`
      await saveProviderStore({
        version: 1,
        armorPrompts: [],
        providers: {
          compat: {
            id: "compat", custom: true, disabled: false, name: "Compatibility fixture",
            driver: "openai-compatible", baseURL: `${origin}/compat/v1`, models: [model("compat-model")], hiddenModels: [],
          },
          openai: {
            id: "openai", custom: false, disabled: false,
            driver: "openai", baseURL: `${origin}/openai/v1`, models: [model("openai-model")], hiddenModels: [],
          },
          anthropic: {
            id: "anthropic", custom: false, disabled: false,
            driver: "anthropic", baseURL: `${origin}/anthropic/v1`, models: [model("anthropic-model")], hiddenModels: [],
          },
        },
      })
      await Promise.all(Object.entries(keys).map(([id, key]) => setProviderAPIKey(id, key)))
      const handle = await startRuntime({
        backend: "native",
        managedNative: {
          searchProvider: async (request) => {
            searches.push(request.query)
            return { provider: "fixture-search", output: "bounded search evidence" }
          },
        },
      })
      handles.push(handle)
      expect(handle.capabilities.providerManagement).toBe(true)
      expect(handle.capabilities.providerOAuth).toBe(false)

      const catalog = await handle.provider!.listProviders()
      expect(catalog.connected).toEqual(expect.arrayContaining(["compat", "openai", "anthropic"]))
      expect(catalog.all.find((provider) => provider.id === "openai")?.models).toHaveProperty("gpt-openai-discovered")
      expect(await handle.provider!.discoverModels({ providerID: "anthropic" })).toContainEqual(
        expect.objectContaining({ id: "anthropic-discovered", name: "anthropic discovered" }),
      )
      await expect(handle.provider!.discoverModels({
        providerID: "openai",
        apiKey: "wrong-model-list-secret",
      })).rejects.toMatchObject({
        failure: { category: "authentication", statusCode: 401 },
      })
      expect(await handle.provider!.listProviderAuth()).toMatchObject({
        compat: [{ type: "api", label: "API Key" }],
        openai: [{ type: "api", label: "API Key" }],
        anthropic: [{ type: "api", label: "API Key" }],
      })

      const task = await workspace()
      for (const [provider, expected, expectedCost] of [
        ["compat", "compat complete", 0.000025],
        ["openai", "openai complete", 0.000019],
        ["anthropic", "anthropic complete", 0.000015],
      ] as const) {
        const conversation = await handle.agent.createConversation({ directory: task, title: `${provider} protocol` })
        const result = await conversation.prompt({
          agent: "boom",
          model: `${provider}/${provider}-model`,
          text: "Read NOTES.md, then report completion.",
        })
        expect(result.error).toBeUndefined()
        expect(result.finish).toBe("stop")
        expect(result.parts).toContainEqual({ type: "text", text: expected })
        expect(result.parts.some((part) => part.type === "tool" && part.tool === "read")).toBe(true)
        expect(result.cost).toBeCloseTo(expectedCost, 8)
        await conversation.close?.()
      }

      expect(requests.filter((request) => request.path.endsWith("/chat/completions"))).toHaveLength(2)
      expect(requests.filter((request) => request.path.endsWith("/responses"))).toHaveLength(2)
      expect(requests.filter((request) => request.path.endsWith("/messages"))).toHaveLength(2)
      expect(searches).toEqual(["Boom Native"])
      expect(JSON.stringify(requests.map((request) => request.body))).toContain("function_call_output")
      expect(JSON.stringify(requests.map((request) => request.body))).toContain("tool_result")

      const taskState = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: task, absolute: true }))
      for (const filename of taskState) {
        if ((await stat(filename)).isFile()) {
          const content = await readFile(filename, "utf8").catch(() => "")
          for (const secret of Object.values(keys)) expect(content).not.toContain(secret)
        }
      }
      for (const secret of Object.values(keys))
        expect(await readFile(providerStorePath(), "utf8")).not.toContain(secret)
      expect((await stat(credentialStorePath())).mode & 0o777).toBe(0o600)
      expect((await stat(path.dirname(credentialStorePath()))).mode & 0o777).toBe(0o700)

      await handle.provider!.removeProviderCredential("compat")
      expect(await hasProviderAPIKey("compat")).toBe(false)
      expect((await handle.provider!.listProviders()).connected).not.toContain("compat")
      const unauthenticated = await handle.agent.createConversation({ directory: task, title: "missing credential" })
      const rejected = await unauthenticated.prompt({
        agent: "boom",
        model: "compat/compat-model",
        text: "This request must fail before network access.",
      })
      expect(rejected.error).toMatchObject({ category: "authentication", retryable: false })
      await unauthenticated.close?.()
    } finally {
      for (const name of managed) {
        const previous = previousEnvironment[name]
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }
    }
  })

  test("classifies and redacts an authentication rejection", async () => {
    const secret = "credential-that-must-not-leak"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(`invalid key ${secret}`, {
        status: 401,
        headers: { "x-request-id": "rejected-request" },
      }),
    })
    servers.push(server)
    const driver = new OpenAICompatibleProviderDriver({
      baseURL: `http://${server.hostname}:${server.port}/v1`,
      apiKey: secret,
    })
    const request: NativeProviderRequest = {
      conversationID: "native-auth-test",
      step: 1,
      agent: "boom",
      model: "test",
      system: "test",
      messages: [{ role: "user", content: "test" }],
      tools: [],
      signal: new AbortController().signal,
    }
    try {
      await Array.fromAsync(driver.stream(request))
      throw new Error("expected authentication rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(NativeProviderFailure)
      const failure = (error as NativeProviderFailure).failure
      expect(failure.category).toBe("authentication")
      expect(failure.statusCode).toBe(401)
      expect(failure.requestID).toBe("rejected-request")
      expect(failure.message).not.toContain(secret)
      expect(failure.message).toContain("[redacted]")
    }
  })

  test("maps Anthropic bearer-token compatibility environment into model and message requests", async () => {
    const names = [
      "BOOM_HOME",
      "BOOM_ANTHROPIC_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
    ] as const
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    const boomHome = await mkdtemp(path.join(os.tmpdir(), "boom-anthropic-token-home-"))
    directories.push(boomHome)
    const secret = "local-bearer-token-fixture"
    const requests: Array<{ path: string; authorization: string | null; apiKey: string | null }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push({
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          apiKey: request.headers.get("x-api-key"),
        })
        if (request.headers.get("authorization") !== `Bearer ${secret}` || request.headers.has("x-api-key"))
          return new Response("unauthorized", { status: 401 })
        if (url.pathname === "/v1/models")
          return Response.json({ data: [{ id: "claude-proxy", display_name: "Claude Proxy" }] })
        if (url.pathname === "/v1/messages") return sse([
          { type: "message_start", message: { id: "proxy-request", usage: { input_tokens: 2, output_tokens: 0 } } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "proxy complete" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ])
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    process.env.BOOM_HOME = boomHome
    delete process.env.BOOM_ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_AUTH_TOKEN = secret
    process.env.ANTHROPIC_BASE_URL = `http://${server.hostname}:${server.port}`
    try {
      expect(await inspectNativeProviders()).toContainEqual(
        expect.objectContaining({ id: "anthropic", credential: true }),
      )
      const handle = await startRuntime({ backend: "native" })
      handles.push(handle)
      const catalog = await handle.provider!.listProviders()
      expect(catalog.connected).toContain("anthropic")
      expect(catalog.all.find((provider) => provider.id === "anthropic")).toMatchObject({
        baseURL: `http://${server.hostname}:${server.port}/v1`,
        models: { "claude-proxy": { name: "Claude Proxy" } },
      })
      const task = await workspace()
      const conversation = await handle.agent.createConversation({ directory: task, title: "bearer proxy" })
      const result = await conversation.prompt({
        agent: "boom",
        model: "anthropic/claude-proxy",
        text: "Return the proxy response.",
      })
      expect(result.error).toBeUndefined()
      expect(result.parts).toContainEqual({ type: "text", text: "proxy complete" })
      expect(requests.map((request) => request.path)).toEqual(expect.arrayContaining([
        "/v1/models",
        "/v1/messages",
      ]))
      expect(requests.every((request) => request.authorization === `Bearer ${secret}` && request.apiKey === null))
        .toBe(true)
      await conversation.close?.()
    } finally {
      for (const name of names) {
        const value = previous[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test("refuses to place credentials through a symlinked Boom home", async () => {
    const previousHome = process.env.BOOM_HOME
    const parent = await mkdtemp(path.join(os.tmpdir(), "boom-credential-link-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "boom-credential-outside-"))
    directories.push(parent, outside)
    const linked = path.join(parent, "boom-home")
    await symlink(outside, linked)
    process.env.BOOM_HOME = linked
    try {
      await expect(setProviderAPIKey("openai", "must-not-write"))
        .rejects.toThrow("not a real directory")
      expect(await Bun.file(path.join(outside, "credentials.json")).exists()).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previousHome
    }
  })

  test("exposes Native Driver, pricing, and real credential lifecycle through the GUI runner contract", async () => {
    const previousHome = process.env.BOOM_HOME
    const boomHome = await mkdtemp(path.join(os.tmpdir(), "boom-provider-gui-home-"))
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-provider-gui-root-"))
    directories.push(boomHome, root)
    process.env.BOOM_HOME = boomHome
    const secret = "gui-native-provider-secret"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${secret}`)
          return new Response("unauthorized", { status: 401 })
        return Response.json({ data: [{ id: "gpt-gui-discovered" }] })
      },
    })
    servers.push(server)
    const launched: RuntimeHandle[] = []
    const runner = new GuiRunner(root, async () => {
      const handle = await startRuntime({ backend: "native" })
      launched.push(handle)
      return handle
    })
    try {
      expect(await runner.discoverProviderModels({
        id: "draft-compat",
        custom: true,
        disabled: false,
        name: "Draft compatibility fixture",
        driver: "openai-compatible",
        baseURL: `http://${server.hostname}:${server.port}/v1`,
        models: [],
        hiddenModels: [],
      }, secret)).toContainEqual(expect.objectContaining({
        id: "gpt-gui-discovered",
        name: "gpt-gui-discovered",
      }))
      const saved = await runner.saveProvider({
        id: "openai",
        custom: false,
        disabled: false,
        name: "OpenAI fixture",
        driver: "openai",
        baseURL: `http://${server.hostname}:${server.port}/v1`,
        models: [model("gpt-gui")],
        hiddenModels: [],
      }, secret)
      expect(saved).toMatchObject({
        id: "openai",
        connected: true,
        driver: "openai",
        models: expect.arrayContaining([
          expect.objectContaining({ id: "gpt-gui", pricing: { input: 1, output: 2 } }),
          expect.objectContaining({ id: "gpt-gui-discovered" }),
        ]),
      })
      expect(await hasProviderAPIKey("openai")).toBe(true)
      await runner.removeProviderCredential("openai")
      expect(await hasProviderAPIKey("openai")).toBe(false)
      expect((await runner.getProviders()).find((provider) => provider.id === "openai")?.connected).toBe(false)
      expect(JSON.stringify(await runner.getProvider("openai"))).not.toContain(secret)
      expect(launched.length).toBeGreaterThanOrEqual(3)
    } finally {
      await runner.close()
      if (previousHome === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previousHome
    }
  })

})

describe("Provider transport hardening", () => {
  test("surfaces an in-stream OpenAI-compatible error instead of swallowing it (M1)", async () => {
    const driver = new OpenAICompatibleProviderDriver({
      baseURL: "https://gateway.example/v1",
      apiKey: "k",
      fetch: (async () => sse([
        { id: "req-1", choices: [{ delta: {} }] },
        { id: "req-1", error: { code: "insufficient_quota", message: "You exceeded your current quota" } },
        "[DONE]",
      ])) as unknown as typeof fetch,
    })
    const request: NativeProviderRequest = {
      conversationID: "conv", step: 1, agent: "a", model: "m",
      system: "s", messages: [], tools: [], signal: new AbortController().signal,
    }
    await expect(Array.fromAsync(driver.stream(request))).rejects.toMatchObject({
      failure: { message: "You exceeded your current quota", retryable: true },
    })
  })

  test("carries Retry-After from 429 responses into the failure (M2)", async () => {
    await expect(providerFetch({
      baseURL: "https://gateway.example/v1",
      endpoint: "chat/completions",
      fetch: (async () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } })) as unknown as typeof fetch,
    })).rejects.toMatchObject({ failure: { statusCode: 429, retryAfterMs: 7_000 } })
  })

  test("treats a truncated tail after parsed events as non-retryable (EOF double-billing guard)", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"id\":1}\r\n\r\n"))
        controller.enqueue(encoder.encode("data: {\"id\":"))
        controller.close()
      },
    })
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } })
    await expect(Array.fromAsync(serverSentEvents(response))).rejects.toMatchObject({
      failure: { category: "network", retryable: false },
    })
  })
})
