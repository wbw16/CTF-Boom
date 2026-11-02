import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Outcome } from "./session.ts"
import { parseExperiment, type ExperimentRecord } from "./experiment.ts"

export type TaskStatus = "active" | "paused" | "candidate-found" | "solved" | "archived" | "given-up"

export type TaskTurn = {
  id: string
  model: string
  prompt?: string
  startedAt: string
  finishedAt: string
  stop: Outcome["stop"]
  tokens: number
  billableTokens: number
  cost: number
  candidates: string[]
  primaryCandidate?: string
  detail?: string
  finish?: Outcome["finish"]
  rawFinish?: string
  purpose?: "solve" | "writeup"
  tier?: "economy" | "strong"
}

export type TaskRecovery = {
  fingerprint: string
  consecutiveFailures: number
  lastFailureAt: string
  retryAt: string
  blocked: boolean
}

export type TaskRecord = {
  version: 1
  id: string
  slug: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  currentModel: string
  rejectedFlags: string[]
  recovery?: TaskRecovery
  experiment?: ExperimentRecord
  acceptedFlag?: {
    value: string
    source: string
    detail: string
    acceptedAt: string
  }
  turns: TaskTurn[]
}

type TaskSeed = {
  id: string
  slug: string
  model: string
  createdAt?: string
  legacyTurn?: TaskTurn
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function parseTurn(value: unknown): TaskTurn | undefined {
  if (!isObject(value)) return undefined
  if (
    typeof value.id !== "string" ||
    typeof value.model !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.finishedAt !== "string" ||
    !["completed", "budget", "stalled", "error", "empty", "timeout", "aborted", "silent", "blocked", "switched"].includes(String(value.stop))
  )
    return undefined
  return {
    id: value.id,
    model: value.model,
    ...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    stop: value.stop as Outcome["stop"],
    tokens: number(value.tokens),
    billableTokens: number(value.billableTokens),
    cost: number(value.cost),
    candidates: strings(value.candidates),
    ...(typeof value.primaryCandidate === "string" ? { primaryCandidate: value.primaryCandidate } : {}),
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    ...(["stop", "length", "tool-calls", "content-filter", "cancelled", "error", "empty", "unknown"].includes(String(value.finish))
      ? { finish: value.finish as Outcome["finish"] } : {}),
    ...(typeof value.rawFinish === "string" ? { rawFinish: value.rawFinish.slice(0, 160) } : {}),
    ...(value.purpose === "solve" || value.purpose === "writeup" ? { purpose: value.purpose } : {}),
    ...(value.tier === "economy" || value.tier === "strong" ? { tier: value.tier } : {}),
  }
}

export function parseTaskRecord(value: unknown): TaskRecord | undefined {
  if (!isObject(value)) return undefined
  const experiment = parseExperiment(value.experiment)
  const statuses = new Set<TaskStatus>([
    "active",
    "paused",
    "candidate-found",
    "solved",
    "archived",
    "given-up",
  ])
  if (
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.status !== "string" ||
    !statuses.has(value.status as TaskStatus) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.currentModel !== "string"
  )
    return undefined
  return {
    version: 1,
    id: value.id,
    slug: value.slug,
    status: value.status as TaskStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    currentModel: value.currentModel,
    rejectedFlags: strings(value.rejectedFlags),
    ...(experiment ? { experiment } : {}),
    ...(isObject(value.recovery) &&
      typeof value.recovery.fingerprint === "string" &&
      Number.isSafeInteger(value.recovery.consecutiveFailures) && number(value.recovery.consecutiveFailures) > 0 &&
      typeof value.recovery.lastFailureAt === "string" && Number.isFinite(Date.parse(value.recovery.lastFailureAt)) &&
      typeof value.recovery.retryAt === "string" && Number.isFinite(Date.parse(value.recovery.retryAt)) &&
      typeof value.recovery.blocked === "boolean"
      ? { recovery: {
          fingerprint: value.recovery.fingerprint,
          consecutiveFailures: number(value.recovery.consecutiveFailures),
          lastFailureAt: value.recovery.lastFailureAt,
          retryAt: value.recovery.retryAt,
          blocked: value.recovery.blocked,
        } } : {}),
    ...(isObject(value.acceptedFlag) &&
    typeof value.acceptedFlag.value === "string" &&
    typeof value.acceptedFlag.source === "string" &&
    typeof value.acceptedFlag.detail === "string" &&
    typeof value.acceptedFlag.acceptedAt === "string"
      ? {
          acceptedFlag: {
            value: value.acceptedFlag.value,
            source: value.acceptedFlag.source,
            detail: value.acceptedFlag.detail,
            acceptedAt: value.acceptedFlag.acceptedAt,
          },
        }
      : {}),
    turns: Array.isArray(value.turns) ? value.turns.flatMap((turn) => parseTurn(turn) ?? []) : [],
  }
}

async function readRealFile(file: string) {
  const info = await lstat(file).catch(() => undefined)
  if (!info || !info.isFile() || info.isSymbolicLink()) return undefined
  return readFile(file, "utf8")
}

export async function loadTaskRecord(directory: string) {
  const raw = await readRealFile(path.join(directory, "task.json"))
  if (!raw) return undefined
  try {
    return parseTaskRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

const taskWrites = new Map<string, Promise<unknown>>()

function withTaskLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory)
  const pending = (taskWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
  taskWrites.set(key, pending)
  void pending.finally(() => {
    if (taskWrites.get(key) === pending) taskWrites.delete(key)
  }).catch(() => {})
  return pending
}

/** Read and mutate the latest task under the same lock used by operator actions and turn writes. */
export function updateTaskRecord(
  directory: string,
  update: (task: TaskRecord) => TaskRecord | Promise<TaskRecord>,
) {
  return withTaskLock(directory, async () => {
    const current = await loadTaskRecord(directory)
    if (!current) throw new Error("This run has no task metadata")
    const identity = { id: current.id, slug: current.slug }
    const next = await update(current)
    if (next.id !== identity.id || next.slug !== identity.slug)
      throw new Error("Task updates cannot change workspace identity")
    await writeTaskRecord(directory, next)
    return next
  })
}

export function loadOrCreateTask(directory: string, seed: TaskSeed) {
  return withTaskLock(directory, () => createTaskIfMissing(directory, seed))
}

async function createTaskIfMissing(directory: string, seed: TaskSeed) {
  const existing = await loadTaskRecord(directory)
  if (existing) {
    if (existing.id !== seed.id || existing.slug !== seed.slug)
      throw new Error("task.json identity does not match its workspace")
    return existing
  }
  if (await lstat(path.join(directory, "task.json")).catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })) throw new Error("task.json is unreadable or invalid; refusing to replace existing task history")
  const now = new Date().toISOString()
  const turns = seed.legacyTurn ? [seed.legacyTurn] : []
  const task: TaskRecord = {
    version: 1,
    id: seed.id,
    slug: seed.slug,
    status: seed.legacyTurn?.candidates.length ? "candidate-found" : "paused",
    createdAt: seed.createdAt ?? seed.legacyTurn?.startedAt ?? now,
    updatedAt: now,
    currentModel: seed.model,
    rejectedFlags: [],
    turns,
  }
  await writeTaskRecord(directory, task)
  return task
}

export function saveTaskRecord(directory: string, task: TaskRecord) {
  return withTaskLock(directory, () => writeTaskRecord(directory, task))
}

async function writeTaskRecord(directory: string, task: TaskRecord) {
  const target = path.join(directory, "task.json")
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`Task metadata is not a real file: ${target}`)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(task, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export function taskTotals(task: TaskRecord) {
  return task.turns.reduce(
    (total, turn) => ({
      tokens: total.tokens + turn.tokens,
      billableTokens: total.billableTokens + turn.billableTokens,
      cost: total.cost + turn.cost,
    }),
    { tokens: 0, billableTokens: 0, cost: 0 },
  )
}

export async function archiveTask(directory: string) {
  return updateTaskRecord(directory, (task) => ({ ...task, status: "archived", updatedAt: new Date().toISOString() }))
}

export async function acceptTaskFlag(input: {
  directory: string
  flag: string
  source: string
  detail: string
}) {
  return updateTaskRecord(input.directory, (task) => {
    task.acceptedFlag = {
      value: input.flag,
      source: input.source,
      detail: input.detail,
      acceptedAt: new Date().toISOString(),
    }
    // A user can correct an earlier manual rejection. The candidate itself remains in the durable
    // turn history; only its current rejection state is cleared.
    task.rejectedFlags = task.rejectedFlags.filter((flag) => flag !== input.flag)
    task.status = "solved"
    task.updatedAt = task.acceptedFlag.acceptedAt
    return task
  })
}

export async function rejectTaskFlag(
  directory: string,
  flag: string,
  detail = "user confirmed incorrect",
) {
  return updateTaskRecord(directory, async (task) => {
    if (!task.rejectedFlags.includes(flag)) task.rejectedFlags.push(flag)
    if (task.acceptedFlag?.value === flag) delete task.acceptedFlag
    task.status = task.acceptedFlag ? "solved" : "paused"
    task.updatedAt = new Date().toISOString()

    const notesPath = path.join(directory, "NOTES.md")
    const notesInfo = await lstat(notesPath).catch(() => undefined)
    if (!notesInfo || !notesInfo.isFile() || notesInfo.isSymbolicLink())
      throw new Error("NOTES.md is not a real file")
    const notes = await readFile(notesPath, "utf8")
    const marker = `- \`${flag.replace(/`/g, "\\`")}\`（${detail.replace(/[\r\n]+/g, " ")}）`
    if (!notes.includes(marker)) {
      const heading = "## User-rejected flags"
      const next = notes.includes(heading)
        ? `${notes.trimEnd()}\n${marker}\n`
        : `${notes.trimEnd()}\n\n${heading}\n\n${marker}\n`
      const temporary = `${notesPath}.${process.pid}.${crypto.randomUUID()}.tmp`
      await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 })
      await rename(temporary, notesPath)
    }
    return task
  })
}
