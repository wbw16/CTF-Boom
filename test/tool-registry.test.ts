import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  loadBoomToolRegistry,
  parseBoomToolRegistry,
  validateBoomToolArguments,
} from "../src/runtime/tool-registry.ts"

const RESOURCE_ROOT = path.join(import.meta.dir, "..", "resources")

async function source(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    path.join(RESOURCE_ROOT, "runtime", "tool-profiles.json"),
    "utf8",
  ))
}

describe("M3 Boom Tool Registry", () => {
  test("owns immutable descriptions, implementation provenance, schemas, and profiles", async () => {
    const registry = await loadBoomToolRegistry(RESOURCE_ROOT)
    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(registry.tools["ctf-submit"]?.schema)).toBe(true)
    expect(Object.entries(registry.tools)
      .filter(([, tool]) => tool.implementation === "boom")
      .map(([name]) => name)).toEqual([
        "bash", "read", "edit", "list", "glob", "grep", "skill", "websearch", "webfetch", "todowrite",
        "boom-exec", "ctf-note", "ctf-consult", "ctf-submit",
      ])
    expect(registry.tools["ctf-submit"]).toEqual(expect.objectContaining({
      implementation: "boom",
      sideEffect: "write",
      description: expect.stringContaining("candidate"),
    }))
    expect(registry.profiles.solver?.tools.every((name) => !!registry.tools[name])).toBe(true)
  })

  test("rejects incomplete definitions and profile references", async () => {
    const missingDescription = await source()
    delete ((missingDescription.tools as Record<string, Record<string, unknown>>).read).description
    expect(() => parseBoomToolRegistry(missingDescription)).toThrow("Invalid Boom tool descriptor: read")

    const placeholderBoomSchema = await source()
    ;((placeholderBoomSchema.tools as Record<string, Record<string, unknown>>)["ctf-note"]).schema = {
      source: "runtime",
      version: 1,
    }
    expect(() => parseBoomToolRegistry(placeholderBoomSchema)).toThrow(
      "Boom tool schema must be an object contract: ctf-note",
    )

    const unknownProfileTool = await source()
    ;((unknownProfileTool.profiles as Record<string, { tools: string[] }>).solver).tools.push("missing")
    expect(() => parseBoomToolRegistry(unknownProfileTool)).toThrow("Invalid Boom tool profile: solver")
  })

  test("uses the public schema as the provider-argument boundary", async () => {
    const registry = await loadBoomToolRegistry(RESOURCE_ROOT)
    expect(validateBoomToolArguments(registry, "ctf-submit", { candidate: "flag{ok}" }))
      .toBe(registry.tools["ctf-submit"])
    expect(() => validateBoomToolArguments(registry, "ctf-submit", { candidate: "" }))
      .toThrow("minimum length is 1")
    expect(() => validateBoomToolArguments(registry, "ctf-submit", { candidate: "flag{x}", note: "extra" }))
      .toThrow("unknown property")
    expect(() => validateBoomToolArguments(registry, "missing", {})).toThrow("Unknown Boom tool")
  })
})
