import { appendFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  controlledProcessEnvironment,
  detectContainerCapability,
  loadTaskEnvironment,
  type ExecutionMode,
  type TaskEnvironmentBinding,
} from "./environment.ts"
import { resolveTaskPath } from "./runtime/policy.ts"
import { resolveInputDirectory } from "./task-layout.ts"

export type CommandRequest = {
  program: string
  args?: string[]
  cwd?: string
  mode?: ExecutionMode
  timeoutMs?: number
  maxOutputBytes?: number
  network?: boolean
  purpose?: "analysis" | "install"
  /** Sensitive input is sent over stdin and is never included in the command event or log metadata. */
  stdin?: string
  /** Return output to the host caller but do not persist its contents in the command log. */
  sensitiveOutput?: boolean
}

export type CommandResult = {
  id: string
  command: string[]
  cwd: string
  mode: ExecutionMode
  interpreter?: string
  environmentFingerprint: string
  exitCode: number
  signal?: string
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  durationMs: number
  output: string
  logPath: string
}

export type ShellRequest = {
  command: string
  workdir?: string
  timeout?: number
  network?: boolean
}

const STATIC_PROGRAMS = new Set([
  "file", "strings", "xxd", "hexdump", "od", "objdump", "readelf", "nm", "otool",
  "codesign", "shasum", "sha256sum", "md5", "grep", "rg", "sed", "awk", "head", "tail",
  "wc", "sort", "uniq", "cut", "tr", "find", "ls", "stat", "tar", "unzip", "7z", "unar",
])
const MANAGED_PROGRAMS = new Set([
  ...STATIC_PROGRAMS,
  "python", "python3", "pip", "pip3", "node", "ruby", "java", "javap", "gcc", "clang",
  "make", "cmake", "gdb", "lldb", "openssl", "curl", "nc", "ncat", "socat",
])
const HOST_PACKAGE_MANAGERS = new Set([
  "brew", "apt", "apt-get", "dnf", "yum", "pacman", "apk", "port", "npm", "pnpm", "yarn",
  "gem", "cargo", "rustup", "conda", "mamba",
])
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh"])
const MAX_CAPTURE_BYTES = 10_000_000
const MAX_VISIBLE_SHELL_BYTES = 32_768

/**
 * Execution modes form a strict isolation ladder: managed < isolated < static-only. A task's bound
 * execution mode is the isolation ceiling, so a requested mode must rank at or above it.
 */
const EXECUTION_MODE_RANK: Record<ExecutionMode, number> = {
  managed: 0,
  isolated: 1,
  "static-only": 2,
}

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`
}

async function executableFromPath(name: string, search: string[]) {
  for (const directory of search) {
    const candidate = path.join(directory, name)
    const info = await lstat(candidate).catch(() => undefined)
    if (info?.isFile() && !info.isSymbolicLink()) return realpath(candidate)
  }
  return undefined
}

async function resultBlocker(root: string): Promise<string> {
  const target = path.join(root, "work", ".boom", "result.blocker")
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!existing) await writeFile(target, "", { encoding: "utf8", flag: "wx", mode: 0o400 })
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Task result blocker is not a real file")
  return target
}

async function resolveCommand(
  request: CommandRequest,
  binding: TaskEnvironmentBinding,
  mode: ExecutionMode,
) {
  const name = path.basename(request.program)
  if (SHELLS.has(name)) throw new Error("Shell interpreters are not exposed; pass a program and argv directly")
  if (HOST_PACKAGE_MANAGERS.has(name)) throw new Error(`Host package manager is forbidden: ${name}`)
  if (["pip", "pip3"].includes(name)) {
    if (request.purpose !== "install") throw new Error("pip is available only with purpose=install")
    if (binding.installPolicy !== "allow") throw new Error(`Environment ${binding.displayName} has installPolicy=deny`)
    return { executable: binding.interpreter, argv: ["-m", "pip", ...(request.args ?? [])], interpreter: binding.interpreter }
  }
  if (["python", "python3"].includes(name))
    return { executable: binding.interpreter, argv: request.args ?? [], interpreter: binding.interpreter }

  const allowed = mode === "static-only" ? STATIC_PROGRAMS : MANAGED_PROGRAMS
  if (!allowed.has(name) && mode !== "isolated") throw new Error(`Program is not in Boom's ${mode} allowlist: ${name}`)
  if (path.isAbsolute(request.program)) {
    const executable = await realpath(request.program).catch(() => undefined)
    if (!executable) throw new Error(`Program does not exist: ${request.program}`)
    if (mode !== "isolated" && path.basename(executable) !== name)
      throw new Error("Executable symlinks are not accepted")
    return { executable, argv: request.args ?? [] }
  }
  const search = [path.dirname(binding.interpreter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  const executable = await executableFromPath(name, search)
  if (!executable && mode !== "isolated") throw new Error(`Allowed program is not installed: ${name}`)
  return { executable: executable ?? name, argv: request.args ?? [] }
}

function validateArguments(root: string, args: string[]) {
  for (const value of args) {
    if (value.includes("\0")) throw new Error("Command arguments may not contain NUL")
    if (!path.isAbsolute(value)) continue
    const resolved = path.resolve(value)
    if (!inside(root, resolved)) throw new Error(`Absolute path escapes the task workspace: ${value}`)
  }
}

function macSandbox(root: string, binding: TaskEnvironmentBinding, network: boolean) {
  const escaped = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const readable = [root, binding.prefix, path.dirname(binding.interpreter)].filter((item): item is string => !!item)
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix*)",
    "(allow iokit-open)",
    "(allow system-socket)",
    "(allow user-preference-read)",
    // Framework interpreters consult OS-managed paths that vary across macOS
    // releases. Fence off user-data mounts, then re-open only the task and the
    // selected interpreter environment.
    "(allow file-read*)",
    "(deny file-read* (subpath \"/Users\"))",
    "(deny file-read* (subpath \"/Volumes\"))",
    "(deny file-read* (subpath \"/Network\"))",
    "(deny file-read* (subpath \"/private/tmp\"))",
    "(deny file-read* (subpath \"/tmp\"))",
    "(deny file-read* (subpath \"/private/var/folders\"))",
    ...readable.map((item) => `(allow file-read* (subpath \"${escaped(item)}\"))`),
    `(allow file-write* (subpath \"${escaped(path.join(root, "work"))}\"))`,
    `(deny file-write* (subpath \"${escaped(path.join(root, "work", ".boom"))}\"))`,
    `(deny file-write* (literal \"${escaped(path.join(root, "work", "RESULT.json"))}\"))`,
    "(allow file-write* (literal \"/dev/null\"))",
    network ? "(allow network*)" : "(deny network*)",
  ].join("\n")
}

async function spawnCaptured(input: {
  command: string[]
  cwd: string
  env: Record<string, string>
  timeout: number
  maximum: number
  signal?: AbortSignal
  stdin?: string
}) {
  input.signal?.throwIfAborted()
  const started = Date.now()
  const child = Bun.spawn(input.command, {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdin: input.stdin === undefined ? "ignore" : new Blob([input.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  let cancelled = false
  let stopping = false
  const killGroup = (signal: NodeJS.Signals) => {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal)
        return
      } catch {}
    }
    child.kill(signal)
  }
  const stop = (reason: "timeout" | "cancel") => {
    if (reason === "timeout") timedOut = true
    else cancelled = true
    if (stopping) return
    stopping = true
    killGroup("SIGTERM")
    const hardKill = setTimeout(() => killGroup("SIGKILL"), 250)
    hardKill.unref?.()
  }
  const timer = setTimeout(() => stop("timeout"), input.timeout)
  const abort = () => stop("cancel")
  input.signal?.addEventListener("abort", abort, { once: true })
  try {
    const chunks: Buffer[] = []
    let captured = 0
    let observed = 0
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader()
      while (true) {
        const item = await reader.read()
        if (item.done) return
        const chunk = Buffer.from(item.value)
        observed += chunk.byteLength
        const remaining = MAX_CAPTURE_BYTES - captured
        if (remaining <= 0) continue
        const kept = chunk.subarray(0, remaining)
        chunks.push(kept)
        captured += kept.byteLength
      }
    }
    const [exitCode] = await Promise.all([child.exited, consume(child.stdout), consume(child.stderr)])
    const combined = Buffer.concat(chunks)
    const captureTruncated = observed > combined.byteLength
    const truncated = observed > input.maximum
    const captureNotice = captureTruncated ? "\n[command log truncated at Boom's hard capture limit]\n" : ""
    return {
      exitCode,
      timedOut,
      cancelled,
      truncated,
      durationMs: Date.now() - started,
      fullOutput: combined.toString("utf8") + captureNotice,
      output: combined.subarray(0, input.maximum).toString("utf8") + (truncated ? "\n[output truncated; see log]\n" : ""),
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
    // A shell can daemonize a child and exit. Never let a task-owned process group outlive its tool call.
    if (process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGTERM") } catch {}
    }
  }
}

export async function executeControlledCommand(input: {
  directory: string
  request: CommandRequest
  signal?: AbortSignal
}): Promise<CommandResult> {
  const root = await realpath(path.resolve(input.directory))
  const binding = await loadTaskEnvironment(root)
  if (!binding) throw new Error("This task has no Python environment binding")
  const mode = input.request.mode ?? binding.executionMode
  // The binding mode is an isolation ceiling, not merely a static-only rule. Reject every request
  // that ranks below it: managed under isolated loses the container boundary, and isolated (or
  // managed) under static-only would void the no-challenge-execution promise and its allowlist.
  if (EXECUTION_MODE_RANK[mode] < EXECUTION_MODE_RANK[binding.executionMode])
    throw new Error(
      `Execution mode ceiling violated: task binding is ${binding.executionMode}, requested mode is ${mode}; a request cannot lower isolation below the task's bound execution mode`,
    )
  const relativeCwd = input.request.cwd?.trim() || "."
  const resolvedCwd = await resolveTaskPath(root, relativeCwd)
  const cwd = resolvedCwd.absolute
  const cwdInfo = await lstat(cwd).catch(() => undefined)
  if (!cwdInfo?.isDirectory() || cwdInfo.isSymbolicLink()) throw new Error(`Command cwd is not a real directory: ${relativeCwd}`)
  const resolved = await resolveCommand(input.request, binding, mode)
  validateArguments(root, resolved.argv)
  const timeout = Math.max(100, Math.min(300_000, Math.floor(input.request.timeoutMs ?? 30_000)))
  const maximum = Math.max(1_024, Math.min(10_000_000, Math.floor(input.request.maxOutputBytes ?? 200_000)))
  let env = await controlledProcessEnvironment(root, binding)
  let command = [resolved.executable, ...resolved.argv]

  if (mode === "isolated") {
    const container = await detectContainerCapability()
    if (container.status !== "ready" || !container.executable)
      throw new Error(`Isolated execution is unavailable: ${container.detail ?? container.status}`)
    const relative = path.relative(root, cwd).split(path.sep).join("/")
    const inputDirectory = path.basename(await resolveInputDirectory(root))
    const image = "ghcr.io/openai/boom-ctf-tools:latest"
    const blockedResult = await resultBlocker(root)
    command = [
      container.executable, "run", "--rm", "--user", "65534:65534", "--read-only",
      "--cpus", "1", "--memory", "1g", "--pids-limit", "128", "--network", input.request.network ? "bridge" : "none",
      "--mount", `type=bind,src=${path.join(root, inputDirectory)},dst=/task/${inputDirectory},readonly`,
      "--mount", `type=bind,src=${path.join(root, "work")},dst=/task/work`,
      "--mount", `type=bind,src=${path.join(root, "work", ".boom")},dst=/task/work/.boom,readonly`,
      "--mount", `type=bind,src=${blockedResult},dst=/task/work/RESULT.json,readonly`,
      "--workdir", `/task/${relative}`,
      image, path.basename(resolved.executable), ...resolved.argv,
    ]
  } else if (process.platform === "darwin") {
    command = ["/usr/bin/sandbox-exec", "-p", macSandbox(root, binding, input.request.network === true), ...command]
  } else if (process.platform === "linux") {
    const prepared = await linuxBubblewrapCommand({
      root,
      cwd,
      binding,
      command,
      network: input.request.network === true,
      env,
    })
    command = prepared.command
    env = prepared.env
  } else {
    throw new Error(`Managed process isolation is unavailable on ${process.platform}; use isolated mode`)
  }

  const result = await spawnCaptured({ command, cwd, env, timeout, maximum, signal: input.signal, stdin: input.request.stdin })
  const id = `command-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const eventDirectory = path.join(root, "work", ".boom", "commands")
  await mkdir(eventDirectory, { recursive: true, mode: 0o700 })
  const log = path.join(eventDirectory, `${id}.log`)
  await writeFile(log, input.request.sensitiveOutput ? "[sensitive output omitted]\n" : result.fullOutput, { encoding: "utf8", mode: 0o600 })
  const record = {
    id,
    at: new Date().toISOString(),
    argv: [resolved.executable, ...resolved.argv],
    cwd: path.relative(root, cwd).split(path.sep).join("/"),
    mode,
    environmentFingerprint: binding.fingerprint,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    truncated: result.truncated,
    requestedMaxOutputBytes: input.request.maxOutputBytes ?? 200_000,
    visibleMaxOutputBytes: maximum,
    logPath: path.relative(root, log).split(path.sep).join("/"),
  }
  await appendFile(path.join(root, "work", ".boom", "command-events.jsonl"), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 })
  return {
    id,
    command: [resolved.executable, ...resolved.argv],
    cwd: record.cwd,
    mode,
    ...(resolved.interpreter ? { interpreter: resolved.interpreter } : {}),
    environmentFingerprint: binding.fingerprint,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    truncated: result.truncated,
    durationMs: result.durationMs,
    output: result.output,
    logPath: record.logPath,
  }
}

async function existingPaths(paths: string[]): Promise<string[]> {
  const found: string[] = []
  for (const item of paths) {
    if (await lstat(item).catch(() => undefined)) found.push(item)
  }
  return found
}

function taskSandboxEnvironment(env: Record<string, string>, root: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [
    key,
    value === root || value.startsWith(`${root}${path.sep}`)
      ? `/task${value.slice(root.length).split(path.sep).join("/")}`
      : value,
  ]))
}

function taskSandboxPath(value: string, root: string): string {
  return value === root || value.startsWith(`${root}${path.sep}`)
    ? `/task${value.slice(root.length).split(path.sep).join("/")}`
    : value
}

async function linuxBubblewrapCommand(input: {
  root: string
  cwd: string
  binding: TaskEnvironmentBinding
  command: string[]
  network: boolean
  env: Record<string, string>
}): Promise<{ command: string[]; cwd: string; env: Record<string, string> }> {
  const search = ["/usr/bin", "/bin", "/usr/local/bin"]
  const bubblewrap = await executableFromPath("bwrap", search) ?? await executableFromPath("bubblewrap", search)
  if (!bubblewrap) throw new Error("Process isolation is unavailable: bubblewrap is missing")
  const system = await existingPaths(["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc"])
  const prefix = input.binding.prefix && !system.some((item) => inside(item, input.binding.prefix!))
    ? input.binding.prefix
    : undefined
  const relative = path.relative(input.root, input.cwd).split(path.sep).join("/")
  const blockedResult = await resultBlocker(input.root)
  return {
    cwd: input.cwd,
    env: taskSandboxEnvironment(input.env, input.root),
    command: [
      bubblewrap,
      "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      ...system.flatMap((item) => ["--ro-bind", item, item]),
      ...(prefix ? ["--ro-bind", prefix, prefix] : []),
      "--ro-bind", input.root, "/task",
      "--bind", path.join(input.root, "work"), "/task/work",
      "--ro-bind", path.join(input.root, "work", ".boom"), "/task/work/.boom",
      "--ro-bind", blockedResult, "/task/work/RESULT.json",
      "--chdir", `/task/${relative}`,
      ...(input.network ? [] : ["--unshare-net"]),
      "--cap-drop", "ALL",
      ...input.command.map((item) => taskSandboxPath(item, input.root)),
    ],
  }
}

async function shellCommand(input: {
  root: string
  cwd: string
  binding: TaskEnvironmentBinding
  mode: ExecutionMode
  command: string
  network: boolean
  env: Record<string, string>
}): Promise<{ command: string[]; cwd: string; env: Record<string, string> }> {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash"
  const shellArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", input.command]
    : ["--noprofile", "--norc", "-c", input.command]
  const relative = path.relative(input.root, input.cwd).split(path.sep).join("/")

  if (input.mode === "isolated" || process.platform === "win32") {
    const container = await detectContainerCapability()
    if (container.status !== "ready" || !container.executable)
      throw new Error(`Shell isolation is unavailable: ${container.detail ?? container.status}`)
    const inputDirectory = path.basename(await resolveInputDirectory(input.root))
    const image = "ghcr.io/openai/boom-ctf-tools:latest"
    const sandboxEnv = taskSandboxEnvironment(input.env, input.root)
    const blockedResult = await resultBlocker(input.root)
    return {
      cwd: input.cwd,
      env: input.env,
      command: [
        container.executable, "run", "--rm", "--user", "65534:65534", "--read-only",
        "--cpus", "1", "--memory", "1g", "--pids-limit", "128",
        "--network", input.network ? "bridge" : "none",
        "--mount", `type=bind,src=${path.join(input.root, inputDirectory)},dst=/task/${inputDirectory},readonly`,
        "--mount", `type=bind,src=${path.join(input.root, "work")},dst=/task/work`,
        "--mount", `type=bind,src=${path.join(input.root, "work", ".boom")},dst=/task/work/.boom,readonly`,
        "--mount", `type=bind,src=${blockedResult},dst=/task/work/RESULT.json,readonly`,
        "--workdir", `/task/${relative}`,
        ...Object.entries(sandboxEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        image, "/bin/bash", "--noprofile", "--norc", "-c", input.command,
      ],
    }
  }

  if (process.platform === "darwin") {
    const sandbox = "/usr/bin/sandbox-exec"
    const info = await lstat(sandbox).catch(() => undefined)
    if (!info?.isFile()) throw new Error("Shell isolation is unavailable: sandbox-exec is missing")
    return {
      cwd: input.cwd,
      env: input.env,
      command: [sandbox, "-p", macSandbox(input.root, input.binding, input.network), shell, ...shellArgs],
    }
  }

  return linuxBubblewrapCommand({
    root: input.root,
    cwd: input.cwd,
    binding: input.binding,
    command: ["/bin/bash", "--noprofile", "--norc", "-c", input.command],
    network: input.network,
    env: input.env,
  })
}

/** Execute full shell syntax behind the same task filesystem, environment, and process boundary. */
export async function executeControlledShell(input: {
  directory: string
  request: ShellRequest
  signal?: AbortSignal
}): Promise<CommandResult> {
  const root = await realpath(path.resolve(input.directory))
  const binding = await loadTaskEnvironment(root)
  if (!binding) throw new Error("This task has no Python environment binding")
  if (!input.request.command.trim()) throw new Error("bash requires a non-empty command")
  if (input.request.command.includes("\0")) throw new Error("Shell command may not contain NUL")
  if (binding.executionMode === "static-only")
    throw new Error("Full shell execution is unavailable in static-only mode; use boom-exec")
  const requestedWorkdir = input.request.workdir?.trim() || "."
  const resolvedCwd = await resolveTaskPath(root, requestedWorkdir)
  if (!(await lstat(resolvedCwd.absolute)).isDirectory())
    throw new Error(`Shell workdir is not a directory: ${requestedWorkdir}`)
  const network = input.request.network !== false
  const env = await controlledProcessEnvironment(root, binding)
  const prepared = await shellCommand({
    root,
    cwd: resolvedCwd.absolute,
    binding,
    mode: binding.executionMode,
    command: input.request.command,
    network,
    env,
  })
  const timeout = Math.max(100, Math.min(600_000, Math.floor(input.request.timeout ?? 120_000)))
  const result = await spawnCaptured({
    command: prepared.command,
    cwd: prepared.cwd,
    env: prepared.env,
    timeout,
    maximum: MAX_VISIBLE_SHELL_BYTES,
    signal: input.signal,
  })
  const id = `shell-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  const eventDirectory = path.join(root, "work", ".boom", "commands")
  await mkdir(eventDirectory, { recursive: true, mode: 0o700 })
  const log = path.join(eventDirectory, `${id}.log`)
  await writeFile(log, result.fullOutput, { encoding: "utf8", mode: 0o600 })
  const record = {
    id,
    at: new Date().toISOString(),
    command: input.request.command,
    cwd: resolvedCwd.relative,
    mode: binding.executionMode,
    network,
    environmentFingerprint: binding.fingerprint,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    truncated: result.truncated,
    logPath: path.relative(root, log).split(path.sep).join("/"),
  }
  await appendFile(
    path.join(root, "work", ".boom", "command-events.jsonl"),
    `${JSON.stringify(record)}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
  return {
    id,
    command: [process.platform === "win32" ? "cmd.exe" : "/bin/bash", "-c", input.request.command],
    cwd: resolvedCwd.relative,
    mode: binding.executionMode,
    interpreter: binding.interpreter,
    environmentFingerprint: binding.fingerprint,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    truncated: result.truncated,
    durationMs: result.durationMs,
    output: result.output,
    logPath: record.logPath,
  }
}

export function formatControlledCommand(result: CommandResult) {
  return `${result.command.map(shellQuote).join(" ")}\nexit=${result.exitCode} duration=${result.durationMs}ms log=${result.logPath}\n${result.output}`
}
