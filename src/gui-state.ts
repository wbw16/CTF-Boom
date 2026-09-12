import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { boomHomeDirectory } from "./boom-home.ts"
import { CONSULT_EXPERTS } from "./consultation.ts"
import {
  DEFAULT_COMPETITION_SETTINGS,
  normalizeCompetitionSettings,
  type CompetitionSettings,
} from "./competition/policy.ts"

export type GuiSettings = {
  /**
   * Product mode: "ctf" is the default challenge-solving flow; "pentest" surfaces the authorized
   * penetration console. The CTF pipeline is identical in both modes — the axis selects which
   * console the GUI emphasizes, not a different runtime.
   */
  mode: "ctf" | "pentest"
  economyModel: string
  strongModel: string
  /** Optional image-capable model used by the on-demand vision tool. */
  visionModel: string
  tokens: number
  /**
   * When false, the task has no cumulative token/time allowance. Per-turn watchdogs remain active,
   * but the host recovers or renews turns until the task completes or the user stops it.
   */
  tokenBudgetEnabled: boolean
  repeats: number
  minutes: number
  concurrency: number
  flagFormat: string
  executionMode: "managed" | "isolated" | "static-only"
  /**
   * The one pool of second-opinion models. A consultation runs all of them in parallel; a blind
   * candidate review draws a single reviewer from it. Kept as one list so switching models is one
   * edit, not two.
   */
  consultModels: string[]
  /**
   * Whether a candidate is blind-reviewed automatically. Separate from the pool because this fires on
   * every candidate while a consultation is user-triggered, so turning the automatic cost off must not
   * mean emptying the pool and losing consultation too.
   */
  blindReview: boolean
  /** Context experiment switch; true preserves the repaired-Boom baseline. */
  consultOnCompaction: boolean
  /** Host-wide network switch; "deny" refuses web tools and isolates bash/boom-exec sandboxes. */
  network: "allow" | "deny"
  /** Competition scheduling: environment/local slots, match length, and the endgame window. */
  competition: CompetitionSettings
}

export type ChallengeGuiState = {
  state?: "given-up" | "removed"
  confirmed?: {
    runID: string
    flag: string
    at: string
  }
}

export type RootGuiState = {
  settings: GuiSettings
  challenges: Record<string, ChallengeGuiState>
}

type StateFile = {
  version: 2
  roots: Record<string, RootGuiState>
  /**
   * Workspace root the GUI opened last, shared across roots and modes. Startup reopens it instead
   * of assuming the launch directory is a workspace; absent until the first root is activated.
   */
  lastRoot?: string
}

export const DEFAULT_GUI_SETTINGS: GuiSettings = {
  mode: "ctf",
  economyModel: "free/deepseek-v4-flash-free",
  strongModel: "free/deepseek-v4-flash-free",
  visionModel: "",
  tokens: 1_000_000,
  tokenBudgetEnabled: false,
  repeats: 5,
  minutes: 60,
  concurrency: 1,
  flagFormat: "",
  executionMode: "managed",
  consultModels: [],
  blindReview: true,
  consultOnCompaction: true,
  network: "allow",
  // The runtime's ordinary concurrency control is the sole local-task knob in this build.
  competition: { ...DEFAULT_COMPETITION_SETTINGS, localSlots: 1 },
}

function statePath() {
  const home = boomHomeDirectory()
  return path.join(home, "gui-state.json")
}

/** The Boom-owned data directory: state and tokens live here; see `boom-home.ts`. */
export { boomHomeDirectory }

function positive(value: unknown, fallback: number, minimum = 1) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback
}

function normalizeSettings(value: unknown): GuiSettings {
  const input = (value ?? {}) as Partial<GuiSettings> & { model?: unknown }
  const legacyModel =
    typeof input.model === "string" && input.model.includes("/") ? input.model : undefined
  const configuredConsultModels = Array.isArray(input.consultModels)
    ? input.consultModels
        .filter((model): model is string => typeof model === "string" && model.includes("/"))
        .slice(0, CONSULT_EXPERTS.maximum)
    : DEFAULT_GUI_SETTINGS.consultModels
  const concurrency = Math.min(32, Math.floor(positive(input.concurrency, DEFAULT_GUI_SETTINGS.concurrency)))
  return {
    mode: input.mode === "pentest" ? "pentest" : "ctf",
    economyModel:
      typeof input.economyModel === "string" && input.economyModel.includes("/")
        ? input.economyModel
        : legacyModel ?? DEFAULT_GUI_SETTINGS.economyModel,
    strongModel:
      typeof input.strongModel === "string" && input.strongModel.includes("/")
        ? input.strongModel
        : legacyModel ?? DEFAULT_GUI_SETTINGS.strongModel,
    visionModel:
      typeof input.visionModel === "string" && (input.visionModel === "" || input.visionModel.includes("/"))
        ? input.visionModel
        : DEFAULT_GUI_SETTINGS.visionModel,
    tokens: positive(input.tokens, DEFAULT_GUI_SETTINGS.tokens),
    // A missing flag adopts the current run-until-complete default. Explicit saved ceilings remain.
    tokenBudgetEnabled:
      typeof input.tokenBudgetEnabled === "boolean"
        ? input.tokenBudgetEnabled
        : DEFAULT_GUI_SETTINGS.tokenBudgetEnabled,
    repeats: positive(input.repeats, DEFAULT_GUI_SETTINGS.repeats, 2),
    minutes: positive(input.minutes, DEFAULT_GUI_SETTINGS.minutes),
    concurrency,
    flagFormat: typeof input.flagFormat === "string" ? input.flagFormat : DEFAULT_GUI_SETTINGS.flagFormat,
    executionMode:
      input.executionMode === "isolated" || input.executionMode === "static-only"
        ? input.executionMode
        : "managed",
    // Bounded to the consultation maximum on read: a persisted list longer than that would otherwise
    // fail validation only later, at the point of use.
    consultModels: configuredConsultModels.length === 0 || configuredConsultModels.length >= CONSULT_EXPERTS.minimum
      ? configuredConsultModels
      : [],
    blindReview:
      typeof input.blindReview === "boolean" ? input.blindReview : DEFAULT_GUI_SETTINGS.blindReview,
    consultOnCompaction:
      typeof input.consultOnCompaction === "boolean"
        ? input.consultOnCompaction
        : DEFAULT_GUI_SETTINGS.consultOnCompaction,
    network:
      input.network === "deny" ? "deny" : "allow",
    competition: {
      ...normalizeCompetitionSettings(input.competition),
      localSlots: concurrency,
    },
  }
}

function normalizeChallenge(value: unknown): ChallengeGuiState {
  const input = (value ?? {}) as ChallengeGuiState
  const confirmed =
    input.confirmed &&
    typeof input.confirmed.runID === "string" &&
    typeof input.confirmed.flag === "string" &&
    typeof input.confirmed.at === "string"
      ? input.confirmed
      : undefined
  return {
    ...(input.state === "given-up" || input.state === "removed" ? { state: input.state } : {}),
    ...(confirmed ? { confirmed } : {}),
  }
}

function normalizeRoot(value: unknown): RootGuiState {
  const input = (value ?? {}) as Partial<RootGuiState>
  const challenges: Record<string, ChallengeGuiState> = {}
  if (input.challenges && typeof input.challenges === "object") {
    for (const [slug, state] of Object.entries(input.challenges)) challenges[slug] = normalizeChallenge(state)
  }
  return { settings: normalizeSettings(input.settings), challenges }
}

/**
 * Move an unreadable state file aside so the next save cannot silently destroy confirmed flags and
 * archived challenge state, then fail loudly. Mirrors the mcp-config/provider-config strategy.
 */
async function quarantineCorruptState(target: string, reason: string): Promise<never> {
  const backup = `${target}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`
  const moved = await rename(target, backup)
    .then(() => true)
    .catch(() => false)
  throw new Error(
    `Failed to read the GUI state file at ${target}: ${reason}. ` +
      (moved
        ? `The corrupt file was preserved at ${backup}; inspect or delete it, then retry.`
        : "Automatic quarantine failed; move the file aside manually before retrying."),
  )
}

async function loadFile(): Promise<StateFile> {
  const target = statePath()
  const raw = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (raw === undefined) return { version: 2, roots: {} }
  let parsed: Partial<StateFile>
  try {
    parsed = JSON.parse(raw) as Partial<StateFile>
  } catch (error) {
    return await quarantineCorruptState(
      target,
      error instanceof Error ? error.message : String(error),
    )
  }
  if (!parsed || typeof parsed !== "object" || !parsed.roots || typeof parsed.roots !== "object")
    return await quarantineCorruptState(target, "expected an object with a roots map")
  const roots: Record<string, RootGuiState> = {}
  for (const [root, state] of Object.entries(parsed.roots)) roots[path.resolve(root)] = normalizeRoot(state)
  return {
    version: 2,
    roots,
    ...(typeof parsed.lastRoot === "string" && parsed.lastRoot.trim() !== ""
      ? { lastRoot: path.resolve(parsed.lastRoot) }
      : {}),
  }
}

async function saveFile(file: StateFile) {
  const target = statePath()
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(file, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, target)
}

export async function loadRootGuiState(root: string): Promise<RootGuiState> {
  const file = await loadFile()
  return normalizeRoot(file.roots[path.resolve(root)])
}

export async function saveRootGuiState(root: string, state: RootGuiState) {
  const file = await loadFile()
  file.roots[path.resolve(root)] = normalizeRoot(state)
  await saveFile(file)
}

/** The workspace root the GUI opened last, resolved absolute; undefined before the first activation. */
export async function loadLastGuiRoot(): Promise<string | undefined> {
  return (await loadFile()).lastRoot
}

/** Remember the active workspace root so the next launch reopens it instead of the launch cwd. */
export async function saveLastGuiRoot(root: string) {
  const file = await loadFile()
  const resolved = path.resolve(root)
  if (file.lastRoot === resolved) return
  file.lastRoot = resolved
  await saveFile(file)
}
