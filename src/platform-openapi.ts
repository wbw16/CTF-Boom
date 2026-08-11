import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import {
  normalizePlatformManifest,
  type ChallengeFieldManifest,
  type ChallengeOperationManifest,
  type HttpRequestManifest,
  type PlatformAdapterManifest,
  type PlatformAuthManifest,
  type SubmissionOperationManifest,
  type TemplateScalar,
  type TemplateValue,
} from "./platform-manifest.ts"

type JsonObject = Record<string, unknown>
type Operation = {
  method: HttpRequestManifest["method"]
  path: string
  definition: JsonObject
  text: string
  responseSchema?: JsonObject
}

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

export type OpenApiAdaptation = {
  manifest: PlatformAdapterManifest
  warnings: string[]
  selected: {
    listChallenges: string
    getChallenge?: string
    submitFlag?: string
  }
}

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function resolveRef(document: JsonObject, value: unknown, seen = new Set<string>()): JsonObject | undefined {
  const input = record(value)
  const reference = typeof input?.$ref === "string" ? input.$ref : undefined
  if (!reference) return input
  if (!reference.startsWith("#/") || seen.has(reference)) return undefined
  seen.add(reference)
  let current: unknown = document
  for (const segment of reference.slice(2).split("/")) {
    current = record(current)?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")]
  }
  return resolveRef(document, current, seen)
}

function responseSchema(document: JsonObject, definition: JsonObject) {
  const responses = record(definition.responses)
  if (!responses) return undefined
  const response = resolveRef(
    document,
    responses["200"] ?? responses["201"] ?? responses["202"] ?? responses.default ?? Object.values(responses)[0],
  )
  const content = record(response?.content)
  const media = record(content?.["application/json"] ?? content?.["application/*+json"] ?? Object.values(content ?? {})[0])
  return resolveRef(document, media?.schema ?? response?.schema)
}

function operations(document: JsonObject) {
  const paths = record(document.paths) ?? {}
  const found: Operation[] = []
  for (const [route, rawPath] of Object.entries(paths)) {
    const pathItem = record(rawPath)
    if (!pathItem) continue
    for (const method of ["get", "post", "put", "patch"] as const) {
      const definition = record(pathItem[method])
      if (!definition) continue
      const labels = Array.isArray(definition.tags) ? definition.tags.filter((item) => typeof item === "string") : []
      found.push({
        method: method.toUpperCase() as Operation["method"],
        path: route,
        definition,
        text: [route, definition.operationId, definition.summary, definition.description, ...labels]
          .filter((item) => typeof item === "string")
          .join(" ")
          .toLowerCase(),
        responseSchema: responseSchema(document, definition),
      })
    }
  }
  return found
}

function schemaType(schema: JsonObject | undefined) {
  if (schema?.type === "array" || schema?.items) return "array"
  if (schema?.type === "object" || schema?.properties) return "object"
  return undefined
}

function findArray(document: JsonObject, schema: JsonObject | undefined, prefix = "$", depth = 0): {
  path: string
  item?: JsonObject
} | undefined {
  const resolved = resolveRef(document, schema)
  if (!resolved || depth > 4) return undefined
  if (schemaType(resolved) === "array") return { path: prefix, item: resolveRef(document, resolved.items) }
  const properties = record(resolved.properties) ?? {}
  const preferred = ["data", "challenges", "items", "results", "list"]
  const entries = Object.entries(properties).sort(([a], [b]) =>
    preferred.indexOf(a) === -1
      ? 1
      : preferred.indexOf(b) === -1
        ? -1
        : preferred.indexOf(a) - preferred.indexOf(b)
  )
  for (const [name, value] of entries) {
    const nested = findArray(document, resolveRef(document, value), prefix === "$" ? name : `${prefix}.${name}`, depth + 1)
    if (nested) return nested
  }
  return undefined
}

function findObject(document: JsonObject, schema: JsonObject | undefined) {
  const resolved = resolveRef(document, schema)
  if (!resolved) return undefined
  const properties = record(resolved.properties) ?? {}
  for (const name of ["data", "challenge", "item", "result"]) {
    const nested = resolveRef(document, properties[name])
    if (nested && schemaType(nested) === "object") return { path: name, schema: nested }
  }
  return { path: "$", schema: resolved }
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function property(document: JsonObject, schema: JsonObject | undefined, aliases: string[]) {
  const properties = record(resolveRef(document, schema)?.properties) ?? {}
  const wanted = aliases.map(normalized)
  const entry = Object.entries(properties).find(([name]) => wanted.includes(normalized(name)))
  return entry ? { name: entry[0], schema: resolveRef(document, entry[1]) } : undefined
}

function challengeFields(document: JsonObject, schema: JsonObject | undefined) {
  const match = (aliases: string[]) => property(document, schema, aliases)?.name
  const id = match(["id", "challenge_id", "challengeId", "uuid"])
  if (!id) return undefined
  const fields: ChallengeFieldManifest = { id }
  const optional: Array<[keyof Omit<ChallengeFieldManifest, "id">, string[]]> = [
    ["slug", ["slug", "key"]],
    ["title", ["name", "title", "challenge_name"]],
    ["description", ["description", "content", "prompt", "question"]],
    ["category", ["category", "type", "challenge_category"]],
    ["difficulty", ["difficulty", "level"]],
    ["flagFormat", ["flag_format", "flagFormat", "flag_regex", "flagRegex"]],
    ["remote", ["remote", "connection_info", "connectionInfo", "endpoint"]],
  ]
  for (const [key, aliases] of optional) {
    const found = match(aliases)
    if (found) fields[key] = found
  }
  return fields
}

function attachments(document: JsonObject, schema: JsonObject | undefined) {
  const found = property(document, schema, ["files", "attachments", "downloads"])
  const array = resolveRef(document, found?.schema)
  if (!found || schemaType(array) !== "array") return undefined
  const item = resolveRef(document, array?.items)
  if (!item || item.type === "string") return { items: found.name, url: "$" }
  const url = property(document, item, ["url", "download_url", "downloadUrl", "path", "location"])
  if (!url) return undefined
  const name = property(document, item, ["name", "filename", "file_name", "title"])
  return { items: found.name, url: url.name, ...(name ? { name: name.name } : {}) }
}

function parameters(operation: Operation) {
  if (!Array.isArray(operation.definition.parameters)) return []
  const found: JsonObject[] = []
  for (const item of operation.definition.parameters) {
    const parsed = record(item)
    if (parsed) found.push(parsed)
  }
  return found
}

function requestTemplate(operation: Operation, purpose: "list" | "challenge" | "submit", warnings: string[]) {
  let route = operation.path.replace(/\{([^}]+)\}/g, (_, raw: string) => {
    const name = raw.trim()
    if (purpose !== "list" && /(^id$|challenge)/i.test(name)) return "{{challenge.id}}"
    warnings.push(`Path parameter ${name} must be configured as variables.${name}`)
    return `{{variable.${name}}}`
  })
  if (!route.startsWith("/")) route = `/${route}`
  const query: Record<string, TemplateScalar> = {}
  for (const parameter of parameters(operation)) {
    if (parameter.in !== "query" || parameter.required !== true || typeof parameter.name !== "string") continue
    query[parameter.name] = `{{variable.${parameter.name}}}`
    warnings.push(`Required query parameter ${parameter.name} must be configured as variables.${parameter.name}`)
  }
  return {
    method: operation.method,
    path: route,
    ...(Object.keys(query).length ? { query } : {}),
  } satisfies HttpRequestManifest
}

function requestBodySchema(document: JsonObject, operation: Operation) {
  const requestBody = resolveRef(document, operation.definition.requestBody)
  const content = record(requestBody?.content)
  const media = record(content?.["application/json"] ?? Object.values(content ?? {})[0])
  const modern = resolveRef(document, media?.schema)
  if (modern) return modern
  const body = parameters(operation).find((item) => item.in === "body")
  return resolveRef(document, body?.schema)
}

function submissionBody(document: JsonObject, operation: Operation, warnings: string[]) {
  const schema = requestBodySchema(document, operation)
  const properties = record(schema?.properties) ?? {}
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((item) => typeof item === "string") : [])
  const body: Record<string, TemplateValue> = {}
  let hasFlag = false
  for (const [name, definition] of Object.entries(properties)) {
    const key = normalized(name)
    if (["flag", "answer", "candidate", "submission"].includes(key)) {
      body[name] = "{{flag}}"
      hasFlag = true
    } else if (["challengeid", "challenge", "id"].includes(key)) {
      body[name] = "{{challenge.id}}"
    } else if (required.has(name)) {
      const schema = resolveRef(document, definition)
      if (schema?.default !== undefined && ["string", "number", "boolean"].includes(typeof schema.default))
        body[name] = schema.default as TemplateScalar
      else {
        body[name] = `{{variable.${name}}}`
        warnings.push(`Required submission field ${name} must be configured as variables.${name}`)
      }
    }
  }
  if (!hasFlag) warnings.push("Could not identify the flag field in the submission request body")
  return { body, hasFlag }
}

function submissionResponse(document: JsonObject, schema: JsonObject | undefined) {
  const envelope = findObject(document, schema)
  const status = property(document, envelope?.schema, ["verdict", "status", "result", "correct"])
  const detail = property(document, envelope?.schema, ["message", "detail", "error", "description"])
  const prefix = envelope?.path && envelope.path !== "$" ? `${envelope.path}.` : ""
  return {
    ...(status ? { verdict: `${prefix}${status.name}` } : {}),
    ...(detail ? { detail: `${prefix}${detail.name}` } : {}),
    accepted: ["correct", "accepted", "success", "ok", true],
    rejected: ["incorrect", "rejected", "wrong", "invalid", false],
    pending: ["pending", "queued", "rate_limited"],
  } satisfies SubmissionOperationManifest["response"]
}

function auth(document: JsonObject, adapterID: string): PlatformAuthManifest | undefined {
  const schemes = record(record(document.components)?.securitySchemes) ?? record(document.securityDefinitions) ?? {}
  const first = Object.values(schemes).map((item) => resolveRef(document, item)).find(Boolean)
  if (!first) return undefined
  const env = `BOOM_PLATFORM_${adapterID.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`
  if (first.type === "http" && String(first.scheme).toLowerCase() === "bearer")
    return { env, location: "header", name: "Authorization", prefix: "Bearer " }
  if (first.type === "apiKey") {
    const location = first.in === "query" || first.in === "cookie" ? first.in : "header"
    return {
      env,
      location,
      name: typeof first.name === "string" ? first.name : "Authorization",
    }
  }
  return undefined
}

function baseURL(document: JsonObject, override?: string) {
  if (override) return override
  const server = Array.isArray(document.servers) ? record(document.servers[0]) : undefined
  if (typeof server?.url === "string") {
    const variables = record(server.variables) ?? {}
    return server.url.replace(/\{([^}]+)\}/g, (_, name: string) => {
      const fallback = record(variables[name])?.default
      return typeof fallback === "string" || typeof fallback === "number" ? String(fallback) : `{${name}}`
    })
  }
  if (typeof document.host === "string") {
    const scheme = Array.isArray(document.schemes) && typeof document.schemes[0] === "string"
      ? document.schemes[0]
      : "https"
    return `${scheme}://${document.host}${typeof document.basePath === "string" ? document.basePath : ""}`
  }
  throw new Error("The API document has no server URL; provide --base-url")
}

function has(text: string, words: string[]) {
  return words.some((word) => text.includes(word))
}

function isDasctfPracticeDocument(document: JsonObject) {
  const paths = record(document.paths) ?? {}
  const info = record(document.info)
  return typeof info?.title === "string" && /ctf2 user open api/i.test(info.title) &&
    Boolean(paths["/api/open/v1/user/practice/"]) &&
    Boolean(paths["/api/open/v1/user/practice/{id}/challenges/{challengeId}/"]) &&
    Boolean(paths["/api/open/v1/user/practice/{id}/challenges/{challengeId}/submit/"])
}

function dasctfPracticeAdaptation(
  document: JsonObject,
  options: { id: string; baseURL?: string; name?: string },
): OpenApiAdaptation {
  const manifest = normalizePlatformManifest({
    version: 1,
    id: options.id,
    name: options.name ?? "DASCTF 练习场",
    profile: "dasctf-practice-v1",
    status: "ready",
    baseURL: baseURL(document, options.baseURL),
    ...(auth(document, options.id) ? { auth: auth(document, options.id) } : {}),
    variables: {},
    operations: {
      listChallenges: {
        request: {
          method: "GET",
          path: "/api/v1/public/practice/challenges/",
          query: { page: 1, page_size: 50 },
        },
        response: {
          items: "data.data",
          fields: {
            id: "challenge.id",
            slug: "challenge.friendly_id",
            title: "challenge.name",
            description: "challenge.description",
            category: "challenge.category",
            difficulty: "challenge.difficulty",
          },
          options: {
            practice_ground_id: "practice_ground.id",
          },
        },
      },
      getChallenge: {
        request: {
          method: "GET",
          path: "/api/open/v1/user/practice/{{challenge.practice_ground_id}}/challenges/{{challenge.id}}/",
        },
        response: {
          item: "data",
          fields: {
            id: "id",
            slug: "friendly_id",
            title: "name",
            description: "description",
            category: "category",
            difficulty: "difficulty",
            flagFormat: "flag_format",
            remote: "remote",
          },
          attachments: { items: "files", name: "name", url: "url" },
        },
      },
      submitFlag: {
        request: {
          method: "POST",
          path: "/api/open/v1/user/practice/{{challenge.practice_ground_id}}/challenges/{{challenge.id}}/submit/",
          body: { flag: "{{flag}}", confirmation: true },
        },
        response: {
          verdict: "data.accepted",
          detail: "data.message",
          accepted: [true],
          rejected: [false],
          pending: [null],
        },
      },
    },
  })
  return {
    manifest,
    warnings: [
      "DASCTF 的 User OpenAPI 未声明练习题列表响应字段；Boom 使用同源公开题目目录做选择预览，详情与 flag 提交仍走 User OpenAPI。",
    ],
    selected: {
      listChallenges: "GET /api/v1/public/practice/challenges/",
      getChallenge: "GET /api/open/v1/user/practice/{id}/challenges/{challengeId}/",
      submitFlag: "POST /api/open/v1/user/practice/{id}/challenges/{challengeId}/submit/",
    },
  }
}

function selectOperations(document: JsonObject) {
  const found = operations(document)
  const list = found
    .filter((item) => item.method === "GET")
    .map((item) => ({
      item,
      array: findArray(document, item.responseSchema),
      score:
        (has(item.text, ["challenge", "task", "problem", "题目"]) ? 12 : 0) +
        (findArray(document, item.responseSchema) ? 10 : 0) -
        ((item.path.match(/\{/g)?.length ?? 0) * 3),
    }))
    .filter((item) => item.array && challengeFields(document, item.array.item))
    .sort((a, b) => b.score - a.score)[0]
  if (!list) throw new Error("Could not identify a challenge-list operation with an ID field")

  const detail = found
    .filter((item) => item.method === "GET" && item !== list.item && /\{[^}]+\}/.test(item.path))
    .map((item) => {
      const envelope = findObject(document, item.responseSchema)
      return {
        item,
        envelope,
        score:
          (has(item.text, ["challenge", "task", "problem", "题目"]) ? 10 : 0) +
          (envelope && challengeFields(document, envelope.schema) ? 8 : 0) +
          (attachments(document, envelope?.schema) ? 6 : 0),
      }
    })
    .filter((item) => item.envelope && challengeFields(document, item.envelope.schema))
    .sort((a, b) => b.score - a.score)[0]

  const submit = found
    .filter((item) => item.method !== "GET")
    .map((item) => ({
      item,
      score:
        (has(item.text, ["flag", "answer", "attempt", "submit", "submission", "check", "答题", "提交"]) ? 16 : 0) +
        (has(item.text, ["challenge", "task", "problem", "题目"]) ? 5 : 0) +
        (requestBodySchema(document, item) ? 4 : 0),
    }))
    .filter((item) => item.score >= 16)
    .sort((a, b) => b.score - a.score)[0]?.item
  return { list, detail, submit }
}

export function adaptOpenApiDocument(
  value: unknown,
  options: { id: string; baseURL?: string; name?: string },
): OpenApiAdaptation {
  const document = record(value)
  if (!document || (typeof document.openapi !== "string" && document.swagger !== "2.0"))
    throw new Error("Expected an OpenAPI 3.x or Swagger 2.0 document")
  if (isDasctfPracticeDocument(document)) return dasctfPracticeAdaptation(document, options)
  const warnings: string[] = []
  const selected = selectOperations(document)
  const listFields = challengeFields(document, selected.list.array?.item)
  if (!listFields) throw new Error("The selected challenge-list response has no challenge ID field")
  const listOperation: ChallengeOperationManifest = {
    request: requestTemplate(selected.list.item, "list", warnings),
    response: {
      items: selected.list.array!.path,
      fields: listFields,
      ...(attachments(document, selected.list.array?.item)
        ? { attachments: attachments(document, selected.list.array?.item)! }
        : {}),
    },
  }
  let detailOperation: ChallengeOperationManifest | undefined
  if (selected.detail?.envelope) {
    const fields = challengeFields(document, selected.detail.envelope.schema)!
    detailOperation = {
      request: requestTemplate(selected.detail.item, "challenge", warnings),
      response: {
        item: selected.detail.envelope.path,
        fields,
        ...(attachments(document, selected.detail.envelope.schema)
          ? { attachments: attachments(document, selected.detail.envelope.schema)! }
          : {}),
      },
    }
  }
  let submitOperation: SubmissionOperationManifest | undefined
  if (selected.submit) {
    const template = requestTemplate(selected.submit, "submit", warnings)
    const inferred = submissionBody(document, selected.submit, warnings)
    if (inferred.hasFlag) {
      submitOperation = {
        request: { ...template, body: inferred.body },
        response: submissionResponse(document, selected.submit.responseSchema),
      }
      if (!submitOperation.response.verdict)
        warnings.push("Could not identify a verdict field in the submission response")
    }
  } else warnings.push("No automatic flag-submission operation was found")

  const critical = warnings.some((warning) =>
    warning.startsWith("Could not identify the flag") ||
    warning.startsWith("Could not identify a verdict") ||
    warning.includes("must be configured"),
  )
  const info = record(document.info)
  const manifest = normalizePlatformManifest({
    version: 1,
    id: options.id,
    name: options.name ?? (typeof info?.title === "string" ? info.title : options.id),
    status: critical ? "draft" : "ready",
    baseURL: baseURL(document, options.baseURL),
    ...(auth(document, options.id) ? { auth: auth(document, options.id) } : {}),
    variables: {},
    operations: {
      listChallenges: listOperation,
      ...(detailOperation ? { getChallenge: detailOperation } : {}),
      ...(submitOperation ? { submitFlag: submitOperation } : {}),
    },
  })
  return {
    manifest,
    warnings,
    selected: {
      listChallenges: `${selected.list.item.method} ${selected.list.item.path}`,
      ...(selected.detail ? { getChallenge: `${selected.detail.item.method} ${selected.detail.item.path}` } : {}),
      ...(selected.submit ? { submitFlag: `${selected.submit.method} ${selected.submit.path}` } : {}),
    },
  }
}

export async function readApiDocument(source: string, signal?: AbortSignal) {
  let raw: string
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal, redirect: "error", headers: { Accept: "application/json, application/yaml, text/yaml" } })
    if (!response.ok) throw new Error(`Failed to download API document (${response.status})`)
    const declared = Number(response.headers.get("content-length") ?? 0)
    if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES)
      throw new Error(`API document exceeds ${MAX_DOCUMENT_BYTES} bytes`)
    if (!response.body) raw = ""
    else {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let size = 0
      let text = ""
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > MAX_DOCUMENT_BYTES)
            throw new Error(`API document exceeds ${MAX_DOCUMENT_BYTES} bytes`)
          text += decoder.decode(next.value, { stream: true })
        }
        text += decoder.decode()
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      } finally {
        reader.releaseLock()
      }
      raw = text
    }
  } else {
    const target = path.resolve(source)
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`API document is not a real file: ${target}`)
    if (info.size > MAX_DOCUMENT_BYTES)
      throw new Error(`API document exceeds ${MAX_DOCUMENT_BYTES} bytes`)
    raw = await readFile(target, "utf8")
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    try {
      return Bun.YAML.parse(raw) as unknown
    } catch (error) {
      throw new Error(`Failed to parse API document as JSON or YAML: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
