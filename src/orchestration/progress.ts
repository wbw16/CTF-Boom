import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { discoverKeyArtifacts } from "./artifacts.ts"
import type { Outcome, RunEvent } from "../session.ts"

export type MeaningfulProgressKind =
  | "artifact"
  | "durable-note"
  | "tool-result"
  | "phase"
  | "candidate"

export type MeaningfulProgressEvent = {
  id: string
  at: string
  kind: MeaningfulProgressKind
  fingerprint: string
  detail: string
  billableAtEvent: number
  durable: boolean
}

export type AutonomyEscalationSummary = {
  id: string
  fingerprint: string
  level: 1 | 2 | 3
  status: "running" | "completed" | "partial" | "failed" | "cancelled"
  reason: string
  startedAt: string
  finishedAt?: string
  artifactPath?: string
  tokens: number
  billable: number
  cost: number
}

export type AutonomyState = {
  version: 1
  startedAt: string
  lastProgressAt: string
  billableAtLastProgress: number
  progressEpoch: string
  meaningfulEvents: MeaningfulProgressEvent[]
  successfulToolFingerprints: string[]
  consecutiveNormalYieldsWithoutDurableProgress: number
  automaticContinuationUsedAt?: string
  escalations: AutonomyEscalationSummary[]
}

export type ProgressSnapshot = {
  capturedAt: string
  artifacts: Record<string, string>
  artifactModifiedAt: Record<string, number>
  notesHash?: string
  notesModifiedAt?: number
}

export type TurnProgress = {
  events: MeaningfulProgressEvent[]
  meaningful: boolean
  durable: boolean
  normalYieldWithoutCandidate: boolean
  consecutiveNormalYieldsWithoutDurableProgress: number
  fingerprint: string
  state: AutonomyState
}

const MAX_EVENTS = 512
const MAX_TOOL_FINGERPRINTS = 2_048

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function autonomyPath(directory: string) {
  const root = await realpath(directory)
  const targetDirectory = path.join(root, "work", ".boom")
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  const info = await lstat(targetDirectory)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Autonomy state path is not a real directory")
  const canonical = await realpath(targetDirectory)
  if (!inside(root, canonical)) throw new Error("Autonomy state path escapes task workspace")
  return path.join(canonical, "autonomy.json")
}

function parseEscalation(value: unknown): AutonomyEscalationSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Partial<AutonomyEscalationSummary>
  if (
    typeof input.id !== "string" ||
    typeof input.fingerprint !== "string" ||
    ![1, 2, 3].includes(Number(input.level)) ||
    !["running", "completed", "partial", "failed", "cancelled"].includes(String(input.status)) ||
    typeof input.reason !== "string" ||
    typeof input.startedAt !== "string"
  ) return undefined
  return {
    id: input.id,
    fingerprint: input.fingerprint,
    level: input.level as 1 | 2 | 3,
    status: input.status as AutonomyEscalationSummary["status"],
    reason: input.reason,
    startedAt: input.startedAt,
    ...(typeof input.finishedAt === "string" ? { finishedAt: input.finishedAt } : {}),
    ...(typeof input.artifactPath === "string" ? { artifactPath: input.artifactPath } : {}),
    tokens: typeof input.tokens === "number" && Number.isFinite(input.tokens) ? Math.max(0, input.tokens) : 0,
    billable: typeof input.billable === "number" && Number.isFinite(input.billable) ? Math.max(0, input.billable) : 0,
    cost: typeof input.cost === "number" && Number.isFinite(input.cost) ? Math.max(0, input.cost) : 0,
  }
}

function parseProgressEvent(value: unknown): MeaningfulProgressEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Partial<MeaningfulProgressEvent>
  if (
    typeof input.id !== "string" ||
    typeof input.at !== "string" ||
    !["artifact", "durable-note", "tool-result", "phase", "candidate"].includes(String(input.kind)) ||
    typeof input.fingerprint !== "string" ||
    typeof input.detail !== "string" ||
    typeof input.durable !== "boolean"
  ) return undefined
  return {
    id: input.id,
    at: input.at,
    kind: input.kind as MeaningfulProgressKind,
    fingerprint: input.fingerprint,
    detail: input.detail,
    billableAtEvent:
      typeof input.billableAtEvent === "number" && Number.isFinite(input.billableAtEvent)
        ? Math.max(0, input.billableAtEvent)
        : 0,
    durable: input.durable,
  }
}

function initialState(now = Date.now()): AutonomyState {
  const startedAt = new Date(now).toISOString()
  return {
    version: 1,
    startedAt,
    lastProgressAt: startedAt,
    billableAtLastProgress: 0,
    progressEpoch: hash(`initial\0${startedAt}`).slice(0, 20),
    meaningfulEvents: [],
    successfulToolFingerprints: [],
    consecutiveNormalYieldsWithoutDurableProgress: 0,
    escalations: [],
  }
}

function parseState(value: unknown, now = Date.now()): AutonomyState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return initialState(now)
  const input = value as Partial<AutonomyState>
  if (input.version !== 1 || typeof input.startedAt !== "string") return initialState(now)
  const fallbackEpoch = hash(`initial\0${input.startedAt}`).slice(0, 20)
  return {
    version: 1,
    startedAt: input.startedAt,
    lastProgressAt: typeof input.lastProgressAt === "string" ? input.lastProgressAt : input.startedAt,
    billableAtLastProgress:
      typeof input.billableAtLastProgress === "number" && Number.isFinite(input.billableAtLastProgress)
        ? Math.max(0, input.billableAtLastProgress)
        : 0,
    progressEpoch: typeof input.progressEpoch === "string" ? input.progressEpoch : fallbackEpoch,
    meaningfulEvents: Array.isArray(input.meaningfulEvents)
      ? input.meaningfulEvents.flatMap((item) => parseProgressEvent(item) ?? []).slice(-MAX_EVENTS)
      : [],
    successfulToolFingerprints: Array.isArray(input.successfulToolFingerprints)
      ? input.successfulToolFingerprints.filter((item): item is string => typeof item === "string").slice(-MAX_TOOL_FINGERPRINTS)
      : [],
    consecutiveNormalYieldsWithoutDurableProgress:
      typeof input.consecutiveNormalYieldsWithoutDurableProgress === "number" &&
      Number.isFinite(input.consecutiveNormalYieldsWithoutDurableProgress)
        ? Math.max(0, Math.floor(input.consecutiveNormalYieldsWithoutDurableProgress))
        : 0,
    ...(typeof input.automaticContinuationUsedAt === "string"
      ? { automaticContinuationUsedAt: input.automaticContinuationUsedAt }
      : {}),
    escalations: Array.isArray(input.escalations)
      ? input.escalations.flatMap((item) => parseEscalation(item) ?? []).slice(-64)
      : [],
  }
}

export async function loadAutonomyState(directory: string, now = Date.now()) {
  const target = await autonomyPath(directory)
  const info = await lstat(target).catch(() => undefined)
  if (!info || !info.isFile() || info.isSymbolicLink()) return initialState(now)
  return readFile(target, "utf8")
    .then((text) => parseState(JSON.parse(text), now))
    .catch(() => initialState(now))
}

export async function loadOrCreateAutonomyState(directory: string, now = Date.now()) {
  const target = await autonomyPath(directory)
  const info = await lstat(target).catch(() => undefined)
  if (info?.isFile() && !info.isSymbolicLink()) return loadAutonomyState(directory, now)
  return saveAutonomyState(directory, initialState(now))
}

export async function saveAutonomyState(directory: string, state: AutonomyState) {
  const target = await autonomyPath(directory)
  const normalized = parseState(state)
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error("Autonomy state is not a real file")
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(normalized, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
  return normalized
}

async function fileHash(file: string) {
  const content = await readFile(file)
  return hash(content.toString("base64"))
}

export async function captureProgressSnapshot(directory: string): Promise<ProgressSnapshot> {
  const root = await realpath(directory)
  const discovered = await discoverKeyArtifacts(root)
  const artifacts = Object.fromEntries(discovered.map((item) => [item.path, item.sha256 ?? ""]))
  const artifactModifiedAt = Object.fromEntries(await Promise.all(
    discovered.map(async (item) => [
      item.path,
      await lstat(path.join(root, item.path)).then((info) => info.mtimeMs).catch(() => Date.now()),
    ] as const),
  ))
  const notes = path.join(root, "NOTES.md")
  const notesInfo = await lstat(notes).catch(() => undefined)
  return {
    capturedAt: new Date().toISOString(),
    artifacts,
    artifactModifiedAt,
    ...(notesInfo?.isFile() && !notesInfo.isSymbolicLink()
      ? { notesHash: await fileHash(notes), notesModifiedAt: notesInfo.mtimeMs }
      : {}),
  }
}

function progressEvent(input: {
  kind: MeaningfulProgressKind
  detail: string
  billable: number
  durable: boolean
  at: number
}) {
  const fingerprint = hash(`${input.kind}\0${input.detail}`).slice(0, 20)
  return {
    id: `progress-${input.at}-${fingerprint.slice(0, 8)}`,
    at: new Date(input.at).toISOString(),
    kind: input.kind,
    fingerprint,
    detail: input.detail.slice(0, 2_000),
    billableAtEvent: Math.max(0, input.billable),
    durable: input.durable,
  } satisfies MeaningfulProgressEvent
}

function completedToolFingerprints(events: RunEvent[]) {
  return events.flatMap((event) =>
    event.type === "tool" && event.status === "completed" && event.tool
      ? [{
          fingerprint: hash(`${event.tool}\0${event.text ?? "completed"}`).slice(0, 20),
          at: event.at,
        }]
      : [],
  )
}

export async function recordTurnProgress(input: {
  directory: string
  before: ProgressSnapshot
  after?: ProgressSnapshot
  outcome: Outcome
  events: RunEvent[]
  cumulativeBillable: number
  now?: number
}) : Promise<TurnProgress> {
  const now = input.now ?? Date.now()
  const after = input.after ?? await captureProgressSnapshot(input.directory)
  const state = await loadAutonomyState(input.directory, now)
  const additions: MeaningfulProgressEvent[] = []

  for (const [artifactPath, artifactHash] of Object.entries(after.artifacts)) {
    if (input.before.artifacts[artifactPath] === artifactHash) continue
    additions.push(progressEvent({
      kind: "artifact",
      detail: `${artifactPath}:${artifactHash}`,
      billable: input.cumulativeBillable,
      durable: true,
      at: Math.min(now, after.artifactModifiedAt[artifactPath] ?? now),
    }))
  }

  const durableNoteCall = input.events.some((event) =>
    event.type === "tool" &&
    event.tool === "ctf-note" &&
    event.status === "completed" &&
    /(?:note|ruled-out|checkpoint)/i.test(event.text ?? ""),
  )
  if (durableNoteCall && after.notesHash && after.notesHash !== input.before.notesHash) {
    additions.push(progressEvent({
      kind: "durable-note",
      detail: `NOTES.md:${after.notesHash}`,
      billable: input.cumulativeBillable,
      durable: true,
      at: Math.min(now, after.notesModifiedAt ?? now),
    }))
  }

  if (input.outcome.candidates.length > 0) {
    additions.push(progressEvent({
      kind: "candidate",
      detail: `candidate-count:${input.outcome.candidates.length}`,
      billable: input.cumulativeBillable,
      durable: true,
      at: now,
    }))
  }

  const knownTools = new Set(state.successfulToolFingerprints)
  for (const toolResult of completedToolFingerprints(input.events)) {
    if (knownTools.has(toolResult.fingerprint)) continue
    knownTools.add(toolResult.fingerprint)
    additions.push(progressEvent({
      kind: "tool-result",
      detail: toolResult.fingerprint,
      billable: input.cumulativeBillable,
      durable: false,
      at: Math.min(now, toolResult.at),
    }))
  }

  const unique = additions.filter((event, index) =>
    additions.findIndex((candidate) => candidate.fingerprint === event.fingerprint) === index &&
    !state.meaningfulEvents.some((candidate) => candidate.fingerprint === event.fingerprint),
  )
  const durable = unique.some((event) => event.durable)
  const meaningful = unique.length > 0
  if (meaningful) {
    state.lastProgressAt = new Date(Math.max(
      ...unique.map((event) => new Date(event.at).valueOf()).filter(Number.isFinite),
    )).toISOString()
    state.billableAtLastProgress = Math.max(0, input.cumulativeBillable)
    state.progressEpoch = hash(
      `${state.progressEpoch}\0${unique.map((event) => event.fingerprint).sort().join("\0")}`,
    ).slice(0, 20)
  }
  const normalYieldWithoutCandidate =
    input.outcome.stop === "completed" && input.outcome.candidates.length === 0
  if (normalYieldWithoutCandidate && !durable)
    state.consecutiveNormalYieldsWithoutDurableProgress += 1
  else if (durable || input.outcome.candidates.length > 0)
    state.consecutiveNormalYieldsWithoutDurableProgress = 0

  state.meaningfulEvents = [...state.meaningfulEvents, ...unique].slice(-MAX_EVENTS)
  state.successfulToolFingerprints = [...knownTools].slice(-MAX_TOOL_FINGERPRINTS)
  const saved = await saveAutonomyState(input.directory, state)
  return {
    events: unique,
    meaningful,
    durable,
    normalYieldWithoutCandidate,
    consecutiveNormalYieldsWithoutDurableProgress:
      saved.consecutiveNormalYieldsWithoutDurableProgress,
    fingerprint: saved.progressEpoch,
    state: saved,
  }
}

export function activeSolveTimeMs(turns: Array<{ startedAt: string; finishedAt: string }>) {
  return turns.reduce((total, turn) => {
    const duration = new Date(turn.finishedAt).valueOf() - new Date(turn.startedAt).valueOf()
    return total + (Number.isFinite(duration) ? Math.max(0, duration) : 0)
  }, 0)
}

export function hasProductiveLongRunningTool(events: RunEvent[], now = Date.now()) {
  let runningAt: number | undefined
  let settled = true
  let activityAt = 0
  for (const event of events) {
    if (event.type === "tool" && (event.status === "running" || event.status === "pending")) {
      runningAt = event.at
      settled = false
    } else if (event.type === "tool" && ["completed", "error"].includes(event.status ?? "")) {
      settled = true
    }
    if (!settled && (event.type === "text" || event.type === "usage" || event.type === "tool"))
      activityAt = Math.max(activityAt, event.at)
  }
  return !settled && runningAt !== undefined && now - Math.max(runningAt, activityAt) < 60_000
}

export async function markAutomaticContinuation(directory: string, now = Date.now()) {
  const state = await loadAutonomyState(directory, now)
  state.automaticContinuationUsedAt ??= new Date(now).toISOString()
  return saveAutonomyState(directory, state)
}

export async function startEscalation(input: {
  directory: string
  fingerprint: string
  level: 1 | 2 | 3
  reason: string
  now?: number
}) {
  const now = input.now ?? Date.now()
  const state = await loadAutonomyState(input.directory, now)
  const record: AutonomyEscalationSummary = {
    id: `escalation-${now}-${crypto.randomUUID().slice(0, 8)}`,
    fingerprint: input.fingerprint,
    level: input.level,
    status: "running",
    reason: input.reason.slice(0, 2_000),
    startedAt: new Date(now).toISOString(),
    tokens: 0,
    billable: 0,
    cost: 0,
  }
  state.escalations.push(record)
  await saveAutonomyState(input.directory, state)
  return record
}

export async function finishEscalation(input: {
  directory: string
  id: string
  status: Exclude<AutonomyEscalationSummary["status"], "running">
  artifactPath?: string
  tokens: number
  billable: number
  cost: number
  now?: number
}) {
  const now = input.now ?? Date.now()
  const state = await loadAutonomyState(input.directory, now)
  const record = state.escalations.find((item) => item.id === input.id)
  if (!record) throw new Error(`No such autonomy escalation: ${input.id}`)
  record.status = input.status
  record.finishedAt = new Date(now).toISOString()
  if (input.artifactPath) record.artifactPath = input.artifactPath
  record.tokens = Math.max(0, input.tokens)
  record.billable = Math.max(0, input.billable)
  record.cost = Math.max(0, input.cost)
  await saveAutonomyState(input.directory, state)
  return record
}
