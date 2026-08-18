import { readdir } from "node:fs/promises"
import path from "node:path"
import { loadPlatformManifest } from "../platform-manifest.ts"
import { XihulunjianPlatformAdapter } from "../xihulunjian-platform-adapter.ts"

/**
 * Locate the configured 西湖论剑 adapter for a Boom root.
 *
 * The competition scheduler needs adapter capabilities that the generic `CtfPlatformAdapter`
 * interface does not expose — starting, polling and recovering a challenge environment. Rather than
 * widening that interface for one platform, the scheduler looks up this profile directly and simply
 * does nothing when no competition adapter is configured.
 *
 * Instances are cached per root because each one owns a request-pacing chain; creating a fresh
 * adapter per call would defeat the rate limiting the platform requires.
 */

const cache = new Map<string, XihulunjianPlatformAdapter | undefined>()

export function clearCompetitionAdapterCache() {
  cache.clear()
}

export async function loadCompetitionAdapter(root: string) {
  const resolved = path.resolve(root)
  if (cache.has(resolved)) return cache.get(resolved)

  const directory = path.join(resolved, "platforms")
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  let found: XihulunjianPlatformAdapter | undefined
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue
    const id = entry.name.slice(0, -".json".length)
    const manifest = await loadPlatformManifest(resolved, id).catch(() => undefined)
    if (manifest?.profile !== "xihulunjian-agent-v1") continue
    // A draft manifest is deliberately not executable.
    if (manifest.status !== "ready") continue
    found = new XihulunjianPlatformAdapter(manifest)
    break
  }
  cache.set(resolved, found)
  return found
}
