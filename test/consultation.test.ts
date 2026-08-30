import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  allocateConsultationBudgets,
  buildConsultationContext,
  compressConsultationHistory,
  conductConsultation,
  createRuntimeConsultant,
  persistConsultation,
  remainingLimits,
  renderConsultationContext,
  type ConsultationReply,
} from "../src/consultation.ts"
import {
  estimateTextTokens,
  loadConsultationHistory,
  persistConsultationHistory,
  estimateRuntimeMessageTokens,
  trimHistoryToCompleteRounds,
} from "../src/consultation-context.ts"
import { RuntimePromptFailure } from "../src/runtime-turn.ts"

const challenge = {
  slug: "clockwork",
  directory: "/tmp/clockwork",
  description: "A VM-shaped reversing challenge",
  files: ["clockwork.bin"],
  flagFormat: "flag\\{[^}]*\\}",
}

function reply(model: string, text: string): ConsultationReply {
  return { model, text, tokens: 100, billable: 80, cost: 0.01 }
}

const snapshot = {
  challenge: "Recover the flag.",
  work: "Decoded the outer archive.",
  clues: "The payload begins with an ELF header.",
}

describe("multi-model consultation", () => {
  test("runs the two experts concurrently and synthesizes only after both finish", async () => {
    const calls: string[] = []
    let releaseExperts!: () => void
    const expertsReleased = new Promise<void>((resolve) => {
      releaseExperts = resolve
    })
    let waiting = 0

    const result = await conductConsultation({
      trigger: "planning",
      expertModels: ["openai/expert-a", "anthropic/expert-b"],
      synthesizerModel: "openai/main",
      context: snapshot,
      ask: async ({ model, title, prompt }) => {
        calls.push(title)
        if (title !== "Boom consult synthesis") {
          expect(prompt).toContain("You are a CTF expert")
          expect(prompt).not.toContain("停止条件")
          waiting += 1
          if (waiting === 2) releaseExperts()
          await expertsReleased
          return reply(model, `plan from ${model}`)
        }
        expect(waiting).toBe(2)
        expect(prompt).toContain("plan from openai/expert-a")
        expect(prompt).toContain("plan from anthropic/expert-b")
        return reply(model, "merged plan")
      },
    })

    expect(calls.slice(0, 2).sort()).toEqual(["Boom consult 1/2", "Boom consult 2/2"])
    expect(calls[2]).toBe("Boom consult synthesis")
    expect(result.plans.map((plan) => plan.model)).toEqual([
      "openai/expert-a",
      "anthropic/expert-b",
    ])
    expect(result.merged.text).toBe("merged plan")
    expect(result).toMatchObject({ tokens: 300, billable: 240, cost: 0.03 })
  })

  test("runs three experts concurrently and gives the synthesiser every plan", async () => {
    const calls: string[] = []
    let releaseExperts!: () => void
    const expertsReleased = new Promise<void>((resolve) => {
      releaseExperts = resolve
    })
    let waiting = 0
    let synthesisPrompt = ""

    const result = await conductConsultation({
      trigger: "manual",
      expertModels: ["openai/one", "anthropic/two", "google/three"],
      synthesizerModel: "openai/main",
      context: snapshot,
      ask: async ({ model, title, prompt }) => {
        calls.push(title)
        if (title !== "Boom consult synthesis") {
          waiting += 1
          if (waiting === 3) releaseExperts()
          await expertsReleased
          return reply(model, `plan from ${model}`)
        }
        expect(waiting).toBe(3)
        synthesisPrompt = prompt
        return reply(model, "merged plan")
      },
    })

    expect(calls.slice(0, 3).sort()).toEqual([
      "Boom consult 1/3",
      "Boom consult 2/3",
      "Boom consult 3/3",
    ])
    expect(result.plans.map((plan) => plan.model)).toEqual([
      "openai/one",
      "anthropic/two",
      "google/three",
    ])
    for (const model of ["openai/one", "anthropic/two", "google/three"])
      expect(synthesisPrompt).toContain(`plan from ${model}`)
    // Three experts, one synthesiser: usage must cover all four calls, not just a fixed pair.
    expect(result).toMatchObject({ tokens: 400, billable: 320 })
  })

  test("rejects an expert count outside the supported range", async () => {
    const ask = async ({ model }: { model: string }) => reply(model, "unused")
    await expect(conductConsultation({
      trigger: "manual",
      expertModels: ["openai/only"],
      synthesizerModel: "openai/main",
      context: snapshot,
      ask,
    })).rejects.toThrow("needs 2-4 expert models")
    await expect(conductConsultation({
      trigger: "manual",
      expertModels: ["a/1", "b/2", "c/3", "d/4", "e/5"],
      synthesizerModel: "openai/main",
      context: snapshot,
      ask,
    })).rejects.toThrow("needs 2-4 expert models")
  })

  test("keeps the synthesis prompt short when plans share a model", async () => {
    let synthesisPrompt = ""
    await conductConsultation({
      trigger: "manual",
      expertModels: ["openai/same", "openai/same", "anthropic/other"],
      synthesizerModel: "openai/main",
      context: snapshot,
      ask: async ({ model, title, prompt }) => {
        if (title === "Boom consult synthesis") synthesisPrompt = prompt
        return reply(model, `draft ${model}`)
      },
    })
    expect(synthesisPrompt).toContain("most actionable plan")
    expect(synthesisPrompt).not.toContain("不构成独立印证")
  })

  test("manual context uses the compact challenge/work/clues envelope", () => {
    const context = buildConsultationContext({
      challenge,
      trigger: "manual",
      notes: "# NOTES\nconfirmed opcode table",
      stopDetail: "decide whether to fuzz the remaining opcode handlers",
      artifacts: ["work/opcodes.json"],
      rejectedFlags: ["flag{wrong}"],
    })
    const rendered = renderConsultationContext(context)

    expect(Object.keys(context)).toEqual(["challenge", "work", "clues"])
    expect(context.challenge).toContain(challenge.description)
    expect(context.work).toContain("decide whether to fuzz")
    expect(context.clues).toContain("confirmed opcode table")
    expect(context.clues).toContain("work/opcodes.json")
    expect(context.clues).toContain("flag{wrong}")
    expect(rendered).toContain("## Challenge summary")
    expect(rendered).toContain("## Work done so far")
    expect(rendered).toContain("## Clues")
  })

  test("compaction context includes the surviving runtime summary and recent execution history", () => {
    const context = buildConsultationContext({
      challenge,
      trigger: "compaction",
      notes: "# NOTES\nOnly an older clue was recorded.",
      stopDetail: "runtime compacted",
      history: [{
        id: "compact-1",
        role: "compaction",
        parts: [
          { type: "summary", text: "Tried AES-CBC and ruled it out because the block relation failed." },
          { type: "recent", text: "The last command extracted stream 7; inspect its zlib payload next." },
        ],
      }],
    })
    const rendered = renderConsultationContext(context)

    expect(context.work).toContain("Tried AES-CBC")
    expect(rendered).toContain("ruled it out")
    expect(rendered).toContain("last command extracted stream 7")
    expect(context.clues).toContain("Only an older clue was recorded")
  })

  test("manual and post-compaction histories use the same consultation-only compression", () => {
    const history = [{
      id: "assistant-work",
      role: "assistant" as const,
      parts: [{ type: "text", text: "Recovered a useful nonce relation." }],
    }]
    const common = {
      challenge,
      notes: "The nonces repeat every fourth packet.",
      stopDetail: "Choose the next attack.",
      history,
    }
    const manual = buildConsultationContext({ ...common, trigger: "manual" })
    const compacted = buildConsultationContext({ ...common, trigger: "compaction" })

    expect(manual).toEqual(compacted)
  })

  test("compresses one oversized API round instead of dropping all recent work", () => {
    const work = compressConsultationHistory([{
      id: "assistant-large",
      role: "assistant",
      parts: [{ type: "tool", tool: "shell", input: "probe", output: `useful-start ${"x".repeat(20_000)} useful-end` }],
    }], 2_000)

    expect(work).toContain("useful-start")
    expect(work).toContain("useful-end")
    expect(work).toContain("truncated")
  })

  test("keeps dense CJK history within the requested token budget", () => {
    const budget = 100
    const work = compressConsultationHistory([{
      id: "dense-cjk",
      role: "assistant",
      parts: [{ type: "text", text: "汉".repeat(1_000) }],
    }], budget)

    expect(estimateTextTokens(work)).toBeLessThanOrEqual(budget)
  })

  test("allows one capable model to serve independent roles", async () => {
    const calls: string[] = []
    const result = await conductConsultation({
      trigger: "planning",
      expertModels: ["openai/same", "openai/same"],
      synthesizerModel: "openai/same",
      context: snapshot,
      ask: async ({ model, title }) => {
        calls.push(title)
        return reply(model, title === "Boom consult synthesis" ? "merged" : "independent")
      },
    })
    expect(calls).toHaveLength(3)
    expect(result.plans.map((plan) => plan.model)).toEqual([
      "openai/same",
      "openai/same",
    ])
    expect(result.merged.model).toBe("openai/same")
  })

  test("writes a numbered section per expert when there are more than two", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-consult-n-"))
    try {
      const consultation = await conductConsultation({
        trigger: "manual",
        expertModels: ["openai/one", "anthropic/two", "google/three"],
        synthesizerModel: "openai/main",
        context: snapshot,
        ask: async ({ model, title }) =>
          reply(model, title === "Boom consult synthesis" ? "merged" : `draft ${model}`),
      })
      await persistConsultation(directory, consultation)

      const markdown = await Bun.file(path.join(directory, "work", "CONSULTATION.md")).text()
      expect(markdown).toContain("## Expert 1: openai/one")
      expect(markdown).toContain("## Expert 2: anthropic/two")
      expect(markdown).toContain("## Expert 3: google/three")
      expect(markdown).toContain("draft google/three")
      expect(markdown).toContain("## Synthesized plan: openai/main")
      const saved = await Bun.file(path.join(directory, "work", "consultation.json")).json()
      expect(saved.plans).toHaveLength(3)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("persists the complete consultation and subtracts its billable usage", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-consult-"))
    try {
      const consultation = await conductConsultation({
        trigger: "stalled",
        sourceRunID: "previous-run",
        expertModels: ["openai/a", "anthropic/b"],
        synthesizerModel: "openai/main",
        context: snapshot,
        ask: async ({ model, title }) =>
          reply(model, title === "Boom consult synthesis" ? "merged" : `draft ${model}`),
      })
      await persistConsultation(directory, consultation)

      expect(await Bun.file(path.join(directory, "work", "CONSULTATION.md")).text()).toContain(
        "## Synthesized plan: openai/main",
      )
      const saved = await Bun.file(path.join(directory, "work", "consultation.json")).json()
      expect(saved).toMatchObject({
        trigger: "stalled",
        source_run_id: "previous-run",
        billable_tokens: 240,
      })
      const remaining = remainingLimits(
        { tokens: 1_000, repeats: 5, timeout: 60_000 },
        consultation,
      )
      expect(remaining).toMatchObject({ tokens: 760, repeats: 5 })
      expect(remaining!.timeout).toBeGreaterThan(59_000)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("refuses to persist when an output file is a planted symlink", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-consult-link-"))
    try {
      const consultation = await conductConsultation({
        trigger: "manual",
        expertModels: ["openai/a", "anthropic/b"],
        synthesizerModel: "openai/main",
        context: snapshot,
        ask: async ({ model, title }) =>
          reply(model, title === "Boom consult synthesis" ? "merged" : `plan ${model}`),
      })
      await mkdir(path.join(directory, "work"))

      const outside = path.join(directory, "outside.json")
      await writeFile(outside, "host payload")
      await symlink(outside, path.join(directory, "work", "consultation.json"))
      await expect(persistConsultation(directory, consultation)).rejects.toThrow(
        /not a real file/,
      )
      expect(await readFile(outside, "utf8")).toBe("host payload")

      // The same guard protects the markdown artifact.
      const outsideMarkdown = path.join(directory, "outside.md")
      await writeFile(outsideMarkdown, "host notes")
      await rm(path.join(directory, "work", "consultation.json"))
      await symlink(outsideMarkdown, path.join(directory, "work", "CONSULTATION.md"))
      await expect(persistConsultation(directory, consultation)).rejects.toThrow(
        /not a real file/,
      )
      expect(await readFile(outsideMarkdown, "utf8")).toBe("host notes")
      expect((await readdir(path.join(directory, "work"))).filter((name) => name.endsWith(".tmp")))
        .toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("trims history only at complete API-round boundaries", () => {
    const history = [
      { id: "user-1", role: "user" as const, parts: [{ type: "text", text: "old question" }] },
      {
        id: "assistant-1",
        role: "assistant" as const,
        parts: [{ type: "tool", tool: "shell", input: "old probe", output: "old result" }],
      },
      { id: "user-2", role: "user" as const, parts: [{ type: "text", text: "new question" }] },
      {
        id: "assistant-2",
        role: "assistant" as const,
        parts: [{ type: "tool", tool: "shell", input: "new probe", output: "new result" }],
      },
    ]
    const newestRoundTokens = history.slice(2).reduce(
      (sum, message) => sum + estimateRuntimeMessageTokens(message),
      0,
    )
    const trimmed = trimHistoryToCompleteRounds(history, newestRoundTokens)

    expect(trimmed.messages.map((message) => message.id)).toEqual(["user-2", "assistant-2"])
    expect(trimmed.omittedRounds).toBe(1)
    expect(trimmed.messages[1]!.parts[0]).toMatchObject({ input: "new probe", output: "new result" })
  })

  test("keeps successful experts when one expert fails and synthesizes the remainder", async () => {
    const settled: string[] = []
    const result = await conductConsultation({
      trigger: "agent-request",
      expertModels: ["openai/a", "anthropic/b", "google/c"],
      synthesizerModel: "openai/main",
      context: snapshot,
      expertRetries: 0,
      onExpertSettled(value) {
        settled.push(value.status === "success" ? value.reply.model : value.failure.model)
      },
      ask: async ({ model, title }) => {
        if (model === "anthropic/b") throw new Error("provider unavailable")
        return reply(model, title === "Boom consult synthesis" ? "merged surviving plans" : `plan ${model}`)
      },
    })

    expect(settled.sort()).toEqual(["anthropic/b", "google/c", "openai/a"])
    expect(result.plans.map((plan) => plan.model)).toEqual(["openai/a", "google/c"])
    expect(result.failures).toEqual([
      expect.objectContaining({ index: 1, model: "anthropic/b", error: "provider unavailable" }),
    ])
    expect(result.merged.text).toBe("merged surviving plans")
  })

  test("skips permanent expert failures instead of retrying invalid credentials", async () => {
    const failedTitles: string[] = []
    const result = await conductConsultation({
      trigger: "manual",
      expertModels: ["mimo/broken", "openai/working"],
      synthesizerModel: "openai/main",
      context: snapshot,
      expertRetries: 2,
      expertRetryDelayMs: 0,
      ask: async ({ model, title }) => {
        if (model === "mimo/broken") {
          failedTitles.push(title)
          throw new Error("Invalid API Key")
        }
        return reply(model, "surviving plan")
      },
    })

    expect(failedTitles).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({ model: "mimo/broken", attempts: 1 })
    expect(result.degraded).toMatchObject({ reason: "insufficient-experts" })
  })

  test("retries a transient expert failure with bounded backoff", async () => {
    let attempts = 0
    const result = await conductConsultation({
      trigger: "manual",
      expertModels: ["openai/flaky", "openai/working"],
      synthesizerModel: "openai/main",
      context: snapshot,
      expertRetries: 1,
      expertRetryDelayMs: 0,
      ask: async ({ model, title }) => {
        if (model === "openai/flaky" && title !== "Boom consult synthesis" && attempts++ === 0)
          throw Object.assign(new Error("Service Unavailable"), { statusCode: 503 })
        return reply(model, title === "Boom consult synthesis" ? "merged" : `plan ${model}`)
      },
    })

    expect(attempts).toBe(2)
    expect(result.plans).toHaveLength(2)
    expect(result.degraded).toBeUndefined()
  })

  test("preserves completed experts when synthesis reaches the consultation deadline", async () => {
    const result = await conductConsultation({
      trigger: "manual",
      expertModels: ["openai/a", "openai/b"],
      synthesizerModel: "openai/main",
      context: snapshot,
      timeout: 20,
      ask: async ({ model, title, signal }) => {
        if (title !== "Boom consult synthesis") return reply(model, `plan ${model}`)
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("deadline aborted synthesis")), { once: true })
        })
        throw new Error("unreachable")
      },
    })

    expect(result.plans).toHaveLength(2)
    expect(result.degraded).toMatchObject({ reason: "synthesis-failed" })
    expect(result.merged.text).toContain("plan openai/a")
    expect(result.merged.text).toContain("plan openai/b")
  })

  test("continues with a clearly marked degraded plan when only one expert succeeds", async () => {
    const titles: string[] = []
    const result = await conductConsultation({
      trigger: "manual",
      expertModels: ["openai/a", "anthropic/b", "google/c"],
      synthesizerModel: "openai/main",
      context: snapshot,
      expertRetries: 0,
      ask: async ({ model, title }) => {
        titles.push(title)
        if (model !== "openai/a") throw new Error(`${model} unavailable`)
        return reply(model, "the surviving evidence-first plan")
      },
    })

    expect(titles).not.toContain("Boom consult synthesis")
    expect(result.plans).toHaveLength(1)
    expect(result.degraded).toMatchObject({ reason: "insufficient-experts" })
    expect(result.merged).toMatchObject({ model: "boom/degraded", tokens: 0, billable: 0 })
    expect(result.merged.text).toContain("the surviving evidence-first plan")
    expect(result).toMatchObject({ tokens: 100, billable: 80, cost: 0.01 })
  })

  test("preserves successful plans when the synthesizer fails", async () => {
    const result = await conductConsultation({
      trigger: "manual",
      expertModels: ["openai/a", "anthropic/b"],
      synthesizerModel: "openai/main",
      context: snapshot,
      expertRetries: 0,
      ask: async ({ model, title }) => {
        if (title === "Boom consult synthesis") throw new Error("provider finish was unusable")
        return reply(model, `plan ${model}`)
      },
    })

    expect(result.degraded).toEqual({
      reason: "synthesis-failed",
      detail: "provider finish was unusable",
    })
    expect(result.merged.model).toBe("boom/degraded")
    expect(result.merged.text).toContain("plan openai/a")
    expect(result.merged.text).toContain("plan anthropic/b")
    expect(result).toMatchObject({ tokens: 200, billable: 160, cost: 0.02 })
  })

  test("accepts a consultant's non-empty response when a provider reports an unknown finish", async () => {
    const consultant = createRuntimeConsultant({
      workspace: { directory: "/tmp", runID: "runtime-finish-test", extracted: [] },
      runtime: {
        async createConversation() {
          return {
            id: "consultant-unknown-finish",
            async events() {
              return { async *[Symbol.asyncIterator]() {} }
            },
            async prompt() {
              return {
                parts: [{ type: "text", text: "usable plan despite provider metadata" }],
                usage: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: 0.001,
                finish: "unknown" as const,
              }
            },
            async abort() {},
          }
        },
      },
    })

    await expect(consultant({
      model: "free/compatible",
      title: "Boom consult synthesis",
      prompt: "merge",
    })).resolves.toMatchObject({
      text: "usable plan despite provider metadata",
      finish: "unknown",
      tokens: 15,
      billable: 15,
    })
  })

  test("allocates independent hard budgets and forwards role ceilings", async () => {
    const budgets = allocateConsultationBudgets(10_000, 2)
    const seen: Array<{ title: string; budget?: number }> = []
    await conductConsultation({
      trigger: "planning",
      expertModels: ["openai/a", "anthropic/b"],
      synthesizerModel: "openai/main",
      context: snapshot,
      budgets,
      ask: async ({ model, title, tokenBudget }) => {
        seen.push({ title, budget: tokenBudget })
        return reply(model, title === "Boom consult synthesis" ? "merged" : "plan")
      },
    })

    expect(budgets).toEqual({ expertTokens: 1_500, synthesizerTokens: 2_000, solverTokens: 5_000 })
    expect(seen.filter((call) => call.title !== "Boom consult synthesis").map((call) => call.budget))
      .toEqual([1_500, 1_500])
    expect(seen.at(-1)).toEqual({ title: "Boom consult synthesis", budget: 2_000 })
  })

  test("caps consultation budgets at declared model windows", () => {
    const capped = allocateConsultationBudgets(10_000, 2, { expert: 1_000, synthesizer: 500 })

    expect(capped).toEqual({ expertTokens: 1_000, synthesizerTokens: 500, solverTokens: 5_000 })
  })

  test("walks down the prompt ladder when an expert prompt does not fit the runtime", async () => {
    const prompts: string[] = []
    const budgets: Array<number | undefined> = []
    const result = await conductConsultation({
      trigger: "manual",
      expertModels: ["openai/a", "anthropic/b"],
      synthesizerModel: "openai/main",
      context: snapshot,
      budgets: { expertTokens: 2_000, synthesizerTokens: 1_000, solverTokens: 7_000 },
      promptRungs: [
        { index: 0, prompt: `FULL ${"x".repeat(2_000)}`, historyTokens: 100, scale: 1 },
        { index: 1, prompt: "small context", historyTokens: 25, scale: 0.25 },
        { index: 2, prompt: "tiny context", historyTokens: 6, scale: 0.0625 },
      ],
      expertRetries: 0,
      ask: async ({ model, title, prompt, tokenBudget }) => {
        if (title !== "Boom consult synthesis") {
          prompts.push(prompt)
          budgets.push(tokenBudget)
        }
        if (prompt.startsWith("FULL")) throw new RuntimePromptFailure(
          "runtime prompt token budget exceeded: 9_000 > 2_000",
          { input: 9_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          0.1,
        )
        return reply(model, `plan ${model}`)
      },
    })

    expect(result.plans.map((plan) => plan.text)).toEqual(["plan openai/a", "plan anthropic/b"])
    expect(prompts.filter((prompt) => prompt.startsWith("FULL"))).toHaveLength(2)
    expect(prompts.filter((prompt) => prompt.startsWith("small"))).toHaveLength(2)
    // The overflowed attempt must not consume the follow-up ask budget.
    expect(budgets).toEqual([2_000, 2_000, 2_000, 2_000])
  })

  test("walks the synthesis ladder when the merged prompt overflows", async () => {
    const synthesisPrompts: string[] = []
    const result = await conductConsultation({
      trigger: "manual",
      expertModels: ["openai/a", "anthropic/b"],
      synthesizerModel: "openai/main",
      context: snapshot,
      budgets: { expertTokens: 1_000, synthesizerTokens: 2_000, solverTokens: 7_000 },
      synthesisRungs: [
        { index: 0, prompt: "BIG MERGE", historyTokens: 0, scale: 1 },
        { index: 1, prompt: "small merge", historyTokens: 0, scale: 0.25 },
      ],
      expertRetries: 0,
      ask: async ({ model, title, prompt }) => {
        if (title === "Boom consult synthesis") {
          synthesisPrompts.push(prompt)
          if (prompt === "BIG MERGE") throw new RuntimePromptFailure(
            "runtime prompt token budget exceeded: 408342 > 400000",
            { input: 400_000, output: 0, reasoning: 8_342, cache: { read: 0, write: 0 } },
            0.01,
          )
          return reply(model, "merged")
        }
        return reply(model, `plan ${model}`)
      },
    })

    expect(synthesisPrompts).toEqual(["BIG MERGE", "small merge"])
    expect(result.merged.text).toBe("merged")
    expect(result.degraded).toBeUndefined()
  })

  test("renders synthesis ladder contexts with bounded plan text", async () => {
    let synthesisPrompt = ""
    await conductConsultation({
      trigger: "manual",
      expertModels: ["openai/a", "anthropic/b"],
      synthesizerModel: "openai/main",
      context: snapshot,
      synthesisContexts: [
        { challenge: "摘要", work: "工作", clues: "线索" },
        { challenge: "摘要小", work: "工作小", clues: "线索小" },
      ],
      expertRetries: 0,
      ask: async ({ model, title, prompt }) => {
        if (title === "Boom consult synthesis") synthesisPrompt = prompt
        return reply(model, `draft ${model}`)
      },
    })

    expect(synthesisPrompt).toContain("摘要")
    expect(synthesisPrompt).toContain("draft openai/a")
    expect(synthesisPrompt).not.toContain("plan openai/a")
  })

  test("persists provider-neutral history for a later manual consultation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-consult-history-"))
    try {
      await mkdir(path.join(directory, "work"))
      await persistConsultationHistory({
        directory,
        sessionID: "solver-original",
        messages: [{
          id: "assistant-latest",
          role: "assistant",
          parts: [{ type: "tool", tool: "shell", input: "probe", output: "evidence" }],
        }],
      })

      expect(await loadConsultationHistory(directory)).toMatchObject({
        version: 1,
        sessionID: "solver-original",
        messages: [{ id: "assistant-latest", role: "assistant" }],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
