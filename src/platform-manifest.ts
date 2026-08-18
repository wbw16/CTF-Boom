import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

export type TemplateScalar = string | number | boolean | null
export type TemplateValue = TemplateScalar | TemplateValue[] | { [key: string]: TemplateValue }

export type HttpRequestManifest = {
  method: "GET" | "POST" | "PUT" | "PATCH"
  path: string
  query?: Record<string, TemplateScalar>
  headers?: Record<string, string>
  body?: TemplateValue
}

export type ChallengeFieldManifest = {
  id: string
  slug?: string
  title?: string
  description?: string
  category?: string
  difficulty?: string
  flagFormat?: string
  remote?: string
}

export type AttachmentFieldManifest = {
  items: string
  name?: string
  url: string
}

export type ChallengeResponseManifest = {
  item?: string
  items?: string
  fields: ChallengeFieldManifest
  attachments?: AttachmentFieldManifest
  /** Non-secret per-challenge values persisted for detail and submission templates. */
  options?: Record<string, string>
}

export type ChallengeOperationManifest = {
  request: HttpRequestManifest
  response: ChallengeResponseManifest
}

export type SubmissionOperationManifest = {
  request: HttpRequestManifest
  response: {
    verdict?: string
    detail?: string
    accepted?: TemplateScalar[]
    rejected?: TemplateScalar[]
    pending?: TemplateScalar[]
  }
}

export type PlatformAuthManifest = {
  env: string
  location: "header" | "query" | "cookie"
  name: string
  prefix?: string
}

export type PlatformAdapterManifest = {
  version: 1
  id: string
  name?: string
  profile?: "dasctf-practice-v1" | "xihulunjian-agent-v1"
  status: "draft" | "ready"
  baseURL: string
  auth?: PlatformAuthManifest
  variables?: Record<string, TemplateScalar>
  operations: {
    listChallenges: ChallengeOperationManifest
    getChallenge?: ChallengeOperationManifest
    submitFlag?: SubmissionOperationManifest
  }
}

const ADAPTER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const METHODS = new Set(["GET", "POST", "PUT", "PATCH"])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum = 4_096) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0"))
    throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalText(value: unknown, label: string, maximum = 4_096) {
  return value === undefined ? undefined : text(value, label, maximum)
}

function optionalPrefix(value: unknown, label: string, maximum = 240) {
  if (value === undefined) return undefined
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    /[\0\r\n]/.test(value)
  ) throw new Error(`${label} must be a non-empty single-line string`)
  return value
}

function templateScalar(value: unknown, label: string): TemplateScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  throw new Error(`${label} must be a string, number, boolean, or null`)
}

function templateValue(value: unknown, label: string, depth = 0): TemplateValue {
  if (depth > 16) throw new Error(`${label} is nested too deeply`)
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => templateValue(item, `${label}[${index}]`, depth + 1))
  const input = object(value, label)
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => [key, templateValue(item, `${label}.${key}`, depth + 1)]),
  )
}

function request(value: unknown, label: string): HttpRequestManifest {
  const input = object(value, label)
  const method = text(input.method, `${label}.method`, 16).toUpperCase()
  if (!METHODS.has(method)) throw new Error(`${label}.method is unsupported: ${method}`)
  const request: HttpRequestManifest = {
    method: method as HttpRequestManifest["method"],
    path: text(input.path, `${label}.path`, 4_096),
  }
  if (input.query !== undefined) {
    const query = object(input.query, `${label}.query`)
    request.query = Object.fromEntries(
      Object.entries(query).map(([key, item]) => [key, templateScalar(item, `${label}.query.${key}`)]),
    )
  }
  if (input.headers !== undefined) {
    const headers = object(input.headers, `${label}.headers`)
    request.headers = Object.fromEntries(
      Object.entries(headers).map(([key, item]) => [key, text(item, `${label}.headers.${key}`)]),
    )
  }
  if (input.body !== undefined) request.body = templateValue(input.body, `${label}.body`)
  return request
}

function challengeResponse(value: unknown, label: string): ChallengeResponseManifest {
  const input = object(value, label)
  const rawFields = object(input.fields, `${label}.fields`)
  const fields: ChallengeFieldManifest = {
    id: text(rawFields.id, `${label}.fields.id`),
  }
  for (const key of ["slug", "title", "description", "category", "difficulty", "flagFormat", "remote"] as const) {
    const found = optionalText(rawFields[key], `${label}.fields.${key}`)
    if (found) fields[key] = found
  }
  const response: ChallengeResponseManifest = { fields }
  const item = optionalText(input.item, `${label}.item`)
  const items = optionalText(input.items, `${label}.items`)
  if (item) response.item = item
  if (items) response.items = items
  if (input.attachments !== undefined) {
    const raw = object(input.attachments, `${label}.attachments`)
    response.attachments = {
      items: text(raw.items, `${label}.attachments.items`),
      url: text(raw.url, `${label}.attachments.url`),
      ...(optionalText(raw.name, `${label}.attachments.name`)
        ? { name: optionalText(raw.name, `${label}.attachments.name`)! }
        : {}),
    }
  }
  if (input.options !== undefined) {
    const raw = object(input.options, `${label}.options`)
    response.options = Object.fromEntries(
      Object.entries(raw).map(([key, item]) => [key, text(item, `${label}.options.${key}`)]),
    )
  }
  return response
}

function challengeOperation(value: unknown, label: string): ChallengeOperationManifest {
  const input = object(value, label)
  return {
    request: request(input.request, `${label}.request`),
    response: challengeResponse(input.response, `${label}.response`),
  }
}

function submissionOperation(value: unknown, label: string): SubmissionOperationManifest {
  const input = object(value, label)
  const rawResponse = object(input.response ?? {}, `${label}.response`)
  const values = (key: "accepted" | "rejected" | "pending") => {
    const raw = rawResponse[key]
    if (raw === undefined) return undefined
    if (!Array.isArray(raw)) throw new Error(`${label}.response.${key} must be an array`)
    return raw.map((item, index) => templateScalar(item, `${label}.response.${key}[${index}]`))
  }
  return {
    request: request(input.request, `${label}.request`),
    response: {
      ...(optionalText(rawResponse.verdict, `${label}.response.verdict`)
        ? { verdict: optionalText(rawResponse.verdict, `${label}.response.verdict`)! }
        : {}),
      ...(optionalText(rawResponse.detail, `${label}.response.detail`)
        ? { detail: optionalText(rawResponse.detail, `${label}.response.detail`)! }
        : {}),
      ...(values("accepted") ? { accepted: values("accepted")! } : {}),
      ...(values("rejected") ? { rejected: values("rejected")! } : {}),
      ...(values("pending") ? { pending: values("pending")! } : {}),
    },
  }
}

function endpoint(value: unknown) {
  const url = new URL(text(value, "baseURL", 4_096))
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("baseURL must use http or https")
  if (url.username || url.password || url.search || url.hash)
    throw new Error("baseURL must be credential-free and contain no query or fragment")
  return url.toString().replace(/\/$/, "")
}

export function normalizePlatformManifest(value: unknown): PlatformAdapterManifest {
  const input = object(value, "platform manifest")
  if (input.version !== 1) throw new Error("Unsupported platform manifest version")
  const id = text(input.id, "id", 64)
  if (!ADAPTER_ID.test(id)) throw new Error(`Invalid platform adapter ID: ${id}`)
  if (input.status !== "draft" && input.status !== "ready")
    throw new Error("status must be draft or ready")
  const rawOperations = object(input.operations, "operations")
  const manifest: PlatformAdapterManifest = {
    version: 1,
    id,
    status: input.status,
    baseURL: endpoint(input.baseURL),
    operations: {
      listChallenges: challengeOperation(rawOperations.listChallenges, "operations.listChallenges"),
    },
  }
  const name = optionalText(input.name, "name", 240)
  if (name) manifest.name = name
  if (input.profile !== undefined) {
    if (input.profile !== "dasctf-practice-v1" && input.profile !== "xihulunjian-agent-v1")
      throw new Error(`Unsupported platform adapter profile: ${String(input.profile)}`)
    manifest.profile = input.profile
  }
  if (rawOperations.getChallenge !== undefined)
    manifest.operations.getChallenge = challengeOperation(rawOperations.getChallenge, "operations.getChallenge")
  if (rawOperations.submitFlag !== undefined)
    manifest.operations.submitFlag = submissionOperation(rawOperations.submitFlag, "operations.submitFlag")
  if (input.auth !== undefined) {
    const auth = object(input.auth, "auth")
    const env = text(auth.env, "auth.env", 128)
    if (!ENV_NAME.test(env)) throw new Error(`Invalid credential environment variable: ${env}`)
    if (auth.location !== "header" && auth.location !== "query" && auth.location !== "cookie")
      throw new Error("auth.location must be header, query, or cookie")
    manifest.auth = {
      env,
      location: auth.location,
      name: text(auth.name, "auth.name", 240),
      ...(optionalPrefix(auth.prefix, "auth.prefix", 240)
        ? { prefix: optionalPrefix(auth.prefix, "auth.prefix", 240)! }
        : {}),
    }
  }
  if (input.variables !== undefined) {
    const variables = object(input.variables, "variables")
    manifest.variables = Object.fromEntries(
      Object.entries(variables).map(([key, item]) => [key, templateScalar(item, `variables.${key}`)]),
    )
  }
  return manifest
}

export function platformManifestPath(root: string, adapterID: string) {
  if (!ADAPTER_ID.test(adapterID)) throw new Error(`Invalid platform adapter ID: ${adapterID}`)
  return path.join(path.resolve(root), "platforms", `${adapterID}.json`)
}

export async function loadPlatformManifest(root: string, adapterID: string) {
  const target = platformManifestPath(root, adapterID)
  const info = await lstat(target).catch(() => undefined)
  if (!info) return undefined
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Platform manifest is not a real file: ${target}`)
  const manifest = normalizePlatformManifest(JSON.parse(await readFile(target, "utf8")))
  if (manifest.id !== adapterID)
    throw new Error(`Platform manifest ${target} declares a mismatched adapter ID`)
  return manifest
}

export async function savePlatformManifest(root: string, manifest: PlatformAdapterManifest) {
  const normalized = normalizePlatformManifest(manifest)
  const target = platformManifestPath(root, normalized.id)
  const directory = path.dirname(target)
  await mkdir(directory, { recursive: true })
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error(`Platform manifest directory is not a real directory: ${directory}`)
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`Platform manifest is not a real file: ${target}`)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, undefined, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return target
}
