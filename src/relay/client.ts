import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { lstat, mkdir, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  type Assignment,
  type ChallengeSnapshot,
  type Device,
  type Flag,
  type MasterState,
  type PublishChallengeRequest,
  type SubmitFlagRequest,
  type UpdateFlagRequest,
  type WorkerPollResponse,
} from "./protocol.ts"

export class RelayClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "RelayClientError"
  }
}

type Fetcher = typeof fetch

function apiURL(baseURL: string, pathname: string) {
  const base = new URL(baseURL)
  if (base.protocol !== "https:" && base.protocol !== "http:")
    throw new Error("Boom Relay URL must use HTTP(S)")
  if (base.username || base.password || base.search || base.hash)
    throw new Error("Boom Relay URL cannot include credentials, a query, or a fragment")
  const prefix = base.pathname.replace(/\/+$/, "")
  base.pathname = `${prefix}${pathname}`.replace(/\/+/g, "/")
  return base
}

function errorMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const root = value as Record<string, unknown>
  const error = root.error
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined
  const message = (error as Record<string, unknown>).message
  return typeof message === "string" ? message : undefined
}

async function responseJSON<T>(response: Response) {
  const raw = await response.text()
  let body: unknown
  try {
    body = raw ? JSON.parse(raw) : undefined
  } catch {
    if (!response.ok) throw new RelayClientError(response.status, `Boom Relay returned HTTP ${response.status}`)
    throw new RelayClientError(502, "Boom Relay returned invalid JSON")
  }
  if (!response.ok)
    throw new RelayClientError(response.status, errorMessage(body) ?? `Boom Relay returned HTTP ${response.status}`)
  return body as T
}

export class RelayClient {
  readonly #baseURL: string
  readonly #token: string
  readonly #fetch: Fetcher

  constructor(input: { url: string; token: string; fetcher?: Fetcher }) {
    const url = apiURL(input.url, "/").toString()
    if (!input.token.trim()) throw new Error("Boom Relay token is required")
    this.#baseURL = url
    this.#token = input.token
    this.#fetch = input.fetcher ?? fetch
  }

  static async register(input: {
    url: string
    joinToken: string
    id: string
    name: string
    role: "worker" | "master-worker"
    maxSlots?: number
    fetcher?: Fetcher
  }) {
    const response = await (input.fetcher ?? fetch)(apiURL(input.url, "/v1/devices/register"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.joinToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: input.id,
        name: input.name,
        role: input.role,
        ...(input.maxSlots === undefined ? {} : { maxSlots: input.maxSlots }),
      }),
    })
    return responseJSON<{ device: Device; token: string; created: boolean }>(response)
  }

  static master(input: { url: string; token: string; fetcher?: Fetcher }) {
    return new RelayClient(input)
  }

  async #json<T>(pathname: string, init: RequestInit = {}) {
    const response = await this.#fetch(apiURL(this.#baseURL, pathname), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
    })
    return responseJSON<T>(response)
  }

  async putBundle(sha256: string, file: string) {
    const source = path.resolve(file)
    const info = await lstat(source)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Bundle is not a real file: ${source}`)
    const response = await this.#fetch(apiURL(this.#baseURL, `/v1/bundles/${sha256}`), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(info.size),
      },
      body: Bun.file(source),
    })
    return responseJSON<{ created: boolean; bytes: number }>(response)
  }

  async getBundle(sha256: string, target: string) {
    const response = await this.#fetch(apiURL(this.#baseURL, `/v1/bundles/${sha256}`), {
      headers: { Authorization: `Bearer ${this.#token}` },
    })
    if (!response.ok) await responseJSON(response)
    const destination = path.resolve(target)
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`
    const body = response.body
    if (!body) throw new RelayClientError(502, "Boom Relay bundle response had no body")
    const hash = createHash("sha256")
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
    try {
      await pipeline(
        Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream),
        counter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      )
      if (hash.digest("hex") !== sha256)
        throw new RelayClientError(502, "Downloaded bundle SHA-256 did not match Relay metadata")
      await rename(temporary, destination)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
    return { bytes: (await lstat(destination)).size }
  }

  publishChallenge(id: string, input: PublishChallengeRequest) {
    return this.#json<{ challenge: ChallengeSnapshot }>(`/v1/challenges/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    })
  }

  poll(input: { freeSlots: number; activeAssignmentIds: string[] }) {
    return this.#json<WorkerPollResponse>("/v1/worker/poll", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  submitResult(input: { assignmentId: string; bundleSha256?: string }) {
    return this.#json<{ challenge: ChallengeSnapshot; idempotent: boolean }>("/v1/results", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  submitFlag(input: SubmitFlagRequest) {
    return this.#json<{ flag: Flag; idempotent: boolean }>("/v1/flags", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  submitWriteup(input: { assignmentId: string; bundleSha256: string }) {
    return this.#json<{ idempotent: boolean }>("/v1/writeups", {
      method: "POST",
      body: JSON.stringify(input),
    })
  }

  masterState() {
    return this.#json<MasterState>("/v1/master/state")
  }

  updateFlag(id: string, input: UpdateFlagRequest) {
    return this.#json<{ flag: Flag }>(`/v1/flags/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  }
}
