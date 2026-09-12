import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { boomHomeDirectory } from "../boom-home.ts"

/**
 * Per-adapter credential store. Credentials live under `$BOOM_HOME/platforms/<id>.json` with
 * owner-only permissions, outside every challenge root; environment variables win over the file so
 * a one-off explicit credential is never silently replaced.
 *
 * A renamed adapter declares its previous env vars and file names as legacy sources, so an existing
 * machine keeps working without a manual migration; writes always go to the current file.
 */

export type PlatformCredentialSpec = {
  id: string
  /** Display name used in validation and error messages. */
  label: string
  accessKeyEnvVar: string
  /** Earlier env var names still honored when the current one is unset. */
  legacyAccessKeyEnvVars?: string[]
  credentialFileName: string
  /** Earlier file names (relative to `$BOOM_HOME`) still honored when the current file is absent. */
  legacyCredentialFileNames?: string[]
  defaultServerHost: string
}

type CredentialFile = {
  version: 1
  accessKey?: string
  serverHost?: string
}

const MAX_ACCESS_KEY_LENGTH = 4_096
const MAX_SERVER_HOST_LENGTH = 2_000

function empty(): CredentialFile {
  return { version: 1 }
}

/** A platform root may include a deployment prefix, but cannot carry credentials or a query. */
export function normalizePlatformServerHost(label: string, value: string) {
  const candidate = value.trim()
  if (!candidate) throw new Error(`${label} Server Host 不能为空`)
  if (candidate.length > MAX_SERVER_HOST_LENGTH || /[\0\r\n]/.test(candidate))
    throw new Error(`${label} Server Host 必须是一行且不超过 2000 个字符`)
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`${label} Server Host 必须是有效的 HTTP(S) 地址`)
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error(`${label} Server Host 必须是不含凭据、查询参数或片段的 HTTP(S) 地址`)
  return url.toString().replace(/\/+$/, "")
}

export function platformCredentialPath(fileName: string) {
  const home = boomHomeDirectory()
  return path.join(home, "platforms", fileName)
}

function legacyCredentialPath(fileName: string) {
  const home = boomHomeDirectory()
  return path.join(home, fileName)
}

function parse(value: unknown, label: string): CredentialFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty()
  const input = value as Record<string, unknown>
  if (input.version !== 1) return empty()
  const accessKey = typeof input.accessKey === "string" ? input.accessKey.trim() : undefined
  const serverHost = typeof input.serverHost === "string"
    ? (() => {
        try {
          return normalizePlatformServerHost(label, input.serverHost)
        } catch {
          return undefined
        }
      })()
    : undefined
  return {
    version: 1,
    ...(accessKey && accessKey.length <= MAX_ACCESS_KEY_LENGTH ? { accessKey } : {}),
    ...(serverHost ? { serverHost } : {}),
  }
}

async function readCredentialFile(target: string, label: string): Promise<CredentialFile | undefined> {
  const info = await lstat(target).catch(() => undefined)
  if (!info) return undefined
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`${label}凭证文件不是普通文件: ${target}`)
  try {
    return parse(JSON.parse(await readFile(target, "utf8")), label)
  } catch (error) {
    throw new Error(`无法读取${label}凭证: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The effective stored credential: the current file, else the first legacy file that exists. */
async function readStoredCredential(spec: PlatformCredentialSpec) {
  const current = await readCredentialFile(platformCredentialPath(spec.credentialFileName), spec.label)
  if (current) return current
  for (const name of spec.legacyCredentialFileNames ?? []) {
    const legacy = await readCredentialFile(legacyCredentialPath(name), spec.label)
    if (legacy) return legacy
  }
  return undefined
}

async function writeStoredCredential(spec: PlatformCredentialSpec, value: CredentialFile) {
  const target = platformCredentialPath(spec.credentialFileName)
  await mkdir(path.dirname(target), { recursive: true })
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`${spec.label}凭证文件不是普通文件: ${target}`)

  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(value, undefined, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export type PlatformCredentials = ReturnType<typeof platformCredentials>

export function platformCredentials(spec: PlatformCredentialSpec) {
  /** Environment variables win, so a one-off explicit credential is never silently replaced. */
  async function loadAccessKey() {
    for (const name of [spec.accessKeyEnvVar, ...(spec.legacyAccessKeyEnvVars ?? [])]) {
      const exported = process.env[name]?.trim()
      if (exported) return exported
    }
    return (await readStoredCredential(spec))?.accessKey
  }

  async function loadServerHost() {
    return (await readStoredCredential(spec))?.serverHost ?? spec.defaultServerHost
  }

  return {
    spec,

    /**
     * Store the credential outside the challenge root with owner-only permissions. It is never
     * exposed through the API, copied into a task, or written into synchronized challenge metadata.
     */
    async saveAccessKey(value: string) {
      const accessKey = value.trim()
      if (accessKey.length > MAX_ACCESS_KEY_LENGTH)
        throw new Error(`AccessKey 不能超过 ${MAX_ACCESS_KEY_LENGTH} 个字符`)
      if (/[\0\r\n]/.test(accessKey)) throw new Error("AccessKey 必须是一行文本")

      const stored = (await readStoredCredential(spec)) ?? empty()
      await writeStoredCredential(spec, {
        version: 1,
        ...(accessKey ? { accessKey } : {}),
        ...(stored.serverHost ? { serverHost: stored.serverHost } : {}),
      })

      if (accessKey) process.env[spec.accessKeyEnvVar] = accessKey
      else delete process.env[spec.accessKeyEnvVar]
      return { configured: Boolean(accessKey) }
    },

    /** Persist the public platform root beside the private credential, never in a challenge workspace. */
    async saveServerHost(value: string) {
      const serverHost = normalizePlatformServerHost(spec.label, value)
      const stored = (await readStoredCredential(spec)) ?? empty()
      await writeStoredCredential(spec, {
        version: 1,
        ...(stored.accessKey ? { accessKey: stored.accessKey } : {}),
        serverHost,
      })
      return { serverHost }
    },

    loadAccessKey,
    loadServerHost,

    async status() {
      const [accessKey, serverHost] = await Promise.all([loadAccessKey(), loadServerHost()])
      return { configured: Boolean(accessKey), serverHost }
    },
  }
}
