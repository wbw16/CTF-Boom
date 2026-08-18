import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { RuntimeModelPricing } from "./runtime-contract.ts"
import { exactEndpointURL, isExactEndpoint } from "./runtime/provider-http.ts"

export type ManagedProviderDriver = "openai-compatible" | "openai" | "anthropic"

export type ManagedModelConfig = {
  id: string
  /** Original runtime-catalog ID when an operator gives a catalog model a replacement ID. */
  catalogID?: string
  name: string
  context: number
  output: number
  reasoning: boolean
  attachment: boolean
  armorPrompt?: string
  pricing?: RuntimeModelPricing
}

export type ArmorPromptPreset = {
  id: string
  name: string
  prompt: string
}

export type ManagedProviderConfig = {
  id: string
  custom: boolean
  disabled: boolean
  name?: string
  npm?: string
  api?: string
  baseURL?: string
  driver?: ManagedProviderDriver
  models: ManagedModelConfig[]
  hiddenModels: string[]
}

export type ProviderDiscoveryConfig = Pick<
  ManagedProviderConfig,
  "id" | "custom" | "driver" | "baseURL"
>

export type ProviderStore = {
  version: 1
  armorPrompts: ArmorPromptPreset[]
  providers: Record<string, ManagedProviderConfig>
}

export type RuntimeProviderConfig = {
  provider?: Record<string, Record<string, unknown>>
  disabled_providers?: string[]
  [key: string]: unknown
}

/** Boom's single declared model context window; the runtime compacts completed sessions at this boundary. */
export const BOOM_CONTEXT_LIMIT = 300_000

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ARMOR_PROMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function string(value: unknown, maximum = 240) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed !== "" && trimmed.length <= maximum && !trimmed.includes("\0")
    ? trimmed
    : undefined
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function pricing(value: unknown): RuntimeModelPricing | undefined {
  const input = object(value)
  const amount = (item: unknown) => typeof item === "number" && Number.isFinite(item) && item >= 0
    ? item
    : undefined
  const inputCost = amount(input?.input)
  const outputCost = amount(input?.output)
  if (inputCost === undefined || outputCost === undefined) return undefined
  const reasoning = amount(input?.reasoning)
  const cacheRead = amount(input?.cacheRead)
  const cacheWrite = amount(input?.cacheWrite)
  return {
    input: inputCost,
    output: outputCost,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  }
}

function model(value: unknown): ManagedModelConfig | undefined {
  const input = object(value)
  const id = string(input?.id)
  if (!input || !id || /\s/.test(id)) return undefined
  const catalogID = string(input.catalogID)
  if (catalogID && /\s/.test(catalogID)) return undefined
  const armorPromptID = string(input.armorPrompt, 120)
  const modelPricing = pricing(input.pricing)
  if (input.pricing !== undefined && !modelPricing) return undefined
  return {
    id,
    ...(catalogID ? { catalogID } : {}),
    name: string(input.name) ?? id,
    context: BOOM_CONTEXT_LIMIT,
    output: positiveInteger(input.output, 16_384),
    reasoning: input.reasoning === true,
    attachment: input.attachment === true,
    ...(modelPricing ? { pricing: modelPricing } : {}),
    ...(armorPromptID && ARMOR_PROMPT_ID.test(armorPromptID)
      ? { armorPrompt: armorPromptID }
      : {}),
  }
}

function armorPrompt(value: unknown): ArmorPromptPreset | undefined {
  const input = object(value)
  const id = string(input?.id, 120)
  const name = string(input?.name, 120)
  const prompt = string(input?.prompt, 100_000)
  if (!input || !id || !ARMOR_PROMPT_ID.test(id) || !name || !prompt)
    return undefined
  return { id, name, prompt }
}

function provider(value: unknown, key?: string): ManagedProviderConfig | undefined {
  const input = object(value)
  const id = string(input?.id) ?? key
  if (!input || !id || !PROVIDER_ID.test(id)) return undefined
  const models = Array.isArray(input.models)
    ? input.models.flatMap((item) => model(item) ?? [])
    : []
  const hiddenModels = Array.isArray(input.hiddenModels)
    ? input.hiddenModels.flatMap((item) => {
        const id = string(item)
        return id && !/\s/.test(id) ? [id] : []
      })
    : []
  const driver = input.driver === "openai-compatible" || input.driver === "openai" || input.driver === "anthropic"
    ? input.driver
    : undefined
  return {
    id,
    custom: input.custom === true,
    disabled: input.disabled === true,
    ...(string(input.name) ? { name: string(input.name) } : {}),
    ...(string(input.npm) ? { npm: string(input.npm) } : {}),
    ...(string(input.api, 2_000) ? { api: string(input.api, 2_000) } : {}),
    ...(string(input.baseURL, 2_000)
      ? { baseURL: string(input.baseURL, 2_000) }
      : {}),
    ...(driver ? { driver } : {}),
    models: [...new Map(models.map((item) => [item.id, item])).values()],
    hiddenModels: [...new Set(hiddenModels)],
  }
}

export function initialProviderStore(): ProviderStore {
  return { version: 1, armorPrompts: [], providers: {} }
}

export function parseProviderStore(value: unknown): ProviderStore | undefined {
  const input = object(value)
  if (!input || input.version !== 1) return undefined
  const armorPrompts = Array.isArray(input.armorPrompts)
    ? input.armorPrompts.flatMap((item) => armorPrompt(item) ?? [])
    : []
  const providers: Record<string, ManagedProviderConfig> = {}
  const rawProviders = object(input.providers) ?? {}
  for (const [id, value] of Object.entries(rawProviders)) {
    const parsed = provider(value, id)
    if (parsed) providers[parsed.id] = parsed
  }
  return {
    version: 1,
    armorPrompts: [
      ...new Map(armorPrompts.map((item) => [item.id, item])).values(),
    ],
    providers,
  }
}

export function normalizeArmorPromptPresets(
  value: unknown,
): ArmorPromptPreset[] {
  if (!Array.isArray(value))
    throw new Error("Invalid armor prompt list")
  const prompts = value.map((item) => {
    const parsed = armorPrompt(item)
    if (!parsed)
      throw new Error(
        "Invalid armor prompt: each item requires a valid ID, name, and prompt",
      )
    return parsed
  })
  if (new Set(prompts.map((item) => item.id)).size !== prompts.length)
    throw new Error("Invalid armor prompt: IDs must be unique")
  if (
    new Set(prompts.map((item) => item.name.toLocaleLowerCase())).size !==
    prompts.length
  )
    throw new Error("Invalid armor prompt: names must be unique")
  return prompts
}

export function replaceArmorPromptPresets(
  store: ProviderStore,
  value: unknown,
): ProviderStore {
  const armorPrompts = normalizeArmorPromptPresets(value)
  const available = new Set(armorPrompts.map((item) => item.id))
  return {
    ...store,
    armorPrompts,
    providers: Object.fromEntries(
      Object.entries(store.providers).map(([id, entry]) => [
        id,
        {
          ...entry,
          models: entry.models.map((item) => {
            if (!item.armorPrompt || available.has(item.armorPrompt)) return item
            const { armorPrompt: _removed, ...model } = item
            return model
          }),
        },
      ]),
    ),
  }
}

export function normalizeManagedProvider(value: unknown) {
  const input = object(value)
  const rawID = typeof input?.id === "string" ? input.id.trim() : undefined
  if (!rawID || !PROVIDER_ID.test(rawID))
    throw new Error(
      "Provider ID must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens (1-64 characters)",
    )
  const parsed = provider(value)
  if (!parsed) throw new Error("Invalid provider configuration")
  if (parsed.baseURL) assertProviderBaseURL(parsed.baseURL)
  if (parsed.custom) {
    if (!parsed.name) throw new Error("Custom provider requires a name")
    if (!parsed.driver && !parsed.npm)
      throw new Error("Custom provider requires a Native protocol Driver or compatibility npm adapter")
    if (!parsed.baseURL) throw new Error("Custom provider requires a Base URL")
    if (parsed.models.length === 0)
      throw new Error("Custom provider requires at least one model")
  }
  return parsed
}

/** Validate the non-secret fields needed to fetch a model catalog before a Provider is saved. */
export function normalizeProviderDiscovery(value: unknown): ProviderDiscoveryConfig {
  const parsed = provider(value)
  if (!parsed) throw new Error("Invalid provider configuration")
  if (parsed.baseURL) assertProviderBaseURL(parsed.baseURL)
  if (parsed.custom && (!parsed.driver || !parsed.baseURL))
    throw new Error("Custom provider requires a Native protocol Driver and Base URL to fetch models")
  return {
    id: parsed.id,
    custom: parsed.custom,
    ...(parsed.driver ? { driver: parsed.driver } : {}),
    ...(parsed.baseURL ? { baseURL: parsed.baseURL } : {}),
  }
}

/**
 * Validate a Provider Base URL.
 *
 * A trailing `!` marks a URL that is already a complete endpoint instead of a prefix, for gateways
 * that answer only at one fixed address. The marker is stripped before validation and before any
 * request; see EXACT_ENDPOINT_MARKER in runtime/provider-http.ts.
 */
export function assertProviderBaseURL(value: string) {
  const candidate = isExactEndpoint(value) ? exactEndpointURL(value) : value
  if (!candidate.trim())
    throw new Error("Provider Base URL must not be empty")
  try {
    const url = new URL(candidate)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error("unsupported protocol")
  } catch {
    throw new Error("Provider Base URL must be a credential-free HTTP(S) URL without query or fragment")
  }
  return value
}

export function providerStorePath() {
  const home = path.resolve(
    process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"),
  )
  return path.join(home, "providers.json")
}

export async function loadProviderStore() {
  const target = providerStorePath()
  const info = await lstat(target).catch(() => undefined)
  if (!info) return initialProviderStore()
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Provider configuration is not a real file: ${target}`)
  try {
    const parsed = parseProviderStore(JSON.parse(await readFile(target, "utf8")))
    if (!parsed) throw new Error("unsupported provider store format")
    return parsed
  } catch (error) {
    throw new Error(
      `Failed to read provider configuration at ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

export async function saveProviderStore(store: ProviderStore) {
  const normalized = parseProviderStore(store)
  if (!normalized) throw new Error("Invalid provider store")
  const target = providerStorePath()
  await mkdir(path.dirname(target), { recursive: true })
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(`Provider configuration is not a real file: ${target}`)
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(normalized, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporary, target)
  return normalized
}

export function mergeRuntimeProviderConfig(
  base: RuntimeProviderConfig,
  store: ProviderStore,
) {
  const output = structuredClone(base)
  const providers = { ...(output.provider ?? {}) }
  const disabled = new Set(output.disabled_providers ?? [])
  for (const entry of Object.values(store.providers)) {
    if (entry.disabled) disabled.add(entry.id)
    else disabled.delete(entry.id)
    const existing = providers[entry.id] ?? {}
    const existingOptions = object(existing.options) ?? {}
    const existingModels = object(existing.models) ?? {}
    const configuredModels = Object.fromEntries(
      entry.models.map((item) => [
        item.id,
        {
          id: item.id,
          name: item.name,
          reasoning: item.reasoning,
          attachment: item.attachment,
          limit: { context: BOOM_CONTEXT_LIMIT, output: item.output },
          modalities: {
            input: item.attachment ? ["text", "image"] : ["text"],
            output: ["text"],
          },
        },
      ]),
    )
    providers[entry.id] = {
      ...existing,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.npm ? { npm: entry.npm } : {}),
      ...(entry.api ? { api: entry.api } : {}),
      ...(entry.baseURL
        ? { options: { ...existingOptions, baseURL: entry.baseURL } }
        : {}),
      ...(Object.keys(configuredModels).length
        ? { models: { ...existingModels, ...configuredModels } }
        : {}),
      ...(() => {
        const blacklist = new Set(entry.hiddenModels)
        for (const model of entry.models) {
          if (model.catalogID && model.catalogID !== model.id) blacklist.add(model.catalogID)
        }
        return blacklist.size
          ? { blacklist: [...blacklist].sort() }
          : { blacklist: undefined }
      })(),
    }
  }
  // Packaged and runtime-provided model entries must follow the same boundary as GUI-managed ones.
  // Keep output limits provider-specific; only the total context window is product-owned here.
  for (const [providerID, providerValue] of Object.entries(providers)) {
    const provider = object(providerValue)
    const models = object(provider?.models)
    if (!provider || !models) continue
    providers[providerID] = {
      ...provider,
      models: Object.fromEntries(Object.entries(models).map(([modelID, modelValue]) => {
        const configured = object(modelValue)
        if (!configured) return [modelID, modelValue]
        const limit = object(configured.limit) ?? {}
        return [modelID, {
          ...configured,
          limit: { ...limit, context: BOOM_CONTEXT_LIMIT },
        }]
      })),
    }
  }
  output.provider = providers
  output.disabled_providers = [...disabled].sort()
  return output
}
