import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Default endpoint for a fresh 西湖论剑 configuration. */
export const XIHULUNJIAN_DEFAULT_SERVER_HOST = "https://pro.dasctf.com"
/** @deprecated Use `loadXihulunjianServerHost()` so the saved endpoint is respected. */
export const XIHULUNJIAN_SERVER_HOST = XIHULUNJIAN_DEFAULT_SERVER_HOST
export const XIHULUNJIAN_ACCESS_KEY_ENV = "BOOM_XIHULUNJIAN_ACCESS_KEY"

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
export function normalizeXihulunjianServerHost(value: string) {
  const candidate = value.trim()
  if (!candidate) throw new Error("西湖论剑 Server Host 不能为空")
  if (candidate.length > MAX_SERVER_HOST_LENGTH || /[\0\r\n]/.test(candidate))
    throw new Error("西湖论剑 Server Host 必须是一行且不超过 2000 个字符")
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error("西湖论剑 Server Host 必须是有效的 HTTP(S) 地址")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("西湖论剑 Server Host 必须是不含凭据、查询参数或片段的 HTTP(S) 地址")
  return url.toString().replace(/\/+$/, "")
}

export function xihulunjianCredentialPath() {
  const home = path.resolve(process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"))
  return path.join(home, "xihulunjian.json")
}

function parse(value: unknown): CredentialFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty()
  const input = value as Record<string, unknown>
  if (input.version !== 1) return empty()
  const accessKey = typeof input.accessKey === "string" ? input.accessKey.trim() : undefined
  const serverHost = typeof input.serverHost === "string"
    ? (() => {
        try {
          return normalizeXihulunjianServerHost(input.serverHost)
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

async function readStoredCredential() {
  const target = xihulunjianCredentialPath()
  const info = await lstat(target).catch(() => undefined)
  if (!info) return empty()
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`西湖论剑凭证文件不是普通文件: ${target}`)
  try {
    return parse(JSON.parse(await readFile(target, "utf8")))
  } catch (error) {
    throw new Error(`无法读取西湖论剑凭证: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeStoredCredential(value: CredentialFile) {
  const target = xihulunjianCredentialPath()
  await mkdir(path.dirname(target), { recursive: true })
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`西湖论剑凭证文件不是普通文件: ${target}`)

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

/** Environment variables win, so a one-off explicit credential is never silently replaced. */
export async function loadXihulunjianAccessKey() {
  const exported = process.env[XIHULUNJIAN_ACCESS_KEY_ENV]?.trim()
  if (exported) return exported
  return (await readStoredCredential()).accessKey
}

export async function loadXihulunjianServerHost() {
  return (await readStoredCredential()).serverHost ?? XIHULUNJIAN_DEFAULT_SERVER_HOST
}

export async function xihulunjianCredentialStatus() {
  const [accessKey, serverHost] = await Promise.all([
    loadXihulunjianAccessKey(),
    loadXihulunjianServerHost(),
  ])
  return { configured: Boolean(accessKey), serverHost }
}

/**
 * Store the credential outside the challenge root with owner-only permissions. It is never exposed
 * through the API, copied into a task, or written into the synchronized challenge metadata.
 */
export async function saveXihulunjianAccessKey(value: string) {
  const accessKey = value.trim()
  if (accessKey.length > MAX_ACCESS_KEY_LENGTH)
    throw new Error(`AccessKey 不能超过 ${MAX_ACCESS_KEY_LENGTH} 个字符`)
  if (/[\0\r\n]/.test(accessKey)) throw new Error("AccessKey 必须是一行文本")

  const stored = await readStoredCredential()
  await writeStoredCredential({
    version: 1,
    ...(accessKey ? { accessKey } : {}),
    ...(stored.serverHost ? { serverHost: stored.serverHost } : {}),
  })

  if (accessKey) process.env[XIHULUNJIAN_ACCESS_KEY_ENV] = accessKey
  else delete process.env[XIHULUNJIAN_ACCESS_KEY_ENV]
  return { configured: Boolean(accessKey) }
}

/** Persist the public platform root beside the private credential, never in a challenge workspace. */
export async function saveXihulunjianServerHost(value: string) {
  const serverHost = normalizeXihulunjianServerHost(value)
  const stored = await readStoredCredential()
  await writeStoredCredential({
    version: 1,
    ...(stored.accessKey ? { accessKey: stored.accessKey } : {}),
    serverHost,
  })
  return { serverHost }
}
