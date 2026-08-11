import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Challenge } from "../src/challenge.ts"
import { prepareWorkspace, runID } from "../src/workspace.ts"

describe("run workspace", () => {
  test("creates an isolated workspace without leaking a known answer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-"))
    const source = path.join(root, "source")
    await mkdir(source)
    await Bun.write(path.join(source, "encoded.txt"), "ZmxhZ3t0ZXN0fQ==\n")

    const challenge: Challenge = {
      slug: "warmup",
      category: "CRYPTO",
      difficulty: "Easy",
      serviceRequired: true,
      directory: source,
      description: "Decode it",
      files: ["encoded.txt"],
      flagFormat: "flag\\{[^}]*\\}",
    }
    const workspace = await prepareWorkspace(root, challenge, "free/test")
    const metadata = await Bun.file(path.join(workspace.directory, "challenge", "challenge.json")).json()

    expect(metadata.flag).toBeUndefined()
    expect(metadata.flag_format).toBe(challenge.flagFormat)
    expect(metadata.category).toBe("CRYPTO")
    expect(metadata.difficulty).toBe("Easy")
    expect(metadata.service_required).toBe(true)
    const notes = await Bun.file(path.join(workspace.directory, "NOTES.md")).text()
    expect(notes).toContain("跨轮次、跨模型共享")
    expect(notes).toContain("## 下一步计划")
    expect(await Bun.file(path.join(workspace.directory, "challenge", "encoded.txt")).text()).toContain("Zmxh")
  })

  test("protects attachments from edits but leaves the workspace deletable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-"))
    const source = path.join(root, "source")
    await mkdir(source)
    await Bun.write(path.join(source, "encoded.txt"), "ZmxhZ3t0ZXN0fQ==\n")

    const workspace = await prepareWorkspace(
      root,
      {
        slug: "warmup",
        directory: source,
        description: "Decode it",
        files: ["encoded.txt"],
        flagFormat: "flag\\{[^}]*\\}",
      },
      "free/test",
    )
    const copied = path.join(workspace.directory, "challenge", "encoded.txt")
    expect((await stat(copied)).mode & 0o222).toBe(0)

    // A read-only challenge directory would make the run undeletable, stranding every past workspace.
    await rm(workspace.directory, { recursive: true })
    expect(await Bun.file(copied).exists()).toBe(false)
  })

  test("uses a stable public model slug in the run id", () => {
    expect(runID("free/test", new Date("2026-07-28T10:12:59Z"))).toBe("20260728T101259Z-test")
  })

  test("keeps runs of one challenge distinct a second apart", () => {
    // Parallel batches and retries can start runs of the same slug in the same minute; colliding ids
    // would overwrite a workspace and lose the earlier attempt.
    const first = runID("free/test", new Date("2026-07-28T10:12:59Z"))
    const second = runID("free/test", new Date("2026-07-28T10:13:00Z"))
    expect(first).not.toBe(second)
  })

  test("keeps runs of one model distinct when created at the exact same instant", () => {
    const now = new Date("2040-01-02T03:04:05.678Z")
    const ids = [runID("free/test", now), runID("free/test", now), runID("free/test", now)]

    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual([
      "20400102T030405Z-test",
      "20400102T030405Z-2-test",
      "20400102T030405Z-3-test",
    ])
  })

  test("refuses a runs symlink that escapes the Boom root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-root-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "boom-runs-outside-"))
    const source = path.join(root, "source")
    try {
      await mkdir(source)
      await writeFile(path.join(source, "payload.txt"), "challenge data")
      await symlink(outside, path.join(root, "runs"))

      await expect(
        prepareWorkspace(
          root,
          {
            slug: "linked-runs",
            directory: source,
            description: "",
            files: ["payload.txt"],
            flagFormat: "",
          },
          "free/test",
        ),
      ).rejects.toThrow("Runs directory escapes Boom root")
      expect(await Bun.file(path.join(outside, "linked-runs")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
