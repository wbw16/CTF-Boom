import { tool, type Plugin } from "@opencode-ai/plugin"
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"

type Binding = {
  displayName: string
  kind: "conda" | "python"
  interpreter: string
  prefix?: string
  pythonVersion: string
  installPolicy: "deny" | "allow"
  fingerprint: string
  executionMode: "managed" | "isolated" | "static-only"
}

const BOOM_MARKERS = [
  "You are Boom. The current workspace contains one CTF challenge.",
  "You are a Boom worker.",
  "Boom escalation point",
  "Boom intake collector",
]
const STATIC = new Set([
  "file", "strings", "xxd", "hexdump", "od", "objdump", "readelf", "nm", "otool",
  "codesign", "shasum", "sha256sum", "md5", "grep", "rg", "sed", "awk", "head", "tail",
  "wc", "sort", "uniq", "cut", "tr", "find", "ls", "stat", "tar", "unzip", "7z", "unar",
])
const MANAGED = new Set([
  ...STATIC, "python", "python3", "pip", "pip3", "node", "ruby", "java", "javap", "gcc",
  "clang", "make", "cmake", "gdb", "lldb", "openssl", "curl", "nc", "ncat", "socat",
])
const FORBIDDEN = new Set([
  "bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh", "brew", "apt", "apt-get", "dnf",
  "yum", "pacman", "apk", "port", "npm", "pnpm", "yarn", "gem", "cargo", "rustup", "conda", "mamba",
])
const MAX_VISIBLE_OUTPUT_BYTES = 32_768

/**
 * Same isolation ladder as Boom's command executor: managed < isolated < static-only. The task
 * binding is the ceiling; a requested mode must rank at or above it.
 */
const EXECUTION_MODE_RANK: Record<Binding["executionMode"], number> = {
  managed: 0,
  isolated: 1,
  "static-only": 2,
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
}

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function locate(directory: string) {
  let current = await realpath(directory)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, "work", ".boom", "environment.json")
    const info = await lstat(candidate).catch(() => undefined)
    if (info?.isFile() && !info.isSymbolicLink()) {
      const binding = JSON.parse(await readFile(candidate, "utf8")) as Binding
      if (!binding.interpreter || !binding.fingerprint || !binding.executionMode)
        throw new Error("Invalid task environment binding")
      return { root: current, binding }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error("This session has no Boom task environment binding")
}

function cleanEnvironment(root: string, binding: Binding) {
  const boom = path.join(root, "work", ".boom")
  const systemBins = process.platform === "win32"
    ? [path.dirname(process.execPath)]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  const env: Record<string, string> = {
    PATH: [path.dirname(binding.interpreter), ...systemBins].join(path.delimiter),
    HOME: path.join(boom, "home"),
    TMPDIR: path.join(boom, "tmp"),
    TMP: path.join(boom, "tmp"),
    TEMP: path.join(boom, "tmp"),
    XDG_CACHE_HOME: path.join(boom, "cache"),
    PIP_CACHE_DIR: path.join(boom, "cache", "pip"),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    BOOM_ENVIRONMENT_FINGERPRINT: binding.fingerprint,
  }
  if (binding.kind === "conda" && binding.prefix) env.CONDA_PREFIX = binding.prefix
  return env
}

function sandboxProfile(root: string, binding: Binding, network: boolean) {
  const escaped = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const readable = [root, binding.prefix, path.dirname(binding.interpreter)].filter((item): item is string => !!item)
  return [
    "(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)", "(allow mach-lookup)",
    "(allow ipc-posix*)", "(allow iokit-open)", "(allow system-socket)", "(allow user-preference-read)",
    "(allow file-read*)",
    "(deny file-read* (subpath \"/Users\"))", "(deny file-read* (subpath \"/Volumes\"))", "(deny file-read* (subpath \"/Network\"))",
    ...readable.map((item) => `(allow file-read* (subpath \"${escaped(item)}\"))`),
    `(allow file-write* (subpath \"${escaped(path.join(root, "work"))}\"))`,
    network ? "(allow network*)" : "(deny network*)",
  ].join("\n")
}

async function resolveProgram(name: string, binding: Binding, mode: Binding["executionMode"], purpose: string) {
  const base = path.basename(name)
  if (FORBIDDEN.has(base)) throw new Error(`Program is forbidden: ${base}`)
  if (base === "python" || base === "python3") return { executable: binding.interpreter, prefix: [] as string[] }
  if (base === "pip" || base === "pip3") {
    if (purpose !== "install") throw new Error("pip requires purpose=install")
    if (binding.installPolicy !== "allow") throw new Error("This shared environment has installPolicy=deny")
    return { executable: binding.interpreter, prefix: ["-m", "pip"] }
  }
  if (!(mode === "static-only" ? STATIC : MANAGED).has(base) && mode !== "isolated")
    throw new Error(`Program is not in Boom's ${mode} allowlist: ${base}`)
  if (path.isAbsolute(name)) return { executable: await realpath(name), prefix: [] as string[] }
  for (const directory of [path.dirname(binding.interpreter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    const candidate = path.join(directory, base)
    if ((await lstat(candidate).catch(() => undefined))?.isFile())
      return { executable: await realpath(candidate), prefix: [] as string[] }
  }
  if (mode === "isolated") return { executable: base, prefix: [] as string[] }
  throw new Error(`Allowed program is not installed: ${base}`)
}

async function containerRuntime() {
  for (const name of ["docker", "podman"]) {
    for (const directory of ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"]) {
      const candidate = path.join(directory, name)
      if ((await lstat(candidate).catch(() => undefined))?.isFile()) return candidate
    }
  }
  return undefined
}

const BoomExecPlugin: Plugin = async (plugin) => ({
  "shell.env": async (input, output) => {
    const { root, binding } = await locate(input.cwd)
    Object.assign(output.env, cleanEnvironment(root, binding))
  },
  "experimental.chat.system.transform": async (_input, output) => {
    if (!output.system.some((part) => BOOM_MARKERS.some((marker) => part.includes(marker)))) return
    const { binding } = await locate(plugin.directory)
    output.system.unshift(
      `本题选择的 Python 环境是“${binding.displayName}”（${binding.kind}，Python ${binding.pythonVersion}，安装策略：${binding.installPolicy}，执行模式：${binding.executionMode}，指纹：${binding.fingerprint}）；python/pip 已由 Boom 路由到该环境，禁止自行激活、切换或修改其他 Python 环境。`,
    )
  },
  "experimental.session.compacting": async (_input, output) => {
    const located = await locate(plugin.directory).catch(() => undefined)
    if (!located) return
    output.context.push(
      "Boom durable recovery: after compaction, read NOTES.md, work/boom-state.json, work/.boom/environment.json, and referenced artifacts. Do not reconstruct bulk output from chat history.",
    )
    await appendFile(
      path.join(located.root, "work", ".boom", "runtime-events.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), type: "compaction.started" })}\n`,
    ).catch(() => {})
  },
  "experimental.compaction.autocontinue": async (_input, output) => {
    output.enabled = true
    const located = await locate(plugin.directory).catch(() => undefined)
    if (located)
      await appendFile(
        path.join(located.root, "work", ".boom", "runtime-events.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), type: "compaction.completed" })}\n`,
      ).catch(() => {})
  },
  tool: {
    "boom-exec": tool({
      description: `Run one argv-based command through Boom's controlled executor. No shell is available.
cwd is relative to the current task; output is capped and the full log is retained under work/.boom/commands/.
Use isolated for unknown binaries or untrusted installers. It never falls back to managed execution.`,
      args: {
        program: tool.schema.string().min(1),
        args: tool.schema.array(tool.schema.string()).default([]),
        cwd: tool.schema.string().default("."),
        mode: tool.schema.enum(["managed", "isolated", "static-only"]).optional(),
        timeoutMs: tool.schema.number().int().min(100).max(300000).default(30000),
        maxOutputBytes: tool.schema.number().int().min(1024).max(1000000).default(MAX_VISIBLE_OUTPUT_BYTES),
        network: tool.schema.boolean().default(false),
        purpose: tool.schema.enum(["analysis", "install"]).default("analysis"),
      },
      async execute(args, ctx) {
        const { root, binding } = await locate(ctx.directory)
        // Compatibility runtimes do not all materialize schema defaults. Normalize every optional
        // value again at the Boom-owned execution boundary; these values are security controls.
        const argv = args.args === undefined
          ? []
          : Array.isArray(args.args) && args.args.every((value) => typeof value === "string")
            ? args.args
            : (() => { throw new Error("args must be an array of strings") })()
        const relativeCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : "."
        const timeoutMs = Math.max(100, Math.min(300_000, finite(args.timeoutMs, 30_000)))
        const requestedMaxOutputBytes = Math.max(1_024, Math.min(1_000_000, finite(args.maxOutputBytes, MAX_VISIBLE_OUTPUT_BYTES)))
        const maxOutputBytes = Math.min(requestedMaxOutputBytes, MAX_VISIBLE_OUTPUT_BYTES)
        const purpose = args.purpose === "install" ? "install" : "analysis"
        const network = args.network === true
        const mode = args.mode === "managed" || args.mode === "isolated" || args.mode === "static-only"
          ? args.mode
          : binding.executionMode
        // Same ceiling rule as src/command-executor.ts: a request may not rank below the bound
        // execution mode. Managed under isolated loses the container boundary, and isolated (or
        // managed) under static-only would void the no-challenge-execution promise and allowlist.
        if (EXECUTION_MODE_RANK[mode] < EXECUTION_MODE_RANK[binding.executionMode])
          throw new Error(
            `Execution mode ceiling violated: task binding is ${binding.executionMode}, requested mode is ${args.mode}; a request cannot lower isolation below the task's bound execution mode`,
          )
        if (path.isAbsolute(relativeCwd) || relativeCwd.split(/[\\/]/).includes("..")) throw new Error("cwd must stay inside the task")
        const cwd = path.resolve(ctx.directory, relativeCwd)
        const sessionRoot = await realpath(ctx.directory)
        if (!inside(sessionRoot, cwd)) throw new Error("cwd escapes this solver/branch workspace")
        const info = await lstat(cwd).catch(() => undefined)
        if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("cwd is not a real directory")
        for (const value of argv) {
          if (value.includes("\0")) throw new Error("argv contains NUL")
          if (path.isAbsolute(value) && !inside(sessionRoot, path.resolve(value))) throw new Error(`absolute path escapes the workspace: ${value}`)
        }
        const resolved = await resolveProgram(args.program, binding, mode, purpose)
        let command = [resolved.executable, ...resolved.prefix, ...argv]
        if (mode === "isolated") {
          const runtime = await containerRuntime()
          if (!runtime) throw new Error("isolated execution unavailable; Docker/Podman is missing")
          const relative = path.relative(sessionRoot, cwd).split(path.sep).join("/")
          command = [runtime, "run", "--rm", "--user", "65534:65534", "--read-only", "--cpus", "1", "--memory", "1g", "--pids-limit", "128", "--network", network ? "bridge" : "none", "--mount", `type=bind,src=${path.join(sessionRoot, "challenge")},dst=/task/challenge,readonly`, "--mount", `type=bind,src=${path.join(sessionRoot, "work")},dst=/task/work`, "--workdir", `/task/${relative}`, "ghcr.io/openai/boom-ctf-tools:latest", path.basename(resolved.executable), ...resolved.prefix, ...argv]
        } else if (process.platform === "darwin") {
          command = ["/usr/bin/sandbox-exec", "-p", sandboxProfile(sessionRoot, binding, network), ...command]
        }
        const child = Bun.spawn(command, { cwd, env: cleanEnvironment(root, binding), detached: process.platform !== "win32", stdin: "ignore", stdout: "pipe", stderr: "pipe" })
        let timedOut = false
        const kill = () => {
          const signal = (name: NodeJS.Signals) => {
            if (process.platform !== "win32") {
              try { process.kill(-child.pid, name); return } catch {}
            }
            child.kill(name)
          }
          signal("SIGTERM")
          setTimeout(() => signal("SIGKILL"), 250)
        }
        const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
        ctx.abort.addEventListener("abort", kill, { once: true })
        const started = Date.now()
        try {
          const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer()])
          const data = Buffer.concat([Buffer.from(stdout), Buffer.from(stderr)])
          const id = `command-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
          const directory = path.join(root, "work", ".boom", "commands")
          await mkdir(directory, { recursive: true, mode: 0o700 })
          const log = path.join(directory, `${id}.log`)
          await writeFile(log, data, { mode: 0o600 })
          const relativeLog = path.relative(root, log).split(path.sep).join("/")
          const event = { id, at: new Date().toISOString(), argv: [resolved.executable, ...resolved.prefix, ...argv], cwd: path.relative(sessionRoot, cwd), mode, environmentFingerprint: binding.fingerprint, durationMs: Date.now() - started, exitCode, timedOut, cancelled: ctx.abort.aborted, truncated: data.byteLength > maxOutputBytes, requestedMaxOutputBytes, visibleMaxOutputBytes: maxOutputBytes, logPath: relativeLog }
          await appendFile(path.join(root, "work", ".boom", "command-events.jsonl"), `${JSON.stringify(event)}\n`)
          const visible = data.subarray(0, maxOutputBytes).toString("utf8")
          return { title: `${path.basename(resolved.executable)} · exit ${exitCode}`, output: `${visible}${event.truncated ? "\n[output truncated; see log]\n" : ""}\nlog: ${relativeLog}\nenvironment: ${binding.fingerprint}`, metadata: event }
        } finally {
          clearTimeout(timer)
          ctx.abort.removeEventListener("abort", kill)
        }
      },
    }),
  },
})

export default BoomExecPlugin
