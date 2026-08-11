import { chmod, copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import {
  discoverChallenges,
  normalizeChallengeCategory,
  updateChallengeRemote,
  type Challenge,
} from "./challenge.ts"
import {
  loadRootGuiState,
  saveRootGuiState,
  type GuiSettings,
  type RootGuiState,
} from "./gui-state.ts"
import type {
  ArmorPromptPreset,
  ManagedProviderConfig,
} from "./provider-config.ts"
import type { ManagedMcpServer } from "./mcp-config.ts"
import {
  appendRunEvent,
  assertPathWithin,
  canonicalDirectory,
  readChallengeRuns,
  type RunHistory,
} from "./history.ts"
import { GuiRunner, type RunnerNotification } from "./runner.ts"
import { DEFAULT_SILENCE_MS } from "./session.ts"
import { CONSULT_EXPERTS } from "./consultation.ts"
import { acceptTaskFlag, loadOrCreateTask, rejectTaskFlag } from "./task.ts"
import {
  bindTaskEnvironment,
  detectContainerCapability,
  discoverCondaEnvironments,
  loadEnvironmentStore,
  loadTaskEnvironment,
  probePythonEnvironment,
  resolveEnvironmentProfile,
  saveEnvironmentStore,
  upsertEnvironmentProfile,
} from "./environment.ts"
import { configuredPlatformAdapterRegistry } from "./http-platform-adapter.ts"
import {
  loadPlatformManifest,
  normalizePlatformManifest,
  platformManifestPath,
  savePlatformManifest,
} from "./platform-manifest.ts"
import { adaptOpenApiDocument, readApiDocument } from "./platform-openapi.ts"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
const HOME_PAGE = path.join(PACKAGE_ROOT, "prototype", "boom-gui-v3.html")
const APP_SCRIPT = path.join(PACKAGE_ROOT, "prototype", "boom-gui-v3.js")
const WEB_DIST = path.join(PACKAGE_ROOT, "frontend", "dist")
const WEB_INDEX = path.join(WEB_DIST, "index.html")
const webReady = existsSync(WEB_INDEX)
const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])
const encoder = new TextEncoder()

export type GuiRunnerBackend = Pick<
  GuiRunner,
  | "setRoot"
  | "setConcurrency"
  | "applyLiveModelSettings"
  | "hasWork"
  | "getRuntimeState"
  | "subscribe"
  | "getModels"
  | "getProviders"
  | "getProvider"
  | "getArmorPrompts"
  | "saveArmorPrompts"
  | "saveProvider"
  | "startProviderOAuth"
  | "completeProviderOAuth"
  | "deleteProvider"
  | "removeProviderCredential"
  | "importOpenCodeProviderCredentials"
  | "getMcpServers"
  | "saveMcpServer"
  | "deleteMcpServer"
  | "testMcpServer"
  | "startMcpOAuth"
  | "completeMcpOAuth"
  | "removeMcpOAuth"
  | "enqueue"
  | "stop"
  | "getTransientRuns"
  | "switchTaskEnvironment"
  | "ensureRuntime"
  | "close"
>

export type StartGuiOptions = {
  root: string
  hostname?: string
  port?: number
  open?: boolean
  runner?: GuiRunnerBackend
  startRuntime?: boolean
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  })
}

async function body(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0)
  if (length > 1_000_000) throw new HttpError(413, "Request body is too large")
  try {
    const parsed = (await request.json()) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new HttpError(400, "Expected a JSON object")
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, "Expected a JSON request body")
  }
}

function positive(value: unknown, name: string, minimum = 1) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    throw new HttpError(400, `${name} must be at least ${minimum}`)
  return value
}

function serviceRemote(value: unknown) {
  if (value === null) return undefined
  if (typeof value !== "string") throw new HttpError(400, "remote must be a string or null")
  const remote = value.trim()
  if (remote === "") return undefined
  if (remote.length > 2_048 || /[\0\r\n]/.test(remote))
    throw new HttpError(400, "remote must be one line of at most 2048 characters")
  return remote
}

function settingsFrom(input: Record<string, unknown>, fallback: GuiSettings): GuiSettings {
  const legacyModel = typeof input.model === "string" ? input.model : undefined
  const economyModel =
    typeof input.economyModel === "string"
      ? input.economyModel
      : legacyModel ?? fallback.economyModel
  const strongModel =
    typeof input.strongModel === "string"
      ? input.strongModel
      : legacyModel ?? fallback.strongModel
  if (!economyModel.includes("/"))
    throw new HttpError(400, "economyModel must be provider/model")
  if (!strongModel.includes("/"))
    throw new HttpError(400, "strongModel must be provider/model")
  const tokens = positive(input.tokens ?? fallback.tokens, "tokens")
  const repeats = positive(input.repeats ?? fallback.repeats, "repeats", 2)
  const minutes = positive(input.minutes ?? fallback.minutes, "minutes")
  const concurrency = Math.min(
    32,
    Math.floor(positive(input.concurrency ?? fallback.concurrency, "concurrency")),
  )
  const flagFormat = typeof input.flagFormat === "string" ? input.flagFormat : fallback.flagFormat
  const executionMode =
    input.executionMode === "managed" || input.executionMode === "isolated" || input.executionMode === "static-only"
      ? input.executionMode
      : fallback.executionMode
  if (flagFormat !== "") {
    try {
      new RegExp(flagFormat)
    } catch {
      throw new HttpError(400, "flagFormat is not a valid regular expression")
    }
  }
  // An empty pool is valid and means "no second opinion configured". A non-empty one is validated
  // eagerly so a bad model name is rejected at save time rather than mid-run.
  let consultModels = fallback.consultModels
  if (input.consultModels !== undefined) {
    if (
      !Array.isArray(input.consultModels) ||
      input.consultModels.some((model) => typeof model !== "string")
    )
      throw new HttpError(400, "consultModels must be an array of provider/model strings")
    const models = input.consultModels as string[]
    if (models.some((model) => !model.includes("/")))
      throw new HttpError(400, "every consultModels entry must be provider/model")
    if (
      models.length > CONSULT_EXPERTS.maximum ||
      (models.length > 0 && models.length < CONSULT_EXPERTS.minimum)
    )
      throw new HttpError(
        400,
        `consultModels must be empty or contain ${CONSULT_EXPERTS.minimum}-${CONSULT_EXPERTS.maximum} models`,
      )
    consultModels = models
  }
  const blindReview =
    typeof input.blindReview === "boolean" ? input.blindReview : fallback.blindReview
  const consultOnCompaction =
    typeof input.consultOnCompaction === "boolean"
      ? input.consultOnCompaction
      : fallback.consultOnCompaction
  return {
    economyModel,
    strongModel,
    tokens,
    repeats,
    minutes,
    concurrency,
    flagFormat,
    executionMode,
    consultModels,
    blindReview,
    consultOnCompaction,
  }
}

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new HttpError(400, "Invalid URL encoding")
  }
}

function containsPath(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function mergeTransient(history: RunHistory[], transient: RunHistory[]) {
  const merged = [...history]
  for (const live of transient) {
    const index = merged.findIndex((run) => run.id === live.id)
    if (index === -1) merged.push(live)
    else {
      const disk = merged[index]!
      const durableCandidate =
        live.candidates.length === 0 && disk.primaryCandidate
          ? {
              candidates: disk.candidates,
              primaryCandidate: disk.primaryCandidate,
              alternatives: disk.alternatives,
              candidateSource: disk.candidateSource,
              verification: disk.verification,
              platformSubmission: disk.platformSubmission,
            }
          : {}
      merged[index] = {
        ...disk,
        ...live,
        ...durableCandidate,
        notes: disk.notes,
        files: disk.files,
        events: live.events.length > 0 ? live.events : disk.events,
      }
    }
  }
  return merged
}

function boundedStateText(value: string | undefined, maximum: number) {
  if (value === undefined || value.length <= maximum) return value
  return `${value.slice(0, maximum)}\n\n[GUI snapshot truncated; open the durable artifact for the full content]`
}

function boundedStateEvents(events: RunHistory["events"]) {
  let remaining = 64_000
  const kept: RunHistory["events"] = []
  for (let index = events.length - 1; index >= 0 && kept.length < 600; index -= 1) {
    const event = events[index]!
    const original = event.text ?? ""
    if (original.length > remaining && event.type === "text" && remaining < 256) continue
    const text = boundedStateText(original, Math.max(0, remaining))
    remaining = Math.max(0, remaining - (text?.length ?? 0))
    kept.push({ ...event, ...(event.text === undefined ? {} : { text }) })
  }
  return kept.reverse()
}

function boundedStateRun(run: RunHistory): RunHistory {
  return {
    ...run,
    reply: boundedStateText(run.reply, 32_000) ?? "",
    ...(run.detail === undefined ? {} : { detail: boundedStateText(run.detail, 4_000) }),
    notes: boundedStateText(run.notes, 64_000) ?? "",
    ...(run.writeup === undefined ? {} : { writeup: boundedStateText(run.writeup, 64_000) ?? "" }),
    events: boundedStateEvents(run.events),
    ...(run.turns ? {
      turns: run.turns.map((turn) => ({
        ...turn,
        ...(turn.prompt === undefined ? {} : { prompt: boundedStateText(turn.prompt, 8_000) }),
        ...(turn.detail === undefined ? {} : { detail: boundedStateText(turn.detail, 4_000) }),
      })),
    } : {}),
    ...(run.consultation ? {
      consultation: {
        ...run.consultation,
        plans: run.consultation.plans.map((plan) => ({
          ...plan,
          text: boundedStateText(plan.text, 16_000) ?? "",
        })),
        ...(run.consultation.merged ? {
          merged: {
            ...run.consultation.merged,
            text: boundedStateText(run.consultation.merged.text, 16_000) ?? "",
          },
        } : {}),
      },
    } : {}),
  }
}

async function platformSummaries(root: string) {
  const directory = path.join(root, "platforms")
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return Promise.all(entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const id = entry.name.slice(0, -".json".length)
      try {
        const manifest = await loadPlatformManifest(root, id)
        if (!manifest) throw new Error("manifest disappeared while scanning")
        return {
          id: manifest.id,
          name: manifest.name ?? manifest.id,
          status: manifest.status as "draft" | "ready" | "invalid",
          profile: manifest.profile,
          listChallenges: true,
          acquireChallenges: true,
          submitFlag: manifest.operations.submitFlag !== undefined,
          credential: manifest.auth
            ? { env: manifest.auth.env, configured: Boolean(process.env[manifest.auth.env]?.trim()) }
            : undefined,
        }
      } catch (error) {
        return {
          id,
          name: id,
          status: "invalid" as const,
          listChallenges: false,
          acquireChallenges: false,
          submitFlag: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }))
}

function platformQuery(value: unknown) {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "query must be an object")
  const input = value as Record<string, unknown>
  const integer = (key: "page" | "pageSize", maximum: number) => {
    const found = input[key]
    if (found === undefined) return undefined
    if (typeof found !== "number" || !Number.isInteger(found) || found < 1 || found > maximum)
      throw new HttpError(400, `query.${key} must be an integer from 1 to ${maximum}`)
    return found
  }
  const string = (key: "search" | "category" | "difficulty") => {
    const found = input[key]
    if (found === undefined || found === "") return undefined
    if (typeof found !== "string" || found.length > 500 || found.includes("\0"))
      throw new HttpError(400, `query.${key} must be a short string`)
    return found.trim()
  }
  return {
    ...(integer("page", 100_000) ? { page: integer("page", 100_000)! } : {}),
    ...(integer("pageSize", 100) ? { pageSize: integer("pageSize", 100)! } : {}),
    ...(string("search") ? { search: string("search")! } : {}),
    ...(string("category") ? { category: string("category")! } : {}),
    ...(string("difficulty") ? { difficulty: string("difficulty")! } : {}),
  }
}

function platformSelection(value: unknown) {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "selection must be an object")
  const input = value as Record<string, unknown>
  const identifiers = (key: "ids" | "exclude") => {
    const found = input[key]
    if (found === undefined) return undefined
    if (!Array.isArray(found) || found.length > 20_000 || found.some((item) =>
      typeof item !== "string" || !item.trim() || item.length > 600 || item.includes("\0")))
      throw new HttpError(400, `selection.${key} must be an array of challenge IDs`)
    return [...new Set(found as string[])]
  }
  if (input.all !== undefined && typeof input.all !== "boolean")
    throw new HttpError(400, "selection.all must be a boolean")
  return {
    ...(input.all === true ? { all: true } : {}),
    ...(identifiers("ids") ? { ids: identifiers("ids")! } : {}),
    ...(identifiers("exclude") ? { exclude: identifiers("exclude")! } : {}),
    ...(input.query === undefined ? {} : { query: platformQuery(input.query) }),
  }
}

function summaryStateRun(run: RunHistory): RunHistory {
  const bounded = boundedStateRun(run)
  return {
    ...bounded,
    reply: boundedStateText(bounded.reply, 2_000) ?? "",
    ...(bounded.detail === undefined ? {} : { detail: boundedStateText(bounded.detail, 1_000) }),
    notes: "",
    writeup: "",
    files: [],
    events: bounded.events.slice(-20),
    turns: bounded.turns?.slice(-3),
    consultation: undefined,
  }
}

async function openExternal(target: string) {
  const command =
    process.platform === "darwin"
      ? ["open", target]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", target]
        : ["xdg-open", target]
  const processHandle = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  void processHandle.exited
}

async function copyTree(source: string, destination: string): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new HttpError(400, `Symbolic links are not accepted during import: ${source}`)
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(source)) await copyTree(path.join(source, entry), path.join(destination, entry))
    return
  }
  if (!info.isFile()) throw new HttpError(400, `Unsupported import entry: ${source}`)
  await mkdir(path.dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

async function makeWritable(target: string): Promise<void> {
  const info = await lstat(target).catch(() => undefined)
  if (!info) return
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    for (const entry of await readdir(target)) await makeWritable(path.join(target, entry))
    await chmod(target, 0o700).catch(() => {})
  } else {
    await chmod(target, 0o600).catch(() => {})
  }
}

async function destructiveTarget(root: string, target: string) {
  const safe = await assertPathWithin(root, target, true)
  const info = await lstat(target).catch(() => undefined)
  if (!info) return safe
  if (info.isSymbolicLink()) throw new HttpError(400, `Refusing to delete a symbolic link: ${target}`)
  return safe
}

async function removeTree(root: string, target: string) {
  const safe = await destructiveTarget(root, target)
  await makeWritable(safe)
  await rm(safe, { recursive: true, force: true })
}

export async function startGuiServer(options: StartGuiOptions) {
  const hostname = options.hostname ?? "127.0.0.1"
  if (!LOOPBACK.has(hostname)) throw new Error(`Boom GUI only listens on loopback, got: ${hostname}`)
  let root = await canonicalDirectory(options.root)
  const challengeRoot = await lstat(path.join(root, "challenges")).catch(() => undefined)
  if (!challengeRoot?.isDirectory()) throw new Error(`No challenges directory at ${path.join(root, "challenges")}`)
  let persisted = await loadRootGuiState(root)
  const runner: GuiRunnerBackend = options.runner ?? new GuiRunner(root)
  runner.setConcurrency(persisted.settings.concurrency)
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let sequence = 0
  let mutation = Promise.resolve()
  let closing = false

  const exclusive = <T>(operation: () => Promise<T>) => {
    const result = mutation.then(operation, operation)
    mutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const broadcast = (value: RunnerNotification | Record<string, unknown>) => {
    const event = { sequence: ++sequence, ...value }
    const packet = encoder.encode(`id: ${sequence}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`)
    for (const client of [...clients]) {
      try {
        client.enqueue(packet)
      } catch {
        clients.delete(client)
      }
    }
  }
  const unsubscribe = runner.subscribe(broadcast)

  const challenges = async () => discoverChallenges(root)
  const challenge = async (slug: string) => {
    const found = (await challenges()).find((item) => item.slug === slug)
    if (!found) throw new HttpError(404, `No such challenge: ${slug}`)
    return found
  }

  const state = async () => {
    const stateRoot = root
    const statePersisted = persisted
    const found = await discoverChallenges(stateRoot)
    const models = await runner.getModels()
    const environments = await loadEnvironmentStore()
    return {
      root: stateRoot,
      settings: statePersisted.settings,
      models,
      runtime: runner.getRuntimeState(),
      environments,
      challenges: await Promise.all(
        found.map(async (item) => {
          const saved = statePersisted.challenges[item.slug]
          const history = await readChallengeRuns(stateRoot, item.slug)
          const runs = mergeTransient(history, runner.getTransientRuns(item.slug)).map((inputRun) => {
            const run = summaryStateRun(inputRun)
            return saved?.confirmed?.runID === run.id
              ? {
                  ...run,
                  taskStatus: "archived" as const,
                  confirmedFlag: saved.confirmed.flag,
                }
              : run
          })
          return {
            slug: item.slug,
            category: item.category ?? "OTHER",
            storagePath: path.relative(
              path.join(stateRoot, "challenges"),
              item.sourceDirectory ?? item.directory,
            ).split(path.sep).join("/"),
            ...(item.difficulty ? { difficulty: item.difficulty } : {}),
            description: item.description,
            files: item.files,
            flagFormat: item.flagFormat,
            ...(item.remote?.trim() ? { remote: item.remote.trim() } : {}),
            ...(item.serviceRequired === true ? { serviceRequired: true } : {}),
            ...(item.platform ? { platform: item.platform } : {}),
            ...(saved?.state ? { state: saved.state } : {}),
            runs,
          }
        }),
      ),
    }
  }

  const runDetail = async (slug: string, runID: string) => {
    const found = await challenge(slug)
    const saved = persisted.challenges[found.slug]
    const runs = mergeTransient(
      await readChallengeRuns(root, found.slug),
      runner.getTransientRuns(found.slug),
    )
    const selected = runs.find((run) => run.id === runID)
    if (!selected) throw new HttpError(404, `No such task: ${found.slug}/${runID}`)
    const run = boundedStateRun(selected)
    return saved?.confirmed?.runID === run.id
      ? { ...run, taskStatus: "archived" as const, confirmedFlag: saved.confirmed.flag }
      : run
  }

  const server = Bun.serve({
    hostname,
    port: options.port ?? 7331,
    async fetch(request, bunServer) {
      const url = new URL(request.url)
      if (!LOOPBACK.has(url.hostname)) return json({ error: "Invalid Host header" }, 403)
      const origin = request.headers.get("origin")
      if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed" }, 403)
      if (request.method === "OPTIONS") return json({ error: "Cross-origin requests are not allowed" }, 403)
      if (closing) return json({ error: "Boom GUI is shutting down" }, 503)

      try {
        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          return new Response(Bun.file(webReady ? WEB_INDEX : HOME_PAGE), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
              "Content-Security-Policy":
                "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
            },
          })
        }
        if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
          if (!webReady) return json({ error: "Not found" }, 404)
          const assetPath = path.normalize(path.join(WEB_DIST, url.pathname))
          if (!assetPath.startsWith(WEB_DIST)) return json({ error: "Not found" }, 404)
          const file = Bun.file(assetPath)
          if (!(await file.exists())) return json({ error: "Not found" }, 404)
          return new Response(file, {
            headers: {
              "Cache-Control": "public, max-age=31536000, immutable",
              "X-Content-Type-Options": "nosniff",
            },
          })
        }
        if (request.method === "GET" && url.pathname === "/app.js") {
          return new Response(Bun.file(APP_SCRIPT), {
            headers: {
              "Content-Type": "application/javascript; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
            },
          })
        }

        if (request.method === "GET" && url.pathname === "/api/state") return json(await state())
        const runDetailMatch = /^\/api\/challenges\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname)
        if (request.method === "GET" && runDetailMatch)
          return json({
            run: await runDetail(
              decodeSegment(runDetailMatch[1]!),
              decodeSegment(runDetailMatch[2]!),
            ),
          })
        if (request.method === "GET" && url.pathname === "/api/events") {
          bunServer.timeout(request, 0)
          let controller: ReadableStreamDefaultController<Uint8Array>
          const stream = new ReadableStream<Uint8Array>({
            start(value) {
              controller = value
              clients.add(controller)
              const reconnectSequence = ++sequence
              controller.enqueue(
                encoder.encode(
                  `: connected\nid: ${reconnectSequence}\nevent: state\ndata: ${JSON.stringify({
                    sequence: reconnectSequence,
                    at: Date.now(),
                    type: "state.connected",
                  })}\n\n`,
                ),
              )
            },
            cancel() {
              clients.delete(controller)
            },
          })
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          })
        }

        if (request.method === "POST" && url.pathname === "/api/root") {
          const input = await body(request)
          return await exclusive(async () => {
            if (runner.hasWork()) throw new HttpError(409, "Stop active runs before changing root")
            if (typeof input.root !== "string") throw new HttpError(400, "root must be a path")
            const next = await canonicalDirectory(input.root)
            const challengeDirectory = await lstat(path.join(next, "challenges")).catch(() => undefined)
            if (!challengeDirectory?.isDirectory())
              throw new HttpError(400, `No challenges directory at ${path.join(next, "challenges")}`)
            const nextPersisted = await loadRootGuiState(next)
            runner.setRoot(next)
            runner.setConcurrency(nextPersisted.settings.concurrency)
            root = next
            persisted = nextPersisted
            broadcast({ at: Date.now(), type: "root.changed" })
            return json(await state())
          })
        }

        if (request.method === "PATCH" && url.pathname === "/api/settings") {
          const input = await body(request)
          return await exclusive(async () => {
            const settings = settingsFrom(input, persisted.settings)
            const nextPersisted: RootGuiState = { ...persisted, settings }
            await saveRootGuiState(root, nextPersisted)
            persisted = nextPersisted
            runner.setConcurrency(settings.concurrency)
            const switches = await runner.applyLiveModelSettings(settings)
            broadcast({ at: Date.now(), type: "settings.changed" })
            return json({ settings, switches })
          })
        }

        if (request.method === "GET" && url.pathname === "/api/platforms")
          return json({ platforms: await platformSummaries(root) })

        if (request.method === "POST" && url.pathname === "/api/platforms/adapt") {
          const input = await body(request)
          if (typeof input.id !== "string" || !input.id.trim())
            throw new HttpError(400, "id must be a platform adapter ID")
          if (typeof input.document !== "string" || !input.document.trim())
            throw new HttpError(400, "document must be an OpenAPI URL or local path")
          const requestedID = input.id.trim()
          const documentSource = input.document.trim()
          return await exclusive(async () => {
            const adapterID = requestedID
            const target = platformManifestPath(root, adapterID)
            if (input.force !== true && await lstat(target).catch(() => undefined))
              throw new HttpError(409, `Platform adapter already exists: ${adapterID}`)
            try {
              const document = await readApiDocument(documentSource)
              const adapted = adaptOpenApiDocument(document, {
                id: adapterID,
                ...(typeof input.baseURL === "string" && input.baseURL.trim()
                  ? { baseURL: input.baseURL.trim() }
                  : {}),
                ...(typeof input.name === "string" && input.name.trim()
                  ? { name: input.name.trim() }
                  : {}),
              })
              await savePlatformManifest(root, adapted.manifest)
              broadcast({ at: Date.now(), type: "platform.adapted", adapter: adapterID })
              return json(adapted, 201)
            } catch (error) {
              if (error instanceof HttpError) throw error
              throw new HttpError(400, error instanceof Error ? error.message : String(error))
            }
          })
        }

        const platformCatalogMatch = /^\/api\/platforms\/([^/]+)\/catalog$/.exec(url.pathname)
        if (request.method === "POST" && platformCatalogMatch) {
          const adapterID = decodeSegment(platformCatalogMatch[1]!)
          const input = await body(request)
          const variables = input.variables === undefined
            ? {}
            : input.variables && typeof input.variables === "object" && !Array.isArray(input.variables)
              ? input.variables as Record<string, unknown>
              : undefined
          if (!variables) throw new HttpError(400, "variables must be an object")
          try {
            const catalog = await configuredPlatformAdapterRegistry().listChallenges(adapterID, {
              root,
              options: variables,
              query: platformQuery(input.query),
            })
            return json({ adapter: adapterID, ...catalog })
          } catch (error) {
            if (error instanceof HttpError) throw error
            throw new HttpError(400, error instanceof Error ? error.message : String(error))
          }
        }

        const platformSyncMatch = /^\/api\/platforms\/([^/]+)\/sync$/.exec(url.pathname)
        if (request.method === "POST" && platformSyncMatch) {
          const adapterID = decodeSegment(platformSyncMatch[1]!)
          const input = await body(request)
          const variables = input.variables === undefined
            ? {}
            : input.variables && typeof input.variables === "object" && !Array.isArray(input.variables)
              ? input.variables as Record<string, unknown>
              : undefined
          if (!variables) throw new HttpError(400, "variables must be an object")
          return await exclusive(async () => {
            try {
              const downloaded = await configuredPlatformAdapterRegistry().acquireChallenges(adapterID, {
                root,
                options: variables,
                selection: platformSelection(input.selection),
              })
              broadcast({
                at: Date.now(),
                type: "platform.synced",
                adapter: adapterID,
                challenges: downloaded.length,
              })
              return json({
                adapter: adapterID,
                challenges: downloaded.map((challenge) => challenge.slug),
              })
            } catch (error) {
              throw new HttpError(400, error instanceof Error ? error.message : String(error))
            }
          })
        }

        const platformMatch = /^\/api\/platforms\/([^/]+)$/.exec(url.pathname)
        if (request.method === "GET" && platformMatch) {
          const adapterID = decodeSegment(platformMatch[1]!)
          const manifest = await loadPlatformManifest(root, adapterID)
          if (!manifest) throw new HttpError(404, `No such platform adapter: ${adapterID}`)
          return json({
            manifest,
            credential: manifest.auth
              ? { env: manifest.auth.env, configured: Boolean(process.env[manifest.auth.env]?.trim()) }
              : undefined,
          })
        }
        if (request.method === "PUT" && platformMatch) {
          const adapterID = decodeSegment(platformMatch[1]!)
          const input = await body(request)
          return await exclusive(async () => {
            try {
              const manifest = normalizePlatformManifest(input.manifest)
              if (manifest.id !== adapterID)
                throw new HttpError(400, "manifest.id must match the URL")
              await savePlatformManifest(root, manifest)
              broadcast({ at: Date.now(), type: "platform.changed", adapter: adapterID })
              return json({ manifest })
            } catch (error) {
              if (error instanceof HttpError) throw error
              throw new HttpError(400, error instanceof Error ? error.message : String(error))
            }
          })
        }

        if (request.method === "GET" && url.pathname === "/api/environments")
          return json({
            store: await loadEnvironmentStore(),
            container: await detectContainerCapability(),
          })

        if (request.method === "POST" && url.pathname === "/api/environments/discover") {
          const input = await body(request)
          const profiles = await discoverCondaEnvironments(
            typeof input.conda === "string" && input.conda.trim() ? input.conda.trim() : "conda",
          )
          const store = await loadEnvironmentStore()
          for (const profile of profiles) {
            const index = store.profiles.findIndex((item) => item.id === profile.id)
            if (index === -1) store.profiles.push(profile)
            else store.profiles[index] = { ...profile, installPolicy: store.profiles[index]!.installPolicy }
          }
          const saved = await saveEnvironmentStore(store)
          broadcast({ at: Date.now(), type: "environments.changed" })
          return json({ store: saved, discovered: profiles.length })
        }

        if (request.method === "POST" && url.pathname === "/api/environments") {
          const input = await body(request)
          if (typeof input.interpreter !== "string" || input.interpreter.trim() === "")
            throw new HttpError(400, "interpreter must be an existing Python executable")
          const profile = await probePythonEnvironment({
            interpreter: input.interpreter,
            ...(typeof input.displayName === "string" ? { displayName: input.displayName } : {}),
            ...(input.kind === "conda" || input.kind === "python" ? { kind: input.kind } : {}),
            ...(typeof input.prefix === "string" ? { prefix: input.prefix } : {}),
            ...(input.installPolicy === "allow" || input.installPolicy === "deny"
              ? { installPolicy: input.installPolicy }
              : {}),
            ...(typeof input.id === "string" ? { id: input.id } : {}),
          })
          if (profile.status !== "ready")
            throw new HttpError(400, profile.detail ?? `Python environment is ${profile.status}`)
          const store = await upsertEnvironmentProfile(profile, input.makeDefault === true)
          broadcast({ at: Date.now(), type: "environments.changed" })
          return json({ profile, store }, 201)
        }

        if (request.method === "PATCH" && url.pathname === "/api/environments/default") {
          const input = await body(request)
          if (typeof input.profileId !== "string") throw new HttpError(400, "profileId must be a string")
          const store = await loadEnvironmentStore()
          if (!store.profiles.some((item) => item.id === input.profileId))
            throw new HttpError(404, `No such environment profile: ${input.profileId}`)
          store.defaultProfileId = input.profileId
          const saved = await saveEnvironmentStore(store)
          broadcast({ at: Date.now(), type: "environments.changed" })
          return json({ store: saved })
        }

        if (request.method === "PATCH" && url.pathname === "/api/environments/task") {
          const input = await body(request)
          if (typeof input.slug !== "string" || typeof input.runID !== "string")
            throw new HttpError(400, "slug and runID must be strings")
          if (typeof input.profileId !== "string")
            throw new HttpError(400, "profileId must be a string")
          const slug = input.slug
          const runID = input.runID
          const profileId = input.profileId
          const executionMode =
            input.executionMode === "isolated" || input.executionMode === "static-only"
              ? input.executionMode
              : "managed"
          return await exclusive(async () => {
            const found = await challenge(slug)
            const runs = await readChallengeRuns(root, found.slug)
            if (!runs.some((run) => run.id === runID))
              throw new HttpError(404, `No such task: ${found.slug}/${runID}`)
            const directory = await assertPathWithin(
              root,
              path.join(root, "runs", found.slug, runID),
            )
            const previous = await loadTaskEnvironment(directory)
            const selected = await resolveEnvironmentProfile({ profileId })
            const binding = await bindTaskEnvironment({
              directory,
              profile: selected.profile,
              source: "task-override",
              executionMode,
              replace: true,
            })
            await appendRunEvent(directory, {
              at: Date.now(),
              type: "status",
              status: "environment-switched",
              text: `${previous?.fingerprint ?? "unbound"} -> ${binding.fingerprint} · ${binding.displayName} · ${binding.executionMode}`,
            })
            const switches = runner.switchTaskEnvironment({
              slug: found.slug,
              profileId,
              executionMode,
            })
            broadcast({ at: Date.now(), type: "environment.switched", slug: found.slug, runID })
            return json({ environment: binding, switches })
          })
        }

        if (request.method === "GET" && url.pathname === "/api/providers")
          return json({ providers: await runner.getProviders() })

        if (
          request.method === "POST" &&
          url.pathname === "/api/providers/import-opencode-credentials"
        ) {
          return await exclusive(async () =>
            json({ migration: await runner.importOpenCodeProviderCredentials() }))
        }

        if (request.method === "GET" && url.pathname === "/api/mcp")
          return json({ servers: await runner.getMcpServers() })

        const mcpTestMatch = /^\/api\/mcp\/([^/]+)\/test$/.exec(url.pathname)
        if (request.method === "POST" && mcpTestMatch) {
          const serverID = decodeSegment(mcpTestMatch[1]!)
          return await exclusive(async () =>
            json({ status: await runner.testMcpServer(serverID) }))
        }

        const mcpOAuthCallbackMatch = /^\/api\/mcp\/([^/]+)\/oauth\/callback$/.exec(url.pathname)
        if (request.method === "POST" && mcpOAuthCallbackMatch) {
          const serverID = decodeSegment(mcpOAuthCallbackMatch[1]!)
          const input = await body(request)
          if (typeof input.code !== "string" || !input.code.trim())
            throw new HttpError(400, "code must be a non-empty string")
          return await exclusive(async () =>
            json({ status: await runner.completeMcpOAuth(serverID, input.code as string) }))
        }

        const mcpOAuthMatch = /^\/api\/mcp\/([^/]+)\/oauth$/.exec(url.pathname)
        if (request.method === "POST" && mcpOAuthMatch) {
          const serverID = decodeSegment(mcpOAuthMatch[1]!)
          return await exclusive(async () => {
            const authorization = await runner.startMcpOAuth(serverID)
            await openExternal(authorization.authorizationUrl)
            return json({ authorization })
          })
        }
        if (request.method === "DELETE" && mcpOAuthMatch) {
          const serverID = decodeSegment(mcpOAuthMatch[1]!)
          return await exclusive(async () => {
            await runner.removeMcpOAuth(serverID)
            return json({ ok: true })
          })
        }

        const mcpMatch = /^\/api\/mcp\/([^/]+)$/.exec(url.pathname)
        if (request.method === "PUT" && mcpMatch) {
          const serverID = decodeSegment(mcpMatch[1]!)
          const input = await body(request)
          const server = input.server && typeof input.server === "object" && !Array.isArray(input.server)
            ? input.server as ManagedMcpServer
            : undefined
          if (!server || server.id !== serverID)
            throw new HttpError(400, "server.id must match the URL")
          return await exclusive(async () =>
            json({ server: await runner.saveMcpServer(server) }))
        }
        if (request.method === "DELETE" && mcpMatch) {
          const serverID = decodeSegment(mcpMatch[1]!)
          return await exclusive(async () => {
            await runner.deleteMcpServer(serverID)
            return json({ ok: true })
          })
        }

        if (request.method === "GET" && url.pathname === "/api/armor-prompts")
          return json({ prompts: await runner.getArmorPrompts() })

        if (request.method === "PUT" && url.pathname === "/api/armor-prompts") {
          const input = await body(request)
          if (!Array.isArray(input.prompts))
            throw new HttpError(400, "prompts must be an array")
          return await exclusive(async () => {
            const prompts = await runner.saveArmorPrompts(
              input.prompts as ArmorPromptPreset[],
            )
            broadcast({ at: Date.now(), type: "armor-prompts.changed" })
            return json({ prompts })
          })
        }

        const providerCredentialMatch =
          /^\/api\/providers\/([^/]+)\/credential$/.exec(url.pathname)
        if (request.method === "DELETE" && providerCredentialMatch) {
          const providerID = decodeSegment(providerCredentialMatch[1]!)
          return await exclusive(async () => {
            await runner.removeProviderCredential(providerID)
            broadcast({ at: Date.now(), type: "providers.changed" })
            return json({ ok: true })
          })
        }

        const providerOAuthCallbackMatch =
          /^\/api\/providers\/([^/]+)\/oauth\/callback$/.exec(url.pathname)
        if (request.method === "POST" && providerOAuthCallbackMatch) {
          const providerID = decodeSegment(providerOAuthCallbackMatch[1]!)
          const input = await body(request)
          const method = positive(input.method, "method", 0)
          if (!Number.isInteger(method))
            throw new HttpError(400, "method must be an integer")
          const code = typeof input.code === "string" ? input.code : undefined
          return await exclusive(async () => {
            const provider = await runner.completeProviderOAuth(
              providerID,
              method,
              code,
            )
            broadcast({ at: Date.now(), type: "providers.changed" })
            return json({ provider })
          })
        }

        const providerOAuthMatch =
          /^\/api\/providers\/([^/]+)\/oauth$/.exec(url.pathname)
        if (request.method === "POST" && providerOAuthMatch) {
          const providerID = decodeSegment(providerOAuthMatch[1]!)
          const input = await body(request)
          const method = positive(input.method, "method", 0)
          if (!Number.isInteger(method))
            throw new HttpError(400, "method must be an integer")
          return await exclusive(async () => {
            const authorization = await runner.startProviderOAuth(
              providerID,
              method,
            )
            await openExternal(authorization.url)
            return json({ authorization })
          })
        }

        const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(url.pathname)
        if (request.method === "GET" && providerMatch) {
          const providerID = decodeSegment(providerMatch[1]!)
          return json({ provider: await runner.getProvider(providerID) })
        }
        if (request.method === "PUT" && providerMatch) {
          const providerID = decodeSegment(providerMatch[1]!)
          const input = await body(request)
          const provider =
            input.provider &&
            typeof input.provider === "object" &&
            !Array.isArray(input.provider)
              ? (input.provider as ManagedProviderConfig)
              : undefined
          if (!provider || provider.id !== providerID)
            throw new HttpError(400, "provider.id must match the URL")
          const apiKey =
            typeof input.apiKey === "string" ? input.apiKey : undefined
          return await exclusive(async () => {
            const saved = await runner.saveProvider(provider, apiKey)
            broadcast({ at: Date.now(), type: "providers.changed" })
            return json({ provider: saved })
          })
        }
        if (request.method === "DELETE" && providerMatch) {
          const providerID = decodeSegment(providerMatch[1]!)
          return await exclusive(async () => {
            await runner.deleteProvider(providerID)
            broadcast({ at: Date.now(), type: "providers.changed" })
            return json({ ok: true })
          })
        }

        const patchMatch = /^\/api\/challenges\/([^/]+)$/.exec(url.pathname)
        if (request.method === "PATCH" && patchMatch) {
          const slug = decodeSegment(patchMatch[1]!)
          const input = await body(request)
          return await exclusive(async () => {
            const found = await challenge(slug)
            const current = { ...(persisted.challenges[slug] ?? {}) }
            let remote = found.remote?.trim() || undefined
            if ("remote" in input) {
              remote = serviceRemote(input.remote)
              await updateChallengeRemote(found, remote)
            }
            if ("state" in input) {
              if (input.state === null) delete current.state
              else if (input.state === "given-up" || input.state === "removed") current.state = input.state
              else throw new HttpError(400, "state must be given-up, removed, or null")
            }
            persisted.challenges[slug] = current
            await saveRootGuiState(root, persisted)
            broadcast({ at: Date.now(), type: "challenge.changed", slug })
            return json({ ok: true, remote: remote ?? null })
          })
        }

        if (request.method === "POST" && url.pathname === "/api/runs") {
          const input = await body(request)
          return await exclusive(async () => {
            const slugs = Array.isArray(input.slugs)
              ? input.slugs.filter((item): item is string => typeof item === "string")
              : []
            if (slugs.length === 0) throw new HttpError(400, "slugs must contain at least one challenge")
            const all = await challenges()
            const selected: Challenge[] = []
            for (const slug of new Set(slugs)) {
              const found = all.find((item) => item.slug === slug)
              if (!found) throw new HttpError(404, `No such challenge: ${slug}`)
              selected.push(found)
            }
            const settings = persisted.settings
            const {
              economyModel,
              strongModel,
              tokens,
              repeats,
              minutes,
              flagFormat,
              executionMode,
              consultModels,
              blindReview,
              consultOnCompaction,
            } = settings
            const model = strongModel
            const models: Record<string, string> = {}
            const workspaces: Record<string, string> = {}
            const requestedRunIDs =
              input.runIDs && typeof input.runIDs === "object"
                ? (input.runIDs as Record<string, unknown>)
                : {}
            const nextChallenges = { ...persisted.challenges }
            for (const item of selected) {
              models[item.slug] = strongModel
              const nextChallenge = { ...(nextChallenges[item.slug] ?? {}) }
              delete nextChallenge.state
              nextChallenges[item.slug] = nextChallenge
              if (input.newTask !== true) {
                const history = await readChallengeRuns(root, item.slug)
                const requested = requestedRunIDs[item.slug]
                const resumable =
                  typeof requested === "string"
                    ? history.find((run) => run.id === requested)
                    : [...history]
                        .reverse()
                        .find(
                          (run) =>
                            run.taskStatus !== "archived" &&
                            nextChallenge.confirmed?.runID !== run.id,
                        )
                if (typeof requested === "string" && !resumable)
                  throw new HttpError(404, `No such task: ${item.slug}/${requested}`)
                if (resumable) workspaces[item.slug] = resumable.id
              }
            }
            const queued = await runner.enqueue({
              challenges: selected,
              model,
              models,
              modelPolicy: { economy: economyModel, strong: strongModel },
              consultModels,
              blindReview,
              consultOnCompaction,
              limits: { tokens, repeats, timeout: minutes * 60_000, silenceMs: DEFAULT_SILENCE_MS },
              flagFormat,
              hint: typeof input.hint === "string" ? input.hint : undefined,
              workspaces,
              ...(typeof input.environmentProfileId === "string"
                ? { environmentProfileId: input.environmentProfileId }
                : {}),
              ...(input.environmentProfileIds && typeof input.environmentProfileIds === "object"
                ? { environmentProfileIds: input.environmentProfileIds as Record<string, string> }
                : {}),
              ...(input.executionMode === "managed" || input.executionMode === "isolated" || input.executionMode === "static-only"
                ? { executionMode: input.executionMode }
                : { executionMode }),
            })
            const nextPersisted: RootGuiState = {
              settings: persisted.settings,
              challenges: nextChallenges,
            }
            await saveRootGuiState(root, nextPersisted)
            persisted = nextPersisted
            return json({ queued }, 202)
          })
        }

        if (request.method === "POST" && url.pathname === "/api/consultations") {
          const input = await body(request)
          return await exclusive(async () => {
            if (typeof input.slug !== "string") throw new HttpError(400, "slug must be a string")
            const found = await challenge(input.slug)
            const expertModels = Array.isArray(input.expertModels)
              ? input.expertModels.filter((item): item is string => typeof item === "string")
              : []
            if (
              expertModels.length < CONSULT_EXPERTS.minimum ||
              expertModels.length > CONSULT_EXPERTS.maximum ||
              expertModels.some((model) => !model.includes("/"))
            )
              throw new HttpError(
                400,
                `expertModels must contain ${CONSULT_EXPERTS.minimum}-${CONSULT_EXPERTS.maximum} ` +
                  "provider/model values",
              )
            const solverModel =
              typeof input.model === "string"
                ? input.model
                : persisted.settings.strongModel
            const synthesizerModel =
              typeof input.synthesizerModel === "string"
                ? input.synthesizerModel
                : persisted.settings.strongModel
            if (!solverModel.includes("/"))
              throw new HttpError(400, "model must be provider/model")
            if (!synthesizerModel.includes("/"))
              throw new HttpError(400, "synthesizerModel must be provider/model")
            const runs = await readChallengeRuns(root, found.slug)
            const requestedRunID =
              typeof input.sourceRunID === "string" ? input.sourceRunID : undefined
            const source = requestedRunID
              ? runs.find((run) => run.id === requestedRunID)
              : [...runs]
                  .reverse()
                  .find(
                    (run) =>
                      run.taskStatus !== "archived" &&
                      persisted.challenges[found.slug]?.confirmed?.runID !== run.id,
                  )
            if (requestedRunID && !source)
              throw new HttpError(404, `No such source run: ${requestedRunID}`)
            const continuationTriggers = new Set(["stalled", "budget", "error"])
            const trigger =
              source && continuationTriggers.has(source.stop)
                ? (source.stop as "stalled" | "budget" | "error")
                : source
                  ? "manual"
                  : "planning"
            const tokens = positive(input.tokens ?? persisted.settings.tokens, "tokens")
            const repeats = positive(input.repeats ?? persisted.settings.repeats, "repeats", 2)
            const minutes = positive(input.minutes ?? persisted.settings.minutes, "minutes")
            const flagFormat =
              typeof input.flagFormat === "string"
                ? input.flagFormat
                : persisted.settings.flagFormat
            if (flagFormat !== "") {
              try {
                new RegExp(flagFormat)
              } catch {
                throw new HttpError(400, "flagFormat is not a valid regular expression")
              }
            }
            const queued = await runner.enqueue({
              challenges: [found],
              model: solverModel,
              models: { [found.slug]: solverModel },
              modelPolicy: {
                economy: persisted.settings.economyModel,
                strong: persisted.settings.strongModel,
              },
              consultModels: persisted.settings.consultModels,
              blindReview: persisted.settings.blindReview,
              consultOnCompaction: persisted.settings.consultOnCompaction,
              limits: { tokens, repeats, timeout: minutes * 60_000, silenceMs: DEFAULT_SILENCE_MS },
              flagFormat,
              ...(source ? { workspaces: { [found.slug]: source.id } } : {}),
              consultation: {
                trigger,
                expertModels: expertModels as [string, string],
                synthesizerModel,
                sourceRunID: source?.id,
                sourceNotes: source?.notes,
                stopDetail: source?.detail,
              },
            })
            const nextChallenge = {
              ...(persisted.challenges[found.slug] ?? {}),
            }
            delete nextChallenge.state
            persisted.challenges[found.slug] = nextChallenge
            await saveRootGuiState(root, persisted)
            return json({ queued, trigger }, 202)
          })
        }

        if (request.method === "POST" && url.pathname === "/api/flags") {
          const input = await body(request)
          return await exclusive(async () => {
            if (typeof input.slug !== "string") throw new HttpError(400, "slug must be a string")
            if (typeof input.runID !== "string") throw new HttpError(400, "runID must be a string")
            if (typeof input.flag !== "string" || input.flag.trim() === "")
              throw new HttpError(400, "flag must be a non-empty string")
            if (typeof input.correct !== "boolean")
              throw new HttpError(400, "correct must be a boolean")
            const found = await challenge(input.slug)
            const runs = await readChallengeRuns(root, found.slug)
            const selected = runs.find((run) => run.id === input.runID)
            if (!selected) throw new HttpError(404, `No such task: ${found.slug}/${input.runID}`)
            const flag = input.flag.trim()
            if (
              !selected.candidates.includes(flag) &&
              selected.primaryCandidate !== flag &&
              !selected.candidateHistory?.includes(flag)
            )
              throw new HttpError(400, "flag is not a candidate from this task")
            const directory = await assertPathWithin(
              root,
              path.join(root, "runs", found.slug, selected.id),
            )
            const legacyStops = new Set([
              "completed",
              "budget",
              "stalled",
              "error",
              "empty",
              "timeout",
              "aborted",
            ])
            await loadOrCreateTask(directory, {
              id: selected.id,
              slug: found.slug,
              model: selected.model,
              createdAt: selected.startedAt,
              legacyTurn:
                selected.startedAt && selected.finishedAt && legacyStops.has(selected.stop)
                  ? {
                      id: "legacy-1",
                      model: selected.model,
                      startedAt: selected.startedAt,
                      finishedAt: selected.finishedAt,
                      stop: selected.stop as
                        | "completed"
                        | "budget"
                        | "stalled"
                        | "error"
                        | "empty"
                        | "timeout"
                        | "aborted",
                      tokens: selected.tokens,
                      billableTokens: selected.billableTokens,
                      cost: selected.cost,
                      candidates: selected.candidates,
                      ...(selected.primaryCandidate
                        ? { primaryCandidate: selected.primaryCandidate }
                        : {}),
                      ...(selected.detail ? { detail: selected.detail } : {}),
                    }
                  : undefined,
            })

            if (input.correct) {
              await acceptTaskFlag({
                directory,
                flag,
                source: "user",
                detail: "User confirmed candidate outside the solver workspace",
              })
              broadcast({
                at: Date.now(),
                type: "task.flag-accepted",
                slug: found.slug,
                runID: selected.id,
              })
              return json({ ok: true }, 202)
            }

            await rejectTaskFlag(directory, flag)
            const settings = persisted.settings
            const model = settings.strongModel
            const queued = await runner.enqueue({
              challenges: [found],
              model,
              models: { [found.slug]: model },
              modelPolicy: {
                economy: settings.economyModel,
                strong: settings.strongModel,
              },
              consultModels: settings.consultModels,
              blindReview: settings.blindReview,
              consultOnCompaction: settings.consultOnCompaction,
              workspaces: { [found.slug]: selected.id },
              limits: {
                tokens: settings.tokens,
                repeats: settings.repeats,
                timeout: settings.minutes * 60_000,
                silenceMs: DEFAULT_SILENCE_MS,
              },
              flagFormat: settings.flagFormat,
              hint: [
                `用户已人工确认候选 flag ${JSON.stringify(flag)} 不正确。`,
                "不要再次提交这个候选；结合 NOTES.md 中的记录检查推导或验证环节，然后继续完成原目标。",
                typeof input.hint === "string" ? input.hint.trim() : "",
              ]
                .filter(Boolean)
                .join("\n"),
            })
            broadcast({
              at: Date.now(),
              type: "task.flag-rejected",
              slug: found.slug,
              runID: selected.id,
            })
            return json({ ok: true, queued }, 202)
          })
        }

        if (request.method === "POST" && url.pathname === "/api/runs/writeup") {
          const input = await body(request)
          return await exclusive(async () => {
            if (typeof input.slug !== "string") throw new HttpError(400, "slug must be a string")
            if (typeof input.runID !== "string") throw new HttpError(400, "runID must be a string")
            const found = await challenge(input.slug)
            const runs = await readChallengeRuns(root, found.slug)
            const selected = runs.find((run) => run.id === input.runID)
            if (!selected) throw new HttpError(404, `No such task: ${found.slug}/${input.runID}`)
            const directory = await assertPathWithin(
              root,
              path.join(root, "runs", found.slug, selected.id),
            )
            const task = await loadOrCreateTask(directory, {
              id: selected.id,
              slug: found.slug,
              model: selected.model,
              createdAt: selected.startedAt,
            })
            const accepted = task.acceptedFlag?.value
            if (!accepted)
              throw new HttpError(400, "任务没有已确认的 flag；Writeup 需要先接受一个候选")
            if (task.status === "archived")
              throw new HttpError(400, "任务已归档，Writeup 已完成")
            const settings = persisted.settings
            const queued = await runner.enqueue({
              challenges: [found],
              model: settings.economyModel,
              models: { [found.slug]: settings.economyModel },
              modelPolicy: {
                economy: settings.economyModel,
                strong: settings.strongModel,
              },
              purpose: "writeup",
              consultOnCompaction: settings.consultOnCompaction,
              workspaces: { [found.slug]: selected.id },
              limits: {
                tokens: settings.tokens,
                repeats: settings.repeats,
                timeout: settings.minutes * 60_000,
                silenceMs: DEFAULT_SILENCE_MS,
              },
              flagFormat: settings.flagFormat,
              hint: `已确认 flag：${accepted}。只生成中文的最终可复现 WRITEUP.md，完成后归档。`,
            })
            broadcast({
              at: Date.now(),
              type: "run.writeup.queued",
              slug: found.slug,
              runID: selected.id,
            })
            return json({ ok: true, queued }, 202)
          })
        }

        if (request.method === "POST" && url.pathname === "/api/runs/stop") {
          const input = await body(request)
          if (input.slug !== undefined && typeof input.slug !== "string")
            throw new HttpError(400, "slug must be a string")
          return json({ stopped: runner.stop(input.slug as string | undefined) })
        }

        if (request.method === "POST" && url.pathname === "/api/challenges/import") {
          const input = await body(request)
          return await exclusive(async () => {
            if (typeof input.source !== "string") throw new HttpError(400, "source must be a directory path")
            const source = await canonicalDirectory(input.source)
            const slug = path.basename(source)
            if (slug === "" || slug.startsWith("."))
              throw new HttpError(400, "Imported directory has an invalid name")
            if (input.category !== undefined && typeof input.category !== "string")
              throw new HttpError(400, "category must be a string")
            const category = normalizeChallengeCategory(
              typeof input.category === "string" ? input.category : path.basename(path.dirname(source)),
            )
            const destination = path.join(root, "challenges", category, slug)
            if (containsPath(source, destination) || containsPath(destination, source))
              throw new HttpError(400, "Import source and destination must not contain one another")
            await assertPathWithin(root, destination, true)
            if (await lstat(destination).catch(() => undefined))
              throw new HttpError(409, `Challenge already exists: ${slug}`)
            try {
              await copyTree(source, destination)
              const imported = (await discoverChallenges(root)).some((item) => item.slug === slug)
              if (!imported) throw new Error(`Imported directory was not discovered as a challenge: ${slug}`)
            } catch (error) {
              await removeTree(root, destination).catch(() => {})
              throw error
            }
            broadcast({ at: Date.now(), type: "challenge.imported", slug, category })
            return json({ slug, category }, 201)
          })
        }

        const resetMatch = /^\/api\/challenges\/([^/]+)\/runs$/.exec(url.pathname)
        if (request.method === "DELETE" && resetMatch) {
          const slug = decodeSegment(resetMatch[1]!)
          return await exclusive(async () => {
            await challenge(slug)
            if (runner.getTransientRuns(slug).length > 0)
              throw new HttpError(409, `Stop ${slug} before deleting its runs`)
            await removeTree(root, path.join(root, "runs", slug))
            broadcast({ at: Date.now(), type: "challenge.runs.deleted", slug })
            return json({ ok: true })
          })
        }

        if (request.method === "DELETE" && patchMatch) {
          const slug = decodeSegment(patchMatch[1]!)
          const input = await body(request)
          return await exclusive(async () => {
            const found = await challenge(slug)
            if (input.confirm !== true) throw new HttpError(400, "confirm must be true")
            if (runner.getTransientRuns(slug).length > 0)
              throw new HttpError(409, `Stop ${slug} before deleting it`)
            const challengeTarget = found.sourceDirectory ?? found.directory
            const runsTarget = path.join(root, "runs", slug)
            await destructiveTarget(root, challengeTarget)
            await destructiveTarget(root, runsTarget)
            await removeTree(root, challengeTarget)
            await removeTree(root, runsTarget)
            delete persisted.challenges[slug]
            await saveRootGuiState(root, persisted)
            broadcast({ at: Date.now(), type: "challenge.deleted", slug })
            return json({ ok: true })
          })
        }

        if (request.method === "POST" && url.pathname === "/api/open") {
          const input = await body(request)
          if (input.kind !== "work" && input.kind !== "file")
            throw new HttpError(400, "kind must be work or file")
          if (typeof input.slug !== "string") throw new HttpError(400, "slug must be a string")
          const found = await challenge(input.slug)
          const runs = await readChallengeRuns(root, found.slug)
          const requestedID = typeof input.runID === "string" ? input.runID : undefined
          const selectedRun = requestedID
            ? runs.find((run) => run.id === requestedID)
            : runs[runs.length - 1]
          let target: string
          if (input.kind === "work") {
            if (!selectedRun) throw new HttpError(404, `No run found for ${found.slug}`)
            target = await assertPathWithin(
              root,
              path.join(root, "runs", found.slug, selectedRun.id, "work"),
            )
          } else {
            if (typeof input.path !== "string" || input.path === "")
              throw new HttpError(400, "path is required when kind is file")
            const base = selectedRun
              ? path.join(root, "runs", found.slug, selectedRun.id)
              : found.directory
            target = await assertPathWithin(base, path.join(base, input.path))
          }
          await openExternal(target)
          return json({ ok: true })
        }

        return json({ error: "Not found" }, 404)
      } catch (error) {
        const unsafePath =
          error instanceof Error && /(?:Path escapes|symbolic link)/i.test(error.message)
        const conflict =
          error instanceof Error &&
          /(?:already running|already queued|Duplicate challenge|Cannot change providers|Cannot change armor prompts|Cannot change MCP|Cannot test MCP|Cannot authenticate MCP)/i.test(
            error.message,
          )
        const invalidConfiguration =
          error instanceof Error &&
          /(?:Invalid provider|Invalid armor prompt|Invalid MCP|Provider Base URL|Custom provider requires|No such armor prompt|No such MCP)/i.test(
            error.message,
          )
        const status = error instanceof HttpError
          ? error.status
          : unsafePath || invalidConfiguration
            ? 400
            : conflict
              ? 409
              : 500
        return json({ error: error instanceof Error ? error.message : String(error) }, status)
      }
    },
  })

  if (!options.runner && options.startRuntime !== false) void runner.ensureRuntime().catch(() => {})
  const heartbeat = setInterval(() => {
    const packet = encoder.encode(`: heartbeat ${Date.now()}\n\n`)
    for (const client of [...clients]) {
      try {
        client.enqueue(packet)
      } catch {
        clients.delete(client)
      }
    }
  }, 15_000)
  const url = server.url.toString()
  if (options.open !== false) void openExternal(url)

  return {
    server,
    url,
    runner,
    async close() {
      if (closing) return
      closing = true
      // Stop accepting new requests before draining jobs so close is a real lifecycle barrier.
      void server.stop(true)
      clearInterval(heartbeat)
      unsubscribe()
      for (const client of clients) {
        try {
          client.close()
        } catch {
          // Already disconnected.
        }
      }
      clients.clear()
      await runner.close()
      // Bun can keep the returned stop promise pending while fetch's pooled loopback sockets drain.
      // Force closure immediately; callers only need the stop request to have been issued.
      void server.stop(true)
    },
  }
}
