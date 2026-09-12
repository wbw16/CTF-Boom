import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { TASKS_DIR } from "./task-layout.ts"

export type Challenge = {
  slug: string
  /** Normalized CTF category used for storage, grouping, and prompt context. */
  category?: ChallengeCategory
  difficulty?: string
  /** Challenge root before an optional files/ attachment directory is selected. */
  sourceDirectory?: string
  directory: string
  /** Prompt text for the challenge, empty when the author supplied none. */
  description: string
  /** Attachment paths relative to `directory`. */
  files: string[]
  /** Regex source matching a valid flag. */
  flagFormat: string
  /** `host:port` of the challenge's own service, when it has one. */
  remote?: string
  /** True when completion depends on an externally provisioned challenge service. */
  serviceRequired?: boolean
  /** Optional competition integration. Absence means manual acquisition/submission. */
  platform?: {
    adapter: string
    challengeID?: string
    options?: Record<string, unknown>
  }
}

export const CHALLENGE_CATEGORIES = [
  "WEB",
  "PWN",
  "REVERSE",
  "CRYPTO",
  "MISC",
  "MOBILE",
  "FORENSICS",
  "AI",
  "HARDWARE",
  "BLOCKCHAIN",
  "OSINT",
  "OTHER",
] as const

export type ChallengeCategory = typeof CHALLENGE_CATEGORIES[number]

const CATEGORY_ALIASES: Record<string, ChallengeCategory> = {
  WEB: "WEB",
  WEBSEC: "WEB",
  PWN: "PWN",
  BINARY: "PWN",
  BINARYEXPLOITATION: "PWN",
  RE: "REVERSE",
  REV: "REVERSE",
  REVERSE: "REVERSE",
  REVERSING: "REVERSE",
  CRYPTO: "CRYPTO",
  CRYPTOGRAPHY: "CRYPTO",
  MISC: "MISC",
  STEG: "MISC",
  STEGANOGRAPHY: "MISC",
  MOBILE: "MOBILE",
  ANDROID: "MOBILE",
  IOS: "MOBILE",
  FORENSICS: "FORENSICS",
  FORENSIC: "FORENSICS",
  DFIR: "FORENSICS",
  AI: "AI",
  ML: "AI",
  AIML: "AI",
  HARDWARE: "HARDWARE",
  IOT: "HARDWARE",
  BLOCKCHAIN: "BLOCKCHAIN",
  WEB3: "BLOCKCHAIN",
  OSINT: "OSINT",
  OTHER: "OTHER",
}

function categoryKey(value: string) {
  return value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

export function recognizedChallengeCategory(value: unknown): ChallengeCategory | undefined {
  return typeof value === "string" ? CATEGORY_ALIASES[categoryKey(value)] : undefined
}

export function normalizeChallengeCategory(value: unknown): ChallengeCategory {
  return recognizedChallengeCategory(value) ?? "OTHER"
}

const DESCRIPTION_NAMES = [
  "README.md",
  "README.txt",
  "readme.md",
  "readme.txt",
  "prompt.md",
  "prompt.txt",
  "题面.md",
  "题面.txt",
]

const META_NAME = "meta.json"
// An empty format is deliberate: without a user- or challenge-supplied regex, Boom decides which
// string is the flag and records it in work/WRITEUP.md. Do not silently impose a flag{...} shape.
const DEFAULT_FLAG_FORMAT = ""
const IGNORED = new Set([".DS_Store", ".gitkeep", ".gitignore", META_NAME])

/** Persist a manually supplied service endpoint without discarding platform-owned metadata. */
export async function updateChallengeRemote(challenge: Challenge, remote?: string) {
  const directory = challenge.sourceDirectory ?? challenge.directory
  const directoryInfo = await lstat(directory).catch(() => undefined)
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error(`Challenge path is not a real directory: ${directory}`)

  const target = path.join(directory, META_NAME)
  const targetInfo = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (targetInfo && (!targetInfo.isFile() || targetInfo.isSymbolicLink()))
    throw new Error(`Challenge metadata is not a real file: ${target}`)

  let metadata: Record<string, unknown> = {}
  if (targetInfo) {
    const parsed = JSON.parse(await readFile(target, "utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`Challenge metadata must be a JSON object: ${target}`)
    metadata = parsed as Record<string, unknown>
  }
  if (remote === undefined) delete metadata.remote
  else metadata.remote = remote

  const temporary = path.join(directory, `${META_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`)
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

/**
 * Turn a known flag into a regex matching flags of the same shape. Only the wrapper is taken from the
 * answer. The payload remains generic so the format neither leaks the answer nor rejects valid characters
 * absent from the known sample.
 */
export function deriveFlagFormat(flag: string) {
  const match = /^([A-Za-z0-9_.-]{1,32})\{.*\}$/s.exec(flag)
  if (!match) return DEFAULT_FLAG_FORMAT
  return `${match[1]}\\{[^}]*\\}`
}

/** Read `<root>/eval/answers.txt`, one `<slug> <flag>` pair per line. */
export async function loadAnswers(root: string) {
  const file = path.join(root, "eval", "answers.txt")
  const raw = await readFile(file, "utf8").catch(() => undefined)
  const answers = new Map<string, string>()
  if (raw === undefined) return answers

  for (const [index, line] of raw.split("\n").entries()) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const separator = /\s+/.exec(trimmed)
    if (!separator) throw new Error(`${file}:${index + 1}: expected "<slug> <flag>", got: ${trimmed}`)
    const slug = trimmed.slice(0, separator.index)
    const flag = trimmed.slice(separator.index + separator[0].length).trim()
    if (flag === "") throw new Error(`${file}:${index + 1}: missing flag for ${slug}`)
    if (answers.has(slug)) throw new Error(`${file}:${index + 1}: duplicate answer for ${slug}`)
    answers.set(slug, flag)
  }
  return answers
}

async function collectFiles(directory: string, base = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, base), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(entry.name)) continue
    // A challenge directory is untrusted input. Following a symlink here could copy an unrelated
    // host file into a run workspace and expose it to the agent or GUI.
    if (entry.isSymbolicLink()) continue
    const relative = base === "" ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) files.push(...(await collectFiles(directory, relative)))
    else if (base !== "" || !DESCRIPTION_NAMES.includes(entry.name)) files.push(relative)
  }
  return files
}

/** Derive a challenge definition from a directory without requiring metadata. */
export async function loadChallenge(
  directory: string,
  answers: Map<string, string>,
  categoryHint?: ChallengeCategory,
): Promise<Challenge> {
  const directoryInfo = await lstat(directory).catch(() => undefined)
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error(`Challenge path is not a real directory: ${directory}`)
  const slug = path.basename(directory)
  let description = ""
  for (const name of DESCRIPTION_NAMES) {
    const found = await readFile(path.join(directory, name), "utf8").catch(() => undefined)
    if (found === undefined) continue
    description = found.trim()
    break
  }

  const explicit = await lstat(path.join(directory, "files")).catch(() => undefined)
  const attachmentBase = explicit?.isDirectory() ? path.join(directory, "files") : directory
  const files = await collectFiles(attachmentBase)
  // A platform sync can be interrupted after creating its destination directory but before the
  // title, description, or attachments are written. Keep that placeholder discoverable so it
  // cannot prevent the rest of the catalog from loading; a later sync can safely fill it in.

  const answer = answers.get(slug)
  const meta = await readFile(path.join(directory, META_NAME), "utf8")
    .then((raw) => JSON.parse(raw) as {
      remote?: string
      flag_format?: string
      category?: string
      difficulty?: string
      service_required?: boolean
      platform?: string | {
        adapter?: string
        challenge_id?: string
        options?: Record<string, unknown>
      }
    })
    .catch(() => ({}) as {
      remote?: string
      flag_format?: string
      category?: string
      difficulty?: string
      service_required?: boolean
      platform?: string | {
        adapter?: string
        challenge_id?: string
        options?: Record<string, unknown>
      }
    })
  const platform = typeof meta.platform === "string"
    ? { adapter: meta.platform.trim() }
    : meta.platform && typeof meta.platform.adapter === "string"
      ? {
          adapter: meta.platform.adapter.trim(),
          ...(typeof meta.platform.challenge_id === "string"
            ? { challengeID: meta.platform.challenge_id }
            : {}),
          ...(meta.platform.options && typeof meta.platform.options === "object"
            ? { options: meta.platform.options }
            : {}),
        }
      : undefined

  return {
    slug,
    category: categoryHint ?? recognizedChallengeCategory(meta.category) ?? "OTHER",
    ...(typeof meta.difficulty === "string" && meta.difficulty.trim()
      ? { difficulty: meta.difficulty.trim() }
      : {}),
    sourceDirectory: directory,
    directory: attachmentBase,
    description,
    files,
    flagFormat: meta.flag_format ?? (answer === undefined ? DEFAULT_FLAG_FORMAT : deriveFlagFormat(answer)),
    ...(typeof meta.remote === "string" && meta.remote.trim()
      ? { remote: meta.remote.trim() }
      : {}),
    ...(meta.service_required === true ? { serviceRequired: true } : {}),
    ...(platform?.adapter ? { platform } : {}),
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type ChallengeCatalog = {
  /** Directory whose direct children are scanned for challenges. */
  directory: string
  /** True when category folders sit directly under the workspace root instead of `challenges/`. */
  atRoot: boolean
}

/**
 * Locate the challenge catalog for a workspace root.
 *
 * `<root>/challenges/` stays the preferred layout. A root that itself contains recognized category
 * folders (WEB/, PWN/, MISC/, …) — the shape of many downloaded competition archives — is accepted
 * as the catalog. Anything else resolves to the default `<root>/challenges/` so callers can create it.
 */
export async function resolveChallengeCatalog(root: string): Promise<ChallengeCatalog> {
  const nested = path.join(root, "challenges")
  const nestedInfo = await lstat(nested).catch(() => undefined)
  if (nestedInfo?.isDirectory() && !nestedInfo.isSymbolicLink())
    return { directory: nested, atRoot: false }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined)
  for (const entry of entries ?? []) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (recognizedChallengeCategory(entry.name)) return { directory: root, atRoot: true }
  }
  return { directory: nested, atRoot: false }
}

/**
 * Create the directories a workspace root needs before Boom opens it: `tasks/` always, plus the
 * default `challenges/` catalog unless categories already live at the root — creating it there
 * would shadow the root layout on the next open.
 */
export async function prepareWorkspaceRoot(root: string) {
  await mkdir(path.join(root, TASKS_DIR), { recursive: true })
  const catalog = await resolveChallengeCatalog(root)
  if (!catalog.atRoot) await mkdir(catalog.directory, { recursive: true })
}

/**
 * Every challenge under a workspace root's catalog.
 *
 * Preferred layout is `<root>/challenges/<CATEGORY>/<slug>/`; legacy flat `<slug>/` directories
 * remain readable there. When categories instead sit directly under the root, only they are
 * scanned — other top-level entries are workspace infrastructure such as `runs/`, not challenges.
 *
 * A single unresolvable challenge directory must not take down the whole catalog (the GUI serves
 * this list directly): it is skipped and reported in a summary warning. Cross-category slug
 * collisions keep the first challenge and warn instead of throwing.
 */
export async function discoverChallenges(root: string): Promise<Challenge[]> {
  const catalog = await resolveChallengeCatalog(root)
  const info = await lstat(catalog.directory).catch(() => undefined)
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new Error(
      `No challenge catalog under ${root}: expected ${path.join(root, "challenges")} or category folders such as WEB/PWN/MISC directly inside`,
    )
  const entries = await readdir(catalog.directory, { withFileTypes: true }).catch(() => {
    throw new Error(`No challenges directory at ${catalog.directory}`)
  })
  const answersFile = path.join(root, "eval", "answers.txt")
  let answers: Map<string, string>
  try {
    answers = await loadAnswers(root)
  } catch (error) {
    // The root answers file is configuration, so a format error stays fatal — but the operator
    // gets the offending file path up front instead of bare parser context.
    throw new Error(`无法加载挑战答案文件 ${answersFile}: ${errorText(error)}`)
  }
  const challenges: Challenge[] = []
  const diagnostics: Array<{ directory: string; error: string }> = []
  const seen = new Set<string>()
  const consider = (challenge: Challenge, source: string) => {
    if (seen.has(challenge.slug)) {
      // Keep the first occurrence so one mirrored category cannot invalidate discovery.
      console.warn(`[boom] 挑战 slug 跨分类重复，保留首个并跳过：${challenge.slug} (${source})`)
      return
    }
    seen.add(challenge.slug)
    challenges.push(challenge)
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const category = recognizedChallengeCategory(entry.name)
    if (!category) {
      // At the workspace root only categories are challenges; the rest is infrastructure.
      if (catalog.atRoot) continue
      const target = path.join(catalog.directory, entry.name)
      try {
        consider(await loadChallenge(target, answers), target)
      } catch (error) {
        diagnostics.push({ directory: target, error: errorText(error) })
      }
      continue
    }
    const categoryDirectory = path.join(catalog.directory, entry.name)
    const nested = await readdir(categoryDirectory, { withFileTypes: true }).catch(
      (error: unknown) => {
        diagnostics.push({ directory: categoryDirectory, error: errorText(error) })
        return undefined
      },
    )
    for (const challenge of nested?.sort((a, b) => a.name.localeCompare(b.name)) ?? []) {
      if (!challenge.isDirectory() || challenge.name.startsWith(".")) continue
      const target = path.join(categoryDirectory, challenge.name)
      try {
        consider(await loadChallenge(target, answers, category), target)
      } catch (error) {
        diagnostics.push({ directory: target, error: errorText(error) })
      }
    }
  }
  if (diagnostics.length > 0) {
    const first = diagnostics[0]
    console.warn(
      `[boom] ${diagnostics.length} 个挑战目录无法解析：${first.directory}: ${first.error}` +
        (diagnostics.length > 1 ? "…" : ""),
    )
  }
  return challenges.sort((left, right) =>
    CHALLENGE_CATEGORIES.indexOf(left.category ?? "OTHER") -
      CHALLENGE_CATEGORIES.indexOf(right.category ?? "OTHER") ||
    left.slug.localeCompare(right.slug))
}
