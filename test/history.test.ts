import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { submitCandidate } from "../src/candidate-submission.ts"
import { appendRunEvent, assertPathWithin, readChallengeRuns, readRunHistory } from "../src/history.ts"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-history-"))
  const makeRun = async (slug: string, id: string) => {
    const directory = path.join(root, "runs", slug, id)
    await mkdir(path.join(directory, "work"), { recursive: true })
    return directory
  }
  return { root, makeRun }
}

describe("run history", () => {
  test("loads a legacy result and enriches it with notes, events, writeup verification, and files", async () => {
    const { root, makeRun } = await fixture()
    try {
      const id = "20260729T011900Z-test"
      const directory = await makeRun("legacy", id)
      await writeFile(
        path.join(directory, "result.json"),
        JSON.stringify({
          run_id: id,
          model: "free/test",
          runtime_backend: "fake-runtime",
          runtime_version: "1.2.3",
          prompt_version: "prompt-v1",
          stop: "completed",
          tokens: 123,
          cost: 0.5,
          candidates: ["flag{legacy}", "flag{alternative}"],
          consultation: {
            trigger: "planning",
            expert_models: ["openai/a", "anthropic/b"],
            synthesizer_model: "openai/main",
            plans: [
              { model: "openai/a", text: "draft a" },
              { model: "anthropic/b", text: "draft b" },
            ],
            merged: { model: "openai/main", text: "merged plan" },
            degraded: { reason: "synthesis-failed", detail: "provider metadata was unusable" },
            tokens: 300,
            billable_tokens: 240,
            cost: 0.03,
          },
          context_policy: { consult_on_compaction: false, compactions: 2 },
          flag_format: "flag\\{[^}]*\\}",
          reply: "done",
        }),
      )
      await writeFile(path.join(directory, "NOTES.md"), "# NOTES\nlegacy evidence\n")
      await writeFile(
        path.join(directory, "work", "WRITEUP.md"),
        [
          "# legacy",
          "",
          "**Flag:** `flag{legacy}`",
          "**Verification:** local checker returned correct",
        ].join("\n"),
      )
      await writeFile(path.join(directory, "work", "artifact.txt"), "proof")
      await writeFile(
        path.join(directory, "work", "events.jsonl"),
        [
          JSON.stringify({ at: 1, type: "tool", tool: "bash", status: "running" }),
          "{partial",
          JSON.stringify({ at: 2, type: "status", status: "completed" }),
          "",
        ].join("\n"),
      )

      const run = await readRunHistory(root, "legacy", id)

      expect(run).toMatchObject({
        id,
        model: "free/test",
        runtimeBackend: "fake-runtime",
        runtimeVersion: "1.2.3",
        promptVersion: "prompt-v1",
        stop: "completed",
        tokens: 123,
        billableTokens: 0,
        cost: 0.5,
        candidates: ["flag{legacy}", "flag{alternative}"],
        primaryCandidate: "flag{legacy}",
        alternatives: ["flag{alternative}"],
        flagFormat: "flag\\{[^}]*\\}",
        reply: "done",
        lastTool: "bash",
        verification: {
          level: "local-checker",
          detail: "local checker returned correct",
        },
        consultation: {
          trigger: "planning",
          expertModels: ["openai/a", "anthropic/b"],
          synthesizerModel: "openai/main",
          merged: { model: "openai/main", text: "merged plan" },
          degraded: { reason: "synthesis-failed", detail: "provider metadata was unusable" },
          tokens: 300,
          billableTokens: 240,
          cost: 0.03,
        },
        contextPolicy: { consultOnCompaction: false, compactions: 2 },
      })
      expect(run.notes).toContain("legacy evidence")
      expect(run.writeup).toContain("flag{legacy}")
      expect(run.events).toHaveLength(2)
      expect(run.files).toContainEqual({ path: "work/artifact.txt", size: 5, directory: false })
      expect(run.files).toContainEqual(
        expect.objectContaining({ path: "NOTES.md", directory: false }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps every candidate in task history after a rejection or a later flagless turn", async () => {
    const { root, makeRun } = await fixture()
    try {
      const id = "20260804T093000Z-task"
      const directory = await makeRun("candidate-history", id)
      await writeFile(
        path.join(directory, "result.json"),
        JSON.stringify({
          run_id: id,
          model: "free/test",
          stop: "completed",
          candidates: [],
          reply: "the follow-up found no new candidate",
        }),
      )
      await writeFile(
        path.join(directory, "task.json"),
        JSON.stringify({
          version: 1,
          id,
          slug: "candidate-history",
          status: "paused",
          createdAt: "2026-08-04T09:30:00.000Z",
          updatedAt: "2026-08-04T09:32:00.000Z",
          currentModel: "free/test",
          rejectedFlags: ["flag{keep-me}"],
          turns: [{
            id: "turn-1",
            model: "free/test",
            startedAt: "2026-08-04T09:30:00.000Z",
            finishedAt: "2026-08-04T09:31:00.000Z",
            stop: "completed",
            tokens: 12,
            billableTokens: 12,
            cost: 0,
            candidates: ["flag{keep-me}"],
            primaryCandidate: "flag{keep-me}",
          }],
        }),
      )

      const run = await readRunHistory(root, "candidate-history", id)

      expect(run.primaryCandidate).toBeUndefined()
      expect(run.candidates).toEqual([])
      expect(run.candidateHistory).toEqual(["flag{keep-me}"])
      expect(run.rejectedFlags).toEqual(["flag{keep-me}"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("keeps a run inspectable when result.json is malformed", async () => {
    const { root, makeRun } = await fixture()
    try {
      const id = "20260729T012000Z-test"
      const directory = await makeRun("broken", id)
      await writeFile(path.join(directory, "result.json"), '{"stop":')
      await writeFile(path.join(directory, "NOTES.md"), "still useful")
      await writeFile(path.join(directory, "work", "artifact.bin"), "data")

      const run = await readRunHistory(root, "broken", id)

      expect(run.stop).toBe("error")
      expect(run.detail).toContain("invalid result.json")
      expect(run.notes).toBe("still useful")
      expect(run.files.map((file) => file.path)).toContain("work/artifact.bin")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("recovers a model-declared flag from legacy output with empty result candidates", async () => {
    const { root, makeRun } = await fixture()
    try {
      const id = "20260802T135235Z-task"
      const directory = await makeRun("legacy-markdown", id)
      await writeFile(
        path.join(directory, "result.json"),
        JSON.stringify({
          runID: id,
          stop: "completed",
          candidates: [],
          reply: "题目已解决\n\n**Flag: `flag{from_reply}`**",
          flagFormat: "",
        }),
      )
      await writeFile(path.join(directory, "work", "WRITEUP.md"), "**Flag: flag{from_writeup}**\n")

      const run = await readRunHistory(root, "legacy-markdown", id)

      expect(run.primaryCandidate).toBe("flag{from_writeup}")
      expect(run.candidates).toEqual(["flag{from_writeup}"])
      expect(run.candidateSource).toBe("model")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prefers the dedicated candidate slot over legacy result and reply fields", async () => {
    const { root, makeRun } = await fixture()
    try {
      const id = "20260802T140000Z-task"
      const directory = await makeRun("structured", id)
      await writeFile(
        path.join(directory, "result.json"),
        JSON.stringify({
          runID: id,
          stop: "completed",
          candidates: ["flag{old_result}"],
          primaryCandidate: "flag{old_result}",
          reply: "FINAL_FLAG: flag{old_reply}",
        }),
      )
      await submitCandidate({
        directory,
        sessionID: "session-current",
        candidate: "flag{structured_slot}",
      })

      const run = await readRunHistory(root, "structured", id)

      expect(run).toMatchObject({
        candidates: ["flag{structured_slot}"],
        primaryCandidate: "flag{structured_slot}",
        alternatives: [],
        candidateSource: "submission",
      })
      expect(run.verification).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("uses the directory entry as run identity and keeps a null result inspectable", async () => {
    const { root, makeRun } = await fixture()
    try {
      const forgedID = "20260729T012030Z-forged"
      const nullID = "20260729T012031Z-null"
      const forged = await makeRun("untrusted", forgedID)
      const empty = await makeRun("untrusted", nullID)
      await writeFile(
        path.join(forged, "result.json"),
        JSON.stringify({ run_id: "../../outside", stop: "completed" }),
      )
      await writeFile(path.join(empty, "result.json"), "null")

      const forgedRun = await readRunHistory(root, "untrusted", forgedID)
      const nullRun = await readRunHistory(root, "untrusted", nullID)

      expect(forgedRun.id).toBe(forgedID)
      expect(forgedRun.stop).toBe("error")
      expect(forgedRun.detail).toContain("run_id does not match directory")
      expect(nullRun.id).toBe(nullID)
      expect(nullRun.stop).toBe("error")
      expect(nullRun.detail).toContain("expected a JSON object")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("classifies a workspace without result.json as interrupted and still reads durable evidence", async () => {
    const { root, makeRun } = await fixture()
    try {
      // Early prototype runs used minute precision; history remains compatible with those IDs.
      const id = "20260729T0121Z-test"
      const directory = await makeRun("interrupted", id)
      await writeFile(path.join(directory, "NOTES.md"), "last confirmed step")
      await writeFile(path.join(directory, "work", "partial.txt"), "partial")

      const run = await readRunHistory(root, "interrupted", id)
      const all = await readChallengeRuns(root, "interrupted")

      expect(run.stop).toBe("interrupted")
      expect(run.model).toBe("test")
      expect(run.startedAt).toBe("2026-07-29T01:21:00.000Z")
      expect(run.notes).toBe("last confirmed step")
      expect(run.files.map((file) => file.path)).toContain("work/partial.txt")
      expect(all.map((item) => item.id)).toEqual([id])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("history path boundary", () => {
  test("never follows an events.jsonl symlink while appending", async () => {
    const { root, makeRun } = await fixture()
    const outside = path.join(root, "outside.txt")
    try {
      const directory = await makeRun("events", "20260729T012200Z-test")
      await writeFile(outside, "unchanged")
      await symlink(outside, path.join(directory, "work", "events.jsonl"))

      await expect(
        appendRunEvent(directory, { at: 1, type: "status", status: "running" }),
      ).rejects.toThrow("not a real file")
      expect(await Bun.file(outside).text()).toBe("unchanged")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects lexical traversal", async () => {
    const { root } = await fixture()
    try {
      await expect(assertPathWithin(root, path.join(root, "..", "outside"), true)).rejects.toThrow(
        "Path escapes",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a missing target whose nearest existing parent is a symlink outside the root", async () => {
    const { root } = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), "boom-history-outside-"))
    try {
      await symlink(outside, path.join(root, "escape"))

      await expect(assertPathWithin(root, path.join(root, "escape", "new-file"), true)).rejects.toThrow(
        "Path escapes",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
