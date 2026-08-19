import path from "node:path"
import { startRelayServer } from "./server.ts"
import { relayProcessCommand } from "./process-command.ts"
import { loadRelayTokens, relayTokensFilePath, resolveRelayTokens } from "./tokens.ts"

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
    "       boom relay tokens --data <directory> [--json]",
    "",
    "Run the standalone Boom Relay mailbox for distributed solving.",
    "",
    "Options:",
    "  --data <directory>       durable Relay SQLite and bundle directory (required)",
    "  --host <address>         bind address (default: 127.0.0.1)",
    "  --port <n>               bind port (default: 7332)",
    "  --lease-seconds <n>      worker lease duration, 60-3600 (default: 600)",
    "",
    "Tokens:",
    "  Set BOOM_RELAY_JOIN_TOKEN and BOOM_RELAY_MASTER_TOKEN to choose both secrets, or leave",
    "  both unset to auto-generate them on first start into <data>/relay-tokens.json (0600).",
    "  Show the stored tokens with `boom relay tokens --data <directory>`.",
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

export function parseRelayTokensArgs(argv: string[], cwd = process.cwd()): { dataDirectory: string; json: boolean } {
  let dataDirectory: string | undefined
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = () => {
      const next = argv[++index]
      if (!next) throw new RelayCommandError(`${option} requires a value`)
      return next
    }
    if (option === "--data") dataDirectory = path.resolve(cwd, value())
    else if (option === "--json") json = true
    else if (option === "-h" || option === "--help") throw new RelayCommandError("help")
    else throw new RelayCommandError(`Unknown Relay tokens option: ${option}`)
  }
  if (!dataDirectory) throw new RelayCommandError("--data is required")
  return { dataDirectory, json }
}

async function relayTokensCommand(argv: string[]) {
  let parsed: { dataDirectory: string; json: boolean }
  try {
    parsed = parseRelayTokensArgs(argv)
  } catch (error) {
    if (!(error instanceof RelayCommandError)) throw error
    process.stderr.write(`${error.message === "help" ? "" : `${error.message}\n\n`}${relayUsage()}`)
    process.exitCode = error.message === "help" ? 0 : 1
    return
  }
  let stored: Awaited<ReturnType<typeof loadRelayTokens>>
  try {
    stored = await loadRelayTokens(parsed.dataDirectory)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return
  }
  if (!stored) {
    process.stderr.write(
      `No Relay tokens file at ${relayTokensFilePath(parsed.dataDirectory)}; tokens were supplied through ` +
        `environment variables and are not stored on disk.\n`,
    )
    process.exitCode = 1
    return
  }
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ joinToken: stored.joinToken, masterToken: stored.masterToken }, undefined, 2)}\n`)
    return
  }
  process.stdout.write(
    [
      `Relay tokens file: ${stored.file}`,
      `join token:   ${stored.joinToken}`,
      `master token: ${stored.masterToken}`,
      "",
    ].join("\n"),
  )
}

export async function relayCommand(argv: string[]) {
  const [action, ...options] = argv
  if (action === "worker" || action === "master") return relayProcessCommand(argv)
  if (action === "tokens") return relayTokensCommand(options)
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
  let tokens: Awaited<ReturnType<typeof resolveRelayTokens>>
  try {
    tokens = await resolveRelayTokens(parsed.dataDirectory)
  } catch (error) {
    if (!(error instanceof RelayCommandError) && !(error instanceof Error)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
    return
  }
  const relay = await startRelayServer({ ...parsed, joinToken: tokens.joinToken, masterToken: tokens.masterToken })
  process.stdout.write(`Boom Relay listening on ${relay.url}\n`)
  if (tokens.source === "generated")
    process.stdout.write(
      `Relay tokens generated at ${tokens.file} (mode 0600); run \`boom relay tokens --data <directory>\` to copy them.\n`,
    )
  let stopping: Promise<void> | undefined
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    stopping ??= relay.close().then(() => { process.exitCode = signal === "SIGINT" ? 130 : 143 })
  }
  const onInterrupt = () => stop("SIGINT")
  const onTerminate = () => stop("SIGTERM")
  process.once("SIGINT", onInterrupt)
  process.once("SIGTERM", onTerminate)
}
