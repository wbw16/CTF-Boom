import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import BoomBridgePlugin from "../resources/plugin/boom-bridge.ts"
import { compileBoomAgentRegistry } from "../src/runtime/agent.ts"
import { startBoomToolBridge } from "../src/runtime/tool-bridge.ts"
import {
  addFlagSubmission,
  addObservation,
  confirmFlagSubmission,
  createEngagement,
  engagementDirectory,
  rejectFlagSubmission,
} from "../src/pentest/store.ts"

const RESOURCE_ROOT = path.join(import.meta.dir, "..", "resources")
const temporary: string[] = []

afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-tool-bridge-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "input"))
  await mkdir(path.join(directory, "work"))
  await writeFile(path.join(directory, "input", "evidence.txt"), "bridge evidence\n")
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
        arguments: { filePath: "input/evidence.txt" },
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
      const plugin = await BoomBridgePlugin({ worktree: directory } as never)
      expect(Object.keys(plugin.tool ?? {})).toEqual([
        "bash", "read", "edit", "list", "glob", "grep", "skill", "websearch",
        "webfetch", "todowrite", "boom-exec", "ctf-note", "ctf-consult", "ctf-submit",
        "pentest-note", "pentest-asset", "pentest-observation", "pentest-evidence", "pentest-finding",
        "pentest-flag",
      ])
      expect(Object.keys(plugin.tool?.read?.args ?? {})).toEqual(["filePath", "offset", "limit"])
      const result = await plugin.tool!.read!.execute(
        { filePath: "input/evidence.txt" },
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

  test("guards Flag delegation, assigns worker output, and injects changed shared progress once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-flag-bridge-"))
    temporary.push(root)
    const engagement = await createEngagement(root, {
      target: "10.10.10.5",
      objective: "获取 Redis 与 MySQL Flag",
      authorization: "授权 #42",
      scope: ["10.10.10.5"],
      mode: "flag-hunt",
      flags: [{ label: "Redis" }, { label: "MySQL" }],
    })
    const directory = await engagementDirectory(root, engagement.slug)
    const bridge = startBoomToolBridge(await compileBoomAgentRegistry(RESOURCE_ROOT))
    const previousURL = process.env.BOOM_TOOL_BRIDGE_URL
    const previousToken = process.env.BOOM_TOOL_BRIDGE_TOKEN
    process.env.BOOM_TOOL_BRIDGE_URL = bridge.url
    process.env.BOOM_TOOL_BRIDGE_TOKEN = bridge.token
    try {
      // OpenCode reports the project worktree, which is "/" for an engagement that is not a git
      // repository; the plugin must resolve the engagement from the session instead.
      const plugin = await BoomBridgePlugin({
        worktree: "/",
        client: {
          session: {
            get: async ({ path }: { path: { id: string } }) => ({
              data: { directory: path.id === "stranger-session" ? "/tmp/stranger" : directory },
            }),
          },
        },
      } as never)
      await plugin["chat.message"]?.({
        sessionID: "main-session",
        agent: "boom-flag-hunt",
      } as never, {} as never)

      const initial = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]?.({
        sessionID: "main-session",
        model: {},
      } as never, initial)
      expect(initial.system.join("\n")).toContain("flag-1 [open]")

      const unchanged = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]?.({
        sessionID: "main-session",
        model: {},
      } as never, unchanged)
      expect(unchanged.system).toEqual([])

      // A live worker session receives the same host-owned progress before its next model call.
      await plugin["chat.message"]?.({
        sessionID: "worker-session",
        agent: "boom-pentest-worker",
      } as never, {} as never)
      const workerInitial = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]?.({
        sessionID: "worker-session",
        model: {},
      } as never, workerInitial)
      expect(workerInitial.system.join("\n")).toContain("flag-2 [open]")

      const output = { args: {
        subagent_type: "boom-pentest-worker",
        description: "solve Redis",
        prompt: "负责 Redis 路径，目标是 flag-1。",
      } }
      await plugin["tool.execute.before"]?.({
        tool: "task",
        sessionID: "main-session",
        callID: "call/redis",
      }, output)
      expect(output.args.prompt).toContain("work/workers/call-redis")
      await access(path.join(directory, "work", "workers", "call-redis"))

      await expect(plugin["tool.execute.before"]?.({
        tool: "task",
        sessionID: "main-session",
        callID: "call-wrong",
      }, { args: { subagent_type: "boom-worker", prompt: "wrong" } })).rejects.toThrow(
        "only to boom-pentest-worker",
      )

      // A session that is not inside a task directory cannot receive a worker contract.
      await plugin["chat.message"]?.({
        sessionID: "stranger-session",
        agent: "boom-flag-hunt",
      } as never, {} as never)
      await expect(plugin["tool.execute.before"]?.({
        tool: "task",
        sessionID: "stranger-session",
        callID: "call-stranger",
      }, { args: { subagent_type: "boom-pentest-worker", prompt: "stranger" } })).rejects.toThrow(
        "engagement workspace",
      )

      const candidate = await addFlagSubmission(root, engagement.slug, {
        flagId: "flag-1",
        value: "flag{redis}",
        note: "MySQL 账号见 work/workers/call-redis/access.md",
      })
      const changed = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]?.({
        sessionID: "main-session",
        model: {},
      } as never, changed)
      expect(changed.system.join("\n")).toContain("flag-1 [candidate]")
      expect(changed.system.join("\n")).toContain("work/workers/call-redis/access.md")

      const workerChanged = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]?.({
        sessionID: "worker-session",
        model: {},
      } as never, workerChanged)
      expect(workerChanged.system.join("\n")).toContain("flag-1 [candidate]")

      // Non-Flag activity is not progress: it must not re-inject an identical update.
      await addObservation(root, engagement.slug, { kind: "port", target: "10.10.10.5", detail: "tcp/6379 open" })
      const quiet = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]?.({
        sessionID: "main-session",
        model: {},
      } as never, quiet)
      expect(quiet.system).toEqual([])

      await confirmFlagSubmission(root, engagement.slug, "flag-1", candidate.id, "平台确认")
      const confirmed = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]?.({
        sessionID: "main-session",
        model: {},
      } as never, confirmed)
      expect(confirmed.system.join("\n")).toContain("flag-1 [confirmed]")
      expect(confirmed.system.join("\n")).toContain("operator note: 平台确认")

      // A rejection reopens the objective and reaches both sessions as a distinct state.
      const second = await addFlagSubmission(root, engagement.slug, { flagId: "flag-2", value: "flag{mysql}" })
      await rejectFlagSubmission(root, engagement.slug, "flag-2", second.id, "平台驳回")
      const rejected = { system: [] as string[] }
      await plugin["experimental.chat.system.transform"]?.({
        sessionID: "worker-session",
        model: {},
      } as never, rejected)
      expect(rejected.system.join("\n")).toContain("flag-2 [rejected (open for another candidate)]")
      expect(rejected.system.join("\n")).toContain("operator note: 平台驳回")
    } finally {
      if (previousURL === undefined) delete process.env.BOOM_TOOL_BRIDGE_URL
      else process.env.BOOM_TOOL_BRIDGE_URL = previousURL
      if (previousToken === undefined) delete process.env.BOOM_TOOL_BRIDGE_TOKEN
      else process.env.BOOM_TOOL_BRIDGE_TOKEN = previousToken
      bridge.close()
    }
  })
})
