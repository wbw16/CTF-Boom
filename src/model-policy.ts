export type ModelTier = "economy" | "strong"

export type ModelPolicy = {
  economy: string
  strong: string
}

export type ModelRole =
  | "worker"
  | "open-worker"
  | "analyzer"
  | "solver"
  | "reviewer"

const ROLE_TIERS: Record<ModelRole, ModelTier> = {
  worker: "economy",
  "open-worker": "strong",
  analyzer: "economy",
  solver: "strong",
  reviewer: "strong",
}

export function isModelID(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/[^/\s].*$/.test(value)
}

export function normalizeModelPolicy(
  value: unknown,
  fallback: ModelPolicy,
): ModelPolicy {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<ModelPolicy>)
      : {}
  return {
    economy: isModelID(input.economy) ? input.economy : fallback.economy,
    strong: isModelID(input.strong) ? input.strong : fallback.strong,
  }
}

export function assertModelPolicy(policy: ModelPolicy) {
  if (!isModelID(policy.economy))
    throw new Error(`Economy model must be "provider/model", got: ${policy.economy}`)
  if (!isModelID(policy.strong))
    throw new Error(`Strong model must be "provider/model", got: ${policy.strong}`)
  return policy
}

export function modelForRole(policy: ModelPolicy, role: ModelRole) {
  assertModelPolicy(policy)
  return policy[ROLE_TIERS[role]]
}
