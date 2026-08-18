import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import type { Challenge } from "../challenge.ts"
import type { TaskRecord } from "../task.ts"

const MAX_NOTES = 6_000
const MAX_ARTIFACTS = 8
/**
 * How many recent meaningful events the recovery summary keeps. It is used only when the solver
 * did not leave a usable durable checkpoint, so raw activity never competes with NOTES.md.
 */
const MAX_RECOVERY_EVENTS = 12
const MAX_EVENT_SUMMARY_CHARS = 1_800
const MAX_EVENT_TEXT = 220
const MAX_EVENT_TOOL = 160

function bounded(value: string | undefined, maximum: number) {
  const text = value?.trim() ?? ""
  if (text.length <= maximum) return text
  return `${text.slice(0, maximum)}\n[truncated, original ${text.length} chars]`
}

/**
 * A checkpoint may have been created by an older Boom version or written manually. Treat every
 * non-header line as durable state rather than requiring the current ctf-note timestamp syntax.
 * Otherwise a useful NOTES.md is followed by a large, low-fidelity event-log fallback.
 */
function hasDurableNotes(notes: string) {
  const structuralLines = new Set([
    "# NOTES",
    "NOTES",
    "Shared cross-turn, cross-model task memory. Maintained by the ctf-note tool.",
    "这是跨轮次、跨模型共享的任务记忆。由 ctf-note 工具维护。",
  ])
  return notes.split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    return trimmed !== "" && !structuralLines.has(trimmed)
  })
}

/** A minimal, defensive view of one `work/events.jsonl` record. */
type EventLogLine = {
  at: number
  type: string
  tool?: string
  status?: string
  text?: string
}

/**
 * Read the run's event log without ever following an agent-controlled link. The log lives under
 * `work/`, which the solving agent can write to; the same lstat/realpath discipline as the history
 * reader applies, so a symlink planted there can never point the handoff at an arbitrary file.
 */
async function readEventLog(directory: string): Promise<EventLogLine[] | undefined> {
  let target = path.join(directory, "work", "events.jsonl")
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
    const canonical = await realpath(target)
    const root = await realpath(directory)
    if (canonical !== root && !canonical.startsWith(root + path.sep)) return undefined
    target = canonical
  } catch {
    return undefined
  }
  const raw = await readFile(target, "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  const events: EventLogLine[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown> | null
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
      if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) continue
      const event: EventLogLine = { at: parsed.at, type: String(parsed.type ?? "") }
      if (typeof parsed.tool === "string") event.tool = parsed.tool
      if (typeof parsed.status === "string") event.status = parsed.status
      if (typeof parsed.text === "string") event.text = parsed.text
      events.push(event)
    } catch {
      // A partial final line after a crash must not hide the rest of the log.
    }
  }
  return events
}

/**
 * Summarize the newest meaningful activity from the event log: what the model said, which tools it
 * ran with what input, and a few key statuses. Tool invocations collapse to their `running` input
 * (plus the result title on completion) so a single tool call reads as one line instead of three.
 * This is deterministic and model-free, so a continuation turn always gets a picture of the actual
 * work even when the solver never wrote NOTES.md.
 */
function summarizeRecentActivity(events: EventLogLine[], maximum: number): string {
  interface Line extends EventLogLine {
    kind: "text" | "tool" | "status"
  }
  const lines: Line[] = []
  for (const event of events) {
    if (event.type === "text" && event.text?.trim()) {
      lines.push({ ...event, kind: "text" })
    } else if (event.type === "tool") {
      // Keep the invocation input and the terminal result; skip the intermediate state noise.
      if (event.status === "running" || event.status === "completed" || event.status === "error")
        lines.push({ ...event, kind: "tool" })
    } else if (event.type === "status") {
      const status = event.status ?? ""
      if (status.startsWith("model.switch") || status.startsWith("context.compaction") || status === "watchdog.busy")
        lines.push({ ...event, kind: "status" })
    }
  }
  const recent = lines.slice(-maximum)
  if (recent.length === 0) return ""
  const anchor = recent[0].at
  const rendered: string[] = []
  for (const event of recent) {
    const delta = Math.round((event.at - anchor) / 1000)
    const at = `${delta >= 0 ? "+" : "-"}${Math.abs(delta)}s`
    if (event.kind === "text") {
      rendered.push(`[${at}] Model: ${bounded(event.text, MAX_EVENT_TEXT)}`)
    } else if (event.kind === "tool") {
      const outcome = event.status === "running" ? "" : ` ${event.status}`
      rendered.push(`[${at}] Tool ${event.tool}${outcome}: ${bounded(event.text, MAX_EVENT_TOOL)}`)
    } else {
      rendered.push(`[${at}] ${event.status}: ${bounded(event.text, MAX_EVENT_TOOL)}`)
    }
  }
  return bounded(rendered.join("\n"), MAX_EVENT_SUMMARY_CHARS)
}

export async function recentArtifacts(directory: string, maximum: number) {
  const root = await realpath(directory)
  const work = path.join(root, "work")
  const files: Array<{ path: string; mtime: number }> = []
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === ".boom") continue
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await visit(target); continue }
      if (!entry.isFile()) continue
      const canonical = await realpath(target)
      const relative = path.relative(root, canonical)
      if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.startsWith("work")) continue
      const info = await lstat(canonical).catch(() => undefined)
      if (!info) continue
      files.push({ path: relative.split(path.sep).join("/"), mtime: info.mtimeMs })
    }
  }
  await visit(work)
  return files.sort((left, right) => right.mtime - left.mtime).slice(0, maximum).map((file) => file.path)
}

/**
 * A deterministic, no-model-call handoff injected at the start of every continuation turn.
 * It gives a fresh solver session a compact index into the durable evidence. The stable task card
 * comes before per-turn state so provider prefix caching can retain it across continuations.
 */
export async function buildHandoffSummary(input: {
  directory: string
  challenge: Challenge
  task: TaskRecord
}) {
  const notes = await readFile(path.join(input.directory, "NOTES.md"), "utf8").catch(() => "")
  const artifacts = await recentArtifacts(input.directory, MAX_ARTIFACTS)
  const events = await readEventLog(input.directory)
  const durableNotes = hasDurableNotes(notes)
  const activity = !durableNotes
    ? summarizeRecentActivity(events ?? [], MAX_RECOVERY_EVENTS)
    : ""
  const lines: string[] = [
    "## Compact handoff (auto-generated, continuation start)",
    "",
    "## Task card",
    `Challenge: ${input.challenge.slug}`,
    `Category: ${input.challenge.category ?? "OTHER"}`,
    ...(input.challenge.remote?.trim() ? [`Remote: ${input.challenge.remote.trim()}`] : []),
    "Input: challenge/ (read-only) · Durable evidence: NOTES.md and work/",
    "",
    "## Current task state",
    `Status: ${input.task.status} · ${input.task.turns.length} turns run · ${input.task.rejectedFlags.length} candidates excluded.`,
  ]
  if (durableNotes) lines.push("", "## Durable checkpoint (NOTES.md)", bounded(notes, MAX_NOTES))
  if (!durableNotes && activity) {
    lines.push(
      "",
      "## Recovery activity (no durable checkpoint found)",
      activity,
    )
  }
  if (artifacts.length > 0) lines.push("", "## Recent artifacts", ...artifacts.map((file) => `- ${file}`))
  return lines.join("\n")
}
