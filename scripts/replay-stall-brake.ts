/**
 * Replay the in-turn dead-end brake against archived runs to calibrate its threshold.
 *
 * The brake aborts a solve turn once it has spent `stalledInTurnBudgetRatio` of the challenge's token
 * budget with no durable signal. Choosing that ratio by running real challenges costs real money, but
 * every archived run already carries what the brake looks at: `work/events.jsonl` records cumulative
 * billable tokens per usage event and every tool call by name. So the counterfactual — would the brake
 * have fired, and would it have killed a run that went on to produce a candidate — is computable
 * offline, for free, from runs that already happened.
 *
 * Two reasons the firing counts here are an UPPER bound on the real brake:
 *   - Artifact writes emit no runtime event, so a bash command's text is all there is to go on. The
 *     regex below is a heuristic; a write it misses shows up as a longer gap than really occurred.
 *   - Stage two of the real brake (rescan artifact mtimes, never cut while a tool runs) can only ever
 *     suppress a firing, never cause one.
 * A false positive found here is therefore a floor, not an artifact — which is what makes this
 * evidence usable for raising the threshold.
 *
 * Usage: bun scripts/replay-stall-brake.ts [--runs <dir>] [--ratios 0.15,0.2,0.25] [--top <n>]
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

/** Tools whose completion is durable by construction: ctf-note writes NOTES.md, ctf-submit records a candidate. */
const DURABLE_TOOLS = new Set(["ctf-note", "ctf-submit"])
/** Tools that write a file directly. */
const WRITER_TOOLS = new Set(["write", "edit", "apply_patch"])
/**
 * A bash command that plausibly creates or modifies a file in the workspace. Deliberately generous:
 * over-counting durable signals shortens gaps and so under-reports firing, keeping this an upper bound
 * on the brake's aggressiveness rather than a flattering one.
 */
const BASH_WRITES = new RegExp([
  />>?\s*\S/.source,                                  // redirection
  /\b(?:tee|cp|mv|dd|unzip|tar|gunzip|7z)\b/.source,  // copy/extract
  /\b(?:binwalk|foremost|steghide|zsteg|outguess)\b/.source, // carving/stego, all write output
  /\bopen\([^)]*['"][wax]/.source,                    // python open(..., "w")
  /\.save\(|\.write\(|savefig/.source,                // pillow/matplotlib
].join("|"))

type Row = {
  run: string
  slug: string
  stop: string
  candidate: boolean
  budget: number
  worstGap: number
  ratio: number
}

type Options = { runs: string; ratios: number[]; top: number }

function usage(): never {
  process.stderr.write(
    "Usage: bun scripts/replay-stall-brake.ts [--runs <dir>] [--ratios 0.15,0.25] [--top <n>]\n",
  )
  process.exit(1)
}

function options(argv: string[]): Options {
  const result: Options = {
    runs: path.resolve("ctf/runs"),
    ratios: [0.15, 0.20, 0.25, 0.30, 0.40, 0.50],
    top: 12,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--runs" && argv[index + 1]) result.runs = path.resolve(argv[++index]!)
    else if (arg === "--ratios" && argv[index + 1]) {
      result.ratios = argv[++index]!.split(",").map((value) => Number(value.trim()))
      if (result.ratios.some((value) => !Number.isFinite(value) || value <= 0)) usage()
    } else if (arg === "--top" && argv[index + 1]) result.top = Number(argv[++index]!)
    else usage()
  }
  return result
}

/** Every `<runs>/<slug>/<timestamp-model>` directory. */
async function runDirectories(root: string) {
  const found: string[] = []
  for (const slug of await readdir(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue
    const slugPath = path.join(root, slug.name)
    for (const run of await readdir(slugPath, { withFileTypes: true }).catch(() => [])) {
      if (run.isDirectory()) found.push(path.join(slugPath, run.name))
    }
  }
  return found.sort()
}

function isDurable(event: { tool?: string; text?: string }) {
  const tool = event.tool
  if (!tool) return false
  if (DURABLE_TOOLS.has(tool) || WRITER_TOOLS.has(tool)) return true
  return tool === "bash" && BASH_WRITES.test(event.text ?? "")
}

/**
 * Largest billable-token gap between durable signals, mirroring the brake's own accounting: a plain
 * tool call never counts, and a turn boundary resets the counter because the brake is per-turn. A
 * usage event with status `tool-calls` is mid-turn; anything else ends one.
 */
async function worstGap(eventsPath: string) {
  const text = await readFile(eventsPath, "utf8").catch(() => "")
  let atDurable = 0
  let billable = 0
  let worst = 0
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let event: { type?: string; status?: string; billable?: number; tool?: string; text?: string }
    try {
      event = JSON.parse(line)
    } catch {
      continue // A run interrupted mid-write leaves a partial final line.
    }
    if (event.type === "usage") {
      billable = event.billable ?? billable
      worst = Math.max(worst, billable - atDurable)
      if (event.status !== "tool-calls") atDurable = billable
    } else if (event.type === "tool" && event.status === "completed" && isDurable(event)) {
      atDurable = billable
    }
  }
  return worst
}

async function collect(root: string) {
  const rows: Row[] = []
  for (const run of await runDirectories(root)) {
    const result = await readFile(path.join(run, "result.json"), "utf8")
      .then((text) => JSON.parse(text) as Record<string, any>)
      .catch(() => undefined)
    const budget = result?.limits?.tokens
    // A run without a recorded budget cannot be scored: the brake's threshold is a share of it.
    if (!result || typeof budget !== "number" || budget <= 0) continue
    const gap = await worstGap(path.join(run, "work", "events.jsonl"))
    rows.push({
      run,
      slug: String(result.slug ?? path.basename(path.dirname(run))),
      stop: String(result.stop ?? "unknown"),
      candidate: Boolean(result.primary_candidate),
      budget,
      worstGap: gap,
      ratio: gap / budget,
    })
  }
  return rows.sort((left, right) => right.ratio - left.ratio)
}

function report(rows: Row[], opts: Options) {
  const out = (line: string) => process.stdout.write(`${line}\n`)
  if (rows.length === 0) {
    out(`No scorable runs under ${opts.runs} (need result.json with limits.tokens and work/events.jsonl).`)
    return
  }
  out(`Replayed ${rows.length} runs from ${opts.runs}`)
  out("")
  out("  ratio   fires   false positives (run had produced a candidate)")
  for (const ratio of opts.ratios) {
    const fired = rows.filter((row) => row.ratio >= ratio)
    const positives = fired.filter((row) => row.candidate)
    out(
      `  ${ratio.toFixed(2)}   ${String(fired.length).padStart(3)}/${rows.length}` +
        `   ${String(positives.length).padStart(3)}` +
        (positives.length > 0 ? `  (${positives.map((row) => row.slug).join(", ")})` : ""),
    )
  }
  out("")
  out(`Largest gaps (top ${opts.top}):`)
  for (const row of rows.slice(0, opts.top)) {
    out(
      `  ${row.ratio.toFixed(2)}  ${String(Math.round(row.worstGap)).padStart(7)}/${row.budget}` +
        `  stop=${row.stop.padEnd(10)} candidate=${row.candidate ? "yes" : "no "}  ${row.slug}`,
    )
  }
  out("")
  out("Median largest-gap ratio by stop reason:")
  const byStop = new Map<string, number[]>()
  for (const row of rows) byStop.set(row.stop, [...(byStop.get(row.stop) ?? []), row.ratio])
  for (const [stop, ratios] of [...byStop].sort((left, right) => right[1].length - left[1].length)) {
    const sorted = [...ratios].sort((left, right) => left - right)
    const median = sorted[Math.floor(sorted.length / 2)]!
    out(`  ${stop.padEnd(12)} n=${String(ratios.length).padStart(3)}  median=${median.toFixed(2)}  max=${sorted.at(-1)!.toFixed(2)}`)
  }
}

const opts = options(process.argv.slice(2))
report(await collect(opts.runs), opts)
