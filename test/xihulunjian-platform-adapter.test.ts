import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  innerFlagValue,
  selectEndpoint,
  XihulunjianPlatformAdapter,
} from "../src/xihulunjian-platform-adapter.ts"

const PREFIX = "/slab-match/api/v1/agent"
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** No-op sleep so throttling and backoff never slow the tests down. */
const instant = async () => {}

function envelope(data: unknown, code = "00000", message = "") {
  return Response.json({ data, code, message })
}

/**
 * The live challenge-list shape: categories at the top level, challenges nested under `corpus`.
 */
const EXERCISE_LIST = [
  {
    id: 3109,
    name: "Web",
    order: 1,
    corpus: [{ id: 10661, name: "web-unserialize-1-3", order: 1, isOpen: true, hasSolved: false }],
  },
  {
    id: 3110,
    name: "Pwn",
    order: 2,
    corpus: [
      { id: 10662, name: "shopping", order: 1, isOpen: true, hasSolved: false },
      // Not yet released: batched releases mean this must be skipped rather than fetched.
      { id: 10999, name: "unreleased", order: 2, isOpen: false, hasSolved: false },
    ],
  },
]

test("accepts both attachment shapes and marks local-only challenges", async () => {
  const details: Record<string, unknown> = {
    // Real shape when a file exists: a single object, not the documented {files:[...]}.
    "10662": {
      id: 10662,
      name: "shopping",
      description: "让我们来购物吧",
      score: "100.0",
      difficulty: "EASY",
      attachment: {
        url: "https://pro-resource.example.com/resource/oss/abc.zip",
        name: "shopping的附件.zip",
        extension: "zip",
      },
      endpoints: [],
      isNeedInit: true,
      endpointType: "monopoly",
      isNeedCheck: false,
    },
    // Real shape when no file exists: an empty array.
    "10663": {
      id: 10663,
      name: "解压缩",
      description: "解压获取福来阁",
      score: "50.0",
      difficulty: "VERY_EASY",
      attachment: [],
      endpoints: [],
      isNeedInit: false,
      endpointType: "none",
      isNeedCheck: false,
    },
  }
  const adapter = new XihulunjianPlatformAdapter("ak_test", (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === `${PREFIX}/ctf/exercise`)
      return envelope(details[url.searchParams.get("exerciseId")!])
    return Response.json({ code: "40400" }, { status: 404 })
  }) as typeof fetch, instant)

  const withFile = await adapter.exerciseDetail("10662")
  expect(withFile).toMatchObject({ score: 100, difficulty: "EASY", serviceRequired: true, needsInit: true })
  expect(withFile.attachments).toEqual([
    { name: "shopping的附件.zip", url: "https://pro-resource.example.com/resource/oss/abc.zip" },
  ])

  const local = await adapter.exerciseDetail("10663")
  expect(local.attachments).toEqual([])
  // endpointType "none" must not consume one of the three scarce environment slots.
  expect(local.serviceRequired).toBe(false)
  expect(local.score).toBe(50)
})

test("materializes challenges without starting environments and never leaks the AccessKey to the CDN", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-xihu-"))
  roots.push(root)
  const calls: string[] = []
  let cdnAuthHeader: string | null = "unset"

  const adapter = new XihulunjianPlatformAdapter("ak_secret", (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    calls.push(`${request.method} ${url.pathname}`)
    if (url.pathname === `${PREFIX}/ctf/exercise-list`) return envelope(EXERCISE_LIST)
    if (url.pathname === `${PREFIX}/ctf/exercise`) {
      const id = url.searchParams.get("exerciseId")!
      return envelope({
        id: Number(id),
        name: id === "10661" ? "web-unserialize-1-3" : "shopping",
        description: "题面",
        score: "50.0",
        difficulty: "VERY_EASY",
        attachment: id === "10662"
          ? { url: "https://pro-resource.example.com/oss/a.zip", name: "a.zip", extension: "zip" }
          : [],
        endpoints: [],
        isNeedInit: true,
        endpointType: "monopoly",
        isNeedCheck: false,
      })
    }
    if (url.hostname === "pro-resource.example.com") {
      cdnAuthHeader = request.headers.get("X-Agent-AccessKey")
      return new Response(new Uint8Array([1, 2, 3]))
    }
    return Response.json({ code: "40400" }, { status: 404 })
  }) as typeof fetch, instant)

  const challenges = await adapter.acquireChallenges({ root })
  expect(challenges.map((item) => item.slug).sort()).toEqual(["shopping", "web-unserialize-1-3"])

  // Acquisition must never start an environment: only three may exist at once and each has an
  // expiry clock, so slots are claimed by the scheduler at solve time instead.
  expect(calls.some((call) => call.includes("build-exercise-env"))).toBe(false)
  // The AccessKey is a platform API credential and must not reach object storage.
  expect(cdnAuthHeader).toBeNull()

  const meta = JSON.parse(
    await readFile(path.join(root, "challenges", "PWN", "shopping", "meta.json"), "utf8"),
  )
  expect(meta).toMatchObject({
    category: "PWN",
    service_required: true,
    platform: { adapter: "xihulunjian", challenge_id: "10662", options: { exercise_id: "10662", score: 50 } },
  })
  expect(await readFile(path.join(root, "challenges", "PWN", "shopping", "files", "a.zip")))
    .toEqual(Buffer.from([1, 2, 3]))
})

test("skips one malformed released challenge without blocking the rest of its release batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-xihu-"))
  roots.push(root)
  const adapter = new XihulunjianPlatformAdapter("ak_test", (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === `${PREFIX}/ctf/exercise-list`) {
      return envelope([{
        id: 1,
        name: "Misc",
        corpus: [
          { id: 1, name: "broken", isOpen: true, hasSolved: false },
          { id: 2, name: "usable", isOpen: true, hasSolved: true },
        ],
      }])
    }
    if (url.pathname === `${PREFIX}/ctf/exercise`) {
      if (url.searchParams.get("exerciseId") === "1")
        return envelope({}, "40002", "题目暂不可用")
      return envelope({
        id: 2,
        name: "usable",
        description: "继续处理这一题",
        attachment: [],
        endpoints: [],
        endpointType: "none",
        isNeedInit: false,
        isNeedCheck: false,
        hasSolved: true,
      })
    }
    return Response.json({ code: "40400" }, { status: 404 })
  }) as typeof fetch, instant)

  const challenges = await adapter.acquireChallenges({ root })
  expect(challenges.map((item) => item.slug)).toEqual(["usable"])
  const meta = JSON.parse(await readFile(path.join(root, "challenges", "MISC", "usable", "meta.json"), "utf8"))
  expect(meta.platform.options).toMatchObject({ exercise_id: "2", solved: true })
})

test("builds, polls, and reports a ready environment", async () => {
  const calls: string[] = []
  let polls = 0
  const adapter = new XihulunjianPlatformAdapter("ak_test", (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    calls.push(`${request.method} ${url.pathname}`)
    if (url.pathname === `${PREFIX}/ctf/build-exercise-env`) return envelope({})
    if (url.pathname === `${PREFIX}/ctf/exercise`) {
      polls += 1
      // First read reports "needs init"; the environment only becomes usable after provisioning.
      const ready = polls > 2
      return envelope({
        id: 10661,
        name: "web-unserialize-1-3",
        attachment: [],
        isNeedInit: !ready,
        isNeedCheck: !ready && polls > 1,
        endpointType: "monopoly",
        endpoints: ready
          ? [{
              // Verified live: exposeIps entries already include the port.
              exposeIps: ["1.14.76.59:27629"],
              ports: ["http/80"],
              isProxy: true,
              proxyIps: ["1.14.76.59"],
              portMappings: [{ type: "http", port: "80", proxy: "27629" }],
              expireTime: 1787130300000,
            }]
          : [],
      })
    }
    return Response.json({ code: "40400" }, { status: 404 })
  }) as typeof fetch, instant)

  const detail = await adapter.ensureEnvironment("10661")
  expect(detail.endpoint?.remote).toBe("1.14.76.59:27629")
  expect(detail.endpoint?.expireTime).toBe(1787130300000)
  expect(calls.filter((call) => call.includes("build-exercise-env"))).toHaveLength(1)
})

test("submits only the value inside the flag wrapper", async () => {
  const bodies: unknown[] = []
  const adapter = new XihulunjianPlatformAdapter("ak_test", (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    bodies.push(await request.json())
    return envelope({ isCorrect: true })
  }) as typeof fetch, instant)

  const challenge = {
    slug: "shopping",
    directory: "/tmp/shopping",
    description: "",
    files: [],
    flagFormat: "",
    platform: { adapter: "xihulunjian", challengeID: "10662" },
  }
  const result = await adapter.submitFlag({
    challenge,
    workspace: { directory: "/tmp/run", runID: "r1", extracted: [] },
    candidate: "DASCTF{p0p_cha1n}",
  })
  expect(result).toMatchObject({ adapter: "xihulunjian", verdict: "accepted" })
  // The rules require submitting only the contents of the braces.
  expect(bodies[0]).toEqual({ exerciseId: 10662, flag: "p0p_cha1n" })
})

test("maps an explicit incorrect verdict to rejected", async () => {
  const adapter = new XihulunjianPlatformAdapter("ak_test", (async () =>
    envelope({ isCorrect: false })) as unknown as typeof fetch, instant)
  const result = await adapter.submitFlag({
    challenge: {
      slug: "shopping",
      directory: "/tmp/shopping",
      description: "",
      files: [],
      flagFormat: "",
      platform: { adapter: "xihulunjian", challengeID: "10662" },
    },
    workspace: { directory: "/tmp/run", runID: "r1", extracted: [] },
    candidate: "flag{wrong}",
  })
  expect(result.verdict).toBe("rejected")
})

test("does not retry an incorrect flag reported with the overloaded 40001 code", async () => {
  let calls = 0
  const adapter = new XihulunjianPlatformAdapter("ak_test", (async () => {
    calls += 1
    // The live answer endpoint sends this HTTP 200 business failure with code 40001, which is
    // also used as the general rate-limit code on other endpoints.
    return envelope(null, "40001", "提交flag错误，请重新提交（当前还有45次提交机会）")
  }) as unknown as typeof fetch, instant)

  const result = await adapter.submitFlag({
    challenge: {
      slug: "unzip",
      directory: "/tmp/unzip",
      description: "",
      files: [],
      flagFormat: "",
      platform: { adapter: "xihulunjian", challengeID: "10663" },
    },
    workspace: { directory: "/tmp/run", runID: "r1", extracted: [] },
    candidate: "DASCTF{ni_cai?}",
  })

  expect(result.verdict).toBe("rejected")
  expect(calls).toBe(1)
})

test("never assumes success when the verdict field is missing", async () => {
  const adapter = new XihulunjianPlatformAdapter("ak_test", (async () =>
    envelope({ unexpected: true })) as unknown as typeof fetch, instant)
  const result = await adapter.submitFlag({
    challenge: {
      slug: "shopping",
      directory: "/tmp/shopping",
      description: "",
      files: [],
      flagFormat: "",
      platform: { adapter: "xihulunjian", challengeID: "10662" },
    },
    workspace: { directory: "/tmp/run", runID: "r1", extracted: [] },
    candidate: "flag{unknown}",
  })
  expect(result.verdict).toBe("pending")
})

test("strips flag wrappers deterministically", () => {
  expect(innerFlagValue("DASCTF{abc}")).toBe("abc")
  expect(innerFlagValue("flag{a b}")).toBe("a b")
  expect(innerFlagValue("  bare_value  ")).toBe("bare_value")
  // A nested closing brace must not truncate the payload.
  expect(innerFlagValue("DASCTF{a{b}c}")).toBe("a{b}c")
  expect(innerFlagValue("DASCTF{}")).toBe("")
})

test("reads announcement summaries and their full content", async () => {
  const calls: string[] = []
  const adapter = new XihulunjianPlatformAdapter("ak_test", (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(`${url.pathname}${url.search}`)
    if (url.pathname === `${PREFIX}/match/notice/now-list`) return envelope([{
      id: 501,
      title: "题目更新",
      content: "新增一道 Web 题。",
      createdAt: "2026-06-26T10:00:00.000+08:00",
      createdTime: 1780000000000,
      userName: "系统公告",
    }])
    if (url.pathname === `${PREFIX}/match/notice/detail`) return envelope({
      id: 501,
      title: "题目更新",
      content: "新增一道 Web 题，附件见下方。",
      isFile: true,
      file: { files: [{ name: "notice.pdf", url: "https://example.com/notice.pdf", ext: "pdf" }] },
      createdTime: 1780000000000,
    })
    return Response.json({ code: "40400" }, { status: 404 })
  }) as typeof fetch, instant)

  await expect(adapter.notices()).resolves.toEqual([{
    id: 501,
    title: "题目更新",
    content: "新增一道 Web 题。",
    createdAt: "2026-06-26T10:00:00.000+08:00",
    createdTime: 1780000000000,
    userName: "系统公告",
  }])
  await expect(adapter.noticeDetail(501)).resolves.toEqual({
    id: 501,
    title: "题目更新",
    content: "新增一道 Web 题，附件见下方。",
    isFile: true,
    files: [{ name: "notice.pdf", url: "https://example.com/notice.pdf", ext: "pdf" }],
    createdTime: 1780000000000,
  })
  expect(calls).toEqual([
    `${PREFIX}/match/notice/now-list`,
    `${PREFIX}/match/notice/detail?id=501`,
  ])
})

test("uses the configured platform root for read-only dashboard calls", async () => {
  let requested = ""
  const adapter = new XihulunjianPlatformAdapter("ak_test", (async (input) => {
    requested = input instanceof Request ? input.url : String(input)
    return envelope({ stagePoint: 200, stageRank: 3 })
  }) as typeof fetch, instant, "https://contest.example.test/agent/")

  await expect(adapter.overview()).resolves.toEqual({ point: 200, rank: 3 })
  expect(requested).toBe("https://contest.example.test/agent/slab-match/api/v1/agent/answer-panel/overview")
})

test("prefers a proxied endpoint and records the full connection matrix", () => {
  const endpoint = selectEndpoint([{
    exposeIps: ["10.0.0.10"],
    ports: ["80", "22"],
    users: [{ username: "root", password: "password" }],
    portMappings: [{ type: "tcp", port: "80", proxy: "30080" }],
    proxyIps: ["1.2.3.4"],
    isProxy: true,
    expireTime: 1780000000000,
  }])
  expect(endpoint?.remote).toBe("1.2.3.4:30080")
  // Extra ports and credentials stay available to the solver through the README.
  expect(endpoint?.detail).toContain("账号：root / 密码：password")
  expect(endpoint?.detail).toContain("80, 22")
  expect(selectEndpoint([])).toBeUndefined()
})
