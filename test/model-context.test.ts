import { expect, test } from "bun:test"
import { runtimeModelLimits } from "../src/model-context.ts"
import { discoverRemoteProviderModels } from "../src/runtime/provider-discovery.ts"

test("real capacities stay intact while the input window reserves output and operating space", () => {
  expect(runtimeModelLimits(64_000, 8_000)).toEqual({ context: 64_000, output: 8_000, input: 49_600 })
  expect(runtimeModelLimits(1_000_000, 32_000)).toEqual({ context: 1_000_000, output: 32_000, input: 259_808 })
  expect(runtimeModelLimits(128_000, 8_000, 64_000).input).toBe(64_000)
  expect(runtimeModelLimits(undefined, 16_384).context).toBe(128_000)
  expect(runtimeModelLimits(4_096, 16_384)).toEqual({ context: 4_096, output: 3_686, input: 1 })
  expect(runtimeModelLimits(NaN, NaN, NaN)).toEqual(runtimeModelLimits(undefined, 16_384))
})

test("remote discovery retains declared capacities and uses an editable fallback when absent", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ data: [
    { id: "small", context_length: 64_000, max_output_tokens: 8_000 },
    { id: "large", limit: { context: 1_000_000, output: 32_000 }, reasoning: true },
    { id: "unknown" },
  ] }) })
  try {
    const models = await discoverRemoteProviderModels({ baseURL: server.url.href, driver: "openai-compatible" })
    expect(models.find((model) => model.id === "small")?.limit.context).toBe(64_000)
    expect(models.find((model) => model.id === "large")?.limit.context).toBe(1_000_000)
    expect(models.find((model) => model.id === "unknown")?.limit.context).toBe(128_000)
  } finally { server.stop(true) }
})
