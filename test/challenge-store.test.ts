import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  addChallengeAttachments,
  createChallengeInCatalog,
  readAnswer,
  removeChallengeAttachment,
  updateChallengeInCatalog,
} from "../src/challenge-store.ts"
import { loadChallenge } from "../src/challenge.ts"

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-challenge-store-"))
  await mkdir(path.join(root, "challenges"), { recursive: true })
  return { root, async close() { await rm(root, { recursive: true, force: true }) } }
}

describe("challenge catalog authoring", () => {
  test("creates, edits, and re-reads a challenge the way discovery sees it", async () => {
    const space = await workspace()
    try {
      const created = await createChallengeInCatalog(space.root, {
        slug: "login-bypass",
        category: "web",
        description: "Bypass the login form",
        difficulty: "medium",
        serviceRequired: true,
        remote: "http://10.0.0.5:8080",
        flagFormat: "flag\\{[^}]*\\}",
        answer: "flag{admin}",
      })
      expect(created.directory).toBe(path.join(space.root, "challenges", "WEB", "login-bypass"))
      expect(await readFile(path.join(created.directory, "README.md"), "utf8"))
        .toBe("# login-bypass\n\nBypass the login form\n")
      expect(await readAnswer(space.root, "login-bypass")).toBe("flag{admin}")

      const discovered = await loadChallenge(created.directory, new Map(), "WEB")
      expect(discovered).toMatchObject({
        slug: "login-bypass",
        category: "WEB",
        difficulty: "medium",
        remote: "http://10.0.0.5:8080",
        serviceRequired: true,
        flagFormat: "flag\\{[^}]*\\}",
      })

      await updateChallengeInCatalog(space.root, "login-bypass", {
        description: "Bypass the login form with a crafted cookie",
        difficulty: null,
      })
      const edited = await loadChallenge(created.directory, new Map(), "WEB")
      expect(edited.description).toBe("# login-bypass\n\nBypass the login form with a crafted cookie")
      expect(edited.difficulty).toBeUndefined()
      expect(edited.serviceRequired).toBe(true)
    } finally {
      await space.close()
    }
  })

  test("does not write a second title when the editor hands back the whole file", async () => {
    const space = await workspace()
    try {
      const created = await createChallengeInCatalog(space.root, {
        slug: "echo",
        category: "misc",
        description: "Original statement",
      })
      // The GUI prefills its description field from the stored description, which is the README.
      const stored = (await loadChallenge(created.directory, new Map(), "MISC")).description
      await updateChallengeInCatalog(space.root, "echo", { description: stored })

      expect(await readFile(path.join(created.directory, "README.md"), "utf8"))
        .toBe("# echo\n\nOriginal statement\n")
    } finally {
      await space.close()
    }
  })

  test("refuses a slug another category already uses", async () => {
    const space = await workspace()
    try {
      await createChallengeInCatalog(space.root, { slug: "dup", category: "MISC" })
      await expect(createChallengeInCatalog(space.root, { slug: "dup", category: "CRYPTO" }))
        .rejects.toThrow("already exists")
      // The flat layout discovery still accepts is protected the same way.
      await mkdir(path.join(space.root, "challenges", "flat"), { recursive: true })
      await writeFile(path.join(space.root, "challenges", "flat", "README.md"), "flat")
      await expect(createChallengeInCatalog(space.root, { slug: "flat", category: "MISC" }))
        .rejects.toThrow("already exists")
    } finally {
      await space.close()
    }
  })

  test("copies attachments in and removes them by name", async () => {
    const space = await workspace()
    const source = path.join(space.root, "note.txt")
    try {
      await writeFile(source, "attachment")
      const created = await createChallengeInCatalog(space.root, { slug: "attach", category: "MISC" })
      const added = await addChallengeAttachments(space.root, "attach", [source])
      expect(added.files).toEqual(["note.txt"])
      expect(await readFile(path.join(created.directory, "files", "note.txt"), "utf8")).toBe("attachment")

      await removeChallengeAttachment(space.root, "attach", "note.txt")
      await expect(readFile(path.join(created.directory, "files", "note.txt"), "utf8")).rejects.toThrow()
      await expect(removeChallengeAttachment(space.root, "attach", "../escape")).rejects.toThrow(
        "Invalid attachment name",
      )
    } finally {
      await space.close()
    }
  })
})
