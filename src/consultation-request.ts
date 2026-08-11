import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export const CONSULTATION_REQUEST_PATH = "work/.boom/consultation-request.json"

export type ConsultationRequest = {
  version: 1
  status: "ready"
  sessionID: string
  reason: string
  requestedAt: string
}

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function requiredString(value: unknown, name: string, maximum: number, oneLine = false) {
  if (typeof value !== "string") throw new Error(`${name} must be a string`)
  const result = value.trim()
  if (!result || result.length > maximum || result.includes("\0") || (oneLine && /[\r\n]/.test(result)))
    throw new Error(`${name} must be non-empty and at most ${maximum} characters`)
  return result
}

async function requestPath(directory: string, create = false) {
  const runRoot = await realpath(path.resolve(directory))
  const workRoot = await realpath(path.join(runRoot, "work"))
  if (!inside(runRoot, workRoot)) throw new Error("Consultation work directory escapes the run")
  const stateRoot = path.join(workRoot, ".boom")
  const existing = await lstat(stateRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory()))
    throw new Error("Consultation state directory is not a real directory")
  if (!existing && !create) return undefined
  if (!existing) await mkdir(stateRoot, { mode: 0o700 })
  const resolvedState = await realpath(stateRoot)
  if (!inside(workRoot, resolvedState)) throw new Error("Consultation state directory escapes work")
  return path.join(resolvedState, "consultation-request.json")
}

function parseConsultationRequest(value: unknown): ConsultationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Consultation request must be a JSON object")
  const input = value as Record<string, unknown>
  const requestedAt = requiredString(input.requestedAt, "requestedAt", 64, true)
  if (!Number.isFinite(new Date(requestedAt).valueOf()))
    throw new Error("Consultation request has an invalid requestedAt")
  return {
    version: 1,
    status: "ready",
    sessionID: requiredString(input.sessionID, "sessionID", 512, true),
    reason: requiredString(input.reason, "reason", 2_000),
    requestedAt,
  }
}

export async function loadConsultationRequest(directory: string) {
  const target = await requestPath(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!target) return undefined
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return undefined
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Consultation request is not a real file")
  return parseConsultationRequest(JSON.parse(await readFile(target, "utf8")))
}

export async function requestConsultation(input: {
  directory: string
  sessionID: string
  reason: string
}) {
  const target = await requestPath(input.directory, true)
  if (!target) throw new Error("Failed to create consultation state directory")
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink() || (existing && !existing.isFile()))
    throw new Error("Consultation request is not a real file")
  const request: ConsultationRequest = {
    version: 1,
    status: "ready",
    sessionID: requiredString(input.sessionID, "sessionID", 512, true),
    reason: requiredString(input.reason, "reason", 2_000),
    requestedAt: new Date().toISOString(),
  }
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(request, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
  return request
}
