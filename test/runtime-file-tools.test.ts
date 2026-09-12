import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadBoomToolRegistry } from "../src/runtime/tool-registry.ts"
import { decideBoomToolPolicy, resolveTaskPath } from "../src/runtime/policy.ts"
import { createBoomToolHost, type BoomToolName } from "../src/tool-runtime.ts"

const RESOURCE_ROOT = path.join(import.meta.dir, "..", "resources")
const temporary: string[] = []

afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-native-files-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "input"))
  await mkdir(path.join(directory, "work", ".boom"), { recursive: true })
  await writeFile(path.join(directory, "input", "evidence.txt"), "alpha\nflag{evidence}\nomega\n")
  await writeFile(path.join(directory, "work", "analysis.txt"), "hypothesis alpha\nsecond alpha\n")
    await writeFile(path.join(directory, "work", ".boom", "state.json"), "{}\n")
    await mkdir(path.join(directory, "work", ".boom", "commands"), { recursive: true })
    await writeFile(path.join(directory, "work", ".boom", "commands", "command-1.log"), "full nmap output\n")
    await writeFile(path.join(directory, "work", ".boom", "commands", "notes.txt"), "host notes\n")
    await writeFile(path.join(directory, "work", ".boom", "command-events.jsonl"), "{}\n")
    await writeFile(path.join(directory, "work", "RESULT.json"), "{}\n")
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n")
  return {
    directory,
    host: createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT)),
  }
}

describe("M3 task file policy", () => {
  test("makes profile visibility and side-effect policy authoritative at dispatch", async () => {
    const registry = await loadBoomToolRegistry(RESOURCE_ROOT)
    expect(decideBoomToolPolicy(registry, "solver", "edit").kind).toBe("allow")
    expect(decideBoomToolPolicy(registry, "reasoning", "read").kind).toBe("allow")
    expect(decideBoomToolPolicy(registry, "reasoning", "edit")).toEqual(expect.objectContaining({ kind: "deny" }))
    expect(decideBoomToolPolicy(registry, "missing", "read")).toEqual(expect.objectContaining({ kind: "deny" }))
    // The pentest profile owns its record tools, including the notes entry point, and no CTF
    // profile gains them by accident.
    expect(decideBoomToolPolicy(registry, "pentest", "pentest-note")).toEqual(expect.objectContaining({ kind: "allow" }))
    expect(decideBoomToolPolicy(registry, "solver", "pentest-note")).toEqual(expect.objectContaining({ kind: "deny" }))
    expect(decideBoomToolPolicy(registry, "reasoning", "pentest-asset")).toEqual(expect.objectContaining({ kind: "deny" }))
  })

  test("resolves task-relative paths and rejects lexical and symbolic-link escape", async () => {
    const { directory } = await fixture()
    expect(await resolveTaskPath(directory, "input/evidence.txt")).toEqual(expect.objectContaining({
      relative: "input/evidence.txt",
      zone: "input",
    }))
    await expect(resolveTaskPath(directory, "../outside")).rejects.toThrow("escapes the workspace")
    await expect(resolveTaskPath(directory, path.join(directory, "input", "evidence.txt")))
      .rejects.toThrow("must be relative")

    const outside = await mkdtemp(path.join(os.tmpdir(), "boom-native-outside-"))
    temporary.push(outside)
    await writeFile(path.join(outside, "secret.txt"), "host secret")
    await symlink(outside, path.join(directory, "work", "escape"))
    await expect(resolveTaskPath(directory, "work/escape/secret.txt")).rejects.toThrow("symbolic link")
  })
})

describe("M3 native file tools", () => {
  test("reads, lists, globs, and greps through one bounded no-follow host", async () => {
    const { directory, host } = await fixture()
    const execute = (name: BoomToolName, args: Record<string, unknown>) => host.execute({
      name,
      arguments: args,
      directory,
      profileID: "solver",
    })

    const read = await execute("read", { filePath: "input/evidence.txt", offset: 2, limit: 1 })
    expect(read.output).toContain("flag{evidence}")
    expect(read.output).not.toContain("alpha")
    expect(read.metadata).toEqual(expect.objectContaining({ returnedLines: 1 }))

    const list = await execute("list", {})
    expect(list.output).toContain("input/")
    expect(list.output).toContain("work/")

    const glob = await execute("glob", { pattern: "**/*.txt" })
    expect(glob.output).toContain("input/evidence.txt")
    expect(glob.output).toContain("work/analysis.txt")

    const grep = await execute("grep", { pattern: "alpha", include: "**/*.txt" })
    expect(grep.output).toContain("input/evidence.txt:1:alpha")
    expect(grep.output).toContain("work/analysis.txt:1:hypothesis alpha")

    // Host-owned task state is hidden from the agent-facing file tools.
    expect(list.output).not.toContain(".boom/")
    expect(list.output).not.toContain("RESULT.json")
    expect(glob.output).not.toContain(".boom")
    await expect(host.execute({
      name: "read",
      arguments: { filePath: "work/.boom/state.json" },
      directory,
      profileID: "solver",
    })).rejects.toThrow("host-owned task state")
    // The command-log paths a bash/boom-exec result points at are readable, so a model never has to
    // re-run a command to see output the host already captured; the ledger stays host-only.
    const log = await execute("read", { filePath: "work/.boom/commands/command-1.log" })
    expect(log.output).toContain("full nmap output")
    await expect(host.execute({
      name: "read",
      arguments: { filePath: "work/.boom/command-events.jsonl" },
      directory,
      profileID: "solver",
    })).rejects.toThrow("host-owned task state")
    await expect(host.execute({
      name: "read",
      arguments: { filePath: "work/.boom/commands/notes.txt" },
      directory,
      profileID: "solver",
    })).rejects.toThrow("host-owned task state")
    await expect(host.execute({
      name: "edit",
      arguments: { filePath: "work/.boom/commands/command-1.log", oldString: "full", newString: "empty" },
      directory,
      profileID: "solver",
    })).rejects.toThrow("host-owned task state")
  })

  test("edits only existing agent-owned files under work", async () => {
    const { directory, host } = await fixture()
    const execute = (filePath: string, profileID = "solver") => host.execute({
      name: "edit",
      arguments: { filePath, oldString: "alpha", newString: "beta", replaceAll: true },
      directory,
      profileID,
    })

    const result = await execute("work/analysis.txt")
    expect(result.output).toContain("Replaced 2 occurrences")
    expect(await readFile(path.join(directory, "work", "analysis.txt"), "utf8")).toBe(
      "hypothesis beta\nsecond beta\n",
    )
    await expect(execute("input/evidence.txt")).rejects.toThrow("outside work")
    await expect(execute("NOTES.md")).rejects.toThrow("outside work")
    await expect(host.execute({
      name: "edit",
      arguments: { filePath: "work/.boom/state.json", oldString: "{}", newString: "bad" },
      directory,
      profileID: "solver",
    })).rejects.toThrow("host-owned")
    await expect(host.execute({
      name: "edit",
      arguments: { filePath: "work/RESULT.json", oldString: "{}", newString: "bad" },
      directory,
      profileID: "solver",
    })).rejects.toThrow("host-owned")
    await expect(execute("work/analysis.txt", "verifier")).rejects.toThrow("Boom policy denied edit")
  })

  test("does not traverse links during discovery and rejects linked reads", async () => {
    const { directory, host } = await fixture()
    await symlink(path.join(directory, "input"), path.join(directory, "work", "linked-input"))
    const glob = await host.execute({
      name: "glob",
      arguments: { pattern: "**/*" },
      directory,
      profileID: "solver",
    })
    expect(glob.output).toContain("work/linked-input@")
    expect(glob.output).not.toContain("work/linked-input/evidence.txt")
    await expect(host.execute({
      name: "read",
      arguments: { filePath: "work/linked-input/evidence.txt" },
      directory,
      profileID: "solver",
    })).rejects.toThrow("symbolic link")
  })

  test("validates native schemas before policy and implementation", async () => {
    const { directory, host } = await fixture()
    await expect(host.execute({
      name: "read",
      arguments: { filePath: "input/evidence.txt", limit: 2001 },
      directory,
      profileID: "solver",
    })).rejects.toThrow("maximum is 2000")
    await expect(host.execute({
      name: "glob",
      arguments: { pattern: "**/*", unknown: true },
      directory,
      profileID: "solver",
    })).rejects.toThrow("unknown property")
  })
})

describe("M3 native state tools", () => {
  test("loads only Boom-owned skills without exposing an absolute resource path", async () => {
    const { directory, host } = await fixture()
    const result = await host.execute({
      name: "skill",
      arguments: { name: "ctf-workflow" },
      directory,
      profileID: "solver",
    })
    expect(result.title).toBe("Loaded skill: ctf-workflow")
    expect(result.output).toContain("<skill_content name=\"ctf-workflow\">")
    expect(result.output).toContain("work/RESULT.json")
    expect(result.output).not.toContain(RESOURCE_ROOT)
    await expect(host.execute({
      name: "skill",
      arguments: { name: "../outside" },
      directory,
      profileID: "solver",
    })).rejects.toThrow("Invalid Boom skill name")
  })

  test("keeps bounded todo state session-scoped and profile-governed", async () => {
    const { directory, host } = await fixture()
    const todos = [{ content: "Inspect evidence", status: "in_progress", priority: "high" }]
    const result = await host.execute({
      name: "todowrite",
      arguments: { todos },
      directory,
      profileID: "worker",
      sessionID: "session-todo-1",
    })
    expect(result.title).toBe("1 todos")
    expect(result.metadata).toEqual(expect.objectContaining({ sessionID: "session-todo-1", todos }))
    await expect(host.execute({
      name: "todowrite",
      arguments: { todos },
      directory,
      profileID: "worker",
    })).rejects.toThrow("runtime session ID")
    await expect(host.execute({
      name: "todowrite",
      arguments: { todos },
      directory,
      profileID: "solver",
      sessionID: "session-todo-solver",
    })).rejects.toThrow("Boom policy denied todowrite")
    await expect(host.execute({
      name: "todowrite",
      arguments: { todos },
      directory,
      profileID: "verifier",
      sessionID: "session-todo-verifier",
    })).rejects.toThrow("Boom policy denied todowrite")
    await expect(host.execute({
      name: "todowrite",
      arguments: { todos: Array.from({ length: 101 }, () => todos[0]) },
      directory,
      profileID: "worker",
      sessionID: "session-todo-large",
    })).rejects.toThrow("maximum item count is 100")
  })
})
