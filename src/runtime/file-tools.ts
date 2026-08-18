import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { resolveTaskPath, type ResolvedTaskPath } from "./policy.ts"

export type BoomFileToolName = "read" | "list" | "glob" | "grep" | "edit"

export type BoomFileToolResult = {
  title: string
  output: string
  metadata?: Record<string, unknown>
}

const MAX_VISIBLE_BYTES = 32_768
const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_SCAN_BYTES = 32 * 1024 * 1024
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024
const MAX_WALK_ENTRIES = 10_000
const MAX_LINE_CHARACTERS = 2_000

type WalkEntry = {
  absolute: string
  relative: string
  directory: boolean
  symbolicLink: boolean
  size: number
}

function inside(base: string, target: string): boolean {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function openTaskFile(target: ResolvedTaskPath, write = false) {
  const flags = (write ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(target.absolute, flags)
  try {
    const descriptor = process.platform === "linux"
      ? `/proc/self/fd/${handle.fd}`
      : process.platform === "darwin"
        ? `/dev/fd/${handle.fd}`
        : target.absolute
    const canonical = await realpath(descriptor)
    if (!inside(target.root, canonical)) throw new Error(`Opened task file escapes the workspace: ${target.relative}`)
    if (write) {
      const relative = path.relative(target.root, canonical).split(path.sep).join("/")
      if (!relative.startsWith("work/") || relative.startsWith("work/.boom/") || relative === "work/RESULT.json")
        throw new Error(`Opened task file escapes the writable workspace: ${target.relative}`)
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

function string(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = input[key]
  if (typeof value === "string") return value
  if (fallback !== undefined) return fallback
  throw new Error(`${key} must be a string`)
}

function integer(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key]
  return typeof value === "number" && Number.isInteger(value) ? value : fallback
}

function visible(text: string): { output: string; truncated: boolean } {
  const encoded = Buffer.from(text)
  if (encoded.byteLength <= MAX_VISIBLE_BYTES) return { output: text, truncated: false }
  const suffix = "\n… output truncated by Boom …"
  const budget = MAX_VISIBLE_BYTES - Buffer.byteLength(suffix)
  return {
    output: new TextDecoder().decode(encoded.subarray(0, Math.max(0, budget))) + suffix,
    truncated: true,
  }
}

function assertPattern(pattern: string, label: string): void {
  if (!pattern || pattern.includes("\0")) throw new Error(`${label} must be non-empty and contain no NUL`)
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]+/).includes(".."))
    throw new Error(`${label} must stay inside its task-relative search root`)
}

function displayLine(line: string): string {
  return line.length <= MAX_LINE_CHARACTERS ? line : `${line.slice(0, MAX_LINE_CHARACTERS)}…`
}

async function walk(root: string, signal?: AbortSignal): Promise<WalkEntry[]> {
  const found: WalkEntry[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted()
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (entry.name === ".boom") continue
      if (entry.name === "RESULT.json" && (prefix === "work" || path.basename(directory) === "work")) continue
      if (found.length >= MAX_WALK_ENTRIES)
        throw new Error(`Task tree exceeds Boom's ${MAX_WALK_ENTRIES}-entry scan limit`)
      const absolute = path.join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const info = await lstat(absolute)
      const symbolicLink = info.isSymbolicLink()
      found.push({
        absolute,
        relative,
        directory: !symbolicLink && info.isDirectory(),
        symbolicLink,
        size: info.size,
      })
      if (!symbolicLink && info.isDirectory()) await visit(absolute, relative)
    }
  }
  await visit(root, "")
  return found
}

async function executeRead(input: Record<string, unknown>, directory: string): Promise<BoomFileToolResult> {
  const requested = string(input, "filePath")
  const target = await resolveTaskPath(directory, requested)
  const handle = await openTaskFile(target)
  let bytes: Buffer
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`read requires a regular file: ${requested}`)
    if (info.size > MAX_READ_BYTES)
      throw new Error(`read file exceeds Boom's ${MAX_READ_BYTES}-byte limit: ${requested}`)
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  if (bytes.includes(0)) return {
    title: target.relative,
    output: `<binary file: ${bytes.byteLength} bytes>`,
    metadata: { path: target.relative, size: bytes.byteLength, binary: true, truncated: false },
  }
  const offset = integer(input, "offset", 1)
  const limit = integer(input, "limit", 2_000)
  const lines = bytes.toString("utf8").split(/\r?\n/)
  const start = Math.max(0, offset - 1)
  const selected = lines.slice(start, start + limit)
  const rendered = selected.map((line, index) => `${String(start + index + 1).padStart(6)} | ${displayLine(line)}`).join("\n")
  const bounded = visible(rendered || `<no lines at offset ${offset}>`)
  return {
    title: target.relative,
    output: bounded.output,
    metadata: {
      path: target.relative,
      size: bytes.byteLength,
      offset,
      returnedLines: selected.length,
      truncated: bounded.truncated || start + selected.length < lines.length,
    },
  }
}

async function executeList(input: Record<string, unknown>, directory: string): Promise<BoomFileToolResult> {
  const requested = string(input, "path", ".")
  const target = await resolveTaskPath(directory, requested)
  if (!(await lstat(target.absolute)).isDirectory()) throw new Error(`list requires a directory: ${requested}`)
  const offset = integer(input, "offset", 1)
  const limit = integer(input, "limit", 200)
  const entries = (await readdir(target.absolute, { withFileTypes: true }))
    .filter((entry) =>
      entry.name !== ".boom" &&
      !(entry.name === "RESULT.json" && (target.relative === "work" || target.relative === "."))
    )
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const selected = entries.slice(offset - 1, offset - 1 + limit)
  const lines: string[] = []
  for (const entry of selected) {
    const info = await lstat(path.join(target.absolute, entry.name))
    const suffix = info.isSymbolicLink() ? "@" : info.isDirectory() ? "/" : ""
    lines.push(`${entry.name}${suffix}`)
  }
  const bounded = visible(lines.join("\n") || "<empty directory>")
  return {
    title: target.relative,
    output: bounded.output,
    metadata: {
      path: target.relative,
      offset,
      returnedEntries: selected.length,
      totalEntries: entries.length,
      truncated: bounded.truncated || offset - 1 + selected.length < entries.length,
    },
  }
}

async function executeGlob(
  input: Record<string, unknown>,
  directory: string,
  signal?: AbortSignal,
): Promise<BoomFileToolResult> {
  const pattern = string(input, "pattern")
  assertPattern(pattern, "glob pattern")
  const requested = string(input, "path", ".")
  const target = await resolveTaskPath(directory, requested)
  if (!(await lstat(target.absolute)).isDirectory()) throw new Error(`glob path must be a directory: ${requested}`)
  const matcher = new Bun.Glob(pattern)
  const limit = integer(input, "limit", 200)
  const entries = (await walk(target.absolute, signal))
    .filter((entry) => matcher.match(entry.relative))
    .slice(0, limit)
  const lines = entries.map((entry) => {
    const relative = target.relative === "." ? entry.relative : `${target.relative}/${entry.relative}`
    return `${relative}${entry.symbolicLink ? "@" : entry.directory ? "/" : ""}`
  })
  const bounded = visible(lines.join("\n") || "<no matches>")
  return {
    title: `${pattern} in ${target.relative}`,
    output: bounded.output,
    metadata: { pattern, path: target.relative, matches: entries.length, limit, truncated: bounded.truncated },
  }
}

async function executeGrep(
  input: Record<string, unknown>,
  directory: string,
  signal?: AbortSignal,
): Promise<BoomFileToolResult> {
  const pattern = string(input, "pattern")
  if (!pattern || pattern.length > 1_000) throw new Error("grep pattern must contain 1-1000 characters")
  const requested = string(input, "path", ".")
  const target = await resolveTaskPath(directory, requested)
  if (!(await lstat(target.absolute)).isDirectory()) throw new Error(`grep path must be a directory: ${requested}`)
  const include = input.include === undefined ? undefined : string(input, "include")
  if (include !== undefined) assertPattern(include, "grep include pattern")
  const includeMatcher = include === undefined ? undefined : new Bun.Glob(include)
  const limit = integer(input, "limit", 100)
  const eligible = (await walk(target.absolute, signal)).filter((entry) =>
    !entry.directory && !entry.symbolicLink && entry.size <= MAX_SCAN_FILE_BYTES &&
    (!includeMatcher || includeMatcher.match(entry.relative)),
  )
  const scannedBytes = eligible.reduce((total, entry) => total + entry.size, 0)
  if (scannedBytes > MAX_SCAN_BYTES) throw new Error(`grep exceeds Boom's ${MAX_SCAN_BYTES}-byte scan limit`)
  const executable = Bun.which("rg")
  if (!executable) throw new Error("Boom grep requires ripgrep (rg) on the system PATH")
  const command = [
    executable,
    "--no-follow", "--hidden", "--no-ignore", "--line-number", "--with-filename",
    "--color", "never", "--max-filesize", String(MAX_SCAN_FILE_BYTES),
    "--max-columns", String(MAX_LINE_CHARACTERS), "--max-columns-preview",
    ...(include ? ["--glob", include] : []),
    "--", pattern, ".",
  ]
  signal?.throwIfAborted()
  const child = Bun.spawn(command, {
    cwd: target.absolute,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const matches: string[] = []
  let pending = ""
  let timedOut = false
  const stop = () => child.kill("SIGTERM")
  const abort = () => stop()
  signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, 10_000)
  const consume = async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    while (matches.length < limit) {
      const item = await reader.read()
      if (item.done) break
      pending += decoder.decode(item.value, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      for (const line of lines) {
        if (!line) continue
        const normalized = line.replace(/^\.\//, "")
        matches.push(target.relative === "." ? normalized : `${target.relative}/${normalized}`)
        if (matches.length >= limit) {
          stop()
          break
        }
      }
    }
  }
  let exitCode: number
  let stderr: string
  try {
    ;[exitCode, , stderr] = await Promise.all([
      child.exited,
      consume(),
      new Response(child.stderr).text(),
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
  signal?.throwIfAborted()
  if (timedOut) throw new Error("grep exceeded Boom's 10-second execution limit")
  if (exitCode > 1 && matches.length === 0) throw new Error(`Invalid grep request: ${stderr.trim().slice(0, 1_000)}`)
  const bounded = visible(matches.join("\n") || "<no matches>")
  return {
    title: `/${pattern}/ in ${target.relative}`,
    output: bounded.output,
    metadata: {
      pattern,
      path: target.relative,
      include,
      matches: matches.length,
      scannedBytes,
      limit,
      truncated: bounded.truncated || matches.length >= limit,
    },
  }
}

async function executeEdit(input: Record<string, unknown>, directory: string): Promise<BoomFileToolResult> {
  const requested = string(input, "filePath")
  const target = await resolveTaskPath(directory, requested, "write")
  const oldString = string(input, "oldString")
  const newString = string(input, "newString")
  if (oldString === newString) throw new Error("edit oldString and newString must differ")
  const handle = await openTaskFile(target, true)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error(`edit requires a regular file: ${requested}`)
    if (info.size > MAX_READ_BYTES)
      throw new Error(`edit file exceeds Boom's ${MAX_READ_BYTES}-byte limit: ${requested}`)
    const sourceBytes = await handle.readFile()
    if (sourceBytes.includes(0)) throw new Error(`edit refuses a binary file: ${requested}`)
    const source = sourceBytes.toString("utf8")
    const occurrences = source.split(oldString).length - 1
    if (occurrences === 0) throw new Error("edit oldString was not found")
    const replaceAll = input.replaceAll === true
    if (!replaceAll && occurrences !== 1)
      throw new Error(`edit oldString is ambiguous: found ${occurrences} occurrences`)
    const output = replaceAll ? source.split(oldString).join(newString) : source.replace(oldString, newString)
    const outputBytes = Buffer.from(output)
    await handle.write(outputBytes, 0, outputBytes.byteLength, 0)
    await handle.truncate(outputBytes.byteLength)
    await handle.sync()
    return {
      title: target.relative,
      output: `Replaced ${replaceAll ? occurrences : 1} occurrence${occurrences === 1 ? "" : "s"} in ${target.relative}.`,
      metadata: { path: target.relative, replacements: replaceAll ? occurrences : 1, bytes: outputBytes.byteLength },
    }
  } finally {
    await handle.close()
  }
}

export async function executeBoomFileTool(input: {
  name: BoomFileToolName
  arguments: Record<string, unknown>
  directory: string
  signal?: AbortSignal
}): Promise<BoomFileToolResult> {
  if (input.name === "read") return executeRead(input.arguments, input.directory)
  if (input.name === "list") return executeList(input.arguments, input.directory)
  if (input.name === "glob") return executeGlob(input.arguments, input.directory, input.signal)
  if (input.name === "grep") return executeGrep(input.arguments, input.directory, input.signal)
  return executeEdit(input.arguments, input.directory)
}
