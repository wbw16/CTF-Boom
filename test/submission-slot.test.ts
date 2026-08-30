import { describe, expect, test } from "bun:test"
import { mkdir, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  consumeCandidateSubmission,
  loadCandidateSubmission,
  submitCandidate,
} from "../src/candidate-submission.ts"
import { runChallenge } from "../src/session.ts"
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimePromptResult,
} from "../src/runtime-contract.ts"

function tempDirectory(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `boom-submission-slot-${label}-`))
}

const finished: RuntimePromptResult = {
  usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0.25,
  finish: "stop",
  parts: [{ type: "text", text: "turn finished" }],
}

/** Same seam as session-run.test.ts: a one-shot runtime whose conversation id is fixed. */
const emptyEvents: AsyncIterable<RuntimeEvent> = {
  async *[Symbol.asyncIterator]() {},
}

function fixedRuntime(sessionID: string): AgentRuntime {
  return {
    async createConversation() {
      return {
        id: sessionID,
        async events() {
          return emptyEvents
        },
        async prompt() {
          return finished
        },
        async abort() {},
      }
    },
  }
}

function runInput(directory: string, sessionID: string) {
  return {
    runtime: fixedRuntime(sessionID),
    challenge: {
      slug: "slot",
      directory: "/tmp/slot-source",
      description: "",
      files: [],
      flagFormat: "",
    },
    workspace: { directory, runID: "slot-run", extracted: [] },
    model: "free/test",
    limits: { tokens: 1_000, repeats: 5, timeout: 10_000 },
  }
}

describe("candidate submission slot consumption", () => {
  test("consume marks the live slot and the loader surfaces consumedAt", async () => {
    const directory = await tempDirectory("live")
    try {
      await mkdir(path.join(directory, "work"))
      await submitCandidate({ directory, sessionID: "session-1", candidate: "flag{one}" })
      expect(await loadCandidateSubmission(directory)).not.toHaveProperty("consumedAt")

      await consumeCandidateSubmission(directory)

      const stored = await loadCandidateSubmission(directory)
      expect(stored).toMatchObject({ sessionID: "session-1", flag: "flag{one}" })
      expect(typeof stored?.consumedAt).toBe("string")
      expect(Number.isFinite(new Date(stored!.consumedAt!).valueOf())).toBeTrue()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("consume rewrites the real target atomically and never follows a planted link", async () => {
    const directory = await tempDirectory("symlink")
    try {
      await mkdir(path.join(directory, "work"))
      const outside = path.join(directory, "outside.json")
      await writeFile(outside, '{"sessionID":"victim"}\n')
      await symlink(outside, path.join(directory, "work", "RESULT.json"))

      // A non-real file is not a consumable slot: leave it exactly as planted.
      await expect(consumeCandidateSubmission(directory)).resolves.toBeUndefined()
      expect(await readFile(outside, "utf8")).toBe('{"sessionID":"victim"}\n')
      const info = await lstat(path.join(directory, "work", "RESULT.json"))
      expect(info.isSymbolicLink()).toBeTrue()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("consume is a silent no-op for a missing, corrupt, or non-object slot", async () => {
    const absentWork = await tempDirectory("absent")
    const emptyWork = await tempDirectory("empty")
    const corrupt = await tempDirectory("corrupt")
    try {
      await expect(consumeCandidateSubmission(absentWork)).resolves.toBeUndefined()

      await mkdir(path.join(emptyWork, "work"))
      await expect(consumeCandidateSubmission(emptyWork)).resolves.toBeUndefined()
      expect(await loadCandidateSubmission(emptyWork)).toBeUndefined()

      await mkdir(path.join(corrupt, "work"))
      const target = path.join(corrupt, "work", "RESULT.json")
      await writeFile(target, "{not json")
      await expect(consumeCandidateSubmission(corrupt)).resolves.toBeUndefined()
      expect(await readFile(target, "utf8")).toBe("{not json")

      await rm(target)
      await writeFile(target, "[1, 2, 3]\n")
      await expect(consumeCandidateSubmission(corrupt)).resolves.toBeUndefined()
      expect(await readFile(target, "utf8")).toBe("[1, 2, 3]\n")
    } finally {
      await Promise.all(
        [absentWork, emptyWork, corrupt].map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      )
    }
  })

  test("the session keeps an unconsumed slot but drops it once consumed", async () => {
    const directory = await tempDirectory("match")
    try {
      await mkdir(path.join(directory, "work"))
      await submitCandidate({ directory, sessionID: "session-1", candidate: "flag{from_slot}" })

      const before = await runChallenge(runInput(directory, "session-1"))
      expect(before).toMatchObject({
        candidates: ["flag{from_slot}"],
        primaryCandidate: "flag{from_slot}",
        candidateSource: "submission",
      })

      await consumeCandidateSubmission(directory)

      const after = await runChallenge(runInput(directory, "session-1"))
      expect(after.candidates).toEqual([])
      expect(after.primaryCandidate).toBeUndefined()
      expect(after.candidateSource).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
