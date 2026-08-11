import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { executeControlledShell } from "../src/command-executor.ts"
import { bindTaskEnvironment, loadTaskEnvironment, probePythonEnvironment } from "../src/environment.ts"
import { loadBoomToolRegistry } from "../src/runtime/tool-registry.ts"
import { createBoomToolHost } from "../src/tool-runtime.ts"

const RESOURCE_ROOT = path.join(import.meta.dir, "..", "resources")
const temporary: string[] = []

afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

function shellIsolationAvailable(): boolean {
  if (process.platform === "darwin") return !!Bun.which("sandbox-exec")
  if (process.platform === "linux") return !!(Bun.which("bwrap") ?? Bun.which("bubblewrap"))
  return false
}

async function fixture() {
  const interpreter = Bun.which("python3")
  if (!interpreter) return undefined
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-native-shell-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "challenge"))
  await mkdir(path.join(directory, "work"))
  await writeFile(path.join(directory, "challenge", "evidence.txt"), "immutable evidence\n")
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n")
  const profile = await probePythonEnvironment({ interpreter })
  if (profile.status !== "ready") return undefined
  await bindTaskEnvironment({ directory, profile, source: "task-override", executionMode: "managed" })
  return { directory, host: createBoomToolHost(await loadBoomToolRegistry(RESOURCE_ROOT)) }
}

describe("M3 native shell", () => {
  test("supports full Bash syntax, PATH tools, and task-local listening with a clean environment", async () => {
    if (!shellIsolationAvailable()) return
    const setup = await fixture()
    if (!setup) return
    const hostDirectory = await mkdtemp(path.join(os.homedir(), ".boom-shell-boundary-"))
    temporary.push(hostDirectory)
    const hostSecret = path.join(hostDirectory, "credential.txt")
    await writeFile(hostSecret, "host-home-marker\n")
    const quotedHostSecret = `'${hostSecret.replaceAll("'", "'\\''")}'`
    process.env.BOOM_TEST_HOST_SECRET = "must-not-enter-shell"
    try {
      const result = await setup.host.execute({
        name: "bash",
        arguments: {
          command: [
            "printf 'alpha\\nbeta\\n' | grep beta > work/pipeline.txt",
            "python -c \"import socket,threading; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); p=s.getsockname()[1]; threading.Thread(target=lambda: (lambda c: (c.send(b'ok'),c.close()))(s.accept()[0])).start(); c=socket.create_connection(('127.0.0.1',p)); print(c.recv(2).decode()); c.close(); s.close()\"",
            `if cat ${quotedHostSecret} >/dev/null 2>&1; then printf 'host-leak\\n'; else printf 'host-isolated\\n'; fi`,
            "printf '%s' \"${BOOM_TEST_HOST_SECRET-unset}\"",
          ].join("; "),
        },
        directory: setup.directory,
        profileID: "solver",
      })
      expect(result.metadata).toEqual(expect.objectContaining({ exitCode: 0, timedOut: false }))
      expect(result.output).toContain("ok")
      expect(result.output).toContain("host-isolated")
      expect(result.output).not.toContain("host-leak")
      expect(result.output).toContain("unset")
      expect(result.output).not.toContain("must-not-enter-shell")
      expect(await readFile(path.join(setup.directory, "work", "pipeline.txt"), "utf8")).toBe("beta\n")
    } finally {
      delete process.env.BOOM_TEST_HOST_SECRET
    }
  })

  test("keeps challenge and host-owned state read-only while work remains writable", async () => {
    if (!shellIsolationAvailable()) return
    const setup = await fixture()
    if (!setup) return
    const beforeBinding = await readFile(path.join(setup.directory, "work", ".boom", "environment.json"), "utf8")
    const result = await executeControlledShell({
      directory: setup.directory,
      request: {
        command: [
          "printf changed > challenge/evidence.txt 2>/dev/null || true",
          "printf changed > work/.boom/environment.json 2>/dev/null || true",
          "printf forged > work/RESULT.json 2>/dev/null || true",
          "printf allowed > work/allowed.txt",
        ].join("; "),
      },
    })
    expect(result.exitCode).toBe(0)
    expect(await readFile(path.join(setup.directory, "challenge", "evidence.txt"), "utf8")).toBe("immutable evidence\n")
    expect(await readFile(path.join(setup.directory, "work", ".boom", "environment.json"), "utf8")).toBe(beforeBinding)
    expect(await Bun.file(path.join(setup.directory, "work", "RESULT.json")).exists()).toBe(false)
    expect(await readFile(path.join(setup.directory, "work", "allowed.txt"), "utf8")).toBe("allowed")
    expect(await loadTaskEnvironment(setup.directory)).toBeDefined()
  })

  test("enforces timeout, output bounds, and process-group cancellation", async () => {
    if (!shellIsolationAvailable()) return
    const setup = await fixture()
    if (!setup) return
    const timed = await executeControlledShell({
      directory: setup.directory,
      request: { command: "sleep 60", timeout: 100 },
    })
    expect(timed.timedOut).toBe(true)

    const controller = new AbortController()
    const running = executeControlledShell({
      directory: setup.directory,
      request: { command: "sleep 60", timeout: 10_000 },
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 50)
    const cancelled = await running
    expect(cancelled.cancelled).toBe(true)

    const large = await executeControlledShell({
      directory: setup.directory,
      request: { command: "python -c \"print('x'*40000)\"" },
    })
    expect(large.truncated).toBe(true)
    expect(Buffer.byteLength(large.output)).toBeLessThan(34_000)
    expect(await Bun.file(path.join(setup.directory, large.logPath)).exists()).toBe(true)
  })
})
