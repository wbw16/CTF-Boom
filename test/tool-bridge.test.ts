import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import BoomBridgePlugin from "../resources/plugin/boom-bridge.ts"
import { compileBoomAgentRegistry } from "../src/runtime/agent.ts"
import { startBoomToolBridge } from "../src/runtime/tool-bridge.ts"

const RESOURCE_ROOT = path.join(import.meta.dir, "..", "resources")
const temporary: string[] = []

afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-tool-bridge-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "challenge"))
  await mkdir(path.join(directory, "work"))
  await writeFile(path.join(directory, "challenge", "evidence.txt"), "bridge evidence\n")
  await writeFile(path.join(directory, "work", "analysis.txt"), "old\n")
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n")
  return directory
}

describe("M3 OpenCode thin tool bridge", () => {
  test("serves the frozen registry and enforces agent profiles in the parent Tool Host", async () => {
    const directory = await workspace()
    const bridge = startBoomToolBridge(await compileBoomAgentRegistry(RESOURCE_ROOT))
    try {
      expect((await fetch(`${bridge.url}/registry`)).status).toBe(401)
      const registry = await fetch(`${bridge.url}/registry`, {
        headers: { Authorization: `Bearer ${bridge.token}` },
      })
      expect(registry.status).toBe(200)
      expect((await registry.json() as { tools: Record<string, { implementation: string }> }).tools.read?.implementation)
        .toBe("boom")

      const execute = (body: Record<string, unknown>) => fetch(`${bridge.url}/execute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
      const read = await execute({
        name: "read",
        arguments: { filePath: "challenge/evidence.txt" },
        directory,
        agent: "boom",
        sessionID: "bridge-session",
      })
      expect(read.status).toBe(200)
      expect(JSON.stringify(await read.json())).toContain("bridge evidence")

      const denied = await execute({
        name: "edit",
        arguments: { filePath: "work/analysis.txt", oldString: "old", newString: "new" },
        directory,
        agent: "boom-consultant",
        sessionID: "bridge-verifier",
      })
      expect(denied.status).toBe(400)
      expect(JSON.stringify(await denied.json())).toContain("Boom policy denied edit")
    } finally {
      bridge.close()
    }
  })

  test("derives OpenCode Zod definitions from the parent registry and delegates execution", async () => {
    const directory = await workspace()
    const bridge = startBoomToolBridge(await compileBoomAgentRegistry(RESOURCE_ROOT))
    const previousURL = process.env.BOOM_TOOL_BRIDGE_URL
    const previousToken = process.env.BOOM_TOOL_BRIDGE_TOKEN
    process.env.BOOM_TOOL_BRIDGE_URL = bridge.url
    process.env.BOOM_TOOL_BRIDGE_TOKEN = bridge.token
    try {
      const plugin = await BoomBridgePlugin({} as never)
      expect(Object.keys(plugin.tool ?? {})).toEqual([
        "bash", "read", "edit", "list", "glob", "grep", "skill", "websearch",
        "webfetch", "todowrite", "boom-exec", "ctf-note", "ctf-consult", "ctf-submit",
      ])
      expect(Object.keys(plugin.tool?.read?.args ?? {})).toEqual(["filePath", "offset", "limit"])
      const result = await plugin.tool!.read!.execute(
        { filePath: "challenge/evidence.txt" },
        {
          directory,
          worktree: path.dirname(directory),
          sessionID: "plugin-bridge-session",
          messageID: "message-1",
          agent: "boom",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        },
      )
      expect(typeof result === "string" ? result : result.output).toContain("bridge evidence")
    } finally {
      if (previousURL === undefined) delete process.env.BOOM_TOOL_BRIDGE_URL
      else process.env.BOOM_TOOL_BRIDGE_URL = previousURL
      if (previousToken === undefined) delete process.env.BOOM_TOOL_BRIDGE_TOKEN
      else process.env.BOOM_TOOL_BRIDGE_TOKEN = previousToken
      bridge.close()
    }
  })
})
