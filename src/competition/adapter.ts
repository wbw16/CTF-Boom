import { XihulunjianPlatformAdapter } from "../xihulunjian-platform-adapter.ts"
import { loadXihulunjianAccessKey, loadXihulunjianServerHost } from "../xihulunjian-config.ts"

/**
 * Locate the configured 西湖论剑 adapter.
 *
 * Instances are cached because each one owns a request-pacing chain; creating a fresh
 * adapter per call would defeat the rate limiting the platform requires.
 */

let cached: XihulunjianPlatformAdapter | undefined
let loaded = false

export function clearCompetitionAdapterCache() {
  cached = undefined
  loaded = false
}

export async function loadCompetitionAdapter() {
  if (loaded) return cached
  loaded = true
  const [accessKey, serverHost] = await Promise.all([
    loadXihulunjianAccessKey(),
    loadXihulunjianServerHost(),
  ])
  cached = accessKey ? new XihulunjianPlatformAdapter(accessKey, fetch, undefined, serverHost) : undefined
  return cached
}
