import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readdir, realpath } from "node:fs/promises"
import path from "node:path"
export type ArtifactRef = {
  path: string
  description: string
  sha256?: string
}

async function sha256(file: string) {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolve)
  })
  return hash.digest("hex")
}

function inside(base: string, target: string) {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Newest mtime under `work/`, or 0 when nothing is there yet.
 *
 * Deliberately cheaper than `discoverKeyArtifacts`: no hashing and no per-file records, because the
 * in-turn dead-end brake calls this to confirm a suspected stall. Artifact writes produce no distinct
 * runtime event, so a filesystem check is the only way to tell "burned tokens and produced nothing"
 * from "producing files without writing notes".
 */
export async function latestArtifactWrite(directory: string) {
  const root = await realpath(directory)
  const work = path.join(root, "work")
  let newest = 0
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === ".boom") continue
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await visit(target); continue }
      if (!entry.isFile()) continue
      const info = await lstat(target).catch(() => undefined)
      if (!info) continue
      newest = Math.max(newest, info.mtimeMs)
    }
  }
  await visit(work)
  return newest
}

export async function discoverKeyArtifacts(directory: string) {
  const root = await realpath(directory)
  const work = path.join(root, "work")
  const output: ArtifactRef[] = []
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === ".boom" || entry.name === "checkpoints" || entry.name === "branches") continue
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await visit(target); continue }
      if (!entry.isFile()) continue
      const canonical = await realpath(target)
      if (!inside(work, canonical)) continue
      const info = await lstat(canonical)
      if (info.size > 100_000_000) continue
      output.push({
        path: path.relative(root, canonical).split(path.sep).join("/"),
        description: `solver artifact (${info.size} bytes)`,
        sha256: await sha256(canonical),
      })
      if (output.length >= 2_000) return
    }
  }
  await visit(work)
  return output
}
