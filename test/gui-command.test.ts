import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  GuiArgumentError,
  parseGuiArgs,
  startGuiLifecycle,
  type GuiCommandOptions,
  type GuiMode,
  type NativeClientProcess,
} from "../src/gui-command.ts"

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function options(mode: GuiMode): GuiCommandOptions {
  return {
    root: "/tmp/Boom GUI tests/ctf",
    port: 0,
    mode,
    help: false,
    network: "allow",
  }
}

describe("GUI command arguments", () => {
  test("selects the platform default mode and free port", () => {
    const cwd = path.join(path.sep, "tmp", "Boom GUI tests")

    expect(parseGuiArgs([], { cwd, platform: "darwin" })).toEqual({
      root: path.join(cwd, "ctf"),
      port: 0,
      mode: "native",
      help: false,
      network: "allow",
    })
    expect(parseGuiArgs([], { cwd, platform: "linux" })).toEqual({
      root: path.join(cwd, "ctf"),
      port: 0,
      mode: "browser",
      help: false,
      network: "allow",
    })
  })

  test("parses explicit modes, the headless alias, help, roots with spaces, and port boundaries", () => {
    const cwd = path.join(path.sep, "tmp", "Boom 工作区 with spaces")
    const cases: Array<{
      argv: string[]
      platform: NodeJS.Platform
      mode: GuiMode
      port?: number
      help?: boolean
      root?: string
    }> = [
      { argv: ["--native"], platform: "darwin", mode: "native" },
      { argv: ["--browser"], platform: "darwin", mode: "browser" },
      { argv: ["--headless"], platform: "darwin", mode: "headless" },
      { argv: ["--no-open"], platform: "linux", mode: "headless" },
      { argv: ["--headless", "--no-open"], platform: "linux", mode: "headless" },
      { argv: ["--browser", "--port", "65535"], platform: "linux", mode: "browser", port: 65_535 },
      {
        argv: ["--root", "题库 files", "--port", "0", "--help"],
        platform: "darwin",
        mode: "native",
        root: path.resolve(cwd, "题库 files"),
        help: true,
      },
    ]

    for (const item of cases) {
      const parsed = parseGuiArgs(item.argv, { cwd, platform: item.platform })
      expect(parsed).toEqual({
        root: item.root ?? path.join(cwd, "ctf"),
        port: item.port ?? 0,
        mode: item.mode,
        help: item.help ?? false,
        network: "allow",
      })
    }
  })

  test("rejects conflicting modes, unsupported native mode, unknown options, missing values, and bad ports", () => {
    const environment = { cwd: "/tmp", platform: "darwin" as const }
    for (const argv of [
      ["--native", "--browser"],
      ["--browser", "--headless"],
      ["--headless", "--native"],
    ]) {
      expect(() => parseGuiArgs(argv, environment)).toThrow("GUI modes are mutually exclusive")
    }

    expect(() => parseGuiArgs(["--native"], { ...environment, platform: "linux" })).toThrow(
      "requires macOS",
    )
    expect(() => parseGuiArgs(["--wat"], environment)).toThrow(GuiArgumentError)
    expect(() => parseGuiArgs(["--root"], environment)).toThrow("--root requires a value")
    expect(() => parseGuiArgs(["--port"], environment)).toThrow("--port requires a value")

    for (const port of ["-1", "65536", "1.5", "NaN"]) {
      expect(() => parseGuiArgs(["--port", port], environment)).toThrow(
        "GUI port must be an integer from 0 to 65535",
      )
    }
  })
})

describe("GUI command lifecycle", () => {
  test("closes the server when the native client exits", async () => {
    const childExit = deferred<number>()
    const serverCalls: Array<{
      root: string
      hostname: string
      port: number
      open: boolean
      network: "allow" | "deny"
    }> = []
    let closeCount = 0
    let terminateCount = 0
    let launchedURL: string | undefined
    const client: NativeClientProcess = {
      exited: childExit.promise,
      terminate() {
        terminateCount++
      },
    }

    const lifecycle = await startGuiLifecycle(options("native"), {
      startServer: async (input) => {
        serverCalls.push(input)
        return {
          url: "http://127.0.0.1:41001/",
          async close() {
            closeCount++
          },
        }
      },
      launchNative: async (url) => {
        launchedURL = url
        return client
      },
    })

    expect(serverCalls).toEqual([
      {
        root: "/tmp/Boom GUI tests/ctf",
        hostname: "127.0.0.1",
        port: 0,
        open: false,
        network: "allow",
      },
    ])
    expect(launchedURL).toBe("http://127.0.0.1:41001/")
    expect(lifecycle.mode).toBe("native")
    expect(lifecycle.url).toBe("http://127.0.0.1:41001/")
    expect(closeCount).toBe(0)

    childExit.resolve(17)
    expect(await lifecycle.done).toBe(17)
    expect(closeCount).toBe(1)
    expect(terminateCount).toBe(0)
  })

  test("shutdown racing native exit terminates the client and closes the server once", async () => {
    const childExit = deferred<number>()
    const closeGate = deferred<void>()
    let closeCount = 0
    let terminateCount = 0
    const lifecycle = await startGuiLifecycle(options("native"), {
      startServer: async () => ({
        url: "http://127.0.0.1:41002/",
        async close() {
          closeCount++
          await closeGate.promise
        },
      }),
      launchNative: async () => ({
        exited: childExit.promise,
        terminate() {
          terminateCount++
        },
      }),
    })

    const shutdown = lifecycle.shutdown()
    childExit.resolve(0)
    await Promise.resolve()
    expect(terminateCount).toBe(1)
    expect(closeCount).toBe(1)

    closeGate.resolve()
    await Promise.all([shutdown, lifecycle.done])
    expect(closeCount).toBe(1)
  })

  test("closes the server when launching the native client fails", async () => {
    let closeCount = 0
    let launchCount = 0
    const launchError = new Error("swift host failed to launch")

    const start = startGuiLifecycle(options("native"), {
      startServer: async () => ({
        url: "http://127.0.0.1:41003/",
        async close() {
          closeCount++
        },
      }),
      launchNative: async () => {
        launchCount++
        throw launchError
      },
    })

    await expect(start).rejects.toBe(launchError)
    expect(launchCount).toBe(1)
    expect(closeCount).toBe(1)
  })

  test("browser opens through the server while headless stays closed, and neither launches native", async () => {
    for (const [mode, expectedOpen] of [
      ["browser", true],
      ["headless", false],
    ] as const) {
      let closeCount = 0
      let launchCount = 0
      let serverOpen: boolean | undefined
      const lifecycle = await startGuiLifecycle(options(mode), {
        startServer: async (input) => {
          serverOpen = input.open
          return {
            url: `http://127.0.0.1:${mode === "browser" ? 41004 : 41005}/`,
            async close() {
              closeCount++
            },
          }
        },
        launchNative: async () => {
          launchCount++
          throw new Error("native launcher must not be used")
        },
      })

      expect(serverOpen).toBe(expectedOpen)
      expect(lifecycle.mode).toBe(mode)
      expect(lifecycle.done).toBeUndefined()
      expect(launchCount).toBe(0)
      expect(closeCount).toBe(0)

      await lifecycle.shutdown()
      expect(closeCount).toBe(1)
    }
  })
})
