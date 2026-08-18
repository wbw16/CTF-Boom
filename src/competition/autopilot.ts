/** The contest releases challenges in batches; ten minutes is the agreed polling cadence. */
export const AUTOPILOT_SYNC_INTERVAL_MS = 10 * 60_000

/**
 * A bounded retry is deliberately separate from the adapter's rate-limit retry.  The adapter knows
 * how to pace individual platform calls; this layer handles a failed *whole catalog* acquisition
 * (for example a temporary DNS, TLS, or 5xx failure) without ever letting one bad poll stop the
 * unattended match loop.
 */
export const AUTOPILOT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const

export type AutopilotCycleResult = {
  downloaded: number
  queued: number
  skipped: number
}

export type CompetitionAutopilotState = {
  enabled: boolean
  syncing: boolean
  /** Number of retry delays used during the current or most recent poll. */
  retries: number
  nextSyncAt?: number
  lastSyncAt?: number
  lastSuccessAt?: number
  lastError?: string
  lastResult?: AutopilotCycleResult
}

export type CompetitionAutopilotOptions = {
  sync: (signal: AbortSignal) => Promise<AutopilotCycleResult>
  /** False means the match is over, so no new catalog poll or solve may be started. */
  canRun?: () => boolean
  intervalMs?: number
  retryDelaysMs?: readonly number[]
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  onState?: (state: CompetitionAutopilotState) => void
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function aborted(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError"
}

/** Errors that are expected to clear without operator action. Authentication and malformed data are not. */
export function isRetryableAutopilotError(error: unknown) {
  if (aborted(error)) return false
  const message = messageOf(error)
  return /\b(?:408|425|429|5\d\d)\b|\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b|\b(?:fetch failed|network|socket|timeout|timed out|temporar(?:y|ily))\b|限流|请求过于频繁/i.test(message)
}

function defaultSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"))
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }, { once: true })
  })
}

/**
 * Process-lifetime scheduler for unattended matches. It intentionally contains no HTTP or GUI
 * knowledge, which keeps retry/overlap semantics testable and lets the GUI server own persistence.
 */
export class CompetitionAutopilot {
  readonly #sync: CompetitionAutopilotOptions["sync"]
  readonly #canRun: () => boolean
  #intervalMs: number
  readonly #retryDelaysMs: readonly number[]
  readonly #now: () => number
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly #onState?: CompetitionAutopilotOptions["onState"]
  #timer: ReturnType<typeof setTimeout> | undefined
  #controller: AbortController | undefined
  #cycle: Promise<void> | undefined
  #generation = 0
  #restartAfterCycle = false
  #state: CompetitionAutopilotState = { enabled: false, syncing: false, retries: 0 }

  constructor(options: CompetitionAutopilotOptions) {
    this.#sync = options.sync
    this.#canRun = options.canRun ?? (() => true)
    this.#intervalMs = Math.max(1, options.intervalMs ?? AUTOPILOT_SYNC_INTERVAL_MS)
    this.#retryDelaysMs = options.retryDelaysMs ?? AUTOPILOT_RETRY_DELAYS_MS
    this.#now = options.now ?? (() => Date.now())
    this.#sleep = options.sleep ?? defaultSleep
    this.#onState = options.onState
  }

  state(): CompetitionAutopilotState {
    return {
      ...this.#state,
      ...(this.#state.lastResult ? { lastResult: { ...this.#state.lastResult } } : {}),
    }
  }

  /** Update the saved cadence without creating a second timer. Active polling is never interrupted. */
  setIntervalMs(value: number) {
    this.#intervalMs = Math.max(1, Math.floor(value))
    if (this.#state.enabled && !this.#state.syncing) {
      if (this.#timer !== undefined) clearTimeout(this.#timer)
      this.#timer = undefined
      this.#schedule(this.#intervalMs)
    }
    return this.state()
  }

  /** Start is idempotent. The first catalog poll begins immediately, without blocking the caller. */
  start(options: { immediate?: boolean } = {}) {
    if (this.#state.enabled) return this.state()
    this.#state = {
      ...this.#state,
      enabled: true,
      syncing: false,
      retries: 0,
      nextSyncAt: undefined,
      lastError: undefined,
    }
    this.#publish()
    if (this.#cycle) this.#restartAfterCycle = true
    else if (options.immediate === false) this.#schedule(this.#intervalMs)
    else void this.syncNow()
    return this.state()
  }

  /** Stops future polling and aborts an in-flight platform request or retry delay. */
  stop() {
    this.#generation += 1
    this.#restartAfterCycle = false
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#controller?.abort()
    this.#controller = undefined
    this.#state = { ...this.#state, enabled: false, syncing: false, nextSyncAt: undefined }
    this.#publish()
    return this.state()
  }

  /** Public mainly for a manual “sync now” action and deterministic tests; overlapping calls coalesce. */
  async syncNow() {
    if (!this.#state.enabled) return
    if (this.#cycle) return this.#cycle
    if (!this.#canRun()) {
      this.#state = {
        ...this.#state,
        enabled: false,
        syncing: false,
        nextSyncAt: undefined,
        lastError: "比赛已结束，已停止无人值守巡航",
      }
      this.#publish()
      return
    }
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    const generation = this.#generation
    const controller = new AbortController()
    this.#controller = controller
    const cycle = this.#run(generation, controller)
    this.#cycle = cycle
    try {
      await cycle
    } finally {
      if (this.#cycle === cycle) {
        this.#cycle = undefined
        if (this.#restartAfterCycle && this.#state.enabled) {
          this.#restartAfterCycle = false
          void this.syncNow()
        }
      }
    }
  }

  #publish() {
    this.#onState?.(this.state())
  }

  #schedule(delay: number) {
    if (!this.#state.enabled) return
    this.#state = { ...this.#state, nextSyncAt: this.#now() + delay }
    this.#publish()
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.syncNow()
    }, delay)
  }

  async #run(generation: number, controller: AbortController) {
    this.#state = {
      ...this.#state,
      syncing: true,
      retries: 0,
      nextSyncAt: undefined,
      lastSyncAt: this.#now(),
      lastError: undefined,
    }
    this.#publish()
    try {
      let retries = 0
      let result: AutopilotCycleResult | undefined
      while (true) {
        try {
          result = await this.#sync(controller.signal)
          break
        } catch (error) {
          if (controller.signal.aborted || generation !== this.#generation) return
          if (!isRetryableAutopilotError(error) || retries >= this.#retryDelaysMs.length) throw error
          const delay = this.#retryDelaysMs[retries]!
          retries += 1
          this.#state = { ...this.#state, retries }
          this.#publish()
          await this.#sleep(delay, controller.signal)
        }
      }
      if (generation !== this.#generation || controller.signal.aborted) return
      this.#state = {
        ...this.#state,
        syncing: false,
        retries,
        lastSuccessAt: this.#now(),
        lastResult: result,
        lastError: undefined,
      }
      this.#publish()
    } catch (error) {
      if (generation !== this.#generation || controller.signal.aborted || aborted(error)) return
      this.#state = {
        ...this.#state,
        syncing: false,
        lastError: messageOf(error).replace(/[\r\n]+/g, " ").slice(0, 500),
      }
      this.#publish()
    } finally {
      if (this.#controller === controller) this.#controller = undefined
      if (generation === this.#generation && this.#state.enabled) this.#schedule(this.#intervalMs)
    }
  }
}
