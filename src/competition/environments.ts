/**
 * Leases for the competition's scarce challenge environments.
 *
 * The platform allows only three environments at once, so a leaked lease permanently stalls every
 * remaining remote challenge. That makes release discipline the critical property here:
 *
 * - `acquire` hands out a lease only when a slot is free.
 * - `release` is idempotent, so a double release from both a normal path and a `finally` cannot
 *   drive the count negative or free someone else's slot.
 * - A lease is keyed by challenge slug, so a re-entrant acquire for the same challenge reuses its
 *   existing lease instead of consuming a second slot.
 */

export type EnvironmentLease = {
  slug: string
  exerciseId: string
  acquiredAt: number
  /** Platform-reported expiry, once the environment is up. */
  expireTime?: number
  remote?: string
}

export type EnvironmentRecoverer = (exerciseId: string) => Promise<void>

/** Treat an environment as expired slightly early; a lease that dies mid-solve is worse than a refresh. */
const EXPIRY_MARGIN_MS = 60_000

export class EnvironmentPool {
  private readonly leases = new Map<string, EnvironmentLease>()

  constructor(
    private capacity: number,
    /** Called when a lease is released so the platform slot is actually freed. */
    private readonly recover: EnvironmentRecoverer,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (capacity < 1) throw new Error("Environment capacity must be at least 1")
  }

  get size() {
    return this.leases.size
  }

  get limit() {
    return this.capacity
  }

  setCapacity(value: number) {
    if (value < 1) throw new Error("Environment capacity must be at least 1")
    this.capacity = value
  }

  held(slug: string) {
    return this.leases.get(slug)
  }

  active(): EnvironmentLease[] {
    return [...this.leases.values()]
  }

  /**
   * Take a lease for a challenge, or return the one it already holds. Returns undefined when every
   * slot is taken, which the scheduler treats as "wait", not as an error.
   */
  acquire(slug: string, exerciseId: string): EnvironmentLease | undefined {
    const existing = this.leases.get(slug)
    if (existing) return existing
    if (this.leases.size >= this.capacity) return undefined
    const lease: EnvironmentLease = { slug, exerciseId, acquiredAt: this.now() }
    this.leases.set(slug, lease)
    return lease
  }

  /** Record what the platform reported once the environment came up. */
  update(slug: string, detail: { remote?: string; expireTime?: number }) {
    const lease = this.leases.get(slug)
    if (!lease) return undefined
    if (detail.remote !== undefined) lease.remote = detail.remote
    if (detail.expireTime !== undefined) lease.expireTime = detail.expireTime
    return lease
  }

  /** True when the lease is gone or close enough to expiry that it must be refreshed before use. */
  expired(slug: string) {
    const lease = this.leases.get(slug)
    if (!lease) return true
    if (lease.expireTime === undefined) return false
    return lease.expireTime - EXPIRY_MARGIN_MS <= this.now()
  }

  /**
   * Release a lease and recover the platform environment.
   *
   * The slot is freed even when recovery fails: holding it locally after losing track of the remote
   * state would strand the slot forever, while the platform reclaims an abandoned environment on its
   * own expiry. The recovery error is returned so the caller can report it.
   */
  async release(slug: string): Promise<{ released: boolean; error?: Error }> {
    const lease = this.leases.get(slug)
    if (!lease) return { released: false }
    // Drop the lease first so a failing recovery cannot leak the slot.
    this.leases.delete(slug)
    try {
      await this.recover(lease.exerciseId)
      return { released: true }
    } catch (error) {
      return {
        released: true,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  /** Release every lease, used when the match ends or the runner shuts down. */
  async releaseAll() {
    const errors: Error[] = []
    for (const slug of [...this.leases.keys()]) {
      const result = await this.release(slug)
      if (result.error) errors.push(result.error)
    }
    return errors
  }
}
