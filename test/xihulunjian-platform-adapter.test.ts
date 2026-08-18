import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { xihulunjianAdaptation } from "../src/platform-openapi.ts"
import {
  innerFlagValue,
  selectEndpoint,
  XihulunjianPlatformAdapter,
} from "../src/xihulunjian-platform-adapter.ts"

const TOKEN_ENV = "BOOM_PLATFORM_XIHU_TOKEN"
const HOST = "https://pro.example.com"
const PREFIX = "/slab-match/api/v1/agent"
const roots: string[] = []

afterEach(async () => {
  delete process.env[TOKEN_ENV]
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function manifest() {
  return xihulunjianAdaptation({ id: "xihu", baseURL: HOST }).manifest
}

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

test("flattens the nested category/corpus catalog and skips unreleased challenges", async () => {
  process.env[TOKEN_ENV] = "ak_test"
  const seen: string[] = []
  const adapter = new XihulunjianPlatformAdapter(manifest(), (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    seen.push(url.pathname)
    expect((input as Request).headers?.get?.("X-Agent-AccessKey") ?? "ak_test").toBe("ak_test")
    if (url.pathname === `${PREFIX}/ctf/exercise-list`) return envelope(EXERCISE_LIST)
    return Response.json({ code: "40400", message: "not found" }, { status: 404 })
  }) as typeof fetch, instant)

  const catalog = await adapter.listChallenges({ root: "/tmp" })
  expect(catalog.total).toBe(2)
  expect(catalog.categories).toEqual(["Web", "Pwn"])
  expect(catalog.items.map((item) => item.id)).toEqual(["10661", "10662"])
  expect(catalog.items[0]).toMatchObject({
    challengeID: "10661",
    title: "web-unserialize-1-3",
    category: "Web",
    solved: false,
    group: { id: "3109", name: "Web" },
  })
  expect(seen).toEqual([`${PREFIX}/ctf/exercise-list`])
})

test("treats a non-zero business code as a failure even on HTTP 200", async () => {
  process.env[TOKEN_ENV] = "ak_test"
  const adapter = new XihulunjianPlatformAdapter(manifest(), (async () =>
    // HTTP 200 with a business failure must not be mistaken for empty data.
    envelope({}, "40003", "AccessKey 无效")) as unknown as typeof fetch, instant)
  await expect(adapter.listChallenges({ root: "/tmp" })).rejects.toThrow(/40003.*AccessKey 无效/)
})

test("retries platform rate limiting and then succeeds", async () => {
  process.env[TOKEN_ENV] = "ak_test"
  let attempts = 0
  const adapter = new XihulunjianPlatformAdapter(manifest(), (async () => {
    attempts += 1
    // Verified live: bursts return HTTP 429 with business code 40001.
    if (attempts < 3)
      return Response.json({ data: {}, code: "40001", message: "请求过于频繁，请稍后重试" }, { status: 429 })
    return envelope(EXERCISE_LIST)
  }) as unknown as typeof fetch, instant)

  const catalog = await adapter.listChallenges({ root: "/tmp" })
  expect(attempts).toBe(3)
  expect(catalog.total).toBe(2)
})

test("accepts both attachment shapes and marks local-only challenges", async () => {
  process.env[TOKEN_ENV] = "ak_test"
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
  const adapter = new XihulunjianPlatformAdapter(manifest(), (async (input) => {
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
  process.env[TOKEN_ENV] = "ak_secret"
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-xihu-"))
  roots.push(root)
  const calls: string[] = []
  let cdnAuthHeader: string | null = "unset"

  const adapter = new XihulunjianPlatformAdapter(manifest(), (async (input, init) => {
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

  const challenges = await adapter.acquireChallenges({ root, selection: { all: true } })
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
    platform: { adapter: "xihu", challenge_id: "10662", options: { exercise_id: "10662", score: 50 } },
  })
  expect(await readFile(path.join(root, "challenges", "PWN", "shopping", "files", "a.zip")))
    .toEqual(Buffer.from([1, 2, 3]))
})

test("builds, polls, and reports a ready environment", async () => {
  process.env[TOKEN_ENV] = "ak_test"
  const calls: string[] = []
  let polls = 0
  const adapter = new XihulunjianPlatformAdapter(manifest(), (async (input, init) => {
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
  process.env[TOKEN_ENV] = "ak_test"
  const bodies: unknown[] = []
  const adapter = new XihulunjianPlatformAdapter(manifest(), (async (input, init) => {
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
    platform: { adapter: "xihu", challengeID: "10662" },
  }
  const result = await adapter.submitFlag({
    root: "/tmp",
    challenge,
    workspace: { directory: "/tmp/run", runID: "r1", extracted: [] },
    candidate: "DASCTF{p0p_cha1n}",
  })
  expect(result).toMatchObject({ adapter: "xihu", verdict: "accepted" })
  // The rules require submitting only the contents of the braces.
  expect(bodies[0]).toEqual({ exerciseId: 10662, flag: "p0p_cha1n" })
})

test("maps an explicit incorrect verdict to rejected", async () => {
  process.env[TOKEN_ENV] = "ak_test"
  const adapter = new XihulunjianPlatformAdapter(manifest(), (async () =>
    envelope({ isCorrect: false })) as unknown as typeof fetch, instant)
  const result = await adapter.submitFlag({
    root: "/tmp",
    challenge: {
      slug: "shopping",
      directory: "/tmp/shopping",
      description: "",
      files: [],
      flagFormat: "",
      platform: { adapter: "xihu", challengeID: "10662" },
    },
    workspace: { directory: "/tmp/run", runID: "r1", extracted: [] },
    candidate: "flag{wrong}",
  })
  expect(result.verdict).toBe("rejected")
})

test("never assumes success when the verdict field is missing", async () => {
  process.env[TOKEN_ENV] = "ak_test"
  const adapter = new XihulunjianPlatformAdapter(manifest(), (async () =>
    envelope({ unexpected: true })) as unknown as typeof fetch, instant)
  const result = await adapter.submitFlag({
    root: "/tmp",
    challenge: {
      slug: "shopping",
      directory: "/tmp/shopping",
      description: "",
      files: [],
      flagFormat: "",
      platform: { adapter: "xihu", challengeID: "10662" },
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
