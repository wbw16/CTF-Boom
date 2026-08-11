import path from "node:path"
import { DeclarativeHttpPlatformAdapter } from "./http-platform-adapter.ts"
import type {
  ChallengeAcquisitionInput,
  CtfPlatformAdapter,
  FlagSubmissionInput,
  PlatformChallengeCatalog,
  PlatformChallengeCatalogInput,
  PlatformChallengePreview,
  PlatformChallengeQuery,
} from "./platform-adapter.ts"
import type { PlatformAdapterManifest } from "./platform-manifest.ts"

type JsonObject = Record<string, unknown>
type CatalogRow = { challenge: JsonObject; practice_ground: JsonObject }

const CATALOG_PATH = "/api/v1/public/practice/challenges/"
const SYNTHETIC_LIST_PATH = "/__boom_dasctf_practice_selected__"
const MAX_CATALOG_ITEMS = 20_000
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function identifier(value: unknown, label: string) {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim())
    throw new Error(`DASCTF catalog item has no ${label}`)
  const found = String(value).trim()
  if (found.length > 256 || found.includes("\0") || found.includes("/") || found.includes(":"))
    throw new Error(`DASCTF catalog item has an invalid ${label}`)
  return found
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function selectionID(groundID: string, challengeID: string) {
  return `${groundID}:${challengeID}`
}

function parseSelectionID(value: string) {
  const separator = value.indexOf(":")
  if (separator < 1 || separator === value.length - 1 || value.indexOf(":", separator + 1) !== -1)
    throw new Error("Invalid DASCTF challenge selection")
  return {
    groundID: identifier(value.slice(0, separator), "practice ground ID"),
    challengeID: identifier(value.slice(separator + 1), "challenge ID"),
  }
}

function catalogRow(value: unknown): CatalogRow {
  const row = object(value)
  const challenge = object(row?.challenge) ?? row
  const ground = object(row?.practice_ground)
  if (!challenge || !ground) throw new Error("DASCTF returned an invalid practice catalog item")
  identifier(challenge.id, "challenge ID")
  identifier(ground.id ?? challenge.practice_ground_id, "practice ground ID")
  return { challenge, practice_ground: ground }
}

function preview(value: unknown): PlatformChallengePreview {
  const row = catalogRow(value)
  const challengeID = identifier(row.challenge.id, "challenge ID")
  const groundID = identifier(
    row.practice_ground.id ?? row.challenge.practice_ground_id,
    "practice ground ID",
  )
  const title = text(row.challenge.name) ?? text(row.challenge.title) ?? challengeID
  const groupName = text(row.practice_ground.name) ?? text(row.practice_ground.title) ?? groundID
  return {
    id: selectionID(groundID, challengeID),
    challengeID,
    title,
    ...(text(row.challenge.friendly_id) ? { slug: text(row.challenge.friendly_id)! } : {}),
    ...(text(row.challenge.description) ? { description: text(row.challenge.description)! } : {}),
    ...(text(row.challenge.category) ? { category: text(row.challenge.category)! } : {}),
    ...(text(row.challenge.difficulty) ? { difficulty: text(row.challenge.difficulty)! } : {}),
    ...(number(row.challenge.points) === undefined ? {} : { points: number(row.challenge.points)! }),
    ...(typeof row.challenge.is_solved === "boolean" ? { solved: row.challenge.is_solved } : {}),
    group: { id: groundID, name: groupName },
  }
}

function queryValues(query: PlatformChallengeQuery | undefined) {
  return {
    page: Math.max(1, Math.floor(query?.page ?? 1)),
    pageSize: Math.max(1, Math.min(100, Math.floor(query?.pageSize ?? 50))),
    search: query?.search?.trim() || undefined,
    category: query?.category?.trim() || undefined,
    difficulty: query?.difficulty?.trim() || undefined,
  }
}

function unwrap(value: unknown) {
  const root = object(value)
  return root && "data" in root && (root.success === true || Object.keys(root).length === 1)
    ? root.data
    : value
}

async function boundedJSON(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new Error(`DASCTF response exceeds ${MAX_RESPONSE_BYTES} bytes`)
  const raw = await response.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES)
    throw new Error(`DASCTF response exceeds ${MAX_RESPONSE_BYTES} bytes`)
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error("DASCTF did not return JSON")
  }
}

function errorDetail(value: unknown) {
  const root = object(value)
  const error = object(root?.error)
  return [error?.code, error?.message, root?.message]
    .find((item) => typeof item === "string" && item.trim()) as string | undefined
}

function fileItems(challenge: JsonObject) {
  for (const key of ["files", "attachments", "downloads", "challenge_files"]) {
    const found = challenge[key]
    if (Array.isArray(found)) return found
  }
  return []
}

function normalizedFiles(
  challenge: JsonObject,
  baseURL: string,
  groundID: string,
  challengeID: string,
) {
  return fileItems(challenge).map((raw, index) => {
    if (typeof raw === "string") {
      const parsed = new URL(raw, baseURL)
      return { name: path.basename(parsed.pathname) || `attachment-${index + 1}`, url: parsed.toString() }
    }
    const item = object(raw)
    if (!item) throw new Error(`DASCTF attachment ${index + 1} is invalid`)
    const explicitURL = text(item.download_url) ?? text(item.downloadUrl) ?? text(item.url) ??
      text(item.path) ?? text(object(item.file)?.url)
    const fileID = text(item.file_id) ?? text(object(item.file)?.id) ?? text(item.id)
    const url = explicitURL
      ? new URL(explicitURL, baseURL)
      : fileID
        ? new URL(
            `/api/v1/practice/${encodeURIComponent(groundID)}/challenges/${encodeURIComponent(challengeID)}/files/${encodeURIComponent(fileID)}/`,
            baseURL,
          )
        : undefined
    if (!url) throw new Error(`DASCTF attachment ${index + 1} has no download URL or file ID`)
    const name = text(item.file_name) ?? text(item.filename) ?? text(item.name) ??
      text(object(item.file)?.name) ?? path.basename(url.pathname) ?? `attachment-${index + 1}`
    return { name, url: url.toString() }
  })
}

function detailObject(value: unknown) {
  const data = unwrap(value)
  const found = object(data)
  return object(found?.challenge) ?? found
}

function dasctfRuntimeManifest(manifest: PlatformAdapterManifest): PlatformAdapterManifest {
  return {
    ...manifest,
    operations: {
      listChallenges: {
        request: { method: "GET", path: SYNTHETIC_LIST_PATH },
        response: {
          items: "items",
          fields: {
            id: "challenge.id",
            slug: "challenge.friendly_id",
            title: "challenge.name",
            description: "challenge.description",
            category: "challenge.category",
            difficulty: "challenge.difficulty",
            remote: "challenge.remote",
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
  }
}

export class DasctfPracticePlatformAdapter implements CtfPlatformAdapter {
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

  private async catalogPage(query: PlatformChallengeQuery | undefined, signal?: AbortSignal) {
    const normalized = queryValues(query)
    const url = new URL(CATALOG_PATH, this.manifest.baseURL)
    url.searchParams.set("page", String(normalized.page))
    url.searchParams.set("page_size", String(normalized.pageSize))
    if (normalized.search) url.searchParams.set("search", normalized.search)
    if (normalized.category) url.searchParams.set("category", normalized.category)
    if (normalized.difficulty) url.searchParams.set("difficulty", normalized.difficulty)
    const response = await this.fetcher(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal,
    })
    const payload = await boundedJSON(response)
    if (!response.ok)
      throw new Error(`DASCTF practice catalog failed (${response.status}): ${errorDetail(payload) ?? "request rejected"}`)
    const envelope = object(unwrap(payload))
    const rows = Array.isArray(envelope?.data)
      ? envelope.data
      : Array.isArray(envelope?.items)
        ? envelope.items
        : []
    const total = number(envelope?.total) ?? rows.length
    if (total > MAX_CATALOG_ITEMS)
      throw new Error(`DASCTF catalog has ${total} items; Boom's safety limit is ${MAX_CATALOG_ITEMS}`)
    const facets = object(envelope?.facets)
    const strings = (value: unknown) => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : undefined
    return {
      rows: rows.map(catalogRow),
      page: number(envelope?.page) ?? normalized.page,
      pageSize: number(envelope?.page_size) ?? normalized.pageSize,
      total,
      categories: strings(facets?.categories),
      difficulties: strings(facets?.difficulties),
    }
  }

  async listChallenges(input: PlatformChallengeCatalogInput): Promise<PlatformChallengeCatalog> {
    const page = await this.catalogPage(input.query, input.signal)
    return {
      items: page.rows.map(preview),
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      ...(page.categories ? { categories: page.categories } : {}),
      ...(page.difficulties ? { difficulties: page.difficulties } : {}),
    }
  }

  private async selectedRows(input: ChallengeAcquisitionInput) {
    const selection = input.selection
    if (!selection) {
      const first = await this.catalogPage({ page: 1, pageSize: 100 }, input.signal)
      if (first.total > first.rows.length)
        throw new Error("DASCTF synchronization requires an explicit GUI/CLI challenge selection")
      return first.rows
    }
    const excluded = new Set(selection.exclude ?? [])
    if (!selection.all) {
      const identifiers = (selection.ids ?? []).filter((id) => !excluded.has(id))
      if (identifiers.length === 0) return []
      const wanted = new Set(identifiers)
      const query = { ...(selection.query ?? {}), page: 1, pageSize: 100 }
      const first = await this.catalogPage(query, input.signal)
      const rows = [...first.rows]
      const found = new Set(rows.map((row) => preview(row).id).filter((id) => wanted.has(id)))
      const totalPages = Math.ceil(first.total / first.pageSize)
      for (let start = 2; start <= totalPages && found.size < wanted.size; start += 6) {
        const pages = await Promise.all(
          Array.from({ length: Math.min(6, totalPages - start + 1) }, (_, offset) =>
            this.catalogPage({ ...query, page: start + offset }, input.signal)),
        )
        for (const page of pages) {
          rows.push(...page.rows)
          for (const row of page.rows) {
            const id = preview(row).id
            if (wanted.has(id)) found.add(id)
          }
        }
      }
      const byID = new Map(rows.map((row) => [preview(row).id, row]))
      return identifiers.map((id) => {
        const row = byID.get(id)
        if (row) return row
        // The catalog can change between selection and synchronization. Preserve the user's explicit
        // choice and let the authenticated detail endpoint supply what remains available.
        const parsed = parseSelectionID(id)
        return {
          challenge: { id: parsed.challengeID, friendly_id: parsed.challengeID },
          practice_ground: { id: parsed.groundID, name: parsed.groundID },
        } satisfies CatalogRow
      })
    }

    const query = { ...(selection.query ?? {}), page: 1, pageSize: 100 }
    const first = await this.catalogPage(query, input.signal)
    const rows = [...first.rows]
    const totalPages = Math.ceil(first.total / first.pageSize)
    for (let start = 2; start <= totalPages; start += 6) {
      const pages = await Promise.all(
        Array.from({ length: Math.min(6, totalPages - start + 1) }, (_, offset) =>
          this.catalogPage({ ...query, page: start + offset }, input.signal)),
      )
      for (const page of pages) rows.push(...page.rows)
    }
    return rows.filter((row) => {
      const item = preview(row)
      return !excluded.has(item.id)
    })
  }

  private normalizedFetcher(rows: CatalogRow[]): typeof fetch {
    return (async (input, init) => {
      const requestURL = input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? new URL(input)
          : new URL(input)
      if (requestURL.pathname === SYNTHETIC_LIST_PATH)
        return Response.json({ items: rows })

      const response = await this.fetcher(input, init)
      const detail = /^\/api\/open\/v1\/user\/practice\/([^/]+)\/challenges\/([^/]+)\/$/.exec(requestURL.pathname)
      const submission = requestURL.pathname.endsWith("/submit/") && init?.method === "POST"
      if (!response.ok || (!detail && !submission)) return response

      const payload = await boundedJSON(response)
      if (detail) {
        const groundID = decodeURIComponent(detail[1]!)
        const challengeID = decodeURIComponent(detail[2]!)
        const found = detailObject(payload)
        if (!found) throw new Error("DASCTF returned an invalid practice challenge detail")
        const normalized = {
          ...found,
          id: found.id ?? challengeID,
          friendly_id: found.friendly_id ?? challengeID,
          name: found.name ?? found.title ?? challengeID,
          description: found.description ?? found.content ?? "",
          flag_format: found.flag_format ?? found.flag_regex ?? "",
          remote: found.remote ?? found.connection_info ?? object(found.target)?.access_url ??
            object(found.environment)?.access_url ?? "",
          files: normalizedFiles(found, this.manifest.baseURL, groundID, challengeID),
        }
        return Response.json({ data: normalized }, { status: response.status })
      }

      const found = object(unwrap(payload)) ?? {}
      const accepted = typeof found.accepted === "boolean"
        ? found.accepted
        : typeof found.is_correct === "boolean"
          ? found.is_correct
          : typeof found.correct === "boolean"
            ? found.correct
            : null
      return Response.json({ data: {
        ...found,
        accepted,
        message: text(found.message) ?? text(found.detail) ??
          (accepted === true ? "DASCTF accepted the flag" : accepted === false ? "DASCTF rejected the flag" : "DASCTF submission is pending"),
      } }, { status: response.status })
    }) as typeof fetch
  }

  async acquireChallenges(input: ChallengeAcquisitionInput) {
    const rows = await this.selectedRows(input)
    if (rows.length === 0) return []
    const adapter = new DeclarativeHttpPlatformAdapter(
      dasctfRuntimeManifest(this.manifest),
      this.normalizedFetcher(rows),
    )
    return adapter.acquireChallenges({ ...input, selection: undefined })
  }

  async submitFlag(input: FlagSubmissionInput) {
    const adapter = new DeclarativeHttpPlatformAdapter(
      dasctfRuntimeManifest(this.manifest),
      this.normalizedFetcher([]),
    )
    return adapter.submitFlag(input)
  }
}
