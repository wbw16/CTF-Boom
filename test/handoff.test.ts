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
  await mkdir(path.join(directory, "records"))
  await mkdir(path.join(directory, "input"))
  return directory
}

describe("compact turn handoff", () => {
  test("puts the stable task card before a durable checkpoint and omits noisy turn history", async () => {
    const directory = await fixture()
    await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n\n## 已确认事实\n\n- 文件是 XOR 加密。\n")
    await writeFile(path.join(directory, "work", "decoded.txt"), "candidate material")
    await writeFile(path.join(directory, "work", "old.txt"), "old")
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(path.join(directory, "work", "newest.txt"), "newest")

    const challenge: Challenge = {
      slug: "warmup",
      category: "CRYPTO",
      remote: "challenge.example:31337",
      directory: path.join(directory, "input"),
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
    expect(handoff).toContain("Compact handoff")
    expect(handoff).toContain("## Task card")
    expect(handoff).toContain("Category: CRYPTO")
    expect(handoff).toContain("Remote: challenge.example:31337")
    expect(handoff).toContain("Status: paused")
    expect(handoff).toContain("1 candidates excluded")
    expect(handoff).toContain("## Durable checkpoint (NOTES.md)")
    expect(handoff).toContain("XOR 加密")
    expect(handoff).toContain("work/newest.txt")
    expect(handoff).toContain("work/decoded.txt")
    expect(handoff).not.toContain("deepseek/deepseek-v4-flash · completed")
    expect(handoff).not.toContain("Recovery activity")
    expect(handoff).not.toContain("flag{wrong}")
  })

  test("uses a bounded recovery activity only when no durable checkpoint exists", async () => {
    const directory = await fixture()
    await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n\nShared cross-turn, cross-model task memory. Maintained by the ctf-note tool.\n")
    await writeFile(path.join(directory, "records", "events.jsonl"), [
      JSON.stringify({ at: 1_000, type: "tool", tool: "bash", status: "running", text: "file challenge/*" }),
      JSON.stringify({ at: 1_500, type: "tool", tool: "bash", status: "completed", text: "bash · exit 0" }),
    ].join("\n") + "\n")

    const handoff = await buildHandoffSummary({
      directory,
      challenge: {
        slug: "empty-notes",
        directory: path.join(directory, "input"),
        description: "Recover context",
        files: [],
        flagFormat: "flag\\{[^}]*\\}",
      },
      task: {
        version: 1,
        id: "task-empty",
        slug: "empty-notes",
        status: "paused",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentModel: "test/model",
        rejectedFlags: [],
        turns: [],
      },
    })

    expect(handoff).toContain("## Recovery activity (no durable checkpoint found)")
    expect(handoff).toContain("file challenge/*")
    expect(handoff).not.toContain("## Durable checkpoint")
  })
})
