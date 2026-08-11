import { lstat } from "node:fs/promises"
import path from "node:path"
import { configuredPlatformAdapterRegistry } from "./http-platform-adapter.ts"
import { loadPlatformManifest, platformManifestPath, savePlatformManifest } from "./platform-manifest.ts"
import { adaptOpenApiDocument, readApiDocument } from "./platform-openapi.ts"

function platformUsage(): never {
  throw new Error([
    "Usage:",
    "  boom platform adapt --id <id> --document <file-or-url> [--base-url <url>] [--root <dir>] [--force]",
    "  boom platform inspect --id <id> [--root <dir>]",
    "  boom platform sync --id <id> [--root <dir>] [--var <name=value>]...",
  ].join("\n"))
}

type Parsed = {
  action: "adapt" | "inspect" | "sync"
  id: string
  root: string
  document?: string
  baseURL?: string
  name?: string
  force: boolean
  variables: Record<string, string>
}

function parse(argv: string[]): Parsed {
  const action = argv[0]
  if (action !== "adapt" && action !== "inspect" && action !== "sync") platformUsage()
  const parsed: Parsed = {
    action,
    id: "",
    root: path.resolve("ctf"),
    force: false,
    variables: {},
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = () => {
      const found = argv[++index]
      if (found === undefined) platformUsage()
      return found
    }
    if (arg === "--id") parsed.id = value()
    else if (arg === "--root") parsed.root = path.resolve(value())
    else if (arg === "--document") parsed.document = value()
    else if (arg === "--base-url") parsed.baseURL = value()
    else if (arg === "--name") parsed.name = value()
    else if (arg === "--force") parsed.force = true
    else if (arg === "--var") {
      const assignment = value()
      const separator = assignment.indexOf("=")
      if (separator < 1) throw new Error("--var must be name=value")
      parsed.variables[assignment.slice(0, separator)] = assignment.slice(separator + 1)
    } else platformUsage()
  }
  if (!parsed.id) throw new Error("--id is required")
  if (action === "adapt" && !parsed.document) throw new Error("--document is required for platform adapt")
  return parsed
}

export async function platformCommand(argv: string[]) {
  const args = parse(argv)
  if (args.action === "adapt") {
    const target = platformManifestPath(args.root, args.id)
    if (!args.force && await lstat(target).catch(() => undefined))
      throw new Error(`Platform manifest already exists: ${target}; pass --force to replace it`)
    const document = await readApiDocument(args.document!)
    const adapted = adaptOpenApiDocument(document, {
      id: args.id,
      ...(args.baseURL ? { baseURL: args.baseURL } : {}),
      ...(args.name ? { name: args.name } : {}),
    })
    await savePlatformManifest(args.root, adapted.manifest)
    process.stdout.write([
      `Platform adapter ${adapted.manifest.id}: ${adapted.manifest.status}`,
      `Manifest: ${target}`,
      `Challenge list: ${adapted.selected.listChallenges}`,
      ...(adapted.selected.getChallenge ? [`Challenge detail: ${adapted.selected.getChallenge}`] : []),
      ...(adapted.selected.submitFlag ? [`Flag submission: ${adapted.selected.submitFlag}`] : []),
      ...adapted.warnings.map((warning) => `Warning: ${warning}`),
      ...(adapted.manifest.auth ? [`Credential: ${adapted.manifest.auth.env}`] : []),
      "",
    ].join("\n"))
    return
  }

  const manifest = await loadPlatformManifest(args.root, args.id)
  if (!manifest) throw new Error(`No platform manifest at ${platformManifestPath(args.root, args.id)}`)
  if (args.action === "inspect") {
    process.stdout.write(`${JSON.stringify({
      ...manifest,
      credential: manifest.auth
        ? { env: manifest.auth.env, configured: Boolean(process.env[manifest.auth.env]?.trim()) }
        : undefined,
    }, undefined, 2)}\n`)
    return
  }

  const challenges = await configuredPlatformAdapterRegistry().acquireChallenges(args.id, {
    root: args.root,
    options: args.variables,
  })
  process.stdout.write(`Downloaded ${challenges.length} challenge(s) through ${args.id}:\n`)
  for (const challenge of challenges) process.stdout.write(`  ${challenge.slug}\n`)
}
