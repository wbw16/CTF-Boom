import { lstat, mkdir } from "node:fs/promises"
import path from "node:path"
import type { Challenge } from "../challenge.ts"
import { loadCompetitionAdapter } from "../competition/adapter.ts"
import { XIHULUNJIAN_ADAPTER_ID, type XihulunjianSubmissionResult } from "../xihulunjian-platform-adapter.ts"
import type { Workspace } from "../workspace.ts"
import { packChallengeBundle, unpackChallengeBundle } from "./bundle.ts"
import { RelayClient } from "./client.ts"
import type { ChallengeSnapshot, MasterState } from "./protocol.ts"

export type MasterFlagSubmitter = (input: {
  challenge: Challenge
  workspace: Workspace
  candidate: string
}) => Promise<XihulunjianSubmissionResult>

export type RelayProvisioner = (input: {
  challenge: ChallengeSnapshot
  challengeDirectory: string
}) => Promise<{ remoteUrl: string; remoteExpiresAt: number } | undefined>

export type RelayMasterOptions = {
  relay: RelayClient
  root: string
  maxRemoteSlots?: number
  submitFlag?: MasterFlagSubmitter
  provision?: RelayProvisioner
  now?: () => number
}

export type RunningRelayMaster = {
  sync(challenges: Challenge[]): Promise<number>
  cycle(): Promise<MasterState>
  run(signal?: AbortSignal): Promise<void>
  stop(): void
}

function challengeFromSnapshot(snapshot: ChallengeSnapshot, directory: string): Challenge {
  return {
    slug: snapshot.slug,
    directory,
    sourceDirectory: directory,
    description: "",
    files: [],
    flagFormat: "",
    ...(snapshot.remoteUrl ? { remote: snapshot.remoteUrl } : {}),
    ...(snapshot.kind === "remote" ? { serviceRequired: true } : {}),
  }
}

export class RelayMaster implements RunningRelayMaster {
  readonly #relay: RelayClient
  readonly #root: string
  readonly #maxRemoteSlots: number
  readonly #submitFlag?: MasterFlagSubmitter
  readonly #provision?: RelayProvisioner
  readonly #now: () => number
  readonly #remoteLeases = new Map<string, number>()
  #stopped = false

  constructor(options: RelayMasterOptions) {
    this.#relay = options.relay
    this.#root = path.resolve(options.root)
    this.#maxRemoteSlots = options.maxRemoteSlots ?? 3
    this.#submitFlag = options.submitFlag
    this.#provision = options.provision
    this.#now = options.now ?? (() => Date.now())
  }

  static async open(options: RelayMasterOptions) {
    await mkdir(path.join(path.resolve(options.root), "relay", "master"), { recursive: true, mode: 0o700 })
    return new RelayMaster(options)
  }

  stop() {
    this.#stopped = true
  }

  async #challengeFor(snapshot: ChallengeSnapshot) {
    const directory = path.join(this.#root, "relay", "master", "challenges", snapshot.slug)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const archive = path.join(this.#root, "relay", "master", "bundles", `${snapshot.bundleSha256}.tar.gz`)
    if (!(await lstat(archive).catch(() => undefined))) await this.#relay.getBundle(snapshot.bundleSha256, archive)
    const unpacked = await unpackChallengeBundle({ bundle: archive, directory })
    if (unpacked.manifest.challengeID !== snapshot.id)
      throw new Error(`Relay challenge bundle ID does not match ${snapshot.id}`)
    return { challenge: { ...unpacked.challenge, remote: snapshot.remoteUrl }, directory }
  }

  async sync(challenges: Challenge[]) {
    let published = 0
    for (const challenge of challenges) {
      const challengeID = challenge.platform?.challengeID ?? challenge.slug
      const archive = path.join(this.#root, "relay", "master", "bundles", `${challengeID}-offline.tar.gz`)
      const packed = await packChallengeBundle({ challengeID, challenge, target: archive })
      await this.#relay.putBundle(packed.sha256, packed.path)
      await this.#relay.publishChallenge(challengeID, {
        id: challengeID,
        slug: challenge.slug,
        category: challenge.category,
        kind: challenge.serviceRequired || challenge.remote ? "remote" : "offline",
        phase: "offline",
        revision: 1,
        bundleSha256: packed.sha256,
      })
      published += 1
    }
    return published
  }

  async syncPlatform() {
    const adapter = await loadCompetitionAdapter()
    if (!adapter) throw new Error("主机未配置西湖论剑 AccessKey")
    return this.sync(await adapter.acquireChallenges({ root: this.#root }))
  }

  async #processPendingFlags(state: MasterState) {
    for (const flag of state.pendingFlags) {
      const challengeSnapshot = [
        ...state.pendingFlagChallenges,
        ...state.readyOnline,
        ...state.activeRemote,
        ...state.pendingWriteups,
      ].find((challenge) => challenge.id === flag.challengeId)
      if (!challengeSnapshot) continue
      let result: Pick<XihulunjianSubmissionResult, "verdict" | "detail" | "submittedAt"> & { adapter: string }
      if (this.#submitFlag) {
        const materialized = await this.#challengeFor(challengeSnapshot)
        result = await this.#submitFlag({
          challenge: materialized.challenge,
          workspace: { directory: materialized.directory, runID: flag.assignmentId, extracted: [] },
          candidate: flag.value,
        })
      } else {
        const adapter = await loadCompetitionAdapter()
        if (!adapter) {
          result = {
            adapter: "relay",
            verdict: "pending",
            detail: "主机未配置比赛 adapter，保留 pending",
            submittedAt: new Date(this.#now()).toISOString(),
          }
        } else {
          const materialized = await this.#challengeFor(challengeSnapshot)
          result = await adapter.submitFlag({
            challenge: materialized.challenge,
            workspace: { directory: materialized.directory, runID: flag.assignmentId, extracted: [] },
            candidate: flag.value,
          })
        }
      }
      await this.#relay.updateFlag(flag.id, { status: result.verdict, detail: result.detail })
    }
  }

  async #provisionReady(state: MasterState) {
    if (!this.#provision) return
    for (const snapshot of state.readyOnline) {
      if (this.#remoteLeases.size >= this.#maxRemoteSlots) break
      if (this.#remoteLeases.has(snapshot.id)) continue
      const materialized = await this.#challengeFor(snapshot)
      const environment = await this.#provision({ challenge: snapshot, challengeDirectory: materialized.directory })
      if (!environment) continue
      this.#remoteLeases.set(snapshot.id, environment.remoteExpiresAt)
      await this.#relay.publishChallenge(snapshot.id, {
        id: snapshot.id,
        slug: snapshot.slug,
        category: snapshot.category,
        kind: "remote",
        phase: "online",
        revision: snapshot.revision + 1,
        bundleSha256: snapshot.bundleSha256,
        remoteUrl: environment.remoteUrl,
        remoteExpiresAt: environment.remoteExpiresAt,
      })
    }
  }

  async cycle() {
    const state = await this.#relay.masterState()
    await this.#processPendingFlags(state)
    await this.#provisionReady(state)
    return state
  }

  async run(signal?: AbortSignal) {
    this.#stopped = false
    while (!this.#stopped && !signal?.aborted) {
      await this.cycle().catch(() => {})
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000)
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  }
}
