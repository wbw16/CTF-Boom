import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_GUI_SETTINGS,
  loadRootGuiState,
  saveRootGuiState,
} from "../src/gui-state.ts"
import { label, why } from "../frontend/src/state.ts"
import type { ChallengeGui, RunHistory } from "../frontend/src/types.ts"

describe("GUI state", () => {
  test("isolates settings and challenge lifecycle by canonical root", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "boom-gui-state-"))
    const previous = process.env.BOOM_HOME
    process.env.BOOM_HOME = home
    try {
      const rootA = path.join(home, "contest-a")
      const rootB = path.join(home, "contest-b")
      await saveRootGuiState(rootA, {
        settings: {
          ...DEFAULT_GUI_SETTINGS,
          economyModel: "openai/gpt-a-mini",
          strongModel: "openai/gpt-a",
          tokens: 123_000,
          flagFormat: "A\\{[^}]*\\}",
        },
        challenges: {
          alpha: { state: "given-up" },
        },
      })
      await saveRootGuiState(rootB, {
        settings: {
          ...DEFAULT_GUI_SETTINGS,
          economyModel: "openai/gpt-b-mini",
          strongModel: "openai/gpt-b",
          repeats: 9,
        },
        challenges: {
          beta: { state: "removed" },
        },
      })

      expect(await loadRootGuiState(rootA)).toMatchObject({
        settings: {
          economyModel: "openai/gpt-a-mini",
          strongModel: "openai/gpt-a",
          tokens: 123_000,
          flagFormat: "A\\{[^}]*\\}",
        },
        challenges: {
          alpha: { state: "given-up" },
        },
      })
      expect((await loadRootGuiState(rootA)).challenges.beta).toBeUndefined()
      expect(await loadRootGuiState(rootB)).toMatchObject({
        settings: {
          economyModel: "openai/gpt-b-mini",
          strongModel: "openai/gpt-b",
          repeats: 9,
        },
        challenges: { beta: { state: "removed" } },
      })
      expect((await loadRootGuiState(rootB)).challenges.alpha).toBeUndefined()
      expect(await loadRootGuiState(path.join(home, "unseen"))).toEqual({
        settings: DEFAULT_GUI_SETTINGS,
        challenges: {},
      })
    } finally {
      if (previous === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("GUI challenge presentation", () => {
  test("presents a legacy missing-remote block as resumable", () => {
    const run = {
      id: "legacy-run",
      model: "test/model",
      stop: "blocked",
      tokens: 0,
      billableTokens: 0,
      cost: 0,
      candidates: [],
      alternatives: [],
      flagFormat: "",
      reply: "",
      detail: "challenge requires an external service, but meta.json has no reachable remote endpoint",
      events: [],
      notes: "",
      files: [],
    } satisfies RunHistory
    const challenge = {
      slug: "service-task",
      category: "CRYPTO",
      storagePath: "CRYPTO/service-task",
      files: [],
      serviceRequired: true,
      runs: [run],
    } satisfies ChallengeGui

    expect(label(challenge)).toEqual(["待继续", "c-warn"])
    expect(why(challenge)).toContain("直接继续本地分析")
  })
})
