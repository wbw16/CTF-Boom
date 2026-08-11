import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CONSULT_EXPERTS } from "./consultation.ts"

export type GuiSettings = {
  economyModel: string
  strongModel: string
  tokens: number
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
}

export const DEFAULT_GUI_SETTINGS: GuiSettings = {
  economyModel: "free/deepseek-v4-flash-free",
  strongModel: "free/deepseek-v4-flash-free",
  tokens: 1_000_000,
  repeats: 5,
  minutes: 60,
  concurrency: 1,
  flagFormat: "",
  executionMode: "managed",
  consultModels: [],
  blindReview: true,
  consultOnCompaction: true,
}

function statePath() {
  const home = path.resolve(process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"))
  return path.join(home, "gui-state.json")
}

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
  return {
    economyModel:
      typeof input.economyModel === "string" && input.economyModel.includes("/")
        ? input.economyModel
        : legacyModel ?? DEFAULT_GUI_SETTINGS.economyModel,
    strongModel:
      typeof input.strongModel === "string" && input.strongModel.includes("/")
        ? input.strongModel
        : legacyModel ?? DEFAULT_GUI_SETTINGS.strongModel,
    tokens: positive(input.tokens, DEFAULT_GUI_SETTINGS.tokens),
    repeats: positive(input.repeats, DEFAULT_GUI_SETTINGS.repeats, 2),
    minutes: positive(input.minutes, DEFAULT_GUI_SETTINGS.minutes),
    concurrency: Math.min(32, Math.floor(positive(input.concurrency, DEFAULT_GUI_SETTINGS.concurrency))),
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

async function loadFile(): Promise<StateFile> {
  const raw = await readFile(statePath(), "utf8").catch(() => undefined)
  if (raw === undefined) return { version: 2, roots: {} }
  try {
    const parsed = JSON.parse(raw) as Partial<StateFile>
    const roots: Record<string, RootGuiState> = {}
    if (parsed.roots && typeof parsed.roots === "object") {
      for (const [root, state] of Object.entries(parsed.roots)) roots[path.resolve(root)] = normalizeRoot(state)
    }
    return { version: 2, roots }
  } catch {
    return { version: 2, roots: {} }
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
