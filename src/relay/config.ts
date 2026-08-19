import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type RelayLocalConfig = {
  version: 1
  relayURL: string
  token: string
  deviceID: string
  deviceName: string
  role: "worker" | "master-worker"
  maxSlots: number
  root: string
  model: string
  pollMs: number
}

export function relayConfigPath(root = process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom")) {
  return path.join(path.resolve(root), "relay.json")
}

export async function loadRelayConfig(root?: string) {
  const target = root?.endsWith(".json") ? path.resolve(root) : relayConfigPath(root)
  const info = await lstat(target).catch(() => undefined)
  if (!info) return undefined
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Relay config is not a real file: ${target}`)
  const value = JSON.parse(await readFile(target, "utf8")) as Partial<RelayLocalConfig>
  if (
    value.version !== 1 || typeof value.relayURL !== "string" || typeof value.token !== "string" ||
    typeof value.deviceID !== "string" || typeof value.deviceName !== "string" ||
    (value.role !== "worker" && value.role !== "master-worker") ||
    typeof value.maxSlots !== "number" || typeof value.root !== "string" || typeof value.model !== "string" ||
    typeof value.pollMs !== "number"
  ) throw new Error(`Relay config is invalid: ${target}`)
  return value as RelayLocalConfig
}

export async function saveRelayConfig(config: RelayLocalConfig, root?: string) {
  const target = relayConfigPath(root)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(config, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return config
}
