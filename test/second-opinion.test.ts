import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  neutralEvidence,
  reviewCandidateBlind,
  selectReviewer,
} from "../src/orchestration/second-opinion.ts"
import type { AgentRuntime, RuntimeEvent } from "../src/runtime-contract.ts"

const CANDIDATE = "flag{real_answer}"

async function workspace(name: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `boom-second-opinion-${name}-`))
  await mkdir(path.join(directory, "work"), { recursive: true })
  return directory
}

function runtime(reply: string): AgentRuntime {
  return {
    async createConversation() {
      return {
        id: "session-review",
        async events() {
          return {
            async *[Symbol.asyncIterator]() {
              // No streamed events: the review reads the prompt result directly.
            },
          } as AsyncIterable<RuntimeEvent>
        },
        async prompt() {
          return {
            usage: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.02,
            finish: "stop",
            parts: [{ type: "text", text: reply }],
          }
        },
        async abort() {},
      }
    },
  }
}

describe("reviewer selection", () => {
  test("prefers a model the solver did not just use", () => {
    expect(selectReviewer({
      pool: ["openai/solver", "anthropic/other"],
      solverModel: "openai/solver",
    })).toEqual({ model: "anthropic/other", sameModelAsSolver: false })
  })

  test("falls back to the solver's model and says so when the pool has nothing else", () => {
    // A same-model review still re-derives from neutral evidence, so it is kept rather than skipped —
    // but the caller must be able to avoid presenting it as an independent check.
    expect(selectReviewer({
      pool: ["openai/solver"],
      solverModel: "openai/solver",
    })).toEqual({ model: "openai/solver", sameModelAsSolver: true })
  })
})

describe("neutral evidence", () => {
  test("uses NOTES.md, redacts the candidate, and drops confidence claims", async () => {
    const directory = await workspace("evidence")
    try {
      await writeFile(
        path.join(directory, "NOTES.md"),
        [
          "# NOTES",
          "## note",
          "work/decoded.bin 是 zlib 流，解压后得到 ASCII。",
          `已验证 flag 就是 ${CANDIDATE}，可以提交。`,
        ].join("\n"),
        "utf8",
      )
      await writeFile(path.join(directory, "work", "decoded.bin"), "payload", "utf8")

      const evidence = await neutralEvidence({ directory, candidate: CANDIDATE })

      // The derivation survives; the answer and the confident assertion do not.
      expect(evidence).toContain("zlib")
      expect(evidence).not.toContain(CANDIDATE)
      expect(evidence).not.toContain("已验证")
      // Artifacts are listed so the reviewer can recompute instead of trusting prose.
      expect(evidence).toContain("work/decoded.bin")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("still produces evidence when no writeup exists", async () => {
    // WRITEUP.md is only written after acceptance, so at review time it is normally absent. Reading
    // it as the sole source used to leave the reviewer with nothing.
    const directory = await workspace("no-writeup")
    try {
      await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n推导：base64 两次。", "utf8")
      const evidence = await neutralEvidence({ directory, candidate: CANDIDATE })
      expect(evidence).toContain("base64")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("blind candidate review", () => {
  test("parses a fenced verdict and reports usage", async () => {
    const directory = await workspace("verdict")
    try {
      await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n推导记录", "utf8")
      const review = await reviewCandidateBlind({
        runtime: runtime('推理过程略。\n```json\n{"passed": false, "detail": "第 3 步缺少依据"}\n```'),
        workspace: { directory, runID: "run", extracted: [] },
        model: "anthropic/reviewer",
        candidate: CANDIDATE,
        sameModelAsSolver: false,
        timeout: 60_000,
      })

      expect(review).toMatchObject({
        model: "anthropic/reviewer",
        passed: false,
        detail: "第 3 步缺少依据",
        sameModelAsSolver: false,
      })
      expect(review.tokens).toBe(120)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("degrades a reply with no usable verdict to an unconfirmed review", async () => {
    const directory = await workspace("garbage")
    try {
      const review = await reviewCandidateBlind({
        runtime: runtime("看起来是对的。"),
        workspace: { directory, runID: "run", extracted: [] },
        model: "anthropic/reviewer",
        candidate: CANDIDATE,
        sameModelAsSolver: false,
        timeout: 60_000,
      })
      expect(review).toMatchObject({
        passed: false,
        detail: expect.stringContaining("did not return a structured report"),
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
