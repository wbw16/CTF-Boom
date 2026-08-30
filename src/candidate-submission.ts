import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export const CANDIDATE_SUBMISSION_PATH = "work/RESULT.json"

type VerificationLevel = "remote" | "local-checker" | "offline-derivation" | "unverified"

export type CandidateSubmission = {
  version: 1
  status: "ready"
  sessionID: string
  flag: string
  verification?: {
    level: VerificationLevel
    detail: string
  }
  writeup: "work/WRITEUP.md"
  recordedAt: string
  /** Set when a gate evaluation has already taken this slot; a consumed slot is never re-offered. */
  consumedAt?: string
}

const LEVELS = new Set<VerificationLevel>([
  "remote",
  "local-checker",
  "offline-derivation",
  "unverified",
])

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function requiredLine(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  const result = value.trim()
  if (!result || result.length > maximum || /[\0\r\n]/.test(result))
    throw new Error(`${name} must be one non-empty line of at most ${maximum} characters`)
  return result
}

async function resultPaths(directory: string) {
  const runRoot = await realpath(path.resolve(directory))
  const workRoot = await realpath(path.join(runRoot, "work"))
  if (!inside(runRoot, workRoot)) throw new Error("Result work directory escapes the run")
  return {
    target: path.join(workRoot, "RESULT.json"),
    legacy: path.join(workRoot, ".boom", "candidate.json"),
  }
}

function parseCandidateSubmission(value: unknown): CandidateSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Result must be a JSON object")
  const input = value as Record<string, unknown>
  const verification = input.verification
  const checked = verification && typeof verification === "object" && !Array.isArray(verification)
    ? verification as Record<string, unknown>
    : undefined
  const level = checked?.level
  if (level !== undefined && !LEVELS.has(level as VerificationLevel))
    throw new Error("Result has an invalid verification level")
  const recordedAt = requiredLine(input.recordedAt ?? input.submittedAt, "recordedAt", 64)
  if (!Number.isFinite(new Date(recordedAt).valueOf()))
    throw new Error("Result has an invalid recordedAt")
  return {
    version: 1,
    status: "ready",
    sessionID: requiredLine(input.sessionID, "sessionID", 512),
    flag: requiredLine(input.flag ?? input.candidate, "flag", 4_096),
    ...(checked && level !== undefined
      ? {
          verification: {
            level: level as VerificationLevel,
            detail: requiredLine(checked.detail, "verification detail", 4_096),
          },
        }
      : {}),
    writeup: "work/WRITEUP.md",
    recordedAt,
    // Presence alone blocks reuse, so any non-empty value is passed through even if unparseable as a
    // date: dropping it would silently resurrect an already-consumed submission.
    ...(typeof input.consumedAt === "string" && input.consumedAt.trim()
      ? { consumedAt: input.consumedAt }
      : {}),
  }
}

export async function loadCandidateSubmission(directory: string) {
  const paths = await resultPaths(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!paths) return undefined
  const { target, legacy } = paths
  for (const candidate of [target, legacy]) {
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info) continue
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Result is not a real file")
    return parseCandidateSubmission(JSON.parse(await readFile(candidate, "utf8")))
  }
  return undefined
}

/**
 * Mark the live `work/RESULT.json` slot as consumed after a gate evaluation has taken it, so a later
 * turn of the same session cannot re-offer the old candidate as a fresh submission. Best-effort
 * bookkeeping: a missing or unreadable slot is silently left alone. The legacy `.boom/candidate.json`
 * path stays read-only here — only the current target is ever rewritten.
 */
export async function consumeCandidateSubmission(directory: string): Promise<void> {
  const paths = await resultPaths(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!paths) return
  const { target } = paths
  let raw: string
  try {
    const info = await lstat(target)
    // Never rewrite anything but the real file: a planted symlink must not be followed, and rename
    // would otherwise clobber the link itself instead of the attacker's target.
    if (!info.isFile() || info.isSymbolicLink()) return
    raw = await readFile(target, "utf8")
  } catch {
    return
  }
  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    return
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return
  const updated: Record<string, unknown> = {
    ...(stored as Record<string, unknown>),
    consumedAt: new Date().toISOString(),
  }
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(updated, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
}

export async function submitCandidate(input: {
  directory: string
  sessionID: string
  candidate: string
}) {
  const { target } = await resultPaths(input.directory)
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
    throw new Error("Result is not a real file")
  const submission: CandidateSubmission = {
    version: 1,
    status: "ready",
    sessionID: requiredLine(input.sessionID, "sessionID", 512),
    flag: requiredLine(input.candidate, "candidate", 4_096),
    writeup: "work/WRITEUP.md",
    recordedAt: new Date().toISOString(),
  }
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(submission, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
  return submission
}
