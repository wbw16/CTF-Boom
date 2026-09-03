import type { PlatformAdapter } from "./adapter.ts"
import {
  DasctfPlatformAdapter,
  DASCTF_ADAPTER_ID,
  DASCTF_DEFAULT_SERVER_HOST,
  DASCTF_LEGACY_ADAPTER_ID,
} from "./adapters/dasctf.ts"
import { platformCredentials, type PlatformCredentials } from "./credentials.ts"

/**
 * Registry of built-in competition platform adapters.
 *
 * The runner, GUI, and autopilot resolve adapters only through this registry, so adding a platform
 * means implementing `PlatformAdapter` and appending one entry below — no core wiring changes. Each
 * entry declares the credential store (including legacy sources for renamed adapters) and a factory;
 * instances are cached per entry because an adapter owns a request-pacing chain.
 */

export type PlatformAdapterEntry = {
  id: string
  /** Legacy adapter ids that still resolve to this entry (challenge meta.json compat). */
  aliases: string[]
  displayName: string
  credentials: PlatformCredentials
  instantiate: (options: { accessKey: string; serverHost: string }) => PlatformAdapter
}

export type PlatformAdapterSummary = {
  id: string
  displayName: string
  defaultServerHost: string
  credential: { configured: boolean; serverHost: string }
}

const BUILT_IN_ADAPTERS: PlatformAdapterEntry[] = [
  {
    id: DASCTF_ADAPTER_ID,
    aliases: [DASCTF_LEGACY_ADAPTER_ID],
    displayName: "DASCTF",
    credentials: platformCredentials({
      id: DASCTF_ADAPTER_ID,
      label: "DASCTF",
      accessKeyEnvVar: "BOOM_DASCTF_ACCESS_KEY",
      legacyAccessKeyEnvVars: ["BOOM_XIHULUNJIAN_ACCESS_KEY"],
      credentialFileName: "dasctf.json",
      legacyCredentialFileNames: ["xihulunjian.json"],
      defaultServerHost: DASCTF_DEFAULT_SERVER_HOST,
    }),
    instantiate: ({ accessKey, serverHost }) =>
      new DasctfPlatformAdapter(accessKey, fetch, undefined, serverHost),
  },
]

export function listPlatformAdapterEntries(): readonly PlatformAdapterEntry[] {
  return BUILT_IN_ADAPTERS
}

/** Resolve an adapter reference (id or alias) to its registry entry; unknown ids resolve to nothing. */
export function findPlatformAdapterEntry(id: string | undefined): PlatformAdapterEntry | undefined {
  const wanted = id?.trim()
  if (!wanted) return undefined
  return BUILT_IN_ADAPTERS.find((entry) => entry.id === wanted || entry.aliases.includes(wanted))
}

export function defaultPlatformAdapterEntry(): PlatformAdapterEntry {
  return BUILT_IN_ADAPTERS[0]!
}

/** The entry the competition layer should use: the configured id when it resolves, else the default. */
export function activePlatformAdapterEntry(platformId?: string): PlatformAdapterEntry {
  return findPlatformAdapterEntry(platformId) ?? defaultPlatformAdapterEntry()
}

async function describeEntry(entry: PlatformAdapterEntry): Promise<PlatformAdapterSummary> {
  return {
    id: entry.id,
    displayName: entry.displayName,
    defaultServerHost: entry.credentials.spec.defaultServerHost,
    credential: await entry.credentials.status(),
  }
}

/** Registry overview for the GUI: every built-in adapter plus which one is active. */
export async function platformAdapterSummaries(platformId?: string) {
  const platforms = await Promise.all(BUILT_IN_ADAPTERS.map((entry) => describeEntry(entry)))
  const activeEntry = activePlatformAdapterEntry(platformId)
  const active = platforms.find((summary) => summary.id === activeEntry.id) ?? platforms[0]!
  return { active, platforms }
}

const instances = new Map<string, Promise<PlatformAdapter | undefined>>()

export function clearCompetitionAdapterCache() {
  instances.clear()
}

/**
 * Load the adapter instance for a platform reference, or undefined when its credential is not
 * configured. The loading Promise itself is cached, not its eventual value: concurrent first
 * callers must await the same in-flight construction instead of observing a fake `undefined`
 * during the await window. A rejected load clears the cache so the next caller retries rather
 * than inheriting the failure forever.
 */
export function loadCompetitionAdapter(platformId?: string): Promise<PlatformAdapter | undefined> {
  const entry = activePlatformAdapterEntry(platformId)
  const cached = instances.get(entry.id)
  if (cached) return trackFailure(cached)
  const loading = (async () => {
    const [accessKey, serverHost] = await Promise.all([
      entry.credentials.loadAccessKey(),
      entry.credentials.loadServerHost(),
    ])
    return accessKey ? entry.instantiate({ accessKey, serverHost }) : undefined
  })()
  instances.set(entry.id, loading)
  return trackFailure(loading)

  function trackFailure(pending: Promise<PlatformAdapter | undefined>) {
    void pending.catch(() => {
      if (instances.get(entry.id) === pending) instances.delete(entry.id)
    })
    return pending
  }
}
