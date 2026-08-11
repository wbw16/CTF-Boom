import { createHash } from "node:crypto"
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ChallengeCategory } from "./challenge.ts"
import { CTFTINY_FINGERPRINTS, type CTFTinyFingerprint } from "./ctftiny-fingerprints.ts"

export const CTFTINY_REPOSITORY = "https://github.com/NYU-LLM-CTF/CTFTiny.git"
export const CTFTINY_REVISION = "f1c9531672c45b24b7fb5f3aa44a7ac33d3602f8"

type CTFTinyIndexEntry = {
  year: string
  event: string
  category: string
  challenge: string
  path: string
}

type CTFTinyChallenge = {
  name?: string
  category?: string
  description?: string
  flag?: string
  files?: unknown
  type?: string
  compose?: boolean
  box?: string
  internal_port?: string | number
}

export type CTFTinyImportSummary = {
  challenges: number
  offline: number
  serviceDependent: number
  destination: string
}

const CATEGORY_MAP: Record<string, ChallengeCategory> = {
  crypto: "CRYPTO",
  forensics: "FORENSICS",
  misc: "MISC",
  pwn: "PWN",
  rev: "REVERSE",
  web: "WEB",
}

const README_CATEGORY: Record<string, string> = {
  crypto: "cry",
  forensics: "for",
  misc: "msc",
  pwn: "pwn",
  rev: "rev",
  web: "web",
}

// The upstream index spells this challenge "dockREleakage" while its benchmark table uses
// "dockerleakage". Keep the published table's difficulty without rewriting either identifier.
const DIFFICULTY_OVERRIDES: Record<string, string> = {
  "rev-dockreleakage": "Easy",
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}: expected a JSON object`)
  return value as Record<string, unknown>
}

async function json(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizedName(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function eventCode(entry: CTFTinyIndexEntry) {
  const suffix = entry.event.toLowerCase().includes("final") ? "f" : "q"
  return `${entry.year}${suffix}`
}

function difficultyTable(readme: string) {
  const difficulties = new Map<string, string>()
  for (const line of readme.split("\n")) {
    const match = /^\|\s*(cry|for|msc|pwn|rev|web)\s*\|\s*(\d{4}[qf])\s*\|\s*(.*?)\s*\|\s*(Very Easy|Easy|Moderate|Hard)\s*\|\s*$/.exec(line)
    if (!match) continue
    difficulties.set(`${match[1]}:${match[2]}:${normalizedName(match[3]!)}`, match[4]!)
  }
  return difficulties
}

function difficultyFor(slug: string, entry: CTFTinyIndexEntry, difficulties: Map<string, string>) {
  if (DIFFICULTY_OVERRIDES[slug]) return DIFFICULTY_OVERRIDES[slug]
  const category = README_CATEGORY[entry.category]
  const difficulty = category && difficulties.get(`${category}:${eventCode(entry)}:${normalizedName(entry.challenge)}`)
  if (!difficulty)
    throw new Error(`No CTFTiny difficulty for ${entry.category}/${entry.challenge} (${eventCode(entry)})`)
  return difficulty
}

function safeRelative(value: string, label: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === ".."))
    throw new Error(`${label}: unsafe relative path ${JSON.stringify(value)}`)
  return normalized
}

function assertInside(root: string, candidate: string, label: string) {
  const relative = path.relative(root, candidate)
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
    return
  throw new Error(`${label}: path escapes ${root}`)
}

async function copyTree(
  source: string,
  destination: string,
  sourceRoot: string,
  replacements?: Record<string, string>,
) {
  assertInside(sourceRoot, source, source)
  const info = await lstat(source).catch(() => undefined)
  if (!info) throw new Error(`Missing CTFTiny handout: ${source}`)
  if (info.isSymbolicLink()) throw new Error(`CTFTiny handout must not be a symlink: ${source}`)
  if (info.isDirectory()) {
    if (replacements) throw new Error(`Cannot apply text replacements to directory handout: ${source}`)
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true }))
      await copyTree(path.join(source, entry.name), path.join(destination, entry.name), sourceRoot)
    return
  }
  if (!info.isFile()) throw new Error(`Unsupported CTFTiny handout type: ${source}`)
  await mkdir(path.dirname(destination), { recursive: true })
  if (!replacements) {
    await copyFile(source, destination)
    return
  }
  let content = await readFile(source, "utf8")
  for (const [before, after] of Object.entries(replacements)) {
    if (!content.includes(before)) throw new Error(`${source}: missing replacement source ${JSON.stringify(before)}`)
    content = content.replaceAll(before, after)
  }
  await writeFile(destination, content)
  await chmod(destination, info.mode)
}

function asIndexEntry(value: unknown, slug: string): CTFTinyIndexEntry {
  const entry = object(value, `ctftiny.json:${slug}`)
  for (const key of ["year", "event", "category", "challenge", "path"] as const) {
    if (typeof entry[key] !== "string" || !entry[key].trim())
      throw new Error(`ctftiny.json:${slug}: missing ${key}`)
  }
  return entry as CTFTinyIndexEntry
}

function handouts(manifest: CTFTinyChallenge, label: string) {
  if (manifest.files === undefined) return []
  if (!Array.isArray(manifest.files) || manifest.files.some((item) => typeof item !== "string"))
    throw new Error(`${label}: files must be an array of relative paths`)
  const result = manifest.files.map((item) => safeRelative(item as string, label))
  if (new Set(result).size !== result.length) throw new Error(`${label}: duplicate handout path`)
  return result
}

function anonymousSlug(sourceSlug: string) {
  const token = createHash("sha256")
    .update(`boom:ctftiny:fingerprint:v1:${sourceSlug}`)
    .digest("hex")
    .slice(0, 10)
  return `task-${token}`
}

function challengeReadme(
  slug: string,
  description: string,
  category: ChallengeCategory,
  difficulty: string,
  serviceDependent: boolean,
) {
  const endpoint = serviceDependent
    ? category === "WEB"
      ? "\n\nService endpoint: `http://<service-host>:<service-port>/`"
      : "\n\nService endpoint: `<service-host>:<service-port>`"
    : ""
  return [
    `# Challenge ${slug.slice("task-".length).toUpperCase()}`,
    "",
    `${description}${endpoint}`,
    "",
    `Difficulty: ${difficulty}`,
    "",
  ].join("\n")
}

function datasetReadme(summary: Omit<CTFTinyImportSummary, "destination">, revision: string) {
  const example = anonymousSlug("cry-babycrypto")
  return [
    "# CTFTiny for Boom",
    "",
    `This is a Boom-compatible import of the official CTFTiny benchmark at commit \`${revision}\`.`,
    `It contains ${summary.challenges} challenges: ${summary.offline} can run from their handouts alone and ${summary.serviceDependent} require the official service environment.`,
    "",
    "Challenge-facing names, statements, slugs, and attachment paths are neutralized during import. Only files declared by each upstream `challenge.json` are copied into `challenges/`. Upstream flags, solvers, writeups, server-only files, and Docker build context are not exposed to Boom run workspaces.",
    "",
    "The importer initially writes known answers and the private provenance map under `eval/`. For the checked-in local dataset those files and prior solve history are stored only in the AES-encrypted `private/ctftiny-evaluation-private.7z` archive and the plaintext originals are removed. Automatic answer scoring remains disabled until the archive is restored.",
    "",
    "Run one offline challenge:",
    "",
    "```sh",
    `boom run --root ./benchmarks/ctftiny ${example}`,
    "```",
    "",
    "Run the full handout-only subset:",
    "",
    "```sh",
    "xargs boom run --root ./benchmarks/ctftiny < ./benchmarks/ctftiny/offline-slugs.txt",
    "```",
    "",
    "Service-dependent challenges are listed in `service-slugs.txt` and `services.json`; they are never started by this importer. All Web challenges stay out of the default offline list. If a remote service is provisioned separately, set its reachable endpoint in that challenge's `meta.json` as `remote` before running it. Do not copy the upstream service tree into a Boom challenge directory because it contains flags and solution material.",
    "",
    "Refresh this import from the pinned upstream revision with `bun run dataset:ctftiny -- --force`.",
    "",
    "The imported challenge material is distributed under GPL-2.0; see `LICENSE.CTFTINY`.",
    "",
  ].join("\n")
}

function fingerprintFor(slug: string, revision: string): CTFTinyFingerprint {
  const known = CTFTINY_FINGERPRINTS[slug]
  if (known) return known
  if (revision === CTFTINY_REVISION)
    throw new Error(`Missing fingerprint-neutralization profile for ${slug}`)
  return {
    description: "Analyze the supplied evidence and recover the protected value.",
    files: {},
  }
}

function mappedHandouts(
  slug: string,
  files: string[],
  profile: CTFTinyFingerprint,
  revision: string,
) {
  if (revision === CTFTINY_REVISION) {
    const missing = files.filter((file) => !profile.files[file])
    const extra = Object.keys(profile.files).filter((file) => !files.includes(file))
    if (missing.length || extra.length)
      throw new Error(`${slug}: fingerprint file map mismatch (missing=${missing.join(",")}; extra=${extra.join(",")})`)
  }
  const mapped = files.map((file, index) => {
    const fallbackExtension = path.posix.extname(file)
    const destination = safeRelative(
      profile.files[file] ?? `artifact-${String(index + 1).padStart(2, "0")}${fallbackExtension}`,
      `${slug}: fingerprint file map`,
    )
    return { source: file, destination }
  })
  if (new Set(mapped.map((file) => file.destination)).size !== mapped.length)
    throw new Error(`${slug}: duplicate neutralized handout path`)
  return mapped
}

/** Materialize an answer-isolated Boom root from an official CTFTiny checkout. */
export async function importCTFTiny(
  source: string,
  destination: string,
  revision = CTFTINY_REVISION,
): Promise<CTFTinyImportSummary> {
  const sourceRoot = await realpath(source)
  const index = object(await json(path.join(sourceRoot, "ctftiny.json")), "ctftiny.json")
  const difficulties = difficultyTable(await readFile(path.join(sourceRoot, "README.md"), "utf8"))
  const answers: string[] = ["# CTFTiny answers. Host-side evaluation only; never copied into a run workspace."]
  const offline: string[] = []
  const services: Record<string, unknown> = {}
  const provenance: Record<string, unknown> = {}

  await mkdir(path.join(destination, "challenges"), { recursive: true })
  await mkdir(path.join(destination, "eval"), { recursive: true })

  for (const [slug, rawEntry] of Object.entries(index).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`Unsafe CTFTiny slug: ${slug}`)
    const entry = asIndexEntry(rawEntry, slug)
    const category = CATEGORY_MAP[entry.category]
    if (!category) throw new Error(`Unsupported CTFTiny category for ${slug}: ${entry.category}`)
    const relativeSource = safeRelative(entry.path, `ctftiny.json:${slug}`)
    const challengeSource = await realpath(path.resolve(sourceRoot, relativeSource)).catch(() => {
      throw new Error(`ctftiny.json:${slug}: missing challenge path ${entry.path}`)
    })
    assertInside(sourceRoot, challengeSource, `ctftiny.json:${slug}`)
    const challengeData = object(await json(path.join(challengeSource, "challenge.json")), `${slug}/challenge.json`) as CTFTinyChallenge
    if (typeof challengeData.flag !== "string" || !challengeData.flag.trim())
      throw new Error(`${slug}/challenge.json: missing flag`)
    if (/[\r\n]/.test(challengeData.flag)) throw new Error(`${slug}/challenge.json: flag must fit on one line`)
    const profile = fingerprintFor(slug, revision)
    const description = profile.description.trim()
    if (description.includes(challengeData.flag))
      throw new Error(`${slug}: neutralized description exposes the answer`)
    const files = handouts(challengeData, `${slug}/challenge.json`)
    const mappedFiles = mappedHandouts(slug, files, profile, revision)
    const difficulty = difficultyFor(slug, entry, difficulties)
    // CTFd's `dynamic` type controls score decay; it says nothing about whether solving needs a
    // network service. Prefer a per-challenge audit when deployment metadata is ambiguous.
    const serviceDependent =
      profile.serviceRequired ?? (challengeData.compose === true || files.length === 0)
    const publicSlug = anonymousSlug(slug)
    const challengeDestination = path.join(destination, "challenges", category, publicSlug)
    await mkdir(challengeDestination, { recursive: true })
    for (const file of mappedFiles)
      await copyTree(
        path.join(challengeSource, file.source),
        path.join(challengeDestination, "files", file.destination),
        challengeSource,
        profile.replacements?.[file.source],
      )

    await writeFile(
      path.join(challengeDestination, "README.md"),
      challengeReadme(publicSlug, description, category, difficulty, serviceDependent),
    )
    await writeFile(
      path.join(challengeDestination, "meta.json"),
      `${JSON.stringify({
        category,
        difficulty,
        service_required: serviceDependent,
      }, null, 2)}\n`,
    )
    answers.push(`${publicSlug} ${challengeData.flag}`)
    provenance[publicSlug] = {
      upstream_id: slug,
      year: entry.year,
      event: entry.event,
      title: entry.challenge,
      upstream_path: entry.path,
      files: Object.fromEntries(mappedFiles.map((file) => [file.destination, file.source])),
    }
    if (serviceDependent) {
      services[publicSlug] = {
        compose: challengeData.compose === true,
        type: challengeData.type ?? "static",
        ...(challengeData.internal_port === undefined ? {} : { internal_port: challengeData.internal_port }),
      }
    } else {
      offline.push(publicSlug)
    }
  }

  const summary = {
    challenges: answers.length - 1,
    offline: offline.length,
    serviceDependent: Object.keys(services).length,
  }
  if (summary.challenges !== 50) throw new Error(`Expected 50 CTFTiny challenges, found ${summary.challenges}`)
  await writeFile(path.join(destination, "eval", "answers.txt"), `${answers.join("\n")}\n`)
  await writeFile(path.join(destination, "eval", "source-map.json"), `${JSON.stringify(provenance, null, 2)}\n`)
  await writeFile(path.join(destination, "offline-slugs.txt"), `${offline.join("\n")}\n`)
  await writeFile(path.join(destination, "service-slugs.txt"), `${Object.keys(services).join("\n")}\n`)
  await writeFile(path.join(destination, "services.json"), `${JSON.stringify(services, null, 2)}\n`)
  await writeFile(path.join(destination, "README.md"), datasetReadme(summary, revision))
  await copyFile(path.join(sourceRoot, "LICENSE"), path.join(destination, "LICENSE.CTFTINY"))
  await writeFile(
    path.join(destination, "dataset.json"),
    `${JSON.stringify({
      name: "CTFTiny",
      source: CTFTINY_REPOSITORY,
      revision,
      schema_version: 2,
      fingerprint_sanitized: true,
      challenge_count: summary.challenges,
      offline_count: summary.offline,
      service_dependent_count: summary.serviceDependent,
    }, null, 2)}\n`,
  )
  return { ...summary, destination }
}
