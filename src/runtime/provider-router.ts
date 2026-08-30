import type {
  NativeProviderDriver,
  NativeProviderEvent,
  NativeProviderRequest,
} from "./native-provider.ts"
import { AnthropicMessagesProviderDriver } from "./anthropic-driver.ts"
import { OpenAICompatibleProviderDriver } from "./openai-compatible-driver.ts"
import { OpenAIResponsesProviderDriver } from "./openai-responses-driver.ts"
import {
  resolveProviderCredential,
  type ProviderCredential,
} from "./credential-store.ts"
import { providerFailure } from "./provider-http.ts"
import {
  defaultProviderModel,
  type BoomProviderDescriptor,
  type BoomProviderRegistry,
} from "./provider-registry.ts"

function splitModel(value: string) {
  const [providerID, ...modelParts] = value.split("/")
  const modelID = modelParts.join("/")
  if (!providerID || !modelID) throw providerFailure({
    message: `Native model must be provider/model, got: ${value}`,
    category: "invalid-request",
  })
  return { providerID, modelID }
}

function driver(
  descriptor: BoomProviderDescriptor,
  credential: ProviderCredential | undefined,
  modelID: string,
) {
  const model = descriptor.models[modelID] ?? defaultProviderModel(modelID)
  const common = {
    baseURL: descriptor.baseURL,
    ...(credential ? { apiKey: credential.key } : {}),
    ...(model.pricing ? { pricing: model.pricing } : {}),
    // One output ceiling across protocols: without it only Anthropic capped generation, so the
    // same model limit silently did not apply on OpenAI-style gateways.
    ...(model.limit.output !== undefined ? { maxOutputTokens: model.limit.output } : {}),
  }
  if (descriptor.driver === "openai") return new OpenAIResponsesProviderDriver(common)
  if (descriptor.driver === "anthropic") return new AnthropicMessagesProviderDriver({
    ...common,
    ...(credential ? { credentialStyle: credential.style } : {}),
    maxOutputTokens: model.limit.output,
  })
  return new OpenAICompatibleProviderDriver(common)
}

/** Resolve provider/model at request time while keeping each protocol Driver single-provider. */
export class BoomProviderRouter implements NativeProviderDriver {
  readonly id = "boom-provider-router"
  readonly version = "1"
  readonly deniedOrigins: ReadonlySet<string>
  #registry: BoomProviderRegistry
  #credentials: Readonly<Record<string, ProviderCredential>>

  constructor(
    registry: BoomProviderRegistry,
    credentials: Readonly<Record<string, ProviderCredential>> = {},
  ) {
    this.#registry = registry
    this.#credentials = credentials
    this.deniedOrigins = new Set(
      Object.values(registry.providers).map((provider) => new URL(provider.baseURL).origin),
    )
  }

  async *stream(request: NativeProviderRequest): AsyncIterable<NativeProviderEvent> {
    const { providerID, modelID } = splitModel(request.model)
    const provider = this.#registry.providers[providerID]
    if (!provider || provider.disabled) throw providerFailure({
      message: `Boom Provider is unavailable: ${providerID}`,
      category: "unsupported",
    })
    const credential = provider.auth === "api"
      ? await resolveProviderCredential(providerID, this.#credentials[providerID])
      : undefined
    if (provider.auth === "api" && !credential) throw providerFailure({
      message: `Boom Provider ${providerID} is not authenticated`,
      category: "authentication",
    })
    yield* driver(provider, credential, modelID).stream({ ...request, model: modelID })
  }
}
