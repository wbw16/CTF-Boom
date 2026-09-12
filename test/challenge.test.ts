import { describe, expect, spyOn, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { discoverChallenges, loadChallenge, prepareWorkspaceRoot } from "../src/challenge.ts"

describe("challenge discovery safety", () => {
  test("keeps an empty synchronized placeholder from blocking challenge discovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-empty-challenge-"))
    try {
      await mkdir(path.join(root, "challenges", "CRYPTO", "0_1_Game"), { recursive: true })

      const challenges = await discoverChallenges(root)

      expect(challenges).toEqual([expect.objectContaining({
        slug: "0_1_Game",
        category: "CRYPTO",
        description: "",
        files: [],
      })])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves an external-service prerequisite from meta.json", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-service-challenge-"))
    try {
      await writeFile(path.join(root, "README.md"), "connect to the challenge service")
      await writeFile(path.join(root, "meta.json"), JSON.stringify({
        service_required: true,
      }))

      const challenge = await loadChallenge(root, new Map())

      expect(challenge.serviceRequired).toBe(true)
      expect(challenge.remote).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not follow attachment symlinks outside the challenge directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-challenge-"))
    const challengeDirectory = path.join(root, "linked")
    const secret = path.join(root, "host-secret.txt")
    try {
      await mkdir(challengeDirectory)
      await writeFile(path.join(challengeDirectory, "payload.txt"), "challenge data")
      await writeFile(secret, "must not enter the workspace")
      await symlink(secret, path.join(challengeDirectory, "leak.txt"))

      const challenge = await loadChallenge(challengeDirectory, new Map())

      expect(challenge.files).toEqual(["payload.txt"])
      expect(challenge.flagFormat).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("discovers category/slug directories while keeping flat challenges compatible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-categories-"))
    try {
      await mkdir(path.join(root, "challenges", "WEB", "login"), { recursive: true })
      await mkdir(path.join(root, "challenges", "misc", "packet"), { recursive: true })
      await mkdir(path.join(root, "challenges", "legacy"), { recursive: true })
      await writeFile(path.join(root, "challenges", "WEB", "login", "README.md"), "web task")
      await writeFile(path.join(root, "challenges", "misc", "packet", "capture.pcap"), "pcap")
      await writeFile(path.join(root, "challenges", "legacy", "README.md"), "old layout")

      const challenges = await discoverChallenges(root)

      expect(challenges.map((challenge) => [challenge.category, challenge.slug])).toEqual([
        ["WEB", "login"],
        ["MISC", "packet"],
        ["OTHER", "legacy"],
      ])
      expect(challenges[0]?.sourceDirectory).toBe(path.join(root, "challenges", "WEB", "login"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps the first challenge when slugs collide across categories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-category-duplicate-"))
    const warn = spyOn(console, "warn")
    try {
      for (const category of ["PWN", "WEB"]) {
        const directory = path.join(root, "challenges", category, "same-name")
        await mkdir(directory, { recursive: true })
        await writeFile(path.join(directory, "README.md"), category)
      }
      // Directories are scanned in name order, so PWN/same-name wins and WEB/same-name is skipped.
      const challenges = await discoverChallenges(root)

      expect(challenges.map((challenge) => [challenge.category, challenge.slug])).toEqual([
        ["PWN", "same-name"],
      ])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("保留首个并跳过"))
    } finally {
      warn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("skips an unresolvable challenge directory without losing the rest of the catalog", async () => {
    // The fault injection relies on directory permissions, which root ignores.
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-bad-challenge-"))
    const brokenFiles = path.join(root, "challenges", "WEB", "broken", "files")
    const warn = spyOn(console, "warn")
    try {
      await mkdir(brokenFiles, { recursive: true })
      await writeFile(path.join(brokenFiles, "payload.txt"), "becomes unreadable")
      await mkdir(path.join(root, "challenges", "WEB", "healthy"), { recursive: true })
      await writeFile(path.join(root, "challenges", "WEB", "healthy", "README.md"), "web task")
      await mkdir(path.join(root, "challenges", "CRYPTO", "solver"), { recursive: true })
      await writeFile(path.join(root, "challenges", "CRYPTO", "solver", "README.md"), "crypto task")
      await chmod(brokenFiles, 0o000)

      const challenges = await discoverChallenges(root)

      expect(challenges.map((challenge) => challenge.slug).sort()).toEqual(["healthy", "solver"])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("个挑战目录无法解析"))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(path.join("WEB", "broken")))
    } finally {
      warn.mockRestore()
      await chmod(brokenFiles, 0o700).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports the answers file path when its configuration is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-answers-invalid-"))
    try {
      await mkdir(path.join(root, "challenges", "WEB", "login"), { recursive: true })
      await mkdir(path.join(root, "eval"), { recursive: true })
      await writeFile(path.join(root, "eval", "answers.txt"), "just-a-slug-without-flag\n")

      await expect(discoverChallenges(root)).rejects.toThrow(
        `无法加载挑战答案文件 ${path.join(root, "eval", "answers.txt")}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("discovers category folders that sit directly under the workspace root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-root-categories-"))
    try {
      await mkdir(path.join(root, "WEB", "login"), { recursive: true })
      await mkdir(path.join(root, "misc", "packet"), { recursive: true })
      // Workspace infrastructure must not be mistaken for challenges.
      await mkdir(path.join(root, "tasks", "login", "20260101T000000Z-x"), { recursive: true })
      await mkdir(path.join(root, "tools"), { recursive: true })
      await writeFile(path.join(root, "WEB", "login", "README.md"), "web task")
      await writeFile(path.join(root, "misc", "packet", "capture.pcap"), "pcap")
      await writeFile(path.join(root, "tools", "README.md"), "not a challenge")

      const challenges = await discoverChallenges(root)

      expect(challenges.map((challenge) => [challenge.category, challenge.slug])).toEqual([
        ["WEB", "login"],
        ["MISC", "packet"],
      ])
      expect(challenges[0]?.sourceDirectory).toBe(path.join(root, "WEB", "login"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prefers challenges/ over root-level categories when both exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-both-layouts-"))
    try {
      await mkdir(path.join(root, "challenges", "PWN", "inner"), { recursive: true })
      await mkdir(path.join(root, "WEB", "outer"), { recursive: true })
      await writeFile(path.join(root, "challenges", "PWN", "inner", "README.md"), "wrapped")
      await writeFile(path.join(root, "WEB", "outer", "README.md"), "unwrapped")

      const challenges = await discoverChallenges(root)

      expect(challenges.map((challenge) => challenge.slug)).toEqual(["inner"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("describes both accepted layouts when no catalog exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-no-catalog-"))
    try {
      await expect(discoverChallenges(root)).rejects.toThrow(
        `No challenge catalog under ${root}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prepares a fresh workspace without shadowing an existing root-level catalog", async () => {
    const fresh = await mkdtemp(path.join(os.tmpdir(), "boom-prepare-fresh-"))
    const categorized = await mkdtemp(path.join(os.tmpdir(), "boom-prepare-categories-"))
    try {
      await prepareWorkspaceRoot(fresh)
      await expect(exists(path.join(fresh, "tasks"))).resolves.toBe(true)
      await expect(exists(path.join(fresh, "challenges"))).resolves.toBe(true)

      await mkdir(path.join(categorized, "PWN", "stack"), { recursive: true })
      await prepareWorkspaceRoot(categorized)
      await expect(exists(path.join(categorized, "tasks"))).resolves.toBe(true)
      await expect(exists(path.join(categorized, "challenges"))).resolves.toBe(false)

      // The prepared catalog stays discoverable alongside the root categories.
      const challenges = await discoverChallenges(categorized)
      expect(challenges.map((challenge) => challenge.slug)).toEqual(["stack"])
    } finally {
      await rm(fresh, { recursive: true, force: true })
      await rm(categorized, { recursive: true, force: true })
    }
  })
})

async function exists(target: string) {
  return (await lstat(target).catch(() => undefined)) !== undefined
}
