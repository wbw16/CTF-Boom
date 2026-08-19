import { randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Server-side Relay secrets.  Operators may still supply both tokens through the environment;
 * when they do not, `boom relay serve` generates them on first start and keeps them in a 0600
 * file inside the data directory, so restarts and `boom relay tokens` see the same values.
 */

export type RelayServerTokens = {
  joinToken: string
  masterToken: string
  source: "environment" | "file" | "generated"
  file: string
}

type StoredRelayTokens = {
  version: 1
  joinToken: string
  masterToken: string
}

export function relayTokensFilePath(dataDirectory: string) {
  return path.join(path.resolve(dataDirectory), "relay-tokens.json")
}

export function generateRelayToken() {
  return randomBytes(32).toString("base64url")
}

function checkToken(token: string, name: string, label: string) {
  if (token.length < 16 || token.length > 512 || /[\s]/.test(token))
    throw new Error(`${label} ${name} must be 16-512 characters without whitespace`)
}

function checkPair(joinToken: string, masterToken: string, label: string) {
  checkToken(joinToken, "join token", label)
  checkToken(masterToken, "master token", label)
  if (joinToken === masterToken) throw new Error(`${label} join and master tokens must be different`)
}

function parseTokens(value: unknown, file: string): StoredRelayTokens {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Relay tokens file is invalid: ${file}`)
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 || typeof record.joinToken !== "string" || typeof record.masterToken !== "string"
  ) throw new Error(`Relay tokens file is invalid: ${file}`)
  return { version: 1, joinToken: record.joinToken, masterToken: record.masterToken }
}

/** Read previously stored tokens without creating anything.  Returns undefined when no file exists. */
export async function loadRelayTokens(dataDirectory: string) {
  const file = relayTokensFilePath(dataDirectory)
  const info = await lstat(file).catch(() => undefined)
  if (!info) return undefined
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Relay tokens file is not a real file: ${file}`)
  const stored = parseTokens(JSON.parse(await readFile(file, "utf8")), file)
  checkPair(stored.joinToken, stored.masterToken, "Relay tokens file")
  return { ...stored, file }
}

async function writeTokens(stored: StoredRelayTokens, file: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(stored, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/**
 * Pick the Relay secrets for `boom relay serve`:
 * - explicit environment variables win and are never written to disk (service-manager private env files);
 * - otherwise reuse the stored tokens file so the master and workers keep working across restarts;
 * - otherwise generate both tokens once and store them with 0600 permissions.
 */
export async function resolveRelayTokens(
  dataDirectory: string,
  environment: { [name: string]: string | undefined } = process.env,
): Promise<RelayServerTokens> {
  const file = relayTokensFilePath(dataDirectory)
  const joinToken = environment.BOOM_RELAY_JOIN_TOKEN
  const masterToken = environment.BOOM_RELAY_MASTER_TOKEN
  if (joinToken !== undefined || masterToken !== undefined) {
    if (!joinToken || !masterToken)
      throw new Error("Set both BOOM_RELAY_JOIN_TOKEN and BOOM_RELAY_MASTER_TOKEN, or neither to auto-generate them")
    checkPair(joinToken, masterToken, "Environment")
    return { joinToken, masterToken, source: "environment", file }
  }
  const stored = await loadRelayTokens(dataDirectory)
  if (stored) return { joinToken: stored.joinToken, masterToken: stored.masterToken, source: "file", file }
  const generated: StoredRelayTokens = { version: 1, joinToken: generateRelayToken(), masterToken: generateRelayToken() }
  checkPair(generated.joinToken, generated.masterToken, "Generated")
  await writeTokens(generated, file)
  return { joinToken: generated.joinToken, masterToken: generated.masterToken, source: "generated", file }
}
