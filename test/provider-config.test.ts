import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  BOOM_CONTEXT_LIMIT,
  loadProviderStore,
  mergeRuntimeProviderConfig,
  normalizeArmorPromptPresets,
  normalizeManagedProvider,
  providerStorePath,
  replaceArmorPromptPresets,
  saveProviderStore,
} from "../src/provider-config.ts"

describe("provider configuration", () => {
  test("merges custom providers, model visibility, and disabled providers", () => {
    const provider = normalizeManagedProvider({
      id: "local-lab",
      custom: true,
      disabled: false,
      name: "Local Lab",
      npm: "@ai-sdk/openai-compatible",
      driver: "openai-compatible",
      baseURL: "http://127.0.0.1:9000/v1",
      models: [
        {
          id: "reasoner",
          name: "Reasoner",
          context: 64_000,
          output: 8_000,
          reasoning: true,
          attachment: false,
          pricing: { input: 0.25, output: 1.5 },
        },
      ],
      hiddenModels: [],
    })
    const merged = mergeRuntimeProviderConfig(
      {
        provider: {
          openai: { blacklist: ["old"], options: { baseURL: "https://old" } },
        },
        disabled_providers: ["legacy"],
      },
      {
        version: 1,
        armorPrompts: [],
        providers: {
          openai: {
            id: "openai",
            custom: false,
            disabled: false,
            models: [],
            hiddenModels: ["deprecated-model"],
          },
          "local-lab": provider,
        },
      },
    )
    expect(merged.disabled_providers).toEqual(["legacy"])
    expect(merged.provider?.openai).toMatchObject({
      blacklist: ["deprecated-model"],
    })
    expect(merged.provider?.["local-lab"]).toMatchObject({
      name: "Local Lab",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9000/v1" },
      models: {
        reasoner: {
          name: "Reasoner",
          reasoning: true,
          limit: { context: BOOM_CONTEXT_LIMIT, output: 8_000 },
        },
      },
    })
    expect(JSON.stringify(merged)).not.toContain("apiKey")
    expect(provider.driver).toBe("openai-compatible")
    expect(provider.models[0]?.context).toBe(BOOM_CONTEXT_LIMIT)
    expect(provider.models[0]?.pricing).toEqual({ input: 0.25, output: 1.5 })
    expect(normalizeManagedProvider({
      id: "native-only",
      custom: true,
      disabled: false,
      name: "Native only",
      driver: "anthropic",
      baseURL: "https://example.com/v1",
      models: [{ id: "model", name: "model" }],
      hiddenModels: [],
    }).npm).toBeUndefined()
  })

  test("persists non-secret provider state atomically and refuses a symlink file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "boom-providers-"))
    const previous = process.env.BOOM_HOME
    process.env.BOOM_HOME = directory
    try {
      await saveProviderStore({
        version: 1,
        armorPrompts: [],
        providers: {
          test: {
            id: "test",
            custom: false,
            disabled: true,
            models: [],
            hiddenModels: ["large"],
          },
        },
      })
      expect(await loadProviderStore()).toMatchObject({
        providers: { test: { disabled: true, hiddenModels: ["large"] } },
      })
      await rm(providerStorePath())
      const outside = path.join(directory, "outside.json")
      await writeFile(outside, "{}")
      await symlink(outside, providerStorePath())
      await expect(
        saveProviderStore({ version: 1, armorPrompts: [], providers: {} }),
      ).rejects.toThrow("not a real file")
    } finally {
      if (previous === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previous
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects unsafe custom provider identifiers and endpoints", () => {
    expect(() =>
      normalizeManagedProvider({
        id: "../escape",
        custom: true,
        name: "Bad",
        npm: "@ai-sdk/openai-compatible",
        baseURL: "file:///tmp/socket",
        models: [{ id: "x", name: "x" }],
      }),
    ).toThrow("Provider ID must start with a lowercase letter or number")
    expect(() => normalizeManagedProvider({
      id: "unsafe-url",
      custom: true,
      name: "Unsafe URL",
      driver: "openai-compatible",
      baseURL: "https://secret@example.com/v1?token=leak",
      models: [{ id: "x", name: "x" }],
    })).toThrow("credential-free")
    expect(() =>
      normalizeManagedProvider({
        id: "bad-price",
        custom: true,
        name: "Bad Price",
        npm: "@ai-sdk/openai-compatible",
        driver: "openai-compatible",
        baseURL: "https://example.com/v1",
        models: [{ id: "x", name: "x", pricing: { input: -1, output: 1 } }],
      }),
    ).toThrow("at least one model")
  })

  test("keeps a renamed catalog model while blacklisting its original ID", () => {
    const merged = mergeRuntimeProviderConfig(
      {
        provider: {
          openai: {
            models: { "catalog-model": { id: "catalog-model", name: "Catalog model" } },
          },
        },
      },
      {
        version: 1,
        armorPrompts: [],
        providers: {
          openai: {
            id: "openai",
            custom: false,
            disabled: false,
            models: [{
              id: "gateway-model",
              catalogID: "catalog-model",
              name: "Gateway model",
              context: 128_000,
              output: 16_384,
              reasoning: true,
              attachment: false,
            }],
            hiddenModels: [],
          },
        },
      },
    )
    expect(merged.provider?.openai).toMatchObject({
      blacklist: ["catalog-model"],
      models: { "gateway-model": { name: "Gateway model" } },
    })
  })

  test("normalizes armor prompts and clears deleted model assignments", () => {
    const prompts = normalizeArmorPromptPresets([
      { id: "general", name: "General", prompt: "  pinned first  " },
    ])
    expect(prompts).toEqual([
      { id: "general", name: "General", prompt: "pinned first" },
    ])
    const replaced = replaceArmorPromptPresets(
      {
        version: 1,
        armorPrompts: prompts,
        providers: {
          openai: {
            id: "openai",
            custom: false,
            disabled: false,
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                context: 128_000,
                output: 16_384,
                reasoning: true,
                attachment: false,
                armorPrompt: "general",
              },
            ],
            hiddenModels: [],
          },
        },
      },
      [],
    )
    expect(replaced.armorPrompts).toEqual([])
    expect(replaced.providers.openai?.models[0]?.armorPrompt).toBeUndefined()
    expect(() =>
      normalizeArmorPromptPresets([
        { id: "one", name: "Same", prompt: "a" },
        { id: "two", name: "same", prompt: "b" },
      ]),
    ).toThrow("names must be unique")
  })
})
