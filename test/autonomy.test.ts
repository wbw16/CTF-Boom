import { afterEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decideAutonomy, runAutonomyEscalation } from "../src/orchestration/escalation.ts"
import {
  captureProgressSnapshot,
  hasProductiveLongRunningTool,
  loadAutonomyState,
  markAutomaticContinuation,
  recordTurnProgress,
  saveAutonomyState,
  startEscalation,
  finishEscalation,
} from "../src/orchestration/progress.ts"
import type { Outcome, RunEvent } from "../src/session.ts"
import type { AgentRuntime } from "../src/runtime-contract.ts"
import type { TaskRecord } from "../src/task.ts"
import { bindTaskEnvironment, probePythonEnvironment } from "../src/environment.ts"

const temporary: string[] = []
async function removeProtected(directory: string) {
  const info = await lstat(directory).catch(() => undefined)
  if (!info) return
  if (info.isDirectory()) {
    await chmod(directory, 0o700).catch(() => {})
    for (const entry of await readdir(directory)) await removeProtected(path.join(directory, entry))
  } else await chmod(directory, 0o600).catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
afterEach(async () => Promise.all(
  temporary.splice(0).map(removeProtected),
))

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-autonomy-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "work"))
  await mkdir(path.join(directory, "challenge"))
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n")
  return directory
}

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return {
    stop: "completed",
    tokens: 100,
    billable: 100,
    cost: 0,
    reply: "yield",
    candidates: [],
    ...overrides,
  }
}

describe("M1.5 autonomy progress and escalation", () => {
  test("continues the same main agent once, then escalates two empty normal yields early", async () => {
    const directory = await fixture()
    const before = await captureProgressSnapshot(directory)
    await recordTurnProgress({
      directory,
      before,
      after: before,
      outcome: outcome(),
      events: [],
      cumulativeBillable: 100,
      now: 1_000,
    })
    let state = await loadAutonomyState(directory, 1_000)
    expect(decideAutonomy({
      state,
      outcome: outcome(),
      activeSolveMs: 1_000,
      cumulativeBillable: 100,
      challengeTokenBudget: 100_000,
      now: 1_000,
    })).toMatchObject({ action: "continue" })
    expect(decideAutonomy({
      state,
      outcome: outcome({ reply: "BOOM_ESCALATE_REQUEST: need an independent view" }),
      activeSolveMs: 1_000,
      cumulativeBillable: 100,
      challengeTokenBudget: 100_000,
      now: 1_000,
    })).toMatchObject({ action: "escalate", level: 1, early: true })

    await markAutomaticContinuation(directory, 1_100)
    await recordTurnProgress({
      directory,
      before,
      after: before,
      outcome: outcome(),
      events: [],
      cumulativeBillable: 200,
      now: 2_000,
    })
    state = await loadAutonomyState(directory, 2_000)
    expect(decideAutonomy({
      state,
      outcome: outcome(),
      activeSolveMs: 2_000,
      cumulativeBillable: 200,
      challengeTokenBudget: 100_000,
      now: 2_000,
    })).toMatchObject({ action: "escalate", level: 1, early: true })
  })

  test("runs at most one L1 second opinion per progress fingerprint", async () => {
    const directory = await fixture()
    const startedAt = Date.parse("2026-08-03T00:00:00.000Z")
    const state = await loadAutonomyState(directory, startedAt)
    state.automaticContinuationUsedAt = new Date(startedAt).toISOString()
    state.lastProgressAt = new Date(startedAt).toISOString()
    state.billableAtLastProgress = 1_000
    await saveAutonomyState(directory, state)
    const first = decideAutonomy({
      state,
      outcome: outcome(),
      activeSolveMs: 20 * 60_000,
      cumulativeBillable: 11_000,
      challengeTokenBudget: 100_000,
      now: startedAt + 20 * 60_000,
    })
    expect(first).toMatchObject({ action: "escalate", level: 1, early: false })
    if (first.action !== "escalate") throw new Error("expected escalation")

    const record1 = await startEscalation({
      directory,
      fingerprint: state.progressEpoch,
      level: 1,
      reason: "test stall",
      now: startedAt + 1_000,
    })
    await finishEscalation({
      directory,
      id: record1.id,
      status: "completed",
      tokens: 10,
      billable: 10,
      cost: 0,
      now: startedAt + 1_001,
    })
    const afterL1 = await loadAutonomyState(directory, startedAt + 20 * 60_000)
    afterL1.automaticContinuationUsedAt = new Date(startedAt).toISOString()
    expect(decideAutonomy({
      state: afterL1,
      outcome: outcome(),
      activeSolveMs: 20 * 60_000,
      cumulativeBillable: 11_000,
      challengeTokenBudget: 100_000,
      now: startedAt + 20 * 60_000,
    })).toMatchObject({
      action: "none",
      reason: expect.stringContaining("L1"),
    })

    const repeated = decideAutonomy({
      state: afterL1,
      outcome: outcome(),
      activeSolveMs: 20 * 60_000,
      cumulativeBillable: 11_000,
      challengeTokenBudget: 100_000,
      now: startedAt + 20 * 60_000,
      manual: true,
    })
    expect(repeated).toMatchObject({
      action: "none",
      reason: expect.stringContaining("L1"),
    })
  })

  test("records only hashed artifacts, durable ctf-note changes, and non-repeated successful tools", async () => {
    const directory = await fixture()
    const before = await captureProgressSnapshot(directory)
    await writeFile(path.join(directory, "work", "evidence.txt"), "evidence")
    await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n\nruled out H1\n")
    const events: RunEvent[] = [
      { at: 1, type: "tool", tool: "ctf-note", status: "completed", text: "ruled-out -> NOTES.md" },
      { at: 2, type: "tool", tool: "bash", status: "completed", text: "file · exit 0" },
    ]
    const first = await recordTurnProgress({
      directory,
      before,
      outcome: outcome(),
      events,
      cumulativeBillable: 1_000,
      now: 3,
    })
    expect(first.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["artifact", "durable-note", "tool-result"]),
    )
    expect(first.durable).toBe(true)
    expect(JSON.stringify(first.state)).not.toContain("evidence\"")

    const after = await captureProgressSnapshot(directory)
    const second = await recordTurnProgress({
      directory,
      before: after,
      after,
      outcome: outcome(),
      events,
      cumulativeBillable: 2_000,
      now: 4,
    })
    expect(second.events).toEqual([])
  })

  test("cools down a failed level for the same progress fingerprint", async () => {
    const directory = await fixture()
    const now = Date.parse("2026-08-03T01:00:00.000Z")
    const state = await loadAutonomyState(directory, now - 20 * 60_000)
    state.automaticContinuationUsedAt = new Date(now).toISOString()
    state.lastProgressAt = new Date(now - 20 * 60_000).toISOString()
    await saveAutonomyState(directory, state)
    const record = await startEscalation({
      directory,
      fingerprint: state.progressEpoch,
      level: 1,
      reason: "failed provider",
      now: now - 1_000,
    })
    await finishEscalation({
      directory,
      id: record.id,
      status: "failed",
      tokens: 0,
      billable: 0,
      cost: 0,
      now,
    })
    const cooled = await loadAutonomyState(directory, now + 1)
    expect(decideAutonomy({
      state: cooled,
      outcome: outcome(),
      activeSolveMs: 20 * 60_000,
      cumulativeBillable: 30_000,
      challengeTokenBudget: 100_000,
      now: now + 1,
    })).toMatchObject({ action: "none", reason: "matching L1 fingerprint is cooling down" })
    expect(decideAutonomy({
      state: cooled,
      outcome: outcome(),
      activeSolveMs: 20 * 60_000,
      cumulativeBillable: 30_000,
      challengeTokenBudget: 100_000,
      now: now + 5 * 60_000 + 1,
    })).toMatchObject({ action: "escalate", level: 1 })
  })

  test("does not trigger while an active long tool is still producing activity", async () => {
    const events: RunEvent[] = [
      { at: 1_000, type: "tool", tool: "bash", status: "running", text: "long job" },
      { at: 50_000, type: "text", text: "heartbeat" },
    ]
    expect(hasProductiveLongRunningTool(events, 60_000)).toBe(true)
    const state = {
      ...(await loadAutonomyState(await fixture(), 0)),
      automaticContinuationUsedAt: new Date(0).toISOString(),
      lastProgressAt: new Date(0).toISOString(),
    }
    expect(decideAutonomy({
      state,
      outcome: outcome(),
      activeSolveMs: 20 * 60_000,
      cumulativeBillable: 30_000,
      challengeTokenBudget: 100_000,
      productiveLongRunningTool: true,
      now: 20 * 60_000,
    })).toMatchObject({ action: "none", reason: "productive long-running tool is still active" })
  })

  test("executes one bounded L1 through the shared consultant role without a report workspace", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) return
    const directory = await fixture()
    await writeFile(path.join(directory, "challenge", "payload.txt"), "payload")
    const profile = await probePythonEnvironment({ interpreter, displayName: "autonomy test Python" })
    await bindTaskEnvironment({ directory, profile, source: "task-override" })
    const calls: string[] = []
    const report = JSON.stringify({
      facts: [],
      hypotheses: [{ statement: "H1", evidenceNeeded: ["work/evidence.txt"] }],
      experiments: ["A", "B"].map((name) => ({
        title: `bounded test ${name}`,
        objective: `distinguish H1 via ${name}`,
        expectedEvidence: `work/evidence-${name}.txt`,
        stopCondition: "one execution",
        tier: "economy",
        budgetTokens: 1_000,
      })),
      risks: [],
      decision: { route: "run the bounded test", reason: "cheapest evidence", nextCheckpoint: "test result" },
    })
    const runtime: AgentRuntime = {
      async createConversation() {
        return {
          id: `conversation-${calls.length}`,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(input) {
            calls.push(input.agent)
            return {
              usage: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0.01,
              finish: "stop",
              parts: [{ type: "text", text: report }],
            }
          },
          async abort() {},
        }
      },
    }
    const task: TaskRecord = {
      version: 1,
      id: "task",
      slug: "sample",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentModel: "test/strong",
      rejectedFlags: [],
      turns: [],
    }
    const workspace = { directory, runID: "task", extracted: [] }
    const challenge = {
      slug: "sample",
      directory: path.join(directory, "challenge"),
      description: "inspect payload",
      files: ["payload.txt"],
      flagFormat: "",
    }
    const state = await loadAutonomyState(directory, 1)
    const result = await runAutonomyEscalation({
        runtime,
        challenge,
        workspace,
        task,
        policy: { economy: "test/economy", strong: "test/strong" },
        limits: { tokens: 10_000, repeats: 5, timeout: 10_000 },
        decision: {
          action: "escalate",
          level: 1,
          reason: "test L1",
          fingerprint: state.progressEpoch,
          early: true,
        },
      })
    expect(result).toMatchObject({ level: 1, status: "completed", tokens: 20, billable: 20 })
    expect(result.hint).toContain(report)
    expect(calls).toEqual(["boom-consultant"])
    expect((await loadAutonomyState(directory)).escalations.map((item) => item.level)).toEqual([1])
    expect(await Bun.file(path.join(directory, "work", "escalations")).exists()).toBe(false)
  })
})
