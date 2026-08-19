import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readdir, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { Challenge, ChallengeCategory } from "../challenge.ts"
import { MAX_BUNDLE_BYTES } from "./protocol.ts"

const MANIFEST_NAME = "boom-relay-manifest.json"
const INPUT_PREFIX = "input/"
const MAX_BUNDLE_FILES = 10_000

export type RelayChallengeBundle = {
  version: 1
  kind: "challenge"
  challengeID: string
  slug: string
  category: ChallengeCategory
  description: string
  flagFormat: string
  files: string[]
  difficulty?: string
  serviceRequired?: boolean
  platform?: Challenge["platform"]
}

export type RelayArtifactBundle = {
  version: 1
  kind: "result" | "writeup"
  files: string[]
}

export type StoredBundle = {
  path: string
  sha256: string
  bytes: number
}

function relativeFile(value: string) {
  const normalized = value.replaceAll("\\", "/")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    normalized.includes("\0")
  ) throw new Error(`Unsafe bundle path: ${JSON.stringify(value)}`)
  return normalized
}

function sourcePath(root: string, relative: string) {
  const target = path.resolve(root, relative)
  const expected = `${path.resolve(root)}${path.sep}`
  if (!target.startsWith(expected)) throw new Error(`Bundle path escapes source: ${relative}`)
  return target
}

async function attachment(sourceFile: string, relative: string) {
  const info = await lstat(sourceFile)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Bundle source is not a real file: ${relative}`)
  if (info.size > MAX_BUNDLE_BYTES) throw new Error(`Bundle file is too large: ${relative}`)
  // Bun.Archive.write does not resolve lazy Bun.file blobs (it archives them as empty), so read eagerly.
  return new Uint8Array(await Bun.file(sourceFile).arrayBuffer())
}

async function digest(file: string) {
  const hash = createHash("sha256")
  let bytes = 0
  await pipeline(
    createReadStream(file),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        hash.update(chunk)
        callback()
      },
    }),
  )
  return { sha256: hash.digest("hex"), bytes }
}

async function writeArchive(target: string, entries: Record<string, BlobPart>) {
  const temporary = `${path.resolve(target)}.${process.pid}.${crypto.randomUUID()}.tmp`
  await mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 })
  try {
    await Bun.Archive.write(temporary, entries as unknown as Bun.ArchiveInput, { compress: "gzip", level: 6 })
    const stored = await digest(temporary)
    if (stored.bytes > MAX_BUNDLE_BYTES) throw new Error(`Bundle exceeds ${MAX_BUNDLE_BYTES} bytes`)
    await rename(temporary, path.resolve(target))
    return { path: path.resolve(target), ...stored } satisfies StoredBundle
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/** Create a portable source bundle without embedding any run workspace, flag, or credential. */
export async function packChallengeBundle(input: { challengeID: string; challenge: Challenge; target: string }) {
  const source = path.resolve(input.challenge.directory)
  const manifest: RelayChallengeBundle = {
    version: 1,
    kind: "challenge",
    challengeID: input.challengeID,
    slug: input.challenge.slug,
    category: input.challenge.category ?? "OTHER",
    description: input.challenge.description,
    flagFormat: input.challenge.flagFormat,
    files: input.challenge.files.map(relativeFile),
    ...(input.challenge.difficulty ? { difficulty: input.challenge.difficulty } : {}),
    ...(input.challenge.serviceRequired ? { serviceRequired: true } : {}),
    ...(input.challenge.platform ? { platform: input.challenge.platform } : {}),
  }
  const entries: Record<string, BlobPart> = { [MANIFEST_NAME]: JSON.stringify(manifest) }
  for (const file of manifest.files) {
    const sourceFile = sourcePath(source, file)
    entries[`${INPUT_PREFIX}${file}`] = await attachment(sourceFile, file)
  }
  return writeArchive(input.target, entries)
}

async function collectDirectory(root: string, base = ""): Promise<string[]> {
  const directory = path.join(root, base)
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = base ? `${base}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Artifact bundle cannot contain a symbolic link: ${relative}`)
    if (entry.isDirectory()) files.push(...await collectDirectory(root, relative))
    else if (entry.isFile()) files.push(relativeFile(relative))
  }
  return files
}

/** Result/writeup bundles are explicit directories so full analysis workspaces never leave a worker. */
export async function packArtifactBundle(input: {
  kind: "result" | "writeup"
  directory: string
  target: string
}) {
  const source = path.resolve(input.directory)
  const info = await lstat(source)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Artifact source is not a real directory: ${source}`)
  const files = await collectDirectory(source)
  if (files.length === 0) throw new Error("Artifact bundle has no files")
  if (files.length > MAX_BUNDLE_FILES) throw new Error("Artifact bundle has too many files")
  const manifest: RelayArtifactBundle = { version: 1, kind: input.kind, files }
  const entries: Record<string, BlobPart> = { [MANIFEST_NAME]: JSON.stringify(manifest) }
  for (const file of files) entries[`${INPUT_PREFIX}${file}`] = await attachment(sourcePath(source, file), file)
  return writeArchive(input.target, entries)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function strings(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Relay bundle manifest files must be an array")
  if (value.length > MAX_BUNDLE_FILES) throw new Error("Relay bundle contains too many files")
  const files = value.map(relativeFile)
  if (new Set(files).size !== files.length) throw new Error("Relay bundle contains duplicate files")
  return files
}

function challengeManifest(value: unknown): RelayChallengeBundle {
  if (!isObject(value) || value.version !== 1 || value.kind !== "challenge")
    throw new Error("Relay bundle is not a challenge bundle")
  if (
    typeof value.challengeID !== "string" ||
    typeof value.slug !== "string" ||
    typeof value.category !== "string" ||
    typeof value.description !== "string" ||
    typeof value.flagFormat !== "string"
  ) throw new Error("Relay challenge bundle manifest is invalid")
  const categories: ChallengeCategory[] = [
    "WEB", "PWN", "REVERSE", "CRYPTO", "MISC", "MOBILE", "FORENSICS", "AI", "HARDWARE", "BLOCKCHAIN", "OSINT", "OTHER",
  ]
  if (!categories.includes(value.category as ChallengeCategory)) throw new Error("Relay challenge category is invalid")
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value.challengeID))
    throw new Error("Relay challenge ID is invalid")
  if (!value.slug || value.slug.includes("/") || value.slug.includes("\\") || value.slug.includes(".."))
    throw new Error("Relay challenge slug is invalid")
  return {
    version: 1,
    kind: "challenge",
    challengeID: value.challengeID,
    slug: value.slug,
    category: value.category as ChallengeCategory,
    description: value.description,
    flagFormat: value.flagFormat,
    files: strings(value.files),
    ...(typeof value.difficulty === "string" ? { difficulty: value.difficulty } : {}),
    ...(value.serviceRequired === true ? { serviceRequired: true } : {}),
    ...(isObject(value.platform) && typeof value.platform.adapter === "string"
      ? {
          platform: {
            adapter: value.platform.adapter,
            ...(typeof value.platform.challengeID === "string" ? { challengeID: value.platform.challengeID } : {}),
            ...(isObject(value.platform.options) ? { options: value.platform.options } : {}),
          },
        }
      : {}),
  }
}

function artifactManifest(value: unknown, expected: "result" | "writeup") {
  if (!isObject(value) || value.version !== 1 || value.kind !== expected)
    throw new Error(`Relay bundle is not a ${expected} bundle`)
  return { version: 1 as const, kind: expected, files: strings(value.files) }
}

async function unpack(input: { bundle: string; directory: string; expected: "challenge" | "result" | "writeup" }) {
  const source = path.resolve(input.bundle)
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Relay bundle is not a real file: ${source}`)
  if (sourceInfo.size > MAX_BUNDLE_BYTES) throw new Error("Relay bundle is too large")
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer())
  // Bun.Archive reads tar bytes but does not auto-detect gzip when wrapping an existing Blob.
  const tar = bytes[0] === 0x1f && bytes[1] === 0x8b ? Bun.gunzipSync(bytes) : bytes
  const archive = new Bun.Archive(tar)
  const entries = await archive.files()
  if (entries.size === 0 || entries.size > MAX_BUNDLE_FILES + 1) throw new Error("Relay bundle has an invalid file count")
  const manifestFile = entries.get(MANIFEST_NAME)
  if (!manifestFile) throw new Error("Relay bundle has no manifest")
  const rawManifest = JSON.parse(await manifestFile.text()) as unknown
  const manifest = input.expected === "challenge"
    ? challengeManifest(rawManifest)
    : artifactManifest(rawManifest, input.expected)
  const known = new Set([MANIFEST_NAME, ...manifest.files.map((file) => `${INPUT_PREFIX}${file}`)])
  if (entries.size !== known.size) throw new Error("Relay bundle has an unexpected file")
  for (const name of entries.keys()) {
    if (!known.has(name)) throw new Error(`Relay bundle has an unexpected file: ${name}`)
    if (name !== MANIFEST_NAME) relativeFile(name.slice(INPUT_PREFIX.length))
  }
  const destination = path.resolve(input.directory)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const file of manifest.files) {
    const entry = entries.get(`${INPUT_PREFIX}${file}`)
    if (!entry) throw new Error(`Relay bundle is missing ${file}`)
    if (entry.size > MAX_BUNDLE_BYTES) throw new Error(`Relay bundle file is too large: ${file}`)
    const target = sourcePath(destination, file)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await Bun.write(target, await entry.arrayBuffer())
  }
  return manifest
}

export async function unpackChallengeBundle(input: { bundle: string; directory: string }) {
  const manifest = await unpack({ ...input, expected: "challenge" }) as RelayChallengeBundle
  return {
    manifest,
    challenge: {
      slug: manifest.slug,
      category: manifest.category,
      ...(manifest.difficulty ? { difficulty: manifest.difficulty } : {}),
      sourceDirectory: path.resolve(input.directory),
      directory: path.resolve(input.directory),
      description: manifest.description,
      files: manifest.files,
      flagFormat: manifest.flagFormat,
      ...(manifest.serviceRequired ? { serviceRequired: true } : {}),
      ...(manifest.platform ? { platform: manifest.platform } : {}),
    } satisfies Challenge,
  }
}

export function unpackArtifactBundle(input: { bundle: string; directory: string; kind: "result" | "writeup" }) {
  return unpack({ bundle: input.bundle, directory: input.directory, expected: input.kind })
}
