import { createHash } from "node:crypto"
import { access, chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type PythonEnvironmentKind = "conda" | "python"
export type InstallPolicy = "deny" | "allow"
export type ExecutionMode = "managed" | "isolated" | "static-only"

export type PythonEnvironmentProfile = {
  id: string
  displayName: string
  kind: PythonEnvironmentKind
  interpreter: string
  prefix?: string
  pythonVersion: string
  architecture: string
  packages: Record<string, string | undefined>
  installPolicy: InstallPolicy
  fingerprint: string
  status: "ready" | "missing" | "invalid"
  detail?: string
}

export type TaskEnvironmentBinding = {
  profileId: string
  displayName: string
  kind: PythonEnvironmentKind
  interpreter: string
  prefix?: string
  pythonVersion: string
  architecture: string
  packages: Record<string, string | undefined>
  installPolicy: InstallPolicy
  fingerprint: string
  source: "default" | "task-override"
  executionMode: ExecutionMode
  boundAt: string
}

export type EnvironmentStore = {
  version: 1
  defaultProfileId?: string
  profiles: PythonEnvironmentProfile[]
}

export type ContainerCapability = {
  runtime?: "docker" | "podman"
  executable?: string
  status: "ready" | "missing" | "invalid"
  detail?: string
}

const IMPORTANT_PACKAGES = [
  "pwntools",
  "angr",
  "z3",
  "Crypto",
  "scapy",
  "capstone",
] as const

const PROBE = `
import importlib.metadata, importlib.util, json, platform, sys
packages = {}
for name in ${JSON.stringify(IMPORTANT_PACKAGES)}:
    try:
        packages[name] = importlib.metadata.version("pycryptodome" if name == "Crypto" else name)
    except Exception:
        packages[name] = None if importlib.util.find_spec(name) is None else "installed"
print(json.dumps({
    "version": platform.python_version(),
    "architecture": platform.machine() or platform.architecture()[0],
    "executable": sys.executable,
    "prefix": sys.prefix,
    "packages": packages,
}, sort_keys=True))
`

function boomHome() {
  return path.resolve(process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"))
}

function storePath() {
  return path.join(boomHome(), "environments.json")
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function safeID(value: string) {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return normalized || `python-${crypto.randomUUID().slice(0, 8)}`
}

function cleanDiscoveryEnvironment() {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
  }
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  if (process.env.WINDIR) env.WINDIR = process.env.WINDIR
  return env
}

async function capture(command: string[], timeout = 10_000) {
  const child = Bun.spawn(command, {
    env: cleanDiscoveryEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), timeout)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { status, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function fingerprint(input: {
  interpreter: string
  pythonVersion: string
  architecture: string
  packages: Record<string, string | undefined>
}) {
  return createHash("sha256")
    .update(JSON.stringify(input, Object.keys(input).sort()))
    .digest("hex")
}

function parseProfile(value: unknown): PythonEnvironmentProfile | undefined {
  const input = object(value)
  const packages = object(input?.packages)
  if (
    !input ||
    typeof input.id !== "string" ||
    typeof input.displayName !== "string" ||
    (input.kind !== "conda" && input.kind !== "python") ||
    typeof input.interpreter !== "string" ||
    typeof input.pythonVersion !== "string" ||
    typeof input.architecture !== "string" ||
    (input.installPolicy !== "deny" && input.installPolicy !== "allow") ||
    typeof input.fingerprint !== "string" ||
    !["ready", "missing", "invalid"].includes(String(input.status))
  ) return undefined
  return {
    id: input.id,
    displayName: input.displayName,
    kind: input.kind,
    interpreter: input.interpreter,
    ...(typeof input.prefix === "string" ? { prefix: input.prefix } : {}),
    pythonVersion: input.pythonVersion,
    architecture: input.architecture,
    packages: Object.fromEntries(
      Object.entries(packages ?? {}).flatMap(([name, version]) =>
        typeof version === "string" || version === undefined ? [[name, version]] : [],
      ),
    ),
    installPolicy: input.installPolicy,
    fingerprint: input.fingerprint,
    status: input.status as PythonEnvironmentProfile["status"],
    ...(typeof input.detail === "string" ? { detail: input.detail } : {}),
  }
}

export async function loadEnvironmentStore(): Promise<EnvironmentStore> {
  const raw = await readFile(storePath(), "utf8").catch(() => undefined)
  if (!raw) return { version: 1, profiles: [] }
  try {
    const input = object(JSON.parse(raw))
    const profiles = Array.isArray(input?.profiles)
      ? input.profiles.flatMap((item) => parseProfile(item) ?? [])
      : []
    return {
      version: 1,
      ...(typeof input?.defaultProfileId === "string"
        ? { defaultProfileId: input.defaultProfileId }
        : {}),
      profiles,
    }
  } catch {
    return { version: 1, profiles: [] }
  }
}

export async function saveEnvironmentStore(store: EnvironmentStore) {
  const normalized: EnvironmentStore = {
    version: 1,
    ...(store.defaultProfileId && store.profiles.some((item) => item.id === store.defaultProfileId)
      ? { defaultProfileId: store.defaultProfileId }
      : {}),
    profiles: store.profiles.flatMap((item) => parseProfile(item) ?? []),
  }
  const target = storePath()
  await mkdir(path.dirname(target), { recursive: true })
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`Environment store is not a real file: ${target}`)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(normalized, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
  return normalized
}

export async function probePythonEnvironment(input: {
  interpreter: string
  displayName?: string
  kind?: PythonEnvironmentKind
  prefix?: string
  installPolicy?: InstallPolicy
  id?: string
}): Promise<PythonEnvironmentProfile> {
  const requested = path.resolve(input.interpreter)
  let interpreter: string
  try {
    interpreter = await realpath(requested)
    const info = await lstat(interpreter)
    await access(interpreter)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular executable")
  } catch (error) {
    return {
      id: safeID(input.id ?? path.basename(requested)),
      displayName: input.displayName?.trim() || path.basename(requested),
      kind: input.kind ?? "python",
      interpreter: requested,
      ...(input.prefix ? { prefix: path.resolve(input.prefix) } : {}),
      pythonVersion: "unknown",
      architecture: "unknown",
      packages: {},
      installPolicy: input.installPolicy ?? "deny",
      fingerprint: fingerprint({
        interpreter: requested,
        pythonVersion: "unknown",
        architecture: "unknown",
        packages: {},
      }),
      status: "missing",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  const result = await capture([interpreter, "-I", "-c", PROBE])
  try {
    if (result.status !== 0) throw new Error(result.stderr.trim() || `probe exited ${result.status}`)
    const data = object(JSON.parse(result.stdout.trim()))
    if (!data || typeof data.version !== "string" || typeof data.architecture !== "string")
      throw new Error("probe returned invalid data")
    const packages = Object.fromEntries(
      Object.entries(object(data.packages) ?? {}).map(([name, version]) => [
        name,
        typeof version === "string" ? version : undefined,
      ]),
    )
    const canonicalPrefix = await realpath(
      input.prefix ?? (typeof data.prefix === "string" ? data.prefix : path.dirname(path.dirname(interpreter))),
    ).catch(() => path.resolve(input.prefix ?? path.dirname(path.dirname(interpreter))))
    const kind = input.kind ?? "python"
    const profile = {
      id: safeID(input.id ?? `${kind}-${path.basename(canonicalPrefix)}`),
      displayName: input.displayName?.trim() || path.basename(canonicalPrefix) || path.basename(interpreter),
      kind,
      interpreter,
      prefix: canonicalPrefix,
      pythonVersion: data.version,
      architecture: data.architecture,
      packages,
      installPolicy: input.installPolicy ?? "deny",
    }
    return { ...profile, fingerprint: fingerprint(profile), status: "ready" }
  } catch (error) {
    const profile = {
      id: safeID(input.id ?? path.basename(interpreter)),
      displayName: input.displayName?.trim() || path.basename(interpreter),
      kind: input.kind ?? "python",
      interpreter,
      ...(input.prefix ? { prefix: path.resolve(input.prefix) } : {}),
      pythonVersion: "unknown",
      architecture: "unknown",
      packages: {},
      installPolicy: input.installPolicy ?? "deny",
    }
    return {
      ...profile,
      fingerprint: fingerprint(profile),
      status: "invalid",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function discoverCondaEnvironments(conda = "conda") {
  const info = await capture([conda, "info", "--json"])
  const listed = await capture([conda, "env", "list", "--json"])
  if (info.status !== 0 || listed.status !== 0) return []
  let prefixes: string[] = []
  try {
    const data = object(JSON.parse(listed.stdout))
    prefixes = Array.isArray(data?.envs)
      ? data.envs.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
  const profiles = await Promise.all(
    prefixes.map(async (prefix) => {
      const interpreter = path.join(prefix, process.platform === "win32" ? "python.exe" : "bin/python")
      return probePythonEnvironment({
        interpreter,
        prefix,
        kind: "conda",
        id: `conda-${createHash("sha256").update(path.resolve(prefix)).digest("hex").slice(0, 12)}`,
        displayName: path.basename(prefix) || prefix,
      })
    }),
  )
  return profiles
}

export async function upsertEnvironmentProfile(profile: PythonEnvironmentProfile, makeDefault = false) {
  const store = await loadEnvironmentStore()
  const index = store.profiles.findIndex((item) => item.id === profile.id)
  if (index === -1) store.profiles.push(profile)
  else store.profiles[index] = profile
  if (makeDefault) store.defaultProfileId = profile.id
  return saveEnvironmentStore(store)
}

export async function resolveEnvironmentProfile(input: {
  profileId?: string
  interpreter?: string
}) {
  if (input.interpreter) {
    const profile = await probePythonEnvironment({ interpreter: input.interpreter })
    if (profile.status !== "ready") throw new Error(`Selected Python environment is ${profile.status}: ${profile.detail ?? profile.interpreter}`)
    return { profile, source: "task-override" as const }
  }
  const store = await loadEnvironmentStore()
  const id = input.profileId ?? store.defaultProfileId
  if (!id)
    throw new Error("No default Python environment is configured. Select an existing Conda environment or Python interpreter first.")
  const stored = store.profiles.find((item) => item.id === id)
  if (!stored) throw new Error(`No such Python environment profile: ${id}`)
  const profile = await probePythonEnvironment(stored)
  if (profile.status !== "ready")
    throw new Error(`Python environment ${stored.displayName} is ${profile.status}: ${profile.detail ?? profile.interpreter}`)
  return { profile: { ...profile, id: stored.id }, source: input.profileId ? "task-override" as const : "default" as const }
}

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function taskBoomDirectory(directory: string, create = true) {
  const base = await realpath(path.resolve(directory))
  const work = path.join(base, "work")
  const workInfo = await lstat(work)
  if (!workInfo.isDirectory() || workInfo.isSymbolicLink()) throw new Error("Task work path is not a real directory")
  const canonicalWork = await realpath(work)
  if (!inside(base, canonicalWork)) throw new Error("Task work path escapes the workspace")
  const target = path.join(canonicalWork, ".boom")
  if (create) await mkdir(target, { recursive: true, mode: 0o700 })
  const info = await lstat(target).catch(() => undefined)
  if (!info && !create) return undefined
  if (!info) throw new Error("Task environment path is missing")
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Task environment path is not a real directory")
  return { base, work: canonicalWork, boom: await realpath(target) }
}

function parseBinding(value: unknown): TaskEnvironmentBinding | undefined {
  const input = object(value)
  const profile = parseProfile({ ...input, id: input?.profileId, status: "ready" })
  if (!input || !profile || (input.source !== "default" && input.source !== "task-override") ||
      !["managed", "isolated", "static-only"].includes(String(input.executionMode)) || typeof input.boundAt !== "string") return undefined
  return {
    profileId: profile.id,
    displayName: profile.displayName,
    kind: profile.kind,
    interpreter: profile.interpreter,
    ...(profile.prefix ? { prefix: profile.prefix } : {}),
    pythonVersion: profile.pythonVersion,
    architecture: profile.architecture,
    packages: profile.packages,
    installPolicy: profile.installPolicy,
    fingerprint: profile.fingerprint,
    source: input.source,
    executionMode: input.executionMode as ExecutionMode,
    boundAt: input.boundAt,
  }
}

export async function loadTaskEnvironment(directory: string) {
  const paths = await taskBoomDirectory(directory, false)
  if (!paths) return undefined
  const target = path.join(paths.boom, "environment.json")
  const info = await lstat(target).catch(() => undefined)
  if (!info) return undefined
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Task environment binding is not a real file")
  try {
    return parseBinding(JSON.parse(await readFile(target, "utf8")))
  } catch {
    return undefined
  }
}

export async function bindTaskEnvironment(input: {
  directory: string
  profile: PythonEnvironmentProfile
  source: TaskEnvironmentBinding["source"]
  executionMode?: ExecutionMode
  replace?: boolean
}) {
  if (input.profile.status !== "ready") throw new Error(`Cannot bind a ${input.profile.status} Python environment`)
  const existing = await loadTaskEnvironment(input.directory)
  if (existing && !input.replace) return existing
  const paths = (await taskBoomDirectory(input.directory))!
  const binding: TaskEnvironmentBinding = {
    profileId: input.profile.id,
    displayName: input.profile.displayName,
    kind: input.profile.kind,
    interpreter: input.profile.interpreter,
    ...(input.profile.prefix ? { prefix: input.profile.prefix } : {}),
    pythonVersion: input.profile.pythonVersion,
    architecture: input.profile.architecture,
    packages: input.profile.packages,
    installPolicy: input.profile.installPolicy,
    fingerprint: input.profile.fingerprint,
    source: input.source,
    executionMode: input.executionMode ?? "managed",
    boundAt: new Date().toISOString(),
  }
  const target = path.join(paths.boom, "environment.json")
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(binding, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, target)
  return binding
}

export function environmentPrompt(binding: TaskEnvironmentBinding) {
  return `本题 Shell 使用“${binding.displayName}”（${binding.kind}，Python ${binding.pythonVersion}，安装策略：${binding.installPolicy}，执行模式：${binding.executionMode}，指纹：${binding.fingerprint}）。`
}

export async function controlledProcessEnvironment(directory: string, binding: TaskEnvironmentBinding) {
  const paths = (await taskBoomDirectory(directory))!
  const sandbox = path.join(paths.work, ".sandbox")
  const localPackages = path.join(sandbox, "site-packages")
  for (const name of ["cache", "cache/pip", "tmp", "home", "site-packages"])
    await mkdir(path.join(sandbox, name), { recursive: true, mode: 0o700 })
  const shimDirectory = path.join(sandbox, "bin")
  await mkdir(shimDirectory, { recursive: true, mode: 0o700 })
  const quotedInterpreter = `'${binding.interpreter.replaceAll("'", "'\\''")}'`
  for (const name of ["python", "python3"]) {
    const target = path.join(shimDirectory, name)
    await writeFile(target, `#!/bin/sh\nexec ${quotedInterpreter} "$@"\n`, { encoding: "utf8", mode: 0o700 })
    await chmod(target, 0o700)
  }
  for (const name of ["pip", "pip3"]) {
    const target = path.join(shimDirectory, name)
    await writeFile(target, `#!/bin/sh\nexec ${quotedInterpreter} -m pip "$@"\n`, { encoding: "utf8", mode: 0o700 })
    await chmod(target, 0o700)
  }
  const environmentBin = path.dirname(binding.interpreter)
  const safeSystemBins = process.platform === "win32"
    ? [path.dirname(process.execPath)]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  const env: Record<string, string> = {
    PATH: [shimDirectory, environmentBin, ...safeSystemBins].join(path.delimiter),
    HOME: path.join(sandbox, "home"),
    TMPDIR: path.join(sandbox, "tmp"),
    TMP: path.join(sandbox, "tmp"),
    TEMP: path.join(sandbox, "tmp"),
    XDG_CACHE_HOME: path.join(sandbox, "cache"),
    PIP_CACHE_DIR: path.join(sandbox, "cache", "pip"),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    BOOM_ENVIRONMENT_FINGERPRINT: binding.fingerprint,
  }
  if (binding.installPolicy === "allow") {
    env.PIP_TARGET = localPackages
    env.PYTHONPATH = localPackages
  }
  if (binding.kind === "conda" && binding.prefix) env.CONDA_PREFIX = binding.prefix
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  if (process.env.WINDIR) env.WINDIR = process.env.WINDIR
  return env
}

export async function detectContainerCapability(): Promise<ContainerCapability> {
  for (const runtime of ["docker", "podman"] as const) {
    const lookup = await capture(process.platform === "win32" ? ["where", runtime] : ["/usr/bin/env", "which", runtime])
    if (lookup.status !== 0 || !lookup.stdout.trim()) continue
    const executable = lookup.stdout.trim().split(/\r?\n/)[0]!
    const version = await capture([executable, "version", "--format", "{{.Server.Version}}"], 5_000)
    if (version.status === 0) return { runtime, executable, status: "ready" }
    return { runtime, executable, status: "invalid", detail: version.stderr.trim() || "container daemon unavailable" }
  }
  return { status: "missing", detail: "Docker or Podman was not found" }
}
