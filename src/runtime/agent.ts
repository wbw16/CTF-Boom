import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  openCodeMcpToolPattern,
  type ManagedMcpServer,
} from "../mcp-config.ts"
import {
  compilePromptText,
  createPromptBundle,
  type PromptBundle,
} from "./prompt.ts"
import {
  loadBoomToolRegistry,
  type BoomToolCatalog,
  type BoomToolProfile,
  type ToolEffectPolicy,
} from "./tool-registry.ts"
import type { ModelPolicy } from "../model-policy.ts"

export type {
  BoomToolCatalog,
  BoomToolDescriptor,
  BoomToolProfile,
  BoomToolRegistry,
  ToolEffectPolicy,
} from "./tool-registry.ts"

export type BoomAgentMode = "primary" | "subagent"
export type BoomAgentRole =
  | "solver"
  | "worker"
  | "intake"
  | "consultant"
  | "analyzer"
  | "challenger"
  | "arbiter"
  | "verifier"

export type BoomAgentResource = {
  version: 1
  id: string
  mode: BoomAgentMode
  role: BoomAgentRole
  description: string
  color: string
  temperature: number
  toolProfile: string
  output: "freeform" | "prompt-contract"
  /** Declared model tier; resolved to the current policy's model in the generated runtime config. */
  model?: keyof ModelPolicy
}

export type CompiledBoomAgent = {
  resource: BoomAgentResource
  profile: BoomToolProfile
  prompt: PromptBundle
  openCodeMarkdown: string
}

export type CompiledBoomAgentRegistry = {
  version: 1
  promptVersion: string
  catalog: BoomToolCatalog
  agents: CompiledBoomAgent[]
  /**
   * Host-wide network policy captured at compile time. "deny" overrides every profile's
   * `effects.network` (so webfetch/websearch are refused on both runtimes) and is handed to the
   * tool host so bash/boom-exec sandboxes drop network too. Consumers read it from the registry
   * instead of threading the option through their own constructors.
   */
  network: "allow" | "deny"
}

const AGENT_ID = /^boom(?:-[a-z][a-z0-9-]*)?$/
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/
const ROLES = new Set<BoomAgentRole>([
  "solver", "worker", "intake", "consultant", "analyzer", "challenger", "arbiter", "verifier",
])

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function parseAgent(value: unknown, directory: string): BoomAgentResource {
  const item = object(value)
  const role = item?.role
  if (
    item?.version !== 1 ||
    typeof item.id !== "string" || !AGENT_ID.test(item.id) || item.id !== path.basename(directory) ||
    (item.mode !== "primary" && item.mode !== "subagent") ||
    typeof role !== "string" || !ROLES.has(role as BoomAgentRole) ||
    typeof item.description !== "string" || !item.description.trim() ||
    typeof item.color !== "string" || !HEX_COLOR.test(item.color) ||
    typeof item.temperature !== "number" || !Number.isFinite(item.temperature) || item.temperature < 0 || item.temperature > 2 ||
    typeof item.toolProfile !== "string" || !item.toolProfile ||
    (item.output !== "freeform" && item.output !== "prompt-contract") ||
    (item.model !== undefined && item.model !== "economy" && item.model !== "strong")
  ) throw new Error(`Invalid Boom agent resource: ${directory}/agent.json`)
  return item as BoomAgentResource
}

function toolContract(profileID: string, profile: BoomToolProfile) {
  const effects = profile.effects
  return [
    "## Tool contract",
    `Boom tool profile: ${profileID}.`,
    `Available tools: ${profile.tools.join(", ")}.`,
    `Side effects: write=${effects.write}; process=${effects.process}; network=${effects.network}; durable-memory=${effects.memory}; submit=${effects.submit}; delegation=${effects.delegate}.`,
    "A listed tool remains discoverable even when its side effect is denied; the runtime permission layer enforces the profile.",
  ].join("\n")
}

type CompatibilityPermission = "allow" | "deny" | Record<string, "allow" | "deny">

function compatibilityPermissions(
  effects: ToolEffectPolicy,
  agentID: string,
  mcpServers: ManagedMcpServer[],
) {
  const permissions: Record<string, CompatibilityPermission> = {
    "*": "allow",
    question: "deny",
    external_directory: "deny",
  }
  if (effects.write === "none") permissions.edit = "deny"
  else permissions.edit = {
    "*": "allow",
    "challenge/**": "deny",
    "**/challenge/**": "deny",
  }
  if (effects.process === "deny") {
    permissions.bash = "deny"
    permissions["boom-exec"] = "deny"
  }
  if (effects.network === "deny") {
    permissions.webfetch = "deny"
    permissions.websearch = "deny"
  }
  if (effects.memory === "deny") {
    permissions["ctf-note"] = "deny"
    permissions.todowrite = "deny"
  }
  if (effects.submit === "deny") permissions["ctf-submit"] = "deny"
  if (effects.delegate === "deny") permissions.task = "deny"
  for (const server of mcpServers) {
    if (!server.agents.some((id) => id === agentID))
      permissions[openCodeMcpToolPattern(server.id)] = "deny"
  }
  return permissions
}

function yamlKey(value: string) {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value) ? value : JSON.stringify(value)
}

function yamlObject(value: Record<string, unknown>, indent = 0): string[] {
  const prefix = " ".repeat(indent)
  return Object.entries(value).flatMap(([key, item]) => {
    if (item && typeof item === "object" && !Array.isArray(item))
      return [`${prefix}${yamlKey(key)}:`, ...yamlObject(item as Record<string, unknown>, indent + 2)]
    return [`${prefix}${yamlKey(key)}: ${typeof item === "string" ? JSON.stringify(item) : String(item)}`]
  })
}

export function compileOpenCodeAgent(
  resource: BoomAgentResource,
  profile: BoomToolProfile,
  catalog: BoomToolCatalog,
  prompt: PromptBundle,
  mcpServers: ManagedMcpServer[] = [],
  models?: ModelPolicy,
) {
  // OpenCode turns an explicit `tool: true` entry into a trailing allow permission, which would
  // override a more specific path/effect deny. Enabled tools therefore use the runtime default;
  // only profile exclusions are emitted as compatibility `false` entries.
  const disabledTools = Object.fromEntries(
    Object.keys(catalog.tools).sort().filter((id) => !profile.tools.includes(id)).map((id) => [id, false]),
  )
  const declaredModel = resource.model ? models?.[resource.model] : undefined
  const frontmatter = {
    mode: resource.mode,
    description: resource.description,
    color: resource.color,
    temperature: resource.temperature,
    ...(declaredModel ? { model: declaredModel } : {}),
    ...(Object.keys(disabledTools).length > 0 ? { tools: disabledTools } : {}),
    permission: compatibilityPermissions(profile.effects, resource.id, mcpServers),
  }
  return [
    "---",
    "# Generated from resources/runtime; do not edit this compatibility artifact.",
    ...yamlObject(frontmatter),
    "---",
    "",
    compilePromptText(prompt, ["policy", "identity", "role", "tools"]),
    "",
  ].join("\n")
}

/** Load and compile every neutral Boom agent resource. */
export async function compileBoomAgentRegistry(
  resourceRoot: string,
  mcpServers: ManagedMcpServer[] = [],
  models?: ModelPolicy,
  visionModel?: string,
  network: "allow" | "deny" = "allow",
): Promise<CompiledBoomAgentRegistry> {
  const runtimeRoot = path.join(resourceRoot, "runtime")
  const [policy, identity, catalog, entries] = await Promise.all([
    readFile(path.join(runtimeRoot, "policies", "immutable.md"), "utf8"),
    readFile(path.join(runtimeRoot, "identity.md"), "utf8"),
    loadBoomToolRegistry(resourceRoot),
    readdir(path.join(runtimeRoot, "agents"), { withFileTypes: true }),
  ])
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  const agents = await Promise.all(directories.map(async (id) => {
    const directory = path.join(runtimeRoot, "agents", id)
    const [resourceSource, role] = await Promise.all([
      readFile(path.join(directory, "agent.json"), "utf8"),
      readFile(path.join(directory, "SYSTEM.md"), "utf8"),
    ])
    const resource = parseAgent(JSON.parse(resourceSource), directory)
    const baseProfile = catalog.profiles[resource.toolProfile]
    if (!baseProfile) throw new Error(`Unknown Boom tool profile ${resource.toolProfile} for ${resource.id}`)
    let profile: BoomToolProfile = baseProfile
    // A host-wide network deny overrides the profile's own policy, so every agent (solver, worker,
    // consultant, …) is uniformly offline and the runtime permission layer refuses web tools.
    if (network === "deny")
      profile = { ...profile, effects: { ...profile.effects, network: "deny" } }
    if (resource.id === "boom" && visionModel)
      profile = { ...profile, tools: [...profile.tools, "describe-image"] }
    const prompt = createPromptBundle({
      policy: [{ source: "runtime/policies/immutable.md", content: policy, stability: "stable", cacheable: true, sensitivity: "public" }],
      identity: [{ source: "runtime/identity.md", content: identity, stability: "stable", cacheable: true, sensitivity: "public" }],
      role: [
        { source: `runtime/agents/${id}/SYSTEM.md`, content: role, stability: "stable", cacheable: true, sensitivity: "public" },
        ...(resource.id === "boom" && visionModel ? [{
          source: "runtime:vision-tool",
          content: "Your current model cannot inspect images directly. When visible image content matters, call `describe-image` with a task-relative path and a focused question; use local tools for byte-level image analysis.",
          stability: "stable" as const,
          cacheable: true,
          sensitivity: "public" as const,
        }] : []),
      ],
      tools: [{ source: `runtime/tool-profiles.json#${resource.toolProfile}`, content: toolContract(resource.toolProfile, profile), stability: "stable", cacheable: true, sensitivity: "public" }],
    })
    return {
      resource,
      profile,
      prompt,
      openCodeMarkdown: compileOpenCodeAgent(resource, profile, catalog, prompt, mcpServers, models),
    }
  }))
  if (agents.length === 0 || new Set(agents.map((agent) => agent.resource.id)).size !== agents.length)
    throw new Error("Boom agent registry is empty or contains duplicate IDs")
  const promptVersion = sha256(JSON.stringify({
    catalog,
    models: models ?? null,
    agents: agents.map((agent) => ({ id: agent.resource.id, resource: agent.resource, prompt: agent.prompt.promptVersion })),
  }))
  return { version: 1, promptVersion, catalog, agents, network }
}

/** Generate the private OpenCode compatibility files from Boom-owned neutral resources. */
export async function installOpenCodeAgentResources(
  resourceRoot: string,
  targetRoot: string,
  mcpServers: ManagedMcpServer[] = [],
  models?: ModelPolicy,
  visionModel?: string,
  network: "allow" | "deny" = "allow",
) {
  const registry = await compileBoomAgentRegistry(resourceRoot, mcpServers, models, visionModel, network)
  const agentDirectory = path.join(targetRoot, "agent")
  await mkdir(agentDirectory, { recursive: true })
  await Promise.all(registry.agents.map((agent) =>
    writeFile(path.join(agentDirectory, `${agent.resource.id}.md`), agent.openCodeMarkdown, "utf8")
  ))
  await writeFile(path.join(targetRoot, "boom-agent-manifest.json"), `${JSON.stringify({
    version: 1,
    promptVersion: registry.promptVersion,
    agents: registry.agents.map((agent) => ({
      id: agent.resource.id,
      role: agent.resource.role,
      toolProfile: agent.resource.toolProfile,
      promptVersion: agent.prompt.promptVersion,
    })),
  }, undefined, 2)}\n`, "utf8")
  return registry
}
