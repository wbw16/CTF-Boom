import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Challenge } from "../src/challenge.ts"
import { buildHandoffSummary } from "../src/orchestration/handoff.ts"
import type { TaskRecord } from "../src/task.ts"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-handoff-"))
  temporary.push(directory)
  await mkdir(path.join(directory, "work"))
  await mkdir(path.join(directory, "challenge"))
  return directory
}

describe("compact turn handoff", () => {
  test("summarizes task state, notes, recent turns, and newest artifacts", async () => {
    const directory = await fixture()
    await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n\n## 已确认事实\n\n- 文件是 XOR 加密。\n")
    await writeFile(path.join(directory, "work", "decoded.txt"), "candidate material")
    await writeFile(path.join(directory, "work", "old.txt"), "old")
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(path.join(directory, "work", "newest.txt"), "newest")

    const challenge: Challenge = {
      slug: "warmup",
      category: "CRYPTO",
      directory: path.join(directory, "challenge"),
      description: "Decode it",
      files: [],
      flagFormat: "flag\\{[^}]*\\}",
    }
    const task: TaskRecord = {
      version: 1,
      id: "task-1",
      slug: "warmup",
      status: "paused",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentModel: "deepseek/deepseek-v4-flash",
      rejectedFlags: ["flag{wrong}"],
      turns: [
        {
          id: "turn-1",
          model: "deepseek/deepseek-v4-flash",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stop: "completed",
          tokens: 1234,
          billableTokens: 100,
          cost: 0,
          candidates: ["flag{wrong}"],
          primaryCandidate: "flag{wrong}",
          detail: "rejected by platform",
        },
      ],
    }

    const handoff = await buildHandoffSummary({ directory, challenge, task })
    expect(handoff).toContain("紧凑交接")
    expect(handoff).toContain("任务状态：paused")
    expect(handoff).toContain("已排除候选 1 个")
    expect(handoff).toContain("deepseek/deepseek-v4-flash · completed")
    expect(handoff).toContain("NOTES.md（摘要）")
    expect(handoff).toContain("XOR 加密")
    expect(handoff).toContain("work/newest.txt")
    expect(handoff).toContain("work/decoded.txt")
    expect(handoff).not.toContain("flag{wrong}")
  })
})
