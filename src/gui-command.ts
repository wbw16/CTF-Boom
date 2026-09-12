import path from "node:path"
import { startGuiServer } from "./gui.ts"

export type GuiMode = "native" | "browser" | "headless"

export type GuiCommandOptions = {
  /**
   * Explicit workspace root from `--root`. Absent means "reopen the remembered root" (or Boom's
   * first-run default) — the launch directory is never treated as a workspace, because preparing
   * one would create runs/ and challenges/ inside whatever folder Boom happened to start from.
   */
  root?: string
  port: number
  mode: GuiMode
  help: boolean
  /** Host-wide network switch; "deny" isolates bash/boom-exec and refuses web tools. */
  network: "allow" | "deny"
}

export type NativeClientProcess = {
  exited: Promise<number>
  terminate(): void
}

type GuiServer = {
  url: string
  close(): Promise<void>
}

export type GuiLifecycle = {
  mode: GuiMode
  url: string
  done?: Promise<number>
  shutdown(): Promise<void>
}

export class GuiArgumentError extends Error {}

function setMode(current: GuiMode | undefined, next: GuiMode) {
  if (current !== undefined && current !== next)
    throw new GuiArgumentError(`GUI modes are mutually exclusive: ${current} and ${next}`)
  return next
}

export function parseGuiArgs(
  argv: string[],
  environment: { cwd?: string; platform?: NodeJS.Platform } = {},
): GuiCommandOptions {
  const cwd = environment.cwd ?? process.cwd()
  const platform = environment.platform ?? process.platform
  let root: string | undefined
  let port = 0
  let explicitMode: GuiMode | undefined
  let help = false
  let network: "allow" | "deny" = "allow"

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const value = () => {
      const next = argv[++index]
      if (next === undefined) throw new GuiArgumentError(`${arg} requires a value`)
      return next
    }
    if (arg === "--root") root = path.resolve(cwd, value())
    else if (arg === "--port") port = Number(value())
    else if (arg === "--native") explicitMode = setMode(explicitMode, "native")
    else if (arg === "--browser") explicitMode = setMode(explicitMode, "browser")
    else if (arg === "--headless" || arg === "--no-open")
      explicitMode = setMode(explicitMode, "headless")
    else if (arg === "--no-network") network = "deny"
    else if (arg === "-h" || arg === "--help") help = true
    else throw new GuiArgumentError(`Unknown GUI option: ${arg}`)
  }

  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new GuiArgumentError(`GUI port must be an integer from 0 to 65535, got: ${port}`)
  const mode = explicitMode ?? (platform === "darwin" ? "native" : "browser")
  if (mode === "native" && platform !== "darwin")
    throw new GuiArgumentError("The Boom native client currently requires macOS; use --browser or --headless")
  return { root, port, mode, help, network }
}

export async function startGuiLifecycle(
  options: GuiCommandOptions,
  dependencies: {
    startServer?: (options: {
      root?: string
      hostname: string
      port: number
      open: boolean
      network: "allow" | "deny"
    }) => Promise<GuiServer>
    launchNative?: (url: string) => Promise<NativeClientProcess>
  } = {},
): Promise<GuiLifecycle> {
  const startServer = dependencies.startServer ?? startGuiServer
  const server = await startServer({
    hostname: "127.0.0.1",
    port: options.port,
    open: options.mode === "browser",
    network: options.network,
    ...(options.root !== undefined ? { root: options.root } : {}),
  })
  let client: NativeClientProcess | undefined
  let closePromise: Promise<void> | undefined
  const closeServer = () => (closePromise ??= Promise.resolve(server.close()))

  try {
    if (options.mode === "native") {
      if (!dependencies.launchNative) throw new Error("Boom native client launcher is unavailable")
      client = await dependencies.launchNative(server.url)
    }
  } catch (error) {
    await closeServer()
    throw error
  }

  const done = client
    ? client.exited.then(
        async (code) => {
          await closeServer()
          return code
        },
        async (error) => {
          await closeServer()
          throw error
        },
      )
    : undefined

  return {
    mode: options.mode,
    url: server.url,
    done,
    async shutdown() {
      client?.terminate()
      await closeServer()
    },
  }
}
