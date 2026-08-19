import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { acceptTaskFlag, loadTaskRecord } from "../task.ts"
import { readChallengeRuns } from "../history.ts"
import { GuiRunner, type CandidateSubmitter } from "../runner.ts"
import { DEFAULT_SILENCE_MS, type Limits } from "../session.ts"
import type { Challenge } from "../challenge.ts"
import { packArtifactBundle, unpackArtifactBundle, unpackChallengeBundle } from "./bundle.ts"
import { RelayClient } from "./client.ts"
import type { Assignment, Flag, WorkerPollResponse } from "./protocol.ts"
import { loadRelayConfig, saveRelayConfig, type RelayLocalConfig } from "./config.ts"

type WorkerOutboxItem =
  | { id: string; kind: "flag"; assignmentId: string; value: string }
  | { id: string; kind: "result" | "writeup"; assignmentId: string; file: string; sha256: string }

type WorkerAssignment = {
  assignment: Assignment
  challenge: Challenge
  challengeDirectory: string
  solving: boolean
  runID?: string
  handledRejected: string[]
  resultQueued?: boolean
  writeupQueued?: boolean
}

type WorkerState = {
  version: 1
  assignments: Record<string, Pick<WorkerAssignment, "assignment" | "challengeDirectory" | "solving" | "runID" | "handledRejected" | "resultQueued" | "writeupQueued">>
  outbox: WorkerOutboxItem[]
}

export type RelayWorkerOptions = {
  relay: RelayClient
  root: string
  model: string
  maxSlots: number
  pollMs?: number
  runner?: GuiRunner
  now?: () => number
}

export type RunningRelayWorker = {
  poll(): Promise<WorkerPollResponse>
  run(signal?: AbortSignal): Promise<void>
  stop(): Promise<void>
}

const DEFAULT_LIMITS: Limits = {
  tokens: 120_000,
  repeats: 5,
  timeout: 25 * 60_000,
  silenceMs: DEFAULT_SILENCE_MS,
}

async function stateFile(root: string) {
  const directory = path.join(path.resolve(root), "relay")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return path.join(directory, "worker-state.json")
}

async function loadState(root: string): Promise<WorkerState> {
  const target = await stateFile(root)
  const raw = await readFile(target, "utf8").catch(() => undefined)
  if (!raw) return { version: 1, assignments: {}, outbox: [] }
  try {
    const value = JSON.parse(raw) as WorkerState
    if (value.version !== 1 || !value.assignments || !Array.isArray(value.outbox)) throw new Error("invalid")
    return value
  } catch {
    throw new Error(`Relay worker state is invalid: ${target}`)
  }
}

async function saveState(root: string, state: WorkerState) {
  const target = await stateFile(root)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await Bun.write(target, Bun.file(temporary))
  } finally {
    await Bun.file(temporary).delete().catch(() => {})
  }
}

function assignmentRoot(root: string, assignment: Assignment) {
  return path.join(path.resolve(root), "relay", "challenges", assignment.challenge.slug)
}

function unique<T>(values: T[]) {
  return [...new Set(values)]
}

async function copyWriteup(runDirectory: string, target: string) {
  const source = path.join(runDirectory, "work", "WRITEUP.md")
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("WRITEUP.md is not a real file")
  await mkdir(target, { recursive: true, mode: 0o700 })
  await copyFile(source, path.join(target, "WRITEUP.md"))
}

async function prepareResultDirectory(runDirectory: string) {
  const work = path.join(runDirectory, "work")
  const explicit = path.join(work, "relay-result")
  if ((await lstat(explicit).catch(() => undefined))?.isDirectory()) return explicit
  const temporary = path.join(runDirectory, ".relay-result-outbox")
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  const entries = await readdir(work, { withFileTypes: true }).catch(() => [])
  const candidates = entries.filter((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) return false
    if (/^(?:HOW_TO_RUN|how_to_run)\.md$/i.test(entry.name)) return true
    return /(?:exploit|solve|poc|script|run)/i.test(entry.name) &&
      /\.(?:py|sh|rb|js|ts|c|cc|cpp|go|rs|lua|php|pl|ps1|txt|md)$/i.test(entry.name)
  })
  for (const entry of candidates) await copyFile(path.join(work, entry.name), path.join(temporary, entry.name))
  return candidates.length > 0 ? temporary : undefined
}

export class RelayWorker implements RunningRelayWorker {
  readonly #relay: RelayClient
  readonly #root: string
  readonly #model: string
  readonly #maxSlots: number
  readonly #pollMs: number
  readonly #now: () => number
  readonly #runner: GuiRunner
  readonly #state: WorkerState
  readonly #assignments = new Map<string, WorkerAssignment>()
  readonly #outbox: WorkerOutboxItem[]
  #stopped = false
  #polling?: Promise<WorkerPollResponse>

  constructor(options: RelayWorkerOptions) {
    this.#relay = options.relay
    this.#root = path.resolve(options.root)
    this.#model = options.model
    this.#maxSlots = options.maxSlots
    this.#pollMs = options.pollMs ?? 15_000
    this.#now = options.now ?? (() => Date.now())
    this.#state = { version: 1, assignments: {}, outbox: [] }
    this.#outbox = this.#state.outbox
    const submitter: CandidateSubmitter = async (input) => {
      const assignment = this.#findAssignment(input.challenge.slug)
      if (!assignment) throw new Error(`No Relay assignment for ${input.challenge.slug}`)
      const item: WorkerOutboxItem = {
        id: `submission-${crypto.randomUUID()}`,
        kind: "flag",
        assignmentId: assignment.assignment.id,
        value: input.candidate,
      }
      this.#outbox.push(item)
      await this.#persist()
      await this.#flushOutbox().catch(() => {})
      return {
        adapter: "relay",
        verdict: "pending",
        detail: "候选 flag 已写入 Relay outbox，等待主机提交比赛平台",
        submittedAt: new Date(this.#now()).toISOString(),
      }
    }
    this.#runner = options.runner ?? new GuiRunner(this.#root, undefined, undefined, {
      candidateSubmitter: submitter,
      manageCompetitionEnvironments: false,
    })
    this.#runner.setConcurrency(this.#maxSlots)
  }

  static async open(options: Omit<RelayWorkerOptions, "relay" | "root" | "model" | "maxSlots"> & {
    relay: RelayClient
    root: string
    model: string
    maxSlots: number
  }) {
    await mkdir(path.resolve(options.root), { recursive: true, mode: 0o700 })
    const worker = new RelayWorker(options)
    const saved = await loadState(options.root)
    worker.#state.assignments = saved.assignments
    worker.#state.outbox.push(...saved.outbox)
    for (const persisted of Object.values(saved.assignments)) {
      // Assignment materialization is validated on the next poll. This keeps restart recovery from
      // trusting stale challenge metadata while preserving run IDs and pending rejected flags.
      if (persisted.assignment.status === "active") {
        worker.#assignments.set(persisted.assignment.id, {
          ...persisted,
          challenge: {
            slug: persisted.assignment.challenge.slug,
            directory: persisted.challengeDirectory,
            sourceDirectory: persisted.challengeDirectory,
            description: "",
            files: [],
            flagFormat: "",
            category: persisted.assignment.challenge.category as Challenge["category"],
          },
        })
      }
    }
    return worker
  }

  async stop() {
    this.#stopped = true
    this.#runner.stop()
    await this.#runner.close()
    await this.#persist()
  }

  async #persist() {
    const state: WorkerState = {
      version: 1,
      assignments: Object.fromEntries([...this.#assignments.entries()].map(([id, value]) => [id, {
        assignment: value.assignment,
        challengeDirectory: value.challengeDirectory,
        solving: value.solving,
        ...(value.runID ? { runID: value.runID } : {}),
        handledRejected: value.handledRejected,
        ...(value.resultQueued ? { resultQueued: true } : {}),
        ...(value.writeupQueued ? { writeupQueued: true } : {}),
      }])),
      outbox: this.#outbox,
    }
    const target = await stateFile(this.#root)
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 })
      await Bun.write(target, Bun.file(temporary))
    } finally {
      await Bun.file(temporary).delete().catch(() => {})
    }
  }

  #findAssignment(slug: string) {
    return [...this.#assignments.values()].find((item) => item.assignment.challenge.slug === slug)
  }

  async #materialize(assignment: Assignment) {
    const existing = this.#assignments.get(assignment.id)
    if (existing && existing.challenge.files.length > 0) {
      existing.assignment = assignment
      return existing
    }
    const directory = assignmentRoot(this.#root, assignment)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const archive = path.join(this.#root, "relay", "bundles", `${assignment.challenge.bundleSha256}.tar.gz`)
    await mkdir(path.dirname(archive), { recursive: true, mode: 0o700 })
    if (!(await lstat(archive).catch(() => undefined))) await this.#relay.getBundle(assignment.challenge.bundleSha256, archive)
    const unpacked = await unpackChallengeBundle({ bundle: archive, directory })
    if (unpacked.manifest.challengeID !== assignment.challenge.id)
      throw new Error(`Relay challenge bundle ID does not match assignment ${assignment.id}`)
    const challenge = { ...unpacked.challenge, remote: assignment.challenge.remoteUrl }
    if (assignment.challenge.resultBundleSha256) {
      const resultArchive = path.join(this.#root, "relay", "bundles", `${assignment.challenge.resultBundleSha256}.tar.gz`)
      if (!(await lstat(resultArchive).catch(() => undefined))) await this.#relay.getBundle(assignment.challenge.resultBundleSha256, resultArchive)
      const resultDirectory = path.join(directory, ".relay-result")
      const result = await unpackArtifactBundle({ bundle: resultArchive, directory: resultDirectory, kind: "result" }) as { files: string[] }
      challenge.files = unique([...challenge.files, ...result.files.map((file) => `.relay-result/${file}`)])
    }
    const value: WorkerAssignment = {
      assignment,
      challenge,
      challengeDirectory: directory,
      solving: false,
      ...(existing?.runID ? { runID: existing.runID } : {}),
      handledRejected: existing?.handledRejected ?? [],
      ...(existing?.resultQueued ? { resultQueued: true } : {}),
      ...(existing?.writeupQueued ? { writeupQueued: true } : {}),
    }
    this.#assignments.set(assignment.id, value)
    await this.#persist()
    return value
  }

  async #enqueueSolve(value: WorkerAssignment, hint?: string) {
    if (value.solving || value.assignment.phase === "writeup") return
    value.solving = true
    await this.#persist()
    const queued = await this.#runner.enqueue({
      challenges: [value.challenge],
      model: this.#model,
      models: { [value.challenge.slug]: this.#model },
      modelPolicy: { economy: this.#model, strong: this.#model },
      limits: DEFAULT_LIMITS,
      flagFormat: value.challenge.flagFormat,
      ...(hint ? { hint } : {}),
      ...(value.runID ? { workspaces: { [value.challenge.slug]: value.runID } } : {}),
    })
    void queued
  }

  async #enqueueWriteup(value: WorkerAssignment) {
    if (value.solving || !value.assignment.challenge.acceptedFlag) return
    const runs = await readChallengeRuns(this.#root, value.challenge.slug)
    const latest = runs.at(-1)
    if (!latest) return
    value.runID = latest.id
    const runDirectory = path.join(this.#root, "runs", value.challenge.slug, latest.id)
    const task = await loadTaskRecord(runDirectory)
    if (!task || task.acceptedFlag?.value !== value.assignment.challenge.acceptedFlag)
      await acceptTaskFlag({
        directory: runDirectory,
        flag: value.assignment.challenge.acceptedFlag,
        source: "relay",
        detail: "主机 connector 在 Relay 中确认 accepted",
      }).catch(() => {})
    value.solving = true
    await this.#persist()
    await this.#runner.enqueue({
      challenges: [value.challenge],
      model: this.#model,
      models: { [value.challenge.slug]: this.#model },
      modelPolicy: { economy: this.#model, strong: this.#model },
      limits: { ...DEFAULT_LIMITS, tokens: 24_000, timeout: 5 * 60_000 },
      flagFormat: value.challenge.flagFormat,
      purpose: "writeup",
      workspaces: { [value.challenge.slug]: value.runID },
    })
  }

  async #afterRunner() {
    if (this.#runner.hasWork()) return
    for (const value of this.#assignments.values()) {
      if (!value.solving) continue
      value.solving = false
      const runs = await readChallengeRuns(this.#root, value.challenge.slug).catch(() => [])
      const latest = runs.at(-1)
      if (latest) value.runID = latest.id
      if (
        latest &&
        value.assignment.phase === "offline" &&
        value.assignment.challenge.kind === "remote" &&
        latest.candidates.length === 0 &&
        !value.resultQueued
      ) {
        const runDirectory = path.join(this.#root, "runs", value.challenge.slug, latest.id)
        const resultDirectory = await prepareResultDirectory(runDirectory)
        if (resultDirectory) {
          const archive = path.join(this.#root, "relay", "outbox", `${value.assignment.id}-result.tar.gz`)
          const packed = await packArtifactBundle({ kind: "result", directory: resultDirectory, target: archive })
          this.#outbox.push({ kind: "result", id: `result-${value.assignment.id}`, assignmentId: value.assignment.id, file: packed.path, sha256: packed.sha256 })
          value.resultQueued = true
        } else {
          // Empty result explicitly releases the assignment back to queued_offline.
          await this.#relay.submitResult({ assignmentId: value.assignment.id }).catch(() => {})
          value.resultQueued = true
        }
      }
      if (latest && value.assignment.phase === "writeup" && !value.writeupQueued) {
        const runDirectory = path.join(this.#root, "runs", value.challenge.slug, latest.id)
        const writeupDirectory = path.join(this.#root, "relay", "outbox", `${value.assignment.id}-writeup`)
        try {
          await copyWriteup(runDirectory, writeupDirectory)
          const archive = path.join(this.#root, "relay", "outbox", `${value.assignment.id}-writeup.tar.gz`)
          const packed = await packArtifactBundle({ kind: "writeup", directory: writeupDirectory, target: archive })
          this.#outbox.push({ kind: "writeup", id: `writeup-${value.assignment.id}`, assignmentId: value.assignment.id, file: packed.path, sha256: packed.sha256 })
          value.writeupQueued = true
        } catch {
          // The next poll retries the writeup assignment while preserving the task workspace.
        }
      }
    }
    await this.#persist()
  }

  async #handleStopAssignments(items: WorkerPollResponse["stopAssignments"]) {
    for (const item of items) {
      const value = this.#assignments.get(item.id)
      if (!value) continue
      if (item.reason === "finished" || item.reason === "expired" || item.reason === "superseded") {
        if (item.reason === "finished" && value.assignment.phase === "writeup") this.#assignments.delete(item.id)
        else if (item.reason !== "finished") this.#assignments.delete(item.id)
      }
    }
  }

  async #handleRejected(flags: Flag[]) {
    for (const flag of flags) {
      const value = this.#assignments.get(flag.assignmentId)
      if (!value || value.handledRejected.includes(flag.id)) continue
      value.handledRejected.push(flag.id)
      await this.#enqueueSolve(value, [
        `Relay rejected candidate ${JSON.stringify(flag.value)}: ${flag.detail ?? "no detail"}.`,
        "Do not submit this value again. Continue solving from the existing NOTES.md and work/ state.",
      ].join("\n"))
    }
  }

  async #flushOutbox() {
    for (let index = 0; index < this.#outbox.length;) {
      const item = this.#outbox[index]!
      try {
        if (item.kind === "flag") await this.#relay.submitFlag({ id: item.id, assignmentId: item.assignmentId, value: item.value })
        else {
          await this.#relay.putBundle(item.sha256, item.file)
          if (item.kind === "result") await this.#relay.submitResult({ assignmentId: item.assignmentId, bundleSha256: item.sha256 })
          else await this.#relay.submitWriteup({ assignmentId: item.assignmentId, bundleSha256: item.sha256 })
        }
        this.#outbox.splice(index, 1)
      } catch {
        index += 1
      }
    }
    await this.#persist()
  }

  async #pollOnce() {
    if (this.#polling) return this.#polling
    this.#polling = (async () => {
      await this.#flushOutbox()
      const response = await this.#relay.poll({
        freeSlots: Math.max(0, this.#maxSlots - [...this.#assignments.values()].filter((value) => value.solving).length),
        activeAssignmentIds: [...this.#assignments.keys()],
      })
      await this.#handleStopAssignments(response.stopAssignments)
      await this.#handleRejected(response.rejectedFlags)
      for (const assignment of response.assignments) {
        const value = await this.#materialize(assignment)
        if (assignment.phase === "writeup") await this.#enqueueWriteup(value)
        else if (!value.solving) await this.#enqueueSolve(value)
      }
      await this.#afterRunner()
      await this.#persist()
      return response
    })()
    try {
      return await this.#polling
    } finally {
      this.#polling = undefined
    }
  }

  poll() {
    return this.#pollOnce()
  }

  async run(signal?: AbortSignal) {
    this.#stopped = false
    while (!this.#stopped && !signal?.aborted) {
      await this.#pollOnce().catch(() => {})
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#pollMs)
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
      })
    }
  }
}

export async function createRelayWorkerFromConfig(config: RelayLocalConfig) {
  return RelayWorker.open({
    relay: new RelayClient({ url: config.relayURL, token: config.token }),
    root: config.root,
    model: config.model,
    maxSlots: config.maxSlots,
    pollMs: config.pollMs,
  })
}
