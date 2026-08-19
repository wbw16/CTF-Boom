import path from "node:path"
import { startRelayServer } from "./server.ts"
import { relayProcessCommand } from "./process-command.ts"

export type RelayServeOptions = {
  dataDirectory: string
  hostname: string
  port: number
  leaseMs?: number
}

export class RelayCommandError extends Error {}

export function relayUsage() {
  return [
    "Usage: boom relay serve --data <directory> [options]",
    "",
    "Run the standalone Boom Relay mailbox for distributed solving.",
    "",
    "Options:",
    "  --data <directory>       durable Relay SQLite and bundle directory (required)",
    "  --host <address>         bind address (default: 127.0.0.1)",
    "  --port <n>               bind port (default: 7332)",
    "  --lease-seconds <n>      worker lease duration, 60-3600 (default: 600)",
    "",
    "Required environment:",
    "  BOOM_RELAY_JOIN_TOKEN    enrollment secret for new workers (at least 16 characters)",
    "  BOOM_RELAY_MASTER_TOKEN  connector-only secret (at least 16 characters)",
    "",
    "Expose the Relay only behind an HTTPS reverse proxy. Do not put contest credentials on this host.",
    "",
  ].join("\n")
}

export function parseRelayServeArgs(argv: string[], cwd = process.cwd()): RelayServeOptions {
  let dataDirectory: string | undefined
  let hostname = "127.0.0.1"
  let port = 7332
  let leaseMs: number | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = () => {
      const next = argv[++index]
      if (!next) throw new RelayCommandError(`${option} requires a value`)
      return next
    }
    if (option === "--data") dataDirectory = path.resolve(cwd, value())
    else if (option === "--host") hostname = value()
    else if (option === "--port") {
      const candidate = Number(value())
      if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > 65_535)
        throw new RelayCommandError("--port must be an integer from 0 to 65535")
      port = candidate
    } else if (option === "--lease-seconds") {
      const candidate = Number(value())
      if (!Number.isSafeInteger(candidate) || candidate < 60 || candidate > 3_600)
        throw new RelayCommandError("--lease-seconds must be an integer from 60 to 3600")
      leaseMs = candidate * 1_000
    } else if (option === "-h" || option === "--help") throw new RelayCommandError("help")
    else throw new RelayCommandError(`Unknown Relay option: ${option}`)
  }
  if (!dataDirectory) throw new RelayCommandError("--data is required")
  if (!hostname || hostname.length > 253 || /[\0\r\n\s]/.test(hostname))
    throw new RelayCommandError("--host is invalid")
  return { dataDirectory, hostname, port, ...(leaseMs === undefined ? {} : { leaseMs }) }
}

export async function relayCommand(argv: string[]) {
  const [action, ...options] = argv
  if (action === "worker" || action === "master") return relayProcessCommand(argv)
  if (action !== "serve") {
    process.stderr.write(relayUsage())
    process.exitCode = action === "--help" || action === "-h" ? 0 : 1
    return
  }
  let parsed: RelayServeOptions
  try {
    parsed = parseRelayServeArgs(options)
  } catch (error) {
    if (!(error instanceof RelayCommandError)) throw error
    process.stderr.write(`${error.message === "help" ? "" : `${error.message}\n\n`}${relayUsage()}`)
    process.exitCode = error.message === "help" ? 0 : 1
    return
  }
  const joinToken = process.env.BOOM_RELAY_JOIN_TOKEN
  const masterToken = process.env.BOOM_RELAY_MASTER_TOKEN
  if (!joinToken || !masterToken) {
    process.stderr.write("Boom Relay requires BOOM_RELAY_JOIN_TOKEN and BOOM_RELAY_MASTER_TOKEN.\n")
    process.exitCode = 1
    return
  }
  const relay = await startRelayServer({ ...parsed, joinToken, masterToken })
  process.stdout.write(`Boom Relay listening on ${relay.url}\n`)
  let stopping: Promise<void> | undefined
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    stopping ??= relay.close().then(() => { process.exitCode = signal === "SIGINT" ? 130 : 143 })
  }
  const onInterrupt = () => stop("SIGINT")
  const onTerminate = () => stop("SIGTERM")
  process.once("SIGINT", onInterrupt)
  process.once("SIGTERM", onTerminate)
}
