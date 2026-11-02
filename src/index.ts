#!/usr/bin/env bun
import path from "node:path"
import { discoverChallenges, loadAnswers, prepareWorkspaceRoot, type Challenge } from "./challenge.ts"
import { launchDesktopClient } from "./desktop.ts"
import {
  GuiArgumentError,
  parseGuiArgs,
  startGuiLifecycle,
  type GuiLifecycle,
} from "./gui-command.ts"
import { CONSULT_EXPERTS } from "./consultation.ts"
import { inspectRuntime, packageVersion } from "./runtime.ts"
import {
  detectContainerCapability,
  resolveEnvironmentProfile,
  type ExecutionMode,
} from "./environment.ts"
import { DEFAULT_SILENCE_MS, type Limits } from "./session.ts"
import { aggregateEvaluation, collectEvaluationSamples, compareEvaluationSamples, evaluationMarkdown } from "./evaluation.ts"
import { normalizeExperiment } from "./experiment.ts"
import { mcpCommand } from "./mcp-command.ts"
import { applyMigration, migrationReport, planMigration } from "./migrate.ts"
import { GuiRunner } from "./runner.ts"
import {
  readRunHistory,
  taskDirectoryFromRoot,
  type RunHistory,
} from "./history.ts"

const DEFAULTS = {
  repeats: 5,
  minutes: 60,
  silenceMs: DEFAULT_SILENCE_MS,
  concurrency: 4,
  model: "free/deepseek-v4-flash-free",
}

type Args = {
  root: string
  model: string
  economyModel: string
  strongModel: string
  consultModels: string[]
  consultOnCompaction: boolean
  limits: Limits
  concurrency: number
  only: string[]
  trials: number
  experiment?: string
  slugsFile?: string
  pythonProfile?: string
  pythonInterpreter?: string
  executionMode: ExecutionMode
  network: "allow" | "deny"
}

function usage(code = 1): never {
  const output = code === 0 ? process.stdout : process.stderr
  output.write([
    "Usage: boom <command> [options]",
    "",
    "Boom — automated CTF solving with the Boom agent.",
    "",
    "Commands:",
    "  run [options] [slug...]  solve one or more challenges",
    "  gui [options]            open the local Boom workbench",
    "  mcp <action>             manage Boom MCP servers through Boom Runtime",
    "  doctor                   verify the local installation",
    "  evaluate [--root <dir>]  summarize existing run results",
    "  migrate [--root <dir>]   move an older workspace onto the shared task layout",
    "  version                  print the installed version",
    "",
    "Run options:",
    "  --root <dir>             workspace root (default: current directory)",
    `  --strong-model <p/m>     solver model (default: ${DEFAULTS.model})`,
    `  --economy-model <p/m>    bounded second-opinion model (default: ${DEFAULTS.model})`,
    "  --model <p/m>            alias for --strong-model",
    "  --consult <p/m>          consultation expert; repeat 2–4 times",
    "  --no-consult-on-compaction  resume directly after compaction (experiment switch)",
    "  --python-profile <id>    use a saved Python environment profile",
    "  --python <path>          bind to an existing Python interpreter",
    "  --execution <mode>       managed|isolated|static-only (default: managed)",
    "  --tokens <n>             optional per-challenge token ceiling (default: unlimited)",
    `  --repeats <n>            abort after N identical tool calls (default: ${DEFAULTS.repeats})`,
    `  --minutes <n>            turn watchdog; cumulative when --tokens is set (default: ${DEFAULTS.minutes})`,
    `  --concurrency <n>        challenges solved at once (default: ${DEFAULTS.concurrency})`,
    "  --no-network             run fully offline: refuse web tools and isolate bash/boom-exec",
    "  --experiment <label>      tag independent evaluation trials (requires --tokens)",
    "  --trials <n>              repeat selected challenges in fresh tasks (default: 1)",
    "  --slugs-file <path>       read a fixed challenge list, one slug per line",
    "",
    "The main solver may request consultation itself; context compaction also triggers one.",
    "With no slugs, run processes every challenge under the workspace root",
    "(<root>/challenges or category folders such as WEB/PWN/MISC directly inside <root>).",
    "",
    "Migrate options:",
    "  --root <dir>       workspace root (default: current directory)",
    "  --apply            write the planned moves (default: preview only)",
    "  --json             print the plan as JSON",
    "",
    "Migration only renames files inside the workspace: challenge/ becomes input/, the event and",
    "tool-run trails move under records/, and runs/ plus engagements/ move under tasks/.",
    "Unmigrated tasks keep working, so run it when convenient.",
    "",
    "Evaluate options:",
    "  --label <label>          select one experiment",
    "  --baseline <label>       compare matching trials against another experiment",
    "  --compare-root <dir>     baseline workspace (default: --root)",
    "  --slugs-file <path>      restrict both groups to a fixed challenge list",
    "  --json                   print scored samples, category summaries and paired comparison",
    "",
    "GUI options:",
    "  --root <dir>       workspace root (default: reopen the last one, first run: Boom's workspace)",
    "  --port <n>         local API port (default: 0, chooses a free port)",
    "  --native           open the macOS desktop client (default on macOS)",
    "  --browser          open the compatibility browser interface",
    "  --headless         start only the local API and print its URL",
    "  --no-open          alias for --headless",
    "  --no-network       run fully offline: refuse web tools and isolate bash/boom-exec",
    "",
  ].join("\n"))
  process.exit(code)
}

async function gui(argv: string[]) {
  let options
  try {
    options = parseGuiArgs(argv)
  } catch (error) {
    if (!(error instanceof GuiArgumentError)) throw error
    process.stderr.write(`${error.message}\n\n`)
    usage()
  }
  if (options.help) usage(0)

  let lifecycle: GuiLifecycle | undefined
  let requestedSignal: "SIGINT" | "SIGTERM" | undefined
  let shuttingDown: Promise<void> | undefined
  let keepSignalHandlers = false
  const shutdownForSignal = () => {
    if (!lifecycle || !requestedSignal) return
    const status = requestedSignal === "SIGINT" ? 130 : 143
    shuttingDown ??= lifecycle.shutdown().then(() => process.exit(status))
  }
  const onInterrupt = () => { requestedSignal ??= "SIGINT"; shutdownForSignal() }
  const onTerminate = () => { requestedSignal ??= "SIGTERM"; shutdownForSignal() }
  process.once("SIGINT", onInterrupt)
  process.once("SIGTERM", onTerminate)

  try {
    lifecycle = await startGuiLifecycle(options, { launchNative: launchDesktopClient })
    const label = lifecycle.mode === "native"
      ? "Boom desktop client"
      : lifecycle.mode === "browser"
        ? "Boom browser GUI"
        : "Boom GUI API"
    process.stdout.write(`${label} ${lifecycle.url}\n`)
    if (requestedSignal) {
      shutdownForSignal()
      await shuttingDown
      return
    }
    if (!lifecycle.done) {
      keepSignalHandlers = true
      return
    }
    const status = await lifecycle.done
    if (status !== 0) throw new Error(`Boom desktop client exited with status ${status}`)
  } catch (error) {
    if (lifecycle && !shuttingDown) await lifecycle.shutdown()
    throw error
  } finally {
    if (!keepSignalHandlers) {
      process.removeListener("SIGINT", onInterrupt)
      process.removeListener("SIGTERM", onTerminate)
    }
  }
}

function parse(argv: string[]): Args {
  const args: Args = {
    root: process.cwd(),
    model: DEFAULTS.model,
    economyModel: DEFAULTS.model,
    strongModel: DEFAULTS.model,
    consultModels: [],
    consultOnCompaction: true,
    limits: {
      repeats: DEFAULTS.repeats,
      timeout: DEFAULTS.minutes * 60_000,
      silenceMs: DEFAULTS.silenceMs,
    },
    concurrency: DEFAULTS.concurrency,
    only: [],
    trials: 1,
    executionMode: "managed",
    network: "allow",
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    const value = () => {
      const next = argv[++index]
      if (next === undefined) usage()
      return next
    }
    if (arg === "--root") args.root = path.resolve(value())
    else if (arg === "--model") {
      args.model = value()
      args.strongModel = args.model
    } else if (arg === "--economy-model") args.economyModel = value()
    else if (arg === "--strong-model") {
      args.strongModel = value()
      args.model = args.strongModel
    } else if (arg === "--python-profile") args.pythonProfile = value()
    else if (arg === "--python") args.pythonInterpreter = path.resolve(value())
    else if (arg === "--execution") {
      const mode = value()
      if (!new Set(["managed", "isolated", "static-only"]).has(mode)) usage()
      args.executionMode = mode as ExecutionMode
    } else if (arg === "--consult") args.consultModels.push(value())
    else if (arg === "--no-consult-on-compaction") args.consultOnCompaction = false
    else if (arg === "--tokens") args.limits.tokens = Number(value())
    else if (arg === "--repeats") args.limits.repeats = Number(value())
    else if (arg === "--minutes") args.limits.timeout = Number(value()) * 60_000
    else if (arg === "--concurrency") args.concurrency = Number(value())
    else if (arg === "--no-network") args.network = "deny"
    else if (arg === "--experiment") args.experiment = value()
    else if (arg === "--trials") args.trials = Number(value())
    else if (arg === "--slugs-file") args.slugsFile = path.resolve(value())
    else if (arg === "-h" || arg === "--help") usage(0)
    else if (arg.startsWith("-")) usage()
    else args.only.push(arg)
  }
  const tokenLimit = args.limits.tokens
  if (tokenLimit !== undefined && (!Number.isFinite(tokenLimit) || tokenLimit <= 0)) usage()
  if (!Number.isFinite(args.limits.repeats) || args.limits.repeats < 2) usage()
  if (!Number.isFinite(args.limits.timeout) || args.limits.timeout <= 0) usage()
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) usage()
  if (!Number.isSafeInteger(args.trials) || args.trials < 1 || args.trials > 100) usage()
  if (args.experiment) {
    normalizeExperiment({ label: args.experiment, trial: 1 })
    if (tokenLimit === undefined) throw new Error("Evaluation experiments require --tokens to keep trials comparable")
  }
  if (args.trials > 1 && !args.experiment) throw new Error("Repeated trials require --experiment")
  if (
    args.consultModels.length !== 0 &&
    (args.consultModels.length < CONSULT_EXPERTS.minimum ||
      args.consultModels.length > CONSULT_EXPERTS.maximum)
  ) usage()
  if (!args.economyModel.includes("/") || !args.strongModel.includes("/")) usage()
  if (args.consultModels.some((model) => !model.includes("/"))) usage()
  args.model = args.strongModel
  return args
}

type Row = { challenge: Challenge; run: RunHistory; directory: string; correct?: boolean }

function score(row: Row) {
  if (row.correct === true) return "correct"
  if (row.run.candidates.length === 0) return row.run.stop === "completed" ? "none" : "cut-short"
  return row.correct === false ? "wrong" : "candidate"
}

function report(rows: Row[]) {
  const lines = ["", "slug                 result     stop        tokens     cost  run", "".padEnd(78, "-")]
  let tokens = 0
  let cost = 0
  for (const row of rows) {
    tokens += row.run.tokens
    cost += row.run.cost
    lines.push([
      row.challenge.slug.padEnd(20).slice(0, 20),
      score(row).padEnd(10),
      row.run.stop.padEnd(11),
      String(row.run.tokens).padStart(6),
      row.run.cost.toFixed(4).padStart(8),
      ` ${path.relative(process.cwd(), row.directory)}`,
    ].join(" "))
  }
  const correct = rows.filter((row) => row.correct === true).length
  const scored = rows.filter((row) => row.correct !== undefined).length
  const cutShort = rows.filter((row) => score(row) === "cut-short").length
  lines.push("".padEnd(78, "-"))
  lines.push(
    `${rows.length} run(s), ${scored === 0 ? "nothing scorable" : `${correct}/${scored} correct`}` +
      `${cutShort === 0 ? "" : `, ${cutShort} cut short`}, ${tokens} tokens, $${cost.toFixed(4)}`,
  )
  for (const row of rows) if (row.run.detail) lines.push(`  ${row.challenge.slug}: ${row.run.detail}`)
  lines.push("")
  return lines.join("\n")
}

async function doctor() {
  const runtime = await inspectRuntime()
  const container = await detectContainerCapability()
  const environment = await resolveEnvironmentProfile({}).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }))
  const environmentLine = "profile" in environment
    ? `Python ${environment.profile.displayName} (${environment.profile.kind}, ${environment.profile.pythonVersion}, ${environment.profile.fingerprint.slice(0, 16)}…)`
    : `Python unconfigured (${environment.error})`
  process.stdout.write([
    `Boom ${await packageVersion()}`,
    `Bun ${Bun.version}`,
    `Execution runtime ${runtime.version}`,
    "Boom Provider catalog ready",
    ...runtime.providers.map((provider) =>
      `Boom Provider ${provider.id} (${provider.name}) ${provider.connected ? "authenticated" : "not authenticated"}; ${provider.models} model(s)`,
    ),
    ...Object.entries(runtime.mcp).map(([id, status]) =>
      `MCP ${id} ${status.status}${"error" in status ? ` (${status.error})` : ""}`,
    ),
    ...(Object.keys(runtime.mcp).length === 0 ? ["MCP no servers configured"] : []),
    `Resources ${runtime.directory}`,
    "Agents boom / boom-worker / boom-consultant",
    "Skill ctf-workflow",
    ...(runtime.skills.includes("reverse-engineer-anything")
      ? ["Skill reverse-engineer-anything (REA)"]
      : []),
    "Tools boom-exec / ctf-note / ctf-consult / ctf-submit",
    environmentLine,
    `Isolation ${container.status}${container.runtime ? ` (${container.runtime})` : ""}`,
    `Status ${"profile" in environment ? "ready" : "needs setup"}`,
    "",
  ].join("\n"))
}

async function run(argv: string[]) {
  const args = parse(argv)
  if (args.slugsFile) args.only.push(...await readSlugs(args.slugsFile))
  // Opening on a folder that has no workspace yet still leaves runs/ and challenges/ behind.
  await prepareWorkspaceRoot(args.root)
  const all = await discoverChallenges(args.root)
  const challenges = args.only.length === 0
    ? all
    : all.filter((challenge) => args.only.includes(challenge.slug))
  const missing = args.only.filter((slug) => !all.some((challenge) => challenge.slug === slug))
  if (missing.length > 0) throw new Error(`No such challenge(s): ${missing.join(", ")}`)
  if (challenges.length === 0)
    throw new Error(`No challenges found under ${args.root}`)

  const answers = await loadAnswers(args.root)
  const runner = new GuiRunner(args.root, undefined, undefined, { network: args.network })
  runner.setConcurrency(args.concurrency)
  const runIDs = new Map<string, string>()
  let interrupted: "SIGINT" | "SIGTERM" | undefined
  const unsubscribe = runner.subscribe((notification) => {
    if (notification.type === "run.started" && notification.slug && notification.runID) {
      runIDs.set(notification.slug, notification.runID)
      process.stderr.write(`==> ${notification.slug} (${args.model}) ${notification.runID}\n`)
    } else if (notification.type === "run.error" && notification.slug && notification.detail) {
      if (notification.runID && !notification.runID.startsWith("queued-"))
        runIDs.set(notification.slug, notification.runID)
      process.stderr.write(`    ${notification.slug}: ${notification.detail}\n`)
    }
  })
  const onInterrupt = () => { interrupted ??= "SIGINT"; runner.stop() }
  const onTerminate = () => { interrupted ??= "SIGTERM"; runner.stop() }
  process.once("SIGINT", onInterrupt)
  process.once("SIGTERM", onTerminate)

  try {
    const rows: Row[] = []
    for (let trial = 1; trial <= args.trials && !interrupted; trial += 1) {
      runIDs.clear()
      await runner.enqueue({
        ...(args.experiment ? { experiment: { label: args.experiment, trial } } : {}),
        challenges,
        model: args.model,
        modelPolicy: { economy: args.economyModel, strong: args.strongModel },
        consultModels: args.consultModels,
        consultOnCompaction: args.consultOnCompaction,
        blindReview: args.consultModels.length > 0,
        limits: args.limits,
        flagFormat: "",
        flagFormats: Object.fromEntries(challenges.map((challenge) => [challenge.slug, challenge.flagFormat])),
        ...(args.pythonProfile ? { environmentProfileId: args.pythonProfile } : {}),
        ...(args.pythonInterpreter ? { pythonInterpreter: args.pythonInterpreter } : {}),
        executionMode: args.executionMode,
        ...(args.consultModels.length >= CONSULT_EXPERTS.minimum
          ? {
              consultation: {
                trigger: "planning",
                expertModels: args.consultModels,
                synthesizerModel: args.strongModel,
              },
            }
          : {}),
      })
      while (runner.hasWork()) await Bun.sleep(50)

      for (const challenge of challenges) {
        const known = runIDs.get(challenge.slug)
        if (interrupted && !known) continue
        if (!known) throw new Error(`Run for ${challenge.slug} ended before creating a workspace`)
        const run = await readRunHistory(args.root, challenge.slug, known)
        const answer = answers.get(challenge.slug)
        rows.push({
          challenge,
          run,
          directory: await taskDirectoryFromRoot(args.root, challenge.slug, run.id),
          ...(answer === undefined ? {} : { correct: (run.candidateHistory ?? run.candidates).includes(answer) }),
        })
        process.stderr.write(
          `    ${challenge.slug}: ${run.stop}, ${run.tokens} tokens${run.detail ? ` — ${run.detail}` : ""}\n`,
        )
      }
    }
    process.stdout.write(report(rows))
    if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143
    else if (rows.some((row) => row.run.stop === "error")) process.exitCode = 1
  } finally {
    unsubscribe()
    process.removeListener("SIGINT", onInterrupt)
    process.removeListener("SIGTERM", onTerminate)
    await runner.close()
  }
}

async function readSlugs(file: string) {
  const slugs = (await Bun.file(file).text()).split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
  if (!slugs.length || slugs.some((slug) => /[\s/\\]/.test(slug)))
    throw new Error("Challenge list must contain one nonempty slug per line")
  return [...new Set(slugs)]
}

async function evaluate(argv: string[]) {
  let root = process.cwd(), baselineRoot: string | undefined, label: string | undefined
  let baseline: string | undefined, slugs: string[] | undefined, asJSON = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => { const next = argv[++index]; if (!next) usage(); return next }
    if (arg === "--root") root = path.resolve(value())
    else if (arg === "--label") label = value()
    else if (arg === "--baseline") baseline = value()
    else if (arg === "--compare-root") baselineRoot = path.resolve(value())
    else if (arg === "--slugs-file") slugs = await readSlugs(path.resolve(value()))
    else if (arg === "--json") asJSON = true
    else if (arg === "--help" || arg === "-h") usage(0)
    else usage()
  }
  if ((baseline && !label) || (baselineRoot && !baseline)) usage()
  const samples = await collectEvaluationSamples(root, { label, slugs })
  const summaries = aggregateEvaluation(samples)
  const categories = Object.fromEntries([...new Set(samples.map((item) => item.category))].sort()
    .map((category) => [category, aggregateEvaluation(samples.filter((item) => item.category === category))]))
  const comparison = baseline ? compareEvaluationSamples(
    await collectEvaluationSamples(baselineRoot ?? root, { label: baseline, slugs }), samples,
  ) : undefined
  process.stdout.write(asJSON
    ? `${JSON.stringify({ schema_version: 2, summaries, categories, samples, comparison }, undefined, 2)}\n`
    : `${evaluationMarkdown(summaries)}${comparison ? `\n\n对照结果：\n\n${JSON.stringify(comparison, undefined, 2)}` : ""}\n`)
}

async function migrate(argv: string[]) {
  let root = process.cwd()
  let apply = false
  let asJSON = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--root" && argv[index + 1]) root = path.resolve(argv[++index]!)
    else if (arg === "--apply") apply = true
    else if (arg === "--json") asJSON = true
    else if (arg === "-h" || arg === "--help") usage(0)
    else usage()
  }
  const plan = await planMigration(root)
  if (apply) {
    const result = await applyMigration(plan)
    process.stdout.write(asJSON ? `${JSON.stringify({ ...result.plan, applied: result.applied }, undefined, 2)}\n` : migrationReport(plan, { applied: result.applied }))
    return
  }
  process.stdout.write(
    asJSON ? `${JSON.stringify(plan, undefined, 2)}\n` : migrationReport(plan),
  )
}

async function main() {
  const [command, ...argv] = process.argv.slice(2)
  if (command === undefined || command === "-h" || command === "--help") usage(0)
  if (command === "doctor") return doctor()
  if (command === "evaluate") return evaluate(argv)
  if (command === "gui") return gui(argv)
  if (command === "migrate") return migrate(argv)
  if (command === "mcp") return mcpCommand(argv)
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${await packageVersion()}\n`)
    return
  }
  if (command === "run") return run(argv)
  usage()
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
