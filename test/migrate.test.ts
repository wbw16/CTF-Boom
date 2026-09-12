import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applyMigration, migrationReport, planMigration, type MigrationPlan } from "../src/migrate.ts"

async function exists(target: string) {
  return (await stat(target).catch(() => undefined)) !== undefined
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-migrate-"))
  return { root, async close() { await rm(root, { recursive: true, force: true }) } }
}

/** The CTF layout of earlier versions: `runs/<slug>/<task-id>/challenge` + `work/events.jsonl`. */
async function legacyRun(root: string, slug: string, id: string) {
  const directory = path.join(root, "runs", slug, id)
  await mkdir(path.join(directory, "challenge"), { recursive: true })
  await mkdir(path.join(directory, "work"), { recursive: true })
  await writeFile(path.join(directory, "challenge", "README.md"), "old statement")
  await writeFile(path.join(directory, "work", "events.jsonl"), '{"at":1}\n')
  await writeFile(path.join(directory, "NOTES.md"), "old notes")
  return directory
}

/** The pentest layout of earlier versions: `engagements/<slug>/engagement.json`. */
async function legacyEngagement(root: string, slug: string) {
  const directory = path.join(root, "engagements", slug)
  await mkdir(path.join(directory, "work"), { recursive: true })
  await mkdir(path.join(directory, "tool-runs", "run-1"), { recursive: true })
  await writeFile(path.join(directory, "engagement.json"), JSON.stringify({ slug, createdAt: "2026-03-04T05:06:07.000Z" }))
  await writeFile(path.join(directory, "agent-log.jsonl"), '{"at":2}\n')
  await writeFile(path.join(directory, "work", "report.md"), "findings")
  await writeFile(path.join(directory, "tool-runs", "run-1", "output.txt"), "nmap")
  return directory
}

/**
 * Migration names a legacy engagement's task the way creation would, from its `createdAt`; the test
 * reads the id out of the plan instead of hard-coding a timestamp.
 */
function engagementTarget(plan: MigrationPlan, slug: string) {
  const move = plan.actions.find(
    (action) => action.kind === "move" && action.from.endsWith(path.join("engagements", slug)),
  )
  if (!move || move.kind !== "move") throw new Error(`no engagement move planned for ${slug}`)
  return { id: path.basename(move.to), directory: move.to }
}

describe("workspace migration", () => {
  test("plans a legacy CTF run and pentest engagement onto the task tree without writing", async () => {
    const space = await workspace()
    try {
      await legacyRun(space.root, "alpha", "20260101T000000Z-model")
      await legacyEngagement(space.root, "acme")

      const plan = await planMigration(space.root)
      const described = plan.actions.map((action) =>
        action.kind === "rmdir"
          ? `${action.kind} ${path.relative(space.root, action.from)}`
          : `${action.kind} ${path.relative(space.root, action.from)} -> ${path.relative(space.root, action.to)}`,
      )

      expect(described).toContain("move runs/alpha/20260101T000000Z-model -> tasks/alpha/20260101T000000Z-model")
      expect(described).toContain(
        "move tasks/alpha/20260101T000000Z-model/challenge -> tasks/alpha/20260101T000000Z-model/input",
      )
      expect(described).toContain(
        "move tasks/alpha/20260101T000000Z-model/work/events.jsonl -> tasks/alpha/20260101T000000Z-model/records/events.jsonl",
      )
      const engagement = engagementTarget(plan, "acme")
      expect(engagement.id.startsWith("20260304T050607Z-pentest")).toBe(true)
      expect(described).toContain(`move engagements/acme -> tasks/acme/${engagement.id}`)
      expect(described).toContain(
        `move tasks/acme/${engagement.id}/engagement.json -> tasks/acme/${engagement.id}/task.json`,
      )
      expect(described).toContain(
        `move tasks/acme/${engagement.id}/agent-log.jsonl -> tasks/acme/${engagement.id}/records/events.jsonl`,
      )
      expect(described).toContain(
        `move tasks/acme/${engagement.id}/tool-runs -> tasks/acme/${engagement.id}/records/tool-runs`,
      )
      expect(described).toContain("rmdir runs")

      // A preview never touches the workspace.
      expect(await exists(path.join(space.root, "runs"))).toBe(true)
      expect(await exists(path.join(space.root, "tasks"))).toBe(false)
      expect(migrationReport(plan)).toContain("re-run with --apply")
    } finally {
      await space.close()
    }
  })

  test("applies the plan, keeps the task readable, and is idempotent", async () => {
    const space = await workspace()
    try {
      await legacyRun(space.root, "alpha", "20260101T000000Z-model")
      await legacyEngagement(space.root, "acme")
      const plan = await planMigration(space.root)
      const result = await applyMigration(plan)
      expect(result.applied).toBe(plan.actions.length)

      const task = path.join(space.root, "tasks", "alpha", "20260101T000000Z-model")
      expect(await readFile(path.join(task, "input", "README.md"), "utf8")).toBe("old statement")
      expect(await readFile(path.join(task, "records", "events.jsonl"), "utf8")).toBe('{"at":1}\n')
      expect(await readFile(path.join(task, "NOTES.md"), "utf8")).toBe("old notes")

      const engagement = engagementTarget(plan, "acme").directory
      expect(JSON.parse(await readFile(path.join(engagement, "task.json"), "utf8"))).toMatchObject({ slug: "acme" })
      expect(await readFile(path.join(engagement, "records", "events.jsonl"), "utf8")).toBe('{"at":2}\n')
      expect(await readFile(path.join(engagement, "records", "tool-runs", "run-1", "output.txt"), "utf8")).toBe("nmap")
      expect(await readFile(path.join(engagement, "work", "report.md"), "utf8")).toBe("findings")

      expect(await exists(path.join(space.root, "runs"))).toBe(false)
      expect(await exists(path.join(space.root, "engagements"))).toBe(false)

      const again = await planMigration(space.root)
      expect(again.actions).toEqual([])
      expect(again.skips).toEqual([])
      expect(migrationReport(again)).toContain("Nothing to do")
    } finally {
      await space.close()
    }
  })

  test("merges into existing destinations instead of overwriting them", async () => {
    const space = await workspace()
    try {
      // A task that a manual move left half-migrated: the new records file and the new input
      // directory already exist next to the pre-rename copies.
      const task = path.join(space.root, "tasks", "alpha", "20260101T000000Z-model")
      await mkdir(path.join(task, "records"), { recursive: true })
      await mkdir(path.join(task, "input"), { recursive: true })
      await mkdir(path.join(task, "challenge"), { recursive: true })
      await mkdir(path.join(task, "work"), { recursive: true })
      await writeFile(path.join(task, "records", "events.jsonl"), '{"at":0}\n')
      await writeFile(path.join(task, "work", "events.jsonl"), '{"at":1}\n{"at":2}\n')
      await writeFile(path.join(task, "input", "README.md"), "new statement")
      await writeFile(path.join(task, "challenge", "README.md"), "old statement")
      // A run that never moved still gets migrated in the same pass.
      await legacyRun(space.root, "beta", "20260101T000000Z-model")

      const plan = await planMigration(space.root)
      const events = plan.actions.find(
        (action) => action.kind === "append" && action.from.endsWith(path.join("work", "events.jsonl")),
      )
      expect(events).toBeDefined()
      expect(plan.skips).toContainEqual(expect.objectContaining({
        path: "tasks/alpha/20260101T000000Z-model/challenge",
        reason: "input/ already exists",
      }))

      await applyMigration(plan)

      expect(await readFile(path.join(task, "records", "events.jsonl"), "utf8"))
        .toBe('{"at":0}\n{"at":1}\n{"at":2}\n')
      expect(await exists(path.join(task, "work", "events.jsonl"))).toBe(false)
      expect(await readFile(path.join(task, "input", "README.md"), "utf8")).toBe("new statement")
      // The conflicting legacy directory stays where it was, so nothing is lost by the conflict.
      expect(await readFile(path.join(task, "challenge", "README.md"), "utf8")).toBe("old statement")
      expect(await exists(path.join(space.root, "tasks", "beta", "20260101T000000Z-model", "input"))).toBe(true)
    } finally {
      await space.close()
    }
  })

  test("reports a run directory that holds no task record instead of moving it", async () => {
    const space = await workspace()
    try {
      await legacyRun(space.root, "alpha", "20260101T000000Z-model")
      // An operator's own directory under the legacy store: no task record, so migration must not
      // claim it — but it leaves `runs/` behind, so the plan has to say why.
      await mkdir(path.join(space.root, "runs", "alpha", "stray"), { recursive: true })
      await writeFile(path.join(space.root, "runs", "alpha", "stray", "scratch.txt"), "operator file")

      const plan = await planMigration(space.root)
      expect(plan.skips).toContainEqual(expect.objectContaining({ path: "runs/alpha/stray" }))

      await applyMigration(plan)

      expect(await readFile(path.join(space.root, "runs", "alpha", "stray", "scratch.txt"), "utf8"))
        .toBe("operator file")
      expect(await exists(path.join(space.root, "runs"))).toBe(true)
      expect(migrationReport(plan, { applied: plan.actions.length })).toContain("1 left alone")
    } finally {
      await space.close()
    }
  })

  test("leaves an already-migrated workspace alone and ignores unmanaged directories", async () => {
    const space = await workspace()
    try {
      await mkdir(path.join(space.root, "challenges", "MISC", "alpha"), { recursive: true })
      await writeFile(path.join(space.root, "challenges", "MISC", "alpha", "README.md"), "operator challenge")
      await mkdir(path.join(space.root, "tasks", "alpha", "20260101T000000Z-model", "records"), { recursive: true })
      await writeFile(path.join(space.root, "tasks", "alpha", "20260101T000000Z-model", "task.json"), "{}")

      const plan = await planMigration(space.root)
      expect(plan.actions).toEqual([])
      expect(plan.skips).toEqual([])
      expect(await readFile(path.join(space.root, "challenges", "MISC", "alpha", "README.md"), "utf8"))
        .toBe("operator challenge")
    } finally {
      await space.close()
    }
  })
})

describe("boom migrate command", () => {
  async function boom(args: string[]) {
    const child = Bun.spawn(["bun", path.join(import.meta.dir, "..", "src", "index.ts"), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  }

  test("previews by default, applies on request, and is quiet once migrated", async () => {
    const space = await workspace()
    try {
      await legacyRun(space.root, "alpha", "20260101T000000Z-model")

      const preview = await boom(["migrate", "--root", space.root])
      expect(preview.code).toBe(0)
      expect(preview.stdout).toContain("dry run")
      expect(preview.stdout).toContain("re-run with --apply")
      expect(await exists(path.join(space.root, "runs"))).toBe(true)

      const json = await boom(["migrate", "--root", space.root, "--json"])
      expect(JSON.parse(json.stdout)).toMatchObject({ root: space.root })

      const applied = await boom(["migrate", "--root", space.root, "--apply"])
      expect(applied.code).toBe(0)
      expect(applied.stdout).toContain("applied")
      expect(await exists(path.join(space.root, "tasks", "alpha", "20260101T000000Z-model", "input"))).toBe(true)

      const again = await boom(["migrate", "--root", space.root])
      expect(again.stdout).toContain("Nothing to do")
    } finally {
      await space.close()
    }
  })

  test("rejects an unknown flag", async () => {
    const result = await boom(["migrate", "--nope"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Usage: boom")
  })
})
