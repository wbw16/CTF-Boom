import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { RuntimeMessage } from "./runtime-contract.ts"

export const CONSULTATION_HISTORY_PATH = "work/.boom/consultation-history.json"
const MAX_PERSISTED_HISTORY_BYTES = 16 * 1024 * 1024

export type ConsultationContext = {
  challenge: string
  work: string
  clues: string
}

export type ConsultationHistorySnapshot = {
  version: 1
  sessionID: string
  capturedAt: string
  messages: RuntimeMessage[]
}

function string(value: unknown, maximum: number) {
  return typeof value === "string" && value.length <= maximum && !value.includes("\0")
    ? value
    : undefined
}

function runtimeMessage(value: unknown): RuntimeMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const id = string(input.id, 512)
  const roles = new Set<RuntimeMessage["role"]>([
    "user",
    "assistant",
    "tool",
    "system",
    "synthetic",
    "compaction",
  ])
  if (!id || !roles.has(input.role as RuntimeMessage["role"]) || !Array.isArray(input.parts))
    return undefined
  const parts = input.parts.slice(0, 1_000).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const part = value as Record<string, unknown>
    const type = string(part.type, 128)
    if (!type) return []
    const state = new Set(["pending", "running", "completed", "error"]).has(String(part.state))
      ? part.state as "pending" | "running" | "completed" | "error"
      : undefined
    return [{
      type,
      ...(string(part.text, 256_000) ? { text: string(part.text, 256_000) } : {}),
      ...(string(part.tool, 512) ? { tool: string(part.tool, 512) } : {}),
      ...(string(part.callID, 512) ? { callID: string(part.callID, 512) } : {}),
      ...(state ? { state } : {}),
      ...(string(part.input, 128_000) ? { input: string(part.input, 128_000) } : {}),
      ...(string(part.output, 512_000) ? { output: string(part.output, 512_000) } : {}),
      ...(string(part.error, 64_000) ? { error: string(part.error, 64_000) } : {}),
    }]
  })
  return {
    id,
    role: input.role as RuntimeMessage["role"],
    ...(typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
      ? { createdAt: input.createdAt }
      : {}),
    parts,
  }
}

/** Conservative provider-neutral estimate used only to bound consultation input. */
export function estimateRuntimeMessageTokens(message: RuntimeMessage) {
  return Math.max(1, Math.ceil(JSON.stringify(message).length / 4))
}

function completeRounds(messages: RuntimeMessage[]) {
  const rounds: RuntimeMessage[][] = []
  let current: RuntimeMessage[] = []
  for (const message of messages) {
    const startsRound = message.role !== "assistant" && message.role !== "tool"
    if (startsRound && current.length > 0) {
      rounds.push(current)
      current = []
    }
    current.push(message)
  }
  if (current.length > 0) rounds.push(current)
  // A corrupt or partial snapshot that begins with only tool results is not a complete API round.
  return rounds.filter((round) => round.some((message) => message.role !== "tool"))
}

/**
 * Keep the newest complete API rounds that fit. Messages and tool-bearing assistant records are never
 * sliced, so a consultation cannot receive a half JSON value or an orphaned tail from one round.
 */
export function trimHistoryToCompleteRounds(messages: RuntimeMessage[], tokenBudget: number) {
  const limit = Math.max(0, Math.floor(tokenBudget))
  const rounds = completeRounds(messages)
  const selected: RuntimeMessage[][] = []
  let tokens = 0
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index]!
    const roundTokens = round.reduce((sum, message) => sum + estimateRuntimeMessageTokens(message), 0)
    if (roundTokens > limit - tokens) break
    selected.unshift(round)
    tokens += roundTokens
  }
  return {
    messages: selected.flat(),
    tokens,
    omittedRounds: rounds.length - selected.length,
  }
}

async function stateDirectory(directory: string, create: boolean) {
  const run = await realpath(path.resolve(directory))
  const work = await realpath(path.join(run, "work"))
  const relative = path.relative(run, work)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Consultation history work directory escapes the run")
  const state = path.join(work, ".boom")
  const existing = await lstat(state).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory()))
    throw new Error("Consultation history state directory is not a real directory")
  if (!existing && !create) return undefined
  if (!existing) await mkdir(state, { mode: 0o700 })
  const resolved = await realpath(state)
  const stateRelative = path.relative(work, resolved)
  if (stateRelative.startsWith("..") || path.isAbsolute(stateRelative))
    throw new Error("Consultation history state directory escapes work")
  return resolved
}

export async function persistConsultationHistory(input: {
  directory: string
  sessionID: string
  messages: RuntimeMessage[]
}) {
  const state = await stateDirectory(input.directory, true)
  if (!state) throw new Error("Failed to create consultation history state directory")
  const target = path.join(state, "consultation-history.json")
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
    throw new Error("Consultation history is not a real file")
  const snapshot: ConsultationHistorySnapshot = {
    version: 1,
    sessionID: input.sessionID,
    capturedAt: new Date().toISOString(),
    messages: input.messages,
  }
  const body = `${JSON.stringify(snapshot, undefined, 2)}\n`
  if (Buffer.byteLength(body) > MAX_PERSISTED_HISTORY_BYTES)
    throw new Error("Consultation history exceeds the persisted snapshot limit")
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, target)
  return CONSULTATION_HISTORY_PATH
}

export async function loadConsultationHistory(directory: string) {
  const state = await stateDirectory(directory, false)
  if (!state) return undefined
  const target = path.join(state, "consultation-history.json")
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return undefined
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Consultation history is not a real file")
  if (info.size > MAX_PERSISTED_HISTORY_BYTES)
    throw new Error("Consultation history exceeds the persisted snapshot limit")
  const value = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>
  const sessionID = string(value.sessionID, 512)
  const capturedAt = string(value.capturedAt, 64)
  if (value.version !== 1 || !sessionID || !capturedAt || !Array.isArray(value.messages))
    throw new Error("Consultation history has an invalid shape")
  const messages = value.messages.flatMap((message) => runtimeMessage(message) ?? [])
  if (messages.length !== value.messages.length)
    throw new Error("Consultation history contains an invalid runtime message")
  return {
    version: 1,
    sessionID,
    capturedAt,
    messages,
  } satisfies ConsultationHistorySnapshot
}
