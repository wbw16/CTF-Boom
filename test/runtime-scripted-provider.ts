export type ScriptedToolCall = {
  id: string
  name: string
  arguments: string | string[]
}

export type ScriptedProviderUsage = {
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
}

export type ScriptedProviderTurn =
  | {
      type: "completion"
      text?: string | string[]
      reasoning?: string | string[]
      tools?: ScriptedToolCall[]
      finish?: "stop" | "length" | "tool_calls" | "content_filter"
      usage?: ScriptedProviderUsage
      delayMs?: number
      disconnectAfterChunks?: number
      waitForAbort?: boolean
    }
  | {
      type: "error"
      status: number
      message: string
      code?: string
      retryAfterMs?: number
    }

export type ScriptedProviderRequest = {
  method: string
  pathname: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

function parts(value: string | string[] | undefined) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function sse(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`
}

function delay(milliseconds: number, signal: AbortSignal) {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

/**
 * Deterministic OpenAI-compatible HTTP provider used by the shared runtime conformance suite.
 * It records sanitized request objects in memory and never makes an outbound network request.
 */
export class ScriptedProvider {
  readonly requests: ScriptedProviderRequest[] = []
  readonly abortedRequests: number[] = []
  /** Highest number of completion response streams consumed at the same time. */
  maxConcurrentRequests = 0
  #concurrentRequests = 0
  #turns: ScriptedProviderTurn[]
  #server: ReturnType<typeof Bun.serve>

  constructor(turns: ScriptedProviderTurn[]) {
    this.#turns = [...turns]
    this.#server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => this.#fetch(request),
    })
  }

  get baseURL() {
    return `http://${this.#server.hostname}:${this.#server.port}/v1`
  }

  get remaining() {
    return this.#turns.length
  }

  enqueue(...turns: ScriptedProviderTurn[]) {
    this.#turns.push(...turns)
  }

  stop() {
    this.#server.stop(true)
  }

  async #fetch(request: Request) {
    const url = new URL(request.url)
    const body = request.method === "POST"
      ? await request.json().catch(() => undefined) as Record<string, unknown> | undefined
      : undefined
    this.requests.push({
      method: request.method,
      pathname: url.pathname,
      headers: Object.fromEntries(
        [...request.headers.entries()]
          .filter(([name]) => !["authorization", "cookie", "x-api-key"].includes(name.toLowerCase()))
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      ...(body ? { body } : {}),
    })

    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "conformance", object: "model" }] })
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
      return Response.json({ error: { message: "scripted route not found" } }, { status: 404 })

    const turn = this.#turns.shift()
    if (!turn) return Response.json({ error: { message: "script exhausted" } }, { status: 500 })
    if (turn.type === "error") {
      return Response.json(
        { error: { message: turn.message, type: "scripted_error", code: turn.code ?? "scripted" } },
        {
          status: turn.status,
          headers: turn.retryAfterMs === undefined ? {} : { "retry-after-ms": String(turn.retryAfterMs) },
        },
      )
    }

    const requestIndex = this.requests.length - 1
    this.#concurrentRequests += 1
    this.maxConcurrentRequests = Math.max(this.maxConcurrentRequests, this.#concurrentRequests)
    let finished = false
    const finishRequest = () => {
      if (finished) return
      finished = true
      this.#concurrentRequests = Math.max(0, this.#concurrentRequests - 1)
    }
    request.signal.addEventListener("abort", () => this.abortedRequests.push(requestIndex), { once: true })
    const encoder = new TextEncoder()
    const id = `chatcmpl-script-${requestIndex + 1}`
    const created = 1_700_000_000
    const model = typeof body?.model === "string" ? body.model : "conformance"
    const chunks: unknown[] = [{
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }]
    for (const text of parts(turn.reasoning)) {
      chunks.push({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
      })
    }
    for (const text of parts(turn.text)) {
      chunks.push({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      })
    }
    for (const [toolIndex, tool] of (turn.tools ?? []).entries()) {
      const fragments = parts(tool.arguments)
      for (const [fragmentIndex, fragment] of fragments.entries()) {
        chunks.push({
          id, object: "chat.completion.chunk", created, model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolIndex,
                ...(fragmentIndex === 0 ? { id: tool.id, type: "function" } : {}),
                function: {
                  ...(fragmentIndex === 0 ? { name: tool.name } : {}),
                  arguments: fragment,
                },
              }],
            },
            finish_reason: null,
          }],
        })
      }
    }
    const finish = turn.finish ?? (turn.tools?.length ? "tool_calls" : "stop")
    chunks.push({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    })
    if (turn.usage) {
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: turn.usage.input,
          completion_tokens: turn.usage.output,
          total_tokens: turn.usage.input + turn.usage.output,
          prompt_tokens_details: { cached_tokens: turn.usage.cacheRead ?? 0 },
          completion_tokens_details: { reasoning_tokens: turn.usage.reasoning ?? 0 },
        },
      })
    }

    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          for (const chunk of chunks) {
            if (request.signal.aborted) return controller.close()
            await delay(turn.delayMs ?? 0, request.signal)
            if (request.signal.aborted) return controller.close()
            controller.enqueue(encoder.encode(sse(chunk)))
            sent += 1
            if (turn.disconnectAfterChunks === sent) {
              controller.error(new Error("scripted disconnect"))
              return
            }
          }
          if (turn.waitForAbort) {
            if (!request.signal.aborted)
              await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }))
            return controller.close()
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        } catch (error) {
          controller.error(error)
        } finally {
          finishRequest()
        }
      },
      cancel: () => {
        this.abortedRequests.push(requestIndex)
        finishRequest()
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }
}
