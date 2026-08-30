import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Challenge } from "./challenge.ts"

export type Workspace = {
  /** Absolute path to `runs/<slug>/<run-id>/`; also the session's directory. */
  directory: string
  runID: string
  /** Attachments unpacked into `work/extracted/<name>/`, relative to the workspace. */
  extracted: string[]
}

const NOTES_SKELETON = `# NOTES

Shared cross-turn, cross-model task memory. Maintained by the ctf-note tool.

## Current goal

Recover and verify the challenge flag.

## Confirmed facts

- None yet.

## Current hypotheses

- None yet.

## Ruled-out directions

- None yet.

## Key artifacts

- None yet.

## Next steps

- Read the challenge statement and attachments.
`

/**
 * `<UTC timestamp>-<model-slug>`, for example `20260728T121459Z-deepseek-v4-flash-free`.
 *
 * Seconds are included because runs of one challenge can now start close together — a retry, or two
 * models on the same slug — and a collision would silently overwrite an existing workspace.
 */
let previousStamp = ""
let sameStampSequence = 0

export function runID(model: string, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  if (stamp === previousStamp) sameStampSequence += 1
  else {
    previousStamp = stamp
    sameStampSequence = 0
  }
  const collisionSuffix = sameStampSequence === 0 ? "" : `-${sameStampSequence + 1}`
  const rawModel = model.split(/[\\/]/).pop() || "model"
  const modelSlug = rawModel.replace(/[\0-\x1f/:\\]/g, "-").replace(/\.\./g, "-")
  return `${stamp}${collisionSuffix}-${modelSlug}`
}

/**
 * Identify an archive by content rather than extension. Real challenge attachments are frequently
 * named after their SHA-256 digest with no extension at all.
 */
export async function archiveKind(file: string): Promise<"zip" | "tar" | "7z" | "rar" | undefined> {
  const handle = Bun.file(file)
  const head = new Uint8Array(await handle.slice(0, 262).arrayBuffer())
  if (head.length < 4) return undefined
  const magic = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte)
  if (magic(0x50, 0x4b)) return "zip" // PK — also docx/xlsx/jar, which are worth unpacking anyway
  if (magic(0x37, 0x7a, 0xbc, 0xaf)) return "7z"
  if (magic(0x52, 0x61, 0x72, 0x21)) return "rar"
  if (magic(0x1f, 0x8b)) return "tar" // gzip, handled by `tar xf`
  if (magic(0x42, 0x5a, 0x68)) return "tar" // bzip2
  if (magic(0xfd, 0x37, 0x7a, 0x58, 0x5a)) return "tar" // xz
  // POSIX tar keeps "ustar" at offset 257.
  if (head.length >= 262 && [0x75, 0x73, 0x74, 0x61, 0x72].every((b, i) => head[257 + i] === b)) return "tar"
  return undefined
}

/**
 * Safety limits for unpacking platform-supplied attachments.
 *
 * Attachments are attacker-controlled archives. A crafted RAR/7z can hang a parser forever (a slot
 * dies mid-competition), a zip/tar bomb can fill the disk, and member names can escape the
 * destination. Every extraction branch therefore gets three layers:
 *
 * 1. A bounded listing pass that enumerates members before extracting anything, rejects unsafe names
 *    (absolute paths, Windows drive letters, `..` segments) and link-type members, and sums declared
 *    uncompressed sizes against the quota.
 * 2. A hard timeout around every spawned tool: SIGTERM to the process group, then SIGKILL after
 *    `KILL_GRACE_MS` — the same convention as `command-executor.ts`. Bun.spawn accepts `detached` on
 *    POSIX; Windows has no process groups, so the direct child kill is the best available there.
 * 3. Byte accounting while extraction runs plus one final measurement of the destination tree, so an
 *    archive whose listing lies about sizes still cannot push more than the quota onto the disk.
 */
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB per attachment
const FREE_DISK_QUOTA_FRACTION = 0.8
const KILL_GRACE_MS = 3_000
const EXTRACT_POLL_INTERVAL_MS = 400
const ZIP_STREAM_CHUNK_BYTES = 1_048_576
const ZIP_REFUSED_MARKER = "BOOM_ZIP_REFUSED:"

/**
 * Hard ceilings for the listing and extract phases. The environment overrides exist so the test
 * suite can exercise the kill path in milliseconds instead of waiting out the production timeouts;
 * leave them unset outside tests.
 */
function timeoutLimit(envName: string, fallback: number) {
  const value = Number(process.env[envName])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const archiveListTimeoutMs = () => timeoutLimit("BOOM_ARCHIVE_LIST_TIMEOUT_MS", 30_000)
const archiveExtractTimeoutMs = () => timeoutLimit("BOOM_ARCHIVE_EXTRACT_TIMEOUT_MS", 120_000)

type ToolRun = {
  code: number | null
  stdout: string
  stderr: string
  /** The binary is missing (spawn failed or classic exit 127): this branch of extraction is unusable. */
  unavailable: boolean
  timedOut: boolean
  overQuota: boolean
}

async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return ""
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * Spawn an untrusted-archive helper with a hard deadline.
 *
 * On expiry — or when the live quota watcher sees the destination tree exceed the quota — the whole
 * process group is terminated (SIGTERM first, SIGKILL after the grace period) so no parser can wedge
 * a run slot open indefinitely.
 */
async function runTool(
  command: string[],
  options: { timeoutMs: number; watch?: { destination: string; quotaBytes: number } },
): Promise<ToolRun> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Spread at call time: Bun snapshots the parent environment at startup, so a child spawned
      // without an explicit env would miss runtime PATH edits (the test suite's tool mocks rely on
      // them to substitute a hung archive tool).
      env: { ...process.env } as Record<string, string>,
      detached: process.platform !== "win32",
    })
  } catch {
    return { code: null, stdout: "", stderr: "", unavailable: true, timedOut: false, overQuota: false }
  }
  const pid = child.pid
  const killGroup = (signal: NodeJS.Signals) => {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal)
        return
      } catch {}
    }
    try { child.kill(signal) } catch {}
  }
  let timedOut = false
  let overQuota = false
  const terminate = () => {
    killGroup("SIGTERM")
    setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref?.()
  }
  const timer = setTimeout(() => {
    timedOut = true
    terminate()
  }, options.timeoutMs)
  timer.unref?.()
  // Live accounting: catch bombs whose listing under-reports their real size while bytes are still
  // being written, instead of discovering the flood only after extraction finishes.
  const watcher = options.watch
    ? setInterval(() => {
        void directoryBytes(options.watch!.destination)
          .then((bytes) => {
            if (bytes > options.watch!.quotaBytes && !timedOut && !overQuota) {
              overQuota = true
              terminate()
            }
          })
          .catch(() => {})
      }, EXTRACT_POLL_INTERVAL_MS)
    : undefined
  watcher?.unref?.()

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    drain(child.stdout),
    drain(child.stderr),
  ])
  clearTimeout(timer)
  if (watcher) clearInterval(watcher)
  return { code, stdout, stderr, unavailable: code === 127, timedOut, overQuota }
}

/** Total bytes of regular files under `directory`; symlinks are counted as nothing and never followed. */
async function directoryBytes(directory: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(target)
    else if (!entry.isSymbolicLink()) {
      const info = await lstat(target).catch(() => undefined)
      total += info?.size ?? 0
    }
  }
  return total
}

/**
 * Per-attachment ceiling: at most 2 GiB uncompressed and at most most-of-the-free-disk. Failing to
 * measure free space falls back to the flat cap rather than skipping the check.
 */
async function extractionQuotaBytes(destination: string): Promise<number> {
  try {
    const usage = await statfs(destination)
    const freeBytes = Number(usage.bavail) * Number(usage.bsize)
    return Math.min(MAX_UNCOMPRESSED_BYTES, Math.floor(freeBytes * FREE_DISK_QUOTA_FRACTION))
  } catch {
    return MAX_UNCOMPRESSED_BYTES
  }
}

/**
 * A member name must resolve inside the destination: no absolute paths, no Windows drive letters,
 * no `..` segments. Backslash separators are checked too because ZIP stores names verbatim.
 */
function unsafeArchiveMember(name: string): boolean {
  const normalized = name.replace(/\\/g, "/")
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return true
  return normalized.split("/").includes("..")
}

/** Refuse to extract anything once one member violates the name rules or the declared size budget. */
function assertSafeMembers(
  members: { name: string; size: number }[],
  linkViolations: string[],
  quotaBytes: number,
) {
  const violations = [
    ...members.filter((member) => unsafeArchiveMember(member.name)).map((member) => member.name),
    ...linkViolations,
  ]
  if (violations.length > 0)
    throw new Error(`unsafe archive member(s) rejected: ${violations.join(", ")}`)
  const declared = members.reduce((sum, member) => sum + member.size, 0)
  if (declared > quotaBytes)
    throw new Error(
      `archive declares ${declared} bytes uncompressed, above the ${quotaBytes}-byte extraction quota`,
    )
}

function assertTimely(run: ToolRun, phase: string, limit: number) {
  if (run.timedOut) throw new Error(`attachment archive ${phase} timed out after ${limit}ms and was killed`)
}

/** Settle an extraction spawn into the legacy boolean result, refusing on timeout or quota breach. */
async function settleExtraction(
  run: ToolRun,
  tool: string,
  quotaBytes: number,
  finish: () => Promise<boolean>,
): Promise<boolean> {
  assertTimely(run, `extraction via ${tool}`, archiveExtractTimeoutMs())
  if (run.unavailable) return false
  if (run.overQuota)
    throw new Error(`archive passed the ${quotaBytes}-byte extraction quota while ${tool} was writing`)
  if (run.code !== 0) return false
  return finish()
}

/**
 * One verbose tar line. bsdtar prints `-rw-r--r-- 0 owner group SIZE DATE name`, GNU prints
 * `-rw-r--r-- owner/group SIZE DATE name`. Link members carry an `l`/`h` type flag (bsdtar marks
 * hard links with `h... link to target`). Unparsable lines yield undefined; callers then fall back
 * to name rules alone with size enforcement left to the live watcher and the final measurement.
 */
function parseTarVerboseLine(line: string): { name: string; size: number; link: boolean } | undefined {
  const bsdtar = line.match(/^(\S{10})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/)
  if (bsdtar) return describeTarMember(bsdtar[1]!, Number(bsdtar[5]), bsdtar[6]!)
  const gnu = line.match(/^(\S{10})\s+(\S+)\s+(\d+)\s+(.*)$/)
  if (gnu) return describeTarMember(gnu[1]!, Number(gnu[3]), gnu[4]!)
  return undefined
}

function describeTarMember(mode: string, size: number, rest: string) {
  const type = mode[0]
  const name = rest.split(/ [-=]> | link to /, 1)[0]?.trim() || rest.trim()
  return { name, size, link: type === "l" || type === "h" }
}

/**
 * `unzip -l` data rows sit between two dash separator lines:
 * `     5  01-01-2026 12:00   name`. Returns undefined when the layout is unrecognized so the caller
 * refuses to extract blind instead of trusting a partial parse.
 */
function parseUnzipListing(output: string): { name: string; size: number }[] | undefined {
  const lines = output.split("\n")
  const start = lines.findIndex((line) => line.startsWith("---------"))
  if (start < 0) return undefined
  let end = start + 1
  while (end < lines.length && !lines[end]!.startsWith("---------")) end += 1
  const members: { name: string; size: number }[] = []
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    if (!match) return undefined
    members.push({ name: match[4]!.trim(), size: Number(match[1]) })
  }
  return members
}

/**
 * `7z l -slt` emits one block per entry after the first `----------` line, with `Path = `, `Size = `,
 * and — for POSIX archives holding links — non-empty `Symbolic Link = ` / `Hard Link = ` fields.
 */
function parseSevenZipListing(output: string): {
  members: { name: string; size: number }[]
  linkViolations: string[]
} {
  const members: { name: string; size: number }[] = []
  const linkViolations: string[] = []
  let started = false
  let current: { name?: string; size: number } | undefined
  const flush = () => {
    if (current?.name !== undefined) members.push({ name: current.name, size: current.size })
    current = undefined
  }
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.startsWith("----------")) {
      flush()
      started = true
      continue
    }
    if (!started) continue
    const field = line.match(/^(.+?) = (.*)$/)
    if (!field) {
      flush()
      continue
    }
    const [, key, value] = field
    if (key === "Path") {
      flush()
      current = { name: value, size: 0 }
    } else if (key === "Size" && current) {
      current.size = Number(value) || 0
    } else if ((key === "Symbolic Link" || key === "Hard Link") && current?.name && value.trim()) {
      linkViolations.push(current.name)
    }
  }
  flush()
  return { members, linkViolations }
}

/**
 * List a zip with `unzip -l`. Returns undefined when unzip is missing or cannot read the archive —
 * the caller then skips this branch entirely rather than extracting without a pre-check.
 */
async function listZipMembers(file: string): Promise<{ name: string; size: number }[] | undefined> {
  const listing = await runTool(["unzip", "-l", file], { timeoutMs: archiveListTimeoutMs() })
  assertTimely(listing, "listing (unzip -l)", archiveListTimeoutMs())
  if (listing.unavailable || listing.code !== 0) return undefined
  return parseUnzipListing(listing.stdout)
}

/**
 * Unpack one layer of an archive into `destination`.
 *
 * Only the first layer is unpacked: nested archives, password protection, and forged headers are
 * routinely the puzzle itself, so they stay for the agent to deal with. Every branch validates a
 * member listing first, runs its extractor under a hard timeout with live quota polling, and only
 * then reports success after measuring what actually landed. Policy violations (path traversal,
 * link members, quota breaches, tool hangs) throw so the failure surfaces in the run's result/detail
 * chain; a merely missing or failing tool keeps the historical lenient `false`.
 */
async function unpack(file: string, kind: string, destination: string) {
  await mkdir(destination, { recursive: true })
  const quotaBytes = await extractionQuotaBytes(destination)
  const discard = () => rm(destination, { recursive: true, force: true }).catch(() => {})
  const watch = { destination, quotaBytes }
  const finish = async (): Promise<boolean> => {
    // Final consistency check: measure what actually landed. A forged listing that under-reports
    // sizes is caught here even if it slipped past both the pre-check and the live polling.
    const actual = await directoryBytes(destination)
    if (actual > quotaBytes) {
      await discard()
      throw new Error(
        `archive wrote ${actual} bytes, above the ${quotaBytes}-byte extraction quota; extraction discarded`,
      )
    }
    return (await readdir(destination)).length > 0
  }

  if (kind === "zip") {
    // Names inside Chinese CTF archives are usually GBK, and the ZIP central directory has no
    // encoding field unless the UTF-8 flag is set. macOS ships Apple's stripped Info-ZIP, which
    // rejects `-O GBK` and fails outright on such names, so decode them here instead. The script
    // enforces the name rules, link rejection, and the quota itself, streaming entries in chunks.
    const python = await runTool(["python3", "-c", ZIP_EXTRACTOR, file, destination, String(quotaBytes)], {
      timeoutMs: archiveExtractTimeoutMs(),
      watch,
    })
    if (!python.unavailable) {
      assertTimely(python, "extraction via python3 zipfile", archiveExtractTimeoutMs())
      const refusedAt = python.stderr.indexOf(ZIP_REFUSED_MARKER)
      if (refusedAt >= 0) {
        const reason = python.stderr.slice(refusedAt + ZIP_REFUSED_MARKER.length).split("\n")[0]?.trim()
        await discard()
        throw new Error(`unsafe archive rejected: ${reason || "policy violation"}`)
      }
      if (python.overQuota) {
        await discard()
        throw new Error(`archive passed the ${quotaBytes}-byte extraction quota while extracting`)
      }
      if (python.code === 0) return finish()
      // Any other failure (odd zip, broken interpreter) falls through to unzip below, which is
      // guarded by its own listing pass.
    }
    const members = await listZipMembers(file)
    if (members === undefined) return false
    assertSafeMembers(members, [], quotaBytes)
    const run = await runTool(["unzip", "-qq", "-o", file, "-d", destination], {
      timeoutMs: archiveExtractTimeoutMs(),
      watch,
    })
    return settleExtraction(run, "unzip", quotaBytes, finish)
  }

  if (kind === "tar") {
    const names = await runTool(["tar", "-tf", file], { timeoutMs: archiveListTimeoutMs() })
    assertTimely(names, "listing (tar -tf)", archiveListTimeoutMs())
    if (names.unavailable || names.code !== 0) return false
    const verbose = await runTool(["tar", "-tvf", file], { timeoutMs: archiveListTimeoutMs() })
    assertTimely(verbose, "listing (tar -tvf)", archiveListTimeoutMs())
    const memberNames = names.stdout.split("\n").filter((line) => line.length > 0)
    const parsedLines = verbose.stdout.split("\n").map(parseTarVerboseLine)
    const parsed = parsedLines.filter((line): line is NonNullable<typeof line> => line !== undefined)
    // Names always come from the bare listing — it is authoritative, while verbose date formats vary
    // enough to mangle name extraction. Sizes pair with names only when every verbose line parsed
    // into the same number of members; otherwise sizes stay unknown and the live watcher plus final
    // measurement carry the quota.
    const members =
      parsed.length === memberNames.length
        ? memberNames.map((name, index) => ({ name, size: parsed[index]!.size }))
        : memberNames.map((name) => ({ name, size: 0 }))
    const linkViolations = parsed.filter(({ link }) => link).map(({ name }) => name)
    assertSafeMembers(members, linkViolations, quotaBytes)
    const run = await runTool(["tar", "xf", file, "-C", destination], {
      timeoutMs: archiveExtractTimeoutMs(),
      watch,
    })
    return settleExtraction(run, "tar", quotaBytes, finish)
  }

  if (kind === "7z") {
    const listing = await runTool(["7z", "l", "-slt", file], { timeoutMs: archiveListTimeoutMs() })
    assertTimely(listing, "listing (7z l -slt)", archiveListTimeoutMs())
    if (listing.unavailable || listing.code !== 0) return false
    const { members, linkViolations } = parseSevenZipListing(listing.stdout)
    assertSafeMembers(members, linkViolations, quotaBytes)
    const run = await runTool(["7z", "x", "-y", `-o${destination}`, file], {
      timeoutMs: archiveExtractTimeoutMs(),
      watch,
    })
    return settleExtraction(run, "7z", quotaBytes, finish)
  }

  // RAR: `unar` has no listing mode. When `unrar` happens to be installed its bare listing provides
  // the name pre-check (sizes are not summed here, so this branch leans on the hard timeout, live
  // quota polling, and the final measurement for volume). Without unrar this branch extracts with
  // those three runtime guards only; unar itself rewrites absolute/traversing member paths, but the
  // residual risk of an unchecked name is accepted and noted here deliberately.
  const rarListing = await runTool(["unrar", "lb", file], { timeoutMs: archiveListTimeoutMs() })
  assertTimely(rarListing, "listing (unrar lb)", archiveListTimeoutMs())
  if (!rarListing.unavailable && rarListing.code === 0)
    assertSafeMembers(
      rarListing.stdout.split("\n").filter(Boolean).map((name) => ({ name, size: 0 })),
      [],
      quotaBytes,
    )
  const run = await runTool(["unar", "-o", destination, file], {
    timeoutMs: archiveExtractTimeoutMs(),
    watch,
  })
  return settleExtraction(run, "unar", quotaBytes, finish)
}

/**
 * Extract a ZIP, recovering legacy-encoded entry names. Python's zipfile decodes non-UTF-8 names as
 * cp437, so re-encoding that and trying GBK first restores the original Chinese filenames.
 *
 * The script is the zip branch's guard as well as its extractor. Before writing anything it applies
 * the shared policy to every entry — no absolute/drive/`..` names, no symlink members, and the sum
 * of declared `file_size` values against the quota passed in as argv[3] — and refuses with the
 * `BOOM_ZIP_REFUSED` marker (which the caller turns into a thrown error) on any violation, removing
 * what it already created. Data is then streamed in 1 MiB chunks instead of `source.read()`, so a
 * single entry cannot balloon host memory, with a running byte count that aborts and cleans up if
 * the declared sizes lied.
 */
const ZIP_EXTRACTOR = `
import os, stat, sys, zipfile
src, dest, quota = sys.argv[1], sys.argv[2], int(sys.argv[3])
realdest = os.path.realpath(dest)
made_files = []
made_dirs = []

def refuse(reason):
    for path_ in made_files:
        try: os.unlink(path_)
        except OSError: pass
    for dir_ in reversed(made_dirs):
        try: os.rmdir(dir_)
        except OSError: pass
    sys.stderr.write("BOOM_ZIP_REFUSED: %s\\n" % reason)
    sys.exit(2)

def decode_name(info):
    name = info.filename
    if not info.flag_bits & 0x800:
        raw = name.encode("cp437", "replace")
        for encoding in ("gbk", "big5", "shift_jis", "utf-8"):
            try:
                name = raw.decode(encoding); break
            except UnicodeDecodeError:
                continue
    return name

def safe_target(name):
    target = realdest
    for part in name.replace("\\\\", "/").split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            return None
        target = os.path.join(target, part)
    return None if target == realdest else target

with zipfile.ZipFile(src) as z:
    infos = z.infolist()
    declared = 0
    for info in infos:
        name = info.filename
        if name.startswith("/") or (len(name) >= 2 and name[1] == ":"):
            refuse("member escapes the destination: %s" % name)
        if safe_target(decode_name(info)) is None:
            refuse("member escapes the destination: %s" % name)
        if stat.S_ISLNK(info.external_attr >> 16):
            refuse("symlink member is not allowed: %s" % name)
        declared += info.file_size
        if declared > quota:
            refuse("declared content exceeds the extraction quota (%d > %d bytes)" % (declared, quota))
    written = 0
    for info in infos:
        target = safe_target(decode_name(info))
        if info.is_dir():
            os.makedirs(target, exist_ok=True)
            made_dirs.append(target)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        made_dirs.append(os.path.dirname(target))
        made_files.append(target)
        with z.open(info) as source, open(target, "wb") as out:
            while True:
                chunk = source.read(1048576)
                if not chunk:
                    break
                written += len(chunk)
                if written > quota:
                    refuse("content exceeds the extraction quota (%d > %d bytes)" % (written, quota))
                out.write(chunk)
`

/**
 * Build an isolated run workspace. Known answers never enter it; challenge inputs are copied, `work/`
 * exists before Boom starts, and NOTES.md is seeded for the agent's mandatory opening read.
 */
export async function prepareWorkspace(
  root: string,
  challenge: Challenge,
  model: string,
  options: { initialNotes?: string } = {},
): Promise<Workspace> {
  const canonicalRoot = await realpath(path.resolve(root))
  const runsPath = path.join(canonicalRoot, "runs")
  await mkdir(runsPath, { recursive: true })
  const runsRoot = await realpath(runsPath)
  if (!isInside(canonicalRoot, runsRoot)) throw new Error(`Runs directory escapes Boom root: ${runsPath}`)
  if (challenge.slug === "." || challenge.slug === ".." || /[\\/]/.test(challenge.slug))
    throw new Error(`Invalid challenge slug: ${challenge.slug}`)
  const parent = path.join(runsRoot, challenge.slug)
  await mkdir(parent, { recursive: true })
  let id = ""
  let directory = ""
  while (true) {
    id = runID(model)
    directory = path.join(parent, id)
    try {
      await mkdir(directory)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  const challengeDirectory = path.join(directory, "challenge")

  await mkdir(path.join(directory, "work"), { recursive: true })
  await mkdir(challengeDirectory, { recursive: true })

  const sourceRoot = await realpath(challenge.directory)
  for (const file of challenge.files) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
      throw new Error(`Challenge attachment escapes its directory: ${file}`)
    const source = path.join(sourceRoot, file)
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
      throw new Error(`Challenge attachment is not a real file: ${file}`)
    const canonicalSource = await realpath(source)
    if (!isInside(sourceRoot, canonicalSource))
      throw new Error(`Challenge attachment escapes its directory: ${file}`)
    const destination = path.join(challengeDirectory, file)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(canonicalSource, destination)
  }

  // Unpack the outer archive layer so the agent starts from the real file tree instead of spending
  // tokens on mechanical unwrapping. The original archive stays in `challenge/`. A rejected archive
  // (traversal member, link member, quota breach, hung tool) fails the run loudly — the error text
  // reaches the job's result/detail chain — and leaves no half-extracted debris behind.
  const extracted: string[] = []
  for (const file of challenge.files) {
    const source = path.join(challengeDirectory, file)
    const kind = await archiveKind(source).catch(() => undefined)
    if (kind === undefined) continue
    const name = path.basename(file).replace(/\.[^.]*$/, "") || path.basename(file)
    const target = path.join(directory, "work", "extracted", name)
    let unpacked = false
    try {
      unpacked = await unpack(source, kind, target)
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => {})
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to unpack ${path.basename(file)} (${kind}): ${reason}`)
    }
    if (unpacked) extracted.push(path.join("work", "extracted", name))
  }

  await writeFile(
    path.join(challengeDirectory, "challenge.json"),
    JSON.stringify(
      {
        slug: challenge.slug,
        category: challenge.category ?? "OTHER",
        ...(challenge.difficulty ? { difficulty: challenge.difficulty } : {}),
        description: challenge.description,
        flag_format: challenge.flagFormat,
        files: challenge.files,
        ...(extracted.length === 0 ? {} : { extracted }),
        ...(challenge.remote === undefined ? {} : { remote: challenge.remote }),
        ...(challenge.serviceRequired === undefined ? {} : { service_required: challenge.serviceRequired }),
      },
      undefined,
      2,
    ) + "\n",
    "utf8",
  )
  const initialNotes = options.initialNotes?.trim()
  await writeFile(
    path.join(directory, "NOTES.md"),
    initialNotes ? `${initialNotes}\n` : NOTES_SKELETON,
    "utf8",
  )

  // Enforce read-only on the filesystem, not just in the prompt and edit rules. `bash` is allowed and
  // would otherwise let the agent modify or delete the original evidence, making a failed run
  // impossible to reproduce. Extraction above is already finished, so this cannot block it.
  await protect(challengeDirectory)
  return { directory, runID: id, extracted }
}

function isInside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Make the copied attachments read-only.
 *
 * Files lose write permission; directories keep theirs. A read-only directory would also block
 * unlinking its entries, which makes the whole run workspace impossible to delete afterwards without
 * a manual `chmod -R`. Files being read-only is enough to protect the evidence from an in-place edit,
 * and the agent has no reason to delete them.
 */
async function protect(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await protect(target)
    else await chmod(target, 0o444).catch(() => {})
  }
}
