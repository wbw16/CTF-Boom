import type { Challenge } from "../challenge.ts"
import type { Workspace } from "../workspace.ts"

/**
 * Contract between Boom's competition layer and a CTF platform integration.
 *
 * An adapter owns everything platform-specific: the API dialect, credential naming, submission
 * semantics, and any quirk the live service verified in practice. Implementations are registered
 * in `src/platform/registry.ts`; the runner, GUI, and autopilot talk to them only through this
 * interface and the registry, never through a concrete adapter identity.
 */

export type PlatformSubmissionInput = {
  challenge: Challenge
  workspace: Workspace
  candidate: string
  signal?: AbortSignal
}

export type PlatformSubmissionResult = {
  /** Adapter id the verdict came from; `"manual"` when no platform verified the flag. */
  adapter: string
  verdict: "accepted" | "rejected" | "pending"
  detail: string
  submittedAt: string
}

export type PlatformNotice = {
  id: number
  title: string
  content?: string
  createdAt?: string
  createdTime?: number
  userName?: string
}

export type PlatformNoticeDetail = PlatformNotice & {
  isFile: boolean
  files: Array<{ name: string; url: string; ext?: string }>
  url?: string
}

/** Connection info for one live challenge environment, as handed to the solver. */
export type PlatformEndpoint = {
  /** `host:port` the solver should target. */
  remote?: string
  /** Human-readable connection matrix rendered into the challenge README. */
  detail: string
  expireTime?: number
}

export type PlatformEnvironment = {
  endpoint?: PlatformEndpoint
}

export type PlatformOverview = {
  point: number
  rank?: number
}

export type PlatformAdapterLimits = {
  /**
   * Boom's own submission ceiling per challenge, deliberately below the platform's hard cap: rules
   * forbid flag brute-forcing, so the useful ceiling is "a few genuine candidates".
   */
  maxSubmissionsPerChallenge: number
}

export interface PlatformAdapter {
  readonly id: string
  readonly displayName: string
  readonly limits: PlatformAdapterLimits
  /** Challenge directory owner tag(s): `this.id` plus any legacy ids still found in meta files. */
  readonly ownedAdapterIds: readonly string[]

  acquireChallenges(input: {
    root: string
    signal?: AbortSignal
    revalidate?: boolean
  }): Promise<Challenge[]>

  submitFlag(input: PlatformSubmissionInput): Promise<PlatformSubmissionResult>

  ensureEnvironment(
    exerciseId: string,
    options?: { signal?: AbortSignal; now?: () => number },
  ): Promise<PlatformEnvironment>

  recoverEnvironment(exerciseId: string, signal?: AbortSignal): Promise<void>

  overview(signal?: AbortSignal): Promise<PlatformOverview>

  notices(signal?: AbortSignal): Promise<PlatformNotice[]>

  noticeDetail(id: number, signal?: AbortSignal): Promise<PlatformNoticeDetail>

  /**
   * Strip the platform's flag wrapper so only the inner value is compared and submitted. Adapters
   * whose wire format is the bare value simply omit this.
   */
  normalizeFlag?(candidate: string): string

  /**
   * Derive a challenge's folder category from its name, a platform category label, and attachment
   * filenames. Used during sync and by the offline reclassification script.
   */
  inferChallengeCategory?(
    name: string,
    platformCategory?: unknown,
    attachments?: string[],
  ): import("../challenge.ts").ChallengeCategory
}

/**
 * Unwrap a `PREFIX{...}` flag to its inner value. The pattern is the common CTF convention, not any
 * single platform's, so the submission ledger deduplicates `DASCTF{x}` and a bare `x` regardless of
 * which adapter is active. A candidate that is already bare passes through untouched.
 */
export function unwrapFlagValue(candidate: string) {
  const trimmed = candidate.trim()
  const wrapped = /^[A-Za-z0-9_.-]{1,32}\{(.*)\}$/s.exec(trimmed)
  return wrapped ? wrapped[1]!.trim() : trimmed
}
