import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  loadChallenge,
  recognizedChallengeCategory,
  resolveChallengeCatalog,
  type Challenge,
  type ChallengeCategory,
} from "./challenge.ts"
import type { Workspace } from "./workspace.ts"
import { XIHULUNJIAN_DEFAULT_SERVER_HOST } from "./xihulunjian-config.ts"

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

/** A fixed identity makes mixed-platform challenge roots impossible in this competition build. */
export const XIHULUNJIAN_ADAPTER_ID = "xihulunjian"

export type XihulunjianSubmissionResult = {
  adapter: typeof XIHULUNJIAN_ADAPTER_ID
  verdict: "accepted" | "rejected" | "pending"
  detail: string
  submittedAt: string
}

export type XihulunjianSubmissionInput = {
  challenge: Challenge
  workspace: Workspace
  candidate: string
  signal?: AbortSignal
}

export type XihulunjianNotice = {
  id: number
  title: string
  content?: string
  createdAt?: string
  createdTime?: number
  userName?: string
}

export type XihulunjianNoticeDetail = XihulunjianNotice & {
  isFile: boolean
  files: Array<{ name: string; url: string; ext?: string }>
  url?: string
}

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
/** Hard ceiling for one platform API request so a hung connection cannot stall the chain forever. */
const REQUEST_TIMEOUT_MS = 12_000
/** Attachments come from CDN storage; allow slower transfers than API calls. */
const DOWNLOAD_TIMEOUT_MS = 60_000

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

function noticeID(value: unknown) {
  const found = numeric(value)
  return found !== undefined && Number.isSafeInteger(found) && found > 0 ? found : undefined
}

function noticeFiles(value: unknown) {
  const file = object(value)
  const values = Array.isArray(file?.files) ? file.files : []
  return values.flatMap((item) => {
    const found = object(item)
    const name = text(found?.name)
    const url = text(found?.url)
    if (!name || !url) return []
    return [{ name, url, ...(text(found?.ext) ? { ext: text(found?.ext) } : {}) }]
  })
}

function notice(value: unknown): XihulunjianNotice | undefined {
  const data = object(value)
  const id = noticeID(data?.id)
  if (!id) return undefined
  return {
    id,
    title: text(data?.title) ?? "未命名公告",
    ...(text(data?.content) ? { content: text(data?.content) } : {}),
    ...(text(data?.createdAt) ? { createdAt: text(data?.createdAt) } : {}),
    ...(numeric(data?.createdTime) !== undefined ? { createdTime: numeric(data?.createdTime) } : {}),
    ...(text(data?.userName) ? { userName: text(data?.userName) } : {}),
  }
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

/**
 * The environment and answer endpoints want a numeric exercise ID on the wire. `Number("")` is 0
 * and a malformed ID is NaN, so validate before sending: an accidental null/NaN must fail loudly
 * with the offending challenge ID rather than silently address the wrong (or no) challenge.
 */
function numericExerciseId(exerciseId: string) {
  const parsed = Number(exerciseId)
  if (!exerciseId.trim() || !Number.isInteger(parsed))
    throw new Error(`西湖论剑题目 ID 非法，拒绝发送非整数 exerciseId: ${JSON.stringify(exerciseId)}`)
  return parsed
}

/** Transport failures may clear on the next paced attempt; API/business validation errors will not. */
function retryablePlatformError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return false
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:408|425|429|5\d\d)\b|\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b|\b(?:fetch failed|network|socket|timeout|timed out|temporar(?:y|ily))\b|限流|请求过于频繁/i.test(message)
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
        `- Direct address: ${exposeIps.join(", ")}` +
          (ports.length ? ` (open ports: ${ports.join(", ")})` : ""),
      )
    if (proxyIps.length) lines.push(`- Proxy IP: ${proxyIps.join(", ")}${proxied ? " (platform recommends the proxy)" : ""}`)
    for (const mapping of mappings)
      lines.push(`- Port mapping: ${mapping.type} container ${mapping.port} -> proxy ${mapping.proxy}`)
    if (Array.isArray(found.users)) {
      for (const item of found.users) {
        const user = object(item)
        const username = text(user?.username)
        if (!username) continue
        const password = text(user?.password)
        lines.push(`- Account: ${username}${password ? ` / password: ${password}` : ""}`)
      }
    }
    if (expires !== undefined)
      lines.push(`- Environment expires: ${new Date(expires).toISOString()}`)
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

/**
 * Raised only when the platform's structured response confirms the candidate answer itself is
 * wrong ({@link isIncorrectFlagResponse} on the answer endpoint). The verdict is definitive and
 * downstream duplicate gates treat "rejected" as final, so every uncertain failure — timeouts,
 * exhausted 5xx retries, malformed envelopes — must stay a plain error and propagate instead of
 * being squeezed into this class by message-text guessing (H3).
 */
export class FlagRejectedError extends Error {
  constructor(public readonly detail: string) {
    super(detail)
    this.name = "FlagRejectedError"
  }
}

/**
 * The answer endpoint overloads business code 40001: on a normal incorrect answer it returns
 * `提交flag错误，请重新提交` with HTTP 200, rather than the usual rate-limit message. Retrying that
 * response would resubmit the same wrong flag and consume the platform quota each time.
 */
function isIncorrectFlagResponse(endpoint: string, message: string) {
  return endpoint === "/answer-panel/answer"
    && /(?:flag|答案).*(?:错误|不正确|incorrect)|(?:错误|不正确|incorrect).*(?:flag|答案)/i.test(message)
}

/**
 * The platform's exercise list is grouped by batch labels ("测试题", "REAL", "批次一") rather than
 * by real CTF categories, and the detail payload has no category field at all.  The challenge NAME
 * is the primary signal ("PWN-01", "WEB-02", "easy_rsa", "逆向题"...); anonymized batches
 * ("REAL-01"...) carry their real nature only in the ATTACHMENT filename
 * ("joomla-6.1.2-full-package.tar.gz.zip", "01_nginx_1.31.4-source.zip"), which is scanned as a
 * secondary signal.  A recognized platform category still wins when present.
 */
const NAME_CATEGORY_RULES: Array<{ category: ChallengeCategory; keywords: string[] }> = [
  { category: "BLOCKCHAIN", keywords: ["blockchain", "web3", "solidity", "区块链", "合约", "智能合约"] },
  { category: "FORENSICS", keywords: ["forensic", "dfir", "pcap", "wireshark", "取证", "内存取证", "流量"] },
  { category: "MOBILE", keywords: ["mobile", "android", "apk", "ios", "ipa", "安卓", "手机"] },
  { category: "PWN", keywords: ["pwn", "pwnable", "rop", "shellcode", "heap", "stack", "溢出", "栈溢出", "堆利用", "二进制"] },
  { category: "REVERSE", keywords: ["reverse", "reversing", "crackme", "keygen", "unpack", "vmprotect", "re", "逆向", "反编译", "脱壳"] },
  { category: "CRYPTO", keywords: ["crypto", "cryptography", "rsa", "aes", "des", "ecc", "密码学", "加密", "解密", "椭圆曲线"] },
  { category: "WEB", keywords: ["web", "website", "webapp", "xss", "csrf", "ssrf", "sqli", "注入", "网站", "网页", "反序列化"] },
  { category: "AI", keywords: ["ai", "ml", "llm", "prompt", "adversarial", "机器学习", "深度学习", "模型", "神经网络", "大模型", "对抗"] },
  { category: "HARDWARE", keywords: ["hardware", "iot", "firmware", "硬件", "单片机", "嵌入式", "固件", "电路"] },
  { category: "OSINT", keywords: ["osint", "社工", "情报"] },
  { category: "MISC", keywords: ["misc", "steg", "steganography", "signin", "welcome", "隐写", "杂项", "签到"] },
  // Real-world software audit batches: the attachment IS the challenge.  Scripted CMS/framework
  // stacks are web vulnerability hunts; native servers and data stores are memory-safety hunts on
  // C/C++ source, which is PWN work (the REVERSE/PWN prompt tier, not the web tier).
  {
    category: "WEB",
    keywords: ["joomla", "wordpress", "drupal", "ghost", "cmsms", "php", "thinkphp", "laravel", "discuz", "spring", "struts", "tomcat", "shiro", "django", "flask", "rails"],
  },
  {
    category: "PWN",
    keywords: ["nginx", "httpd", "openlitespeed", "litespeed", "caddy", "openresty", "redis", "memcached", "mysql", "mariadb", "postgres", "postgresql", "clickhouse", "sqlite", "openssl", "ffmpeg", "imagemagick", "libpng", "zlib"],
  },
]

/**
 * Precompiled keyword matchers.  ASCII keywords must sit on token boundaries: match "PWN-01"/
 * "easy_pwn" but not "pwnme", and "ios" but not the tail of "various".  CJK keywords use plain
 * substring inclusion because CJK text has no token separators.
 */
const CATEGORY_MATCHERS: Array<{ category: ChallengeCategory; tests: Array<{ re: RegExp; substring: boolean; keyword: string }> }> =
  NAME_CATEGORY_RULES.map((rule) => ({
    category: rule.category,
    tests: rule.keywords.map((keyword) => {
      const ascii = /^[\x20-\x7e]+$/.test(keyword)
      return {
        keyword,
        substring: !ascii,
        re: ascii ? new RegExp(`(?:^|[\\W_])${keyword}(?=$|[\\W_])`) : new RegExp(keyword),
      }
    }),
  }))

function keywordMatches(test: { re: RegExp; substring: boolean; keyword: string }, normalized: string) {
  return test.substring ? normalized.includes(test.keyword) : test.re.test(normalized)
}

function categoryFromKeywords(source: string): ChallengeCategory {
  if (!source.trim()) return "OTHER"
  const normalized = source.normalize("NFKC").toLowerCase()
  for (const rule of CATEGORY_MATCHERS)
    for (const test of rule.tests) if (keywordMatches(test, normalized)) return rule.category
  return "OTHER"
}

/**
 * Derive a challenge's folder category.  Signal precedence: a recognized platform category, then
 * the challenge name, then attachment filenames (the only signal for anonymized batches).
 */
export function inferChallengeCategory(
  name: string,
  platformCategory?: unknown,
  attachments?: string[],
): ChallengeCategory {
  const known = recognizedChallengeCategory(platformCategory)
  if (known && known !== "OTHER") return known
  const byName = categoryFromKeywords(name)
  if (byName !== "OTHER") return byName
  for (const attachment of attachments ?? []) {
    const byAttachment = categoryFromKeywords(attachment)
    if (byAttachment !== "OTHER") return byAttachment
  }
  return "OTHER"
}

export class XihulunjianPlatformAdapter {
  readonly id = XIHULUNJIAN_ADAPTER_ID
  readonly name = "西湖论剑"
  /** Tail of the serialized request chain; every call waits for the previous one. */
  private pending: Promise<void> = Promise.resolve()
  private lastRequestAt = 0

  constructor(
    private readonly accessKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> =
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly serverHost = XIHULUNJIAN_DEFAULT_SERVER_HOST,
  ) {
    if (!accessKey.trim()) throw new Error("西湖论剑未配置 AccessKey")
  }

  private credential() {
    return this.accessKey
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
        // A definitive verdict is final even if its message text happens to look transient
        // (e.g. "当前还有500次提交机会"); only genuine transport/rate-limit errors retry.
        if (error instanceof FlagRejectedError) throw error
        if (!(error instanceof XihulunjianRateLimitError) && !retryablePlatformError(error)) throw error
      }
    }
    throw lastError
  }

  private async attempt(
    method: "GET" | "POST",
    endpoint: string,
    options: { query?: Record<string, string>; body?: JsonObject; signal?: AbortSignal } = {},
  ) {
    const base = new URL(this.serverHost)
    const url = new URL(`${base.pathname.replace(/\/$/, "")}${API_PREFIX}${endpoint}`, base.origin)
    if (url.origin !== base.origin)
      throw new Error(`西湖论剑请求越出配置的源: ${url.origin}`)
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)

    const headers = new Headers({ Accept: "application/json" })
    headers.set("X-Agent-AccessKey", this.credential())

    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    if (body !== undefined) headers.set("Content-Type", "application/json")

    // Compose the caller's signal with a hard timeout: either one aborting cancels the request,
    // and no response (or stalled body) can outlive REQUEST_TIMEOUT_MS.
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    const response = await this.fetcher(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal,
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
    // Most endpoints use 40001 for rate limits. The answer endpoint also uses it for an
    // incorrect flag (with HTTP 200), which is a definitive verdict and must never be retried.
    if (response.status === 429 || (code === RATE_LIMIT_CODE && !isIncorrectFlagResponse(endpoint, message)))
      throw new XihulunjianRateLimitError(
        `西湖论剑接口 ${method} ${endpoint} 触发限流 (${response.status}/${code ?? "-"}): ${message}`,
      )
    if (!response.ok)
      throw new Error(`西湖论剑接口 ${method} ${endpoint} 失败 (${response.status}): ${safeErrorBody(raw)}`)
    if (!envelope) throw new Error(`西湖论剑接口 ${method} ${endpoint} 返回结构异常`)
    if (code !== SUCCESS_CODE) {
      // Structurally confirmed wrong answer: the only failure shape that becomes a definitive
      // "rejected" verdict. HTTP-layer failures above keep plain errors so a 5xx body that merely
      // contains words like「系统错误」can never masquerade as a verdict after retries exhaust.
      if (isIncorrectFlagResponse(endpoint, message)) throw new FlagRejectedError(message)
      throw new Error(
        `西湖论剑接口 ${method} ${endpoint} 返回业务失败 (code=${code ?? "缺失"}): ${message}`,
      )
    }
    return envelope.data
  }

  /**
   * Flatten `分类[].corpus[]` into Boom's flat preview list.
   *
   * One malformed group or challenge entry (a bad ID, an unexpected shape) must not abort the
   * whole catalog sync, so each group — and each entry inside it — is processed independently:
   * bad items are skipped and reported through `warnings` as `{groupID?, error}` (M23-a).
   */
  private async exerciseList(signal?: AbortSignal) {
    const data = await this.call("GET", "/ctf/exercise-list", { signal })
    if (!Array.isArray(data)) throw new Error("西湖论剑题目列表结构异常")
    const previews: Array<{
      id: string
      challengeID: string
      title: string
      category?: string
      solved?: boolean
      group?: { id: string; name: string }
    }> = []
    const warnings: Array<{ groupID?: string; error: unknown }> = []
    for (const raw of data) {
      const group = object(raw)
      if (!group) continue
      try {
        const groupID = identifier(group.id, "分类 ID")
        const groupName = text(group.name) ?? groupID
        const corpus = Array.isArray(group.corpus) ? group.corpus : []
        for (const entry of corpus) {
          const item = object(entry)
          if (!item) continue
          // A challenge that is not yet open cannot be fetched or solved; batched releases mean the
          // list must be re-read later rather than treated as complete.
          if (item.isOpen === false) continue
          try {
            const challengeID = identifier(item.id, "题目 ID")
            previews.push({
              id: challengeID,
              challengeID,
              title: text(item.name) ?? challengeID,
              category: groupName,
              ...(typeof item.hasSolved === "boolean" ? { solved: item.hasSolved } : {}),
              group: { id: groupID, name: groupName },
            })
          } catch (error) {
            // A sibling challenge with a valid ID must still survive one broken entry.
            warnings.push({ ...(text(group.id) ? { groupID: text(group.id)! } : {}), error })
          }
        }
      } catch (error) {
        warnings.push({ ...(text(group.id) ? { groupID: text(group.id)! } : {}), error })
      }
    }
    return { previews, warnings }
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
    await this.call("POST", "/ctf/build-exercise-env", { body: { exerciseId: numericExerciseId(exerciseId) }, signal })
  }

  /**
   * Release a challenge environment. Safe to call defensively: a failure here is reported by the
   * caller but must never mask the solving outcome, and must never block slot release.
   */
  async recoverEnvironment(exerciseId: string, signal?: AbortSignal) {
    await this.call("POST", "/ctf/recover-exercise-env", { body: { exerciseId: numericExerciseId(exerciseId) }, signal })
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

  /** One local copy of a challenge, as discovered by {@link scanExisting}. */
  private async scanExisting(base: string) {
    const index = new Map<string, Array<{ directory: string; category: ChallengeCategory; meta: JsonObject }>>()
    const top = await readdir(base, { withFileTypes: true }).catch(() => [])
    for (const entry of top) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const category = recognizedChallengeCategory(entry.name)
      if (category) {
        // Current layout: challenges/<CATEGORY>/<slug>/.
        const nested = await readdir(path.join(base, entry.name), { withFileTypes: true }).catch(() => [])
        for (const child of nested) {
          if (!child.isDirectory() || child.name.startsWith(".")) continue
          await this.indexOwned(index, path.join(base, entry.name, child.name), category)
        }
      } else {
        // Legacy layout: a challenge directory sitting directly under challenges/.
        await this.indexOwned(index, path.join(base, entry.name), "OTHER")
      }
    }
    return index
  }

  private async indexOwned(
    index: Map<string, Array<{ directory: string; category: ChallengeCategory; meta: JsonObject }>>,
    directory: string,
    category: ChallengeCategory,
  ) {
    const meta = await readFile(path.join(directory, "meta.json"), "utf8")
      .then((raw) => JSON.parse(raw) as JsonObject)
      .catch(() => undefined)
    const owner = object(object(meta)?.platform)
    if (owner?.adapter !== this.id) return
    const challengeID = String(owner.challenge_id ?? "")
    if (!challengeID) return
    const copies = index.get(challengeID) ?? []
    copies.push({ directory, category, meta: meta ?? {} })
    index.set(challengeID, copies)
  }

  private async rewriteMeta(directory: string, mutate: (meta: JsonObject) => void) {
    const target = path.join(directory, "meta.json")
    const meta = object(await readFile(target, "utf8").then((raw) => JSON.parse(raw) as JsonObject).catch(() => undefined))
    if (!meta) return
    mutate(meta)
    await this.atomicWrite(target, `${JSON.stringify(meta, undefined, 2)}\n`)
  }

  /** Drop a category directory that has just become empty, so the GUI shows no ghost category. */
  private async pruneCategoryIfEmpty(base: string, directory: string) {
    const parent = path.dirname(directory)
    if (path.resolve(parent) === path.resolve(base)) return
    await rmdir(parent).catch(() => {})
  }

  private async localAttachmentNames(directory: string) {
    const entries = await readdir(path.join(directory, "files"), { withFileTypes: true }).catch(() => [])
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  }

  /**
   * The completeness check a local copy must pass before it may be trusted (and kept): the meta
   * must record an attachment manifest (one without it predates the incremental sync) and every
   * recorded file must still be on disk. This is exactly the verification {@link reconcileExisting}
   * applies to every candidate copy before choosing and deleting.
   */
  private async copyCompleteness(copy: { directory: string; meta: JsonObject }) {
    const options = object(object(copy.meta.platform)?.options)
    const recorded = Array.isArray(options?.attachments)
      ? options!.attachments.filter((name): name is string => typeof name === "string")
      : undefined
    if (recorded === undefined) return false
    const present = new Set(await this.localAttachmentNames(copy.directory))
    return recorded.every((name) => present.has(name))
  }

  /**
   * Reconcile an already-materialized challenge against the current catalog entry using local data
   * only: no platform detail call, no attachment download.  Returns the challenge, or undefined
   * when no local copy is usable and the caller must re-materialize it from the platform.
   *
   * This is what keeps periodic re-syncs cheap: the platform rate-limits detail reads (three
   * back-to-back requests trigger 40001) and attachments are large, so an unchanged challenge must
   * cost nothing but a directory scan.
   */
  private async reconcileExisting(input: {
    base: string
    item: { challengeID: string; title: string; category?: string; solved?: boolean }
    copies: Array<{ directory: string; category: ChallengeCategory; meta: JsonObject }>
  }): Promise<Challenge | undefined> {
    // Evaluate EVERY copy first — category fit AND completeness — before anything is deleted.
    // Debris removal below is irreversible, so picking a favorite first and deleting the rest
    // could destroy the one intact copy when the favorite turns out broken (M23-b).
    const ranked = await Promise.all(input.copies.map(async (copy) => ({
      copy,
      inferred: await inferChallengeCategory(
        path.basename(copy.directory),
        input.item.category,
        await this.localAttachmentNames(copy.directory),
      ),
      complete: await this.copyCompleteness(copy),
    })))
    // Among VERIFIED-COMPLETE copies only: prefer one already sitting in the freshly inferred
    // category, then any recognized category, then the first complete one.
    const complete = ranked.filter((entry) => entry.complete)
    const chosen = complete.find((entry) => entry.copy.category === entry.inferred)
      ?? complete.find((entry) => entry.copy.category !== "OTHER")
      ?? complete[0]
    // Nothing verifiable survives locally. Delete NOTHING — a complete copy may still appear on a
    // later sync, and re-materialization needs a platform round-trip that can itself fail — and
    // let the caller rebuild from scratch.
    if (!chosen) return undefined
    let canonical = chosen.copy
    const canonicalCategory = chosen.inferred
    // The canonical copy has already passed completeness verification, so pruning the remaining
    // debris from earlier category derivations cannot lose data anymore.
    for (const copy of input.copies)
      if (path.resolve(copy.directory) !== path.resolve(canonical.directory)) {
        await rm(copy.directory, { recursive: true, force: true })
        await this.pruneCategoryIfEmpty(input.base, copy.directory)
      }

    // Completeness was verified during selection; `options` is still needed to merge solve state.
    const options = object(object(canonical.meta.platform)?.options)

    if (canonical.category !== canonicalCategory) {
      const destination = path.join(input.base, canonicalCategory, path.basename(canonical.directory))
      const occupied = await lstat(destination).catch(() => undefined)
      // An occupied destination belongs to a different challenge (slug collision), so the copy
      // stays where it is with its meta unchanged rather than claiming a category it is not in.
      if (!occupied) {
        await mkdir(path.dirname(destination), { recursive: true })
        await rename(canonical.directory, destination)
        await this.pruneCategoryIfEmpty(input.base, canonical.directory)
        canonical = { ...canonical, directory: destination, category: canonicalCategory }
        await this.rewriteMeta(destination, (meta) => { meta.category = canonicalCategory })
      }
    }
    if (input.item.solved === true && options?.solved !== true)
      await this.rewriteMeta(canonical.directory, (meta) => {
        const platform = object(meta.platform)
        if (!platform) return
        const target = object(platform.options) ?? {}
        target.solved = true
        platform.options = target
      })
    return await loadChallenge(canonical.directory, new Map())
  }

  /**
   * Download an attachment. Attachments live on a separate CDN origin, so the AccessKey is never
   * forwarded: it is a platform API credential and must not leak to object storage.
   */
  private async download(url: URL, signal?: AbortSignal) {
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error(`附件协议不受支持: ${url.protocol}`)
    const downloadTimeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    const effectiveSignal = signal ? AbortSignal.any([signal, downloadTimeout]) : downloadTimeout
    const response = await this.fetcher(url, {
      headers: { Accept: "*/*" },
      signal: effectiveSignal,
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
   *
   * A challenge that is already materialized and complete is reconciled from local data alone — no
   * detail call, no re-download — because the platform rate-limits detail reads hard enough that
   * re-reading the whole catalog every cycle starves flag submission of its request budget. Pass
   * `revalidate` to force a full re-pull (broken attachment replaced by the organizers, etc.).
   */
  async acquireChallenges(
    input: { root: string; signal?: AbortSignal; revalidate?: boolean },
  ): Promise<Challenge[]> {
    const { previews: selected, warnings: listWarnings } = await this.exerciseList(input.signal)
    // Materialize into whichever catalog layout the workspace uses (challenges/ or root categories).
    const base = (await resolveChallengeCatalog(path.resolve(input.root))).directory
    const existing = input.revalidate ? new Map() : await this.scanExisting(base)

    const materialized: Challenge[] = []
    const skipped: Array<{ challengeID: string; title: string; error: unknown }> = []
    const used = new Set<string>()
    for (const item of selected) {
      try {
        const copies = existing.get(item.challengeID) ?? []
        if (copies.length > 0) {
          const reconciled = await this.reconcileExisting({ base, item, copies })
          if (reconciled) {
            materialized.push(reconciled)
            used.add(reconciled.slug)
            continue
          }
        }

        const detail = await this.exerciseDetail(item.challengeID, input.signal)
        let slug = this.slug(detail.name || item.title || detail.id)
        if (used.has(slug)) slug = this.slug(`${slug}-${detail.id}`)
        used.add(slug)

        const category = inferChallengeCategory(
          detail.name || item.title || "",
          detail.category ?? item.category,
          detail.attachments.map((attachment) => attachment.name),
        )
        const directory = path.join(base, category, slug)
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
          detail.description || "(no challenge description provided by the platform)",
          ...(detail.endpoint?.detail
            ? ["", "## Environment connection info", "", detail.endpoint.detail]
            : detail.serviceRequired
              ? ["", "## Environment connection info", "", "This challenge needs a target environment that has not been started yet. The solving scheduler will start it once an environment slot is available and write the address here."]
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
                // The written attachment manifest lets later syncs verify completeness without a
                // platform round-trip, and distinguishes "no attachments" from "old meta format".
                attachments: [...names],
                ...(detail.solved || item.solved ? { solved: true } : {}),
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
        // Debris from an earlier category derivation must not keep a duplicate slug on disk; the
        // scan has already verified every indexed copy belongs to this challenge.
        for (const copy of copies)
          if (path.resolve(copy.directory) !== path.resolve(directory)) {
            await rm(copy.directory, { recursive: true, force: true })
            await this.pruneCategoryIfEmpty(base, copy.directory)
          }
      } catch (error) {
        // A malformed or access-restricted individual challenge must not hide all other challenges
        // in the same release batch. A transport failure is different: propagate it so the outer
        // unattended cycle can retry the whole catalog coherently.
        if (input.signal?.aborted || retryablePlatformError(error)) throw error
        skipped.push({ challengeID: item.challengeID, title: item.title, error })
      }
    }
    // Swallowed failures must stay observable: one summary warning names every challenge that was
    // dropped this cycle, without changing control flow for the ones that succeeded.
    const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
    const notes = [
      ...listWarnings.map((warning) =>
        `${warning.groupID ? `分组 ${warning.groupID}` : "未知分组"}: ${describe(warning.error)}`),
      ...skipped.map((entry) => `题目 ${entry.challengeID}(${entry.title}): ${describe(entry.error)}`),
    ]
    if (notes.length > 0)
      console.warn(`西湖论剑：跳过 ${notes.length} 个无法物化的题目\n  - ${notes.join("\n  - ")}`)
    return materialized
  }

  /**
   * Submit a candidate. Only the value inside the flag wrapper goes on the wire.
   *
   * `isCorrect` is authoritative, so this is the fastest and most reliable verification available;
   * the competition applies no penalty for a wrong flag, which is why Boom submits promptly instead
   * of spending model budget on self-verification first.
   */
  async submitFlag(input: XihulunjianSubmissionInput): Promise<XihulunjianSubmissionResult> {
    const exerciseId = input.challenge.platform?.challengeID
    if (!exerciseId) throw new Error(`题目 ${input.challenge.slug} 缺少平台题目 ID`)
    const flag = innerFlagValue(input.candidate)
    if (!flag) throw new Error("候选 flag 为空")
    const submittedAt = new Date().toISOString()
    try {
      const data = object(await this.call("POST", "/answer-panel/answer", {
        body: { exerciseId: numericExerciseId(exerciseId), flag },
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
      // Only a structurally confirmed wrong-answer verdict may be reported as "rejected": the
      // duplicate gate downstream treats that as final and the flag can never be resubmitted.
      // Everything else — timeouts, exhausted 5xx retries, envelope anomalies — propagates so
      // upstream records pending/manual work instead of silently dropping the challenge (H3).
      if (error instanceof FlagRejectedError)
        return { adapter: this.id, verdict: "rejected", detail: error.detail, submittedAt }
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

  /** Announcement summaries, intentionally kept separate from challenge acquisition. */
  async notices(signal?: AbortSignal): Promise<XihulunjianNotice[]> {
    const data = await this.call("GET", "/match/notice/now-list", { signal })
    if (!Array.isArray(data)) throw new Error("西湖论剑公告列表结构异常")
    return data.flatMap((item) => {
      const found = notice(item)
      return found ? [found] : []
    })
  }

  /** Full announcement content and any platform-provided attachments. */
  async noticeDetail(id: number, signal?: AbortSignal): Promise<XihulunjianNoticeDetail> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("西湖论剑公告 ID 非法")
    const data = object(await this.call("GET", "/match/notice/detail", {
      query: { id: String(id) },
      signal,
    }))
    const base = notice(data)
    if (!base) throw new Error("西湖论剑公告详情结构异常")
    return {
      ...base,
      isFile: data?.isFile === true,
      files: noticeFiles(data?.file),
      ...(text(data?.url) ? { url: text(data?.url) } : {}),
    }
  }
}
