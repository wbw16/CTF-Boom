import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
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
  test("keeps legacy inputs visible when adding an attachment", async () => {
    const space = await workspace()
    try {
      const directory = path.join(space.root, "challenges", "legacy")
      await mkdir(directory)
      await writeFile(path.join(directory, "README.md"), "legacy")
      await writeFile(path.join(directory, "old.py"), "old")
      const source = path.join(space.root, "new.txt")
      await writeFile(source, "new")
      await addChallengeAttachments(space.root, "legacy", [source])
      expect((await loadChallenge(directory, new Map())).files).toEqual(["new.txt", "old.py"])
    } finally { await space.close() }
  })

  test("rejects a colliding batch without changing existing attachments", async () => {
    const space = await workspace()
    try {
      const created = await createChallengeInCatalog(space.root, { slug: "collision" })
      await mkdir(path.join(space.root, "a"))
      await mkdir(path.join(space.root, "b"))
      const first = path.join(space.root, "a", "same.txt")
      const second = path.join(space.root, "b", "same.txt")
      await writeFile(first, "first")
      await writeFile(second, "second")
      await expect(addChallengeAttachments(space.root, "collision", [first, second])).rejects.toThrow("already exists")
      expect((await loadChallenge(created.directory, new Map())).files).toEqual([])
      await addChallengeAttachments(space.root, "collision", [first])
      await expect(addChallengeAttachments(space.root, "collision", [second])).rejects.toThrow("already exists")
      expect(await readFile(path.join(created.directory, "files", "same.txt"), "utf8")).toBe("first")
    } finally { await space.close() }
  })

  test("deletes the exact nested path and refuses links or metadata", async () => {
    const space = await workspace()
    try {
      const created = await createChallengeInCatalog(space.root, { slug: "nested" })
      const base = path.join(created.directory, "files")
      await mkdir(path.join(base, "a"))
      await writeFile(path.join(base, "a", "data.txt"), "nested")
      await writeFile(path.join(base, "data.txt"), "root")
      await removeChallengeAttachment(space.root, "nested", "a/data.txt")
      expect(await readFile(path.join(base, "data.txt"), "utf8")).toBe("root")
      await symlink(space.root, path.join(base, "linked"))
      await expect(removeChallengeAttachment(space.root, "nested", "linked/data.txt")).rejects.toThrow("real file")
      await expect(removeChallengeAttachment(space.root, "nested", "meta.json")).rejects.toThrow("Invalid attachment")
      await expect(removeChallengeAttachment(space.root, "nested", "a/../data.txt")).rejects.toThrow("Invalid attachment")
    } finally { await space.close() }
  })
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
