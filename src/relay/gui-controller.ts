import os from "node:os"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { loadCompetitionAdapter } from "../competition/adapter.ts"
import { RelayClient } from "./client.ts"
import { loadRelayConfig, saveRelayConfig, type RelayLocalConfig } from "./config.ts"
import { RelayMaster } from "./master.ts"
import type { MasterState, WorkerPollResponse } from "./protocol.ts"
import { isRelayId } from "./protocol.ts"
import { RelayWorker } from "./worker.ts"

export type DistributedRole = "inactive" | "master" | "worker"
export type DistributedStatus = "idle" | "connecting" | "running" | "error"

export type DistributedSessionState = {
  role: DistributedRole
  status: DistributedStatus
  relayURL?: string
  device?: {
    id: string
    name: string
    role: "worker" | "master-worker"
    maxSlots: number
  }
  worker?: {
    activeAssignments: number
    assignmentSlugs: string[]
    lastPollAt?: string
  }
  master?: {
    pendingFlags: number
    readyOnline: number
    activeRemote: number
    pendingWriteups: number
    lastCycleAt?: string
  }
  lastError?: string
}

export type StartDistributedWorker = {
  relayURL: string
  joinToken: string
  deviceID?: string
  deviceName?: string
  maxSlots: number
  model: string
  pollMs?: number
}

export type StartDistributedMaster = StartDistributedWorker & {
  masterToken: string
  maxRemoteSlots: number
}

type StateListener = (state: DistributedSessionState) => void

function cleanRelayURL(value: string) {
  const candidate = value.trim()
  if (!candidate || candidate.length > 2_000 || /[\0\r\n]/.test(candidate))
    throw new Error("Relay 服务地址必须是一行有效 HTTP(S) 地址")
  const url = new URL(candidate)
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Relay 服务地址必须使用 HTTP(S)")
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Relay 服务地址不能包含凭据、查询参数或片段")
  return url.toString().replace(/\/+$/, "")
}

function secret(value: string, label: string) {
  const candidate = value.trim()
  if (candidate.length < 16 || candidate.length > 512 || /[\0\r\n\s]/.test(candidate))
    throw new Error(`${label}必须是 16–512 个不含空白字符的字符`)
  return candidate
}

function deviceID(value?: string) {
  const candidate = value?.trim() || `boom-${crypto.randomUUID()}`
  if (!isRelayId(candidate))
    throw new Error("设备 ID 只能使用字母、数字、点、下划线、连字符和冒号，且长度不超过 192")
  return candidate
}

function deviceName(value?: string) {
  const candidate = value?.trim() || os.hostname().trim() || "Boom worker"
  if (candidate.length === 0 || candidate.length > 128 || /[\0\r\n]/.test(candidate))
    throw new Error("设备名称必须是一行且不超过 128 个字符")
  return candidate
}

function slots(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5)
    throw new Error("设备并发必须是 1–5 的整数")
  return value
}

function model(value: string) {
  const candidate = value.trim()
  if (!candidate.includes("/") || candidate.length > 512 || /[\0\r\n]/.test(candidate))
    throw new Error("解题模型必须是 provider/model")
  return candidate
}

function pollInterval(value: number | undefined) {
  const candidate = value ?? 15_000
  if (!Number.isSafeInteger(candidate) || candidate < 1_000 || candidate > 300_000)
    throw new Error("轮询间隔必须是 1000–300000 毫秒")
  return candidate
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Owns the in-process Relay connector and worker started by `boom gui`.
 *
 * The controller deliberately keeps the enrollment token in memory only.  Once a device has been
 * enrolled, its per-device token is stored by relay/config.ts with 0600 permissions; the shared
 * contest join secret never enters a workspace, bundle, or GUI state response.
 */
export class RelayGuiController {
  readonly #root: string
  readonly #onState?: StateListener
  #state: DistributedSessionState = { role: "inactive", status: "idle" }
  #worker?: RelayWorker
  #workerAbort?: AbortController
  #workerTask?: Promise<void>
  #master?: RelayMaster
  #masterAbort?: AbortController
  #masterTask?: Promise<void>
  #masterClient?: RelayClient
  /** Invalidates callbacks from a worker/connector that is still unwinding after a stop. */
  #generation = 0

  constructor(input: { root: string; onState?: StateListener }) {
    this.#root = path.resolve(input.root)
    this.#onState = input.onState
  }

  snapshot() {
    return structuredClone(this.#state)
  }

  #set(next: DistributedSessionState) {
    this.#state = next
    this.#onState?.(this.snapshot())
  }

  #setError(error: unknown, generation?: number) {
    if (generation !== undefined && generation !== this.#generation) return
    const message = error instanceof Error ? error.message : String(error)
    this.#set({ ...this.#state, status: "error", lastError: message })
  }

  #updateWorker(response: WorkerPollResponse, generation: number) {
    if (generation !== this.#generation) return
    this.#set({
      ...this.#state,
      status: "running",
      device: {
        id: response.device.id,
        name: response.device.name,
        role: response.device.role,
        maxSlots: response.device.maxSlots,
      },
      worker: {
        activeAssignments: response.assignments.length,
        assignmentSlugs: response.assignments.map((assignment) => assignment.challenge.slug),
        lastPollAt: new Date().toISOString(),
      },
      ...(this.#state.lastError === undefined ? {} : { lastError: undefined }),
    })
  }

  #updateMaster(state: MasterState, generation: number) {
    if (generation !== this.#generation) return
    this.#set({
      ...this.#state,
      status: "running",
      master: {
        pendingFlags: state.pendingFlags.length,
        readyOnline: state.readyOnline.length,
        activeRemote: state.activeRemote.length,
        pendingWriteups: state.pendingWriteups.length,
        lastCycleAt: new Date().toISOString(),
      },
      ...(this.#state.lastError === undefined ? {} : { lastError: undefined }),
    })
  }

  async #startWorker(input: {
    relayURL: string
    joinToken: string
    deviceID?: string
    deviceName?: string
    role: "worker" | "master-worker"
    maxSlots: number
    model: string
    pollMs?: number
  }, generation: number) {
    const registered = await RelayClient.register({
      url: input.relayURL,
      joinToken: input.joinToken,
      id: deviceID(input.deviceID),
      name: deviceName(input.deviceName),
      role: input.role,
      maxSlots: input.maxSlots,
    })
    const config: RelayLocalConfig = {
      version: 1,
      relayURL: input.relayURL,
      token: registered.token,
      deviceID: registered.device.id,
      deviceName: registered.device.name,
      role: registered.device.role,
      maxSlots: registered.device.maxSlots,
      root: this.#root,
      model: input.model,
      pollMs: input.pollMs ?? 15_000,
    }
    await saveRelayConfig(config)
    const worker = await RelayWorker.open({
      relay: new RelayClient({ url: config.relayURL, token: config.token }),
      root: this.#root,
      model: config.model,
      maxSlots: config.maxSlots,
      pollMs: config.pollMs,
      onPoll: (response) => this.#updateWorker(response, generation),
      onError: (error) => this.#setError(error, generation),
    })
    this.#worker = worker
    this.#workerAbort = new AbortController()
    // The first poll is part of joining: it verifies the returned device token before a GUI claims
    // that a worker is connected, and immediately starts any already queued assignment.
    await worker.poll()
    this.#workerTask = worker.run(this.#workerAbort.signal).catch((error) => this.#setError(error, generation))
    return registered.device
  }

  async startWorker(input: StartDistributedWorker) {
    await this.stop()
    const generation = ++this.#generation
    const relayURL = cleanRelayURL(input.relayURL)
    const joinToken = secret(input.joinToken, "比赛加入令牌")
    const maxSlots = slots(input.maxSlots)
    const solver = model(input.model)
    const pollMs = pollInterval(input.pollMs)
    await mkdir(path.join(this.#root, "challenges"), { recursive: true, mode: 0o700 })
    this.#set({ role: "worker", status: "connecting", relayURL })
    try {
      await this.#startWorker({
        relayURL,
        joinToken,
        deviceID: input.deviceID,
        deviceName: input.deviceName,
        role: "worker",
        maxSlots,
        model: solver,
        pollMs,
      }, generation)
      return this.snapshot()
    } catch (error) {
      this.#setError(error, generation)
      throw error
    }
  }

  async resumeWorker() {
    await this.stop()
    const generation = ++this.#generation
    const config = await loadRelayConfig()
    if (!config || config.role !== "worker")
      throw new Error("没有可恢复的从机配置；请使用比赛加入令牌先加入一次")
    if (path.resolve(config.root) !== this.#root)
      throw new Error("已保存的从机属于另一个工作目录；请切换到该目录或使用比赛加入令牌重新加入")
    await mkdir(path.join(this.#root, "challenges"), { recursive: true, mode: 0o700 })
    this.#set({ role: "worker", status: "connecting", relayURL: config.relayURL })
    try {
      const worker = await RelayWorker.open({
        relay: new RelayClient({ url: config.relayURL, token: config.token }),
        root: this.#root,
        model: config.model,
        maxSlots: config.maxSlots,
        pollMs: config.pollMs,
        onPoll: (response) => this.#updateWorker(response, generation),
        onError: (error) => this.#setError(error, generation),
      })
      this.#worker = worker
      this.#workerAbort = new AbortController()
      await worker.poll()
      this.#workerTask = worker.run(this.#workerAbort.signal).catch((error) => this.#setError(error, generation))
      return this.snapshot()
    } catch (error) {
      this.#setError(error, generation)
      throw error
    }
  }

  async startMaster(input: StartDistributedMaster) {
    await this.stop()
    const generation = ++this.#generation
    const relayURL = cleanRelayURL(input.relayURL)
    const masterToken = secret(input.masterToken, "主控令牌")
    const joinToken = secret(input.joinToken, "比赛加入令牌")
    const maxSlots = slots(input.maxSlots)
    const solver = model(input.model)
    const pollMs = pollInterval(input.pollMs)
    if (!Number.isSafeInteger(input.maxRemoteSlots) || input.maxRemoteSlots < 1 || input.maxRemoteSlots > 3)
      throw new Error("线上靶机并发必须是 1–3 的整数")
    await mkdir(path.join(this.#root, "challenges"), { recursive: true, mode: 0o700 })
    this.#set({ role: "master", status: "connecting", relayURL })
    try {
      const client = RelayClient.master({ url: relayURL, token: masterToken })
      // Authenticate before starting a local worker, so a typo cannot leave the host half joined.
      await client.masterState()
      const master = await RelayMaster.open({
        relay: client,
        root: this.#root,
        maxRemoteSlots: input.maxRemoteSlots,
        provision: async ({ challenge }) => {
          const adapter = await loadCompetitionAdapter()
          if (!adapter) throw new Error("主机未配置西湖论剑 AccessKey，无法申请线上靶机")
          const detail = await adapter.ensureEnvironment(challenge.id)
          const remoteUrl = detail.endpoint?.remote
          if (!remoteUrl) return undefined
          return {
            remoteUrl,
            // The platform normally returns an expiry.  The fallback deliberately expires early so
            // a stale endpoint cannot remain advertised forever after a platform response change.
            remoteExpiresAt: detail.endpoint?.expireTime ?? Date.now() + 10 * 60_000,
          }
        },
        release: async ({ challenge }) => {
          const adapter = await loadCompetitionAdapter()
          if (adapter) await adapter.recoverEnvironment(challenge.id)
        },
      })
      this.#master = master
      this.#masterClient = client
      await this.#startWorker({
        relayURL,
        joinToken,
        deviceID: input.deviceID,
        deviceName: input.deviceName,
        role: "master-worker",
        maxSlots,
        model: solver,
        pollMs,
      }, generation)
      this.#masterAbort = new AbortController()
      this.#masterTask = this.#runMaster(master, this.#masterAbort.signal, generation)
      return this.snapshot()
    } catch (error) {
      await this.stop()
      this.#set({ role: "master", status: "error", relayURL, lastError: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async #runMaster(master: RelayMaster, signal: AbortSignal, generation: number) {
    while (!signal.aborted) {
      try {
        const state = await master.cycle()
        if (!signal.aborted) this.#updateMaster(state, generation)
      } catch (error) {
        this.#setError(error, generation)
      }
      await sleep(5_000, signal)
    }
  }

  async syncMaster() {
    if (!this.#master || this.#state.role !== "master")
      throw new Error("当前不是主机比赛会话")
    const published = await this.#master.syncPlatform()
    // A direct state read is quick and makes the UI reflect the new queue before the next cycle.
    if (this.#masterClient) this.#updateMaster(await this.#masterClient.masterState(), this.#generation)
    return { published, state: this.snapshot() }
  }

  async stop() {
    this.#generation += 1
    const worker = this.#worker
    const master = this.#master
    this.#worker = undefined
    this.#master = undefined
    this.#masterClient = undefined
    this.#workerAbort?.abort()
    this.#masterAbort?.abort()
    this.#workerAbort = undefined
    this.#masterAbort = undefined
    if (master) master.stop()
    // Worker shutdown persists the outbox before its runner closes.  Do not await the background
    // loops: an in-flight platform environment poll must never keep a desktop window from closing.
    await worker?.stop().catch(() => {})
    await master?.close().catch(() => {})
    void this.#workerTask
    void this.#masterTask
    this.#workerTask = undefined
    this.#masterTask = undefined
    this.#set({ role: "inactive", status: "idle" })
  }
}
