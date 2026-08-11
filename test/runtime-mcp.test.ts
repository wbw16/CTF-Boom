import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { normalizeManagedMcpServer, saveMcpStore } from "../src/mcp-config.ts"
import { startOpenCodeRuntime } from "../src/runtime.ts"

const temporary: string[] = []
afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

test("Boom compiles and connects its managed local MCP through the isolated OpenCode runtime", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "boom-runtime-mcp-"))
  temporary.push(home)
  const previous = process.env.BOOM_HOME
  process.env.BOOM_HOME = home
  let runtime: Awaited<ReturnType<typeof startOpenCodeRuntime>> | undefined
  try {
    const fixture = path.join(import.meta.dir, "fixtures", "mcp-server.ts")
    const server = normalizeManagedMcpServer({
      id: "fixture",
      name: "Fixture",
      type: "local",
      command: [process.execPath, fixture],
      environment: {},
      enabled: true,
      timeout: 5_000,
      agents: ["boom"],
    })
    await saveMcpStore({ version: 1, servers: { fixture: server } })
    runtime = await startOpenCodeRuntime()
    expect(runtime.capabilities.mcp).toBe(true)
    expect(await runtime.mcp?.status()).toEqual({ fixture: { status: "connected" } })
    const config = JSON.parse(await readFile(path.join(home, "runtime", "boom.json"), "utf8"))
    expect(config.mcp.fixture).toMatchObject({
      type: "local",
      command: [process.execPath, fixture],
      enabled: true,
    })
    expect(await Bun.file(path.join(home, "runtime", "opencode.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(home, "runtime", "xdg-config")).exists()).toBe(false)
    expect(await Bun.file(path.join(home, "runtime", "home")).exists()).toBe(false)
    expect(await Bun.file(path.join(home, "runtime", "bin", "opencode")).exists()).toBe(false)
    expect(await readFile(path.join(home, "runtime", "agent", "boom-consultant.md"), "utf8"))
      .toContain('"fixture_*": "deny"')

    const workspace = path.join(home, "workspace")
    await mkdir(path.join(workspace, "work"), { recursive: true })
    const conversation = await runtime.agent.createConversation({
      directory: workspace,
      title: "context-resume-smoke",
    })
    expect(await conversation.activeContext?.()).toEqual([])
    const resumed = await runtime.agent.resumeConversation?.({
      directory: workspace,
      id: conversation.id,
    })
    expect(resumed?.id).toBe(conversation.id)
  } finally {
    await runtime?.close()
    if (previous === undefined) delete process.env.BOOM_HOME
    else process.env.BOOM_HOME = previous
  }
}, 20_000)
