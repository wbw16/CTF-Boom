import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  compileBoomAgentRegistry,
  installOpenCodeAgentResources,
} from "../src/runtime/agent.ts"
import {
  createPromptBundle,
  orderedPromptSections,
  stablePromptPrefix,
} from "../src/runtime/prompt.ts"

const RESOURCE_ROOT = path.join(import.meta.dir, "..", "resources")
const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe("M2 neutral prompt compiler", () => {
  test("orders layers, records provenance, and isolates the stable cache prefix", () => {
    const bundle = createPromptBundle({
      turn: [{ source: "turn:user", content: "solve this task", stability: "turn", cacheable: false, sensitivity: "task" }],
      identity: [{ source: "identity", content: "Boom identity", stability: "stable", cacheable: true, sensitivity: "public" }],
      environment: [{ source: "environment", content: "workspace=/task", stability: "task", cacheable: false, sensitivity: "task" }],
      policy: [{ source: "policy", content: "Immutable policy", stability: "stable", cacheable: true, sensitivity: "public" }],
    })

    expect(orderedPromptSections(bundle).map((section) => section.layer)).toEqual([
      "policy", "identity", "environment", "turn",
    ])
    expect(orderedPromptSections(bundle).every((section) => /^[a-f0-9]{64}$/.test(section.contentHash))).toBe(true)
    expect(bundle.promptVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(stablePromptPrefix(bundle)).toBe("Immutable policy\n\nBoom identity")
    expect(stablePromptPrefix(bundle)).not.toContain("/task")
    expect(stablePromptPrefix(bundle)).not.toContain("solve this task")
  })

  test("rejects cacheable task or secret sections", () => {
    expect(() => createPromptBundle({
      memory: [{ source: "memory", content: "task state", stability: "task", cacheable: true, sensitivity: "task" }],
    })).toThrow("Only stable prompt sections may be cacheable")
    expect(() => createPromptBundle({
      armor: [{ source: "secret", content: "credential", stability: "stable", cacheable: true, sensitivity: "secret" }],
    })).toThrow("Secret prompt sections may not be cacheable")
  })
})

describe("M2 neutral agent registry", () => {
  test("compiles every role from Boom resources with stable tool profiles", async () => {
    const registry = await compileBoomAgentRegistry(RESOURCE_ROOT)
    expect(registry.agents.map((agent) => agent.resource.id)).toEqual([
      "boom",
      "boom-consultant",
      "boom-worker",
      "boom-worker-pro",
    ])
    expect(registry.promptVersion).toMatch(/^[a-f0-9]{64}$/)

    const solver = registry.agents.find((agent) => agent.resource.id === "boom")!
    const worker = registry.agents.find((agent) => agent.resource.id === "boom-worker")!
    const strongWorker = registry.agents.find((agent) => agent.resource.id === "boom-worker-pro")!
    const consultant = registry.agents.find((agent) => agent.resource.id === "boom-consultant")!
    for (const agent of [solver, worker, strongWorker]) {
      for (const tool of ["bash", "read", "edit", "write", "list", "glob", "grep", "task", "skill", "websearch", "webfetch", "boom-exec", "ctf-note", "ctf-submit"])
        expect(agent.profile.tools).toContain(tool)
    }
    expect(consultant.profile.tools).toEqual(["read", "list", "glob", "grep"])
    expect(solver.profile.tools).toContain("ctf-consult")
    expect(worker.profile.tools).not.toContain("ctf-consult")
    expect(strongWorker.profile.tools).not.toContain("ctf-consult")
    expect(consultant.profile.tools).not.toContain("ctf-consult")
    expect(solver.openCodeMarkdown).toContain("Generated from resources/runtime")
    expect(solver.openCodeMarkdown).toContain('"challenge/**": "deny"')
    expect(solver.openCodeMarkdown).toContain("You are Boom. The current workspace contains one CTF challenge.")
    expect(consultant.openCodeMarkdown).toContain("Boom tool profile: reasoning.")
    expect(worker.resource.model).toBe("economy")
    expect(strongWorker.resource.model).toBe("strong")
    expect(solver.resource.model).toBeUndefined()
    expect(consultant.resource.model).toBeUndefined()
  })

  test("stamps declared agent tiers into the OpenCode frontmatter from the current model policy", async () => {
    const models = { economy: "free/deepseek-v4-flash-free", strong: "mimo/mimo-v2.5-pro" }
    const registry = await compileBoomAgentRegistry(RESOURCE_ROOT, [], models)
    const solver = registry.agents.find((agent) => agent.resource.id === "boom")!
    const worker = registry.agents.find((agent) => agent.resource.id === "boom-worker")!
    const strongWorker = registry.agents.find((agent) => agent.resource.id === "boom-worker-pro")!
    const consultant = registry.agents.find((agent) => agent.resource.id === "boom-consultant")!
    expect(worker.openCodeMarkdown).toContain(`model: "${models.economy}"`)
    expect(strongWorker.openCodeMarkdown).toContain(`model: "${models.strong}"`)
    // Host-selected roles must inherit the per-turn model, not a baked tier.
    for (const markdown of [solver.openCodeMarkdown, consultant.openCodeMarkdown]) {
      expect(markdown).not.toContain('model: "')
    }

    const unstamped = await compileBoomAgentRegistry(RESOURCE_ROOT)
    expect(unstamped.agents.find((agent) => agent.resource.id === "boom-worker")!.openCodeMarkdown)
      .not.toContain('model: "')
    // The resolved tier models participate in the prompt provenance hash.
    expect(registry.promptVersion).not.toBe(unstamped.promptVersion)
  })

  test("keeps the C19 tool catalog and Boom-owned schemas snapshot-stable", async () => {
    const { catalog } = await compileBoomAgentRegistry(RESOURCE_ROOT)
    expect(Object.entries(catalog.tools).map(([id, tool]) => [id, tool.implementation, tool.sideEffect])).toEqual([
      ["bash", "boom", "process"],
      ["read", "boom", "read"],
      ["edit", "boom", "write"],
      ["write", "compatibility", "write"],
      ["list", "boom", "read"],
      ["glob", "boom", "read"],
      ["grep", "boom", "read"],
      ["task", "runtime", "process"],
      ["skill", "boom", "read"],
      ["websearch", "boom", "network"],
      ["webfetch", "boom", "network"],
      ["todowrite", "boom", "memory"],
      ["boom-exec", "boom", "process"],
      ["ctf-note", "boom", "memory"],
      ["ctf-consult", "boom", "memory"],
      ["ctf-submit", "boom", "write"],
    ])
    expect(catalog.tools["ctf-note"]?.schema).toEqual(expect.objectContaining({
      required: ["kind", "text"],
      properties: expect.objectContaining({ kind: { enum: ["note", "ruled-out", "checkpoint"] } }),
    }))
    expect(catalog.tools["ctf-submit"]?.schema).toEqual(expect.objectContaining({
      required: ["candidate"],
      properties: { candidate: { type: "string", minLength: 1, maxLength: 4096 } },
    }))
    expect(catalog.tools["ctf-consult"]?.schema).toEqual(expect.objectContaining({
      required: ["reason"],
      properties: { reason: { type: "string", minLength: 1, maxLength: 2000 } },
    }))
    expect(catalog.tools.read?.schema).toEqual(expect.objectContaining({
      required: ["filePath"],
      additionalProperties: false,
    }))
    expect(catalog.tools.edit?.schema).toEqual(expect.objectContaining({
      required: ["filePath", "oldString", "newString"],
      additionalProperties: false,
    }))
  })

  test("installs generated OpenCode agents and a prompt provenance manifest", async () => {
    const target = await mkdtemp(path.join(os.tmpdir(), "boom-m2-agents-"))
    temporary.push(target)
    const registry = await installOpenCodeAgentResources(RESOURCE_ROOT, target)
    const generated = await readFile(path.join(target, "agent", "boom.md"), "utf8")
    const manifest = JSON.parse(await readFile(path.join(target, "boom-agent-manifest.json"), "utf8"))

    expect(generated).toBe(registry.agents.find((agent) => agent.resource.id === "boom")!.openCodeMarkdown)
    expect(manifest).toMatchObject({
      version: 1,
      promptVersion: registry.promptVersion,
      agents: expect.arrayContaining([
        expect.objectContaining({ id: "boom", role: "solver", toolProfile: "solver" }),
        expect.objectContaining({ id: "boom-consultant", role: "consultant", toolProfile: "reasoning" }),
      ]),
    })
  })

  test("limits OpenCode MCP tools to the Boom roles selected by the managed server", async () => {
    const registry = await compileBoomAgentRegistry(RESOURCE_ROOT, [{
      id: "github",
      name: "GitHub",
      type: "remote",
      url: "https://example.test/mcp",
      headers: {},
      oauth: false,
      enabled: true,
      timeout: 5_000,
      agents: ["boom", "boom-worker"],
    }])
    const solver = registry.agents.find((agent) => agent.resource.id === "boom")!
    const consultant = registry.agents.find((agent) => agent.resource.id === "boom-consultant")!
    expect(solver.openCodeMarkdown).not.toContain('github_*: "deny"')
    expect(consultant.openCodeMarkdown).toContain('"github_*": "deny"')
  })
})
