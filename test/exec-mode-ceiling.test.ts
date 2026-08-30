import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import BoomExecPlugin from "../resources/plugin/boom-exec.ts"
import { executeControlledCommand } from "../src/command-executor.ts"
import { bindTaskEnvironment, detectContainerCapability, probePythonEnvironment } from "../src/environment.ts"
import { loadBoomToolRegistry } from "../src/runtime/tool-registry.ts"
import { createBoomToolHost } from "../src/tool-runtime.ts"

const RESOURCE_ROOT = path.join(import.meta.dir, "..", "resources")
const CEILING = "Execution mode ceiling violated"
const temporary: string[] = []

afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

function hostSandboxAvailable(): boolean {
  if (process.platform === "darwin") return !!Bun.which("sandbox-exec")
  if (process.platform === "linux") return !!(Bun.which("bwrap") ?? Bun.which("bubblewrap"))
  return false
}

let spawnHealth: Promise<boolean> | undefined
/**
 * Some macOS hosts intermittently kill child processes spawned by test runners (even plain
 * `/bin/echo` exits 1 with no output), which is unrelated to Boom. Real-execution assertions are
 * gated on this probe so the suite stays deterministic; guard logic itself needs no processes.
 */
function childSpawnsWork(): Promise<boolean> {
  spawnHealth ??= (async () => {
    try {
      const child = Bun.spawn(["/bin/echo", "probe"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => child.kill(), 5_000)
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
      clearTimeout(timer)
      return code === 0 && output.trim() === "probe"
    } catch {
      return false
    }
  })()
  return spawnHealth
}

/** Task workspace bound through the production path; needs a probeable python3 like the other suites. */
async function boundWorkspace(executionMode: "managed" | "isolated" | "static-only") {
  const interpreter = Bun.which("python3")
  if (!interpreter) return undefined
  const profile = await probePythonEnvironment({ interpreter })
  if (profile.status !== "ready") return undefined
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-mode-ceiling-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "challenge"))
  await mkdir(path.join(directory, "work"))
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n\nshared memory\n")
  await bindTaskEnvironment({ directory, profile, source: "task-override", executionMode })
  return directory
}

/** The legacy plugin validates fewer binding fields than src, so its fixture writes the JSON directly. */
async function pluginWorkspace(executionMode: "managed" | "isolated" | "static-only") {
  // The plugin compares cwd against realpath(ctx.directory); on macOS os.tmpdir() is a symlink, so
  // hand it the canonical path.
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "boom-plugin-ceiling-")))
  temporary.push(directory)
  await mkdir(path.join(directory, "challenge"))
  await mkdir(path.join(directory, "work", ".boom"), { recursive: true })
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n\nshared memory\n")
  await writeFile(
    path.join(directory, "work", ".boom", "environment.json"),
    JSON.stringify({
      displayName: "ceiling-fixture",
      kind: "python",
      interpreter: "/usr/bin/python3",
      pythonVersion: "3.11.0",
      installPolicy: "deny",
      fingerprint: "ceiling-fixture-fingerprint",
      executionMode,
    }),
  )
  return directory
}

type BoomExecToolExecute = (
  args: Record<string, unknown>,
  context: { directory: string; abort: AbortSignal },
) => Promise<{ title: string; output: string; metadata: Record<string, unknown> }>

async function pluginBoomExec(): Promise<BoomExecToolExecute> {
  const hooks = (await BoomExecPlugin({ directory: os.tmpdir() } as never)) as unknown as {
    tool: Record<string, { execute: BoomExecToolExecute }>
  }
  const execute = hooks.tool["boom-exec"]?.execute
  if (!execute) throw new Error("boom-exec plugin did not expose its tool")
  return execute
}

describe("H2 execution-mode ceiling in the command executor", () => {
  test("(a) rejects managed requests under an isolated binding", async () => {
    const directory = await boundWorkspace("isolated")
    if (!directory) return
    await expect(executeControlledCommand({
      directory,
      request: { program: "python", args: ["-c", "print('downgraded')"], mode: "managed" },
    })).rejects.toThrow(new RegExp(`${CEILING}: task binding is isolated, requested mode is managed`))
  })

  test("(b) rejects isolated and managed requests under a static-only binding", async () => {
    const directory = await boundWorkspace("static-only")
    if (!directory) return
    await expect(executeControlledCommand({
      directory,
      request: { program: "ls", mode: "isolated" },
    })).rejects.toThrow(new RegExp(`${CEILING}: task binding is static-only, requested mode is isolated`))
    await expect(executeControlledCommand({
      directory,
      request: { program: "python", args: ["-c", "print('downgraded')"], mode: "managed" },
    })).rejects.toThrow(new RegExp(`${CEILING}: task binding is static-only, requested mode is managed`))
  })

  test("(c) falls back to the bound static-only mode and executes when no mode is passed", async () => {
    if (!hostSandboxAvailable() || !(await childSpawnsWork())) return
    const directory = await boundWorkspace("static-only")
    if (!directory) return
    const result = await executeControlledCommand({
      directory,
      request: { program: "head", args: ["-n", "1", "NOTES.md"] },
    })
    expect(result.mode).toBe("static-only")
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("# NOTES")
  })

  test("(c) picks the static-only allowlist without a requested mode even when spawning is unavailable", async () => {
    const directory = await boundWorkspace("static-only")
    if (!directory) return
    // "7z" is in the static allowlist; under static-only the failure is "not installed", while a
    // managed downgrade would fail earlier with an allowlist error instead.
    const outcome = await executeControlledCommand({
      directory,
      request: { program: "7z", args: ["x", "archive.7z"] },
    }).then(
      (result) => ({ ran: true as const, mode: result.mode }),
      (error: unknown) => ({ ran: false as const, message: String(error instanceof Error ? error.message : error) }),
    )
    if (outcome.ran) expect(outcome.mode).toBe("static-only")
    else expect(outcome.message).toContain("Allowed program is not installed: 7z")
  })

  test("(d) lets managed bindings accept stronger isolated requests", async () => {
    const directory = await boundWorkspace("managed")
    if (!directory) return
    const capability = await detectContainerCapability()
    if (capability.status !== "ready") {
      // Reaching the isolated branch's own availability error proves the ceiling did not reject.
      await expect(executeControlledCommand({
        directory,
        request: { program: "ls", args: ["."], mode: "isolated" },
      })).rejects.toThrow("Isolated execution is unavailable")
      return
    }
    // With a real container runtime we avoid touching images; any pipeline failure that is not the
    // ceiling error proves the upgrade was accepted past the guard.
    const failure = await executeControlledCommand({
      directory,
      request: { program: "ls", mode: "isolated", cwd: "work/missing-directory" },
    }).then(
      () => undefined,
      (error: unknown) => String(error instanceof Error ? error.message : error),
    )
    expect(failure).toBeDefined()
    expect(failure!).not.toContain(CEILING)
  })
})

describe("H2 execution-mode ceiling in the Boom tool host", () => {
  test("rejects boom-exec requests that rank below the bound mode", async () => {
    for (const [bindingMode, requested] of [
      ["isolated", "managed"],
      ["static-only", "isolated"],
      ["static-only", "managed"],
    ] as const) {
      const directory = await boundWorkspace(bindingMode)
      if (!directory) return
      const host = createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT))
      await expect(host.execute({
        name: "boom-exec",
        arguments: { program: "python", args: ["-c", "print('x')"], mode: requested },
        directory,
        profileID: "solver",
      })).rejects.toThrow(new RegExp(`${CEILING}: task binding is ${bindingMode}, requested mode is ${requested}`))
    }
  })

  test("keeps the no-mode fallback on static-only tasks working end to end", async () => {
    if (!hostSandboxAvailable() || !(await childSpawnsWork())) return
    const directory = await boundWorkspace("static-only")
    if (!directory) return
    const host = createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT))
    const result = await host.execute({
      name: "boom-exec",
      arguments: { program: "head", args: ["-n", "1", "NOTES.md"] },
      directory,
      profileID: "solver",
    })
    expect(result.metadata).toEqual(expect.objectContaining({ exitCode: 0, mode: "static-only" }))
    expect(result.output).toContain("# NOTES")
  })
})

describe("H2 execution-mode ceiling in the legacy boom-exec plugin", () => {
  test("(a,b) rejects requests below the bound mode before resolving programs", async () => {
    const execute = await pluginBoomExec()
    for (const [bindingMode, requested] of [
      ["isolated", "managed"],
      ["static-only", "isolated"],
      ["static-only", "managed"],
    ] as const) {
      const directory = await pluginWorkspace(bindingMode)
      await expect(execute(
        { program: "ls", mode: requested },
        { directory, abort: new AbortController().signal },
      )).rejects.toThrow(new RegExp(`${CEILING}: task binding is ${bindingMode}, requested mode is ${requested}`))
    }
  })

  test("(c) resolves no-mode requests against the static-only allowlist", async () => {
    const execute = await pluginBoomExec()
    const directory = await pluginWorkspace("static-only")
    // "7z" is static-allowlisted but not installed: under the correct static-only fallback this
    // fails with "not installed"; a managed downgrade would fail the managed allowlist instead.
    await expect(execute(
      { program: "7z", args: ["x", "archive.7z"] },
      { directory, abort: new AbortController().signal },
    )).rejects.toThrow("Allowed program is not installed: 7z")
  })

  test("(c) executes static-only commands end to end when the host spawns children reliably", async () => {
    if (!(await childSpawnsWork())) return
    if (process.platform === "darwin" && !Bun.which("sandbox-exec")) return
    const execute = await pluginBoomExec()
    const directory = await pluginWorkspace("static-only")
    const result = await execute(
      { program: "head", args: ["-n", "1", "NOTES.md"] },
      { directory, abort: new AbortController().signal },
    )
    expect(result.metadata).toEqual(expect.objectContaining({ exitCode: 0, mode: "static-only" }))
    expect(result.output).toContain("# NOTES")
  })

  test("(d) lets managed bindings accept stronger isolated requests", async () => {
    const capability = await detectContainerCapability()
    if (capability.status === "ready") return
    const execute = await pluginBoomExec()
    const directory = await pluginWorkspace("managed")
    await expect(execute(
      { program: "ls", mode: "isolated" },
      { directory, abort: new AbortController().signal },
    )).rejects.toThrow("isolated execution unavailable; Docker/Podman is missing")
  })
})
