import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const packageRoot = path.resolve(import.meta.dir, "..")
const manifest = (await Bun.file(path.join(packageRoot, "package.json")).json()) as {
  name: string
  version: string
}

type CommandOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
}

async function command(argv: string[], options: CommandOptions = {}) {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error([
      `Command failed (${exitCode}): ${argv.join(" ")}`,
      stdout.trim(),
      stderr.trim(),
    ].filter(Boolean).join("\n"))
  }
  return stdout
}

function assertIncludes(value: string, expected: string, subject: string) {
  if (!value.includes(expected)) throw new Error(`${subject} is missing ${expected}`)
}

const directory = await mkdtemp(path.join(os.tmpdir(), "boom-package-check-"))
const archiveDirectory = path.join(directory, "release")
const installRoot = path.join(directory, "install")
const boomHome = path.join(directory, "boom-home")

try {
  await command([process.execPath, "pm", "pack", "--destination", archiveDirectory, "--quiet"], {
    cwd: packageRoot,
  })
  const archives = (await readdir(archiveDirectory))
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => path.join(archiveDirectory, entry))
  if (archives.length !== 1) throw new Error(`Expected one package archive, found ${archives.length}`)
  const archive = archives[0]!

  const listing = await command(["tar", "-tzf", archive])
  assertIncludes(listing, "package/frontend/dist/index.html", "Package archive")
  assertIncludes(listing, "package/resources/runtime/agents/boom/agent.json", "Package archive")

  const environment = {
    ...process.env,
    BUN_INSTALL: installRoot,
    BOOM_HOME: boomHome,
    PATH: `${path.join(installRoot, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  }
  await command([process.execPath, "install", "--global", archive], { cwd: directory, env: environment })
  const executable = path.join(installRoot, "bin", process.platform === "win32" ? "boom.exe" : "boom")
  const version = await command([executable, "version"], { cwd: directory, env: environment })
  assertIncludes(version, manifest.version, "Installed Boom version")
  const doctor = await command([executable, "doctor"], { cwd: directory, env: environment })
  assertIncludes(doctor, "Execution runtime", "Installed Boom doctor report")
  assertIncludes(doctor, "Skill ctf-workflow", "Installed Boom doctor report")

  process.stdout.write(`Verified ${manifest.name}@${manifest.version} from a clean temporary installation.\n`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
