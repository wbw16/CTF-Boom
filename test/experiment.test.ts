import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fingerprintInput, normalizeExperiment } from "../src/experiment.ts"
import { prepareWorkspace } from "../src/workspace.ts"

test("independent trials hash the same handout without reading host answers or analysis", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-experiment-"))
  try {
    const source = path.join(root, "challenges", "alpha")
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, "data.bin"), new Uint8Array([1, 0, 2]))
    const challenge = { slug: "alpha", directory: source, description: "Decode", files: ["data.bin"], flagFormat: "" }
    const a = await prepareWorkspace(root, challenge, "task")
    const b = await prepareWorkspace(root, challenge, "task")
    expect(a.runID).not.toBe(b.runID)
    const before = await fingerprintInput(a.directory)
    expect(await fingerprintInput(b.directory)).toBe(before)
    await writeFile(path.join(root, "answers.json"), JSON.stringify({ alpha: "secret-host-answer" }))
    await writeFile(path.join(a.directory, "work", "scratch.txt"), "new work")
    expect(await fingerprintInput(a.directory)).toBe(before)
    const c = await prepareWorkspace(root, { ...challenge, description: "Changed statement" }, "task")
    expect(await fingerprintInput(c.directory)).not.toBe(before)
    await symlink(path.join(root, "answers.json"), path.join(a.directory, "input", "injected"))
    await expect(fingerprintInput(a.directory)).rejects.toThrow("symbolic links")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("experiment labels and independent trial numbers are validated", () => {
  expect(normalizeExperiment({ label: "baseline-v1", trial: 3 })).toEqual({ label: "baseline-v1", trial: 3 })
  expect(() => normalizeExperiment({ label: "../invalid", trial: 1 })).toThrow()
  expect(() => normalizeExperiment({ label: "baseline", trial: 1.5 })).toThrow()
})
