import type { Challenge } from "./challenge.ts"
import type { Workspace } from "./workspace.ts"

export type FlagSubmissionVerdict = "accepted" | "rejected" | "pending"

export type FlagSubmissionResult = {
  adapter: string
  verdict: FlagSubmissionVerdict
  detail: string
  submittedAt: string
}
export type ChallengeAcquisitionInput = {
  root: string
  signal?: AbortSignal
  options?: Record<string, unknown>
  selection?: PlatformChallengeSelection
}

export type PlatformChallengePreview = {
  /** Opaque adapter-owned key used by the catalog selection API. */
  id: string
  challengeID: string
  title: string
  slug?: string
  description?: string
  category?: string
  difficulty?: string
  points?: number
  solved?: boolean
  group?: { id: string; name: string }
}

export type PlatformChallengeQuery = {
  page?: number
  pageSize?: number
  search?: string
  category?: string
  difficulty?: string
}

export type PlatformChallengeCatalogInput = {
  root: string
  signal?: AbortSignal
  options?: Record<string, unknown>
  query?: PlatformChallengeQuery
}

export type PlatformChallengeCatalog = {
  items: PlatformChallengePreview[]
  page: number
  pageSize: number
  total: number
  categories?: string[]
  difficulties?: string[]
}

export type PlatformChallengeSelection = {
  /** Select every item matching query; exclude remains adapter-owned opaque IDs. */
  all?: boolean
  ids?: string[]
  exclude?: string[]
  query?: PlatformChallengeQuery
}

export type PlatformAdapterCapabilities = {
  listChallenges: boolean
  acquireChallenges: boolean
  submitFlag: boolean
}

export type FlagSubmissionInput = {
  root: string
  challenge: Challenge
  workspace: Workspace
  candidate: string
  signal?: AbortSignal
}

/**
 * Optional boundary for competition-specific challenge acquisition and flag submission.
 *
 * Boom's solver and task state machine never depend on a concrete platform. An adapter may
 * implement either operation or both; an unconfigured operation falls back to the manual flow.
 * Authentication remains adapter-owned and must not be copied into a run workspace.
 */
export interface CtfPlatformAdapter {
  readonly id: string
  readonly name?: string
  listChallenges?(input: PlatformChallengeCatalogInput): Promise<PlatformChallengeCatalog>
  acquireChallenges?(input: ChallengeAcquisitionInput): Promise<Challenge[]>
  submitFlag?(input: FlagSubmissionInput): Promise<FlagSubmissionResult>
}

export type PlatformAdapterLoader = (
  adapterID: string,
  root: string,
) => Promise<CtfPlatformAdapter | undefined>

function manualResult(detail: string): FlagSubmissionResult {
  return {
    adapter: "manual",
    verdict: "pending",
    detail,
    submittedAt: new Date().toISOString(),
  }
}

function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

export class PlatformAdapterRegistry {
  private readonly adapters = new Map<string, CtfPlatformAdapter>()
  private readonly loadedAdapters = new Map<string, CtfPlatformAdapter>()

  constructor(
    adapters: CtfPlatformAdapter[] = [],
    private readonly loader?: PlatformAdapterLoader,
  ) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: CtfPlatformAdapter) {
    const id = adapter.id.trim()
    if (!id) throw new Error("Platform adapter ID must not be empty")
    if (this.adapters.has(id)) throw new Error(`Duplicate platform adapter: ${id}`)
    this.adapters.set(id, adapter)
    return this
  }

  private async resolve(adapterID: string, root: string) {
    const registered = this.adapters.get(adapterID)
    if (registered) return registered
    const cacheKey = `${root}\0${adapterID}`
    const cached = this.loadedAdapters.get(cacheKey)
    if (cached) return cached
    const loaded = await this.loader?.(adapterID, root)
    if (!loaded) return undefined
    if (loaded.id !== adapterID)
      throw new Error(`Platform adapter loader returned ${loaded.id} for ${adapterID}`)
    this.loadedAdapters.set(cacheKey, loaded)
    return loaded
  }

  async capabilities(adapterID: string, root: string): Promise<PlatformAdapterCapabilities | undefined> {
    const adapter = await this.resolve(adapterID, root)
    return adapter
      ? {
          listChallenges: adapter.listChallenges !== undefined,
          acquireChallenges: adapter.acquireChallenges !== undefined,
          submitFlag: adapter.submitFlag !== undefined,
        }
      : undefined
  }

  async acquireChallenges(adapterID: string, input: ChallengeAcquisitionInput) {
    const adapter = await this.resolve(adapterID, input.root)
    if (!adapter?.acquireChallenges)
      throw new Error(`Platform adapter ${adapterID} does not support challenge acquisition`)
    return adapter.acquireChallenges(input)
  }

  async listChallenges(adapterID: string, input: PlatformChallengeCatalogInput) {
    const adapter = await this.resolve(adapterID, input.root)
    if (!adapter?.listChallenges)
      throw new Error(`Platform adapter ${adapterID} does not support challenge catalog preview`)
    return adapter.listChallenges(input)
  }

  async submitFlag(input: FlagSubmissionInput): Promise<FlagSubmissionResult> {
    const adapterID = input.challenge.platform?.adapter
    if (!adapterID)
      return manualResult("No automatic flag-submission adapter is configured; waiting for manual confirmation")
    const adapter = await this.resolve(adapterID, input.root)
    if (!adapter)
      return manualResult(`Configured flag-submission adapter is unavailable: ${adapterID}`)
    if (!adapter.submitFlag)
      return manualResult(`Platform adapter ${adapterID} does not support automatic flag submission`)
    const result = await adapter.submitFlag(input)
    if (result.adapter !== adapterID)
      throw new Error(`Platform adapter ${adapterID} returned a mismatched adapter ID`)
    return result
  }

  /**
   * Submit a flag with a bounded retry for attempts that return no verdict. A pending verdict
   * (adapter error, credential failure, or an API response without accepted/rejected) is retried
   * once after a short delay; the last result is then handed to the manual-review flow. Config
   * errors such as a missing adapter or missing submit capability are not retried.
   */
  async submitFlagWithRetry(
    input: FlagSubmissionInput,
    options: { attempts?: number; retryDelayMs?: number } = {},
  ): Promise<FlagSubmissionResult> {
    const adapterID = input.challenge.platform?.adapter
    if (!adapterID)
      return manualResult("No automatic flag-submission adapter is configured; waiting for manual confirmation")
    const adapter = await this.resolve(adapterID, input.root)
    if (!adapter)
      return manualResult(`Configured flag-submission adapter is unavailable: ${adapterID}`)
    if (!adapter.submitFlag)
      return manualResult(`Platform adapter ${adapterID} does not support automatic flag submission`)

    const attempts = Math.max(1, options.attempts ?? 2)
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 5_000)
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await delay(retryDelayMs, input.signal)
      if (input.signal?.aborted)
        return {
          adapter: adapterID,
          verdict: "pending",
          detail: "Automatic flag submission aborted; waiting for manual confirmation",
          submittedAt: new Date().toISOString(),
        }
      try {
        const result = await adapter.submitFlag(input)
        if (result.adapter !== adapterID)
          throw new Error(`Platform adapter ${adapterID} returned a mismatched adapter ID`)
        if (result.verdict !== "pending" || attempt === attempts) return result
      } catch (error) {
        lastError = error
        if (attempt === attempts) {
          return {
            adapter: adapterID,
            verdict: "pending",
            detail: `Automatic submission failed after ${attempts} attempts; waiting for manual confirmation: ${error instanceof Error ? error.message : String(error)}`,
            submittedAt: new Date().toISOString(),
          }
        }
      }
    }
    return manualResult(
      lastError instanceof Error
        ? `Automatic submission failed after ${attempts} attempts; waiting for manual confirmation: ${lastError.message}`
        : `Automatic submission returned no verdict after ${attempts} attempts; waiting for manual confirmation`,
    )
  }
}
