/**
 * Reclassify already-synced local challenges into keyword-derived category folders.
 *
 * Platforms that give no per-challenge category (e.g. DASCTF) get their folder derived from the
 * challenge name (folder name) using the same rules the sync adapter uses.  By default it only
 * prints what would move; pass --apply to actually move folders and rewrite meta.json.
 *
 *   bun scripts/classify-challenges.ts --root ./ctf-workspace [--apply]
 */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { recognizedChallengeCategory } from "../src/challenge.ts"
import { inferChallengeCategory } from "../src/platform/adapters/dasctf.ts"

const argv = process.argv.slice(2)
const rootIndex = argv.indexOf("--root")
const rootValue = rootIndex >= 0 ? argv[rootIndex + 1] : undefined
if (!rootValue) {
  console.error("用法: bun scripts/classify-challenges.ts --root <挑战工作区> [--apply]")
  process.exit(1)
}
const root = path.resolve(rootValue!)
const apply = argv.includes("--apply")

const base = path.join(root, "challenges")
const top = await readdir(base, { withFileTypes: true }).catch(() => {
  throw new Error(`No challenges directory at ${base}`)
})

type Entry = { directory: string; name: string; parent: string | undefined }

const entries: Entry[] = []
for (const item of top) {
  if (!item.isDirectory() || item.name.startsWith(".")) continue
  if (recognizedChallengeCategory(item.name)) {
    const nested = await readdir(path.join(base, item.name), { withFileTypes: true })
    for (const child of nested) {
      if (!child.isDirectory() || child.name.startsWith(".")) continue
      entries.push({ directory: path.join(base, item.name, child.name), name: child.name, parent: item.name })
    }
  } else {
    entries.push({ directory: path.join(base, item.name), name: item.name, parent: undefined })
  }
}

let moved = 0
for (const entry of entries) {
  const metadata = await readFile(path.join(entry.directory, "meta.json"), "utf8")
    .then((raw) => JSON.parse(raw) as { category?: string })
    .catch((): { category?: string } => ({}))
  // The local meta category is itself a previous inference, not platform truth, so it must not be
  // fed back as the platform category — that would freeze every misclassification in place.  The
  // offline signals are the challenge name and the attachment filenames.
  const attachments = await readdir(path.join(entry.directory, "files"), { withFileTypes: true })
    .then((items) => items.filter((item) => item.isFile()).map((item) => item.name))
    .catch(() => [] as string[])
  const inferred = inferChallengeCategory(entry.name, undefined, attachments)
  if (inferred === "OTHER" || (entry.parent !== undefined && entry.parent === inferred)) {
    continue
  }
  const destination = path.join(base, inferred, entry.name)
  const existing = await lstat(destination).catch(() => undefined)
  if (existing) {
    // A stale copy under the wrong category (usually OTHER/) duplicates the slug and breaks the
    // whole challenge list.  The correctly categorized copy wins; drop the stale one.
    if (!apply) {
      console.log(`[dedupe] ${entry.parent ?? "(root)"}/${entry.name} duplicated by ${inferred}/${entry.name}`)
      moved += 1
    } else {
      await rm(entry.directory, { recursive: true, force: true })
      console.log(`[dedupe] removed ${entry.parent ?? "(root)"}/${entry.name}, kept ${inferred}/${entry.name}`)
      moved += 1
    }
    continue
  }
  if (!apply) {
    console.log(`[move]   ${entry.parent ?? "(root)"}/${entry.name} -> ${inferred}/${entry.name}`)
    moved += 1
    continue
  }
  await mkdir(path.dirname(destination), { recursive: true })
  await rename(entry.directory, destination)
  await writeFile(path.join(destination, "meta.json"), `${JSON.stringify({ ...metadata, category: inferred }, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  console.log(`[moved]  ${entry.parent ?? "(root)"}/${entry.name} -> ${inferred}/${entry.name}`)
  moved += 1
}

console.log(apply ? `完成,移动 ${moved} 个题目目录。` : `预览:${moved} 个题目目录会被移动。确认后加 --apply 执行。`)
