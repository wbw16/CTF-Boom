import path from "node:path"
import type { RuntimeHandle } from "../runtime-contract.ts"
import { createNativeRuntime, type NativeRuntimeOptions } from "./native-runtime.ts"
import { createBoomNetworkBroker, type NetworkSearchRequest } from "./network-broker.ts"
import { BoomNativeProviderControl } from "./provider-control.ts"
import { loadBoomProviderRegistry } from "./provider-registry.ts"
import { BoomProviderRouter } from "./provider-router.ts"
import {
  providerCredentialEnvironment,
  resolveProviderCredential,
  type ProviderCredential,
} from "./credential-store.ts"
import type { BoomProviderRegistryOverrides } from "./provider-registry.ts"

const DEFAULT_RESOURCE_ROOT = path.resolve(import.meta.dir, "..", "..", "resources")

export type ManagedNativeRuntimeOptions = Omit<NativeRuntimeOptions, "provider" | "providerRuntime" | "networkBroker"> & {
  searchProvider?: (request: NetworkSearchRequest) => Promise<{ provider: string; output: string }>
  providerOverrides?: BoomProviderRegistryOverrides
  providerCredentials?: Readonly<Record<string, ProviderCredential>>
}

/** Assemble Boom's first-party protocol Drivers, credential control, and Native agent kernel. */
export async function createManagedNativeRuntime(
  options: ManagedNativeRuntimeOptions = {},
): Promise<RuntimeHandle> {
  const resourceRoot = options.resourceRoot ?? DEFAULT_RESOURCE_ROOT
  const registry = await loadBoomProviderRegistry(resourceRoot, options.providerOverrides)
  const router = new BoomProviderRouter(registry, options.providerCredentials)
  const providerRuntime = new BoomNativeProviderControl(registry, options.providerCredentials)
  const networkBroker = createBoomNetworkBroker({
    deniedOrigins: router.deniedOrigins,
    ...(options.searchProvider ? { searchProvider: options.searchProvider } : {}),
  })
  return createNativeRuntime({
    provider: router,
    providerRuntime,
    networkBroker,
    resourceRoot,
    ...(options.version ? { version: options.version } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  })
}

/** Read-only Native doctor view. It reports readiness without reading or printing secret values. */
export async function inspectManagedNativeProviders(
  resourceRoot = DEFAULT_RESOURCE_ROOT,
  options: Pick<ManagedNativeRuntimeOptions, "providerOverrides" | "providerCredentials"> = {},
) {
  const registry = await loadBoomProviderRegistry(resourceRoot, options.providerOverrides)
  return Promise.all(Object.values(registry.providers).map(async (provider) => ({
    id: provider.id,
    name: provider.name,
    driver: provider.driver,
    disabled: provider.disabled,
    credential: provider.auth === "none" || Boolean(await resolveProviderCredential(
      provider.id,
      options.providerCredentials?.[provider.id],
    )),
    credentialEnvironment: provider.auth === "api" ? providerCredentialEnvironment(provider.id) : undefined,
    models: Object.keys(provider.models).length,
    dynamicModels: Object.keys(provider.models).length === 0,
  })))
}
