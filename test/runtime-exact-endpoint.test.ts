import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { saveProviderStore } from "../src/provider-config.ts"
import { startOpenCodeRuntime } from "../src/runtime.ts"

const directories: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("routes an OpenCode solver request through the complete-endpoint compatibility proxy", async () => {
  const previousHome = process.env.BOOM_HOME
  const home = await mkdtemp(path.join(os.tmpdir(), "boom-exact-runtime-"))
  const workspace = path.join(home, "workspace")
  directories.push(home)
  const paths: string[] = []
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      paths.push(url.pathname)
      if (request.method !== "POST" || url.pathname !== "/competition-gateway")
        return new Response("not found", { status: 404 })
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "gateway root reached" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } })
    },
  })
  servers.push(gateway)
  process.env.BOOM_HOME = home
  let runtime: Awaited<ReturnType<typeof startOpenCodeRuntime>> | undefined
  try {
    await saveProviderStore({
      version: 1,
      armorPrompts: [],
      providers: {
        gateway: {
          id: "gateway",
          custom: true,
          disabled: false,
          name: "Competition gateway fixture",
          driver: "openai-compatible",
          baseURL: `http://127.0.0.1:${gateway.port}/competition-gateway!`,
          models: [{
            id: "gateway-model",
            name: "Gateway model",
            context: 300_000,
            output: 16_384,
            reasoning: true,
            attachment: false,
          }],
          hiddenModels: [],
        },
      },
    })
    await mkdir(path.join(workspace, "work"), { recursive: true })
    await writeFile(path.join(workspace, "NOTES.md"), "# NOTES\n")

    runtime = await startOpenCodeRuntime()
    const config = await Bun.file(path.join(home, "runtime", "boom.json")).text()
    expect(config).toContain("/providers/gateway/v1")
    expect(config).not.toContain("/competition-gateway!")

    const conversation = await runtime.agent.createConversation({ directory: workspace, title: "gateway proxy" })
    const result = await conversation.prompt({
      agent: "boom",
      model: "gateway/gateway-model",
      text: "Reply with the gateway result.",
    })

    expect(result.error).toBeUndefined()
    expect(result.parts).toContainEqual({ type: "text", text: "gateway root reached" })
    expect(paths).toEqual(["/competition-gateway"])
    await conversation.close?.()
  } finally {
    await runtime?.close()
    if (previousHome === undefined) delete process.env.BOOM_HOME
    else process.env.BOOM_HOME = previousHome
  }
}, 30_000)
