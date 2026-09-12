import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { randomBytes, timingSafeEqual } from "node:crypto"
import os from "node:os"
import path from "node:path"
import {
  discoverChallenges,
  normalizeChallengeCategory,
  prepareWorkspaceRoot,
  resolveChallengeCatalog,
  updateChallengeRemote,
  type Challenge,
} from "./challenge.ts"
import {
  addChallengeAttachments,
  createChallengeInCatalog,
  readAnswer,
  removeChallengeAttachment,
  updateChallengeInCatalog,
} from "./challenge-store.ts"
import { boomBackupsDirectory } from "./boom-home.ts"
import {
  boomHomeDirectory,
  loadLastGuiRoot,
  loadRootGuiState,
  saveLastGuiRoot,
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
  taskDirectoryFromRoot,
  type RunHistory,
} from "./history.ts"
import { LEGACY_ENGAGEMENTS_DIR, legacyRunsRoot, TASKS_DIR, taskSlugRoot, tasksRoot } from "./task-layout.ts"
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
import { CompetitionAutopilot, type AutopilotCycleResult } from "./competition/autopilot.ts"
import {
  activePlatformAdapterEntry,
  clearCompetitionAdapterCache,
  findPlatformAdapterEntry,
  loadCompetitionAdapter,
  platformAdapterSummaries,
} from "./platform/registry.ts"
import { normalizeCompetitionSettings } from "./competition/policy.ts"
import {
  addAsset,
  addEvidence,
  addFinding,
  confirmFlagSubmission,
  addObservation,
  confirmFinding,
  createEngagement,
  deleteEngagement,
  listEngagements,
  listToolRuns,
  loadEngagement,
  rejectFinding,
  rejectFlagSubmission,
  updateEngagement,
  type PentestEngagementInput,
  type PentestToolRun,
} from "./pentest/store.ts"
import { PentestToolJobManager, pentestToolInstalled } from "./pentest/tool-jobs.ts"
import { PentestAgentManager, type PentestActivityEntry } from "./pentest/agent.ts"
import { parseAgentRunState } from "./pentest/model.ts"
import { probePentestTools } from "./pentest/environment.ts"
import { findPentestPreset, findPentestTool, PENTEST_TOOLS } from "./pentest/presets.ts"
import { normalizeNmapRun } from "./pentest/adapters/nmap.ts"
import { registerBoomControlPlaneOrigin } from "./runtime.ts"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
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
  | "requestConsultation"
  | "stop"
  | "getTransientRuns"
  | "switchTaskEnvironment"
  | "ensureRuntime"
  | "close"
> & {
  /**
   * Competition scheduling, optional so a test backend can omit it. The real runner always provides
   * both; a backend without them simply runs without match-clock and environment-slot awareness.
   */
  setCompetitionSettings?: GuiRunner["setCompetitionSettings"]
  getCompetitionState?: GuiRunner["getCompetitionState"]
  closeAllEnvironments?: GuiRunner["closeAllEnvironments"]
}

export type StartGuiOptions = {
  /** Explicit workspace root; absent reopens the remembered root or Boom's first-run default. */
  root?: string
  hostname?: string
  port?: number
  open?: boolean
  runner?: GuiRunnerBackend
  startRuntime?: boolean
  /** Host-wide network switch handed to the runner; "deny" isolates tool sandboxes. */
  network?: "allow" | "deny"
  /**
   * Require the per-installation GUI token on every request (default true). Tests disable this to
   * exercise handlers directly; production always authenticates local callers.
   */
  tokenAuth?: boolean
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

/** Optional free-text field from a request body: absent, null, and "" all mean "not provided". */
function optionalText(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > 20_000) throw new HttpError(400, `${field} is too long`)
  return trimmed === "" ? undefined : trimmed
}

function serviceRemote(value: unknown) {
  // Absent (create, or a PATCH that does not mention the field) and explicit null (clear) both
  // mean "no endpoint"; only a non-string, non-null value is a caller mistake.
  if (value === null || value === undefined) return undefined
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
  const visionModel =
    typeof input.visionModel === "string" ? input.visionModel : fallback.visionModel
  if (!economyModel.includes("/"))
    throw new HttpError(400, "economyModel must be provider/model")
  if (!strongModel.includes("/"))
    throw new HttpError(400, "strongModel must be provider/model")
  if (visionModel !== "" && !visionModel.includes("/"))
    throw new HttpError(400, "visionModel must be empty or provider/model")
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
  const tokenBudgetEnabled =
    typeof input.tokenBudgetEnabled === "boolean"
      ? input.tokenBudgetEnabled
      : fallback.tokenBudgetEnabled
  const network = input.network === "deny" ? "deny" : "allow"
  // An explicit mode always wins so the top-bar switch can move in both directions; the fallback
  // only fills in roots whose saved state predates the mode axis.
  const mode = input.mode === "pentest" || input.mode === "ctf"
    ? input.mode
    : fallback.mode === "pentest"
      ? "pentest"
      : "ctf"
  // Local concurrency is a normal runtime setting. Keep the competition admission mirror aligned
  // with it so this specialized panel never creates a second, conflicting local-concurrency knob.
  const competition = {
    ...normalizeCompetitionSettings(input.competition, fallback.competition),
    localSlots: concurrency,
  }
  return {
    mode,
    economyModel,
    strongModel,
    visionModel,
    tokens,
    tokenBudgetEnabled,
    repeats,
    minutes,
    competition,
    concurrency,
    flagFormat,
    executionMode,
    consultModels,
    blindReview,
    consultOnCompaction,
    network,
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

async function staticWebAsset(pathname: string) {
  if (!webReady) return undefined
  const assetPath = path.normalize(path.join(WEB_DIST, pathname))
  if (!containsPath(WEB_DIST, assetPath)) return undefined
  const file = Bun.file(assetPath)
  if (!(await file.exists())) return undefined
  return new Response(file, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

/**
 * Keep the local host alive when a streaming client drops a rejection on the floor.
 *
 * Aborting a runtime turn is a normal operation (pause, stop, budget), but the OpenCode SDK's
 * event-stream reader cancels its body with a bare `void reader.cancel()`. That cancel rejects as
 * soon as the same abort has already errored the stream, so the rejection belongs to nobody. Bun's
 * default is to exit the process on an unhandled rejection, which used to kill the whole GUI inside
 * the pause request that caused the abort: the browser reported a bare connection failure
 * ("Load failed"), the engagement stayed on "pausing" with no live run to finish it, and the
 * runtime child was left orphaned.
 *
 * A request-serving host must outlive a dependency's dropped rejection, so it logs every one
 * loudly instead of dying; genuine bugs stay visible in the host log. Installation is idempotent
 * because one process may host several server instances over its lifetime.
 */
const REJECTION_GUARD = Symbol.for("boom.gui.rejectionGuard")

export function guardUnhandledRejections(
  emitter: { on: (event: string, listener: (reason: unknown, promise: unknown) => void) => unknown } = process,
  report: (message: string) => void = (message) => console.error(message),
) {
  const target = emitter as { [REJECTION_GUARD]?: boolean }
  if (target[REJECTION_GUARD]) return
  target[REJECTION_GUARD] = true
  emitter.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    report(`Boom GUI 忽略了未处理的 Promise 拒绝并继续运行：\n${detail}`)
  })
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
  const processHandle = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // Spread at call time: Bun snapshots the parent environment at startup, so a child spawned
    // without an explicit env would miss PATH edits made after Boom started.
    env: { ...process.env } as Record<string, string>,
  })
  void processHandle.exited
}

/**
 * One workspace archive name: a plain file name, so a typed name can never walk out of the backup
 * directory. Dots are fine in the middle; a leading one would hide the file, and `..` is refused.
 */
function validBackupName(name: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !name.includes("..")
}

/** Readable default name: the workspace folder plus the UTC stamp runs already use. */
function defaultBackupName(root: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  const label = path.basename(path.resolve(root)).replace(/[^A-Za-z0-9._-]/g, "-") || "workspace"
  return `${label}-${stamp}`
}

/**
 * Archive one whole workspace as `$BOOM_HOME/backups/<name>.tar.gz`.
 *
 * The backup lives outside the workspace so it survives the "clear workspace" it exists to precede,
 * and so a later backup never contains an earlier one. A failed or hung `tar` removes its partial
 * file: a half-written archive that looks complete is worse than no archive.
 */
async function createWorkspaceBackup(root: string, name: string) {
  const directory = boomBackupsDirectory()
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, `${name}.tar.gz`)
  if (await lstat(target).catch(() => undefined)) throw new HttpError(409, "Backup already exists")
  let child: Bun.Subprocess<"ignore", "ignore", "pipe">
  try {
    child = Bun.spawn(["tar", "-czf", target, "-C", root, "."], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env } as Record<string, string>,
    })
  } catch {
    throw new HttpError(500, "Cannot run tar; install it or back the workspace up manually")
  }
  const exit = await Promise.race([
    child.exited,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), BACKUP_TIMEOUT_MS).unref?.()),
  ])
  if (exit === undefined) {
    child.kill("SIGTERM")
    await rm(target, { force: true }).catch(() => {})
    throw new HttpError(500, `Backup timed out after ${Math.round(BACKUP_TIMEOUT_MS / 60_000)} minutes`)
  }
  if (exit !== 0) {
    const detail = await new Response(child.stderr).text().catch(() => "")
    await rm(target, { force: true }).catch(() => {})
    throw new HttpError(500, `Backup failed: ${detail.trim() || `tar exited ${exit}`}`)
  }
  return { path: target, bytes: (await stat(target)).size }
}

/** How long one workspace archive may take before Boom kills it and drops the partial file. */
const BACKUP_TIMEOUT_MS = 30 * 60_000

/** Boom-owned data under a workspace root: the challenge catalog, task trees, and answers. */
async function workspaceDataTargets(root: string) {
  const targets = new Set<string>([
    path.join(root, "challenges"),
    tasksRoot(root),
    legacyRunsRoot(root),
    path.join(root, LEGACY_ENGAGEMENTS_DIR),
    path.join(root, "eval"),
  ])
  // A traditional catalog keeps category folders (WEB/, PWN/, MISC/) directly in the root. Only the
  // challenge directories inside them are Boom's; the category folder itself may hold other work.
  const catalog = await resolveChallengeCatalog(root)
  if (catalog.atRoot) {
    for (const challenge of await discoverChallenges(root).catch(() => []))
      targets.add(challenge.sourceDirectory ?? challenge.directory)
  }
  return [...targets]
}

/**
 * Delete Boom's data from one workspace and rebuild the empty skeleton.
 *
 * Operator files that Boom does not own — a writeup, a wordlist, an unrelated folder — are left
 * where they are: "clear" means "start this workspace over", not "delete whatever is in this folder".
 */
async function clearWorkspaceData(root: string) {
  const removed: string[] = []
  for (const target of await workspaceDataTargets(root)) {
    let safe: string
    try {
      safe = await assertPathWithin(root, target, true)
    } catch {
      continue
    }
    const info = await lstat(safe).catch(() => undefined)
    if (!info) continue
    await rm(safe, { recursive: true, force: true })
    removed.push(path.relative(root, safe) || ".")
  }
  await prepareWorkspaceRoot(root)
  return removed
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

/**
 * Every store that may hold tasks of one slug: the current `tasks/<slug>/` tree plus the legacy
 * `runs/<slug>/` store. Callers that delete or inspect all of a challenge's tasks use both.
 */
function slugStores(root: string, slug: string) {
  return [taskSlugRoot(root, slug), path.join(legacyRunsRoot(root), slug)]
}

/**
 * Opening Boom is intentionally stationary. A saved "running" bit from an earlier process must
 * never synchronize or solve before the operator presses the main "开始比赛" button.
 */
function stationaryRootState(state: RootGuiState): RootGuiState {
  if (state.settings.competition.autopilotEnabled !== true) return state
  return {
    ...state,
    settings: {
      ...state.settings,
      competition: normalizeCompetitionSettings(
        { ...state.settings.competition, autopilotEnabled: false },
        state.settings.competition,
      ),
    },
  }
}

const GUI_COOKIE = "boom_gui"

/** Directory holding gui-state.json; the GUI token lives beside it under the same BOOM_HOME rule. */
function boomStateHome() {
  return boomHomeDirectory()
}

/**
 * Load the per-installation GUI token, creating a random one on first use.
 *
 * Loopback binding plus origin checks keep remote browsers out but not local processes: any task
 * agent or script on the machine could previously call the API anonymously. This token is the
 * bearer credential for those callers; it is stored 0600 next to gui-state.json so only the
 * operating user (and processes they already trust) can read it, and it survives restarts so
 * browser sessions keep working across Boom upgrades within one installation.
 */
async function loadOrCreateGuiToken(stateHome: string) {
  const target = path.join(stateHome, ".gui-token")
  const existing = (await readFile(target, "utf8").catch(() => "")).trim()
  if (/^[0-9a-f]{48}$/.test(existing)) return existing
  const token = randomBytes(24).toString("hex")
  await mkdir(stateHome, { recursive: true })
  // Atomic replace like gui-state so a concurrent reader never observes a partial token.
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, target)
  // Defense in depth: keep 0600 even when a umask or a pre-existing wider file loosened the mode.
  await chmod(target, 0o600).catch(() => {})
  return token
}

function guiCookieValue(request: Request, name: string) {
  const header = request.headers.get("cookie")
  if (!header) return undefined
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator === -1) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return undefined
}

function guiTokenMatches(supplied: string | null | undefined, expected: string) {
  if (!supplied) return false
  const left = encoder.encode(supplied)
  const right = encoder.encode(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Minimal unauthenticated page for document navigations; points at the startup banner URL. */
function unauthenticatedGuiPage() {
  return new Response(
    `<!doctype html><html lang="zh"><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Boom GUI 需要访问令牌</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;line-height:1.6;color:#1f2430">` +
    `<h1>401 · 需要 Boom GUI 访问令牌</h1>` +
    `<p>本机其他进程不允许匿名访问 Boom GUI。请使用 Boom 启动时控制台输出的带 <code>?token=…</code> 的完整地址重新打开本页面。</p>` +
    `</body></html>`,
    {
      status: 401,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    },
  )
}

/**
 * Resolve a workspace root to its real path, initializing a missing one first so opening any
 * folder works on the first start. Preparation precedes canonicalization because realpath
 * requires the directory to exist; both spellings denote the same directory even when an
 * ancestor is a symlink.
 */
async function resolveWorkspaceRoot(directory: string) {
  await prepareWorkspaceRoot(directory)
  return canonicalDirectory(directory)
}

/**
 * The default project folder: `~/BoomProject`, the visible, user-owned home of every task.
 *
 * It replaces the hidden `$BOOM_HOME/workspace` of earlier versions, where an operator could not
 * find, back up, or share their own work. `home` is injectable so tests never touch a real user's
 * home directory. Exported for tests; the GUI is the only caller.
 */
export function defaultProjectRoot(home = os.homedir()) {
  return path.join(home, "BoomProject")
}

/** The pre-`~/BoomProject` default, still recognized so its data is never abandoned silently. */
async function isLegacyDefaultRoot(directory: string) {
  return path.resolve(directory) === path.join(boomHomeDirectory(), "workspace")
}

/** True when a workspace root already holds tasks or a challenge catalog worth keeping. */
async function holdsProjectData(directory: string) {
  for (const name of [TASKS_DIR, "runs", "engagements", "challenges"]) {
    const entries = await readdir(path.join(directory, name)).catch(() => [])
    if (entries.length > 0) return true
  }
  return false
}

/**
 * Pick the workspace root the GUI opens on: an explicit `--root`, else the root remembered from the
 * last session, else `~/BoomProject`. The launch directory is deliberately never the fallback —
 * preparing a workspace there would create `tasks/` and `challenges/` inside whatever folder Boom
 * happened to start from, in both CTF and pentest mode.
 */
export async function resolveInitialWorkspaceRoot(
  requested: string | undefined,
  options: { home?: string } = {},
) {
  if (requested !== undefined && requested.trim() !== "") {
    const root = await resolveWorkspaceRoot(path.resolve(requested))
    await saveLastGuiRoot(root)
    return root
  }
  const remembered = await loadLastGuiRoot()
  if (remembered !== undefined) {
    // A remembered root that vanished (unmounted volume, deleted folder) falls through to the
    // default; existence is checked before preparation, which would otherwise resurrect it as an
    // empty scaffold. Re-preparing keeps tasks/ and challenges/ present even after manual cleanup.
    const info = await lstat(remembered).catch(() => undefined)
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      // The legacy hidden default is upgraded only when it holds nothing: a user who already solved
      // tasks there keeps them, everyone else lands in the visible `~/BoomProject`.
      if (!(await isLegacyDefaultRoot(remembered)) || await holdsProjectData(remembered)) {
        await prepareWorkspaceRoot(remembered)
        return canonicalDirectory(remembered)
      }
    }
  }
  const root = await resolveWorkspaceRoot(defaultProjectRoot(options.home))
  await saveLastGuiRoot(root)
  return root
}

/**
 * Storage whose contents originate from challenges or agents: run workspaces plus every challenge
 * directory. Interpreters inside them are rejected no matter how the path is spelled.
 */
async function workspaceTaskStorageRoots(workspace: string) {
  const found = await discoverChallenges(workspace)
  return [
    tasksRoot(workspace),
    legacyRunsRoot(workspace),
    ...found.map((item) => item.sourceDirectory ?? item.directory),
  ]
}

export async function startGuiServer(options: StartGuiOptions) {
  if (!webReady)
    throw new Error("Boom GUI 前端尚未构建；请先运行 bun run build:web")
  const hostname = options.hostname ?? "127.0.0.1"
  if (!LOOPBACK.has(hostname)) throw new Error(`Boom GUI only listens on loopback, got: ${hostname}`)
  // Installed before the first request so an aborted turn can never take the host down mid-response.
  guardUnhandledRejections()
  let root = await resolveInitialWorkspaceRoot(options.root)
  const loaded = await loadRootGuiState(root)
  let persisted = stationaryRootState(loaded)
  // Persisted settings win at startup; the CLI flag only seeds a root with no saved state yet.
  const runner: GuiRunnerBackend = options.runner ?? new GuiRunner(root, undefined, undefined, {
    network: options.network ?? persisted.settings.network,
  })
  runner.setConcurrency(persisted.settings.concurrency)
  runner.setCompetitionSettings?.(persisted.settings.competition)
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const instanceID = crypto.randomUUID()
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
    const event = { instanceID, sequence: ++sequence, ...value }
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

  /**
   * Host-managed penetration tool runs. Completion of a parseable run (nmap XML) triggers
   * normalization into the engagement's assets/observations and re-broadcasts, so the GUI and
   * later the agent see structured results without re-reading raw logs.
   */
  const pentestToolRunEvent = (slug: string, run: PentestToolRun) => {
    broadcast({ at: Date.now(), type: "pentest.toolrun.changed", engagement: slug, runId: run.id, status: run.status })
    if (run.status === "done" && run.parsed === undefined && findPentestTool(run.tool)?.parses === "nmap-xml") {
      void normalizeNmapRun(root, slug, run)
        .then((updated) => pentestToolRunEvent(slug, updated))
        .catch(() => {})
    }
  }
  const pentestJobs = new PentestToolJobManager({
    onEvent: (event) => pentestToolRunEvent(event.slug, event.run),
  })
  // Runs left "running" by a previous process are reaped as orphaned, not silently resumed.
  void pentestJobs.reapOrphans(root).catch(() => {})

  /**
   * Agent-driven engagement runs. The manager shares the GUI runner's runtime (one OpenCode child)
   * and the strong model from settings; every phase change is broadcast so the workspace follows
   * the run live. The root getter keeps a root switch from stranding a run on the old workspace.
   *
   * The optional consumption ceiling reuses the existing budget setting: when it is enabled, each
   * turn hands the runtime what is left of this manual run's allowance, and exhaustion lands on a
   * resumable pause instead of a failure. No second billing or budget system is introduced.
   */
  const pentestAgents = new PentestAgentManager({
    root: () => root,
    ensureRuntime: () => runner.ensureRuntime(),
    model: () => persisted.settings.strongModel,
    tokenBudget: () => (persisted.settings.tokenBudgetEnabled ? persisted.settings.tokens : undefined),
    onEvent: (slug) => {
      broadcast({ at: Date.now(), type: "pentest.agent.changed", engagement: slug })
    },
  })
  void pentestAgents.reapOrphans().catch(() => {})

  const challenges = async () => discoverChallenges(root)
  const challenge = async (slug: string) => {
    const found = (await challenges()).find((item) => item.slug === slug)
    if (!found) throw new HttpError(404, `No such challenge: ${slug}`)
    return found
  }

  const state = async () => {
    const snapshotSequence = sequence
    const stateRoot = root
    const statePersisted = persisted
    const found = await discoverChallenges(stateRoot)
    const models = await runner.getModels()
    const environments = await loadEnvironmentStore()
    return {
      instanceID,
      sequence: snapshotSequence,
      root: stateRoot,
      // The folder Boom opens on a first launch, so the workbench can name it and offer to return.
      defaultRoot: defaultProjectRoot(),
      settings: statePersisted.settings,
      models,
      runtime: runner.getRuntimeState(),
      environments,
      challenges: await Promise.all(
        found.map(async (item) => {
          const saved = statePersisted.challenges[item.slug]
          const history = await readChallengeRuns(stateRoot, item.slug, { files: false, eventTail: 120 })
          const runs = mergeTransient(history, runner.getTransientRuns(item.slug)).map((inputRun) => {
            const preserveWriteup =
              saved?.confirmed?.runID === inputRun.id ||
              inputRun.taskStatus === "solved" ||
              inputRun.taskStatus === "archived" ||
              !!inputRun.acceptedFlag ||
              !!inputRun.confirmedFlag
            const run = {
              ...summaryStateRun(inputRun),
              ...(preserveWriteup
                ? { writeup: boundedStateText(inputRun.writeup, 64_000) ?? "" }
                : {}),
            }
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
              stateRoot,
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

  const automaticEnvironmentProfile = async () => {
    const environments = await loadEnvironmentStore()
    const profileID = environments.defaultProfileId ?? environments.profiles[0]?.id
    const profile = profileID ? environments.profiles.find((item) => item.id === profileID) : undefined
    if (!profile)
      throw new HttpError(400, "无人值守解题需要先在设置中选择默认 Python 环境")
    if (profile.status !== "ready")
      throw new HttpError(400, `默认 Python 环境不可用：${profile.detail ?? profile.status}`)
    return profile.id
  }

  /**
   * Choose only untouched platform challenges, plus a small bounded retry allowance for a task that
   * ended in a runtime error. This prevents an unattended 10-minute poll from reviving manually
   * abandoned work, confirmed flags, or an irrecoverable task forever.
   */
  const automaticCandidate = async (item: Challenge) => {
    if (!item.platform || !findPlatformAdapterEntry(item.platform.adapter)) return undefined
    if (item.platform.options?.solved === true) return undefined
    const saved = persisted.challenges[item.slug]
    if (saved?.state || saved?.confirmed) return undefined
    if (runner.getTransientRuns(item.slug).length > 0) return undefined
    const history = await readChallengeRuns(root, item.slug, { files: false, eventTail: 20 })
    const previous = history.at(-1)
    if (!previous) return { challenge: item }
    if (previous.taskStatus === "archived" || previous.acceptedFlag || previous.confirmedFlag)
      return undefined
    const errorCount = history.filter((run) => run.stop === "error").length
    // The runner already attempts in-process recovery. Two later polling retries are enough to
    // cover a transient provider/runtime outage without repeatedly spending the match on one bad task.
    if (previous.stop === "error" && errorCount <= 2)
      return { challenge: item, workspace: previous.id }
    return undefined
  }

  const enqueueAutomatically = async (downloaded: Challenge[]): Promise<Pick<AutopilotCycleResult, "queued" | "skipped">> => {
    const profileID = await automaticEnvironmentProfile()
    const settings = persisted.settings
    let queued = 0
    let skipped = 0
    for (const item of downloaded) {
      let candidate: { challenge: Challenge; workspace?: string } | undefined
      try {
        candidate = await automaticCandidate(item)
      } catch (error) {
        skipped += 1
        broadcast({
          at: Date.now(),
          type: "competition.autopilot.challenge.skipped",
          slug: item.slug,
          detail: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      if (!candidate) {
        skipped += 1
        continue
      }
      try {
        await runner.enqueue({
          challenges: [candidate.challenge],
          model: settings.strongModel,
          models: { [candidate.challenge.slug]: settings.strongModel },
          modelPolicy: { economy: settings.economyModel, strong: settings.strongModel },
          visionModel: settings.visionModel,
          consultModels: settings.consultModels,
          blindReview: settings.blindReview,
          consultOnCompaction: settings.consultOnCompaction,
          limits: {
            ...(settings.tokenBudgetEnabled ? { tokens: settings.tokens } : {}),
            repeats: settings.repeats,
            timeout: settings.minutes * 60_000,
            silenceMs: DEFAULT_SILENCE_MS,
          },
          flagFormat: settings.flagFormat,
          environmentProfileId: profileID,
          executionMode: settings.executionMode,
          ...(candidate.workspace ? { workspaces: { [candidate.challenge.slug]: candidate.workspace } } : {}),
        })
        queued += 1
      } catch (error) {
        // One malformed challenge or temporarily unavailable model must not prevent later released
        // challenges from being admitted. The error is visible in the event stream but never escapes
        // the polling cycle.
        skipped += 1
        broadcast({
          at: Date.now(),
          type: "competition.autopilot.enqueue.failed",
          slug: candidate.challenge.slug,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { queued, skipped }
  }

  const synchronizePlatform = async (
    options: { signal?: AbortSignal; automatic?: boolean } = {},
    platformId?: string,
  ): Promise<AutopilotCycleResult & { slugs: string[] }> => {
    const entry = activePlatformAdapterEntry(platformId ?? persisted.settings.competition.platformId)
    const adapter = await loadCompetitionAdapter(entry.id)
    if (!adapter) throw new HttpError(400, `请先保存 ${entry.displayName} AccessKey`)
    const downloaded = await adapter.acquireChallenges({ root, signal: options.signal })
    const admission = options.automatic
      ? await enqueueAutomatically(downloaded)
      : { queued: 0, skipped: 0 }
    const result = { downloaded: downloaded.length, ...admission, slugs: downloaded.map((item) => item.slug) }
    broadcast({
      at: Date.now(),
      type: "platform.synced",
      challenges: downloaded.length,
      ...(options.automatic ? { autopilot: result } : {}),
    })
    return result
  }

  const autopilot = new CompetitionAutopilot({
    sync: (signal) => exclusive(() => synchronizePlatform({ signal, automatic: true })),
    intervalMs: (persisted.settings.competition.refreshIntervalMinutes ?? 10) * 60_000,
    // Unattended mode ends only when the operator stops it. The legacy clock remains readable for
    // old saved state, but it must not silently stop future catalog polling or solve admission.
    canRun: () => true,
    onState: (autopilotState) => {
      broadcast({ at: Date.now(), type: "competition.autopilot.changed", autopilot: autopilotState })
    },
  })

  const competitionState = () => ({
    ...(runner.getCompetitionState?.() ?? { unavailable: true }),
    autopilot: autopilot.state(),
  })

  const runDetail = async (
    detailRoot: string,
    detailPersisted: RootGuiState,
    slug: string,
    runID: string,
  ) => {
    const found = (await discoverChallenges(detailRoot)).find((item) => item.slug === slug)
    if (!found) throw new HttpError(404, `No such challenge: ${slug}`)
    const saved = detailPersisted.challenges[found.slug]
    const runs = mergeTransient(
      await readChallengeRuns(detailRoot, found.slug),
      runner.getTransientRuns(found.slug),
    )
    const selected = runs.find((run) => run.id === runID)
    if (!selected) throw new HttpError(404, `No such task: ${found.slug}/${runID}`)
    const run = boundedStateRun(selected)
    return saved?.confirmed?.runID === run.id
      ? { ...run, taskStatus: "archived" as const, confirmedFlag: saved.confirmed.flag }
      : run
  }

  // Loopback binding keeps remote browsers out, but without a credential any local process could
  // drive the API. The token is created once per installation and handed to callers exclusively
  // through the startup URL; tests may opt out via tokenAuth: false.
  const guiToken = options.tokenAuth === false ? undefined : await loadOrCreateGuiToken(boomStateHome())

  /**
   * Route one already-authenticated request. Extracted from Bun.serve so the fetch shell below can
   * gate every response this handler returns and seed the strict session cookie when credentials
   * arrived through the URL or a header instead of a cookie.
   */
  const route = async (request: Request, bunServer: { timeout(request: Request, seconds: number): void }): Promise<Response> => {
      const url = new URL(request.url)
      if (!LOOPBACK.has(url.hostname)) return json({ error: "Invalid Host header" }, 403)
      const origin = request.headers.get("origin")
      if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed" }, 403)
      if (request.method === "OPTIONS") return json({ error: "Cross-origin requests are not allowed" }, 403)
      if (closing) return json({ error: "Boom GUI is shutting down" }, 503)

      try {
        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          return new Response(Bun.file(WEB_INDEX), {
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
        if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
          const asset = await staticWebAsset(url.pathname)
          if (asset) return asset
        }
        if (request.method === "GET" && url.pathname === "/api/state") return json(await state())
        const runDetailMatch = /^\/api\/challenges\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname)
        if (request.method === "GET" && runDetailMatch) {
          const snapshotSequence = sequence
          const detailRoot = root
          const detailPersisted = persisted
          return json({
            instanceID,
            sequence: snapshotSequence,
            root: detailRoot,
            run: await runDetail(
              detailRoot,
              detailPersisted,
              decodeSegment(runDetailMatch[1]!),
              decodeSegment(runDetailMatch[2]!),
            ),
          })
        }
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
                    instanceID,
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
            const next = await resolveWorkspaceRoot(input.root)
            const nextLoaded = await loadRootGuiState(next)
            const nextPersisted = stationaryRootState(nextLoaded)
            autopilot.stop()
            await pentestJobs.stopAll()
            await pentestAgents.stopAll()
            runner.setRoot(next)
            runner.setConcurrency(nextPersisted.settings.concurrency)
            runner.setCompetitionSettings?.(nextPersisted.settings.competition)
            root = next
            persisted = nextPersisted
            // The operator just chose this folder; the next launch should reopen it, not the
            // previous one (and never the directory Boom happened to be started from).
            await saveLastGuiRoot(next)
            await pentestJobs.reapOrphans(root).catch(() => {})
            await pentestAgents.reapOrphans().catch(() => {})
            await runner.applyLiveModelSettings(nextPersisted.settings)
            broadcast({ at: Date.now(), type: "root.changed" })
            return json(await state())
          })
        }

        if (request.method === "PATCH" && url.pathname === "/api/settings") {
          const input = await body(request)
          return await exclusive(async () => {
            const settings = settingsFrom(input, persisted.settings)
            if (settings.visionModel) {
              const models = await runner.getModels()
              if (!models.some((model) =>
                model.id === settings.visionModel && model.connected && model.attachment === true
              )) throw new HttpError(400, "visionModel must be a connected image-capable model")
            }
            const nextPersisted: RootGuiState = { ...persisted, settings }
            await saveRootGuiState(root, nextPersisted)
            persisted = nextPersisted
            runner.setConcurrency(settings.concurrency)
            // Optional so an injected test backend need not implement the competition scheduler.
            runner.setCompetitionSettings?.(settings.competition)
            autopilot.setIntervalMs((settings.competition.refreshIntervalMinutes ?? 10) * 60_000)
            const switches = await runner.applyLiveModelSettings(settings)
            broadcast({ at: Date.now(), type: "settings.changed" })
            return json({ settings, switches })
          })
        }

        // Workspace maintenance: one archive of everything, and starting the workspace over.
        if (request.method === "POST" && url.pathname === "/api/workspace/backup") {
          const input = await body(request)
          return await exclusive(async () => {
            if (runner.hasWork()) throw new HttpError(409, "Stop active runs before backing up the workspace")
            const requested = typeof input.name === "string" ? input.name.trim() : ""
            if (requested !== "" && !validBackupName(requested))
              throw new HttpError(400, "Invalid backup name")
            const name = requested === "" ? defaultBackupName(root) : requested
            const backup = await createWorkspaceBackup(root, name)
            return json({ name, path: backup.path, bytes: backup.bytes })
          })
        }

        if (request.method === "POST" && url.pathname === "/api/workspace/clear") {
          const input = await body(request)
          return await exclusive(async () => {
            if (input.confirm !== true) throw new HttpError(400, "Clearing the workspace requires confirm: true")
            if (runner.hasWork()) throw new HttpError(409, "Stop active runs before clearing the workspace")
            autopilot.stop()
            await pentestJobs.stopAll()
            await pentestAgents.stopAll()
            const removed = await clearWorkspaceData(root)
            // Confirmations and per-challenge state point at task trees that no longer exist.
            const nextPersisted: RootGuiState = { ...persisted, challenges: {} }
            await saveRootGuiState(root, nextPersisted)
            persisted = nextPersisted
            broadcast({ at: Date.now(), type: "root.changed" })
            return json({ ok: true, root, removed })
          })
        }

        // Live match status: clock, environment slots, and current slot usage.
        if (request.method === "GET" && url.pathname === "/api/competition")
          return json(competitionState())

        // Start or clear the match clock. The deadline is what drives the endgame and give-up rules,
        // so it is set explicitly by the operator rather than guessed from the first run.
        if (request.method === "POST" && url.pathname === "/api/competition/clock") {
          const input = await body(request)
          if (input.action === "clear") autopilot.stop()
          return await exclusive(async () => {
            const current = persisted.settings.competition
            let deadline: number | undefined
            if (input.action === "start") {
              const minutes = typeof input.minutes === "number" && Number.isFinite(input.minutes)
                ? Math.floor(input.minutes)
                : current.matchMinutes
              if (minutes < 1) throw new HttpError(400, "minutes must be at least 1")
              deadline = Date.now() + minutes * 60_000
            } else if (input.action !== "clear") {
              throw new HttpError(400, "action must be start or clear")
            }
            // "clear" must actually drop the deadline, so build the object without it rather than
            // spreading an undefined over the existing value.
            const { deadline: _previous, ...rest } = current
            const competition = normalizeCompetitionSettings(
              deadline === undefined
                ? { ...rest, autopilotEnabled: false }
                : { ...rest, deadline },
              current,
            )
            const settings = { ...persisted.settings, competition }
            const nextPersisted: RootGuiState = { ...persisted, settings }
            await saveRootGuiState(root, nextPersisted)
            persisted = nextPersisted
            runner.setCompetitionSettings?.(competition)
            broadcast({ at: Date.now(), type: "competition.clock.changed" })
            return json(competitionState())
          })
        }

        /**
         * Main-screen start: arm the match clock and then let the process-lifetime autopilot fetch
         * immediately. It returns promptly; catalog acquisition and solving continue if the window
         * is closed or refreshed.
         */
        if (request.method === "POST" && url.pathname === "/api/competition/autopilot/start") {
          return await exclusive(async () => {
            const activeEntry = activePlatformAdapterEntry(persisted.settings.competition.platformId)
            if (!await activeEntry.credentials.loadAccessKey())
              throw new HttpError(400, "开始比赛前请先在比赛平台控制台保存 AccessKey")
            await automaticEnvironmentProfile()
            const current = persisted.settings.competition
            const { deadline: _legacyDeadline, ...withoutDeadline } = current
            const competition = normalizeCompetitionSettings({
              ...withoutDeadline,
              autopilotEnabled: true,
            }, current)
            const settings = { ...persisted.settings, competition }
            const nextPersisted: RootGuiState = { ...persisted, settings }
            await saveRootGuiState(root, nextPersisted)
            persisted = nextPersisted
            runner.setConcurrency(settings.concurrency)
            runner.setCompetitionSettings?.(competition)
            autopilot.setIntervalMs((competition.refreshIntervalMinutes ?? 10) * 60_000)
            const autopilotState = autopilot.start()
            broadcast({ at: Date.now(), type: "competition.autopilot.started", autopilot: autopilotState })
            return json({ competition: competitionState() }, 202)
          })
        }

        /** Stop active work and future polls, while retaining the clock for an intentional resume. */
        if (request.method === "POST" && url.pathname === "/api/competition/autopilot/stop") {
          // Do this outside the serialized mutation so a stop interrupts a slow sync immediately.
          const autopilotState = autopilot.stop()
          return await exclusive(async () => {
            const current = persisted.settings.competition
            const competition = normalizeCompetitionSettings({ ...current, autopilotEnabled: false }, current)
            const settings = { ...persisted.settings, competition }
            const nextPersisted: RootGuiState = { ...persisted, settings }
            await saveRootGuiState(root, nextPersisted)
            persisted = nextPersisted
            runner.setCompetitionSettings?.(competition)
            const stopped = runner.stop()
            broadcast({ at: Date.now(), type: "competition.autopilot.stopped", stopped, autopilot: autopilotState })
            return json({ stopped, competition: competitionState() })
          })
        }

        /**
         * Explicit operator kill switch: prevent the unattended loop from creating replacements,
         * then stop remote work and recover every target lease the runner currently owns.
         */
        if (request.method === "POST" && url.pathname === "/api/competition/environments/close") {
          const closeAllEnvironments = runner.closeAllEnvironments
          if (!closeAllEnvironments)
            throw new HttpError(501, "当前运行器不支持批量关闭靶机环境")
          const autopilotState = autopilot.stop()
          return await exclusive(async () => {
            const current = persisted.settings.competition
            const competition = normalizeCompetitionSettings({ ...current, autopilotEnabled: false }, current)
            const settings = { ...persisted.settings, competition }
            const nextPersisted: RootGuiState = { ...persisted, settings }
            await saveRootGuiState(root, nextPersisted)
            persisted = nextPersisted
            runner.setCompetitionSettings?.(competition)
            const closed = await closeAllEnvironments.call(runner)
            broadcast({
              at: Date.now(),
              type: "competition.environments.closed",
              detail: `已关闭 ${closed.released} 个靶机环境`,
            })
            return json({ closed, competition: competitionState(), autopilot: autopilotState })
          })
        }

        // Competition platform routes. The `:id` segment resolves through the adapter registry,
        // so one route set serves every built-in platform integration.
        // ---- Penetration mode: engagements, host-managed tool runs, and the record gates ----
        const pentestError = (error: unknown): HttpError =>
          error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : String(error))
        const stringOrUndefined = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined)

        if (request.method === "GET" && url.pathname === "/api/pentest/tools") {
          const hostTools = await probePentestTools().catch(() => [])
          return json({
            tools: PENTEST_TOOLS.map((tool) => ({
              name: tool.name,
              displayName: tool.displayName,
              parses: tool.parses,
              unattended: tool.unattended,
              ...(tool.note ? { note: tool.note } : {}),
              installed: pentestToolInstalled(tool.name),
              presets: tool.presets.map((preset) => ({
                id: preset.id,
                title: preset.title,
                description: preset.description,
              })),
            })),
            host: hostTools,
          })
        }

        if (request.method === "GET" && url.pathname === "/api/pentest/engagements")
          return json({ engagements: await listEngagements(root) })

        if (request.method === "POST" && url.pathname === "/api/pentest/engagements") {
          const input = await body(request)
          return await exclusive(async () => {
            // Minimal creation contract: one target, an authorization confirmation, and optional
            // free-form notes. The objective and the authorization record have defaults so the
            // operator never writes formatted declarations (docs/PENTEST_REWORK.md §4.1).
            const authorized = input.authorized === true
            const target = typeof input.target === "string" ? input.target : ""
            const notes = typeof input.notes === "string" && input.notes.trim() !== "" ? input.notes.trim() : undefined
            const scope = Array.isArray(input.scope)
              ? input.scope.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
              : []
            const mode = input.mode === "flag-hunt" ? "flag-hunt" : "assessment"
            const flags = Array.isArray(input.flags)
              ? input.flags.flatMap((item) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) return []
                const flag = item as Record<string, unknown>
                const label = typeof flag.label === "string" ? flag.label.trim() : ""
                if (!label) return []
                return [{ label, ...(typeof flag.hint === "string" && flag.hint.trim() ? { hint: flag.hint.trim() } : {}) }]
              })
              : []
            const engagementInput: PentestEngagementInput = {
              target,
              objective:
                typeof input.objective === "string" && input.objective.trim() !== ""
                  ? input.objective
                  : mode === "flag-hunt" ? "获取已声明的 Flag 并保留可验证证据" : "对目标进行授权安全测试",
              authorization:
                typeof input.authorization === "string" && input.authorization.trim() !== ""
                  ? input.authorization
                  : authorized
                    ? `创建时勾选授权确认 · ${new Date().toISOString()}`
                    : "",
              // The default scope is the target itself; extra entries only via advanced scope.
              scope: scope.length > 0 ? scope : [target],
              // The operator's notes are a fixed constraint: every turn re-states them, and no
              // newer observation can push them out (docs/PENTEST_AUTONOMY.md §3.3).
              ...(notes !== undefined ? { userNotes: notes } : {}),
              mode,
              flags,
            }
            try {
              if (!authorized) throw new HttpError(400, "必须勾选「我确认已获得该目标的测试授权」后才能创建任务")
              const engagement = await createEngagement(root, engagementInput)
              if (notes !== undefined)
                await addObservation(root, engagement.slug, {
                  kind: "info",
                  target: engagement.target,
                  detail: `用户补充说明：${notes}`,
                })
              broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: engagement.slug })
              return json({ engagement })
            } catch (error) {
              throw pentestError(error)
            }
          })
        }

        const pentestEngagementRoute = /^\/api\/pentest\/engagements\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(url.pathname)
        if (pentestEngagementRoute) {
          const slug = pentestEngagementRoute[1]
          const rest = pentestEngagementRoute[2] ?? ""
          const requireEngagement = async () => {
            try {
              return await loadEngagement(root, slug)
            } catch {
              throw new HttpError(404, `没有这个渗透任务: ${slug}`)
            }
          }
          const requireActiveEngagement = async () => {
            const engagement = await requireEngagement()
            if (engagement.status !== "active")
              throw new HttpError(409, engagement.status === "archived" ? "任务已归档，只读" : "任务已放弃；恢复后才能修改")
            return engagement
          }

          if (request.method === "GET" && rest === "") {
            const loaded = await requireEngagement()
            const run = parseAgentRunState(loaded.run)
            const activity = await pentestAgents.activityTail(slug).catch(() => [] as PentestActivityEntry[])
            const liveText = pentestAgents.liveText(slug)
            return json({
              engagement: loaded,
              toolRuns: await listToolRuns(root, slug),
              agent: {
                ...run,
                live: pentestAgents.isLive(slug),
                activity,
                ...(liveText !== "" ? { liveText } : {}),
              },
            })
          }

          if (request.method === "POST" && rest === "/agent/start") {
            return await exclusive(async () => {
              await requireActiveEngagement()
              try {
                await pentestAgents.start(slug)
                return json({ started: true })
              } catch (error) {
                throw pentestError(error)
              }
            })
          }

          if (request.method === "POST" && (rest === "/agent/pause" || rest === "/agent/stop")) {
            return await exclusive(async () => {
              await requireEngagement()
              try {
                // The whole task stops, not just the agent: a scan that outlives the pause would keep
                // producing results for a task the operator believes is stopped.
                await pentestAgents.stop(slug)
                await pentestJobs.stopFor(root, slug)
                return json({ paused: true, stopped: true })
              } catch (error) {
                throw pentestError(error)
              }
            })
          }

          if (request.method === "POST" && rest === "/archive") {
            return await exclusive(async () => {
              const current = await requireEngagement()
              if (current.status === "archived") return json({ engagement: current })
              // Archiving is terminal for live activity: wait for the checkpoint before the status
              // flips, never race a still-writing agent as the old implementation did.
              await pentestAgents.stop(slug)
              await pentestJobs.stopFor(root, slug)
              const engagement = await updateEngagement(root, slug, (current) => ({ ...current, status: "archived" }))
              broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
              return json({ engagement })
            })
          }

          if (request.method === "POST" && rest === "/abandon") {
            return await exclusive(async () => {
              const current = await requireEngagement()
              if (current.status === "abandoned") return json({ engagement: current })
              await pentestAgents.stop(slug)
              await pentestJobs.stopFor(root, slug)
              const engagement = await updateEngagement(root, slug, (item) => ({ ...item, status: "abandoned" }))
              broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
              return json({ engagement })
            })
          }

          if (request.method === "POST" && rest === "/restore") {
            return await exclusive(async () => {
              const current = await requireEngagement()
              if (current.status === "active") return json({ engagement: current })
              const engagement = await updateEngagement(root, slug, (item) => ({ ...item, status: "active" }))
              broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
              return json({ engagement })
            })
          }

          if (request.method === "POST" && rest === "/mode") {
            const input = await body(request)
            return await exclusive(async () => {
              const current = await requireActiveEngagement()
              const mode = input.mode === "flag-hunt" ? "flag-hunt" : input.mode === "assessment" ? "assessment" : undefined
              if (!mode) throw new HttpError(400, "任务模式必须是 assessment 或 flag-hunt")
              const engagement = await updateEngagement(root, slug, (item) => ({
                ...item,
                mode,
                // Preserve historical Flag submissions when switching away and back. A task moving
                // into Flag mode for the first time gets one usable objective immediately.
                ...(mode === "flag-hunt" && item.flagObjectives.length === 0
                  ? { flagObjectives: [{ id: "flag-1", label: "Flag 1", hint: "", submissions: [] }] }
                  : {}),
              }))
              broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
              return json({ engagement, previousMode: current.mode })
            })
          }

          const flagDecisionRoute = /^\/flags\/(flag-\d+)\/submissions\/(flag-\d+-submission-\d+)\/(confirm|reject)$/.exec(rest)
          if (request.method === "POST" && flagDecisionRoute) {
            const [, flagId, submissionId, decision] = flagDecisionRoute
            const input = await body(request)
            return await exclusive(async () => {
              await requireActiveEngagement()
              try {
                const note = typeof input.note === "string" ? input.note : undefined
                const submission = decision === "confirm"
                  ? await confirmFlagSubmission(root, slug, flagId!, submissionId!, note)
                  : await rejectFlagSubmission(root, slug, flagId!, submissionId!, note)
                broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
                return json({ submission })
              } catch (error) {
                throw pentestError(error)
              }
            })
          }

          if (request.method === "DELETE" && rest === "") {
            return await exclusive(async () => {
              await requireEngagement()
              if (pentestAgents.isLive(slug) || pentestJobs.hasLiveRun(slug))
                throw new HttpError(409, "请先暂停任务，再删除")
              const deleted = await deleteEngagement(root, slug)
              broadcast({ at: Date.now(), type: "pentest.engagement.deleted", engagement: slug })
              return json({ deleted: true, recoverable: true, ...deleted })
            })
          }

          if (request.method === "POST" && rest === "/tool-runs") {
            const input = await body(request)
            return await exclusive(async () => {
              const engagement = await requireActiveEngagement()
              const tool = typeof input.tool === "string" ? input.tool : ""
              const reason = typeof input.reason === "string" ? input.reason.trim() : ""
              if (reason === "") throw new HttpError(400, "启动工具任务必须填写执行原因")
              if (!findPentestTool(tool)) throw new HttpError(400, `未知的渗透工具: ${tool}`)
              let args: string[]
              let presetId: string | undefined
              const presetInput = stringOrUndefined(input.presetId)
              if (presetInput !== undefined) {
                const found = findPentestPreset(presetInput)
                if (!found || found.tool.name !== tool)
                  throw new HttpError(400, `预设 ${presetInput} 不属于工具 ${tool}`)
                const target = stringOrUndefined(input.target) ?? engagement.target
                args = found.preset.build(target)
                presetId = found.preset.id
              } else if (Array.isArray(input.args) && input.args.every((arg) => typeof arg === "string")) {
                // Custom argv is a tier-2 action: the operator reviewing this argv and pressing
                // start IS the confirmation; the plan (tool + args + target) is shown verbatim.
                args = input.args
              } else {
                throw new HttpError(400, "必须提供预设 ID 或显式参数列表")
              }
              const timeoutMs =
                typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
                  ? input.timeoutMs
                  : undefined
              try {
                const run = await pentestJobs.start(root, slug, { tool, args, reason, presetId, timeoutMs })
                return json({ run })
              } catch (error) {
                throw pentestError(error)
              }
            })
          }

          const pentestToolRunRoute = /^\/tool-runs\/(run-\d+)(\/.*)?$/.exec(rest)
          if (pentestToolRunRoute) {
            const runId = pentestToolRunRoute[1]
            const runRest = pentestToolRunRoute[2] ?? ""
            if (request.method === "GET" && runRest === "") {
              const bytes =
                typeof Number(url.searchParams.get("bytes")) === "number" &&
                Number.isFinite(Number(url.searchParams.get("bytes"))) &&
                Number(url.searchParams.get("bytes")) > 0
                  ? Math.min(1_000_000, Math.floor(Number(url.searchParams.get("bytes"))))
                  : undefined
              try {
                return json(await pentestJobs.detail(root, slug, runId, bytes))
              } catch (error) {
                throw pentestError(error)
              }
            }
            if (request.method === "POST" && runRest === "/stop") {
              return await exclusive(async () => {
                try {
                  const run = await pentestJobs.stop(root, slug, runId)
                  return json({ run })
                } catch (error) {
                  throw pentestError(error)
                }
              })
            }
          }

          if (request.method === "POST" && rest === "/assets") {
            const input = await body(request)
            return await exclusive(async () => {
              await requireActiveEngagement()
              try {
                const asset = await addAsset(root, slug, {
                  type: input.type as never,
                  value: typeof input.value === "string" ? input.value : "",
                  ...(stringOrUndefined(input.meta) !== undefined ? { meta: input.meta as string } : {}),
                  ...(stringOrUndefined(input.parentId) !== undefined ? { parentId: input.parentId as string } : {}),
                })
                broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
                return json({ asset })
              } catch (error) {
                throw pentestError(error)
              }
            })
          }

          if (request.method === "POST" && rest === "/observations") {
            const input = await body(request)
            return await exclusive(async () => {
              await requireActiveEngagement()
              try {
                const observation = await addObservation(root, slug, {
                  kind: input.kind as never,
                  ...(stringOrUndefined(input.target) !== undefined ? { target: input.target as string } : {}),
                  detail: typeof input.detail === "string" ? input.detail : "",
                  ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}),
                })
                broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
                return json({ observation })
              } catch (error) {
                throw pentestError(error)
              }
            })
          }

          if (request.method === "POST" && rest === "/evidence") {
            const input = await body(request)
            return await exclusive(async () => {
              await requireActiveEngagement()
              try {
                const evidence = await addEvidence(root, slug, {
                  ...(input.provenance === "external-import" ? { provenance: "external-import" as const } : {}),
                  ...(stringOrUndefined(input.path) !== undefined ? { path: input.path as string } : {}),
                  ...(stringOrUndefined(input.excerpt) !== undefined ? { excerpt: input.excerpt as string } : {}),
                  ...(stringOrUndefined(input.note) !== undefined ? { note: input.note as string } : {}),
                })
                broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
                return json({ evidence })
              } catch (error) {
                throw pentestError(error)
              }
            })
          }

          if (request.method === "POST" && rest === "/findings") {
            const input = await body(request)
            return await exclusive(async () => {
              await requireActiveEngagement()
              try {
                const finding = await addFinding(root, slug, {
                  title: typeof input.title === "string" ? input.title : "",
                  severity: input.severity as never,
                  ...(stringOrUndefined(input.description) !== undefined ? { description: input.description as string } : {}),
                  ...(Array.isArray(input.evidenceIds) && input.evidenceIds.every((id) => typeof id === "string")
                    ? { evidenceIds: input.evidenceIds as string[] }
                    : {}),
                  ...(Array.isArray(input.reproducibleSteps) &&
                    input.reproducibleSteps.every((step) => typeof step === "string")
                    ? { reproducibleSteps: input.reproducibleSteps as string[] }
                    : {}),
                  ...(stringOrUndefined(input.affectedAssetId) !== undefined
                    ? { affectedAssetId: input.affectedAssetId as string }
                    : {}),
                })
                broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
                return json({ finding })
              } catch (error) {
                throw pentestError(error)
              }
            })
          }

          const pentestFindingRoute = /^\/findings\/(finding-\d+)\/(confirm|reject)$/.exec(rest)
          if (request.method === "POST" && pentestFindingRoute) {
            const [, findingId, action] = pentestFindingRoute
            const input = await body(request)
            return await exclusive(async () => {
              await requireActiveEngagement()
              try {
                const finding =
                  action === "confirm"
                    ? await confirmFinding(root, slug, findingId)
                    : await rejectFinding(root, slug, findingId, stringOrUndefined(input.note))
                broadcast({ at: Date.now(), type: "pentest.engagement.changed", engagement: slug })
                return json({ finding })
              } catch (error) {
                throw pentestError(error)
              }
            })
          }
        }

        if (request.method === "GET" && url.pathname === "/api/platform")
          return json(await platformAdapterSummaries(persisted.settings.competition.platformId))

        const platformRoute = /^\/api\/platform\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(url.pathname)
        if (platformRoute) {
          const entry = findPlatformAdapterEntry(platformRoute[1])
          if (!entry) throw new HttpError(404, `未知的比赛平台: ${platformRoute[1]}`)
          const rest = platformRoute[2] ?? ""
          const requireAdapter = async () => {
            const adapter = await loadCompetitionAdapter(entry.id)
            if (!adapter) throw new HttpError(400, `请先在比赛平台控制台配置 ${entry.displayName} AccessKey`)
            return adapter
          }

          if (request.method === "GET" && rest === "/overview")
            return json(await (await requireAdapter()).overview(request.signal))

          if (request.method === "GET" && rest === "/notices")
            return json({ notices: await (await requireAdapter()).notices(request.signal) })

          const noticeDetail = /^\/notices\/(\d+)$/.exec(rest)
          if (request.method === "GET" && noticeDetail) {
            const id = Number(noticeDetail[1])
            if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "公告 ID 非法")
            return json(await (await requireAdapter()).noticeDetail(id, request.signal))
          }

          if (request.method === "PUT" && rest === "/credential") {
            const input = await body(request)
            if (typeof input.value !== "string") throw new HttpError(400, "AccessKey 必须是字符串")
            const accessKey = input.value
            return await exclusive(async () => {
              try {
                const credential = await entry.credentials.saveAccessKey(accessKey)
                clearCompetitionAdapterCache()
                broadcast({ at: Date.now(), type: "platform.credential.changed" })
                return json({ credential })
              } catch (error) {
                throw new HttpError(400, error instanceof Error ? error.message : String(error))
              }
            })
          }

          if (request.method === "PUT" && rest === "/server-host") {
            const input = await body(request)
            if (typeof input.value !== "string") throw new HttpError(400, "Server Host 必须是字符串")
            const serverHost = input.value
            return await exclusive(async () => {
              try {
                const saved = await entry.credentials.saveServerHost(serverHost)
                clearCompetitionAdapterCache()
                broadcast({ at: Date.now(), type: "platform.server-host.changed" })
                return json(saved)
              } catch (error) {
                throw new HttpError(400, error instanceof Error ? error.message : String(error))
              }
            })
          }

          if (request.method === "POST" && rest === "/sync") {
            return await exclusive(async () => {
              try {
                const result = await synchronizePlatform(undefined, entry.id)
                return json({ challenges: result.slugs })
              } catch (error) {
                if (error instanceof HttpError) throw error
                throw new HttpError(400, error instanceof Error ? error.message : String(error))
              }
            })
          }
        }

        if (request.method === "GET" && url.pathname === "/api/environments")
          return json({
            store: await loadEnvironmentStore(),
            container: await detectContainerCapability(),
          })

        if (request.method === "POST" && url.pathname === "/api/environments/discover") {
          const input = await body(request)
          // Captured before exclusive() so the closure sees a const, matching the sibling handlers.
          const conda = typeof input.conda === "string" && input.conda.trim() ? input.conda.trim() : "conda"
          return await exclusive(async () => {
            const profiles = await discoverCondaEnvironments(conda)
            const store = await loadEnvironmentStore()
            for (const profile of profiles) {
              const index = store.profiles.findIndex((item) => item.id === profile.id)
              if (index === -1) store.profiles.push(profile)
              else store.profiles[index] = { ...profile, installPolicy: store.profiles[index]!.installPolicy }
            }
            const saved = await saveEnvironmentStore(store)
            broadcast({ at: Date.now(), type: "environments.changed" })
            return json({ store: saved, discovered: profiles.length })
          })
        }

        if (request.method === "POST" && url.pathname === "/api/environments") {
          const input = await body(request)
          if (typeof input.interpreter !== "string" || input.interpreter.trim() === "")
            throw new HttpError(400, "interpreter must be an existing Python executable")
          // Probe options are captured before exclusive() because the typeof guard above narrows
          // input.interpreter only inside its own scope (see the server-host credential handler).
          // The explicit parameter type keeps the discriminated `kind` narrow outside its guard.
          const taskStorageRoots = await workspaceTaskStorageRoots(root)
          const probeOptions: Parameters<typeof probePythonEnvironment>[0] = {
            interpreter: input.interpreter,
            ...(typeof input.displayName === "string" ? { displayName: input.displayName } : {}),
            ...(input.kind === "conda" || input.kind === "python" ? { kind: input.kind } : {}),
            ...(typeof input.prefix === "string" ? { prefix: input.prefix } : {}),
            ...(input.installPolicy === "allow" || input.installPolicy === "deny"
              ? { installPolicy: input.installPolicy }
              : {}),
            ...(typeof input.id === "string" ? { id: input.id } : {}),
            taskStorageRoots,
          }
          return await exclusive(async () => {
            const profile = await probePythonEnvironment(probeOptions)
            if (profile.status !== "ready")
              throw new HttpError(400, profile.detail ?? `Python environment is ${profile.status}`)
            const store = await upsertEnvironmentProfile(profile, input.makeDefault === true)
            broadcast({ at: Date.now(), type: "environments.changed" })
            return json({ profile, store }, 201)
          })
        }

        if (request.method === "PATCH" && url.pathname === "/api/environments/default") {
          const input = await body(request)
          if (typeof input.profileId !== "string") throw new HttpError(400, "profileId must be a string")
          const profileId = input.profileId
          return await exclusive(async () => {
            const store = await loadEnvironmentStore()
            if (!store.profiles.some((item) => item.id === profileId))
              throw new HttpError(404, `No such environment profile: ${profileId}`)
            store.defaultProfileId = profileId
            const saved = await saveEnvironmentStore(store)
            broadcast({ at: Date.now(), type: "environments.changed" })
            return json({ store: saved })
          })
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
            const directory = await taskDirectoryFromRoot(root, found.slug, runID)
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
          if (input.apply !== undefined && typeof input.apply !== "boolean")
            throw new HttpError(400, "apply must be a boolean")
          // Existing API clients historically applied every save. The GUI now opts out explicitly
          // for a fast local save, while callers that omit the field keep the old behavior.
          const apply = input.apply !== false
          return await exclusive(async () => {
            const saved = await runner.saveProvider(provider, apiKey, { apply })
            if (apply) broadcast({ at: Date.now(), type: "providers.changed" })
            return json({ ...(saved ? { provider: saved } : {}), applied: apply })
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

        if (request.method === "POST" && url.pathname === "/api/challenges") {
          const input = await body(request)
          return await exclusive(async () => {
            if (typeof input.slug !== "string") throw new HttpError(400, "slug must be a string")
            const files = Array.isArray(input.files)
              ? input.files.filter((item): item is string => typeof item === "string" && item.trim() !== "")
              : []
            const created = await createChallengeInCatalog(root, {
              slug: input.slug,
              category: typeof input.category === "string" ? input.category : undefined,
              description: optionalText(input.description, "description"),
              difficulty: optionalText(input.difficulty, "difficulty"),
              remote: serviceRemote(input.remote === undefined ? undefined : input.remote),
              serviceRequired: input.serviceRequired === true,
              flagFormat: optionalText(input.flagFormat, "flagFormat"),
              answer: optionalText(input.answer, "answer"),
              attachments: files,
            })
            const discovered = (await discoverChallenges(root)).some((item) => item.slug === created.slug)
            if (!discovered) {
              await removeTree(root, created.directory).catch(() => {})
              throw new HttpError(400, `Challenge was not discoverable after creation: ${created.slug}`)
            }
            broadcast({ at: Date.now(), type: "challenge.created", slug: created.slug, category: created.category })
            return json(created, 201)
          })
        }

        const fileMatch = /^\/api\/challenges\/([^/]+)\/files(?:\/([^/]+))?$/.exec(url.pathname)
        if (fileMatch && (request.method === "POST" || request.method === "DELETE")) {
          const slug = decodeSegment(fileMatch[1]!)
          const name = fileMatch[2] === undefined ? undefined : decodeSegment(fileMatch[2])
          return await exclusive(async () => {
            await challenge(slug)
            if (request.method === "DELETE") {
              if (name === undefined) throw new HttpError(400, "attachment name is required")
              const removed = await removeChallengeAttachment(root, slug, name)
              broadcast({ at: Date.now(), type: "challenge.changed", slug })
              return json({ ok: true, ...removed })
            }
            const input = await body(request)
            const sources = Array.isArray(input.sources)
              ? input.sources.filter((item): item is string => typeof item === "string" && item.trim() !== "")
              : []
            if (sources.length === 0) throw new HttpError(400, "sources must name at least one file")
            const added = await addChallengeAttachments(root, slug, sources)
            broadcast({ at: Date.now(), type: "challenge.changed", slug })
            return json(added, 201)
          })
        }

        const patchMatch = /^\/api\/challenges\/([^/]+)$/.exec(url.pathname)
        if (request.method === "PATCH" && patchMatch) {
          const slug = decodeSegment(patchMatch[1]!)
          const input = await body(request)
          return await exclusive(async () => {
            const found = await challenge(slug)
            const current = { ...(persisted.challenges[slug] ?? {}) }
            const content: Parameters<typeof updateChallengeInCatalog>[2] = {}
            if ("description" in input) content.description = optionalText(input.description, "description") ?? ""
            if ("category" in input) {
              if (typeof input.category !== "string") throw new HttpError(400, "category must be a string")
              content.category = input.category
            }
            if ("difficulty" in input) content.difficulty = optionalText(input.difficulty, "difficulty") ?? null
            if ("flagFormat" in input) content.flagFormat = optionalText(input.flagFormat, "flagFormat") ?? null
            if ("serviceRequired" in input) {
              if (typeof input.serviceRequired !== "boolean")
                throw new HttpError(400, "serviceRequired must be a boolean")
              content.serviceRequired = input.serviceRequired
            }
            if ("answer" in input) content.answer = optionalText(input.answer, "answer") ?? null
            if ("remote" in input) content.remote = serviceRemote(input.remote) ?? null

            let remote = found.remote?.trim() || undefined
            if (Object.keys(content).length > 0) {
              await updateChallengeInCatalog(root, slug, content)
              if ("remote" in content) remote = content.remote ?? undefined
            } else if ("remote" in input) {
              // A remote-only edit keeps using the narrow writer, which touches nothing else.
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
            return json({
              ok: true,
              remote: remote ?? null,
              ...("answer" in input ? { answer: (await readAnswer(root, slug)) ?? null } : {}),
            })
          })
        }

        // One challenge's operator-owned fields that the queue state deliberately omits: the known
        // answer lives in the workspace-wide `eval/answers.txt`, not in the challenge directory.
        if (request.method === "GET" && patchMatch) {
          const slug = decodeSegment(patchMatch[1]!)
          await challenge(slug)
          return json({ slug, answer: (await readAnswer(root, slug)) ?? null })
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
              visionModel,
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
              visionModel,
              consultModels,
              blindReview,
              consultOnCompaction,
              limits: {
                ...(settings.tokenBudgetEnabled ? { tokens } : {}),
                repeats,
                timeout: minutes * 60_000,
                silenceMs: DEFAULT_SILENCE_MS,
              },
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
            const requestedRunID =
              typeof input.sourceRunID === "string" ? input.sourceRunID : undefined
            const requestedTokens = input.tokens ?? (
              persisted.settings.tokenBudgetEnabled ? persisted.settings.tokens : undefined
            )
            const tokens = requestedTokens === undefined ? undefined : positive(requestedTokens, "tokens")
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
            const scheduled = runner.requestConsultation({
              slug: found.slug,
              sourceRunID: requestedRunID,
              expertModels,
              synthesizerModel,
              solverModel,
              modelPolicy: {
                economy: persisted.settings.economyModel,
                strong: persisted.settings.strongModel,
              },
              consultModels: persisted.settings.consultModels,
              blindReview: persisted.settings.blindReview,
              consultOnCompaction: persisted.settings.consultOnCompaction,
              limits: {
                ...(tokens === undefined ? {} : { tokens }),
                repeats,
                timeout: minutes * 60_000,
                silenceMs: DEFAULT_SILENCE_MS,
              },
              flagFormat,
              requestedAt: Date.now(),
            })
            if (scheduled) {
              const nextChallenge = {
                ...(persisted.challenges[found.slug] ?? {}),
              }
              delete nextChallenge.state
              persisted.challenges[found.slug] = nextChallenge
              await saveRootGuiState(root, persisted)
              return json({
                queued: [{ slug: found.slug, id: scheduled.runID, model: scheduled.model }],
                trigger: "manual",
                mode: scheduled.mode,
              }, 202)
            }

            const runs = await readChallengeRuns(root, found.slug)
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
            const queued = await runner.enqueue({
              challenges: [found],
              model: solverModel,
              models: { [found.slug]: solverModel },
              modelPolicy: {
                economy: persisted.settings.economyModel,
                strong: persisted.settings.strongModel,
              },
              visionModel: persisted.settings.visionModel,
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
            return json({ queued, trigger, mode: "queued" }, 202)
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
            const directory = await taskDirectoryFromRoot(root, found.slug, selected.id)
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
              visionModel: settings.visionModel,
              consultModels: settings.consultModels,
              blindReview: settings.blindReview,
              consultOnCompaction: settings.consultOnCompaction,
              workspaces: { [found.slug]: selected.id },
              limits: {
                ...(settings.tokenBudgetEnabled ? { tokens: settings.tokens } : {}),
                repeats: settings.repeats,
                timeout: settings.minutes * 60_000,
                silenceMs: DEFAULT_SILENCE_MS,
              },
              flagFormat: settings.flagFormat,
              hint: [
                `The user manually confirmed the candidate flag ${JSON.stringify(flag)} is incorrect.`,
                "Do not submit this candidate again; review the derivation or verification steps against the NOTES.md record, then continue the original goal.",
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
            const directory = await taskDirectoryFromRoot(root, found.slug, selected.id)
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
              visionModel: settings.visionModel,
              purpose: "writeup",
              consultOnCompaction: settings.consultOnCompaction,
              workspaces: { [found.slug]: selected.id },
              limits: {
                ...(settings.tokenBudgetEnabled ? { tokens: settings.tokens } : {}),
                repeats: settings.repeats,
                timeout: settings.minutes * 60_000,
                silenceMs: DEFAULT_SILENCE_MS,
              },
              flagFormat: settings.flagFormat,
              hint: `Confirmed flag: ${accepted}. Generate only the final, reproducible Chinese WRITEUP.md, then archive.`,
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
            const catalogDirectory = (await resolveChallengeCatalog(root)).directory
            const destination = path.join(catalogDirectory, category, slug)
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
            for (const target of slugStores(root, slug)) await removeTree(root, target)
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
            const taskTargets = slugStores(root, slug)
            await destructiveTarget(root, challengeTarget)
            for (const target of taskTargets) await destructiveTarget(root, target)
            await removeTree(root, challengeTarget)
            for (const target of taskTargets) await removeTree(root, target)
            delete persisted.challenges[slug]
            await saveRootGuiState(root, persisted)
            broadcast({ at: Date.now(), type: "challenge.deleted", slug })
            return json({ ok: true })
          })
        }

        if (request.method === "POST" && url.pathname === "/api/open") {
          const input = await body(request)
          if (input.kind !== "task" && input.kind !== "work" && input.kind !== "file" &&
              input.kind !== "root" && input.kind !== "backups")
            throw new HttpError(400, "kind must be task, work, file, root, or backups")
          // The workspace itself and the backup folder are not challenge-scoped, so they open
          // before the slug lookup: the operator is inspecting Boom's own folders.
          if (input.kind === "root" || input.kind === "backups") {
            const directory = input.kind === "root" ? root : boomBackupsDirectory()
            await mkdir(directory, { recursive: true })
            await openExternal(directory)
            return json({ ok: true, path: directory })
          }
          if (typeof input.slug !== "string") throw new HttpError(400, "slug must be a string")
          const found = await challenge(input.slug)
          const runs = await readChallengeRuns(root, found.slug)
          const requestedID = typeof input.runID === "string" ? input.runID : undefined
          const selectedRun = requestedID
            ? runs.find((run) => run.id === requestedID)
            : runs[runs.length - 1]
          let target: string
          if (input.kind === "task" || input.kind === "work") {
            if (!selectedRun) throw new HttpError(404, `No run found for ${found.slug}`)
            const directory = await taskDirectoryFromRoot(root, found.slug, selectedRun.id)
            target = input.kind === "task"
              ? directory
              : await assertPathWithin(directory, path.join(directory, "work"))
          } else {
            if (typeof input.path !== "string" || input.path === "")
              throw new HttpError(400, "path is required when kind is file")
            const base = selectedRun
              ? await taskDirectoryFromRoot(root, found.slug, selectedRun.id)
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
          /(?:already running|already queued|Consultation is already|Duplicate challenge|Challenge already exists|Cannot change providers|Cannot change armor prompts|Cannot change MCP|Cannot test MCP|Cannot authenticate MCP)/i.test(
            error.message,
          )
        const invalidConfiguration =
          error instanceof Error &&
          /(?:Invalid provider|Invalid armor prompt|Invalid MCP|Provider Base URL|Custom provider requires|No such armor prompt|No such MCP)/i.test(
            error.message,
          )
        // Operator input the GUI can reject with a field correction: a bad slug, an attachment
        // name that is not one path segment, or an attachment the operator no longer has on disk.
        const invalidInput =
          error instanceof Error &&
          /(?:Invalid challenge slug|Invalid attachment name|Attachment (?:does not exist|is not a real file))/i.test(
            error.message,
          )
        const missing =
          error instanceof Error && /(?:No such challenge|No such attachment)/i.test(error.message)
        const status = error instanceof HttpError
          ? error.status
          : unsafePath || invalidConfiguration || invalidInput
            ? 400
            : conflict
              ? 409
              : missing
                ? 404
                : 500
        return json({ error: error instanceof Error ? error.message : String(error) }, status)
      }
  }

  const server = Bun.serve({
    hostname,
    port: options.port ?? 7331,
    async fetch(request, bunServer) {
      if (guiToken === undefined) return route(request, bunServer)
      const url = new URL(request.url)
      const cookie = guiCookieValue(request, GUI_COOKIE)
      const header = request.headers.get("x-boom-token")
      const query = url.searchParams.get("token")
      if (!guiTokenMatches(cookie ?? header ?? query, guiToken)) {
        // Document navigations get a human-readable hint; everything else speaks JSON.
        if (request.method === "GET" && !url.pathname.startsWith("/api/"))
          return unauthenticatedGuiPage()
        return json({
          error:
            "Boom GUI 需要鉴权：请使用启动横幅输出的带 ?token= 的完整 URL 打开，或在请求头携带 x-boom-token。",
        }, 401)
      }
      const response = await route(request, bunServer)
      // The credential arrived out-of-band (first navigation or a local API client): seed the
      // strict cookie so every later frontend request authenticates without frontend changes.
      if (cookie === undefined && (header !== null || query !== null)) {
        const seeded = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
        seeded.headers.set(
          "set-cookie",
          `${GUI_COOKIE}=${guiToken}; HttpOnly; SameSite=Strict; Path=/`,
        )
        return seeded
      }
      return response
    },
  })

  // Task agents reach the network broker, not the browser, so the GUI's own origin is denied to
  // them explicitly. Registered for both loopback name spellings once the port is bound.
  registerBoomControlPlaneOrigin(
    `http://127.0.0.1:${server.port}`,
    `http://localhost:${server.port}`,
    ...(hostname === "::1" ? [`http://[::1]:${server.port}`] : []),
  )

  if (!options.runner && options.startRuntime !== false)
    void runner.applyLiveModelSettings(persisted.settings).catch(() => {})
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
  // The full URL printed by the startup banner carries the token, so the first browser navigation
  // both authenticates and receives the strict cookie; the frontend itself never sees credentials.
  const authenticatedUrl = guiToken === undefined ? url : `${url}?token=${guiToken}`
  if (options.open !== false) void openExternal(authenticatedUrl)

  return {
    server,
    url: authenticatedUrl,
    runner,
    async close() {
      if (closing) return
      closing = true
      // Stop accepting new requests before draining jobs so close is a real lifecycle barrier.
      void server.stop(true)
      autopilot.stop()
      await pentestAgents.stopAll()
      await pentestJobs.stopAll()
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
