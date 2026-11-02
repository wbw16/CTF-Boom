/**
 * Operator-facing challenge authoring: create, edit, attach, and answer a challenge from the GUI.
 *
 * Before this module the only way to add a challenge was to hand-build a directory
 * (`challenges/<CATEGORY>/<slug>/README.md`, `meta.json`, attachments, `eval/answers.txt`) outside
 * Boom. Everything the GUI writes goes through these functions, so one place owns the on-disk
 * contract that `src/challenge.ts` reads back:
 *
 * ```
 * <root>/challenges/<CATEGORY>/<slug>/
 *   README.md   description (any of the recognized DESCRIPTION_NAMES)
 *   meta.json   category, difficulty, remote, service_required, flag_format
 *   files/      attachments, copied — never linked — from the operator's disk
 * <root>/eval/answers.txt   "<slug> <flag>" per line, edited in place
 * ```
 * @module boom/challenge-store
 */

import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { constants } from "node:fs"
import { normalizeChallengeCategory, resolveChallengeCatalog } from "./challenge.ts"

const META_NAME = "meta.json"
const FILES_DIR = "files"
const README_NAME = "README.md"
const ANSWERS_RELATIVE = path.join("eval", "answers.txt")

/** Names a challenge directory cannot use: they would be read back as metadata or attachments. */
const RESERVED_NAMES = new Set([META_NAME, FILES_DIR, "eval", "README.md", "README.txt"])

export type ChallengeDraft = {
  slug: string
  category?: string
  description?: string
  difficulty?: string
  remote?: string
  serviceRequired?: boolean
  flagFormat?: string
  /** Known flag; stored in `<root>/eval/answers.txt`, never inside the challenge directory. */
  answer?: string
  /** Absolute paths of files to copy into `files/`. */
  attachments?: string[]
}

export type ChallengeEdit = {
  description?: string
  category?: string
  difficulty?: string | null
  remote?: string | null
  serviceRequired?: boolean
  flagFormat?: string | null
  answer?: string | null
}

export type ChallengeDirectory = {
  slug: string
  category: string
  directory: string
  /** True when the challenge moved to another category directory. */
  moved?: boolean
}

export function validChallengeSlug(slug: string) {
  const trimmed = slug.trim()
  return (
    trimmed !== "" &&
    trimmed.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) &&
    !RESERVED_NAMES.has(trimmed.toLowerCase().replace(/\.md$|\.txt$/, "")) &&
    trimmed !== "." &&
    trimmed !== ".."
  )
}

export function assertChallengeSlug(slug: string) {
  if (!validChallengeSlug(slug)) throw new Error(`Invalid challenge slug: ${slug}`)
  return slug.trim()
}

/**
 * A caller may hand back the whole description file — the GUI's editor is prefilled from the stored
 * description, which includes the title line — so a leading copy of the title is dropped instead of
 * being written a second time. The prose below it is what this field owns.
 */
function stripTitleEcho(description: string | undefined, title: string) {
  if (description === undefined) return undefined
  const [first, ...rest] = description.split("\n")
  if (first === undefined || first.trim() !== title.trim()) return description
  const prose = rest.join("\n").trim()
  return prose === "" ? undefined : prose
}

function cleanLine(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

/** A metadata field the operator owns; an empty value removes the key instead of writing "". */
function setOptional(metadata: Record<string, unknown>, key: string, value: string | null | undefined) {
  if (value === null) {
    delete metadata[key]
    return
  }
  const cleaned = cleanLine(value ?? undefined)
  if (cleaned === undefined) delete metadata[key]
  else metadata[key] = cleaned
}

async function realFile(target: string) {
  const info = await lstat(target).catch(() => undefined)
  if (!info) throw new Error(`Attachment does not exist: ${target}`)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Attachment is not a real file: ${target}`)
  return await realpath(target)
}

async function readMetadata(directory: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(directory, META_NAME), "utf8").catch(() => undefined)
  if (raw === undefined) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Challenge metadata must be a JSON object: ${path.join(directory, META_NAME)}`)
  return parsed as Record<string, unknown>
}

async function writeMetadata(directory: string, metadata: Record<string, unknown>) {
  const target = path.join(directory, META_NAME)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, undefined, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

const PROTECTED_INPUT_NAMES = new Set(["meta.json", "readme.md", "readme.txt", "prompt.md", "prompt.txt", "题面.md", "题面.txt"])

function attachmentSegments(name: string) {
  const segments = name.split("/")
  if (name.includes("\\") || name.includes("\0") || segments.some((part) => !part || part.startsWith(".")) ||
      segments.some((part) => part.toLowerCase() === META_NAME) ||
      PROTECTED_INPUT_NAMES.has(segments[0]!.toLowerCase()))
    throw new Error(`Invalid attachment name: ${name}`)
  return segments
}

/** Imported challenges retain their flat layout; creating files/ would hide their old inputs. */
async function attachmentDirectory(directory: string) {
  const target = path.join(directory, FILES_DIR)
  const info = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return directory
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Attachment directory is not a real directory: ${target}`)
  return target
}

/** Preflight the complete batch, refuse collisions, and roll back only files copied by this call. */
async function copyAttachments(target: string, attachments: string[]) {
  const sources: Array<{ source: string; name: string }> = []
  const names = new Set<string>()
  for (const source of attachments) {
    const canonical = await realFile(path.resolve(source))
    const name = path.basename(canonical)
    attachmentSegments(name)
    if (names.has(name) || await lstat(path.join(target, name)).catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })) throw new Error(`Attachment already exists: ${name}`)
    names.add(name)
    sources.push({ source: canonical, name })
  }
  const copied: string[] = []
  try {
    for (const { source, name } of sources) {
      await copyFile(source, path.join(target, name), constants.COPYFILE_EXCL)
      copied.push(name)
    }
  } catch (error) {
    await Promise.all(copied.map((name) => rm(path.join(target, name), { force: true })))
    throw error
  }
  return copied
}

/** Create a challenge directory inside the workspace's catalog. */
export async function createChallengeInCatalog(
  root: string,
  draft: ChallengeDraft,
): Promise<ChallengeDirectory & { files: string[] }> {
  const slug = assertChallengeSlug(draft.slug)
  const category = normalizeChallengeCategory(draft.category)
  const catalog = (await resolveChallengeCatalog(root)).directory
  const directory = path.join(catalog, category, slug)
  if (await existingChallengeDirectory(root, slug)) throw new Error(`Challenge already exists: ${slug}`)
  const existing = await lstat(directory).catch(() => undefined)
  if (existing) throw new Error(`Challenge already exists: ${slug}`)
  await mkdir(directory, { recursive: true })

  try {
    const metadata: Record<string, unknown> = { category }
    if (draft.difficulty !== undefined) setOptional(metadata, "difficulty", draft.difficulty)
    if (draft.remote !== undefined) setOptional(metadata, "remote", draft.remote)
    if (draft.serviceRequired === true) metadata.service_required = true
    if (draft.flagFormat !== undefined) setOptional(metadata, "flag_format", draft.flagFormat)
    await writeMetadata(directory, metadata)

    const description = cleanLine(draft.description)
    await writeFile(
      path.join(directory, README_NAME),
      `# ${slug}\n\n${description ?? "（暂无题面，点击「编辑题目」补充。）"}\n`,
      "utf8",
    )
    const attachmentBase = path.join(directory, FILES_DIR)
    await mkdir(attachmentBase)
    const files = await copyAttachments(attachmentBase, draft.attachments ?? [])
    if (draft.answer !== undefined) await writeAnswer(root, slug, draft.answer)
    return { slug, category, directory, files }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Apply an operator edit to an existing challenge. The directory follows a category change so the
 * catalog keeps one home per challenge; every other field is rewritten in place.
 */
export async function updateChallengeInCatalog(
  root: string,
  slug: string,
  edit: ChallengeEdit,
): Promise<ChallengeDirectory> {
  assertChallengeSlug(slug)
  const catalog = (await resolveChallengeCatalog(root)).directory
  let directory = await findChallengeDirectory(root, slug)

  const metadata = await readMetadata(directory)
  if ("description" in edit) {
    // Keep the operator's title line when the file already has one; only the prose below it changes.
    const body = await readFile(path.join(directory, README_NAME), "utf8").catch(() => `# ${slug}\n`)
    const existingTitle = body.split("\n")[0] ?? ""
    const title = existingTitle.trimStart().startsWith("#") ? existingTitle : `# ${slug}`
    const description = stripTitleEcho(cleanLine(edit.description), title)
    await writeFile(
      path.join(directory, README_NAME),
      description === undefined ? `${title}\n` : `${title}\n\n${description}\n`,
      "utf8",
    )
  }
  if ("category" in edit) {
    const category = normalizeChallengeCategory(edit.category)
    directory = await moveChallengeToCategory(catalog, directory, category)
    metadata.category = category
  }
  if ("difficulty" in edit) setOptional(metadata, "difficulty", edit.difficulty)
  if ("remote" in edit) setOptional(metadata, "remote", edit.remote)
  if ("flagFormat" in edit) setOptional(metadata, "flag_format", edit.flagFormat)
  if ("serviceRequired" in edit) {
    if (edit.serviceRequired === true) metadata.service_required = true
    else delete metadata.service_required
  }
  await writeMetadata(directory, metadata)
  if ("answer" in edit) await writeAnswer(root, slug, edit.answer ?? undefined)
  return { slug, category: normalizeChallengeCategory(metadata.category), directory }
}

/**
 * The challenge's real directory, resolved through the catalog instead of trusting a slug path.
 *
 * Discovery keeps the first challenge it sees for a slug and warns about the rest, so a slug has to
 * be unique across every category: creation refuses a slug that already resolves here rather than
 * writing a second directory the workspace would then silently ignore.
 */
async function existingChallengeDirectory(root: string, slug: string): Promise<string | undefined> {
  const catalog = (await resolveChallengeCatalog(root)).directory
  const categories = await readdir(catalog, { withFileTypes: true }).catch(() => [])
  for (const entry of categories) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const candidate = path.join(catalog, entry.name, slug)
    const info = await lstat(candidate).catch(() => undefined)
    if (info?.isDirectory() && !info.isSymbolicLink()) return candidate
  }
  // Legacy flat catalogs keep challenges directly under the catalog directory.
  const flat = path.join(catalog, slug)
  const info = await lstat(flat).catch(() => undefined)
  return info?.isDirectory() && !info.isSymbolicLink() ? flat : undefined
}

async function findChallengeDirectory(root: string, slug: string): Promise<string> {
  const directory = await existingChallengeDirectory(root, slug)
  if (directory === undefined) throw new Error(`No such challenge: ${slug}`)
  return directory
}

/** Move one challenge directory between category folders, refusing to clobber an existing slug. */
async function moveChallengeToCategory(catalog: string, directory: string, category: string) {
  const current = path.basename(path.dirname(directory))
  if (current === category) return directory
  const destination = path.join(catalog, category, path.basename(directory))
  if (await lstat(destination).catch(() => undefined))
    throw new Error(`Challenge already exists in ${category}: ${path.basename(directory)}`)
  await mkdir(path.dirname(destination), { recursive: true })
  await rename(directory, destination)
  return destination
}

/** Copy more operator-selected files into the challenge's attachment directory. */
export async function addChallengeAttachments(root: string, slug: string, attachments: string[]) {
  assertChallengeSlug(slug)
  const directory = await findChallengeDirectory(root, slug)
  const target = await attachmentDirectory(directory)
  const copied = await copyAttachments(target, attachments)
  return { slug, files: copied, directory: target }
}

/** Remove one relative attachment path without following symlinks in any component. */
export async function removeChallengeAttachment(root: string, slug: string, name: string) {
  assertChallengeSlug(slug)
  const segments = attachmentSegments(name)
  const directory = await findChallengeDirectory(root, slug)
  let target = await attachmentDirectory(directory)
  for (const [index, segment] of segments.entries()) {
    target = path.join(target, segment)
    const info = await lstat(target).catch((error) => {
      if (error.code === "ENOENT") throw new Error(`No such attachment: ${name}`)
      throw error
    })
    if (info.isSymbolicLink() || (index === segments.length - 1 ? !info.isFile() : !info.isDirectory()))
      throw new Error(`Attachment is not a real file: ${name}`)
  }
  await rm(target)
  return { slug, removed: name }
}

/**
 * Set (or clear) one challenge's answer in `<root>/eval/answers.txt`.
 *
 * The file is shared by every challenge in the workspace, so it is rewritten atomically with the
 * comments and unrelated lines preserved. Clearing the last answer removes the file's line but
 * keeps the file itself, matching what `loadAnswers` expects to find.
 */
export async function writeAnswer(root: string, slug: string, answer?: string | null) {
  assertChallengeSlug(slug)
  const target = path.join(path.resolve(root), ANSWERS_RELATIVE)
  const info = await lstat(target).catch(() => undefined)
  if (info && (!info.isFile() || info.isSymbolicLink()))
    throw new Error(`Answers file is not a real file: ${target}`)
  const raw = info ? await readFile(target, "utf8") : ""
  const flag = cleanLine(answer ?? undefined)
  const lines: string[] = []
  let replaced = false
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      if (trimmed !== "" || lines.length > 0) lines.push(line)
      continue
    }
    const separator = /\s+/.exec(trimmed)
    const lineSlug = separator ? trimmed.slice(0, separator.index) : trimmed
    if (lineSlug !== slug) {
      lines.push(line)
      continue
    }
    replaced = true
    if (flag !== undefined) lines.push(`${slug} ${flag}`)
  }
  if (!replaced && flag !== undefined) lines.push(`${slug} ${flag}`)
  const body = lines.filter((line, index, all) => !(line.trim() === "" && index === all.length - 1))
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, body.length === 0 ? "" : `${body.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
  return { slug, answer: flag ?? null }
}

/** The answer Boom knows for one challenge, if the workspace's answers file lists it. */
export async function readAnswer(root: string, slug: string) {
  const raw = await readFile(path.join(path.resolve(root), ANSWERS_RELATIVE), "utf8").catch(() => "")
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const separator = /\s+/.exec(trimmed)
    if (!separator) continue
    if (trimmed.slice(0, separator.index) === slug) return trimmed.slice(separator.index + separator[0].length).trim()
  }
  return undefined
}
