import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises"
import path from "node:path"
import type { RuntimeEvent, RuntimeUsage } from "../runtime-contract.ts"
import {
  addRuntimeUsage,
  billableRuntimeUsage,
  cloneRuntimeUsage,
  emptyRuntimeUsage,
  NativeProviderFailure,
} from "./native-provider.ts"
import { atomicJson, NativeEventBus, sanitizeNativeState } from "./native-storage.ts"

export type NativeKernelLimits = {
  maxSteps: number
  maxRetries: number
  maxLengthContinuations: number
  maxTaskDepth: number
  maxConcurrency: number
}

export const DEFAULT_NATIVE_KERNEL_LIMITS: NativeKernelLimits = {
  maxSteps: 64,
  maxRetries: 2,
  maxLengthContinuations: 1,
  maxTaskDepth: 2,
  maxConcurrency: 4,
}

/**
 * Hard ceiling on how long a step may queue for a concurrency slot. Generous by design (a busy
 * local match keeps all slots legitimately busy), but bounded so a provider that accepts a slot
 * and then hangs cannot deadlock the whole task tree until process exit.
 */
const SEMAPHORE_WAIT_TIMEOUT_MS = 600_000

export type NativeTaskState = "queued" | "running" | "completed" | "failed" | "cancelled"

export type NativeTaskAuditEntry = {
  version: 1
  timestamp: string
  taskID: string
  parentTaskID?: string
  callID: string
  state: NativeTaskState
  depth: number
  title: string
  directory: string
  usage?: RuntimeUsage
  cost?: number
  error?: string
}

export class NativeBudgetExceeded extends Error {
  constructor(readonly used: number, readonly limit: number) {
    super(`Boom Native task-tree token budget exceeded: ${Math.round(used)} > ${limit}`)
    this.name = "NativeBudgetExceeded"
  }
}

/** Sentinel name for a concurrency-slot wait that exceeded its deadline. */
const SLOT_TIMEOUT = "BoomSlotTimeout"

class Semaphore {
  #active = 0
  #waiters: Array<{
    signal: AbortSignal
    resolve: (release: () => void) => void
    reject: (error: unknown) => void
    abort: () => void
    timer?: ReturnType<typeof setTimeout>
  }> = []

  constructor(readonly limit: number) {}

  acquire(signal: AbortSignal, waitTimeoutMs = SEMAPHORE_WAIT_TIMEOUT_MS): Promise<() => void> {
    signal.throwIfAborted()
    if (this.#active < this.limit) {
      this.#active += 1
      return Promise.resolve(this.#release())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) this.#waiters.splice(index, 1)
          if (waiter.timer !== undefined) clearTimeout(waiter.timer)
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
        },
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      }
      // A queued caller must not be pinned forever by a hung slot holder; the rejection is
      // distinguishable from abort so runActive can map it to a retryable failure.
      if (waitTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.#waiters.indexOf(waiter)
          if (index >= 0) this.#waiters.splice(index, 1)
          signal.removeEventListener("abort", waiter.abort)
          const error = new Error(`Timed out after ${Math.round(waitTimeoutMs / 1_000)}s waiting for a provider concurrency slot`)
          error.name = SLOT_TIMEOUT
          reject(error)
        }, waitTimeoutMs)
      }
      signal.addEventListener("abort", waiter.abort, { once: true })
      this.#waiters.push(waiter)
    })
  }

  #release() {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#waiters.shift()
      if (next) {
        next.signal.removeEventListener("abort", next.abort)
        if (next.timer !== undefined) clearTimeout(next.timer)
        next.resolve(this.#release())
      } else this.#active -= 1
    }
  }
}

type BudgetState = {
  version: 1
  limit?: number
  usage: RuntimeUsage
  cost: number
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < 1) throw new Error(`${name} must be a positive integer`)
  return selected
}

export function normalizeNativeKernelLimits(input: Partial<NativeKernelLimits> = {}): NativeKernelLimits {
  return {
    maxSteps: positiveInteger(input.maxSteps, DEFAULT_NATIVE_KERNEL_LIMITS.maxSteps, "maxSteps"),
    maxRetries: positiveInteger(input.maxRetries, DEFAULT_NATIVE_KERNEL_LIMITS.maxRetries, "maxRetries"),
    maxLengthContinuations: positiveInteger(
      input.maxLengthContinuations,
      DEFAULT_NATIVE_KERNEL_LIMITS.maxLengthContinuations,
      "maxLengthContinuations",
    ),
    maxTaskDepth: positiveInteger(input.maxTaskDepth, DEFAULT_NATIVE_KERNEL_LIMITS.maxTaskDepth, "maxTaskDepth"),
    maxConcurrency: positiveInteger(input.maxConcurrency, DEFAULT_NATIVE_KERNEL_LIMITS.maxConcurrency, "maxConcurrency"),
  }
}

function isInside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function copyTree(sourceRoot: string, destinationRoot: string) {
  const canonical = await realpath(sourceRoot)
  const sourceInfo = await lstat(canonical)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error(`Subagent source is not a real directory: ${sourceRoot}`)
  await mkdir(destinationRoot, { recursive: true })
  const visit = async (source: string, destination: string) => {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name)
      const canonicalFrom = await realpath(from)
      if (!isInside(canonical, canonicalFrom)) throw new Error(`Subagent source escapes its root: ${from}`)
      const info = await lstat(from)
      if (info.isSymbolicLink()) throw new Error(`Subagent source contains a symbolic link: ${from}`)
      const to = path.join(destination, entry.name)
      if (info.isDirectory()) {
        await mkdir(to, { recursive: true })
        await visit(from, to)
      } else if (info.isFile()) {
        await copyFile(from, to)
        await chmod(to, 0o444).catch(() => {})
      } else throw new Error(`Subagent source contains a non-file entry: ${from}`)
    }
  }
  await visit(canonical, destinationRoot)
}

/** Shared cancellation, concurrency, budget, workspace, and audit authority for one root task tree. */
export class NativeTaskCoordinator {
  readonly signal: AbortSignal
  readonly limits: NativeKernelLimits
  readonly rootDirectory: string
  readonly rootSessionID: string
  readonly storageDirectory: string
  #controller = new AbortController()
  #semaphore: Semaphore
  #bus: NativeEventBus
  #budget: BudgetState
  #budgetFile: string
  #auditFile: string
  #budgetTail: Promise<void> = Promise.resolve()
  #auditTail: Promise<void> = Promise.resolve()

  private constructor(input: {
    rootDirectory: string
    rootSessionID: string
    storageDirectory: string
    limits: NativeKernelLimits
    bus: NativeEventBus
    budget: BudgetState
  }) {
    this.rootDirectory = input.rootDirectory
    this.rootSessionID = input.rootSessionID
    this.storageDirectory = input.storageDirectory
    this.limits = input.limits
    this.#bus = input.bus
    this.#budget = input.budget
    this.#budgetFile = path.join(input.storageDirectory, "budget.json")
    this.#auditFile = path.join(input.storageDirectory, "task-tree.jsonl")
    this.#semaphore = new Semaphore(input.limits.maxConcurrency)
    this.signal = this.#controller.signal
  }

  static async open(input: {
    rootDirectory: string
    rootSessionID: string
    storageDirectory: string
    limits?: Partial<NativeKernelLimits>
    tokenBudget?: number
    bus: NativeEventBus
  }) {
    const rootDirectory = await realpath(input.rootDirectory)
    const limits = normalizeNativeKernelLimits(input.limits)
    const budgetFile = path.join(input.storageDirectory, "budget.json")
    const raw = await readFile(budgetFile, "utf8").catch(() => undefined)
    let budget: BudgetState
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BudgetState>
      if (parsed.version !== 1 || !parsed.usage || typeof parsed.cost !== "number")
        throw new Error("Invalid Boom Native task-tree budget state")
      budget = parsed as BudgetState
      if (input.tokenBudget !== undefined)
        budget.limit = budget.limit === undefined ? input.tokenBudget : Math.min(budget.limit, input.tokenBudget)
    } else {
      budget = {
        version: 1,
        ...(input.tokenBudget === undefined ? {} : { limit: input.tokenBudget }),
        usage: emptyRuntimeUsage(),
        cost: 0,
      }
    }
    if (budget.limit !== undefined && (!Number.isFinite(budget.limit) || budget.limit <= 0))
      throw new Error("tokenBudget must be a positive finite number")
    const coordinator = new NativeTaskCoordinator({
      rootDirectory,
      rootSessionID: input.rootSessionID,
      storageDirectory: input.storageDirectory,
      limits,
      bus: input.bus,
      budget,
    })
    const used = billableRuntimeUsage(budget.usage)
    if (budget.limit !== undefined && used > budget.limit)
      throw new NativeBudgetExceeded(used, budget.limit)
    await Promise.all([
      atomicJson(budgetFile, budget),
      mkdir(path.join(input.storageDirectory, "tasks"), { recursive: true }),
    ])
    return coordinator
  }

  usage() {
    return cloneRuntimeUsage(this.#budget.usage)
  }

  get cost() {
    return this.#budget.cost
  }

  get tokenBudget() {
    return this.#budget.limit
  }

  abort(reason: unknown = new DOMException("Boom Native conversation cancelled", "AbortError")) {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason)
  }

  async runActive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([this.signal, signal])
    let release: (() => void) | undefined
    try {
      release = await this.#semaphore.acquire(combined)
    } catch (error) {
      // Abort rejections keep their identity; a slot-wait timeout becomes a retryable provider
      // failure so the step re-enters the normal retry/backoff path instead of failing the turn.
      if (combined.aborted || !(error instanceof Error) || error.name !== SLOT_TIMEOUT) throw error
      throw new NativeProviderFailure({
        name: SLOT_TIMEOUT,
        message: error.message,
        category: "network",
        retryable: true,
      })
    }
    try {
      combined.throwIfAborted()
      return await operation()
    } finally {
      release()
    }
  }

  async charge(usage: RuntimeUsage, cost: number) {
    let exceeded: NativeBudgetExceeded | undefined
    const write = this.#budgetTail.then(async () => {
      addRuntimeUsage(this.#budget.usage, usage)
      this.#budget.cost += cost
      await atomicJson(this.#budgetFile, this.#budget)
      const billable = billableRuntimeUsage(this.#budget.usage)
      if (this.#budget.limit !== undefined && billable > this.#budget.limit)
        exceeded = new NativeBudgetExceeded(billable, this.#budget.limit)
    })
    this.#budgetTail = write.catch(() => {})
    await write
    if (exceeded) {
      this.abort(exceeded)
      throw exceeded
    }
  }

  async createTaskWorkspace(taskID: string, sourceDirectory = this.rootDirectory) {
    if (!/^task-[0-9a-f-]+$/i.test(taskID)) throw new Error(`Invalid Native task ID: ${taskID}`)
    const sourceRoot = await realpath(sourceDirectory)
    const taskRoot = path.join(this.storageDirectory, "tasks", taskID)
    const workspace = path.join(taskRoot, "workspace")
    await mkdir(path.join(workspace, "work"), { recursive: true })
    await copyTree(path.join(sourceRoot, "challenge"), path.join(workspace, "challenge"))
    const notes = path.join(sourceRoot, "NOTES.md")
    const notesInfo = await lstat(notes)
    if (!notesInfo.isFile() || notesInfo.isSymbolicLink()) throw new Error("Root NOTES.md is not a real file")
    await copyFile(notes, path.join(workspace, "NOTES.md"))
    const environment = path.join(sourceRoot, "work", ".boom", "environment.json")
    const environmentInfo = await lstat(environment).catch(() => undefined)
    if (environmentInfo?.isFile() && !environmentInfo.isSymbolicLink()) {
      const destination = path.join(workspace, "work", ".boom", "environment.json")
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(environment, destination)
    }
    return { taskRoot, workspace, relative: path.relative(this.rootDirectory, workspace).split(path.sep).join("/") }
  }

  async recordTask(input: Omit<NativeTaskAuditEntry, "version" | "timestamp">) {
    const entry = sanitizeNativeState<NativeTaskAuditEntry>({
      version: 1,
      timestamp: new Date().toISOString(),
      ...input,
      ...(input.error ? { error: input.error.slice(0, 2_000) } : {}),
    }, 2_000)
    const write = this.#auditTail.then(() => appendFile(
      this.#auditFile,
      `${JSON.stringify(entry)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ))
    this.#auditTail = write.catch(() => {})
    await write
    const event: RuntimeEvent = {
      type: "task-state",
      sessionID: this.rootSessionID,
      taskID: entry.taskID,
      ...(entry.parentTaskID ? { parentTaskID: entry.parentTaskID } : {}),
      state: entry.state,
      depth: entry.depth,
      title: entry.title,
      directory: entry.directory,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.cost === undefined ? {} : { cost: entry.cost }),
      ...(entry.error ? { error: entry.error } : {}),
    }
    await this.#bus.emit(event)
    return entry
  }
}
