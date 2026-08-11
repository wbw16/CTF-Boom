import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DasctfPracticePlatformAdapter } from "../src/dasctf-platform-adapter.ts"
import { DeclarativeHttpPlatformAdapter } from "../src/http-platform-adapter.ts"
import { adaptOpenApiDocument } from "../src/platform-openapi.ts"

const TOKEN_ENV = "BOOM_PLATFORM_TEST_CTF_TOKEN"
const DASCTF_TOKEN_ENV = "BOOM_PLATFORM_DASCTF_TOKEN"
const roots: string[] = []

afterEach(async () => {
  delete process.env[TOKEN_ENV]
  delete process.env[DASCTF_TOKEN_ENV]
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function apiDocument(baseURL: string) {
  const challenge = {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      description: { type: "string" },
      category: { type: "string" },
      files: { type: "array", items: { type: "string" } },
    },
  }
  return {
    openapi: "3.0.3",
    info: { title: "Test CTF", version: "1" },
    servers: [{ url: baseURL }],
    components: {
      securitySchemes: {
        token: { type: "apiKey", in: "header", name: "X-CTF-Token" },
      },
      schemas: { Challenge: challenge },
    },
    paths: {
      "/challenges": {
        get: {
          operationId: "listChallenges",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { type: "array", items: { $ref: "#/components/schemas/Challenge" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/challenges/{challenge_id}": {
        get: {
          operationId: "getChallenge",
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/Challenge" } },
                  },
                },
              },
            },
          },
        },
      },
      "/challenges/attempt": {
        post: {
          operationId: "submitFlagAttempt",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["challenge_id", "submission"],
                  properties: {
                    challenge_id: { type: "integer" },
                    submission: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "object",
                        properties: {
                          status: { type: "string" },
                          message: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }
}

describe("declarative HTTP platform adapter", () => {
  test("downloads challenges and submits flags without copying credentials into the challenge", async () => {
    const calls: Array<{ path: string; token: string | null; body?: unknown }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const token = request.headers.get("X-CTF-Token")
        const body = request.method === "POST" ? await request.json() : undefined
        calls.push({ path: url.pathname, token, ...(body === undefined ? {} : { body }) })
        if (token !== "top-secret") return Response.json({ error: "unauthorized" }, { status: 401 })
        if (url.pathname === "/api/challenges")
          return Response.json({ data: [{ id: 7, name: "web-warmup", category: "WEB" }] })
        if (url.pathname === "/api/challenges/7")
          return Response.json({ data: {
            id: 7,
            name: "web-warmup",
            category: "WEB",
            description: "Find the hidden value.",
            files: ["/files/input.txt"],
          } })
        if (url.pathname === "/files/input.txt") return new Response("evidence")
        if (url.pathname === "/api/challenges/attempt") {
          const candidate = (body as { submission?: string })?.submission
          return Response.json({ data: {
            status: candidate === "flag{ok}" ? "correct" : "incorrect",
            message: candidate === "flag{ok}" ? "solved" : "try again",
          } })
        }
        return new Response("missing", { status: 404 })
      },
    })
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-platform-"))
    roots.push(root)
    process.env[TOKEN_ENV] = "top-secret"
    try {
      const adapted = adaptOpenApiDocument(apiDocument(`http://127.0.0.1:${server.port}/api`), { id: "test-ctf" })
      expect(adapted.manifest.status).toBe("ready")
      expect(adapted.warnings).toEqual([])
      const adapter = new DeclarativeHttpPlatformAdapter(adapted.manifest)

      const challenges = await adapter.acquireChallenges({ root })
      expect(challenges).toHaveLength(1)
      expect(challenges[0]).toMatchObject({
        slug: "web-warmup",
        category: "WEB",
        description: "# web-warmup\n\nFind the hidden value.",
        files: ["input.txt"],
        platform: { adapter: "test-ctf", challengeID: "7" },
      })
      expect(await readFile(path.join(root, "challenges", "WEB", "web-warmup", "files", "input.txt"), "utf8"))
        .toBe("evidence")
      const serialized = [
        await readFile(path.join(root, "challenges", "WEB", "web-warmup", "README.md"), "utf8"),
        await readFile(path.join(root, "challenges", "WEB", "web-warmup", "meta.json"), "utf8"),
      ].join("\n")
      expect(serialized).not.toContain("top-secret")

      const result = await adapter.submitFlag({
        root,
        challenge: challenges[0]!,
        workspace: { directory: path.join(root, "runs", "web-warmup", "one"), runID: "one", extracted: [] },
        candidate: "flag{ok}",
      })
      expect(result).toMatchObject({ adapter: "test-ctf", verdict: "accepted", detail: "solved" })
      expect(calls.every((call) => call.token === "top-secret")).toBe(true)
      expect(calls.at(-1)?.body).toEqual({ challenge_id: "7", submission: "flag{ok}" })
    } finally {
      server.stop(true)
    }
  })

  test("refuses to execute a generated draft", () => {
    const adapted = adaptOpenApiDocument({
      ...apiDocument("https://ctf.example"),
      paths: {
        ...(apiDocument("https://ctf.example").paths as object),
        "/challenges/attempt": {
          post: {
            operationId: "submitFlag",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["team_id"],
                    properties: { team_id: { type: "string" } },
                  },
                },
              },
            },
            responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
          },
        },
      },
    }, { id: "test-ctf" })
    expect(adapted.manifest.status).toBe("draft")
    expect(() => new DeclarativeHttpPlatformAdapter(adapted.manifest)).toThrow("still a draft")
  })

  test("adapts DASCTF practice catalog for selective sync and confirmed flag submission", async () => {
    const calls: Array<{ path: string; authorization: string | null; body?: unknown }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const authorization = request.headers.get("Authorization")
        const body = request.method === "POST" ? await request.json() : undefined
        calls.push({ path: url.pathname, authorization, ...(body === undefined ? {} : { body }) })
        if (url.pathname === "/api/v1/public/practice/challenges/") {
          return Response.json({ success: true, data: {
            data: [
              {
                challenge: { id: "ch-1", friendly_id: "one", name: "One", category: "WEB", points: 10 },
                practice_ground: { id: "ground-1", name: "Public Ground" },
              },
              {
                challenge: { id: "ch-2", friendly_id: "two", name: "Two", category: "PWN", points: 20 },
                practice_ground: { id: "ground-1", name: "Public Ground" },
              },
            ],
            page: 1,
            page_size: 50,
            total: 2,
            facets: { categories: ["WEB", "PWN"], difficulties: ["Easy"] },
          } })
        }
        if (authorization !== "Bearer das-secret")
          return Response.json({ success: false, error: { code: "AUTH_REQUIRED" } }, { status: 401 })
        if (url.pathname === "/api/open/v1/user/practice/ground-1/challenges/ch-2/")
          return Response.json({ success: true, data: {
            id: "ch-2",
            friendly_id: "two",
            name: "Two",
            description: "Only this challenge should be synchronized.",
            files: [{ file_name: "input.bin", download_url: "/files/ch-2.bin" }],
          } })
        if (url.pathname === "/files/ch-2.bin") return new Response("das evidence")
        if (url.pathname === "/api/open/v1/user/practice/ground-1/challenges/ch-2/submit/")
          return Response.json({ success: true, data: {
            accepted: (body as { flag?: string })?.flag === "flag{das}",
            submission_id: "sub-1",
          } })
        return Response.json({ error: "missing" }, { status: 404 })
      },
    })
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-dasctf-"))
    roots.push(root)
    process.env[DASCTF_TOKEN_ENV] = "das-secret"
    try {
      const adapted = adaptOpenApiDocument({
        openapi: "3.1.0",
        info: { title: "CTF2 User Open API", version: "1.0.0" },
        servers: [{ url: `http://127.0.0.1:${server.port}` }],
        components: { securitySchemes: {
          BearerToken: { type: "http", scheme: "bearer" },
        } },
        paths: {
          "/api/open/v1/user/practice/": { get: { responses: { "200": { description: "ok" } } } },
          "/api/open/v1/user/practice/{id}/challenges/{challengeId}/": {
            get: { responses: { "200": { description: "ok" } } },
          },
          "/api/open/v1/user/practice/{id}/challenges/{challengeId}/submit/": {
            post: { responses: { "200": { description: "ok" } } },
          },
        },
      }, { id: "dasctf" })
      expect(adapted.manifest).toMatchObject({
        profile: "dasctf-practice-v1",
        status: "ready",
        auth: { env: DASCTF_TOKEN_ENV, name: "Authorization", prefix: "Bearer " },
        operations: { submitFlag: { request: { body: { confirmation: true, flag: "{{flag}}" } } } },
      })
      const adapter = new DasctfPracticePlatformAdapter(adapted.manifest)
      expect(await adapter.listChallenges({ root, query: { page: 1, pageSize: 50 } })).toMatchObject({
        total: 2,
        categories: ["WEB", "PWN"],
        items: [
          { id: "ground-1:ch-1", challengeID: "ch-1", title: "One", group: { name: "Public Ground" } },
          { id: "ground-1:ch-2", challengeID: "ch-2", title: "Two", group: { name: "Public Ground" } },
        ],
      })
      const synchronized = await adapter.acquireChallenges({
        root,
        selection: { ids: ["ground-1:ch-2"] },
      })
      expect(synchronized).toHaveLength(1)
      expect(synchronized[0]).toMatchObject({
        slug: "two",
        category: "PWN",
        platform: {
          adapter: "dasctf",
          challengeID: "ch-2",
          options: { practice_ground_id: "ground-1" },
        },
      })
      expect(await readFile(path.join(root, "challenges", "PWN", "two", "files", "input.bin"), "utf8"))
        .toBe("das evidence")
      expect(calls.some((call) => call.path.includes("ch-1") && call.path !== "/api/v1/public/practice/challenges/"))
        .toBe(false)
      expect(await adapter.submitFlag({
        root,
        challenge: synchronized[0]!,
        workspace: { directory: path.join(root, "runs", "two", "one"), runID: "one", extracted: [] },
        candidate: "flag{das}",
      })).toMatchObject({ verdict: "accepted" })
      expect(calls.at(-1)?.body).toEqual({ flag: "flag{das}", confirmation: true })
    } finally {
      server.stop(true)
    }
  })
})
