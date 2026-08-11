import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type StoredProviderCredential =
  | {
      type: "api"
      key: string
      metadata?: Record<string, string>
    }
  | {
      type: "oauth"
      refresh: string
      access: string
      expires: number
      accountId?: string
      enterpriseUrl?: string
    }

type CredentialStore = {
  version: 2
  providers: Record<string, StoredProviderCredential>
}

export type ProviderCredential = {
  key: string
  style: "api-key" | "bearer"
}

export type CredentialImportResult = {
  source: string
  imported: Array<{ id: string; type: StoredProviderCredential["type"] }>
  skipped: number
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_SECRET = 65_536
const MAX_AUTH_FILE = 2 * 1024 * 1024
let mutationTail: Promise<void> = Promise.resolve()

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedSecret(value: unknown, allowEmpty = false) {
  return typeof value === "string" && (allowEmpty || value.length > 0) &&
      value.length <= MAX_SECRET && !value.includes("\0")
    ? value
    : undefined
}

function boundedText(value: unknown, maximum = 4_096) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0")
    ? value
    : undefined
}

function parseMetadata(value: unknown) {
  if (value === undefined) return undefined
  const input = object(value)
  if (!input) return undefined
  const entries = Object.entries(input)
  if (entries.length > 64) return undefined
  const metadata: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(key)) return undefined
    const text = boundedText(item, 4_096)
    if (!text) return undefined
    metadata[key] = text
  }
  return metadata
}

export function parseStoredProviderCredential(value: unknown): StoredProviderCredential | undefined {
  const input = object(value)
  if (!input) return undefined
  if (input.type === "api") {
    const key = boundedSecret(input.key)
    const metadata = parseMetadata(input.metadata)
    if (!key || (input.metadata !== undefined && !metadata)) return undefined
    return { type: "api", key, ...(metadata ? { metadata } : {}) }
  }
  if (input.type === "oauth") {
    const access = boundedSecret(input.access)
    const refresh = boundedSecret(input.refresh, true)
    const expires = input.expires
    const accountId = input.accountId === undefined ? undefined : boundedText(input.accountId)
    const enterpriseUrl = input.enterpriseUrl === undefined
      ? undefined
      : boundedText(input.enterpriseUrl, 2_048)
    if (
      !access || refresh === undefined || typeof expires !== "number" || !Number.isFinite(expires) ||
      expires < 0 || (input.accountId !== undefined && !accountId) ||
      (input.enterpriseUrl !== undefined && !enterpriseUrl)
    ) return undefined
    return {
      type: "oauth",
      refresh,
      access,
      expires,
      ...(accountId ? { accountId } : {}),
      ...(enterpriseUrl ? { enterpriseUrl } : {}),
    }
  }
  return undefined
}

function parse(value: unknown): CredentialStore {
  const input = object(value)
  if (input?.version === 1) {
    const raw = object(input.apiKeys)
    if (!raw) throw new Error("unsupported credential store format")
    const providers: Record<string, StoredProviderCredential> = {}
    for (const [id, key] of Object.entries(raw)) {
      const parsed = parseStoredProviderCredential({ type: "api", key })
      if (!PROVIDER_ID.test(id) || !parsed) throw new Error("invalid provider credential entry")
      providers[id] = parsed
    }
    return { version: 2, providers }
  }
  const raw = object(input?.providers)
  if (input?.version !== 2 || !raw) throw new Error("unsupported credential store format")
  const providers: Record<string, StoredProviderCredential> = {}
  for (const [id, value] of Object.entries(raw)) {
    const credential = parseStoredProviderCredential(value)
    if (!PROVIDER_ID.test(id) || !credential) throw new Error("invalid provider credential entry")
    providers[id] = credential
  }
  return { version: 2, providers }
}

function mutate(operation: () => Promise<void>) {
  const result = mutationTail.then(operation, operation)
  mutationTail = result.catch(() => {})
  return result
}

export function credentialStorePath() {
  const home = path.resolve(process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"))
  return path.join(home, "credentials.json")
}

export function openCodeCredentialPath(environment: NodeJS.ProcessEnv = process.env) {
  const dataHome = environment.XDG_DATA_HOME?.trim()
    ? path.resolve(environment.XDG_DATA_HOME)
    : path.join(os.homedir(), ".local", "share")
  return path.join(dataHome, "opencode", "auth.json")
}

async function assertCredentialDirectory(target: string) {
  const directory = path.dirname(target)
  const info = await lstat(directory).catch(() => undefined)
  if (info && (!info.isDirectory() || info.isSymbolicLink()))
    throw new Error(`Provider credential directory is not a real directory: ${directory}`)
  return directory
}

export async function loadCredentialStore(): Promise<CredentialStore> {
  const target = credentialStorePath()
  await assertCredentialDirectory(target)
  const info = await lstat(target).catch(() => undefined)
  if (!info) return { version: 2, providers: {} }
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Provider credential store is not a real file: ${target}`)
  try {
    return parse(JSON.parse(await readFile(target, "utf8")))
  } catch (error) {
    throw new Error(`Failed to read Boom Provider credentials: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function save(store: CredentialStore) {
  const normalized = parse(store)
  const target = credentialStorePath()
  const directory = await assertCredentialDirectory(target)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await assertCredentialDirectory(target)
  await chmod(directory, 0o700)
  const info = await lstat(target).catch(() => undefined)
  if (info && (!info.isFile() || info.isSymbolicLink()))
    throw new Error(`Provider credential store is not a real file: ${target}`)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function setStoredProviderCredential(providerID: string, value: StoredProviderCredential) {
  const credential = parseStoredProviderCredential(value)
  if (!PROVIDER_ID.test(providerID)) throw new Error(`Invalid Provider ID: ${providerID}`)
  if (!credential) throw new Error("Provider credential is invalid")
  await mutate(async () => {
    const store = await loadCredentialStore()
    store.providers[providerID] = credential
    await save(store)
  })
}

export async function setProviderAPIKey(providerID: string, value: string) {
  const key = value.trim()
  const credential = parseStoredProviderCredential({ type: "api", key })
  if (!credential) throw new Error("Provider API key is invalid")
  await setStoredProviderCredential(providerID, credential)
}

export async function removeProviderAPIKey(providerID: string) {
  await mutate(async () => {
    const store = await loadCredentialStore()
    if (!Object.hasOwn(store.providers, providerID))
      throw new Error(`Unknown provider credential: ${providerID}`)
    delete store.providers[providerID]
    await save(store)
  })
}

export async function hasProviderAPIKey(providerID: string) {
  const environment = providerCredentialEnvironment(providerID)
  return Boolean(process.env[environment]?.trim()) || Object.hasOwn((await loadCredentialStore()).providers, providerID)
}

export async function getProviderAPIKey(providerID: string) {
  const fromEnvironment = process.env[providerCredentialEnvironment(providerID)]?.trim()
  if (fromEnvironment) return fromEnvironment
  const credential = (await loadCredentialStore()).providers[providerID]
  return credential?.type === "api" ? credential.key : undefined
}

export async function boomOpenCodeAuthContent(providerIDs: Iterable<string> = []) {
  const providers = { ...(await loadCredentialStore()).providers }
  for (const id of providerIDs) {
    if (!PROVIDER_ID.test(id)) continue
    const key = process.env[providerCredentialEnvironment(id)]?.trim()
    if (key) providers[id] = { type: "api", key }
  }
  return JSON.stringify(providers)
}

async function readOpenCodeCredentials(target: string) {
  const info = await lstat(target).catch(() => undefined)
  if (!info)
    throw new Error(`OpenCode credentials were not found at ${target}`)
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`OpenCode credential source is not a real file: ${target}`)
  if (info.size > MAX_AUTH_FILE)
    throw new Error(`OpenCode credential source is too large: ${target}`)
  const input = object(JSON.parse(await readFile(target, "utf8")))
  if (!input) throw new Error(`OpenCode credential source is invalid: ${target}`)
  return input
}

export async function importOpenCodeCredentials(
  source = openCodeCredentialPath(),
): Promise<CredentialImportResult> {
  const raw = await readOpenCodeCredentials(source)
  const imported = Object.entries(raw).flatMap(([id, value]) => {
    const credential = parseStoredProviderCredential(value)
    return PROVIDER_ID.test(id) && credential ? [{ id, credential }] : []
  })
  await mutate(async () => {
    const store = await loadCredentialStore()
    for (const item of imported) store.providers[item.id] = item.credential
    await save(store)
  })
  return {
    source,
    imported: imported.map(({ id, credential }) => ({ id, type: credential.type })),
    skipped: Object.keys(raw).length - imported.length,
  }
}

export async function captureRuntimeProviderCredential(source: string, providerID: string) {
  const raw = await readOpenCodeCredentials(source)
  const credential = parseStoredProviderCredential(raw[providerID])
  if (!credential) throw new Error(`Boom Runtime did not persist a supported credential for ${providerID}`)
  await setStoredProviderCredential(providerID, credential)
  return credential.type
}

/** Boom credentials take precedence; compatibility credentials remain memory-only. */
export async function resolveProviderCredential(
  providerID: string,
  compatibility?: ProviderCredential,
): Promise<ProviderCredential | undefined> {
  const configured = await getProviderAPIKey(providerID)
  if (!configured) return compatibility
  return compatibility?.key === configured
    ? compatibility
    : { key: configured, style: "api-key" }
}

export function providerCredentialEnvironment(providerID: string) {
  if (!PROVIDER_ID.test(providerID)) throw new Error(`Invalid Provider ID: ${providerID}`)
  return `BOOM_${providerID.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`
}
