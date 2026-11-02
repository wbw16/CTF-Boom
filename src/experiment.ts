import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { resolveInputDirectory } from "./task-layout.ts"

export type Experiment = { label: string; trial: number }
export type ExperimentConditions = {
  model: string
  economyModel: string
  strongModel: string
  tokens: number
  timeoutMs: number
  repeats: number
  inputFingerprint: string
  environmentFingerprint: string
  executionMode: string
  consultModels: string[]
  blindReview: boolean
  consultOnCompaction: boolean
  planningConsultation: boolean
  network: "allow" | "deny"
}
export type ExperimentRecord = Experiment & { conditions?: ExperimentConditions; invalidated?: boolean }

export function normalizeExperiment(value: Experiment): Experiment {
  if (typeof value.label !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value.label) ||
      !Number.isSafeInteger(value.trial) || value.trial < 1)
    throw new Error("Experiment requires a 1–80 character label and a positive integer trial")
  return { label: value.label, trial: value.trial }
}

export function parseExperiment(value: unknown): ExperimentRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  let experiment: Experiment
  try { experiment = normalizeExperiment(record as Experiment) } catch { return undefined }
  const c = record.conditions as Record<string, unknown> | undefined
  const stringKeys = ["model", "economyModel", "strongModel", "inputFingerprint", "environmentFingerprint", "executionMode"] as const
  const numberKeys = ["tokens", "timeoutMs", "repeats"] as const
  const booleanKeys = ["blindReview", "consultOnCompaction", "planningConsultation"] as const
  const valid = c && stringKeys.every((key) => typeof c[key] === "string" && c[key] !== "") &&
    numberKeys.every((key) => typeof c[key] === "number" && Number.isFinite(c[key]) && c[key] > 0) &&
    booleanKeys.every((key) => typeof c[key] === "boolean") &&
    Array.isArray(c.consultModels) && c.consultModels.every((item) => typeof item === "string") &&
    (c.network === "allow" || c.network === "deny")
  return {
    ...experiment,
    ...(valid ? { conditions: {
      model: c.model as string, economyModel: c.economyModel as string, strongModel: c.strongModel as string,
      inputFingerprint: c.inputFingerprint as string, environmentFingerprint: c.environmentFingerprint as string,
      executionMode: c.executionMode as string, tokens: c.tokens as number, timeoutMs: c.timeoutMs as number,
      repeats: c.repeats as number, consultModels: c.consultModels as string[],
      blindReview: c.blindReview as boolean, consultOnCompaction: c.consultOnCompaction as boolean,
      planningConsultation: c.planningConsultation as boolean, network: c.network as "allow" | "deny",
    } } : {}),
    ...(record.invalidated === true ? { invalidated: true } : {}),
  }
}

/** Hash the copied handout, never the host answer store or analysis artifacts. */
export async function fingerprintInput(directory: string) {
  const root = await resolveInputDirectory(directory)
  const hash = createHash("sha256")
  async function visit(current: string) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const file = path.join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error("Experiment input must not contain symbolic links")
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) {
        const contentHash = createHash("sha256")
        for await (const chunk of createReadStream(file)) contentHash.update(chunk)
        hash.update(JSON.stringify([path.relative(root, file).split(path.sep).join("/"), contentHash.digest("hex")]) + "\n")
      }
    }
  }
  await visit(root)
  return hash.digest("hex")
}
