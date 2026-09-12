/**
 * One task, one directory: the single source of truth for Boom's on-disk task layout.
 *
 * Both modes — CTF solving and authorized penetration testing — materialize the same shape, so the
 * directory the agent works in is also the directory the operator opens, and a prompt, a policy
 * zone, a container mount, or a migration script can never disagree about where something lives:
 *
 * ```
 * <root>/tasks/<slug>/<task-id>/
 *   task.json      host-owned record (mode, status, turns, pentest records)
 *   result.json    latest run/turn result summary
 *   NOTES.md       durable cross-turn memory
 *   input/         read-only snapshot: brief + attachments (CTF) or authorization + imports
 *   records/       host-owned, append-only: events.jsonl, tool-runs/
 *   work/          the only place the agent may write
 * ```
 *
 * The layout is deliberately mode-neutral: `input/` replaced the CTF-only `challenge/`, and the
 * per-slug stores (`runs/`, `engagements/`) became one `tasks/` tree. Legacy directories written by
 * earlier Boom versions stay readable through the `resolve*` helpers and `boom migrate`.
 * @module boom/task-layout
 */

import { lstat } from "node:fs/promises"
import path from "node:path"

/** Task tree and its legacy per-mode predecessors. */
export const TASKS_DIR = "tasks"
export const LEGACY_RUNS_DIR = "runs"
export const LEGACY_ENGAGEMENTS_DIR = "engagements"

/** Inside one task directory. */
export const INPUT_DIR = "input"
export const LEGACY_INPUT_DIR = "challenge"
export const WORK_DIR = "work"
export const RECORDS_DIR = "records"
export const NOTES_FILE = "NOTES.md"
export const TASK_FILE = "task.json"
export const RESULT_FILE = "result.json"
export const EVENTS_FILE = "events.jsonl"
export const TOOL_RUNS_DIR = "tool-runs"
export const WORKERS_DIR = "workers"

/** The pentest record used this name before both modes shared `task.json`. */
export const LEGACY_ENGAGEMENT_FILE = "engagement.json"
/** Host-owned runtime state inside `work/`; kept where earlier versions wrote it. */
export const BOOM_STATE_DIR = ".boom"

/** Pre-migration event trails: CTF wrote one, pentest another. */
export const LEGACY_EVENTS_RELATIVE = path.join(WORK_DIR, EVENTS_FILE)
export const LEGACY_ACTIVITY_FILE = "agent-log.jsonl"
/** Pentest worker output used `work/tasks/<call-id>/` before the shared `work/workers/` rule. */
export const LEGACY_WORKERS_PATH = path.join(WORK_DIR, "tasks")

export function validTaskSlug(slug: string) {
  return (
    slug.trim() !== "" &&
    slug !== "." &&
    slug !== ".." &&
    !slug.includes("/") &&
    !slug.includes("\\") &&
    !slug.includes("\0") &&
    !slug.startsWith(".")
  )
}

export function assertTaskSlug(slug: string) {
  if (!validTaskSlug(slug)) throw new Error(`Invalid task slug: ${slug}`)
  return slug
}

/** `<root>/tasks` — the one tree every task lives in, in both modes. */
export function tasksRoot(root: string) {
  return path.join(path.resolve(root), TASKS_DIR)
}

/** `<root>/tasks/<slug>` — all tasks (CTF attempts, one pentest engagement) of one slug. */
export function taskSlugRoot(root: string, slug: string) {
  return path.join(tasksRoot(root), assertTaskSlug(slug))
}

/** `<root>/tasks/<slug>/<task-id>` — one task's workspace, also the agent's conversation root. */
export function taskDirectory(root: string, slug: string, taskID: string) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskID) || taskID === "." || taskID === "..")
    throw new Error(`Invalid task id: ${taskID}`)
  return path.join(taskSlugRoot(root, slug), taskID)
}

/** `<root>/runs/<slug>` — CTF task store of earlier versions, still read for existing runs. */
export function legacyRunsRoot(root: string) {
  return path.join(path.resolve(root), LEGACY_RUNS_DIR)
}

/** `<root>/engagements` — pentest store of earlier versions, still read for existing engagements. */
export function legacyEngagementsRoot(root: string) {
  return path.join(path.resolve(root), LEGACY_ENGAGEMENTS_DIR)
}

/** Task-relative paths, for prompts and record files that must stay portable. */
export function eventsRelativePath() {
  return path.join(RECORDS_DIR, EVENTS_FILE)
}

export function toolRunsRelativePath() {
  return path.join(RECORDS_DIR, TOOL_RUNS_DIR)
}

/**
 * `<UTC timestamp>-<model-slug>`, for example `20260728T121459Z-deepseek-v4-flash-free`.
 *
 * Seconds are included because runs of one challenge can start close together — a retry, or two
 * models on the same slug — and a collision would silently overwrite an existing workspace.
 */
let previousStamp = ""
let sameStampSequence = 0

export function runID(model: string, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  if (stamp === previousStamp) sameStampSequence += 1
  else {
    previousStamp = stamp
    sameStampSequence = 0
  }
  const collisionSuffix = sameStampSequence === 0 ? "" : `-${sameStampSequence + 1}`
  const rawModel = model.split(/[\\/]/).pop() || "model"
  const modelSlug = rawModel.replace(/[\0-\x1f/:\\]/g, "-").replace(/\.\./g, "-")
  return `${stamp}${collisionSuffix}-${modelSlug}`
}

async function realDirectory(target: string): Promise<boolean> {
  const info = await lstat(target).catch(() => undefined)
  return info !== undefined && info.isDirectory() && !info.isSymbolicLink()
}

/**
 * The task's read-only input directory. `input/` is the current name; `challenge/` is honored for
 * task directories written before the rename so old runs stay solvable and inspectable.
 */
export async function resolveInputDirectory(taskDirectory: string): Promise<string> {
  const current = path.join(taskDirectory, INPUT_DIR)
  if (await realDirectory(current)) return current
  const legacy = path.join(taskDirectory, LEGACY_INPUT_DIR)
  if (await realDirectory(legacy)) return legacy
  return current
}

/** The append-only event trail. New tasks write `records/events.jsonl`; old ones wrote under `work/`. */
export async function resolveEventsFile(taskDirectory: string): Promise<string> {
  const current = path.join(taskDirectory, eventsRelativePath())
  if (await realFile(current)) return current
  const legacy = path.join(taskDirectory, LEGACY_EVENTS_RELATIVE)
  if (await realFile(legacy)) return legacy
  return current
}

/** The tool-run directory of one task (pentest). Legacy tasks kept it at the task root. */
export async function resolveToolRunsDirectory(taskDirectory: string): Promise<string> {
  const current = path.join(taskDirectory, toolRunsRelativePath())
  if (await realDirectory(current)) return current
  const legacy = path.join(taskDirectory, TOOL_RUNS_DIR)
  if (await realDirectory(legacy)) return legacy
  return current
}

/** True when a directory looks like a Boom task workspace (current or legacy record present). */
export async function isTaskDirectory(directory: string): Promise<boolean> {
  if (!(await realDirectory(directory))) return false
  for (const name of [TASK_FILE, LEGACY_ENGAGEMENT_FILE, NOTES_FILE, RESULT_FILE]) {
    if (await realFile(path.join(directory, name))) return true
  }
  return false
}

async function realFile(target: string): Promise<boolean> {
  const info = await lstat(target).catch(() => undefined)
  return info !== undefined && info.isFile() && !info.isSymbolicLink()
}
