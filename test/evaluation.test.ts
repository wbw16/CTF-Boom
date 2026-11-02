import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { aggregateEvaluation, collectEvaluationSamples, compareEvaluationSamples, evaluationMarkdown } from "../src/evaluation.ts"
import type { ExperimentConditions } from "../src/experiment.ts"
import { saveTaskRecord, type TaskTurn } from "../src/task.ts"

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const conditions: ExperimentConditions = {
  model: "test/strong", economyModel: "test/economy", strongModel: "test/strong", tokens: 10_000,
  timeoutMs: 60_000, repeats: 3, inputFingerprint: "handout-a", environmentFingerprint: "env-a",
  executionMode: "managed", consultModels: [], blindReview: false, consultOnCompaction: false,
  planningConsultation: false, network: "deny",
}
const stamp = (ms: number) => new Date(ms).toISOString()

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-evaluation-"))
  temporary.push(root)
  for (const slug of ["alpha", "beta", "unscored"]) {
    await mkdir(path.join(root, "challenges", slug), { recursive: true })
    await writeFile(path.join(root, "challenges", slug, "README.md"), "Analyze the attachment")
    await writeFile(path.join(root, "challenges", slug, "meta.json"), JSON.stringify({ category: "CRYPTO" }))
  }
  await mkdir(path.join(root, "eval"))
  await writeFile(path.join(root, "eval", "answers.txt"), "alpha flag{host-answer-a}\nbeta flag{host-answer-b}\n")
  return root
}

async function makeRun(root: string, slug: string, id: string, label: string, candidates: string[], options: {
  stop?: "error" | "completed"; writeup?: boolean; tokens?: number; trial?: number;
  configuration?: Partial<ExperimentConditions>; invalidated?: boolean;
} = {}) {
  const directory = path.join(root, "tasks", slug, id)
  await mkdir(path.join(directory, "records"), { recursive: true })
  await mkdir(path.join(directory, "work"))
  await mkdir(path.join(directory, "input"))
  await writeFile(path.join(directory, "input", "challenge.json"), "{}")
  await writeFile(path.join(directory, "NOTES.md"), "# NOTES\n")
  const turns: TaskTurn[] = (candidates.length ? candidates : [undefined]).map((candidate, index) => ({
    id: `turn-${index}`, model: "test/strong", purpose: "solve", startedAt: stamp(1_000 + index * 1_000),
    finishedAt: stamp(2_000 + index * 1_000), stop: options.stop ?? "completed", tokens: 50, billableTokens: 50, cost: 0.1,
    candidates: candidate ? [candidate] : [], ...(candidate ? { primaryCandidate: candidate } : {}),
  }))
  if (options.writeup) turns.push({ id: "writeup", model: "test/economy", purpose: "writeup",
    startedAt: stamp(10_000), finishedAt: stamp(15_000), stop: "completed", tokens: 5,
    billableTokens: 5, cost: 0.01, candidates: [candidates.at(-1)!] })
  const experiment = { label, trial: options.trial ?? 1, conditions: {
    ...conditions, inputFingerprint: `handout-${slug}`, ...options.configuration,
  }, ...(options.invalidated ? { invalidated: true } : {}) }
  await saveTaskRecord(directory, { version: 1, id, slug, status: "paused", createdAt: stamp(1_000), updatedAt: stamp(15_000),
    currentModel: options.writeup ? "test/economy" : "test/strong", rejectedFlags: [], experiment, turns })
  await writeFile(path.join(directory, "result.json"), JSON.stringify({ model: "test/economy", stop: options.stop ?? "completed",
    experiment, candidates: candidates.slice(-1), tokens: options.tokens ?? 100, cost: 0.2,
    started_at: stamp(1_000), finished_at: stamp(15_000) }))
  await writeFile(path.join(directory, "records", "events.jsonl"), JSON.stringify({
    at: 1_100, type: "tool", tool: "boom-exec", status: "completed", text: "file analyzed",
  }) + "\n")
}

test("scores runtime failures, counts earlier mistakes on successful tasks, and distinguishes first tool from evidence", async () => {
  const root = await fixture()
  await makeRun(root, "alpha", "a1", "current", ["flag{wrong}", "flag{host-answer-a}"], { writeup: true })
  await makeRun(root, "beta", "b1", "current", [], { stop: "error" })
  await makeRun(root, "unscored", "u1", "current", [])
  const samples = await collectEvaluationSamples(root, { label: "current" })
  const alpha = samples.find((row) => row.slug === "alpha")!
  expect(alpha).toMatchObject({ model: "test/strong", correct: true, scoringSource: "answer", candidateCount: 2,
    judgedCandidates: 2, wrongCandidates: 1, firstToolMs: 100, firstCorrectCandidateMs: 2_000, activeSolveMs: 2_000 })
  expect(samples.find((row) => row.slug === "unscored")?.correct).toBeUndefined()
  const [summary] = aggregateEvaluation(samples)
  expect(summary).toMatchObject({ runs: 3, scored: 2, successes: 1, successRate: 0.5,
    wrongCandidateRate: 0.5, runtimeFailures: 1 })
  expect(summary?.costPerSuccess).toBeUndefined()
  expect(evaluationMarkdown([summary!])).toContain("首工具耗时只表示开始执行")
  const output = JSON.stringify(samples)
  expect(output).not.toContain("host-answer")
  expect(output).not.toContain("flag{wrong}")
})

test("pairs only matching independent trials and excludes missing scores, changed budgets and duplicate trials", async () => {
  const root = await fixture()
  await makeRun(root, "alpha", "base-a", "baseline", ["flag{wrong}"])
  await makeRun(root, "alpha", "new-a", "current", ["flag{host-answer-a}"], { writeup: true })
  await makeRun(root, "beta", "base-b", "baseline", [])
  await makeRun(root, "beta", "new-b", "current", [], { configuration: { tokens: 20_000 } })
  await makeRun(root, "unscored", "base-u", "baseline", [])
  await makeRun(root, "unscored", "new-u", "current", [])
  const baseline = await collectEvaluationSamples(root, { label: "baseline" })
  const current = await collectEvaluationSamples(root, { label: "current" })
  expect(compareEvaluationSamples(baseline, current)).toMatchObject({ pairedTrials: 1, pairedChallenges: 1,
    excludedBaseline: 2, excludedCurrent: 2, wins: 1, losses: 0, baselineSuccessRate: 0, currentSuccessRate: 1 })
  expect(compareEvaluationSamples(baseline, [...current, current[0]!]).pairedTrials).toBe(0)
  await makeRun(root, "alpha", "manual-a", "manual", ["flag{host-answer-a}"], { invalidated: true })
  expect((await collectEvaluationSamples(root, { label: "manual" }))[0]?.comparisonKey).toBeUndefined()
})

test("the evaluation CLI exports filtered JSON without starting a model or exposing answers", async () => {
  const root = await fixture()
  await makeRun(root, "alpha", "base-a", "baseline", [])
  await makeRun(root, "alpha", "new-a", "current", ["flag{host-answer-a}"])
  await writeFile(path.join(root, "slugs.txt"), "# frozen suite\nalpha\n")
  const process = Bun.spawn(["bun", "src/index.ts", "evaluate", "--root", root, "--label", "current",
    "--baseline", "baseline", "--slugs-file", path.join(root, "slugs.txt"), "--json"], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  expect(stderr).toBe("")
  expect(exit).toBe(0)
  expect(JSON.parse(stdout)).toMatchObject({ schema_version: 2, comparison: { pairedTrials: 1, wins: 1 } })
  expect(stdout).not.toContain("host-answer")
})
