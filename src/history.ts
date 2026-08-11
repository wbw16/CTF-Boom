import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { loadCandidateSubmission } from "./candidate-submission.ts"
import {
  classifyVerification,
  findDeclaredCandidates,
  parseWriteup,
  type Outcome,
  type RunEvent,
} from "./session.ts"
import { parseTaskRecord, taskTotals, type TaskStatus, type TaskTurn } from "./task.ts"
import { loadTaskEnvironment, type TaskEnvironmentBinding } from "./environment.ts"

export type RunFile = {
  path: string
  size: number
  directory: boolean
}

export type RunHistory = {
  id: string
  model: string
  runtimeBackend?: string
  runtimeVersion?: string
  promptVersion?: string
  stop: string
  tokens: number
  billableTokens: number
  cost: number
  candidates: string[]
  primaryCandidate?: string
  alternatives: string[]
  candidateSource?: "regex" | "model" | "submission"
  verification?: Outcome["verification"]
  platformSubmission?: {
    adapter: string
    verdict: "accepted" | "rejected" | "pending"
    detail: string
    submittedAt: string
  }
  flagFormat: string
  reply: string
  detail?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  lastTool?: string
  events: RunEvent[]
  notes: string
  /** Durable final writeup, if this run has produced one. */
  writeup?: string
  files: RunFile[]
  taskStatus?: TaskStatus
  turns?: TaskTurn[]
  /** Every candidate observed in this durable task, including user-rejected values. */
  candidateHistory?: string[]
  rejectedFlags?: string[]
  confirmedFlag?: string
  acceptedFlag?: string
  consultation?: {
    trigger: string
    sourceRunID?: string
    expertModels: string[]
    synthesizerModel?: string
    tokens: number
    billableTokens: number
    cost: number
    plans: Array<{ model: string; text: string }>
    merged?: { model: string; text: string }
    degraded?: {
      reason: "insufficient-experts" | "synthesis-failed"
      detail: string
    }
  }
  contextPolicy?: {
    consultOnCompaction: boolean
    compactions: number
  }
  environment?: TaskEnvironmentBinding
}

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export async function canonicalDirectory(directory: string) {
  const resolved = await realpath(path.resolve(directory))
  if (!(await stat(resolved)).isDirectory()) throw new Error(`Not a directory: ${directory}`)
  return resolved
}

/** Resolve a path and reject both lexical traversal and symlink escapes. */
export async function assertPathWithin(base: string, target: string, allowMissing = false) {
  const resolvedBase = path.resolve(base)
  const canonicalBase = await canonicalDirectory(base)
  const resolved = path.resolve(target)
  if (!inside(resolvedBase, resolved)) throw new Error(`Path escapes ${resolvedBase}`)
  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(resolved)
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    let parent = path.dirname(resolved)
    while (true) {
      try {
        const canonicalParent = await realpath(parent)
        if (!inside(canonicalBase, canonicalParent)) throw new Error(`Path escapes ${canonicalBase}`)
        return resolved
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError
        const next = path.dirname(parent)
        if (next === parent) break
        parent = next
      }
    }
    throw new Error(`Cannot establish a safe parent for ${target}`)
  }
  if (!inside(canonicalBase, canonicalTarget)) throw new Error(`Path escapes ${canonicalBase}`)
  return canonicalTarget
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value !== ""))]
}

function verification(value: unknown): Outcome["verification"] | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as { level?: unknown; detail?: unknown }
  const levels = new Set(["remote", "local-checker", "offline-derivation", "unverified"])
  if (!levels.has(String(candidate.level)) || typeof candidate.detail !== "string") return undefined
  return candidate as NonNullable<Outcome["verification"]>
}

function platformSubmission(value: unknown): RunHistory["platformSubmission"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const adapter = string(input.adapter)
  const verdict = string(input.verdict)
  const detail = string(input.detail)
  const submittedAt = string(input.submittedAt) ?? string(input.submitted_at)
  if (
    !adapter ||
    (verdict !== "accepted" && verdict !== "rejected" && verdict !== "pending") ||
    !detail ||
    !submittedAt
  ) return undefined
  return { adapter, verdict, detail, submittedAt }
}

function consultation(value: unknown): RunHistory["consultation"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const trigger = string(input.trigger)
  if (!trigger) return undefined
  const plans = Array.isArray(input.plans)
    ? input.plans.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return []
        const plan = value as Record<string, unknown>
        const model = string(plan.model)
        const text = string(plan.text)
        return model && text ? [{ model, text }] : []
      })
    : []
  const rawMerged =
    input.merged && typeof input.merged === "object" && !Array.isArray(input.merged)
      ? (input.merged as Record<string, unknown>)
      : undefined
  const mergedModel = rawMerged ? string(rawMerged.model) : undefined
  const mergedText = rawMerged ? string(rawMerged.text) : undefined
  const rawDegraded =
    input.degraded && typeof input.degraded === "object" && !Array.isArray(input.degraded)
      ? (input.degraded as Record<string, unknown>)
      : undefined
  const degradedReason = rawDegraded ? string(rawDegraded.reason) : undefined
  const degradedDetail = rawDegraded ? string(rawDegraded.detail) : undefined
  return {
    trigger,
    sourceRunID: string(input.sourceRunID) ?? string(input.source_run_id),
    expertModels: strings(input.expertModels).length
      ? strings(input.expertModels)
      : strings(input.expert_models),
    synthesizerModel:
      string(input.synthesizerModel) ?? string(input.synthesizer_model),
    tokens: number(input.tokens),
    billableTokens:
      number(input.billableTokens) || number(input.billable_tokens),
    cost: number(input.cost),
    plans,
    merged:
      mergedModel && mergedText
        ? { model: mergedModel, text: mergedText }
        : undefined,
    degraded:
      (degradedReason === "insufficient-experts" || degradedReason === "synthesis-failed") &&
      degradedDetail
        ? { reason: degradedReason, detail: degradedDetail }
        : undefined,
  }
}

function contextPolicy(value: unknown): RunHistory["contextPolicy"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const consultOnCompaction = input.consultOnCompaction ?? input.consult_on_compaction
  const compactions = input.compactions
  if (typeof consultOnCompaction !== "boolean") return undefined
  return {
    consultOnCompaction,
    compactions: typeof compactions === "number" && Number.isFinite(compactions)
      ? Math.max(0, Math.floor(compactions))
      : 0,
  }
}

const RESULT_STOPS = new Set<Outcome["stop"]>([
  "completed",
  "budget",
  "stalled",
  "error",
  "empty",
  "timeout",
  "aborted",
  "silent",
  "blocked",
])
const EVENT_TYPES = new Set<RunEvent["type"]>(["session", "text", "tool", "usage", "retry", "status"])

function runTimestamp(id: string) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(?:(\d{2}))?Z/.exec(id)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second] = match
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second ?? "00"}Z`)
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString()
}

/**
 * Run directories are writable by the solving agent. Never follow one of its links while serving
 * history: even the fixed metadata names can otherwise be replaced with a link to an arbitrary
 * local file.
 */
async function readRunText(directory: string, relative: string) {
  const target = path.join(directory, relative)
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
    const safe = await assertPathWithin(directory, target)
    return await readFile(safe, "utf8")
  } catch {
    return undefined
  }
}

async function readEvents(directory: string) {
  const raw = (await readRunText(directory, path.join("work", "events.jsonl"))) ?? ""
  const events: RunEvent[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown> | null
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof parsed.at === "number" &&
        Number.isFinite(parsed.at) &&
        EVENT_TYPES.has(parsed.type as RunEvent["type"])
      ) {
        events.push({
          at: parsed.at,
          type: parsed.type as RunEvent["type"],
          ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
          ...(typeof parsed.tool === "string" ? { tool: parsed.tool } : {}),
          ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
          ...(typeof parsed.tokens === "number" && Number.isFinite(parsed.tokens) ? { tokens: parsed.tokens } : {}),
          ...(typeof parsed.billable === "number" && Number.isFinite(parsed.billable)
            ? { billable: parsed.billable }
            : {}),
          ...(typeof parsed.cost === "number" && Number.isFinite(parsed.cost) ? { cost: parsed.cost } : {}),
        })
      }
    } catch {
      // A partial final line after a crash must not hide the rest of the run.
    }
  }
  return events
}

async function listFiles(directory: string, base = "", output: RunFile[] = []): Promise<RunFile[]> {
  if (output.length >= 2_000) return output
  const entries = await readdir(path.join(directory, base), { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (output.length >= 2_000) break
    const relative = base === "" ? entry.name : `${base}/${entry.name}`
    const target = path.join(directory, relative)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      output.push({ path: relative, size: 0, directory: true })
      await listFiles(directory, relative, output)
    } else if (entry.isFile()) {
      output.push({ path: relative, size: (await stat(target).catch(() => ({ size: 0 }))).size, directory: false })
    }
  }
  return output
}

export async function readRunHistory(root: string, slug: string, runID: string): Promise<RunHistory> {
  const directory = await assertPathWithin(root, path.join(root, "runs", slug, runID))
  const resultFile = path.join(directory, "result.json")
  const raw = await readRunText(directory, "result.json")
  let result: Record<string, unknown> = {}
  let invalid: string | undefined
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("expected a JSON object")
      result = parsed as Record<string, unknown>
    } catch (error) {
      invalid = `invalid result.json: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const declaredRunID = string(result.runID) ?? string(result.run_id)
  if (declaredRunID !== undefined && declaredRunID !== runID)
    invalid ??= `invalid result.json: run_id does not match directory (${declaredRunID})`
  const declaredStop = string(result.stop)
  if (declaredStop !== undefined && !RESULT_STOPS.has(declaredStop as Outcome["stop"]))
    invalid ??= `invalid result.json: unknown stop value (${declaredStop})`

  const events = await readEvents(directory)
  const taskRaw = await readRunText(directory, "task.json")
  let task = undefined
  if (taskRaw) {
    try {
      task = parseTaskRecord(JSON.parse(taskRaw))
    } catch {
      // Invalid task metadata falls back to the legacy one-run result.
    }
  }
  const notes = (await readRunText(directory, "NOTES.md")) ?? ""
  const writeupText = (await readRunText(directory, path.join("work", "WRITEUP.md"))) ?? ""
  const writeup = parseWriteup(writeupText)
  const reply = string(result.reply) ?? ""
  const declaredReplyCandidates = findDeclaredCandidates(reply)
  const rejected = new Set(task?.rejectedFlags ?? [])
  const submission = await loadCandidateSubmission(directory).catch(() => undefined)
  const submittedCandidate = submission && !rejected.has(submission.flag)
    ? submission.flag
    : undefined
  const resultCandidates = strings(result.candidates)
  const candidates = resultCandidates.filter((candidate) => !rejected.has(candidate))
  const storedPrimary = string(result.primaryCandidate) ?? string(result.primary_candidate)
  const legacyPrimary = [storedPrimary, candidates[0], writeup.flag, declaredReplyCandidates.at(-1)]
    .find((candidate) => candidate !== undefined && !rejected.has(candidate))
  const primaryCandidate =
    submittedCandidate ?? legacyPrimary
  const alternatives =
    submittedCandidate
      ? []
      : strings(result.alternatives).length > 0
      ? strings(result.alternatives)
          .filter((candidate) => candidate !== primaryCandidate && !rejected.has(candidate))
      : candidates.filter((candidate) => candidate !== primaryCandidate)
  // result.json only describes the most recent turn. Keep an append-only view from task.json so
  // a candidate remains inspectable and copyable after it has been rejected or a later turn ends
  // without a flag. This is deliberately independent of the active-candidate filtering above.
  const candidateHistory = uniqueStrings([
    ...[...(task?.turns ?? [])]
      .reverse()
      .flatMap((turn) => [turn.primaryCandidate, ...turn.candidates]),
    submittedCandidate,
    submission?.flag,
    storedPrimary,
    ...resultCandidates,
    ...strings(result.alternatives),
    writeup.flag,
    ...declaredReplyCandidates,
    task?.acceptedFlag?.value,
    ...(task?.rejectedFlags ?? []),
  ])
  const runVerification =
    (submittedCandidate ? submission?.verification : undefined) ??
    verification(result.verification) ??
    (writeup.verification ? classifyVerification(writeup.verification) : undefined)
  const runPlatformSubmission = platformSubmission(
    result.platformSubmission ?? result.platform_submission,
  ) ?? (task?.acceptedFlag
    ? {
        adapter: task.acceptedFlag.source,
        verdict: "accepted" as const,
        detail: task.acceptedFlag.detail,
        submittedAt: task.acceptedFlag.acceptedAt,
      }
    : undefined)
  const startedAt =
    task?.createdAt ?? string(result.startedAt) ?? string(result.started_at) ?? runTimestamp(runID)
  const resultStat = raw === undefined ? undefined : await lstat(resultFile).catch(() => undefined)
  const finishedAt =
    string(result.finishedAt) ?? string(result.finished_at) ?? (resultStat ? resultStat.mtime.toISOString() : undefined)
  const duration =
    number(result.durationMs) ||
    number(result.duration_ms) ||
    (startedAt && finishedAt ? Math.max(0, new Date(finishedAt).valueOf() - new Date(startedAt).valueOf()) : 0)
  const lastTool =
    string(result.lastTool) ??
    string(result.last_tool) ??
    [...events].reverse().find((event) => event.tool)?.tool

  const totals = task ? taskTotals(task) : undefined
  const runConsultation = consultation(result.consultation)
  const runContextPolicy = contextPolicy(result.contextPolicy ?? result.context_policy)
  return {
    // The directory entry is the physical identity. result.json is agent-writable metadata and must
    // not be allowed to redirect later file-opening requests to another run.
    id: runID,
    model:
      task?.currentModel ??
      string(result.model) ??
      runID.replace(/^\d{8}T\d{4}(?:\d{2})?Z-(?:\d+-)?/, ""),
    runtimeBackend: string(result.runtimeBackend) ?? string(result.runtime_backend),
    runtimeVersion: string(result.runtimeVersion) ?? string(result.runtime_version),
    promptVersion: string(result.promptVersion) ?? string(result.prompt_version),
    stop: raw === undefined ? "interrupted" : invalid ? "error" : declaredStop ?? "interrupted",
    tokens: totals?.tokens ?? number(result.tokens),
    billableTokens:
      totals?.billableTokens ?? (number(result.billableTokens) || number(result.billable_tokens)),
    cost: totals?.cost ?? number(result.cost),
    candidates: submittedCandidate
      ? [submittedCandidate]
      : primaryCandidate && candidates.length === 0
        ? [primaryCandidate]
        : candidates,
    primaryCandidate,
    alternatives,
    candidateSource:
      submittedCandidate
        ? "submission"
        : result.candidateSource === "model" || result.candidateSource === "regex" || result.candidateSource === "submission"
        ? result.candidateSource
        : result.candidate_source === "model" || result.candidate_source === "regex" || result.candidate_source === "submission"
          ? result.candidate_source
          : primaryCandidate
            ? (string(result.flagFormat) ?? string(result.flag_format) ?? "").trim() === ""
              ? "model"
              : "regex"
            : undefined,
    verification: runVerification,
    platformSubmission: runPlatformSubmission,
    flagFormat: string(result.flagFormat) ?? string(result.flag_format) ?? "",
    reply,
    detail: invalid ?? string(result.detail),
    startedAt,
    finishedAt: task?.updatedAt ?? finishedAt,
    durationMs: duration || undefined,
    lastTool,
    events,
    notes,
    writeup: writeupText || undefined,
    files: await listFiles(directory),
    taskStatus: task?.status,
    turns: task?.turns,
    candidateHistory,
    rejectedFlags: task?.rejectedFlags,
    acceptedFlag: task?.acceptedFlag?.value,
    consultation: runConsultation,
    contextPolicy: runContextPolicy,
    environment: await loadTaskEnvironment(directory).catch(() => undefined),
  }
}

export async function readChallengeRuns(root: string, slug: string) {
  const directory = path.join(root, "runs", slug)
  const safe = await assertPathWithin(root, directory, true)
  const entries = await readdir(safe, { withFileTypes: true }).catch(() => [])
  const runs: RunHistory[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    try {
      runs.push(await readRunHistory(root, slug, entry.name))
    } catch {
      // A symlink escape or unreadable directory is excluded instead of exposing it.
    }
  }
  return runs.sort((a, b) => {
    const left = a.startedAt ? new Date(a.startedAt).valueOf() : 0
    const right = b.startedAt ? new Date(b.startedAt).valueOf() : 0
    return left - right || a.id.localeCompare(b.id)
  })
}

export async function appendRunEvent(directory: string, event: RunEvent) {
  const safeDirectory = await canonicalDirectory(directory)
  const work = path.join(safeDirectory, "work")
  await mkdir(work).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  })
  const workInfo = await lstat(work)
  if (!workInfo.isDirectory() || workInfo.isSymbolicLink())
    throw new Error(`Run work path is not a real directory: ${work}`)
  const safeWork = await assertPathWithin(safeDirectory, work)
  const target = path.join(safeWork, "events.jsonl")
  const existing = await lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`Run event log is not a real file: ${target}`)

  // O_NOFOLLOW closes the check/open race for the final path component. A solving agent controls
  // work/, so a normal appendFile() must never be allowed to follow an events.jsonl symlink.
  const handle = await open(
    target,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8")
  } finally {
    await handle.close()
  }
}

export async function writeRunResultAtomic(directory: string, result: Record<string, unknown>) {
  const target = path.join(directory, "result.json")
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(result, undefined, 2)}\n`, "utf8")
  await rename(temporary, target)
}
