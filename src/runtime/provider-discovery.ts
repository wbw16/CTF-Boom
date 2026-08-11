import type {
  RuntimeProviderDiscoveryInput,
  RuntimeProviderModel,
} from "../runtime-contract.ts"
import { BOOM_CONTEXT_LIMIT } from "../provider-config.ts"
import {
  anthropicProviderBaseURL,
  providerFailure,
  providerFetch,
  providerJSON,
} from "./provider-http.ts"

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function discoverableOpenAIModel(id: string) {
  return /^(?:gpt-|o\d|chatgpt-|codex-|computer-use-|deep-research-)/.test(id)
}

function defaultModel(id: string, name: string): RuntimeProviderModel {
  return {
    id,
    name,
    limit: { context: BOOM_CONTEXT_LIMIT, output: 16_384 },
    reasoning: false,
    attachment: false,
  }
}

/** Fetch a Provider's remote model catalog without persisting its credential. */
export async function discoverRemoteProviderModels(
  input: Omit<RuntimeProviderDiscoveryInput, "providerID"> & {
    baseURL: string
    driver: NonNullable<RuntimeProviderDiscoveryInput["driver"]>
    credentialStyle?: "api-key" | "bearer"
  },
): Promise<RuntimeProviderModel[]> {
  const key = input.apiKey?.trim()
  const response = await providerFetch({
    baseURL: input.driver === "anthropic"
      ? anthropicProviderBaseURL(input.baseURL)
      : input.baseURL,
    ...(input.driver === "anthropic"
      ? {
          apiKey: undefined,
          headers: {
            ...(key && input.credentialStyle === "bearer"
              ? { Authorization: `Bearer ${key}` }
              : key
                ? { "x-api-key": key }
                : {}),
            "anthropic-version": "2023-06-01",
          },
        }
      : { ...(key ? { apiKey: key } : {}) }),
    endpoint: input.driver === "anthropic" ? "models?limit=1000" : "models",
    signal: AbortSignal.timeout(10_000),
  })
  const body = await providerJSON(response)
  if (!Array.isArray(body.data)) throw providerFailure({
    message: "Provider model response must contain a data array",
    category: "malformed-response",
  })
  const models = body.data.flatMap((value) => {
    const item = object(value)
    const id = typeof item?.id === "string" ? item.id.trim() : ""
    if (
      !id || id.length > 240 || /\s/.test(id) ||
      (input.driver === "openai" && !discoverableOpenAIModel(id))
    ) return []
    const name = typeof item?.display_name === "string" && item.display_name.trim()
      ? item.display_name.trim()
      : typeof item?.name === "string" && item.name.trim()
        ? item.name.trim()
        : id
    return [defaultModel(id, name)]
  })
  const unique = [...new Map(models.map((model) => [model.id, model])).values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  if (unique.length === 0) throw providerFailure({
    message: "Provider returned no usable models",
    category: "malformed-response",
  })
  return unique
}
