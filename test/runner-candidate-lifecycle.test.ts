import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { submitCandidate } from "../src/candidate-submission.ts"
import { readChallengeRuns } from "../src/history.ts"
import { MockSubmissionGateway } from "./fixtures/mock-submission.ts"
import { GuiRunner } from "../src/runner.ts"
import type { RuntimeHandle } from "../src/runtime-contract.ts"

const temporary: string[] = []
afterEach(async () => Promise.all(
  temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
))

async function fixture(input: {
  candidates: string[]
  verdicts?: Array<"accepted" | "rejected" | "pending">
}) {
  const interpreter = Bun.which("python3")
  if (!interpreter) throw new Error("python3 is required for this test")
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-candidate-lifecycle-"))
  temporary.push(directory)
  const root = path.join(directory, "ctf")
  const source = path.join(root, "challenges", "sample")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "README.md"), "Recover a flag")

  let solveTurns = 0
  const prompts: string[] = []
  const handle: RuntimeHandle = {
    backend: "fake",
    version: "test",
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: false,
      attachments: false,
      web: false,
      cancellation: true,
      providerManagement: false,
      providerOAuth: false,
      compaction: false,
      compactionHooks: false,
    },
    agent: {
      async createConversation(conversation) {
        const id = `session-${prompts.length + 1}`
        return {
          id,
          async events() {
            return { async *[Symbol.asyncIterator]() {} }
          },
          async prompt(request) {
            prompts.push(request.text)
            const candidate = input.candidates[solveTurns++]
            if (candidate) {
              await submitCandidate({
                directory: conversation.directory,
                sessionID: id,
                candidate,
              })
            }
            return {
              usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 0,
              finish: "stop" as const,
              parts: [{ type: "text" as const, text: candidate ? "candidate submitted" : "done" }],
            }
          },
          async abort() {},
        }
      },
    },
    close() {},
  }
  const verdicts = [...(input.verdicts ?? [])]
  const adapters = verdicts.length
    ? new MockSubmissionGateway([{
        id: "test",
        async submitFlag() {
          const verdict = verdicts.shift() ?? "pending"
          return {
            adapter: "test",
            verdict,
            detail: `test verdict: ${verdict}`,
            submittedAt: new Date().toISOString(),
          }
        },
      }])
    : new MockSubmissionGateway()
  const runner = new GuiRunner(root, async () => handle, adapters, {
    platformSubmissionRetryDelayMs: 20,
  })
  const challenge = {
    slug: "sample",
    directory: source,
    description: "Recover a flag",
    files: [],
    flagFormat: "flag\\{[^}]+\\}",
    ...(input.verdicts ? { platform: { adapter: "test" } } : {}),
  }
  await runner.enqueue({
    challenges: [challenge],
    model: "test/strong",
    modelPolicy: { economy: "test/economy", strong: "test/strong" },
    limits: { tokens: 100_000, repeats: 5, timeout: 60_000 },
    flagFormat: challenge.flagFormat,
    pythonInterpreter: interpreter,
  })
  for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1) await Bun.sleep(10)
  const [runID] = await readdir(path.join(root, "tasks", "sample"))
  const run = path.join(root, "tasks", "sample", runID!)
  return { runner, root, run, prompts }
}

describe("candidate lifecycle", () => {
  test("stops at manual review when no submission adapter is configured", async () => {
    const one = await fixture({ candidates: ["flag{manual}"] })
    try {
      expect(one.prompts).toHaveLength(1)
      expect(JSON.parse(await readFile(path.join(one.run, "task.json"), "utf8"))).toMatchObject({
        status: "candidate-found",
        rejectedFlags: [],
      })
      expect(JSON.parse(await readFile(path.join(one.run, "result.json"), "utf8"))).toMatchObject({
        platform_submission: { adapter: "manual", verdict: "pending" },
      })
    } finally {
      await one.runner.close()
    }
  })

  test("records a rejected flag and continues until the next candidate needs review", async () => {
    const one = await fixture({
      candidates: ["flag{wrong}", "flag{next}"],
      verdicts: ["rejected", "pending"],
    })
    try {
      expect(one.prompts).toHaveLength(2)
      expect(one.prompts[1]).toContain("flag{wrong}")
      expect(JSON.parse(await readFile(path.join(one.run, "task.json"), "utf8"))).toMatchObject({
        status: "candidate-found",
        rejectedFlags: ["flag{wrong}"],
      })
      expect(await readFile(path.join(one.run, "NOTES.md"), "utf8")).toContain("flag{wrong}")
      expect(JSON.parse(await readFile(path.join(one.run, "work", "RESULT.json"), "utf8"))).toMatchObject({
        flag: "flag{next}",
      })
    } finally {
      await one.runner.close()
    }
  })

  test("removes a platform-rejected flag from the active candidate state", async () => {
    const one = await fixture({
      candidates: ["flag{wrong}"],
      verdicts: ["rejected"],
    })
    try {
      // The follow-up solve turn is expected, but it has no candidate of its own. Recovery may
      // make further empty attempts, which must not resurrect the rejected flag.
      expect(one.prompts.length).toBeGreaterThanOrEqual(2)
      expect(JSON.parse(await readFile(path.join(one.run, "task.json"), "utf8"))).toMatchObject({
        status: "paused",
        rejectedFlags: ["flag{wrong}"],
      })

      const [history] = await readChallengeRuns(one.root, "sample")
      expect(history).toMatchObject({
        candidates: [],
        primaryCandidate: undefined,
        rejectedFlags: ["flag{wrong}"],
      })
      // It stays in the immutable history so the solver and user can see it was ruled out.
      expect(history?.candidateHistory).toContain("flag{wrong}")
    } finally {
      await one.runner.close()
    }
  })

  test("retries a pending platform submission once, then ends the main flow on acceptance", async () => {
    const interpreter = Bun.which("python3")
    if (!interpreter) throw new Error("python3 is required for this test")
    let submissionAttempts = 0
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-candidate-retry-"))
    temporary.push(directory)
    const root = path.join(directory, "ctf")
    const source = path.join(root, "challenges", "sample")
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, "README.md"), "Recover a flag")

    const prompts: string[] = []
    const handle: RuntimeHandle = {
      backend: "fake",
      version: "test",
      capabilities: {
        eventStreaming: true,
        toolCalls: true,
        reasoning: false,
        attachments: false,
        web: false,
        cancellation: true,
        providerManagement: false,
        providerOAuth: false,
        compaction: false,
        compactionHooks: false,
      },
      agent: {
        async createConversation(conversation) {
          const id = `session-retry`
          return {
            id,
            async events() {
              return { async *[Symbol.asyncIterator]() {} }
            },
            async prompt(request) {
              prompts.push(request.text)
              if (request.text.includes("Confirmed flag")) {
                await writeFile(
                  path.join(conversation.directory, "work", "WRITEUP.md"),
                  "# Writeup\n\n已确认 flag，并根据已有证据整理核心思路与复现步骤。\n\nFlag: flag{retry}\n",
                )
                return {
                  usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
                  cost: 0,
                  finish: "stop" as const,
                  parts: [{ type: "text" as const, text: "writeup completed" }],
                }
              }
              await submitCandidate({
                directory: conversation.directory,
                sessionID: id,
                candidate: "flag{retry}",
              })
              return {
                usage: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0,
                finish: "stop" as const,
                parts: [{ type: "text" as const, text: "candidate submitted" }],
              }
            },
            async abort() {},
          }
        },
      },
      close() {},
    }
    const adapters = new MockSubmissionGateway([{
      id: "test",
      async submitFlag() {
        submissionAttempts += 1
        return {
          adapter: "test",
          verdict: submissionAttempts === 1 ? "pending" : "accepted",
          detail: submissionAttempts === 1
            ? "temporary submission failure"
            : "test verdict: accepted",
          submittedAt: new Date().toISOString(),
        }
      },
    }])
    const runner = new GuiRunner(root, async () => handle, adapters, {
      platformSubmissionRetryDelayMs: 20,
    })
    try {
      await runner.enqueue({
        challenges: [{
          slug: "sample",
          directory: source,
          description: "Recover a flag",
          files: [],
          flagFormat: "flag\\{[^}]+\\}",
          platform: { adapter: "test" },
        }],
        model: "test/strong",
        modelPolicy: { economy: "test/economy", strong: "test/strong" },
        limits: { tokens: 100_000, repeats: 5, timeout: 60_000 },
        flagFormat: "flag\\{[^}]+\\}",
        pythonInterpreter: interpreter,
      })
      for (let attempt = 0; attempt < 500 && runner.hasWork(); attempt += 1) await Bun.sleep(10)
      const [runID] = await readdir(path.join(root, "tasks", "sample"))
      const run = path.join(root, "tasks", "sample", runID!)
      expect(submissionAttempts).toBe(2)
      expect(prompts).toHaveLength(2)
      expect(JSON.parse(await readFile(path.join(run, "task.json"), "utf8"))).toMatchObject({
        status: "archived",
        acceptedFlag: { value: "flag{retry}", source: "test" },
      })
      expect(JSON.parse(await readFile(path.join(run, "result.json"), "utf8"))).toMatchObject({
        platform_submission: { adapter: "test", verdict: "accepted" },
      })
      expect(runner.hasWork()).toBe(false)
    } finally {
      await runner.close()
    }
  })
})
