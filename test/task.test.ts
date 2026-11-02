import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  archiveTask,
  acceptTaskFlag,
  loadOrCreateTask,
  loadTaskRecord,
  rejectTaskFlag,
  saveTaskRecord,
  taskTotals,
  updateTaskRecord,
} from "../src/task.ts"

describe("durable task metadata", () => {
  test("refuses to overwrite corrupt task history or mutate its identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-task-corrupt-"))
    try {
      const seed = { id: "task", slug: "sample", model: "test/model" }
      await loadOrCreateTask(directory, seed)
      await expect(updateTaskRecord(directory, (task) => { task.id = "wrong"; return task }))
        .rejects.toThrow("identity")
      expect((await loadTaskRecord(directory))?.id).toBe("task")
      await writeFile(path.join(directory, "task.json"), "{broken")
      await expect(loadOrCreateTask(directory, seed)).rejects.toThrow("refusing to replace")
      expect(await Bun.file(path.join(directory, "task.json")).text()).toBe("{broken")
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test("concurrent turn updates merge with manual acceptance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-task-race-"))
    try {
      await loadOrCreateTask(directory, { id: "task", slug: "sample", model: "test/model" })
      await Promise.all([
        acceptTaskFlag({ directory, flag: "flag{manual}", source: "manual", detail: "reviewed" }),
        updateTaskRecord(directory, (task) => {
          task.currentModel = "test/next"
          task.status = task.acceptedFlag ? "solved" : "paused"
          return task
        }),
      ])
      expect(await loadTaskRecord(directory)).toMatchObject({ status: "solved", currentModel: "test/next", acceptedFlag: { value: "flag{manual}" } })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  test("keeps multiple model turns in one workspace and aggregates their usage", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-task-"))
    try {
      await mkdir(path.join(directory, "work"))
      await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n")
      const task = await loadOrCreateTask(directory, {
        id: "20260730T010203Z-task",
        slug: "alpha",
        model: "openai/a",
      })
      task.turns.push(
        {
          id: "turn-1",
          model: "openai/a",
          startedAt: "2026-07-30T01:02:03.000Z",
          finishedAt: "2026-07-30T01:03:03.000Z",
          stop: "budget",
          tokens: 100,
          billableTokens: 80,
          cost: 0.1,
          candidates: [],
        },
        {
          id: "turn-2",
          model: "anthropic/b",
          prompt: "继续验证",
          startedAt: "2026-07-30T01:04:03.000Z",
          finishedAt: "2026-07-30T01:05:03.000Z",
          stop: "completed",
          tokens: 50,
          billableTokens: 40,
          cost: 0.2,
          candidates: ["flag{candidate}"],
        },
      )
      task.currentModel = "anthropic/b"
      task.status = "candidate-found"
      await saveTaskRecord(directory, task)

      const loaded = await loadTaskRecord(directory)
      expect(loaded).toMatchObject({
        id: task.id,
        currentModel: "anthropic/b",
        status: "candidate-found",
        turns: [{ model: "openai/a" }, { model: "anthropic/b", prompt: "继续验证" }],
      })
      const totals = taskTotals(loaded!)
      expect(totals).toMatchObject({ tokens: 150, billableTokens: 120 })
      expect(totals.cost).toBeCloseTo(0.3)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("records a rejected candidate in task memory and archives without writing a known flag", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-task-"))
    try {
      await mkdir(path.join(directory, "work"))
      await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n\n## 下一步计划\n\n- verify\n")
      await loadOrCreateTask(directory, {
        id: "20260730T010203Z-task",
        slug: "alpha",
        model: "openai/a",
      })

      await rejectTaskFlag(directory, "flag{wrong}")
      expect((await loadTaskRecord(directory))?.rejectedFlags).toEqual(["flag{wrong}"])
      expect(await Bun.file(path.join(directory, "NOTES.md")).text()).toContain("user confirmed incorrect")

      await archiveTask(directory)
      const rawTask = await Bun.file(path.join(directory, "task.json")).text()
      expect((await loadTaskRecord(directory))?.status).toBe("archived")
      expect(rawTask).not.toContain("confirmedFlag")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
