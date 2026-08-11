import { createHash } from "node:crypto"

export const PROMPT_LAYERS = [
  "armor",
  "policy",
  "identity",
  "role",
  "tools",
  "environment",
  "memory",
  "skills",
  "turn",
] as const

export type PromptLayer = typeof PROMPT_LAYERS[number]
export type PromptStability = "stable" | "task" | "turn"
export type PromptSensitivity = "public" | "task" | "secret"

export type PromptSectionInput = {
  source: string
  content: string
  stability: PromptStability
  cacheable: boolean
  sensitivity: PromptSensitivity
}

export type PromptSection = PromptSectionInput & {
  layer: PromptLayer
  contentHash: string
}

export type PromptBundle = {
  version: 1
  sections: Record<PromptLayer, PromptSection[]>
  promptVersion: string
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizedContent(value: string) {
  return value.replace(/\r\n/g, "\n").trim()
}

/** Build the backend-neutral prompt representation in Boom's canonical layer order. */
export function createPromptBundle(
  input: Partial<Record<PromptLayer, readonly PromptSectionInput[]>>,
): PromptBundle {
  const sections = Object.fromEntries(PROMPT_LAYERS.map((layer) => [
    layer,
    (input[layer] ?? []).map((section) => {
      const content = normalizedContent(section.content)
      if (!section.source.trim()) throw new Error(`Prompt ${layer} section is missing its source`)
      if (!content) throw new Error(`Prompt ${layer} section from ${section.source} is empty`)
      if (section.cacheable && section.stability !== "stable")
        throw new Error(`Only stable prompt sections may be cacheable: ${section.source}`)
      if (section.cacheable && section.sensitivity === "secret")
        throw new Error(`Secret prompt sections may not be cacheable: ${section.source}`)
      return {
        ...section,
        source: section.source.trim(),
        content,
        layer,
        contentHash: sha256(content),
      }
    }),
  ])) as Record<PromptLayer, PromptSection[]>

  const promptVersion = sha256(JSON.stringify(PROMPT_LAYERS.flatMap((layer) =>
    sections[layer].map((section) => ({
      layer,
      source: section.source,
      stability: section.stability,
      cacheable: section.cacheable,
      sensitivity: section.sensitivity,
      contentHash: section.contentHash,
    })),
  )))
  return { version: 1, sections, promptVersion }
}

export function orderedPromptSections(bundle: PromptBundle) {
  return PROMPT_LAYERS.flatMap((layer) => bundle.sections[layer])
}

/** Compile selected IR layers to one compatibility-system block without losing layer metadata. */
export function compilePromptText(
  bundle: PromptBundle,
  layers: readonly PromptLayer[] = PROMPT_LAYERS,
) {
  return layers.flatMap((layer) => bundle.sections[layer]).map((section) => section.content).join("\n\n")
}

/** Stable cache prefix ends before task-specific environment, memory, skills, and turn content. */
export function stablePromptPrefix(bundle: PromptBundle) {
  return ["armor", "policy", "identity", "role", "tools"]
    .flatMap((layer) => bundle.sections[layer as PromptLayer])
    .filter((section) => section.stability === "stable" && section.cacheable)
    .map((section) => section.content)
    .join("\n\n")
}
