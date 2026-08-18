import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { loadChallenge, normalizeChallengeCategory, type Challenge } from "./challenge.ts"
import type {
  ChallengeAcquisitionInput,
  CtfPlatformAdapter,
  FlagSubmissionInput,
  FlagSubmissionResult,
  PlatformChallengeCatalog,
  PlatformChallengeCatalogInput,
  PlatformChallengePreview,
} from "./platform-adapter.ts"
import type { PlatformAdapterManifest } from "./platform-manifest.ts"

/**
 * 西湖论剑 "AI Agent API" adapter.
 *
 * This profile is hand-written rather than declarative because the API does not fit the
 * declarative manifest mappers in three ways, all verified against the live service:
 *
 * 1. Every response is wrapped in `{code, message, data}` where only `code === "00000"` means
 *    success. HTTP 200 alone is not success, so the declarative engine's status-only check would
 *    silently treat business failures as empty data.
 * 2. The challenge list is two levels deep (category -> `corpus[]`); the declarative item mapper
 *    selects a single array.
 * 3. `attachment` is a single object when present but an empty array when absent, so one field has
 *    two different JSON types.
 *
 * See docs/XIHULUNJIAN.md for the recorded deviations from docs/api_doc.md.
 */

type JsonObject = Record<string, unknown>

const API_PREFIX = "/slab-match/api/v1/agent"
const SUCCESS_CODE = "00000"
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024

/**
 * Boom's own guard, deliberately far below the platform's hard limit of 50 attempts per challenge.
 * The rules forbid flag brute-forcing outright, so the useful ceiling is "a few genuine candidates",
 * not "as many as the platform tolerates".
 */
export const MAX_SUBMISSIONS_PER_CHALLENGE = 15

/** How long to wait for an asynchronously provisioned environment before giving up on this attempt. */
const ENVIRONMENT_POLL_TIMEOUT_MS = 3 * 60_000
const ENVIRONMENT_POLL_INTERVAL_MS = 5_000

/**
 * The live service rate-limits with HTTP 429 and business code 40001 ("请求过于频繁"), which
 * docs/api_doc.md does not mention. Three back-to-back detail reads were enough to trigger it, so
 * every call is serialized with a minimum gap and retried with backoff. Without this a burst of
 * catalog reads would fail mid-match.
 */
const MIN_REQUEST_GAP_MS = 700
const RATE_LIMIT_CODE = "40001"
const RATE_LIMIT_RETRIES = 4
const RATE_LIMIT_BASE_DELAY_MS = 1_500

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** `score` arrives as a string such as "50.0"; keep it numeric for prioritization. */
function numeric(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function identifier(value: unknown, label: string) {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim())
    throw new Error(`西湖论剑接口返回的${label}为空`)
  const found = String(value).trim()
  if (found.length > 256 || /[\0/:]/.test(found))
    throw new Error(`西湖论剑接口返回的${label}非法: ${found}`)
  return found
}

function safeErrorBody(value: string) {
  return value.replace(/[\0\r\n]+/g, " ").slice(0, 2_000)
}

async function boundedBytes(response: Response, maximum: number) {
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declared) && declared > maximum)
    throw new Error(`西湖论剑响应超过 ${maximum} 字节上限`)
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximum) throw new Error(`西湖论剑响应超过 ${maximum} 字节上限`)
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

/**
 * Strip the flag wrapper so only the inner value is submitted, per the competition rules
 * ("提交时仅需提交 {} 内内容"). This is deliberately done in code rather than in the solver prompt:
 * the model produces the natural full flag and the wire format stays deterministic. A candidate that
 * is already bare passes through untouched.
 */
export function innerFlagValue(candidate: string) {
  const trimmed = candidate.trim()
  const wrapped = /^[A-Za-z0-9_.-]{1,32}\{(.*)\}$/s.exec(trimmed)
  return wrapped ? wrapped[1]!.trim() : trimmed
}

export type XihulunjianEndpoint = {
  /** `host:port` Boom hands to the solver. */
  remote?: string
  /** Full connection matrix rendered into the challenge README for the solver to read. */
  detail: string
  expireTime?: number
}

/**
 * Reduce the platform's `endpoints[]` to Boom's single `remote` plus human-readable detail.
 * A proxied endpoint is preferred when the platform marks it, because the direct IP is then
 * usually unreachable from the contest network.
 */
export function selectEndpoint(endpoints: unknown): XihulunjianEndpoint | undefined {
  if (!Array.isArray(endpoints) || endpoints.length === 0) return undefined
  const lines: string[] = []
  let remote: string | undefined
  let expireTime: number | undefined
  for (const raw of endpoints) {
    const found = object(raw)
    if (!found) continue
    const exposeIps = Array.isArray(found.exposeIps)
      ? found.exposeIps.map((item) => text(item)).filter((item): item is string => Boolean(item))
      : []
    const ports = Array.isArray(found.ports)
      ? found.ports.map((item) => text(item) ?? (numeric(item) === undefined ? undefined : String(numeric(item))))
          .filter((item): item is string => Boolean(item))
      : []
    const proxyIps = Array.isArray(found.proxyIps)
      ? found.proxyIps.map((item) => text(item)).filter((item): item is string => Boolean(item))
      : []
    const mappings = Array.isArray(found.portMappings)
      ? found.portMappings.flatMap((item) => {
          const mapping = object(item)
          if (!mapping) return []
          const port = text(mapping.port) ?? String(numeric(mapping.port) ?? "")
          const proxy = text(mapping.proxy) ?? String(numeric(mapping.proxy) ?? "")
          if (!port || !proxy) return []
          return [{ type: text(mapping.type) ?? "tcp", port, proxy }]
        })
      : []
    const proxied = found.isProxy === true
    if (!remote) {
      // Verified live: `exposeIps` entries already carry `host:port` (e.g. "1.14.76.59:27629") and
      // `ports` holds protocol-qualified values such as "http/80", so an exposed entry must not be
      // re-joined with a port. Only fall back to composing one when it has no port of its own.
      const exposed = exposeIps[0]
      const bareProxyPort = mappings[0]?.proxy
      if (proxied && proxyIps[0] && bareProxyPort) remote = `${proxyIps[0]}:${bareProxyPort}`
      else if (exposed?.includes(":")) remote = exposed
      else if (exposed && ports[0]) remote = `${exposed}:${ports[0]!.replace(/^.*\//, "")}`
      else if (proxyIps[0] && bareProxyPort) remote = `${proxyIps[0]}:${bareProxyPort}`
    }
    const expires = numeric(found.expireTime)
    if (expires !== undefined) expireTime = expireTime === undefined ? expires : Math.min(expireTime, expires)

    if (exposeIps.length)
      lines.push(
        `- 直连地址：${exposeIps.join(", ")}` +
          (ports.length ? `（开放端口：${ports.join(", ")}）` : ""),
      )
    if (proxyIps.length) lines.push(`- 代理 IP：${proxyIps.join(", ")}${proxied ? "（平台建议优先使用代理）" : ""}`)
    for (const mapping of mappings)
      lines.push(`- 端口映射：${mapping.type} 容器 ${mapping.port} -> 代理 ${mapping.proxy}`)
    if (Array.isArray(found.users)) {
      for (const item of found.users) {
        const user = object(item)
        const username = text(user?.username)
        if (!username) continue
        const password = text(user?.password)
        lines.push(`- 账号：${username}${password ? ` / 密码：${password}` : ""}`)
      }
    }
    if (expires !== undefined)
      lines.push(`- 环境过期时间：${new Date(expires).toISOString()}`)
  }
  if (!remote && lines.length === 0) return undefined
  return {
    ...(remote ? { remote } : {}),
    detail: lines.join("\n"),
    ...(expireTime === undefined ? {} : { expireTime }),
  }
}

type ExerciseDetail = {
  id: string
  name: string
  description: string
  score?: number
  difficulty?: string
  category?: string
  solved: boolean
  attachments: Array<{ name: string; url: string }>
  endpoint?: XihulunjianEndpoint
  needsInit: boolean
  needsCheck: boolean
  /** `none` means the challenge has no target service at all, so it is purely local. */
  serviceRequired: boolean
}

/**
 * `attachment` is a single object when the challenge has a file and an empty array when it does not.
 * Accept both, plus the `{files:[...]}` shape that docs/api_doc.md documents, so a later API change
 * back to the documented form keeps working.
 */
function attachmentsOf(value: unknown): Array<{ name: string; url: string }> {
  const items: unknown[] = Array.isArray(value)
    ? value
    : (() => {
        const found = object(value)
        if (!found) return []
        if (Array.isArray(found.files)) return found.files
        return [found]
      })()
  const attachments: Array<{ name: string; url: string }> = []
  for (const [index, raw] of items.entries()) {
    const item = object(raw)
    if (!item) continue
    const url = text(item.url) ?? text(item.previewUrl) ?? text(item.downloadUrl)
    if (!url) continue
    const extension = text(item.extension)
    const fallback = `attachment-${index + 1}${extension ? `.${extension}` : ""}`
    attachments.push({ name: text(item.name) ?? fallback, url })
  }
  return attachments
}

/** Raised only for platform rate limiting, which is retryable; every other failure is not. */
export class XihulunjianRateLimitError extends Error {}

export class XihulunjianPlatformAdapter implements CtfPlatformAdapter {
  readonly id: string
  readonly name?: string
  /** Tail of the serialized request chain; every call waits for the previous one. */
  private pending: Promise<void> = Promise.resolve()
  private lastRequestAt = 0

  constructor(
    private readonly manifest: PlatformAdapterManifest,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> =
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (manifest.status !== "ready")
      throw new Error(`Platform adapter ${manifest.id} is still a draft; review it and set status to ready`)
    this.id = manifest.id
    this.name = manifest.name
  }

  private credential() {
    const auth = this.manifest.auth
    if (!auth) throw new Error(`西湖论剑适配器 ${this.id} 缺少 AccessKey 配置`)
    const value = process.env[auth.env]?.trim()
    if (!value)
      throw new Error(`西湖论剑适配器 ${this.id} 需要环境变量 ${auth.env} 提供 AccessKey`)
    return value
  }

  /**
   * Serialize platform calls and keep a minimum gap between them. The platform rate-limits per
   * account and only one Agent may be connected, so pacing every request through one chain is both
   * sufficient and necessary: parallel bursts are what trigger 40001.
   */
  private async throttle<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending
    let release = () => {}
    this.pending = new Promise<void>((resolve) => { release = resolve })
    await previous.catch(() => {})
    try {
      const wait = this.lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
      if (wait > 0) await this.sleep(wait)
      return await operation()
    } finally {
      this.lastRequestAt = Date.now()
      release()
    }
  }

  /**
   * One platform call, throttled and retried on rate limiting. Enforces the `{code,message,data}`
   * envelope so a business failure surfaces as a real error with the platform's own message instead
   * of being mistaken for empty data.
   */
  private async call(
    method: "GET" | "POST",
    endpoint: string,
    options: { query?: Record<string, string>; body?: JsonObject; signal?: AbortSignal } = {},
  ) {
    let lastError: unknown
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt += 1) {
      if (options.signal?.aborted) throw new Error(`西湖论剑请求被取消: ${endpoint}`)
      if (attempt > 0) await this.sleep(RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1))
      try {
        return await this.throttle(() => this.attempt(method, endpoint, options))
      } catch (error) {
        lastError = error
        if (!(error instanceof XihulunjianRateLimitError)) throw error
      }
    }
    throw lastError
  }

  private async attempt(
    method: "GET" | "POST",
    endpoint: string,
    options: { query?: Record<string, string>; body?: JsonObject; signal?: AbortSignal } = {},
  ) {
    const base = new URL(this.manifest.baseURL)
    const url = new URL(`${base.pathname.replace(/\/$/, "")}${API_PREFIX}${endpoint}`, base.origin)
    if (url.origin !== base.origin)
      throw new Error(`西湖论剑请求越出配置的源: ${url.origin}`)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)

    const headers = new Headers({ Accept: "application/json" })
    const auth = this.manifest.auth!
    const credential = `${auth.prefix ?? ""}${this.credential()}`
    if (auth.location === "header") headers.set(auth.name, credential)
    else if (auth.location === "query") url.searchParams.set(auth.name, credential)
    else headers.append("Cookie", `${auth.name}=${encodeURIComponent(credential)}`)

    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    if (body !== undefined) headers.set("Content-Type", "application/json")

    const response = await this.fetcher(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: options.signal,
      redirect: "error",
    })
    const bytes = await boundedBytes(response, MAX_RESPONSE_BYTES)
    const raw = new TextDecoder().decode(bytes)
    let payload: unknown
    try {
      payload = JSON.parse(raw) as unknown
    } catch {
      payload = undefined
    }
    const envelope = object(payload)
    const code = text(envelope?.code)
    const message = text(envelope?.message) ?? "无描述"
    // Rate limiting arrives as HTTP 429 and/or business code 40001; both are retryable.
    if (response.status === 429 || code === RATE_LIMIT_CODE)
      throw new XihulunjianRateLimitError(
        `西湖论剑接口 ${method} ${endpoint} 触发限流 (${response.status}/${code ?? "-"}): ${message}`,
      )
    if (!response.ok)
      throw new Error(`西湖论剑接口 ${method} ${endpoint} 失败 (${response.status}): ${safeErrorBody(raw)}`)
    if (!envelope) throw new Error(`西湖论剑接口 ${method} ${endpoint} 返回结构异常`)
    if (code !== SUCCESS_CODE)
      throw new Error(
        `西湖论剑接口 ${method} ${endpoint} 返回业务失败 (code=${code ?? "缺失"}): ${message}`,
      )
    return envelope.data
  }

  /** Flatten `分类[].corpus[]` into Boom's flat preview list. */
  private async exerciseList(signal?: AbortSignal) {
    const data = await this.call("GET", "/ctf/exercise-list", { signal })
    if (!Array.isArray(data)) throw new Error("西湖论剑题目列表结构异常")
    const previews: PlatformChallengePreview[] = []
    for (const raw of data) {
      const group = object(raw)
      if (!group) continue
      const groupID = identifier(group.id, "分类 ID")
      const groupName = text(group.name) ?? groupID
      const corpus = Array.isArray(group.corpus) ? group.corpus : []
      for (const entry of corpus) {
        const item = object(entry)
        if (!item) continue
        // A challenge that is not yet open cannot be fetched or solved; batched releases mean the
        // list must be re-read later rather than treated as complete.
        if (item.isOpen === false) continue
        const challengeID = identifier(item.id, "题目 ID")
        previews.push({
          id: challengeID,
          challengeID,
          title: text(item.name) ?? challengeID,
          category: groupName,
          ...(typeof item.hasSolved === "boolean" ? { solved: item.hasSolved } : {}),
          group: { id: groupID, name: groupName },
        })
      }
    }
    return previews
  }

  async listChallenges(input: PlatformChallengeCatalogInput): Promise<PlatformChallengeCatalog> {
    const all = await this.exerciseList(input.signal)
    const query = input.query ?? {}
    const search = query.search?.trim().toLocaleLowerCase()
    const category = query.category?.trim()
    const filtered = all.filter((item) => {
      if (category && item.category !== category) return false
      if (!search) return true
      return [item.id, item.title, item.category]
        .some((value) => value?.toLocaleLowerCase().includes(search))
    })
    const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize ?? 50)))
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
    const page = Math.max(1, Math.min(pages, Math.floor(query.page ?? 1)))
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: filtered.length,
      categories: [...new Set(all.map((item) => item.category).filter((value): value is string => Boolean(value)))],
    }
  }

  /** Read one challenge's detail. Never starts an environment; that is an explicit separate step. */
  async exerciseDetail(exerciseId: string, signal?: AbortSignal): Promise<ExerciseDetail> {
    const data = object(await this.call("GET", "/ctf/exercise", {
      query: { exerciseId },
      signal,
    }))
    if (!data) throw new Error(`西湖论剑题目 ${exerciseId} 详情结构异常`)
    const endpointType = text(data.endpointType)
    return {
      id: identifier(data.id ?? exerciseId, "题目 ID"),
      name: text(data.name) ?? exerciseId,
      description: text(data.description) ?? "",
      ...(numeric(data.score) === undefined ? {} : { score: numeric(data.score)! }),
      ...(text(data.difficulty) ? { difficulty: text(data.difficulty)! } : {}),
      solved: data.hasSolved === true,
      attachments: attachmentsOf(data.attachment),
      ...(selectEndpoint(data.endpoints) ? { endpoint: selectEndpoint(data.endpoints)! } : {}),
      needsInit: data.isNeedInit === true,
      needsCheck: data.isNeedCheck === true,
      // `endpointType: "none"` marks a purely local challenge, which must never consume one of the
      // three scarce remote environment slots.
      serviceRequired: data.isNeedInit === true ||
        (endpointType !== undefined && endpointType !== "none") ||
        Array.isArray(data.endpoints) && data.endpoints.length > 0,
    }
  }

  /** Start a challenge environment. Asynchronous: the caller must then poll for readiness. */
  async buildEnvironment(exerciseId: string, signal?: AbortSignal) {
    await this.call("POST", "/ctf/build-exercise-env", { body: { exerciseId: Number(exerciseId) }, signal })
  }

  /**
   * Release a challenge environment. Safe to call defensively: a failure here is reported by the
   * caller but must never mask the solving outcome, and must never block slot release.
   */
  async recoverEnvironment(exerciseId: string, signal?: AbortSignal) {
    await this.call("POST", "/ctf/recover-exercise-env", { body: { exerciseId: Number(exerciseId) }, signal })
  }

  /**
   * Bring a challenge's environment up and wait until the platform reports it usable. Bounded by
   * ENVIRONMENT_POLL_TIMEOUT_MS so a stuck environment cannot consume the whole match clock; the
   * caller decides whether to retry or move on.
   */
  async ensureEnvironment(
    exerciseId: string,
    options: { signal?: AbortSignal; now?: () => number } = {},
  ) {
    const now = options.now ?? (() => Date.now())
    const sleep = this.sleep
    let detail = await this.exerciseDetail(exerciseId, options.signal)
    if (detail.endpoint?.remote && !detail.needsCheck) return detail
    if (detail.needsInit) await this.buildEnvironment(exerciseId, options.signal)

    const deadline = now() + ENVIRONMENT_POLL_TIMEOUT_MS
    while (now() < deadline) {
      if (options.signal?.aborted) throw new Error("环境启动被取消")
      await sleep(ENVIRONMENT_POLL_INTERVAL_MS)
      detail = await this.exerciseDetail(exerciseId, options.signal)
      if (!detail.needsCheck && detail.endpoint?.remote) return detail
    }
    throw new Error(`西湖论剑题目 ${exerciseId} 环境在 ${ENVIRONMENT_POLL_TIMEOUT_MS / 1000}s 内未就绪`)
  }

  private slug(value: string) {
    const normalized = value.normalize("NFKC").trim().replace(/[\0-\x1f/\\:]+/g, "-").replace(/\.\./g, "-")
    const trimmed = normalized.replace(/^\.+|\.+$/g, "").slice(0, 160)
    if (!trimmed || trimmed === "." || trimmed === "..") throw new Error("西湖论剑题目名无法生成合法 slug")
    return trimmed
  }

  private async atomicWrite(target: string, value: string | Uint8Array) {
    await mkdir(path.dirname(target), { recursive: true })
    const existing = await lstat(target).catch(() => undefined)
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      throw new Error(`目标不是普通文件: ${target}`)
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
      throw new Error(`题目目录不是普通目录: ${directory}`)
    const metadata = await readFile(path.join(directory, "meta.json"), "utf8")
      .then((raw) => JSON.parse(raw) as JsonObject)
      .catch(() => undefined)
    const owner = object(metadata?.platform)
    if (owner && (owner.adapter !== this.id || String(owner.challenge_id ?? "") !== challengeID))
      throw new Error(`拒绝覆盖不属于 ${this.id} 的题目目录: ${directory}`)
  }

  /**
   * Download an attachment. Attachments live on a separate CDN origin, so the AccessKey is never
   * forwarded: it is a platform API credential and must not leak to object storage.
   */
  private async download(url: URL, signal?: AbortSignal) {
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`附件协议不受支持: ${url.protocol}`)
    const response = await this.fetcher(url, {
      headers: { Accept: "*/*" },
      signal,
      redirect: "follow",
    })
    const bytes = await boundedBytes(response, MAX_ATTACHMENT_BYTES)
    if (!response.ok)
      throw new Error(`附件下载失败 (${response.status}): ${safeErrorBody(new TextDecoder().decode(bytes))}`)
    return bytes
  }

  /**
   * Materialize selected challenges into Boom's normal layout.
   *
   * Environments are deliberately NOT started here. Acquisition happens once up front for the whole
   * catalog, while only three environments may exist at a time; starting them at download would burn
   * all three slots on challenges nobody is solving yet and start their expiry clocks.
   */
  async acquireChallenges(input: ChallengeAcquisitionInput): Promise<Challenge[]> {
    const previews = await this.exerciseList(input.signal)
    const selection = input.selection
    const excluded = new Set(selection?.exclude ?? [])
    const wanted = new Set(selection?.ids ?? [])
    const search = selection?.query?.search?.trim().toLocaleLowerCase()
    const selected = previews.filter((item) => {
      if (excluded.has(item.id)) return false
      if (selection?.all) {
        if (!search) return true
        return [item.id, item.title, item.category]
          .some((value) => value?.toLocaleLowerCase().includes(search))
      }
      if (!selection) return true
      return wanted.has(item.id)
    })

    const materialized: Challenge[] = []
    const used = new Set<string>()
    for (const item of selected) {
      const detail = await this.exerciseDetail(item.challengeID, input.signal)
      let slug = this.slug(detail.name || item.title || detail.id)
      if (used.has(slug)) slug = this.slug(`${slug}-${detail.id}`)
      used.add(slug)

      const category = normalizeChallengeCategory(detail.category ?? item.category)
      const directory = path.join(path.resolve(input.root), "challenges", category, slug)
      await this.assertOwned(directory, detail.id)

      const names = new Set<string>()
      for (const attachment of detail.attachments) {
        let name = this.slug(attachment.name)
        if (names.has(name)) name = this.slug(`${detail.id}-${name}`)
        names.add(name)
        const bytes = await this.download(new URL(attachment.url), input.signal)
        await this.atomicWrite(path.join(directory, "files", name), bytes)
      }

      const readme = [
        `# ${detail.name}`,
        "",
        detail.description || "（平台未提供题目描述）",
        ...(detail.endpoint?.detail
          ? ["", "## 环境连接信息", "", detail.endpoint.detail]
          : detail.serviceRequired
            ? ["", "## 环境连接信息", "", "该题需要靶机环境，尚未启动。解题调度会在获得环境槽位后启动并写入地址。"]
            : []),
      ].join("\n")
      await this.atomicWrite(path.join(directory, "README.md"), `${readme}\n`)

      await this.atomicWrite(
        path.join(directory, "meta.json"),
        `${JSON.stringify({
          category,
          ...(detail.difficulty ? { difficulty: detail.difficulty } : {}),
          ...(detail.endpoint?.remote ? { remote: detail.endpoint.remote } : {}),
          ...(detail.serviceRequired ? { service_required: true } : {}),
          platform: {
            adapter: this.id,
            challenge_id: detail.id,
            options: {
              exercise_id: detail.id,
              ...(detail.score === undefined ? {} : { score: detail.score }),
              ...(detail.difficulty ? { difficulty: detail.difficulty } : {}),
              ...(detail.endpoint?.expireTime === undefined
                ? {}
                : { expire_time: detail.endpoint.expireTime }),
            },
          },
        }, undefined, 2)}\n`,
      )
      materialized.push(await loadChallenge(directory, new Map()))
    }
    return materialized
  }

  /**
   * Submit a candidate. Only the value inside the flag wrapper goes on the wire.
   *
   * `isCorrect` is authoritative, so this is the fastest and most reliable verification available;
   * the competition applies no penalty for a wrong flag, which is why Boom submits promptly instead
   * of spending model budget on self-verification first.
   */
  async submitFlag(input: FlagSubmissionInput): Promise<FlagSubmissionResult> {
    const exerciseId = input.challenge.platform?.challengeID
    if (!exerciseId) throw new Error(`题目 ${input.challenge.slug} 缺少平台题目 ID`)
    const flag = innerFlagValue(input.candidate)
    if (!flag) throw new Error("候选 flag 为空")
    const submittedAt = new Date().toISOString()
    try {
      const data = object(await this.call("POST", "/answer-panel/answer", {
        body: { exerciseId: Number(exerciseId), flag },
        signal: input.signal,
      }))
      const correct = data?.isCorrect
      if (correct === true)
        return { adapter: this.id, verdict: "accepted", detail: "平台判定 flag 正确", submittedAt }
      if (correct === false)
        return { adapter: this.id, verdict: "rejected", detail: "平台判定 flag 错误", submittedAt }
      // An unrecognized shape must never be assumed to be success.
      return {
        adapter: this.id,
        verdict: "pending",
        detail: `平台未返回明确判定：${JSON.stringify(data ?? null).slice(0, 500)}`,
        submittedAt,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A rejected flag is reported through the envelope's error code, so distinguish a real verdict
      // from a transport failure: only the latter is worth retrying.
      if (/flag|答案|错误|incorrect/i.test(message) && !/超时|timeout|ECONN|fetch/i.test(message))
        return { adapter: this.id, verdict: "rejected", detail: message, submittedAt }
      throw error
    }
  }

  /** Current score and rank, used by the match dashboard. Read-only and never blocking. */
  async overview(signal?: AbortSignal) {
    const data = object(await this.call("GET", "/answer-panel/overview", { signal }))
    return {
      point: numeric(data?.stagePoint) ?? 0,
      rank: numeric(data?.stageRank),
    }
  }
}
