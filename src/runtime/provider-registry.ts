import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  BOOM_CONTEXT_LIMIT,
  loadProviderStore,
  type ManagedModelConfig,
  type ManagedProviderConfig,
  type ManagedProviderDriver,
} from "../provider-config.ts"
import type { RuntimeModelPricing, RuntimeProviderModel } from "../runtime-contract.ts"

export type BoomProviderDriverID = ManagedProviderDriver

export type BoomProviderModel = RuntimeProviderModel

export type BoomProviderDescriptor = {
  id: string
  name: string
  driver: BoomProviderDriverID
  baseURL: string
  api?: string
  auth: "api" | "none"
  disabled: boolean
  custom: boolean
  hiddenModels: readonly string[]
  models: Readonly<Record<string, BoomProviderModel>>
}

export type BoomProviderRegistry = {
  version: 1
  providers: Readonly<Record<string, BoomProviderDescriptor>>
}

export type BoomProviderRegistryOverrides = Readonly<
  Record<string, { baseURL?: string }>
>

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function driver(value: unknown): BoomProviderDriverID | undefined {
  return value === "openai-compatible" || value === "openai" || value === "anthropic" ? value : undefined
}

function httpURL(value: unknown) {
  if (typeof value !== "string" || value.length > 2_000) return undefined
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      ? value.replace(/\/+$/, "")
      : undefined
  } catch {
    return undefined
  }
}

function model(value: unknown): BoomProviderModel | undefined {
  const item = object(value)
  if (
    !item || typeof item.id !== "string" || !item.id || /\s/.test(item.id) ||
    typeof item.name !== "string" || !item.name ||
    typeof item.context !== "number" || item.context <= 0 ||
    typeof item.output !== "number" || item.output <= 0
  ) return undefined
  const rawPricing = object(item.pricing)
  const amount = (entry: unknown) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0
    ? entry
    : undefined
  const inputPrice = amount(rawPricing?.input)
  const outputPrice = amount(rawPricing?.output)
  const optionalPrice = (name: "reasoning" | "cacheRead" | "cacheWrite") => {
    const entry = rawPricing?.[name]
    return entry === undefined ? undefined : amount(entry)
  }
  const invalidOptional = (["reasoning", "cacheRead", "cacheWrite"] as const)
    .some((name) => rawPricing?.[name] !== undefined && optionalPrice(name) === undefined)
  if (item.pricing !== undefined && (!rawPricing || inputPrice === undefined || outputPrice === undefined || invalidOptional))
    return undefined
  const pricing: RuntimeModelPricing | undefined = rawPricing ? {
    input: inputPrice!,
    output: outputPrice!,
    ...(optionalPrice("reasoning") === undefined ? {} : { reasoning: optionalPrice("reasoning") }),
    ...(optionalPrice("cacheRead") === undefined ? {} : { cacheRead: optionalPrice("cacheRead") }),
    ...(optionalPrice("cacheWrite") === undefined ? {} : { cacheWrite: optionalPrice("cacheWrite") }),
  } : undefined
  return {
    id: item.id,
    name: item.name,
    limit: { context: BOOM_CONTEXT_LIMIT, output: Math.floor(item.output) },
    reasoning: item.reasoning === true,
    attachment: item.attachment === true,
    ...(pricing ? { pricing } : {}),
  }
}

function managedModel(value: ManagedModelConfig): BoomProviderModel {
  return {
    id: value.id,
    name: value.name,
    limit: { context: BOOM_CONTEXT_LIMIT, output: value.output },
    reasoning: value.reasoning,
    attachment: value.attachment,
    ...(value.pricing ? { pricing: value.pricing } : {}),
  }
}

function inferredDriver(provider: ManagedProviderConfig, fallback?: BoomProviderDriverID) {
  if (provider.driver) return provider.driver
  if (provider.npm?.includes("anthropic")) return "anthropic"
  if (provider.npm?.includes("openai") || provider.custom) return "openai-compatible"
  return fallback
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Compile packaged Provider definitions plus the user's non-secret provider/model overrides. */
export async function loadBoomProviderRegistry(
  resourceRoot: string,
  overrides: BoomProviderRegistryOverrides = {},
): Promise<BoomProviderRegistry> {
  const raw = JSON.parse(await readFile(path.join(resourceRoot, "runtime", "providers.json"), "utf8"))
  const input = object(raw)
  const source = object(input?.providers)
  if (input?.version !== 1 || !source) throw new Error("Invalid Boom Provider Registry")
  const providers: Record<string, BoomProviderDescriptor> = {}
  for (const [id, value] of Object.entries(source)) {
    const item = object(value)
    const selectedDriver = driver(item?.driver)
    const baseURL = httpURL(item?.baseURL)
    if (
      !PROVIDER_ID.test(id) || !item || typeof item.name !== "string" || !item.name ||
      !selectedDriver || !baseURL || (item.auth !== "api" && item.auth !== "none") ||
      !Array.isArray(item.models)
    ) throw new Error(`Invalid Boom Provider descriptor: ${id}`)
    const models = item.models.map(model)
    if (models.some((entry) => !entry)) throw new Error(`Invalid Boom Provider model: ${id}`)
    providers[id] = {
      id,
      name: item.name,
      driver: selectedDriver,
      baseURL,
      ...(typeof item.api === "string" ? { api: item.api } : {}),
      auth: item.auth,
      disabled: false,
      custom: false,
      hiddenModels: [],
      models: Object.fromEntries((models as BoomProviderModel[]).map((entry) => [entry.id, entry])),
    }
  }

  const store = await loadProviderStore()
  for (const managed of Object.values(store.providers)) {
    const packaged = providers[managed.id]
    const selectedDriver = inferredDriver(managed, packaged?.driver)
    const baseURL = httpURL(managed.baseURL) ?? packaged?.baseURL
    if (!selectedDriver || !baseURL) {
      if (managed.custom) throw new Error(`Native Provider ${managed.id} requires a supported driver and Base URL`)
      continue
    }
    const models = { ...(packaged?.models ?? {}) }
    for (const item of managed.models) models[item.id] = managedModel(item)
    providers[managed.id] = {
      id: managed.id,
      name: managed.name ?? packaged?.name ?? managed.id,
      driver: selectedDriver,
      baseURL,
      ...(managed.api ?? packaged?.api ? { api: managed.api ?? packaged?.api } : {}),
      auth: packaged?.auth ?? "api",
      disabled: managed.disabled,
      custom: managed.custom,
      hiddenModels: [...new Set(managed.hiddenModels)],
      models,
    }
  }
  for (const [id, override] of Object.entries(overrides)) {
    const existing = providers[id]
    if (!existing) continue
    const baseURL = override.baseURL === undefined ? existing.baseURL : httpURL(override.baseURL)
    if (!baseURL) throw new Error(`Invalid Boom Provider Base URL override: ${id}`)
    providers[id] = { ...existing, baseURL }
  }
  return freeze({ version: 1, providers })
}

export function defaultProviderModel(id: string, name = id): BoomProviderModel {
  return {
    id,
    name,
    limit: { context: BOOM_CONTEXT_LIMIT, output: 16_384 },
    reasoning: false,
    attachment: false,
  }
}
