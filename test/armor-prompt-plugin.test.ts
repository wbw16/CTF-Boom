import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import ArmorPromptPlugin from "../resources/plugin/armor-prompt.ts"

const previousHome = process.env.BOOM_HOME
let temporary: string | undefined

afterEach(async () => {
  if (previousHome === undefined) delete process.env.BOOM_HOME
  else process.env.BOOM_HOME = previousHome
  if (temporary) await rm(temporary, { recursive: true, force: true })
  temporary = undefined
})

async function writeStore(value: unknown) {
  temporary = await mkdtemp(path.join(os.tmpdir(), "boom-armor-plugin-"))
  process.env.BOOM_HOME = temporary
  await mkdir(temporary, { recursive: true })
  await writeFile(
    path.join(temporary, "providers.json"),
    JSON.stringify(value),
  )
}

describe("armor prompt runtime plugin", () => {
  test("removes per-run directories and the date from Boom system prompts", async () => {
    await writeStore({ version: 1, armorPrompts: [], providers: {} })
    const hooks = await ArmorPromptPlugin({} as never)
    const output = {
      system: [
        [
          "You are Boom, Boom's CTF-solving agent.",
          "Here is some useful information about the environment you are running in:",
          "<env>",
          "  Working directory: /tmp/ctf/runs/example/20260801T000000Z",
          "  Workspace root folder: /tmp/ctf/runs/example/20260801T000000Z",
          "  Is directory a git repo: yes",
          "  Platform: darwin",
          "  Today's date: Sat Aug 01 2026",
          "</env>",
          "STABLE INSTRUCTIONS",
        ].join("\n"),
      ],
    }
    await hooks["experimental.chat.system.transform"]!(
      { model: { providerID: "openai", id: "gpt-test" } } as never,
      output,
    )
    expect(output.system).toEqual([
      [
        "You are Boom, Boom's CTF-solving agent.",
        "Here is some useful information about the environment you are running in:",
        "<env>",
        "  Is directory a git repo: yes",
        "  Platform: darwin",
        "</env>",
        "STABLE INSTRUCTIONS",
      ].join("\n"),
    ])
  })

  test("does not alter OpenCode environment fields for a non-Boom agent", async () => {
    await writeStore({ version: 1, armorPrompts: [], providers: {} })
    const hooks = await ArmorPromptPlugin({} as never)
    const system = [
      "You are another agent.",
      "<env>",
      "  Working directory: /tmp/another-agent",
      "  Today's date: Sat Aug 01 2026",
      "</env>",
    ].join("\n")
    const output = { system: [system] }
    await hooks["experimental.chat.system.transform"]!(
      { model: { providerID: "openai", id: "gpt-test" } } as never,
      output,
    )
    expect(output.system).toEqual([system])
  })

  test("prepends the assigned model prompt before the agent system prompt", async () => {
    await writeStore({
      version: 1,
      armorPrompts: [
        { id: "general", name: "General", prompt: "PINNED FIRST" },
      ],
      providers: {
        openai: {
          id: "openai",
          models: [{ id: "gpt-test", armorPrompt: "general" }],
        },
      },
    })
    const hooks = await ArmorPromptPlugin({} as never)
    const output = { system: ["AGENT SYSTEM PROMPT"] }
    await hooks["experimental.chat.system.transform"]!(
      { model: { providerID: "openai", id: "gpt-test" } } as never,
      output,
    )
    expect(output.system).toEqual(["PINNED FIRST", "AGENT SYSTEM PROMPT"])
  })

  test("does not inject an assigned model prompt into Boom", async () => {
    await writeStore({
      version: 1,
      armorPrompts: [
        { id: "general", name: "General", prompt: "SOLVING ADVICE" },
      ],
      providers: {
        openai: {
          id: "openai",
          models: [{ id: "gpt-test", armorPrompt: "general" }],
        },
      },
    })
    const hooks = await ArmorPromptPlugin({} as never)
    const output = {
      system: ["You are Boom. The current workspace contains one CTF challenge."],
    }
    await hooks["experimental.chat.system.transform"]!(
      { model: { providerID: "openai", id: "gpt-test" } } as never,
      output,
    )
    expect(output.system).toEqual([
      "You are Boom. The current workspace contains one CTF challenge.",
    ])
  })

  test("ignores non-string system entries instead of unloading the plugin", async () => {
    await writeStore({ version: 1, armorPrompts: [], providers: {} })
    const hooks = await ArmorPromptPlugin({} as never)
    const output = {
      system: [
        "You are Boom. The current workspace contains one CTF challenge.",
        undefined,
        "<env>\n  Working directory: /tmp/run\n  Platform: darwin\n</env>",
      ],
    }

    await hooks["experimental.chat.system.transform"]!(
      { model: { providerID: "openai", id: "gpt-test" } } as never,
      output as never,
    )

    expect(output.system).toEqual([
      "You are Boom. The current workspace contains one CTF challenge.",
      undefined,
      "<env>\n  Platform: darwin\n</env>",
    ])
  })

  test("leaves the request unchanged when no valid assignment exists", async () => {
    await writeStore({ version: 1, armorPrompts: [], providers: {} })
    const hooks = await ArmorPromptPlugin({} as never)
    const output = { system: ["AGENT"] }
    await hooks["experimental.chat.system.transform"]!(
      { model: { providerID: "openai", id: "gpt-test" } } as never,
      output,
    )
    expect(output.system).toEqual(["AGENT"])
  })
})
