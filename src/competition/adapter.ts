import { XihulunjianPlatformAdapter } from "../xihulunjian-platform-adapter.ts"
import { loadXihulunjianAccessKey, loadXihulunjianServerHost } from "../xihulunjian-config.ts"

/**
 * Locate the configured 西湖论剑 adapter.
 *
 * Instances are cached because each one owns a request-pacing chain; creating a fresh
 * adapter per call would defeat the rate limiting the platform requires.
 */

let cached: Promise<XihulunjianPlatformAdapter | undefined> | undefined

export function clearCompetitionAdapterCache() {
  cached = undefined
}

function createAdapter() {
  return (async () => {
    const [accessKey, serverHost] = await Promise.all([
      loadXihulunjianAccessKey(),
      loadXihulunjianServerHost(),
    ])
    return accessKey ? new XihulunjianPlatformAdapter(accessKey, fetch, undefined, serverHost) : undefined
  })()
}

/**
 * Cache the loading Promise itself, not its eventual value: concurrent first callers must await the
 * same in-flight construction instead of observing a fake `undefined` during the await window (which
 * used to be reported as "AccessKey 未配置"). A rejected load clears the cache so the next caller
 * retries rather than inheriting the failure forever.
 */
export function loadCompetitionAdapter(): Promise<XihulunjianPlatformAdapter | undefined> {
  cached ??= createAdapter()
  const pending = cached
  void pending.catch(() => {
    if (cached === pending) cached = undefined
  })
  return pending
}
