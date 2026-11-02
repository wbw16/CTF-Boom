import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  compileOpenCodeMcpConfig,
  normalizeManagedMcpServer,
  type OpenCodeMcpConfig,
} from "../src/mcp-config.ts"
import { mcpPresets } from "../src/mcp-presets.ts"
import {
  commandLooksLikeRea,
  inspectReaSource,
  installReaSkill,
  isReaMcpServer,
  reaMcpCommand,
  reaMcpServer,
  wrapLocalReaBridge,
  REA_DEFAULT_AGENTS,
} from "../src/rea.ts"

const ROOT = path.join(import.meta.dir, "..")
const RESOURCE_ROOT = path.join(ROOT, "resources")
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

async function directory() {
  const created = await mkdtemp(path.join(os.tmpdir(), "boom-rea-"))
  temporary.push(created)
  return created
}

function localCommand(server: OpenCodeMcpConfig[string] | undefined) {
  return server?.type === "local" ? server.command : undefined
}

describe("REA MCP preset", () => {
  test("pins the npm release and defaults to the reversing roles", () => {
    expect(reaMcpCommand()).toEqual(["npx", "-y", "rea-agents@6.4.0", "mcp"])
    const server = normalizeManagedMcpServer(reaMcpServer())
    expect(server).toMatchObject({
      id: "rea",
      type: "local",
      enabled: true,
      timeout: 120_000,
      agents: [...REA_DEFAULT_AGENTS],
      command: ["npx", "-y", "rea-agents@6.4.0", "mcp"],
      environment: {},
    })
  })

  test("builds a local checkout command and wraps npx on Windows", () => {
    expect(reaMcpCommand({
      sourceDirectory: "/opt/rea",
      nodeExecutable: "/opt/node/bin/node",
    })).toEqual(["/opt/node/bin/node", path.join("/opt/rea", "scripts", "rea.mjs"), "mcp"])
    expect(reaMcpCommand({ platform: "win32" })).toEqual([
      "cmd.exe", "/d", "/c", "npx", "-y", "rea-agents@6.4.0", "mcp",
    ])
  })

  test("recognizes preset and renamed registrations without matching unrelated servers", () => {
    expect(commandLooksLikeRea(["npx", "-y", "rea-agents@6.4.0", "mcp"])).toBe(true)
    expect(commandLooksLikeRea(["node", "/src/rea/scripts/rea.mjs", "mcp"])).toBe(true)
    expect(commandLooksLikeRea(["npx", "-y", "some-other-mcp"])).toBe(false)
    expect(isReaMcpServer(normalizeManagedMcpServer(reaMcpServer()))).toBe(true)
    expect(isReaMcpServer(normalizeManagedMcpServer({
      id: "renamed",
      type: "local",
      command: ["node", "/work/rea/scripts/rea.mjs", "mcp"],
      environment: {},
    }))).toBe(true)
    expect(isReaMcpServer(normalizeManagedMcpServer({
      id: "filesystem",
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"],
      environment: {},
    }))).toBe(false)
  })

  test("exposes REA through the preset catalog", () => {
    const preset = mcpPresets().find((item) => item.id === "rea")
    expect(preset?.name).toBe("REA")
    expect(localCommand(preset?.server)).toEqual(["npx", "-y", "rea-agents@6.4.0", "mcp"])
  })
})

describe("REA source checkout", () => {
  test("validates the package identity and reports whether the MCP entrypoint is built", async () => {
    const root = await directory()
    const source = path.join(root, "rea")
    await mkdir(path.join(source, "scripts"), { recursive: true })
    await writeFile(path.join(source, "package.json"), JSON.stringify({
      name: "rea-agents",
      version: "6.4.0",
    }))
    await writeFile(path.join(source, "scripts", "rea.mjs"), "#!/usr/bin/env node\n")

    const unbuilt = await inspectReaSource(source)
    expect(unbuilt.built).toBe(false)
    expect(unbuilt.version).toBe("6.4.0")
    expect(unbuilt.entrypoint).toBe(path.join(source, "scripts", "rea.mjs"))

    await mkdir(path.join(source, "dist", "mcp"), { recursive: true })
    await writeFile(path.join(source, "dist", "mcp", "main.js"), "export {}\n")
    expect((await inspectReaSource(source)).built).toBe(true)

    const other = path.join(root, "other")
    await mkdir(other, { recursive: true })
    await writeFile(path.join(other, "package.json"), JSON.stringify({ name: "not-rea" }))
    await expect(inspectReaSource(other)).rejects.toThrow("rea-agents")
    await expect(inspectReaSource(path.join(root, "missing"))).rejects.toThrow("Not a readable REA checkout")
  })
})

describe("REA runtime bridge", () => {
  test("wraps only enabled local REA servers and stays idempotent", () => {
    const config = compileOpenCodeMcpConfig({
      version: 1,
      servers: {
        rea: normalizeManagedMcpServer(reaMcpServer()),
        renamed: normalizeManagedMcpServer({
          id: "renamed",
          type: "local",
          command: ["node", "/src/rea/scripts/rea.mjs", "mcp"],
          environment: {},
        }),
        disabled: normalizeManagedMcpServer({
          id: "disabled",
          type: "local",
          enabled: false,
          command: ["npx", "-y", "rea-agents@6.4.0", "mcp"],
          environment: {},
        }),
        filesystem: normalizeManagedMcpServer({
          id: "filesystem",
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"],
          environment: {},
        }),
      },
    })
    const options = { bunExecutable: "/bin/bun", bridgeScript: "/boom/rea-bridge.ts" }
    const wrapped = wrapLocalReaBridge(config, options)
    expect(localCommand(wrapped.rea)).toEqual([
      "/bin/bun", "/boom/rea-bridge.ts", "npx", "-y", "rea-agents@6.4.0", "mcp",
    ])
    expect(localCommand(wrapped.renamed)).toEqual([
      "/bin/bun", "/boom/rea-bridge.ts", "node", "/src/rea/scripts/rea.mjs", "mcp",
    ])
    expect(localCommand(wrapped.disabled)).toEqual(["npx", "-y", "rea-agents@6.4.0", "mcp"])
    expect(localCommand(wrapped.filesystem)).toEqual([
      "npx", "-y", "@modelcontextprotocol/server-filesystem", "/data",
    ])
    expect(wrapLocalReaBridge(wrapped, options)).toBe(wrapped)
  })

  test("installs the REA skill only while an enabled REA server exists", async () => {
    const runtime = await directory()
    const target = path.join(runtime, "skills", "reverse-engineer-anything")

    expect(await installReaSkill(RESOURCE_ROOT, runtime, [])).toBe(false)
    expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false)

    const installed = await installReaSkill(RESOURCE_ROOT, runtime, [
      normalizeManagedMcpServer(reaMcpServer()),
    ])
    expect(installed).toBe(true)
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("## Boom bridge")
    expect(await Bun.file(path.join(target, "references", "native-and-artifacts.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(target, "LICENSE")).exists()).toBe(true)

    expect(await installReaSkill(RESOURCE_ROOT, runtime, [
      normalizeManagedMcpServer({ ...reaMcpServer(), enabled: false }),
    ])).toBe(false)
    expect(await Bun.file(path.join(target, "SKILL.md")).exists()).toBe(false)
  })
})
