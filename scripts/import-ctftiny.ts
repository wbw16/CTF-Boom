import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CTFTINY_REPOSITORY, CTFTINY_REVISION, importCTFTiny } from "../src/ctftiny-dataset.ts"

type Options = {
  source?: string
  output: string
  force: boolean
}

function usage(): never {
  process.stderr.write("Usage: bun scripts/import-ctftiny.ts [--source <checkout>] [--output <dir>] [--force]\n")
  process.exit(1)
}

function options(argv: string[]): Options {
  const result: Options = { output: path.resolve("benchmarks/ctftiny"), force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--source" && argv[index + 1]) result.source = path.resolve(argv[++index]!)
    else if (arg === "--output" && argv[index + 1]) result.output = path.resolve(argv[++index]!)
    else if (arg === "--force") result.force = true
    else usage()
  }
  return result
}

async function git(args: string[]) {
  const process = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "inherit" })
  const code = await process.exited
  if (code !== 0) throw new Error(`git ${args[0]} failed with exit code ${code}`)
}

async function verifyRevision(source: string) {
  if (!await lstat(path.join(source, ".git")).catch(() => undefined)) return
  const process = Bun.spawn(["git", "-C", source, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "inherit" })
  const head = (await new Response(process.stdout).text()).trim()
  const code = await process.exited
  if (code !== 0) throw new Error(`Could not inspect CTFTiny revision in ${source}`)
  if (head !== CTFTINY_REVISION)
    throw new Error(`CTFTiny checkout is ${head}; expected pinned revision ${CTFTINY_REVISION}`)
}

async function download() {
  const checkout = await mkdtemp(path.join(os.tmpdir(), "boom-ctftiny-source-"))
  await git(["init", "--quiet", checkout])
  await git(["-C", checkout, "remote", "add", "origin", CTFTINY_REPOSITORY])
  await git(["-C", checkout, "fetch", "--quiet", "--depth", "1", "origin", CTFTINY_REVISION])
  await git(["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"])
  return checkout
}

async function main() {
  const args = options(process.argv.slice(2))
  const temporarySource = args.source ? undefined : await download()
  const source = args.source ?? temporarySource!
  await verifyRevision(source)
  const parent = path.dirname(args.output)
  await mkdir(parent, { recursive: true })
  const staging = await mkdtemp(path.join(parent, ".ctftiny-import-"))
  const replaced = `${args.output}.replaced-${process.pid}`

  try {
    const existing = await lstat(args.output).catch(() => undefined)
    if (existing && !existing.isDirectory()) throw new Error(`${args.output} exists and is not a directory`)
    if (existing && !args.force)
      throw new Error(`${args.output} already exists; pass --force to replace dataset files while preserving runs`)
    const summary = await importCTFTiny(source, staging, CTFTINY_REVISION)
    if (existing) {
      await rename(args.output, replaced)
      await rename(staging, args.output)
      const oldRuns = path.join(replaced, "runs")
      if (await lstat(oldRuns).catch(() => undefined)) await rename(oldRuns, path.join(args.output, "runs"))
      await rm(replaced, { recursive: true, force: true })
    } else {
      await rename(staging, args.output)
    }
    process.stdout.write(
      `Imported CTFTiny ${CTFTINY_REVISION}: ${summary.challenges} challenges ` +
      `(${summary.offline} offline, ${summary.serviceDependent} service-dependent) -> ${args.output}\n`,
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
    if (temporarySource) await rm(temporarySource, { recursive: true, force: true })
  }
}

main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
