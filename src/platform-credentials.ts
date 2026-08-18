import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Host-owned storage for platform API credentials.
 *
 * Adapters read their credential from a named environment variable, which keeps secrets out of
 * manifests, challenge directories, and run workspaces. But a GUI user has no way to set an
 * environment variable for an already-running process, so Boom persists the value here (0600, in the
 * Boom config directory) and loads it into `process.env` at startup and on save.
 *
 * The value is never written into `<root>/platforms/*.json`, never copied into a run workspace, and
 * never returned to the frontend: callers may only ask whether it is configured.
 */

export type PlatformCredentialStore = {
  version: 1
  /** Environment variable name -> credential value. */
  credentials: Record<string, string>
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const MAX_VALUE_LENGTH = 4_096

function empty(): PlatformCredentialStore {
  return { version: 1, credentials: {} }
}

export function platformCredentialStorePath() {
  const home = path.resolve(
    process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"),
  )
  return path.join(home, "platform-credentials.json")
}

function parse(value: unknown): PlatformCredentialStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty()
  const input = value as Record<string, unknown>
  if (input.version !== 1) return empty()
  const raw = input.credentials
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty()
  const credentials: Record<string, string> = {}
  for (const [key, item] of Object.entries(raw as Record<string, unknown>)) {
    if (!ENV_NAME.test(key)) continue
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) continue
    credentials[key] = trimmed
  }
  return { version: 1, credentials }
}

export async function loadPlatformCredentials() {
  const target = platformCredentialStorePath()
  const info = await lstat(target).catch(() => undefined)
  if (!info) return empty()
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Platform credential store is not a real file: ${target}`)
  try {
    return parse(JSON.parse(await readFile(target, "utf8")))
  } catch (error) {
    throw new Error(
      `Failed to read platform credentials at ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

/**
 * Export stored credentials into the current process environment so adapters can read them.
 * An existing environment variable wins: an explicitly exported secret must not be silently
 * overridden by a stale stored one.
 */
export async function applyStoredPlatformCredentials() {
  const store = await loadPlatformCredentials().catch(() => empty())
  const applied: string[] = []
  for (const [env, value] of Object.entries(store.credentials)) {
    if (process.env[env]?.trim()) continue
    process.env[env] = value
    applied.push(env)
  }
  return applied
}

/** Persist or clear one credential. Passing an empty value removes it. */
export async function savePlatformCredential(env: string, value: string) {
  if (!ENV_NAME.test(env)) throw new Error(`Invalid credential environment variable: ${env}`)
  const trimmed = value.trim()
  if (trimmed.length > MAX_VALUE_LENGTH)
    throw new Error(`Credential exceeds ${MAX_VALUE_LENGTH} characters`)
  if (/[\0\r\n]/.test(trimmed)) throw new Error("Credential must be a single line")

  const store = await loadPlatformCredentials().catch(() => empty())
  if (trimmed) {
    store.credentials[env] = trimmed
    process.env[env] = trimmed
  } else {
    delete store.credentials[env]
    delete process.env[env]
  }

  const target = platformCredentialStorePath()
  await mkdir(path.dirname(target), { recursive: true })
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`Platform credential store is not a real file: ${target}`)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(store, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
  return { env, configured: Boolean(trimmed) }
}
