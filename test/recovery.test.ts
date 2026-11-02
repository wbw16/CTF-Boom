import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { recordRecoveryFailure, waitForRecovery } from "../src/orchestration/recovery.ts"
import { loadOrCreateTask, loadTaskRecord, saveTaskRecord } from "../src/task.ts"

const failure = {
  model: "test/model", recoverable: true, events: [], now: 1_000,
  outcome: { stop: "error" as const, finish: "unknown", candidates: [], detail: "provider finish reason: unknown" },
}

test("the failure circuit survives task reloads and backs off before blocking", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-recovery-state-"))
  try {
    const task = await loadOrCreateTask(directory, { id: "task-1", slug: "alpha", model: "test/model" })
    task.recovery = recordRecoveryFailure(failure)
    expect(task.recovery).toMatchObject({ consecutiveFailures: 1, retryAt: new Date(2_000).toISOString(), blocked: false })
    await saveTaskRecord(directory, task)
    const second = recordRecoveryFailure({ ...failure, previous: (await loadTaskRecord(directory))?.recovery })!
    expect(second).toMatchObject({ consecutiveFailures: 2, retryAt: new Date(3_000).toISOString(), blocked: false })
    expect(recordRecoveryFailure({ ...failure, previous: second })).toMatchObject({ consecutiveFailures: 3, blocked: true })
    expect(recordRecoveryFailure({ ...failure, previous: second, model: "test/changed" })).toMatchObject({ consecutiveFailures: 1 })
    expect(recordRecoveryFailure({ ...failure, previous: second, events: [{ at: 1, type: "tool", tool: "bash", status: "completed" }] })).toBeUndefined()
    expect(recordRecoveryFailure({ ...failure, previous: second, outcome: { ...failure.outcome, stop: "completed" } })).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("recovery waits are cancelled immediately", async () => {
  const controller = new AbortController()
  const waiting = waitForRecovery(new Date(Date.now() + 30_000).toISOString(), controller.signal)
  controller.abort(new Error("cancelled by user"))
  await expect(waiting).rejects.toThrow("cancelled by user")
})
