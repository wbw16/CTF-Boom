import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import type { AgentRuntime } from "../runtime-contract.ts"
import { assertRuntimeResult, completeRuntimePrompt, runtimeReplyText } from "../runtime-turn.ts"
import { budgetTokens, messageTokens } from "../session.ts"
import type { Workspace } from "../workspace.ts"
import { jsonObject } from "./structured-report.ts"

const MAX_EVIDENCE = 64_000
const MAX_ARTIFACTS = 40

export type BlindReview = {
  model: string
  /** False only when the reviewer found the derivation insufficient or found a counterexample. */
  passed: boolean
  detail: string
  /** True when no model other than the solver's was available, so the review is weaker. */
  sameModelAsSolver: boolean
  tokens: number
  billable: number
  cost: number
}

/**
 * Pick a reviewer from the shared second-opinion pool, preferring one the solver did not just use.
 *
 * Falling back to the solver's own model is deliberate: a same-model review still re-derives the
 * candidate from neutral evidence, which catches arithmetic and decoding mistakes even when it cannot
 * catch a shared blind spot. The caller is told which case it got so the weaker one is not reported as
 * an independent check.
 */
export function selectReviewer(input: { pool: string[]; solverModel: string }) {
  const different = input.pool.find((model) => model !== input.solverModel)
  if (different) return { model: different, sameModelAsSolver: false }
  const fallback = input.pool[0] ?? input.solverModel
  return { model: fallback, sameModelAsSolver: true }
}

async function workArtifacts(directory: string) {
  const root = await realpath(directory)
  const work = path.join(root, "work")
  const files: Array<{ path: string; size: number }> = []
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === ".boom") continue
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await visit(target); continue }
      if (!entry.isFile()) continue
      const info = await lstat(target).catch(() => undefined)
      if (!info) continue
      files.push({
        path: path.relative(root, target).split(path.sep).join("/"),
        size: info.size,
      })
    }
  }
  await visit(work)
  return files.slice(0, MAX_ARTIFACTS)
}

/**
 * Build review evidence with the solver's conclusions stripped out.
 *
 * Reads `NOTES.md` rather than `work/WRITEUP.md`: a writeup is only produced after a candidate is
 * accepted, so at review time it almost never exists and using it as the sole source left the reviewer
 * with nothing but the candidate string to guess from.
 */
export async function neutralEvidence(input: {
  directory: string
  candidate: string
}) {
  const notes = await readFile(path.join(input.directory, "NOTES.md"), "utf8").catch(() => "")
  const writeup = await readFile(
    path.join(input.directory, "work", "WRITEUP.md"),
    "utf8",
  ).catch(() => "")
  const artifacts = await workArtifacts(input.directory).catch(() => [])
  const redacted = [notes, writeup]
    .filter((text) => text.trim() !== "")
    .join("\n\n")
    // Remove the answer itself and any line asserting confidence, so the reviewer re-derives rather
    // than agreeing with a conclusion it was handed.
    .replaceAll(input.candidate, "[CANDIDATE_REDACTED]")
    .replace(/^.*(?:confidence|自信|已验证|verified|确认是|就是 ?flag).*$/gim, "")
    .slice(0, MAX_EVIDENCE)
  const listing = artifacts.length
    ? ["", "工作区产物（供独立复算）：", ...artifacts.map((file) => `- ${file.path} (${file.size} bytes)`)]
    : []
  return [redacted, ...listing].join("\n").trim()
}

export async function reviewCandidateBlind(input: {
  runtime: AgentRuntime
  workspace: Workspace
  model: string
  candidate: string
  sameModelAsSolver: boolean
  signal?: AbortSignal
  timeout: number
}): Promise<BlindReview> {
  const deadline = AbortSignal.timeout(input.timeout)
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  const evidence = await neutralEvidence({
    directory: input.workspace.directory,
    candidate: input.candidate,
  })
  const completed = await completeRuntimePrompt({
    runtime: input.runtime,
    directory: input.workspace.directory,
    title: "Boom blind candidate review",
    agent: "boom-consultant",
    model: input.model,
    prompt: [
      "独立复核以下候选。证据里已移除结论和自信表述，你的任务不是判断它看起来像不像 flag，",
      "而是检查现有证据能否推导出它，并主动寻找反例。",
      "如果证据不足以推出该候选，就返回 passed=false 并说明缺哪一步——“无法证伪”不等于通过。",
      "可以读取工作区文件自行复算。",
      `候选：${input.candidate}`,
      "严格返回 JSON（放在 ```json 代码块中）：",
      JSON.stringify({ passed: false, detail: "逐步复核或反证理由" }),
      "",
      "中性证据：",
      evidence || "[没有可用的离线推导证据]",
    ].join("\n"),
    signal,
  })
  const text = runtimeReplyText(completed.parts)
  // Some compatible providers return a complete response without a known terminal state. The text
  // is still useful for an advisory review, so only an errored or empty response is fatal.
  const allowedFinishes =
    completed.finish === "unknown" && text !== "" && !completed.error
      ? ["stop", "unknown"]
      : ["stop"]
  const response = assertRuntimeResult(completed, "Blind review model", allowedFinishes)
  const parsed = jsonObject(text) as {
    passed?: unknown
    detail?: unknown
  } | undefined
  if (typeof parsed?.passed !== "boolean" || typeof parsed.detail !== "string") {
    // A malformed advisory report must not be treated as a confirmed pass. Keep the candidate
    // pending and record why the independent check could not complete.
    return {
      model: input.model,
      passed: false,
      detail: `Blind review did not return a structured report; treated as unconfirmed: ${text.slice(0, 500) || "no text"}`,
      sameModelAsSolver: input.sameModelAsSolver,
      tokens: response.usage ? messageTokens(response.usage) : 0,
      billable: response.usage ? Math.round(budgetTokens(response.usage)) : 0,
      cost: response.cost,
    }
  }
  const usage = response.usage
  return {
    model: input.model,
    passed: parsed.passed,
    detail: parsed.detail,
    sameModelAsSolver: input.sameModelAsSolver,
    tokens: usage ? messageTokens(usage) : 0,
    billable: usage ? Math.round(budgetTokens(usage)) : 0,
    cost: response.cost,
  }
}
