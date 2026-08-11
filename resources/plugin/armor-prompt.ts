import type { Plugin } from "@opencode-ai/plugin"
import { lstat, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type StoredPrompt = { id?: unknown; prompt?: unknown }
type StoredModel = { id?: unknown; armorPrompt?: unknown }

const BOOM_AGENT_MARKERS = [
  "You are operating as a role inside Boom",
  "You are Boom. The current workspace contains one CTF challenge.",
  "Boom's CTF-solving agent",
  "You are a Boom worker.",
  "Boom escalation point",
  "Boom consultation",
]

const DYNAMIC_ENVIRONMENT_FIELD =
  /^\s*(?:Working directory|Workspace root folder|Today's date):/

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function storePath() {
  const home = path.resolve(
    process.env.BOOM_HOME ?? path.join(os.homedir(), ".config", "boom"),
  )
  return path.join(home, "providers.json")
}

/** Resolve defensively: a broken optional preset must never prevent an LLM call. */
async function readArmorPrompt(
  providerID: string,
  modelID: string,
): Promise<string | undefined> {
  try {
    const target = storePath()
    const info = await lstat(target).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink()) return undefined
    const store = object(JSON.parse(await readFile(target, "utf8")))
    const providers = object(store?.providers)
    const provider = object(providers?.[providerID])
    const models = Array.isArray(provider?.models)
      ? (provider.models as StoredModel[])
      : []
    const selected = models.find((model) => model?.id === modelID)?.armorPrompt
    if (typeof selected !== "string" || selected === "") return undefined
    const prompts = Array.isArray(store?.armorPrompts)
      ? (store.armorPrompts as StoredPrompt[])
      : []
    const prompt = prompts.find((item) => item?.id === selected)?.prompt
    if (typeof prompt !== "string" || prompt.trim() === "") return undefined
    return prompt.trim()
  } catch {
    return undefined
  }
}

function isBoomSystem(system: unknown) {
  return Array.isArray(system) && system.some((part) =>
    typeof part === "string" && BOOM_AGENT_MARKERS.some((marker) => part.includes(marker)),
  )
}

/**
 * OpenCode places the run's absolute directory and current date inside the same system block as the
 * agent prompt. Boom addresses its workspace through stable relative paths, so those fields add no
 * useful context and make an otherwise reusable prompt prefix different for every run.
 */
export function stripDynamicBoomEnvironment(system: string) {
  return system.replace(/<env>([\s\S]*?)<\/env>/g, (_block, body: string) => {
    const stable = body
      .split(/\r?\n/)
      .filter((line) => !DYNAMIC_ENVIRONMENT_FIELD.test(line))
      .join("\n")
    return `<env>${stable}</env>`
  })
}

const ArmorPromptPlugin: Plugin = async () => ({
  "experimental.chat.system.transform": async (input, output) => {
    if (isBoomSystem(output.system)) {
      for (let index = 0; index < output.system.length; index += 1) {
        const system = output.system[index]
        if (typeof system === "string") output.system[index] = stripDynamicBoomEnvironment(system)
      }
      // Boom receives only the task contract. Model-specific presets must not
      // inject solving experience or suggested techniques into Boom roles.
      return
    }

    const prompt = await readArmorPrompt(input.model.providerID, input.model.id)
    if (prompt) output.system.unshift(prompt)
  },
})

export default ArmorPromptPlugin
