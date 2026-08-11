import { describe, expect, test } from "bun:test"
import {
  budgetTokens,
  buildPrompt,
  buildWriteupPrompt,
  classifyVerification,
  describe as describeError,
  findDeclaredCandidates,
  findCandidates,
  isRejectedAttachment,
  isTransient,
  messageTokens,
  parseWriteup,
  runChallenge,
  TextLoopDetector,
} from "../src/session.ts"
import { resolveRuntimeModel } from "../src/runtime.ts"

test("stream repetition guard detects degenerate output blocks without flagging normal prose", () => {
  const normal = new TextLoopDetector()
  expect(normal.push("one useful observation\ntwo different observations\n")).toBeUndefined()
  const looping = new TextLoopDetector()
  const block = "0123456789abcdef".repeat(4)
  expect(looping.push(block.repeat(5))).toContain("repeated")
})

describe("model aliases", () => {
  test("maps the public free provider to the internal runtime provider", () => {
    expect(resolveRuntimeModel("free/deepseek-v4-flash-free")).toBe("opencode/deepseek-v4-flash-free")
  })

  test("preserves explicitly configured providers", () => {
    expect(resolveRuntimeModel("anthropic/claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5")
  })
})

describe("candidate extraction", () => {
  test("does not guess candidates when no flag format was supplied", () => {
    expect(findCandidates("maybe flag{one}", "")).toEqual([])
    expect(findCandidates("maybe flag{one}", "   ")).toEqual([])
  })

  test("deduplicates matching flags", () => {
    expect(findCandidates("flag{one} flag{one} flag{two}", "flag\\{[^}]*\\}")).toEqual([
      "flag{one}",
      "flag{two}",
    ])
  })

  test("treats an invalid format as no candidates", () => {
    expect(findCandidates("flag{one}", "[")).toEqual([])
  })

  test("drops format literals written while explaining the format", () => {
    // Observed for real: the agent explained `flag{...}` next to the answer it had found.
    const reply = "格式为 flag{...}，实际得到 flag{那你也很棒哦}"
    expect(findCandidates(reply, "flag\\{[^}]*\\}")).toEqual(["flag{那你也很棒哦}"])
  })

  test("drops the usual stand-in bodies but keeps real flags", () => {
    const format = "flag\\{[^}]*\\}"
    for (const fake of ["flag{}", "flag{xxx}", "flag{XXXX}", "flag{your_flag_here}", "flag{____}"])
      expect(findCandidates(fake, format)).toEqual([])
    for (const real of ["flag{xor_is_not_encryption}", "flag{a}", "flag{4069afd7089f}"])
      expect(findCandidates(real, format)).toEqual([real])
  })
})

describe("model-declared results", () => {
  test("requires a Chinese final writeup while preserving literal technical material", () => {
    const prompt = buildWriteupPrompt("flag{confirmed}")
    expect(prompt).toContain("Writeup 必须使用中文")
    expect(prompt).toContain("命令、代码、文件路径与 flag 保持原样")
    expect(prompt).toContain("用代码块嵌入脚本的完整源码")
    expect(prompt).toContain("不得省略、截断或用省略号代替任何代码")
    expect(prompt).toContain("已确认 flag：flag{confirmed}")
  })

  test("extracts flag and verification fields from a writeup", () => {
    expect(
      parseWriteup(`
# warmup

**Flag:** \`flag{from_writeup}\`
**Verification:** offline decode + format match
`),
    ).toEqual({
      flag: "flag{from_writeup}",
      verification: "offline decode + format match",
    })
  })

  test("accepts both canonical and legacy Markdown result declarations", () => {
    expect(parseWriteup("**Flag: flag{whole_line_bold}**")).toEqual({
      flag: "flag{whole_line_bold}",
      verification: undefined,
    })
    expect(parseWriteup("**Flag: `flag{whole_line_code}`**")).toEqual({
      flag: "flag{whole_line_code}",
      verification: undefined,
    })
    expect(parseWriteup("FINAL_FLAG: flag{canonical}")).toEqual({
      flag: "flag{canonical}",
      verification: undefined,
    })
  })

  test("accepts only explicitly declared final candidates", () => {
    const reply = [
      "I considered flag{guess} but did not verify it.",
      "**Flag:** `flag{markdown_only}`",
      "FINAL_FLAG: `flag{declared}`",
      "FINAL_FLAG: `flag{declared}`",
      "flag{bare}",
    ].join("\n")

    expect(findDeclaredCandidates(reply)).toEqual(["flag{markdown_only}", "flag{declared}"])
  })

  test("classifies all four verification levels", () => {
    expect(classifyVerification("remote service accepted it")).toEqual({
      level: "remote",
      detail: "remote service accepted it",
    })
    expect(classifyVerification("local checker returned correct")).toEqual({
      level: "local-checker",
      detail: "local checker returned correct",
    })
    expect(classifyVerification("offline decode + format match")).toEqual({
      level: "offline-derivation",
      detail: "offline decode + format match",
    })
    expect(classifyVerification("model judgement only")).toEqual({
      level: "unverified",
      detail: "model judgement only",
    })
  })
})

describe("token accounting", () => {
  const step = (input: number, output: number, reasoning = 0, read = 0, write = 0) => ({
    input,
    output,
    reasoning,
    cache: { read, write },
  })

  test("counts every usage category, not just input and output", () => {
    expect(messageTokens(step(100, 20, 7, 3, 1))).toBe(131)
  })

  test("a session's budget is the sum of its steps, never the largest one", () => {
    // Upstream overwrites per-step usage rather than accumulating it, so a run that takes many small
    // steps must still be charged for all of them.
    const steps = [step(1000, 100), step(1200, 90), step(1500, 120)]
    const total = steps.reduce((sum, one) => sum + messageTokens(one), 0)
    expect(total).toBe(4010)
    expect(total).toBeGreaterThan(Math.max(...steps.map(messageTokens)))
  })

  test("the budget discounts cache reads while the reported figure does not", () => {
    // 100 fresh prompt + 20 output + 10000 cache reads: cheap in practice, huge at face value.
    const usage = step(100, 20, 0, 10_000, 0)
    expect(messageTokens(usage)).toBe(10_120)
    expect(budgetTokens(usage)).toBeCloseTo(1120, 6)
  })

  test("cache writes stay at full price, unlike reads", () => {
    expect(budgetTokens(step(0, 0, 0, 1000, 0))).toBeCloseTo(100, 6)
    expect(budgetTokens(step(0, 0, 0, 0, 1000))).toBeCloseTo(1000, 6)
  })
})

describe("failure classification", () => {
  test("retries transport and capacity failures", () => {
    // Observed for real: a TLS failure ended a challenge that had 60 minutes of budget left.
    expect(isTransient({ name: "UnknownError", data: { message: "unknown certificate verification error" } })).toBe(
      true,
    )
    expect(isTransient({ data: { statusCode: 429 } })).toBe(true)
    expect(isTransient({ data: { statusCode: 503 } })).toBe(true)
    expect(isTransient({ data: { isRetryable: true } })).toBe(true)
    expect(isTransient({ data: { message: "socket hang up" } })).toBe(true)
  })

  test("does not retry failures that will repeat identically", () => {
    expect(isTransient({ data: { statusCode: 400 } })).toBe(false)
    expect(isTransient({ data: { statusCode: 401 } })).toBe(false)
    expect(isTransient({ name: "ValidationError", data: { message: "model must be provider/model" } })).toBe(false)
  })

  test("recognises a rejected attachment as recoverable but not retryable", () => {
    // Observed for real: the agent attached a 3.3 MB PDF and the request was refused.
    const rejected = {
      name: "APIError",
      data: {
        statusCode: 400,
        message: "The file you uploaded is badly formatted or corrupted. Please fix the file and try again.",
        responseBody: '{"error":{"code":"invalid_file"}}',
      },
    }
    expect(isRejectedAttachment(rejected)).toBe(true)
    // A plain 400 must not be mistaken for one.
    expect(isRejectedAttachment({ data: { statusCode: 400, message: "bad request" } })).toBe(false)
  })

  test("summarises an error to a single line", () => {
    expect(describeError({ name: "APIError", data: { message: "overloaded" } })).toBe("overloaded")
    expect(describeError({ name: "UnknownError" })).toBe("UnknownError")
  })
})

describe("run controls", () => {
  test("appends a trimmed user hint without changing the base prompt when it is blank", () => {
    const base = buildPrompt()

    expect(buildPrompt("   ")).toBe(base)
    expect(buildPrompt("  优先检查压缩包注释  ")).toBe(`${base}\n\n用户追加提示：优先检查压缩包注释`)
  })

  test("adds category-specific priorities without overriding challenge evidence", () => {
    const web = buildPrompt(undefined, "web")
    expect(web).toContain("正在解一道 CTF WEB 类型题目")
    expect(web).toContain("HTTP 行为、路由、参数、会话与鉴权")
    expect(web).toContain("以实际证据为准")

    const pwn = buildPrompt(undefined, "PWN")
    expect(pwn).toContain("正在解一道 CTF PWN 类型题目")
    expect(pwn).toContain("内存破坏面")
  })

  test("returns an aborted outcome before creating a runtime conversation when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const events: unknown[] = []

    const outcome = await runChallenge({
      runtime: {
        async createConversation() {
          throw new Error("an already-aborted turn must not reach the runtime")
        },
      },
      challenge: {
        slug: "never-started",
        directory: "/does/not/matter",
        description: "",
        files: [],
        flagFormat: "",
      },
      workspace: {
        directory: "/does/not/matter",
        runID: "never-started",
        extracted: [],
      },
      model: "invalid-without-provider",
      limits: { tokens: 1, repeats: 2, timeout: 1 },
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    })

    expect(outcome).toMatchObject({
      stop: "aborted",
      tokens: 0,
      billable: 0,
      cost: 0,
      candidates: [],
      detail: "aborted by user",
    })
    expect(events).toEqual([])
  })
})
