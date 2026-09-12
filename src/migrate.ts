/**
 * `boom migrate`: move a workspace written by an earlier Boom onto today's shared task layout.
 *
 * The layout changed in three ways — `input/` replaced the CTF-only `challenge/`, the event and
 * tool-run trails moved from `work/` to `records/`, and one `tasks/` tree replaced the per-mode
 * `runs/` and `engagements/` stores. Nothing *has* to be migrated: `src/task-layout.ts` resolves
 * every legacy path at read time, so an unmigrated task stays solvable and inspectable. Migration
 * is therefore an explicit operator action, planned in full before anything is written.
 *
 * A plan is a list of primitive operations (`move`, `append`, `rmdir`) plus the reasons a move was
 * refused, so the preview and `--apply` report the same facts and no file is ever migrated twice.
 * @module boom/migrate
 */

import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises"
import path from "node:path"
import {
  EVENTS_FILE,
  INPUT_DIR,
  isTaskDirectory,
  LEGACY_ACTIVITY_FILE,
  LEGACY_ENGAGEMENT_FILE,
  LEGACY_ENGAGEMENTS_DIR,
  LEGACY_EVENTS_RELATIVE,
  LEGACY_INPUT_DIR,
  LEGACY_RUNS_DIR,
  LEGACY_WORKERS_PATH,
  RECORDS_DIR,
  runID,
  TASK_FILE,
  tasksRoot,
  TOOL_RUNS_DIR,
  WORK_DIR,
  WORKERS_DIR,
} from "./task-layout.ts"

export type MigrationAction =
  /** Rename one file or directory; the destination does not exist yet. */
  | { kind: "move"; from: string; to: string }
  /** Append a legacy event trail to the current one, then drop the legacy file. */
  | { kind: "append"; from: string; to: string }
  /** Remove a legacy directory that migration emptied. `rmdir` refuses a non-empty one. */
  | { kind: "rmdir"; from: string }

export type MigrationSkip = { path: string; reason: string }

export type MigrationPlan = {
  root: string
  actions: MigrationAction[]
  skips: MigrationSkip[]
}

export type MigrationResult = { plan: MigrationPlan; applied: number }

/** One task being inspected: `inspection` is where its files are now, `target` where they belong. */
type TaskLocation = { inspection: string; target: string }

async function info(target: string) {
  return await lstat(target).catch(() => undefined)
}

async function isDirectory(target: string) {
  const entry = await info(target)
  return entry !== undefined && entry.isDirectory() && !entry.isSymbolicLink()
}

async function isFile(target: string) {
  const entry = await info(target)
  return entry !== undefined && entry.isFile() && !entry.isSymbolicLink()
}

/** Every entry name, sorted, so a dry run reads the same on every machine. */
async function listEntries(target: string) {
  const entries = await readdir(target, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => !entry.isSymbolicLink() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
}

async function listDirectories(target: string) {
  const entries = await readdir(target, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
}

async function isEmpty(target: string) {
  const entries = await readdir(target).catch(() => undefined)
  return entries !== undefined && entries.length === 0
}

/**
 * True when applying the plan leaves this directory with nothing in it, so a legacy store can be
 * pruned in the same run that empties it. Recursion is bounded by the workspace depth and never
 * follows a symlink.
 */
async function plannedEmpty(plan: MigrationPlan, target: string): Promise<boolean> {
  if (await isEmpty(target)) return true
  const entries = await readdir(target).catch(() => undefined)
  if (entries === undefined || entries.length === 0) return false
  const vacated = new Set(
    plan.actions.flatMap((action) => (action.kind === "rmdir" ? [] : [action.from])),
  )
  for (const name of entries) {
    const child = path.join(target, name)
    if (vacated.has(child)) continue
    if (!(await plannedEmpty(plan, child))) return false
  }
  return true
}

class Planner {
  readonly actions: MigrationAction[] = []
  readonly skips: MigrationSkip[] = []

  constructor(readonly root: string) {}

  /** Workspace-relative spelling for the report; keeps long previews readable. */
  rel(target: string) {
    const relative = path.relative(this.root, target)
    return relative === "" ? "." : relative.split(path.sep).join("/")
  }

  skip(target: string, reason: string) {
    this.skips.push({ path: this.rel(target), reason })
  }

  move(from: string, to: string) {
    if (this.planned(to)) {
      this.skip(from, "another migration rule already writes this destination")
      return false
    }
    this.actions.push({ kind: "move", from, to })
    return true
  }

  /** Appends are ordered, so several legacy trails may extend the same events file in turn. */
  append(from: string, to: string) {
    this.actions.push({ kind: "append", from, to })
    return true
  }

  /** True when an operation already targets this path, so two rules cannot fight over it. */
  private planned(target: string) {
    return this.actions.some((action) => action.kind !== "rmdir" && action.to === target)
  }
}

/**
 * Move one legacy directory into `into`, leaving behind entries the destination already holds: a
 * merge never overwrites a file an earlier version wrote. Both `relative` and `into` are relative
 * to the task root, and every planned path is spelled from the target task location.
 */
async function planDirectoryMerge(plan: Planner, task: TaskLocation, relative: string, into: string) {
  const source = path.join(task.inspection, relative)
  if (!(await isDirectory(source))) return
  const future = path.join(task.target, relative)
  const destination = path.join(task.target, into)
  if (!(await isDirectory(path.join(task.inspection, into)))) {
    plan.move(future, destination)
    return
  }
  for (const name of await listEntries(source)) {
    if (await info(path.join(destination, name))) {
      plan.skip(path.join(future, name), "destination already exists")
      continue
    }
    plan.move(path.join(future, name), path.join(destination, name))
  }
}

/** Everything inside one task: the read-only input, the event trail, and the pentest records. */
async function planTask(plan: Planner, task: TaskLocation) {
  const here = (relative: string) => path.join(task.inspection, relative)
  const at = (relative: string) => path.join(task.target, relative)

  if (await isDirectory(here(LEGACY_INPUT_DIR))) {
    if (await info(here(INPUT_DIR))) plan.skip(at(LEGACY_INPUT_DIR), `${INPUT_DIR}/ already exists`)
    else plan.move(at(LEGACY_INPUT_DIR), at(INPUT_DIR))
  }

  // A new task keeps `records/events.jsonl`; older ones wrote one trail under `work/` and, in
  // pentest, another at the task root. Appending keeps a task's whole history in one file.
  const trails = (
    await Promise.all(
      [LEGACY_EVENTS_RELATIVE, LEGACY_ACTIVITY_FILE].map(async (relative) =>
        (await isFile(here(relative))) ? relative : undefined,
      ),
    )
  ).filter((relative): relative is string => relative !== undefined)
  if (trails.length > 0) {
    const current = path.join(RECORDS_DIR, EVENTS_FILE)
    const hasCurrent = await isFile(here(current))
    trails.forEach((relative, index) => {
      if (hasCurrent || index > 0) plan.append(at(relative), at(current))
      else plan.move(at(relative), at(current))
    })
  }

  await planDirectoryMerge(plan, task, path.join(WORK_DIR, TOOL_RUNS_DIR), path.join(RECORDS_DIR, TOOL_RUNS_DIR))
  await planDirectoryMerge(plan, task, TOOL_RUNS_DIR, path.join(RECORDS_DIR, TOOL_RUNS_DIR))

  if (await isFile(here(LEGACY_ENGAGEMENT_FILE))) {
    if (await info(here(TASK_FILE))) plan.skip(at(LEGACY_ENGAGEMENT_FILE), `${TASK_FILE} already exists`)
    else plan.move(at(LEGACY_ENGAGEMENT_FILE), at(TASK_FILE))
  }

  await planDirectoryMerge(plan, task, LEGACY_WORKERS_PATH, path.join(WORK_DIR, WORKERS_DIR))
}

/** One task id per legacy engagement: the same `<UTC stamp>-pentest` name creation would use. */
async function engagementTaskID(record: Record<string, unknown>, directory: string) {
  const createdAt = typeof record.createdAt === "string" ? new Date(record.createdAt) : undefined
  const fallback = (await stat(directory).catch(() => undefined))?.mtime
  const date = createdAt && Number.isFinite(createdAt.valueOf()) ? createdAt : fallback ?? new Date(0)
  return runID("pentest", date)
}

async function readRecord(directory: string) {
  for (const name of [TASK_FILE, LEGACY_ENGAGEMENT_FILE]) {
    const raw = await readFile(path.join(directory, name), "utf8").catch(() => undefined)
    if (raw === undefined) continue
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  }
  return undefined
}

/** Task directories already under `tasks/`, including a session opened on a slug root itself. */
async function listTaskDirectories(root: string) {
  const tasks = tasksRoot(root)
  const found: TaskLocation[] = []
  for (const slug of await listDirectories(tasks)) {
    const slugRoot = path.join(tasks, slug)
    if (await isTaskDirectory(slugRoot))
      found.push({ inspection: slugRoot, target: slugRoot })
    for (const id of await listDirectories(slugRoot)) {
      const directory = path.join(slugRoot, id)
      found.push({ inspection: directory, target: directory })
    }
  }
  return found
}

/**
 * Everything migration would do to one workspace, without writing anything.
 *
 * The per-mode stores are planned first because their destinations are the task directories phase
 * two inspects: a task that moves in this run also gets its `challenge/`, event trail, and records
 * brought along, and a task that is already in place is only inspected in place.
 */
export async function planMigration(root: string): Promise<MigrationPlan> {
  const absolute = path.resolve(root)
  const plan = new Planner(absolute)
  const tasks = tasksRoot(absolute)
  const moved: TaskLocation[] = []

  const runs = path.join(absolute, LEGACY_RUNS_DIR)
  for (const slug of await listDirectories(runs)) {
    const store = path.join(runs, slug)
    for (const id of await listDirectories(store)) {
      const source = path.join(store, id)
      if (!(await isTaskDirectory(source))) {
        plan.skip(source, "not a Boom task (no NOTES.md, task.json, or RESULT.md)")
        continue
      }
      const destination = path.join(tasks, slug, id)
      if (await info(destination)) plan.skip(source, "destination already exists")
      else if (plan.move(source, destination)) moved.push({ inspection: source, target: destination })
    }
    if (await plannedEmpty(plan, store)) plan.actions.push({ kind: "rmdir", from: store })
  }

  const engagements = path.join(absolute, LEGACY_ENGAGEMENTS_DIR)
  for (const slug of await listDirectories(engagements)) {
    const store = path.join(engagements, slug)
    const record = await readRecord(store)
    if (!record) {
      plan.skip(store, `no ${LEGACY_ENGAGEMENT_FILE}`)
      continue
    }
    const destination = path.join(tasks, slug, await engagementTaskID(record, store))
    if (await info(destination)) plan.skip(store, "destination already exists")
    else if (plan.move(store, destination)) moved.push({ inspection: store, target: destination })
  }

  for (const task of [...(await listTaskDirectories(absolute)), ...moved]) await planTask(plan, task)

  if (await plannedEmpty(plan, runs)) plan.actions.push({ kind: "rmdir", from: runs })
  if (await plannedEmpty(plan, engagements))
    plan.actions.push({ kind: "rmdir", from: engagements })

  return { root: absolute, actions: plan.actions, skips: plan.skips }
}

/**
 * Write one planned migration.
 *
 * `rmdir` failures are ignored on purpose: a legacy store that still holds something phase one did
 * not claim (an operator's own file, say) must survive the pruning of its siblings.
 */
export async function applyMigration(plan: MigrationPlan): Promise<MigrationResult> {
  let applied = 0
  for (const action of plan.actions) {
    if (action.kind === "move") {
      await mkdir(path.dirname(action.to), { recursive: true })
      await rename(action.from, action.to)
    } else if (action.kind === "append") {
      const legacy = await readFile(action.from, "utf8")
      if (legacy !== "") {
        await mkdir(path.dirname(action.to), { recursive: true })
        await appendFile(action.to, legacy.endsWith("\n") ? legacy : `${legacy}\n`, "utf8")
      }
      await rm(action.from)
    } else {
      await rmdir(action.from).catch(() => {})
    }
    applied += 1
  }
  return { plan, applied }
}

/** Human-readable plan, shared by the dry run and the post-apply summary. */
export function migrationReport(plan: MigrationPlan, options: { applied?: number } = {}) {
  const lines: string[] = []
  lines.push(`Boom workspace migration (${options.applied === undefined ? "dry run" : "applied"}) — ${plan.root}`)
  lines.push("")
  for (const action of plan.actions) {
    const label = action.kind === "move" ? "move " : action.kind === "append" ? "merge" : "prune"
    lines.push(
      action.kind === "rmdir"
        ? `  ${label} ${planRelative(plan, action.from)}`
        : `  ${label} ${planRelative(plan, action.from)} → ${planRelative(plan, action.to)}`,
    )
  }
  for (const skip of plan.skips) lines.push(`  skip  ${skip.path} (${skip.reason})`)
  lines.push("")
  if (plan.actions.length === 0 && plan.skips.length === 0)
    lines.push("Nothing to do: this workspace already uses the shared task layout.")
  else if (options.applied === undefined)
    lines.push(`${plan.actions.length} change(s) planned; re-run with --apply to write them.`)
  else
    lines.push(
      `${options.applied} change(s) applied${plan.skips.length > 0 ? `, ${plan.skips.length} left alone` : ""}.`,
    )
  return `${lines.join("\n")}\n`
}

function planRelative(plan: MigrationPlan, target: string) {
  const relative = path.relative(plan.root, target)
  return relative === "" ? "." : relative.split(path.sep).join("/")
}
