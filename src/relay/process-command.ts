import path from "node:path"
import { loadRelayConfig, relayConfigPath, saveRelayConfig, type RelayLocalConfig } from "./config.ts"
import { RelayClient } from "./client.ts"
import { RelayMaster } from "./master.ts"
import { createRelayWorkerFromConfig } from "./worker.ts"

function option(argv: string[], name: string) {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function requireOption(argv: string[], name: string) {
  const value = option(argv, name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function numberOption(argv: string[], name: string, fallback: number, minimum: number, maximum: number) {
  const value = option(argv, name)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  return parsed
}

export function relayProcessUsage() {
  return [
    "Usage:",
    "  boom relay worker register --url <relay> --join-token <token> --id <id> --name <name> --root <dir>",
    "  boom relay worker run [--config <file>]",
    "  boom relay master sync --url <relay> --token <token> --root <dir>",
    "  boom relay master run --url <relay> --token <token> --root <dir>",
    "",
    "Worker register stores only the device token in Boom's private config; the join token is not persisted.",
    "The master process runs on the competition-connected host and is the only process allowed to submit flags.",
    "",
  ].join("\n")
}

async function workerRegister(argv: string[]) {
  const url = requireOption(argv, "--url")
  const joinToken = requireOption(argv, "--join-token")
  const id = requireOption(argv, "--id")
  const name = requireOption(argv, "--name")
  const root = path.resolve(requireOption(argv, "--root"))
  const role = option(argv, "--role") as "worker" | "master-worker" | undefined
  if (role !== undefined && role !== "worker" && role !== "master-worker") throw new Error("--role must be worker or master-worker")
  const maxSlots = numberOption(argv, "--slots", 5, 1, 5)
  const model = option(argv, "--model") ?? "free/deepseek-v4-flash-free"
  const pollMs = numberOption(argv, "--poll-ms", 15_000, 1_000, 300_000)
  const registered = await RelayClient.register({ url, joinToken, id, name, role: role ?? "worker", maxSlots })
  const config: RelayLocalConfig = {
    version: 1,
    relayURL: url,
    token: registered.token,
    deviceID: id,
    deviceName: name,
    role: role ?? "worker",
    maxSlots,
    root,
    model,
    pollMs,
  }
  await saveRelayConfig(config)
  process.stdout.write(`Boom Relay device ${id} registered; config ${relayConfigPath()}\n`)
}

async function workerRun(argv: string[]) {
  const configPath = option(argv, "--config")
  const config = await loadRelayConfig(configPath ? path.resolve(configPath) : undefined)
  if (!config) throw new Error("No Relay worker config; run `boom relay worker register` first")
  const worker = await createRelayWorkerFromConfig(config)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  process.stdout.write(`Boom Relay worker ${config.deviceID} polling ${config.relayURL}\n`)
  try {
    await worker.run(controller.signal)
  } finally {
    await worker.stop()
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

function masterClient(argv: string[]) {
  return RelayClient.master({ url: requireOption(argv, "--url"), token: requireOption(argv, "--token") })
}

async function masterRun(argv: string[], syncFirst: boolean) {
  const root = path.resolve(requireOption(argv, "--root"))
  const master = await RelayMaster.open({ relay: masterClient(argv), root })
  if (syncFirst) await master.syncPlatform()
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  process.stdout.write(`Boom Relay master connector polling\n`)
  try {
    await master.run(controller.signal)
  } finally {
    master.stop()
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

export async function relayProcessCommand(argv: string[]) {
  const [role, action, ...rest] = argv
  if (role === "worker" && action === "register") return workerRegister(rest)
  if (role === "worker" && action === "run") return workerRun(rest)
  if (role === "master" && action === "sync") return masterRun(rest, true)
  if (role === "master" && action === "run") return masterRun(rest, false)
  process.stderr.write(relayProcessUsage())
  process.exitCode = 1
}
