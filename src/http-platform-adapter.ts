import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { loadChallenge, normalizeChallengeCategory, type Challenge } from "./challenge.ts"
import {
  PlatformAdapterRegistry,
  type ChallengeAcquisitionInput,
  type CtfPlatformAdapter,
  type FlagSubmissionInput,
  type FlagSubmissionResult,
  type PlatformChallengeCatalogInput,
  type PlatformChallengePreview,
} from "./platform-adapter.ts"
import {
  loadPlatformManifest,
  type ChallengeOperationManifest,
  type ChallengeResponseManifest,
  type HttpRequestManifest,
  type PlatformAdapterManifest,
  type SubmissionOperationManifest,
  type TemplateScalar,
  type TemplateValue,
} from "./platform-manifest.ts"

type JsonObject = Record<string, unknown>
type TemplateContext = {
  challenge?: JsonObject
  flag?: string
  variable: Record<string, TemplateScalar>
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const TEMPLATE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as JsonObject
}

function valueAt(value: unknown, source: string): unknown {
  if (source === "$" || source === "") return value
  const parts = source.replace(/^\$\.?/, "").split(".").filter(Boolean)
  let current = value
  for (const part of parts) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)]
    else if (current && typeof current === "object") current = (current as JsonObject)[part]
    else return undefined
  }
  return current
}

function contextValue(context: TemplateContext, source: string) {
  if (source === "flag") return context.flag
  if (source.startsWith("challenge.")) return valueAt(context.challenge, source.slice("challenge.".length))
  if (source.startsWith("variable.")) return valueAt(context.variable, source.slice("variable.".length))
  return undefined
}

function renderText(template: string, context: TemplateContext, encode = false) {
  return template.replace(TEMPLATE, (_, source: string) => {
    const value = contextValue(context, source)
    if (value === undefined || value === null)
      throw new Error(`Missing platform template value: ${source}`)
    const rendered = String(value)
    return encode ? encodeURIComponent(rendered) : rendered
  })
}

function renderValue(value: TemplateValue, context: TemplateContext): unknown {
  if (typeof value === "string") {
    const exact = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value)
    if (exact) {
      const rendered = contextValue(context, exact[1]!)
      if (rendered === undefined) throw new Error(`Missing platform template value: ${exact[1]}`)
      return rendered
    }
    return renderText(value, context)
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, context))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, context)]))
  return value
}

function safeErrorBody(value: string) {
  return value.replace(/[\0\r\n]+/g, " ").slice(0, 2_000)
}

function runtimeVariables(value: Record<string, unknown> | undefined, label: string) {
  const variables: Record<string, TemplateScalar> = {}
  for (const [key, item] of Object.entries(value ?? {})) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) throw new Error(`${label}.${key} must be a string, number, boolean, or null`)
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error(`${label}.${key} must be finite`)
    variables[key] = item as TemplateScalar
  }
  return variables
}

async function boundedBody(response: Response, maximum: number) {
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > maximum)
    throw new Error(`Platform response exceeds ${maximum} bytes`)
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) throw new Error(`Platform response exceeds ${maximum} bytes`)
      chunks.push(next.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function decode(bytes: Uint8Array) {
  return new TextDecoder().decode(bytes)
}

function sameOrigin(baseURL: string, target: URL) {
  return new URL(baseURL).origin === target.origin
}

export class DeclarativeHttpPlatformAdapter implements CtfPlatformAdapter {
  readonly id: string
  readonly name?: string

  constructor(
    private readonly manifest: PlatformAdapterManifest,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (manifest.status !== "ready")
      throw new Error(`Platform adapter ${manifest.id} is still a draft; review it and set status to ready`)
    this.id = manifest.id
    this.name = manifest.name
  }

  private credential() {
    const auth = this.manifest.auth
    if (!auth) return undefined
    const value = process.env[auth.env]?.trim()
    if (!value) throw new Error(`Platform adapter ${this.id} requires credential environment variable ${auth.env}`)
    return value
  }

  private async request(
    template: HttpRequestManifest,
    context: TemplateContext,
    signal?: AbortSignal,
  ) {
    const base = new URL(this.manifest.baseURL)
    const renderedPath = renderText(template.path, context, true)
    const url = /^https?:\/\//i.test(renderedPath)
      ? new URL(renderedPath)
      : new URL(
          `${base.pathname.replace(/\/$/, "")}/${renderedPath.replace(/^\//, "")}`,
          base.origin,
        )
    if (!sameOrigin(this.manifest.baseURL, url))
      throw new Error(`Platform API request escapes configured origin: ${url.origin}`)
    for (const [key, value] of Object.entries(template.query ?? {}))
      url.searchParams.set(key, String(renderValue(value, context)))

    const headers = new Headers()
    headers.set("Accept", "application/json")
    for (const [key, value] of Object.entries(template.headers ?? {}))
      headers.set(key, renderText(value, context))
    const credential = this.credential()
    const auth = this.manifest.auth
    if (credential && auth) {
      const rendered = `${auth.prefix ?? ""}${credential}`
      if (auth.location === "header") headers.set(auth.name, rendered)
      else if (auth.location === "query") url.searchParams.set(auth.name, rendered)
      else headers.append("Cookie", `${auth.name}=${encodeURIComponent(rendered)}`)
    }
    const body = template.body === undefined ? undefined : JSON.stringify(renderValue(template.body, context))
    if (body !== undefined) headers.set("Content-Type", "application/json")
    const response = await this.fetcher(url, {
      method: template.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal,
      redirect: "error",
    })
    const bytes = await boundedBody(response, MAX_RESPONSE_BYTES)
    if (!response.ok)
      throw new Error(`Platform request ${template.method} ${url.pathname} failed (${response.status}): ${safeErrorBody(decode(bytes))}`)
    if (bytes.byteLength === 0) return {}
    try {
      return JSON.parse(decode(bytes)) as unknown
    } catch {
      throw new Error(`Platform request ${template.method} ${url.pathname} did not return JSON`)
    }
  }

  private item(value: unknown, response: ChallengeResponseManifest, list: boolean) {
    const selected = valueAt(value, list ? response.items ?? "$" : response.item ?? "$")
    if (list) {
      if (!Array.isArray(selected)) throw new Error("Platform challenge-list mapping did not select an array")
      return selected
    }
    return object(selected, "Platform challenge response")
  }

  private field(item: unknown, source: string | undefined) {
    return source === undefined ? undefined : valueAt(item, source)
  }

  private mappedChallenge(item: JsonObject, response: ChallengeResponseManifest) {
    const fields = response.fields
    const id = this.field(item, fields.id)
    if (typeof id !== "string" && typeof id !== "number")
      throw new Error(`Platform adapter ${this.id} produced a challenge without an ID`)
    const stringField = (source: string | undefined) => {
      const value = this.field(item, source)
      return typeof value === "string" ? value.trim() : undefined
    }
    return {
      id: String(id),
      slug: stringField(fields.slug),
      title: stringField(fields.title),
      description: stringField(fields.description),
      category: stringField(fields.category),
      difficulty: stringField(fields.difficulty),
      flagFormat: stringField(fields.flagFormat),
      remote: stringField(fields.remote),
    }
  }

  private mappedOptions(item: JsonObject, response: ChallengeResponseManifest) {
    const options: Record<string, TemplateScalar> = {}
    for (const [name, source] of Object.entries(response.options ?? {})) {
      const value = this.field(item, source)
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) throw new Error(`Platform adapter ${this.id} produced invalid option ${name}`)
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error(`Platform adapter ${this.id} produced invalid option ${name}`)
      options[name] = value as TemplateScalar
    }
    return options
  }

  private preview(item: JsonObject, response: ChallengeResponseManifest): PlatformChallengePreview {
    const mapped = this.mappedChallenge(item, response)
    return {
      id: mapped.id,
      challengeID: mapped.id,
      title: mapped.title || mapped.slug || mapped.id,
      ...(mapped.slug ? { slug: mapped.slug } : {}),
      ...(mapped.description ? { description: mapped.description } : {}),
      ...(mapped.category ? { category: mapped.category } : {}),
      ...(mapped.difficulty ? { difficulty: mapped.difficulty } : {}),
    }
  }

  private filteredCatalog(items: PlatformChallengePreview[], input: PlatformChallengeCatalogInput) {
    const query = input.query ?? {}
    const search = query.search?.trim().toLocaleLowerCase()
    const filtered = search
      ? items.filter((item) => [item.id, item.challengeID, item.title, item.slug, item.description]
          .some((value) => value?.toLocaleLowerCase().includes(search)))
      : items
    const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize ?? 50)))
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
    const page = Math.max(1, Math.min(pages, Math.floor(query.page ?? 1)))
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: filtered.length,
    }
  }

  async listChallenges(input: PlatformChallengeCatalogInput) {
    const variables = {
      ...(this.manifest.variables ?? {}),
      ...runtimeVariables(input.options, "Platform catalog option"),
    }
    const operation = this.manifest.operations.listChallenges
    const value = await this.request(operation.request, { variable: variables }, input.signal)
    const listed = this.item(value, operation.response, true) as unknown[]
    const previews = listed.map((raw) => this.preview(
      object(raw, "Platform challenge-list item"),
      operation.response,
    ))
    return this.filteredCatalog(previews, input)
  }

  private slug(value: string) {
    const normalized = value.normalize("NFKC").trim().replace(/[\0-\x1f/\\:]+/g, "-").replace(/\.\./g, "-")
    const trimmed = normalized.replace(/^\.+|\.+$/g, "").slice(0, 160)
    if (!trimmed || trimmed === "." || trimmed === "..") throw new Error("Platform challenge has an invalid slug")
    return trimmed
  }

  private attachments(item: JsonObject, response: ChallengeResponseManifest) {
    const mapping = response.attachments
    if (!mapping) return []
    const values = valueAt(item, mapping.items)
    if (!Array.isArray(values)) throw new Error("Platform attachment mapping did not select an array")
    return values.map((value, index) => {
      const url = valueAt(value, mapping.url)
      if (typeof url !== "string" || !url.trim())
        throw new Error(`Platform attachment ${index + 1} has no URL`)
      const explicit = mapping.name ? valueAt(value, mapping.name) : undefined
      const parsed = new URL(url, this.manifest.baseURL)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error(`Platform attachment uses unsupported protocol: ${parsed.protocol}`)
      let fallback = path.basename(parsed.pathname) || `attachment-${index + 1}`
      try { fallback = decodeURIComponent(fallback) } catch {}
      const name = this.slug(typeof explicit === "string" && explicit.trim() ? explicit : fallback)
      return { name, url: parsed }
    })
  }

  private async download(url: URL, signal?: AbortSignal) {
    const headers = new Headers()
    const credential = sameOrigin(this.manifest.baseURL, url) ? this.credential() : undefined
    const auth = this.manifest.auth
    if (credential && auth) {
      const rendered = `${auth.prefix ?? ""}${credential}`
      if (auth.location === "header") headers.set(auth.name, rendered)
      else if (auth.location === "query") url.searchParams.set(auth.name, rendered)
      else headers.set("Cookie", `${auth.name}=${encodeURIComponent(rendered)}`)
    }
    const response = await this.fetcher(url, { headers, signal, redirect: "error" })
    const bytes = await boundedBody(response, MAX_ATTACHMENT_BYTES)
    if (!response.ok)
      throw new Error(`Platform attachment download failed (${response.status}): ${safeErrorBody(decode(bytes))}`)
    return bytes
  }

  private async atomicWrite(target: string, value: string | Uint8Array) {
    await mkdir(path.dirname(target), { recursive: true })
    const existing = await lstat(target).catch(() => undefined)
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw new Error(`Platform challenge target is not a real file: ${target}`)
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, value, { mode: 0o600 })
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  private async assertOwned(directory: string, challengeID: string) {
    const info = await lstat(directory).catch(() => undefined)
    if (!info) {
      await mkdir(directory, { recursive: true })
      return
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Platform challenge directory is not a real directory: ${directory}`)
    const metadata = await readFile(path.join(directory, "meta.json"), "utf8")
      .then((raw) => JSON.parse(raw) as JsonObject)
      .catch(() => undefined)
    const platform = metadata?.platform
    const owner = platform && typeof platform === "object" ? platform as JsonObject : undefined
    if (owner?.adapter !== this.id || String(owner.challenge_id ?? "") !== challengeID)
      throw new Error(`Refusing to overwrite challenge directory not owned by ${this.id}: ${directory}`)
  }

  async acquireChallenges(input: ChallengeAcquisitionInput): Promise<Challenge[]> {
    const overrides = runtimeVariables(input.options, "Platform acquisition option")
    const variables = { ...(this.manifest.variables ?? {}), ...overrides }
    const listOperation = this.manifest.operations.listChallenges
    const listValue = await this.request(listOperation.request, { variable: variables }, input.signal)
    let listed = this.item(listValue, listOperation.response, true) as unknown[]
    if (input.selection) {
      const selection = input.selection
      const excluded = new Set(selection.exclude ?? [])
      const selected = new Set(selection.ids ?? [])
      const search = selection.query?.search?.trim().toLocaleLowerCase()
      listed = listed.filter((raw) => {
        const item = object(raw, "Platform challenge-list item")
        const preview = this.preview(item, listOperation.response)
        if (selection.all) {
          if (excluded.has(preview.id)) return false
          if (!search) return true
          return [preview.id, preview.challengeID, preview.title, preview.slug, preview.description]
            .some((value) => value?.toLocaleLowerCase().includes(search))
        }
        return selected.has(preview.id)
      })
    }
    const materialized: Challenge[] = []
    const used = new Set<string>()

    for (const raw of listed) {
      const listItem = object(raw, "Platform challenge-list item")
      const initial = this.mappedChallenge(listItem, listOperation.response)
      const itemOptions = this.mappedOptions(listItem, listOperation.response)
      let source = listItem
      let response = listOperation.response
      if (this.manifest.operations.getChallenge) {
        const detailOperation = this.manifest.operations.getChallenge
        const detailValue = await this.request(
          detailOperation.request,
          {
            challenge: { ...listItem, ...itemOptions, id: initial.id, slug: initial.slug },
            variable: variables,
          },
          input.signal,
        )
        source = this.item(detailValue, detailOperation.response, false) as JsonObject
        response = detailOperation.response
      }
      const detail = this.mappedChallenge(source, response)
      const merged = {
        id: detail.id || initial.id,
        slug: detail.slug || initial.slug,
        title: detail.title || initial.title,
        description: detail.description ?? initial.description,
        category: detail.category ?? initial.category,
        difficulty: detail.difficulty ?? initial.difficulty,
        flagFormat: detail.flagFormat ?? initial.flagFormat,
        remote: detail.remote ?? initial.remote,
      }
      let slug = this.slug(merged.slug || merged.title || merged.id)
      if (used.has(slug)) slug = this.slug(`${slug}-${merged.id}`)
      if (used.has(slug)) throw new Error(`Platform adapter ${this.id} produced duplicate challenge slug ${slug}`)
      used.add(slug)

      const category = normalizeChallengeCategory(merged.category)
      const directory = path.join(path.resolve(input.root), "challenges", category, slug)
      await this.assertOwned(directory, merged.id)
      const attachments = this.attachments(source, response)
      const attachmentNames = new Set<string>()
      for (const attachment of attachments) {
        if (attachmentNames.has(attachment.name))
          throw new Error(`Platform challenge ${slug} has duplicate attachment name ${attachment.name}`)
        attachmentNames.add(attachment.name)
        const bytes = await this.download(new URL(attachment.url), input.signal)
        await this.atomicWrite(path.join(directory, "files", attachment.name), bytes)
      }
      const title = merged.title || slug
      const description = merged.description?.trim()
      const persistedOptions = { ...overrides, ...itemOptions }
      await this.atomicWrite(
        path.join(directory, "README.md"),
        `${description?.startsWith("#") ? description : `# ${title}${description ? `\n\n${description}` : ""}`}\n`,
      )
      await this.atomicWrite(
        path.join(directory, "meta.json"),
        `${JSON.stringify({
          ...(merged.flagFormat ? { flag_format: merged.flagFormat } : {}),
          category,
          ...(merged.difficulty ? { difficulty: merged.difficulty } : {}),
          ...(merged.remote ? { remote: merged.remote } : {}),
          platform: {
            adapter: this.id,
            challenge_id: merged.id,
            ...(Object.keys(persistedOptions).length ? { options: persistedOptions } : {}),
          },
        }, undefined, 2)}\n`,
      )
      materialized.push(await loadChallenge(directory, new Map()))
    }
    return materialized
  }

  private verdict(
    value: unknown,
    operation: SubmissionOperationManifest,
  ): Pick<FlagSubmissionResult, "verdict" | "detail"> {
    const response = operation.response
    const raw = response.verdict ? valueAt(value, response.verdict) : undefined
    const matches = (candidates: TemplateScalar[] | undefined) => candidates?.some((candidate) =>
      typeof candidate === "string" && typeof raw === "string"
        ? candidate.toLowerCase() === raw.toLowerCase()
        : candidate === raw
    ) ?? false
    const detailValue = response.detail ? valueAt(value, response.detail) : undefined
    const detail = typeof detailValue === "string" && detailValue.trim()
      ? detailValue.trim().slice(0, 4_096)
      : raw === undefined
        ? "Platform accepted the submission request but did not expose a mapped verdict"
        : `Platform verdict: ${String(raw).slice(0, 1_024)}`
    if (matches(response.accepted)) return { verdict: "accepted", detail }
    if (matches(response.rejected)) return { verdict: "rejected", detail }
    if (matches(response.pending)) return { verdict: "pending", detail }
    return { verdict: "pending", detail: `Unrecognized ${detail}` }
  }

  async submitFlag(input: FlagSubmissionInput): Promise<FlagSubmissionResult> {
    const operation = this.manifest.operations.submitFlag
    if (!operation) throw new Error(`Platform adapter ${this.id} does not support automatic flag submission`)
    const challengeID = input.challenge.platform?.challengeID
    if (!challengeID) throw new Error(`Challenge ${input.challenge.slug} has no platform challenge ID`)
    const challengeVariables = runtimeVariables(input.challenge.platform?.options, "Challenge platform option")
    const value = await this.request(operation.request, {
      challenge: {
        id: challengeID,
        slug: input.challenge.slug,
        ...(input.challenge.platform?.options ?? {}),
      },
      flag: input.candidate,
      variable: { ...(this.manifest.variables ?? {}), ...challengeVariables },
    }, input.signal)
    return {
      adapter: this.id,
      ...this.verdict(value, operation),
      submittedAt: new Date().toISOString(),
    }
  }
}

export async function loadConfiguredPlatformAdapter(root: string, adapterID: string) {
  const manifest = await loadPlatformManifest(root, adapterID)
  if (!manifest) return undefined
  if (manifest.profile === "dasctf-practice-v1") {
    const { DasctfPracticePlatformAdapter } = await import("./dasctf-platform-adapter.ts")
    return new DasctfPracticePlatformAdapter(manifest)
  }
  return new DeclarativeHttpPlatformAdapter(manifest)
}

/** Registry used by product surfaces. Manifests are loaded lazily from `<root>/platforms/`. */
export function configuredPlatformAdapterRegistry() {
  return new PlatformAdapterRegistry([], (adapterID, root) => loadConfiguredPlatformAdapter(root, adapterID))
}
