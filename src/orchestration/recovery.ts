import { createHash } from "node:crypto"
import type { Outcome, RunEvent } from "../session.ts"
import type { TaskRecovery } from "../task.ts"

export const RECOVERY_FAILURE_LIMIT = 3
const RETRY_DELAY_MS = 1_000

/** Infrastructure retries belong to the task, including renewals through the autonomy path. */
export function recordRecoveryFailure(input: {
  previous?: TaskRecovery
  model: string
  outcome: Pick<Outcome, "stop" | "finish" | "detail" | "candidates">
  recoverable: boolean
  events: RunEvent[]
  now?: number
}): TaskRecovery | undefined {
  if (input.outcome.candidates.length || input.outcome.stop === "completed" ||
      input.events.some((event) => event.type === "tool" && event.status === "completed")) return undefined
  if (!input.recoverable) return input.previous
  const reason = (input.outcome.detail ?? input.outcome.finish ?? input.outcome.stop)
    .replace(/https?:\/\/\S+/g, "[endpoint]")
    .replace(/\b\d+\b/g, "#")
    .slice(0, 2_000)
  const fingerprint = createHash("sha256")
    .update(`${input.model}\0${input.outcome.stop}\0${input.outcome.finish ?? ""}\0${reason}`)
    .digest("hex")
  const consecutiveFailures = input.previous?.fingerprint === fingerprint
    ? input.previous.consecutiveFailures + 1 : 1
  const now = input.now ?? Date.now()
  return {
    fingerprint,
    consecutiveFailures,
    lastFailureAt: new Date(now).toISOString(),
    retryAt: new Date(now + Math.min(30_000, RETRY_DELAY_MS * 2 ** Math.min(5, consecutiveFailures - 1))).toISOString(),
    blocked: consecutiveFailures >= RECOVERY_FAILURE_LIMIT,
  }
}

export async function waitForRecovery(retryAt: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const delay = Math.max(0, Date.parse(retryAt) - Date.now())
  if (!delay) return
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, delay)
    signal.addEventListener("abort", abort, { once: true })
  })
}
