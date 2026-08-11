import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  bindTaskEnvironment,
  controlledProcessEnvironment,
  detectContainerCapability,
  environmentPrompt,
  loadTaskEnvironment,
  probePythonEnvironment,
} from "../src/environment.ts"
import { executeControlledCommand } from "../src/command-executor.ts"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-environment-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "challenge"))
  await mkdir(path.join(directory, "work"))
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n")
  return directory
}

describe("task Python environments", () => {
  test("probes, binds, and routes python through the selected interpreter with a clean environment", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const profile = await probePythonEnvironment({ interpreter, displayName: "test python" })
    expect(profile.status).toBe("ready")
    const directory = await workspace()
    const binding = await bindTaskEnvironment({ directory, profile, source: "task-override" })
    expect((await loadTaskEnvironment(directory))?.fingerprint).toBe(profile.fingerprint)
    expect(environmentPrompt(binding)).toContain(binding.fingerprint)
    expect(environmentPrompt(binding)).toContain(`Python ${binding.pythonVersion}`)

    process.env.BOOM_TEST_PROVIDER_API_KEY = "must-not-leak"
    try {
      const result = await executeControlledCommand({
        directory,
        request: {
          program: "python",
          args: ["-c", "import os,sys; print(sys.executable); print(os.getenv('BOOM_TEST_PROVIDER_API_KEY'))"],
        },
      })
      expect(result.exitCode).toBe(0)
      expect(result.interpreter).toBe(binding.interpreter)
      expect(await realpath(result.output.split("\n", 1)[0]!)).toBe(await realpath(binding.interpreter))
      expect(result.output).toContain("None")
      expect(result.output).not.toContain("must-not-leak")
    } finally {
      delete process.env.BOOM_TEST_PROVIDER_API_KEY
    }
  })

  test("kills the managed command process group when a task is cancelled", async () => {
    if (process.platform === "win32") return
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const directory = await workspace()
    const profile = await probePythonEnvironment({ interpreter })
    await bindTaskEnvironment({ directory, profile, source: "task-override" })
    const controller = new AbortController()
    const running = executeControlledCommand({
      directory,
      signal: controller.signal,
      request: {
        program: "python",
        cwd: "work",
        args: ["-c", "import pathlib,subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); pathlib.Path('child.pid').write_text(str(p.pid)); time.sleep(60)"],
        timeoutMs: 10_000,
      },
    })
    const childFile = path.join(directory, "work", "child.pid")
    let childPID: number | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      childPID = await Bun.file(childFile).text().then(Number).catch(() => undefined)
      if (childPID) break
      await Bun.sleep(10)
    }
    expect(childPID).toBeNumber()
    controller.abort()
    const result = await running
    expect(result.cancelled).toBe(true)
    for (let attempt = 0; attempt < 100 && childPID; attempt += 1) {
      try {
        process.kill(childPID, 0)
        await Bun.sleep(10)
      } catch {
        childPID = undefined
      }
    }
    expect(childPID).toBeUndefined()
  })

  test("does not downgrade isolated execution when no container runtime is ready", async () => {
    const capability = await detectContainerCapability()
    if (capability.status === "ready") return
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const directory = await workspace()
    const profile = await probePythonEnvironment({ interpreter })
    await bindTaskEnvironment({ directory, profile, source: "task-override" })
    await expect(executeControlledCommand({
      directory,
      request: { program: "python", args: ["-c", "print(1)"], mode: "isolated" },
    })).rejects.toThrow("Isolated execution is unavailable")
  })

  test("keeps caches private and rejects package installs and path escapes", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const profile = await probePythonEnvironment({ interpreter })
    const directory = await workspace()
    const binding = await bindTaskEnvironment({ directory, profile, source: "task-override" })
    const env = await controlledProcessEnvironment(directory, binding)
    const canonical = await realpath(directory)
    expect(env.HOME).toStartWith(path.join(canonical, "work", ".sandbox"))
    expect(env.PIP_CACHE_DIR).toStartWith(path.join(canonical, "work", ".sandbox"))
    expect(env.PYTHONPATH).toBeUndefined()
    await expect(executeControlledCommand({ directory, request: { program: "pip", args: ["install", "x"] } })).rejects.toThrow("purpose=install")
    await expect(executeControlledCommand({ directory, request: { program: "python", cwd: "../" } })).rejects.toThrow("escapes the workspace")
  })
})
