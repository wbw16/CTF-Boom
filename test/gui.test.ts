import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mergeTransient, startGuiServer, type GuiRunnerBackend } from "../src/gui.ts"
import type { RunHistory } from "../src/history.ts"
import { GuiRunner, type McpServerDetails } from "../src/runner.ts"

type Harness = Awaited<ReturnType<typeof harness>>

async function exists(target: string) {
  return (await stat(target).catch(() => undefined)) !== undefined
}

async function harness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-gui-api-"))
  const root = path.join(directory, "ctf")
  const challenge = path.join(root, "challenges", "alpha")
  const runID = "20260729T010203Z-test"
  const run = path.join(root, "runs", "alpha", runID)
  await mkdir(path.join(run, "work"), { recursive: true })
  await mkdir(challenge, { recursive: true })
  await writeFile(path.join(challenge, "README.md"), "Recover the flag")
  await writeFile(path.join(challenge, "payload.txt"), "payload")
  await writeFile(path.join(challenge, "meta.json"), JSON.stringify({
    service_required: true,
    custom_field: "preserved",
  }))
  await writeFile(path.join(run, "NOTES.md"), "durable note")
  await writeFile(path.join(run, "work", "artifact.txt"), "artifact")
  await writeFile(
    path.join(run, "result.json"),
    JSON.stringify({
      run_id: runID,
      model: "free/test",
      stop: "completed",
      tokens: 7,
      cost: 0,
      candidates: ["flag{alpha}"],
      flag_format: "flag\\{[^}]*\\}",
      reply: "done",
    }),
  )

  const previousHome = process.env.BOOM_HOME
  process.env.BOOM_HOME = path.join(directory, "home")
  let subscribed: ((notification: unknown) => void) | undefined
  const enqueued: unknown[] = []
  const stops: Array<string | undefined> = []
  const concurrencyChanges: number[] = []
  let schedulerConcurrency = 1
  const providerChanges: Array<{ action: string; value?: unknown }> = []
  const mcpChanges: Array<{ action: string; value?: unknown }> = []
  const envSwitches: Array<{
    slug: string
    profileId: string
    executionMode: string
  }> = []
  let armorPrompts = [
    { id: "general", name: "General", prompt: "PINNED FIRST" },
  ]
  const provider = {
    id: "openai",
    name: "OpenAI",
    connected: true,
    configured: true,
    custom: false,
    disabled: false,
    modelCount: 1,
    visibleModelCount: 1,
    authMethods: [{ type: "api" as const, label: "API Key", index: 0 }],
    npm: "@ai-sdk/openai",
    models: [
      {
        id: "gpt-test",
        name: "GPT Test",
        context: 128_000,
        output: 16_384,
        reasoning: true,
        attachment: true,
        armorPrompt: "general",
        enabled: true,
        source: "catalog" as const,
      },
    ],
  }
  let mcpServers: McpServerDetails[] = [{
    id: "example",
    name: "Example MCP",
    type: "remote" as const,
    enabled: false,
    timeout: 5_000,
    agents: ["boom"],
    url: "https://example.test/mcp",
    headers: {},
    oauth: false as const,
    runtime: { status: "disabled" },
  }]
  const runner = {
    setRoot() {},
    setConcurrency(value: number) {
      schedulerConcurrency = value
      concurrencyChanges.push(value)
      return value
    },
    async applyLiveModelSettings() {
      return { active: 0, queued: 0, warnings: [] }
    },
    hasWork: () => false,
    getRuntimeState: () => ({
      status: "ready",
      active: 0,
      queued: 0,
      concurrency: schedulerConcurrency,
    }),
    subscribe(listener: (notification: unknown) => void) {
      subscribed = listener
      return () => {
        subscribed = undefined
      }
    },
    getModels: async () => [{ id: "free/test", name: "Test Model", connected: true }],
    getProviders: async () => [provider],
    getProvider: async () => provider,
    getArmorPrompts: async () => armorPrompts,
    saveArmorPrompts: async (value: typeof armorPrompts) => {
      armorPrompts = value
      providerChanges.push({ action: "armor-prompts", value })
      return armorPrompts
    },
    saveProvider: async (value: unknown, apiKey?: string) => {
      providerChanges.push({
        action: "save",
        value: { provider: value, credentialSupplied: !!apiKey },
      })
      return provider
    },
    startProviderOAuth: async (id: string, method: number) => ({
      url: "https://example.test/oauth",
      method: "code" as const,
      instructions: `${id}:${method}`,
    }),
    completeProviderOAuth: async (
      id: string,
      method: number,
      code?: string,
    ) => {
      providerChanges.push({
        action: "oauth",
        value: { id, method, codeSupplied: !!code },
      })
      return provider
    },
    deleteProvider: async (id: string) => {
      providerChanges.push({ action: "delete", value: id })
    },
    removeProviderCredential: async (id: string) => {
      providerChanges.push({ action: "credential", value: id })
    },
    importOpenCodeProviderCredentials: async () => {
      providerChanges.push({ action: "import-opencode-credentials" })
      return {
        source: "/tmp/opencode/auth.json",
        imported: [
          { id: "openai", type: "oauth" as const },
          { id: "deepseek", type: "api" as const },
        ],
        skipped: 1,
      }
    },
    getMcpServers: async () => mcpServers,
    saveMcpServer: async (server: typeof mcpServers[number]) => {
      const saved = { ...server, runtime: { status: server.enabled ? "connected" as const : "disabled" as const } }
      mcpServers = [saved]
      mcpChanges.push({ action: "save", value: server })
      return saved
    },
    deleteMcpServer: async (id: string) => {
      mcpServers = mcpServers.filter(server => server.id !== id)
      mcpChanges.push({ action: "delete", value: id })
    },
    testMcpServer: async (id: string) => {
      mcpChanges.push({ action: "test", value: id })
      return { status: "connected" as const }
    },
    startMcpOAuth: async (id: string) => {
      mcpChanges.push({ action: "oauth-start", value: id })
      return { authorizationUrl: "https://example.test/oauth" }
    },
    completeMcpOAuth: async (id: string, code: string) => {
      mcpChanges.push({ action: "oauth-complete", value: { id, code } })
      return { status: "connected" as const }
    },
    removeMcpOAuth: async (id: string) => {
      mcpChanges.push({ action: "oauth-remove", value: id })
    },
    enqueue: async (input: { challenges: Array<{ slug: string }>; models?: Record<string, string> }) => {
      enqueued.push(input)
      return input.challenges.map((item) => ({
        slug: item.slug,
        id: `queued-${item.slug}`,
        model: input.models?.[item.slug] ?? "free/test",
      }))
    },
    stop: (slug?: string) => {
      stops.push(slug)
      return 1
    },
    getTransientRuns: () => [],
    switchTaskEnvironment: (input: {
      slug: string
      profileId: string
      executionMode: "managed" | "isolated" | "static-only"
    }) => {
      envSwitches.push(input)
      return { queued: 0, active: 0 }
    },
    ensureRuntime: async () => {
      throw new Error("the injected test runner must never start a runtime")
    },
    close: async () => {},
  } as unknown as GuiRunnerBackend
  const started = await startGuiServer({
    root,
    hostname: "127.0.0.1",
    port: 0,
    open: false,
    runner,
    startRuntime: false,
  })

  return {
    directory,
    root,
    challenge,
    run,
    runID,
    started,
    enqueued,
    stops,
    concurrencyChanges,
    providerChanges,
    mcpChanges,
    envSwitches,
    notify(value: unknown) {
      subscribed?.(value)
    },
    async close() {
      await started.close()
      if (previousHome === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function endpoint(one: Harness, pathname: string) {
  return new URL(pathname, one.started.url).toString()
}

async function request(
  one: Harness,
  pathname: string,
  method = "GET",
  value?: Record<string, unknown>,
) {
  return fetch(endpoint(one, pathname), {
    method,
    ...(value === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        }),
  })
}

describe("GUI HTTP surface", () => {
  test("returns fallback state immediately without starting the runtime from /api/state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-gui-starting-"))
    const root = path.join(directory, "ctf")
    await Promise.all([
      mkdir(path.join(root, "challenges"), { recursive: true }),
      mkdir(path.join(root, "runs"), { recursive: true }),
    ])
    let launches = 0
    const runner = new GuiRunner(root, async () => {
      launches += 1
      throw new Error("state reads must not launch the runtime")
    })
    const started = await startGuiServer({
      root,
      hostname: "127.0.0.1",
      port: 0,
      open: false,
      runner,
      startRuntime: false,
    })
    try {
      const response = await fetch(new URL("/api/state", started.url))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        runtime: { status: "starting" },
        models: [{ id: "free/deepseek-v4-flash-free", connected: true }],
      })
      expect(launches).toBe(0)
    } finally {
      await started.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("binds and explicitly switches a finished task to a selected Python profile", async () => {
    const one = await harness()
    try {
      const interpreter = Bun.which("python3")
      if (!interpreter) return
      const added = await request(one, "/api/environments", "POST", {
        interpreter,
        displayName: "GUI test Python",
        makeDefault: true,
      })
      expect(added.status).toBe(201)
      const profile = (await added.json() as { profile: { id: string } }).profile
      const switched = await request(one, "/api/environments/task", "PATCH", {
        slug: "alpha",
        runID: one.runID,
        profileId: profile.id,
        executionMode: "static-only",
      })
      expect(switched.status).toBe(200)
      expect(await switched.json()).toMatchObject({
        environment: { profileId: profile.id, source: "task-override", executionMode: "static-only" },
        switches: { queued: 0, active: 0 },
      })
      expect(one.envSwitches).toEqual([{
        slug: "alpha",
        profileId: profile.id,
        executionMode: "static-only",
      }])
      expect(await readFile(path.join(one.run, "work", ".boom", "environment.json"), "utf8"))
        .toContain('"executionMode": "static-only"')
      expect(await readFile(path.join(one.run, "work", "events.jsonl"), "utf8"))
        .toContain("environment-switched")
    } finally {
      await one.close()
    }
  })

  test("serves the current GUI, state snapshot, and lifecycle patch without a real runtime", async () => {
    const one = await harness()
    try {
      const page = await request(one, "/")
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toContain("text/html")
      expect(page.headers.get("content-security-policy")).toContain("default-src 'self'")
      const html = await page.text()
      expect(html).toContain('<div id="root"></div>')
      expect(html).toContain('type="module"')
      expect(html).not.toContain('id="consultModels"')
      const asset = /\/assets\/index-[^"]+\.js/.exec(html)?.[0]
      expect(asset).toBeTruthy()
      const script = await request(one, asset ?? "/assets/missing.js")
      expect(script.status).toBe(200)
      expect(script.headers.get("content-type")).toContain("javascript")
      const client = await script.text()
      expect(client).toContain("/api/events")
      expect(client).toContain("由 Boom 提交槽接收")
      expect(client).not.toContain("startCheckpoint")
      expect(client).toContain("startConsultation")
      expect(client).toContain("reviewFlag")
      expect(client).toContain("candidateHistory")
      expect(client).toContain("/api/consultations")
      expect(client).toContain("/api/settings")
      expect(client).toContain("/api/providers")
      expect(client).toContain("从 OpenCode 迁移凭据")
      expect(client).toContain("/api/mcp")
      expect(client).toContain("/api/platforms")
      expect(client).toContain("/api/platforms/adapt")
      expect(client).toContain("/api/armor-prompts")
      expect(client).toContain("Boom Runtime 已应用 Provider 配置并刷新模型目录")

      const before = await request(one, "/api/state")
      expect(before.status).toBe(200)
      const initial = (await before.json()) as {
        runtime: { status: string }
        models: Array<{ id: string }>
        challenges: Array<{
          slug: string
          category: string
          storagePath: string
          remote?: string
          serviceRequired?: boolean
          state?: string
          runs: Array<{ id: string; notes: string; files: Array<{ path: string }> }>
        }>
      }
      expect(initial.runtime.status).toBe("ready")
      expect(initial.models.map((model) => model.id)).toEqual(["free/test"])
      expect(initial.challenges).toHaveLength(1)
      expect(initial.challenges[0]).toMatchObject({
        slug: "alpha",
        category: "OTHER",
        storagePath: "alpha",
        serviceRequired: true,
        runs: [{ id: one.runID, notes: "", files: [] }],
      })
      const detail = await request(
        one,
        `/api/challenges/alpha/runs/${encodeURIComponent(one.runID)}`,
      )
      expect(detail.status).toBe(200)
      const detailed = (await detail.json()) as {
        run: { notes: string; files: Array<{ path: string }> }
      }
      expect(detailed.run.notes).toBe("durable note")
      expect(detailed.run.files.map((file) => file.path)).toContain(
        "work/artifact.txt",
      )

      const providers = await request(one, "/api/providers")
      expect(providers.status).toBe(200)
      expect(await providers.json()).toMatchObject({
        providers: [{ id: "openai", connected: true }],
      })
      const migration = await request(
        one,
        "/api/providers/import-opencode-credentials",
        "POST",
        {},
      )
      expect(await migration.json()).toMatchObject({
        migration: {
          imported: [
            { id: "openai", type: "oauth" },
            { id: "deepseek", type: "api" },
          ],
          skipped: 1,
        },
      })
      expect(one.providerChanges).toContainEqual({ action: "import-opencode-credentials" })
      expect(
        await (await request(one, "/api/providers/openai")).json(),
      ).toMatchObject({ provider: { id: "openai", models: [{ id: "gpt-test" }] } })
      expect(
        await request(one, "/api/providers/openai/models", "POST", {
          provider: { id: "openai", custom: false, disabled: false, models: [], hiddenModels: [] },
        }),
      ).toMatchObject({ status: 404 })
      expect(await (await request(one, "/api/armor-prompts")).json()).toEqual({
        prompts: [
          { id: "general", name: "General", prompt: "PINNED FIRST" },
        ],
      })
      const promptsSaved = await request(one, "/api/armor-prompts", "PUT", {
        prompts: [
          { id: "special", name: "Special", prompt: "SPECIAL FIRST" },
        ],
      })
      expect(promptsSaved.status).toBe(200)
      expect(await promptsSaved.json()).toEqual({
        prompts: [
          { id: "special", name: "Special", prompt: "SPECIAL FIRST" },
        ],
      })
      const providerSaved = await request(
        one,
        "/api/providers/openai",
        "PUT",
        {
          provider: {
            id: "openai",
            custom: false,
            disabled: false,
            name: "OpenAI",
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                context: 128_000,
                output: 16_384,
                reasoning: true,
                attachment: true,
                armorPrompt: "special",
              },
            ],
            hiddenModels: ["gpt-old"],
          },
          apiKey: "secret-never-returned",
        },
      )
      expect(providerSaved.status).toBe(200)
      expect(JSON.stringify(await providerSaved.json())).not.toContain(
        "secret-never-returned",
      )
      expect(one.providerChanges.find(change => change.action === "save")).toMatchObject({
        action: "save",
        value: {
          credentialSupplied: true,
          provider: { models: [{ armorPrompt: "special" }] },
        },
      })
      expect(
        await request(one, "/api/providers/openai/credential", "DELETE"),
      ).toMatchObject({ status: 200 })

      expect(await (await request(one, "/api/mcp")).json()).toMatchObject({
        servers: [{ id: "example", runtime: { status: "disabled" } }],
      })
      const mcpSaved = await request(one, "/api/mcp/example", "PUT", {
        server: {
          id: "example",
          name: "Example MCP",
          type: "remote",
          enabled: true,
          timeout: 5_000,
          agents: ["boom"],
          url: "https://example.test/mcp",
          headers: {},
          oauth: false,
        },
      })
      expect(mcpSaved.status).toBe(200)
      expect(await mcpSaved.json()).toMatchObject({
        server: { id: "example", runtime: { status: "connected" } },
      })
      expect(await request(one, "/api/mcp/example/test", "POST", {})).toMatchObject({ status: 200 })
      expect(one.mcpChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "save" }),
        { action: "test", value: "example" },
      ]))

      const patch = await request(one, "/api/challenges/alpha", "PATCH", {
        state: "given-up",
      })
      expect(patch.status).toBe(200)
      const after = (await (await request(one, "/api/state")).json()) as {
        challenges: Array<{ slug: string; state?: string }>
      }
      expect(after.challenges[0]).toMatchObject({
        slug: "alpha",
        state: "given-up",
      })

      const endpointResponse = await request(one, "/api/challenges/alpha", "PATCH", {
        remote: "  https://target.example:8443/instance/1  ",
      })
      expect(endpointResponse.status).toBe(200)
      expect(await endpointResponse.json()).toEqual({
        ok: true,
        remote: "https://target.example:8443/instance/1",
      })
      const endpointState = (await (await request(one, "/api/state")).json()) as {
        challenges: Array<{ slug: string; remote?: string; serviceRequired?: boolean }>
      }
      expect(endpointState.challenges[0]).toMatchObject({
        slug: "alpha",
        remote: "https://target.example:8443/instance/1",
        serviceRequired: true,
      })
      expect(JSON.parse(await readFile(path.join(one.root, "challenges", "alpha", "meta.json"), "utf8")))
        .toEqual({
          service_required: true,
          custom_field: "preserved",
          remote: "https://target.example:8443/instance/1",
        })

      expect(await request(one, "/api/challenges/alpha", "PATCH", {
        remote: "bad\nendpoint",
      })).toMatchObject({ status: 400 })
      const clearedEndpoint = await request(one, "/api/challenges/alpha", "PATCH", { remote: null })
      expect(clearedEndpoint.status).toBe(200)
      expect(await clearedEndpoint.json()).toEqual({ ok: true, remote: null })
      expect(JSON.parse(await readFile(path.join(one.root, "challenges", "alpha", "meta.json"), "utf8")))
        .toEqual({ service_required: true, custom_field: "preserved" })

      const settings = await request(one, "/api/settings", "PATCH", {
        economyModel: "free/economy",
        strongModel: "free/strong",
        tokens: 2_000,
        repeats: 3,
        minutes: 2,
        concurrency: 2,
        flagFormat: "",
        consultModels: ["free/expert-a", "free/expert-b"],
        blindReview: false,
        consultOnCompaction: false,
      })
      expect(settings.status).toBe(200)
      expect(await settings.json()).toMatchObject({
        settings: {
          economyModel: "free/economy",
          strongModel: "free/strong",
          tokens: 2_000,
          minutes: 2,
          consultModels: ["free/expert-a", "free/expert-b"],
          blindReview: false,
          consultOnCompaction: false,
        },
      })

      const queued = await request(one, "/api/runs", "POST", {
        slugs: ["alpha"],
        hint: "continue from NOTES",
        runIDs: { alpha: one.runID },
      })
      expect(queued.status).toBe(202)
      expect(await queued.json()).toEqual({
        queued: [{ slug: "alpha", id: "queued-alpha", model: "free/strong" }],
      })
      expect(one.enqueued[0]).toMatchObject({
        model: "free/strong",
        models: { alpha: "free/strong" },
        modelPolicy: { economy: "free/economy", strong: "free/strong" },
        consultModels: ["free/expert-a", "free/expert-b"],
        blindReview: false,
        consultOnCompaction: false,
        limits: { tokens: 2_000, repeats: 3, timeout: 120_000 },
        flagFormat: "",
        hint: "continue from NOTES",
      })
      expect(one.enqueued[0]).not.toHaveProperty("concurrency")
      expect(one.enqueued[0]).not.toHaveProperty("checkpoints")
      expect(one.concurrencyChanges).toEqual([1, 2])

      const manualConsultation = await request(one, "/api/consultations", "POST", {
        slug: "alpha",
        sourceRunID: one.runID,
        expertModels: ["free/expert-a", "free/expert-b"],
      })
      expect(manualConsultation.status).toBe(202)
      expect(one.enqueued[1]).toMatchObject({
        model: "free/strong",
        modelPolicy: { economy: "free/economy", strong: "free/strong" },
        consultModels: ["free/expert-a", "free/expert-b"],
        blindReview: false,
        consultOnCompaction: false,
        consultation: {
          trigger: "manual",
          expertModels: ["free/expert-a", "free/expert-b"],
          synthesizerModel: "free/strong",
          sourceRunID: one.runID,
        },
      })
      expect(one.enqueued[1]).not.toHaveProperty("concurrency")
      const stateAfterConsultation = await request(one, "/api/state")
      expect(await stateAfterConsultation.json()).toMatchObject({
        runtime: { concurrency: 2 },
      })

      const stopped = await request(one, "/api/runs/stop", "POST", { slug: "alpha" })
      expect(stopped.status).toBe(200)
      expect(await stopped.json()).toEqual({ stopped: 1 })
      expect(one.stops).toEqual(["alpha"])

      const streamAbort = new AbortController()
      const stream = await fetch(endpoint(one, "/api/events"), { signal: streamAbort.signal })
      expect(stream.headers.get("content-type")).toContain("text/event-stream")
      const packet = await stream.body!.getReader().read()
      expect(new TextDecoder().decode(packet.value)).toContain(": connected")
      streamAbort.abort()

      const crossOrigin = await fetch(endpoint(one, "/api/state"), {
        headers: { Origin: "https://attacker.example" },
      })
      expect(crossOrigin.status).toBe(403)

    } finally {
      await one.close()
    }
  })

  test("imports a local challenge into the selected category directory", async () => {
    const one = await harness()
    const source = path.join(path.dirname(one.root), "incoming", "category-beta")
    try {
      await mkdir(source, { recursive: true })
      await writeFile(path.join(source, "README.md"), "categorized task")

      const imported = await request(one, "/api/challenges/import", "POST", {
        source,
        category: "crypto",
      })

      expect(imported.status).toBe(201)
      expect(await imported.json()).toEqual({ slug: "category-beta", category: "CRYPTO" })
      expect(await exists(path.join(one.root, "challenges", "CRYPTO", "category-beta", "README.md")))
        .toBe(true)
      const state = (await (await request(one, "/api/state")).json()) as {
        challenges: Array<{ slug: string; category: string; storagePath: string }>
      }
      expect(state.challenges).toContainEqual(expect.objectContaining({
        slug: "category-beta",
        category: "CRYPTO",
        storagePath: "CRYPTO/category-beta",
      }))
    } finally {
      await one.close()
    }
  })

  test("adapts and synchronizes a competition API through the GUI", async () => {
    const one = await harness()
    const competition = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/openapi.json") {
          return Response.json({
            openapi: "3.0.3",
            info: { title: "GUI Test CTF", version: "1" },
            servers: [{ url: `${url.origin}/api` }],
            components: {
              schemas: {
                Challenge: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                      name: { type: "string" },
                      category: { type: "string" },
                    description: { type: "string" },
                    files: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
            paths: {
              "/challenges": {
                get: {
                  operationId: "listChallenges",
                  responses: { "200": { content: { "application/json": { schema: {
                    type: "object",
                    properties: { data: { type: "array", items: { $ref: "#/components/schemas/Challenge" } } },
                  } } } } },
                },
              },
              "/challenges/{challenge_id}": {
                get: {
                  operationId: "getChallenge",
                  responses: { "200": { content: { "application/json": { schema: {
                    type: "object",
                    properties: { data: { $ref: "#/components/schemas/Challenge" } },
                  } } } } },
                },
              },
              "/challenges/attempt": {
                post: {
                  operationId: "submitFlagAttempt",
                  requestBody: { content: { "application/json": { schema: {
                    type: "object",
                    required: ["challenge_id", "submission"],
                    properties: {
                      challenge_id: { type: "integer" },
                      submission: { type: "string" },
                    },
                  } } } },
                  responses: { "200": { content: { "application/json": { schema: {
                    type: "object",
                    properties: { data: { type: "object", properties: {
                      status: { type: "string" },
                      message: { type: "string" },
                    } } },
                  } } } } },
                },
              },
            },
          })
        }
        if (url.pathname === "/api/challenges")
          return Response.json({ data: [{ id: 9, name: "gui-beta", category: "WEB" }] })
        if (url.pathname === "/api/challenges/9")
          return Response.json({ data: {
            id: 9,
            name: "gui-beta",
            category: "WEB",
            description: "Downloaded through the GUI.",
            files: ["/files/input.bin"],
          } })
        if (url.pathname === "/files/input.bin") return new Response("gui evidence")
        if (url.pathname === "/api/challenges/attempt")
          return Response.json({ data: { status: "correct", message: "ok" } })
        return new Response("missing", { status: 404 })
      },
    })
    try {
      expect(await (await request(one, "/api/platforms")).json()).toEqual({ platforms: [] })
      const adapted = await request(one, "/api/platforms/adapt", "POST", {
        id: "gui-ctf",
        document: `http://127.0.0.1:${competition.port}/openapi.json`,
      })
      expect(adapted.status).toBe(201)
      expect(await adapted.json()).toMatchObject({
        manifest: {
          id: "gui-ctf",
          status: "ready",
          operations: { submitFlag: { request: { method: "POST" } } },
        },
        warnings: [],
      })
      expect(await (await request(one, "/api/platforms")).json()).toMatchObject({
        platforms: [{
          id: "gui-ctf",
          status: "ready",
          listChallenges: true,
          acquireChallenges: true,
          submitFlag: true,
        }],
      })
      const inspected = await request(one, "/api/platforms/gui-ctf")
      const manifest = (await inspected.json() as { manifest: Record<string, unknown> }).manifest
      const saved = await request(one, "/api/platforms/gui-ctf", "PUT", {
        manifest: { ...manifest, name: "GUI Updated CTF" },
      })
      expect(saved.status).toBe(200)
      expect(await saved.json()).toMatchObject({ manifest: { name: "GUI Updated CTF" } })

      const catalog = await request(one, "/api/platforms/gui-ctf/catalog", "POST", {
        variables: { game_id: "42" },
        query: { page: 1, pageSize: 50 },
      })
      expect(catalog.status).toBe(200)
      expect(await catalog.json()).toMatchObject({
        adapter: "gui-ctf",
        total: 1,
        items: [{ id: "9", challengeID: "9", title: "gui-beta" }],
      })

      const synced = await request(one, "/api/platforms/gui-ctf/sync", "POST", {
        variables: { game_id: "42" },
        selection: { ids: ["9"] },
      })
      expect(synced.status).toBe(200)
      expect(await synced.json()).toEqual({ adapter: "gui-ctf", challenges: ["gui-beta"] })
      expect(await readFile(path.join(one.root, "challenges", "WEB", "gui-beta", "files", "input.bin"), "utf8"))
        .toBe("gui evidence")
      expect(JSON.parse(await readFile(path.join(one.root, "challenges", "WEB", "gui-beta", "meta.json"), "utf8")))
        .toMatchObject({
          platform: { adapter: "gui-ctf", challenge_id: "9", options: { game_id: "42" } },
        })
      const state = await request(one, "/api/state")
      expect((await state.json() as { challenges: Array<{ slug: string; category: string }> }).challenges)
        .toContainEqual(expect.objectContaining({ slug: "gui-beta", category: "WEB" }))
    } finally {
      competition.stop(true)
      await one.close()
    }
  })

  test("bounds heavy history in snapshots while the live client applies run events incrementally", async () => {
    const one = await harness()
    try {
      await writeFile(
        path.join(one.run, "work", "events.jsonl"),
        `${JSON.stringify({ at: Date.now(), type: "text", text: "x".repeat(200_000) })}\n`,
      )
      await writeFile(
        path.join(one.run, "result.json"),
        JSON.stringify({
          run_id: one.runID,
          model: "free/test",
          stop: "completed",
          tokens: 7,
          cost: 0,
          candidates: [],
          flag_format: "",
          reply: "y".repeat(200_000),
        }),
      )
      const response = await request(one, "/api/state")
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body.length).toBeLessThan(150_000)
      expect(body).toContain("GUI snapshot truncated")
    } finally {
      await one.close()
    }
  })

  test("keeps a refreshed structured candidate while a run is still live", () => {
    const base = {
      id: "run-1",
      model: "free/test",
      stop: "completed",
      tokens: 1,
      billableTokens: 1,
      cost: 0,
      candidates: ["flag{slot}"],
      primaryCandidate: "flag{slot}",
      alternatives: [],
      candidateSource: "submission",
      verification: { level: "offline-derivation", detail: "proof" },
      flagFormat: "",
      reply: "",
      events: [],
      notes: "durable",
      files: [],
    } satisfies RunHistory
    const live = {
      ...base,
      stop: "running",
      candidates: [],
      primaryCandidate: undefined,
      candidateSource: undefined,
      verification: undefined,
      notes: "",
    } satisfies RunHistory

    expect(mergeTransient([base], [live])[0]).toMatchObject({
      stop: "running",
      candidates: ["flag{slot}"],
      primaryCandidate: "flag{slot}",
      candidateSource: "submission",
      verification: { level: "offline-derivation", detail: "proof" },
    })
  })

  test("manually rejects a candidate into the same task, or confirms it outside the workspace", async () => {
    const rejected = await harness()
    try {
      const response = await request(rejected, "/api/flags", "POST", {
        slug: "alpha",
        runID: rejected.runID,
        flag: "flag{alpha}",
        correct: false,
        model: "free/test",
      })
      expect(response.status).toBe(202)
      expect(rejected.enqueued[0]).toMatchObject({
        model: "free/deepseek-v4-flash-free",
        models: { alpha: "free/deepseek-v4-flash-free" },
        modelPolicy: {
          economy: "free/deepseek-v4-flash-free",
          strong: "free/deepseek-v4-flash-free",
        },
        workspaces: { alpha: rejected.runID },
        hint: expect.stringContaining("已人工确认候选 flag"),
      })
      expect(await Bun.file(path.join(rejected.run, "NOTES.md")).text()).toContain(
        "用户已确认错误",
      )
      expect(
        await Bun.file(path.join(rejected.run, "task.json")).text(),
      ).toContain('"status": "paused"')
      await writeFile(
        path.join(rejected.run, "result.json"),
        JSON.stringify({
          run_id: rejected.runID,
          model: "free/test",
          stop: "completed",
          candidates: [],
          reply: "later turn had no candidate",
        }),
      )
      const corrected = await request(rejected, "/api/flags", "POST", {
        slug: "alpha",
        runID: rejected.runID,
        flag: "flag{alpha}",
        correct: true,
      })
      expect(corrected.status).toBe(202)
      expect(JSON.parse(await Bun.file(path.join(rejected.run, "task.json")).text())).toMatchObject({
        status: "solved",
        rejectedFlags: [],
        acceptedFlag: { value: "flag{alpha}" },
      })
    } finally {
      await rejected.close()
    }

    const confirmed = await harness()
    try {
      const response = await request(confirmed, "/api/flags", "POST", {
        slug: "alpha",
        runID: confirmed.runID,
        flag: "flag{alpha}",
        correct: true,
      })
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ ok: true })
      expect(confirmed.enqueued).toHaveLength(0)
      const taskText = await Bun.file(path.join(confirmed.run, "task.json")).text()
      expect(taskText).toContain('"status": "solved"')
      expect(taskText).toContain('"value": "flag{alpha}"')
      const state = (await (await request(confirmed, "/api/state")).json()) as {
        challenges: Array<{ runs: Array<{ acceptedFlag?: string; taskStatus?: string }> }>
      }
      expect(state.challenges[0]!.runs[0]).toMatchObject({
        taskStatus: "solved",
        acceptedFlag: "flag{alpha}",
      })
    } finally {
      await confirmed.close()
    }
  })

  test("starts a separate writeup run only for a task with a confirmed flag", async () => {
    const one = await harness()
    try {
      await writeFile(
        path.join(one.run, "task.json"),
        JSON.stringify({
          version: 1,
          id: one.runID,
          slug: "alpha",
          status: "solved",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          currentModel: "free/test",
          rejectedFlags: [],
          acceptedFlag: {
            value: "flag{alpha}",
            source: "user",
            detail: "confirmed",
            acceptedAt: new Date().toISOString(),
          },
          turns: [],
        }),
      )
      const response = await request(one, "/api/runs/writeup", "POST", {
        slug: "alpha",
        runID: one.runID,
      })
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({ ok: true, queued: [{ slug: "alpha" }] })
      expect(one.enqueued[0]).toMatchObject({
        purpose: "writeup",
        workspaces: { alpha: one.runID },
        hint: expect.stringContaining("flag{alpha}"),
      })

      const missing = await request(one, "/api/runs/writeup", "POST", {
        slug: "alpha",
        runID: "20260729T999999Z-nope",
      })
      expect(missing.status).toBe(404)
    } finally {
      await one.close()
    }
  })

  test("reset removes only run history while confirmed delete removes both directory trees", async () => {
    const one = await harness()
    try {
      const reset = await request(one, "/api/challenges/alpha/runs", "DELETE")
      expect(reset.status).toBe(200)
      expect(await exists(one.challenge)).toBe(true)
      expect(await exists(path.join(one.root, "runs", "alpha"))).toBe(false)

      await mkdir(path.join(one.root, "runs", "alpha", "new-run", "work"), { recursive: true })
      const unconfirmed = await request(one, "/api/challenges/alpha", "DELETE", { confirm: false })
      expect(unconfirmed.status).toBe(400)
      expect(await exists(one.challenge)).toBe(true)
      expect(await exists(path.join(one.root, "runs", "alpha"))).toBe(true)

      const deleted = await request(one, "/api/challenges/alpha", "DELETE", { confirm: true })
      expect(deleted.status).toBe(200)
      expect(await exists(one.challenge)).toBe(false)
      expect(await exists(path.join(one.root, "runs", "alpha"))).toBe(false)
    } finally {
      await one.close()
    }
  })

  test("rejects file traversal and refuses to reset a run tree that is a symlink", async () => {
    const one = await harness()
    const outside = await mkdtemp(path.join(os.tmpdir(), "boom-gui-outside-"))
    try {
      const traversal = await request(one, "/api/open", "POST", {
        kind: "file",
        slug: "alpha",
        runID: one.runID,
        path: "../../../../etc/passwd",
      })
      expect(traversal.status).toBe(400)
      expect(((await traversal.json()) as { error: string }).error).toContain("Path escapes")

      await rm(path.join(one.root, "runs", "alpha"), { recursive: true, force: true })
      await writeFile(path.join(outside, "sentinel.txt"), "keep")
      await symlink(outside, path.join(one.root, "runs", "alpha"))
      const reset = await request(one, "/api/challenges/alpha/runs", "DELETE")

      expect(reset.status).toBe(400)
      expect(await exists(path.join(outside, "sentinel.txt"))).toBe(true)
    } finally {
      await one.close()
      await rm(outside, { recursive: true, force: true })
    }
  })
})
