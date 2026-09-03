import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { unwrapFlagValue } from "../platform/adapter.ts"

/**
 * Durable per-challenge submission ledger.
 *
 * Competition platforms cap submissions per challenge and forbid brute-forcing outright, so Boom
 * keeps its own low ceiling and refuses to resend a value it has already tried. The ledger is
 * persisted so a process restart mid-match cannot reset the count and walk into the platform's limit.
 *
 * Comparison uses the unwrapped flag value, so `DASCTF{x}` and a bare `x` count as the same attempt.
 */

export type SubmissionAttempt = {
  /** The value actually sent, i.e. the contents of the flag braces. */
  value: string
  verdict: "accepted" | "rejected" | "pending"
  at: string
  detail?: string
}

export type SubmissionLedger = {
  version: 1
  slug: string
  attempts: SubmissionAttempt[]
}

const LEDGER_NAME = "submissions.json"

/**
 * Product-side anti-brute-force ceiling used when no platform adapter is loaded; a registered
 * adapter usually supplies its own (lower or platform-informed) limit through `limits`.
 */
export const DEFAULT_MAX_SUBMISSIONS_PER_CHALLENGE = 15

function empty(slug: string): SubmissionLedger {
  return { version: 1, slug, attempts: [] }
}

function parse(slug: string, value: unknown): SubmissionLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty(slug)
  const input = value as Record<string, unknown>
  if (input.version !== 1) return empty(slug)
  const attempts = Array.isArray(input.attempts) ? input.attempts : []
  return {
    version: 1,
    slug,
    attempts: attempts.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
      const item = raw as Record<string, unknown>
      if (typeof item.value !== "string" || typeof item.at !== "string") return []
      const verdict = item.verdict
      if (verdict !== "accepted" && verdict !== "rejected" && verdict !== "pending") return []
      return [{
        value: item.value,
        verdict,
        at: item.at,
        ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
      }]
    }),
  }
}

function ledgerPath(root: string, slug: string) {
  // The slug becomes a filename, so it must not be able to escape the ledger directory.
  if (!slug.trim() || slug.includes("/") || slug.includes("\\") || slug.includes("\0") || slug.includes(".."))
    throw new Error(`Invalid challenge slug for a submission ledger: ${slug}`)
  // Keyed by challenge, not by run, because the cap is per challenge and must survive new runs.
  // Deliberately NOT inside `runs/<slug>/`: entries there are enumerated as run IDs, so a stray file
  // would be read as a run directory.
  return path.join(path.resolve(root), "competition", "submissions", `${slug}.json`)
}

export async function loadSubmissionLedger(root: string, slug: string) {
  const target = ledgerPath(root, slug)
  const info = await lstat(target).catch(() => undefined)
  if (!info) return empty(slug)
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Submission ledger is not a real file: ${target}`)
  try {
    return parse(slug, JSON.parse(await readFile(target, "utf8")))
  } catch {
    // A corrupt ledger must not block solving; treat it as empty but keep the cap conservative.
    return empty(slug)
  }
}

export async function saveSubmissionLedger(root: string, ledger: SubmissionLedger) {
  const target = ledgerPath(root, ledger.slug)
  await mkdir(path.dirname(target), { recursive: true })
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`Submission ledger is not a real file: ${target}`)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(ledger, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
  return ledger
}

export type SubmissionGate =
  | { allowed: true; value: string }
  | { allowed: false; reason: string }

/**
 * Decide whether a candidate may be submitted.
 *
 * Rejecting a duplicate is what keeps repeated solver attempts from consuming the platform's quota,
 * and refusing past the cap is what keeps Boom clear of the anti-brute-force rule.
 */
export function gateSubmission(input: {
  ledger: SubmissionLedger
  candidate: string
  maxSubmissions: number
}): SubmissionGate {
  const value = unwrapFlagValue(input.candidate)
  if (!value) return { allowed: false, reason: "候选 flag 为空" }
  if (input.ledger.attempts.some((attempt) => attempt.verdict === "accepted"))
    return { allowed: false, reason: "该题已有被平台接受的 flag，无需重复提交" }
  const duplicate = input.ledger.attempts.find((attempt) => attempt.value === value)
  if (duplicate)
    return {
      allowed: false,
      reason: `该候选已于 ${duplicate.at} 提交过（判定：${duplicate.verdict}），不重复提交`,
    }
  // Pending attempts still consumed a platform submission, so they count toward the cap.
  if (input.ledger.attempts.length >= input.maxSubmissions)
    return {
      allowed: false,
      reason: `已提交 ${input.ledger.attempts.length} 次，达到 Boom 的每题上限 ${input.maxSubmissions}，禁止爆破`,
    }
  return { allowed: true, value }
}

export function recordAttempt(
  ledger: SubmissionLedger,
  attempt: SubmissionAttempt,
): SubmissionLedger {
  return { ...ledger, attempts: [...ledger.attempts, attempt] }
}

/** Values already ruled out, for feeding back into the solver's context. */
export function rejectedValues(ledger: SubmissionLedger) {
  return ledger.attempts.filter((attempt) => attempt.verdict === "rejected").map((attempt) => attempt.value)
}
