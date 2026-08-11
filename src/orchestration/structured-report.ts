import type { ModelTier } from "../model-policy.ts"

export type ArtifactReference = {
  path: string
  description: string
  sha256?: string
}

export type StructuredReport = {
  facts: Array<{ statement: string; evidence: ArtifactReference[] }>
  hypotheses: Array<{
    statement: string
    evidenceNeeded: string[]
    nextExperiment?: string
  }>
  experiments: Array<{
    title: string
    objective: string
    expectedEvidence: string
    stopCondition: string
    tier: ModelTier
    budgetTokens?: number
  }>
  risks: string[]
  rawText: string
}

/** Prefer a fenced JSON block so braces in surrounding prose cannot corrupt the report. */
export function jsonObject(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  for (const candidate of [fenced, text].filter((value): value is string => !!value)) {
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start === -1 || end <= start) continue
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>
    } catch {
      // The caller still receives raw text; malformed optional structure must not erase the advice.
    }
  }
  return undefined
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function artifact(value: unknown): ArtifactReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.path !== "string" || typeof input.description !== "string") return undefined
  return {
    path: input.path,
    description: input.description,
    ...(typeof input.sha256 === "string" ? { sha256: input.sha256 } : {}),
  }
}

export function parseStructuredReport(text: string): StructuredReport {
  const input = jsonObject(text)
  const facts = Array.isArray(input?.facts)
    ? input.facts.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return []
        const item = value as Record<string, unknown>
        if (typeof item.statement !== "string") return []
        return [{
          statement: item.statement,
          evidence: Array.isArray(item.evidence)
            ? item.evidence.flatMap((entry) => artifact(entry) ?? [])
            : [],
        }]
      })
    : []
  const hypotheses = Array.isArray(input?.hypotheses)
    ? input.hypotheses.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return []
        const item = value as Record<string, unknown>
        if (typeof item.statement !== "string") return []
        return [{
          statement: item.statement,
          evidenceNeeded: strings(item.evidenceNeeded),
          ...(typeof item.nextExperiment === "string" ? { nextExperiment: item.nextExperiment } : {}),
        }]
      })
    : []
  const experiments = Array.isArray(input?.experiments)
    ? input.experiments.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return []
        const item = value as Record<string, unknown>
        if (
          typeof item.title !== "string" ||
          typeof item.objective !== "string" ||
          typeof item.expectedEvidence !== "string" ||
          typeof item.stopCondition !== "string"
        ) return []
        return [{
          title: item.title,
          objective: item.objective,
          expectedEvidence: item.expectedEvidence,
          stopCondition: item.stopCondition,
          tier: item.tier === "strong" ? "strong" as const : "economy" as const,
          ...(typeof item.budgetTokens === "number" ? { budgetTokens: item.budgetTokens } : {}),
        }]
      })
    : []
  return {
    facts,
    hypotheses,
    experiments,
    risks: strings(input?.risks),
    rawText: text,
  }
}
