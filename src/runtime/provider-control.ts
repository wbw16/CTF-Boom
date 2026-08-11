import type {
  ProviderRuntime,
  RuntimeAuthMethod,
  RuntimeOAuthAuthorization,
  RuntimeProvider,
  RuntimeProviderCatalog,
  RuntimeProviderDiscoveryInput,
} from "../runtime-contract.ts"
import {
  removeProviderAPIKey,
  resolveProviderCredential,
  setProviderAPIKey,
  type ProviderCredential,
} from "./credential-store.ts"
import { discoverRemoteProviderModels } from "./provider-discovery.ts"
import {
  type BoomProviderDescriptor,
  type BoomProviderModel,
  type BoomProviderRegistry,
} from "./provider-registry.ts"

function runtimeProvider(provider: BoomProviderDescriptor, discovered: readonly BoomProviderModel[]): RuntimeProvider {
  const models: Record<string, BoomProviderModel> = { ...provider.models }
  for (const item of discovered) {
    if (!models[item.id]) models[item.id] = item
  }
  return {
    id: provider.id,
    name: provider.name,
    models,
    driver: provider.driver,
    baseURL: provider.baseURL,
    ...(provider.api ? { api: provider.api } : {}),
  }
}

/** Native Provider catalog and credential lifecycle. Secrets never enter catalog objects or task state. */
export class BoomNativeProviderControl implements ProviderRuntime {
  #registry: BoomProviderRegistry
  #credentials: Readonly<Record<string, ProviderCredential>>

  constructor(
    registry: BoomProviderRegistry,
    credentials: Readonly<Record<string, ProviderCredential>> = {},
  ) {
    this.#registry = registry
    this.#credentials = credentials
  }

  async listProviders(): Promise<RuntimeProviderCatalog> {
    const providers = Object.values(this.#registry.providers)
    const readiness = await Promise.all(providers.map(async (provider) => {
      const credential = provider.auth === "api"
        ? await resolveProviderCredential(provider.id, this.#credentials[provider.id])
        : undefined
      return {
        provider,
        credential,
        connected: !provider.disabled && (provider.auth === "none" || credential !== undefined),
      }
    }))
    const all = await Promise.all(readiness.map(async ({ provider, credential, connected }) => {
      const discovered = connected
        ? await discoverRemoteProviderModels({
            baseURL: provider.baseURL,
            driver: provider.driver,
            ...(credential ? {
              apiKey: credential.key,
              credentialStyle: credential.style,
            } : {}),
          }).catch(() => [])
        : []
      return runtimeProvider(provider, discovered)
    }))
    return {
      connected: readiness.filter((item) => item.connected).map((item) => item.provider.id),
      all,
    }
  }

  async discoverModels(input: RuntimeProviderDiscoveryInput) {
    const provider = this.#registry.providers[input.providerID]
    const baseURL = input.baseURL ?? provider?.baseURL
    const driver = input.driver ?? provider?.driver
    if (!baseURL || !driver)
      throw new Error(`Provider ${input.providerID} requires a Driver and Base URL for model discovery`)
    const supplied = input.apiKey?.trim()
    const credential = supplied
      ? {
          key: supplied,
          style: this.#credentials[input.providerID]?.key === supplied
            ? this.#credentials[input.providerID]!.style
            : "api-key" as const,
        }
      : provider?.auth === "api"
        ? await resolveProviderCredential(input.providerID, this.#credentials[input.providerID])
        : undefined
    if (provider?.auth === "api" && !credential)
      throw new Error(`Provider ${input.providerID} requires an API Key to fetch models`)
    return discoverRemoteProviderModels({
      baseURL,
      driver,
      ...(credential ? {
        apiKey: credential.key,
        credentialStyle: credential.style,
      } : {}),
    })
  }

  async listProviderAuth(): Promise<Record<string, RuntimeAuthMethod[]>> {
    return Object.fromEntries(Object.values(this.#registry.providers).map((provider) => [
      provider.id,
      provider.auth === "api" ? [{ type: "api", label: "API Key" }] : [],
    ]))
  }

  async setProviderCredential(providerID: string, key: string) {
    const provider = this.#registry.providers[providerID]
    if (!provider || provider.auth !== "api") throw new Error(`Unknown configured Provider: ${providerID}`)
    await setProviderAPIKey(providerID, key)
  }

  async authorizeProviderOAuth(
    _providerID: string,
    _method: number,
  ): Promise<RuntimeOAuthAuthorization> {
    throw new Error("Boom Native Provider OAuth is not supported by the configured registry")
  }

  async completeProviderOAuth(_providerID: string, _method: number, _code?: string): Promise<void> {
    throw new Error("Boom Native Provider OAuth is not supported by the configured registry")
  }

  async removeProviderCredential(providerID: string) {
    if (!this.#registry.providers[providerID]) throw new Error(`Unknown configured Provider: ${providerID}`)
    await removeProviderAPIKey(providerID)
  }
}
