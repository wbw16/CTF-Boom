import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import BoomBridgePlugin from "../resources/plugin/boom-bridge.ts"
import { loadCandidateSubmission } from "../src/candidate-submission.ts"
import { loadConsultationRequest } from "../src/consultation-request.ts"
import { compileBoomAgentRegistry } from "../src/runtime/agent.ts"
import { loadBoomToolRegistry } from "../src/runtime/tool-registry.ts"
import { createBoomToolHost } from "../src/tool-runtime.ts"

const RESOURCE_ROOT = path.join(import.meta.dir, "..", "resources")
const temporary: string[] = []
afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

describe("Boom-native tool host", () => {
  test("does not inject provider-specific output token parameters", async () => {
    const hooks = await BoomBridgePlugin({ directory: "/tmp" } as never)
    expect(hooks["chat.params"]).toBeUndefined()
  })

  test("keeps OpenCode's native discovery and shell tools available", async () => {
    const registry = await compileBoomAgentRegistry(RESOURCE_ROOT)
    for (const id of ["boom", "boom-worker", "boom-consultant"]) {
      const agent = registry.agents.find((item) => item.resource.id === id)!
      const source = agent.openCodeMarkdown
      expect(source).not.toContain('"**/runs/**": allow')
      expect(source).toContain('  "*": "allow"')
      expect(agent.profile.tools).toContain("glob")
      expect(agent.profile.tools).toContain("grep")
      expect(agent.profile.tools).toContain("list")
      expect(source).toContain('  external_directory: "deny"')
    }
  })

  test("exposes portable tool names and maintains durable notes without a plugin SDK", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-tool-runtime-"))
    temporary.push(directory)
    await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n")
    const host = createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT))
    expect(host.names).toEqual([
      "bash", "read", "edit", "list", "glob", "grep", "skill", "websearch",
      "webfetch", "todowrite", "boom-exec", "ctf-note", "ctf-consult", "ctf-submit",
      "pentest-note", "pentest-asset", "pentest-observation", "pentest-evidence", "pentest-finding",
      "pentest-flag",
    ])
    expect(host.definitions["ctf-note"].schema).toEqual(expect.objectContaining({
      required: ["kind", "text"],
    }))
    const result = await host.execute({
      name: "ctf-note",
      arguments: { kind: "ruled-out", text: "H1 contradicted by work/evidence.txt" },
      directory,
      profileID: "solver",
    })
    expect(result.title).toBe("ruled-out -> NOTES.md")
    expect(await readFile(path.join(directory, "NOTES.md"), "utf8")).toContain(
      "H1 contradicted by work/evidence.txt",
    )
    const checkpoint = await host.execute({
      name: "ctf-note",
      arguments: { kind: "checkpoint", text: "## Current goal\n\nContinue from work/evidence.txt" },
      directory,
      profileID: "solver",
    })
    expect(checkpoint.title).toBe("checkpoint -> NOTES.md")
    const replaced = await readFile(path.join(directory, "NOTES.md"), "utf8")
    expect(replaced).toContain("Continue from work/evidence.txt")
    expect(replaced).not.toContain("H1 contradicted")
  })

  test("stores a session-scoped proactive consultation request", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-tool-consult-"))
    temporary.push(directory)
    await mkdir(path.join(directory, "work"))
    const host = createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT))

    const result = await host.execute({
      name: "ctf-consult",
      arguments: { reason: "Repeated parser variations do not distinguish the two remaining hypotheses." },
      directory,
      profileID: "solver",
      sessionID: "session-consult-1",
    })

    expect(result.title).toBe("multi-model consultation requested")
    expect(await loadConsultationRequest(directory)).toMatchObject({
      version: 1,
      status: "ready",
      sessionID: "session-consult-1",
      reason: "Repeated parser variations do not distinguish the two remaining hypotheses.",
    })
    await expect(host.execute({
      name: "ctf-consult",
      arguments: { reason: "try another model" },
      directory,
      profileID: "worker",
      sessionID: "worker-1",
    })).rejects.toThrow("denied")
  })

  test("stores one session-scoped candidate in Boom's structured submission slot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-tool-submit-"))
    temporary.push(directory)
    await mkdir(path.join(directory, "work"))
    const host = createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT))

    const result = await host.execute({
      name: "ctf-submit",
      arguments: {
        candidate: "flag{structured}",
      },
      directory,
      profileID: "solver",
      sessionID: "session-submit-1",
    })

    expect(result.title).toBe("candidate recorded")
    expect(await loadCandidateSubmission(directory)).toMatchObject({
      version: 1,
      status: "ready",
      sessionID: "session-submit-1",
      flag: "flag{structured}",
    })
    expect(await loadCandidateSubmission(directory)).not.toHaveProperty("verification")
    expect(JSON.parse(await readFile(path.join(directory, "work", "RESULT.json"), "utf8"))).toMatchObject({
      flag: "flag{structured}",
      status: "ready",
    })
  })

  test("rejects provider arguments through the registry schema before dispatch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-tool-schema-"))
    temporary.push(directory)
    const host = createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT))

    await expect(host.execute({
      name: "ctf-note",
      arguments: { kind: "note", text: "evidence", extra: true },
      directory,
      profileID: "solver",
    })).rejects.toThrow("unknown property")
    await expect(host.execute({
      name: "boom-exec",
      arguments: { program: "python", timeoutMs: 300_001 },
      directory,
      profileID: "solver",
    })).rejects.toThrow("maximum is 300000")
    await expect(host.execute({
      name: "ctf-submit",
      arguments: {},
      directory,
      profileID: "solver",
      sessionID: "session-submit-invalid",
    })).rejects.toThrow("required value is missing")
  })
})
