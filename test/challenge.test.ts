import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { discoverChallenges, loadChallenge } from "../src/challenge.ts"

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

  test("rejects duplicate slugs across categories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-category-duplicate-"))
    try {
      for (const category of ["WEB", "PWN"]) {
        const directory = path.join(root, "challenges", category, "same-name")
        await mkdir(directory, { recursive: true })
        await writeFile(path.join(directory, "README.md"), category)
      }
      await expect(discoverChallenges(root)).rejects.toThrow("Duplicate challenge slug across categories")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
