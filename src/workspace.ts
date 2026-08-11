import { chmod, copyFile, lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises"
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

这是跨轮次、跨模型共享的任务记忆。由 ctf-note 工具维护。

## 当前目标

恢复并验证题目 flag。

## 已确认事实

- 暂无。

## 当前假设

- 暂无。

## 已排除方向

- 暂无。

## 关键产物

- 暂无。

## 下一步计划

- 阅读题目说明与附件。
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
 * Unpack one layer of an archive into `destination`.
 *
 * Only the first layer is unpacked: nested archives, password protection, and forged headers are
 * routinely the puzzle itself, so they stay for the agent to deal with.
 */
async function unpack(file: string, kind: string, destination: string) {
  await mkdir(destination, { recursive: true })
  const run = async (command: string[]) => {
    const code = await Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).exited.catch(() => 1)
    return code === 0 && (await readdir(destination)).length > 0
  }

  if (kind === "zip") {
    // Names inside Chinese CTF archives are usually GBK, and the ZIP central directory has no
    // encoding field unless the UTF-8 flag is set. macOS ships Apple's stripped Info-ZIP, which
    // rejects `-O GBK` and fails outright on such names, so decode them here instead.
    if (await run(["python3", "-c", ZIP_EXTRACTOR, file, destination])) return true
    return run(["unzip", "-qq", "-o", file, "-d", destination])
  }
  if (kind === "tar") return run(["tar", "xf", file, "-C", destination])
  if (kind === "7z") return run(["7z", "x", "-y", `-o${destination}`, file])
  return run(["unar", "-o", destination, file])
}

/**
 * Extract a ZIP, recovering legacy-encoded entry names. Python's zipfile decodes non-UTF-8 names as
 * cp437, so re-encoding that and trying GBK first restores the original Chinese filenames. Entries
 * that would escape the destination are skipped.
 */
const ZIP_EXTRACTOR = `
import os, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        name = info.filename
        if not info.flag_bits & 0x800:
            raw = name.encode("cp437", "replace")
            for encoding in ("gbk", "big5", "shift_jis", "utf-8"):
                try:
                    name = raw.decode(encoding); break
                except UnicodeDecodeError:
                    continue
        target = os.path.normpath(os.path.join(dest, name))
        if not target.startswith(os.path.realpath(dest) + os.sep) and target != os.path.realpath(dest):
            if not os.path.abspath(target).startswith(os.path.abspath(dest) + os.sep):
                continue
        if info.is_dir():
            os.makedirs(target, exist_ok=True); continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with z.open(info) as source, open(target, "wb") as out:
            out.write(source.read())
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
  // tokens on mechanical unwrapping. The original archive stays in `challenge/`.
  const extracted: string[] = []
  for (const file of challenge.files) {
    const source = path.join(challengeDirectory, file)
    const kind = await archiveKind(source).catch(() => undefined)
    if (kind === undefined) continue
    const name = path.basename(file).replace(/\.[^.]*$/, "") || path.basename(file)
    const target = path.join(directory, "work", "extracted", name)
    if (await unpack(source, kind, target)) extracted.push(path.join("work", "extracted", name))
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
