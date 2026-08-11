import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  compileOpenCodeMcpConfig,
  loadMcpStore,
  mcpStorePath,
  normalizeManagedMcpServer,
  saveMcpStore,
} from "../src/mcp-config.ts"

describe("Boom-managed MCP configuration", () => {
  test("normalizes remote and local servers and compiles OpenCode environment references", () => {
    const remote = normalizeManagedMcpServer({
      id: "github",
      name: "GitHub MCP",
      type: "remote",
      enabled: true,
      timeout: 12_000,
      agents: ["boom", "boom-worker"],
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer {env:GITHUB_TOKEN}", "X-Client": "boom" },
      oauth: false,
    })
    const local = normalizeManagedMcpServer({
      id: "filesystem",
      name: "Filesystem",
      type: "local",
      enabled: false,
      timeout: 5_000,
      agents: ["boom"],
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"],
      environment: { ACCESS_TOKEN: "SOURCE_ACCESS_TOKEN" },
    })
    const compiled = compileOpenCodeMcpConfig({
      version: 1,
      servers: { github: remote, filesystem: local },
    })
    expect(compiled.github).toMatchObject({
      type: "remote",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer {env:GITHUB_TOKEN}" },
      oauth: false,
      enabled: true,
      timeout: 12_000,
    })
    expect(compiled.filesystem).toMatchObject({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"],
      environment: { ACCESS_TOKEN: "{env:SOURCE_ACCESS_TOKEN}" },
      enabled: false,
    })
    expect(JSON.stringify(compiled)).not.toContain("SOURCE_ACCESS_TOKEN\":\"SOURCE_ACCESS_TOKEN")
  })

  test("rejects unsafe identifiers, embedded URL credentials, and literal sensitive headers", () => {
    expect(() => normalizeManagedMcpServer({
      id: "../escape",
      type: "remote",
      url: "https://example.test/mcp",
      headers: {},
    })).toThrow("Invalid MCP")
    expect(() => normalizeManagedMcpServer({
      id: "unsafe-url",
      type: "remote",
      url: "https://secret@example.test/mcp?token=leak",
      headers: {},
    })).toThrow("Invalid MCP")
    expect(() => normalizeManagedMcpServer({
      id: "literal-secret",
      type: "remote",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer actual-secret" },
    })).toThrow("Invalid MCP")
    expect(() => normalizeManagedMcpServer({
      id: "secret-field",
      type: "remote",
      url: "https://example.test/mcp",
      headers: {},
      oauth: { clientId: "client", clientSecret: "must-not-persist" },
    })).toThrow("Invalid MCP")
  })

  test("persists the MCP store atomically and refuses a symlink target", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-mcp-config-"))
    const previous = process.env.BOOM_HOME
    process.env.BOOM_HOME = directory
    try {
      const server = normalizeManagedMcpServer({
        id: "example",
        type: "remote",
        url: "https://example.test/mcp",
        headers: {},
      })
      await saveMcpStore({ version: 1, servers: { example: server } })
      expect(await loadMcpStore()).toMatchObject({
        servers: { example: { id: "example", enabled: true, agents: ["boom", "boom-worker"] } },
      })
      await rm(mcpStorePath())
      const outside = path.join(directory, "outside.json")
      await writeFile(outside, "{}")
      await symlink(outside, mcpStorePath())
      await expect(saveMcpStore({ version: 1, servers: {} })).rejects.toThrow("not a real file")
    } finally {
      if (previous === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previous
      await rm(directory, { recursive: true, force: true })
    }
  })
})
