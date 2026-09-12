import { tool, type Plugin } from "@opencode-ai/plugin"
import { mkdir } from "node:fs/promises"
import path from "node:path"

type JsonSchema = {
  type?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  additionalProperties?: boolean
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

type Descriptor = {
  description: string
  implementation: "boom" | "runtime" | "compatibility"
  schema: JsonSchema
}

type Registry = {
  version: 1
  tools: Record<string, Descriptor>
}

function zod(schema: JsonSchema): any {
  const z = tool.schema
  let value: any
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length > 0 && schema.enum.every((item) => typeof item === "string"))
      value = z.enum(schema.enum as [string, ...string[]])
    else {
      const literals = schema.enum.map((item) => z.literal(item as any))
      value = literals.length === 1 ? literals[0] : z.union(literals as [any, any, ...any[]])
    }
  } else if (schema.type === "string") {
    value = z.string()
    if (schema.minLength !== undefined) value = value.min(schema.minLength)
    if (schema.maxLength !== undefined) value = value.max(schema.maxLength)
  } else if (schema.type === "integer" || schema.type === "number") {
    value = z.number()
    if (schema.type === "integer") value = value.int()
    if (schema.minimum !== undefined) value = value.min(schema.minimum)
    if (schema.maximum !== undefined) value = value.max(schema.maximum)
  } else if (schema.type === "boolean") {
    value = z.boolean()
  } else if (schema.type === "array") {
    value = z.array(zod(schema.items ?? {}))
    if (schema.minItems !== undefined) value = value.min(schema.minItems)
    if (schema.maxItems !== undefined) value = value.max(schema.maxItems)
  } else if (schema.type === "object") {
    value = z.object(shape(schema))
    if (schema.additionalProperties === false) value = value.strict()
  } else {
    value = z.unknown()
  }
  return value
}

function shape(schema: JsonSchema): Record<string, any> {
  const required = new Set(schema.required ?? [])
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, child]) => {
    const value = zod(child)
    return [name, required.has(name) ? value : value.optional()]
  }))
}

function normalizeArguments(name: string, input: Record<string, unknown>, directory: string) {
  const args = { ...input }
  const pathKey = name === "read" || name === "edit"
    ? "filePath"
    : name === "list" || name === "glob" || name === "grep"
      ? "path"
      : name === "bash"
        ? "workdir"
        : name === "boom-exec"
          ? "cwd"
          : undefined
  if (pathKey && typeof args[pathKey] === "string" && path.isAbsolute(args[pathKey])) {
    const relative = path.relative(path.resolve(directory), path.resolve(args[pathKey]))
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
      args[pathKey] = relative || "."
  }
  return args
}

const BoomBridgePlugin: Plugin = async (pluginInput) => {
  const base = process.env.BOOM_TOOL_BRIDGE_URL
  const token = process.env.BOOM_TOOL_BRIDGE_TOKEN
  if (!base || !token) return {}
  const response = await fetch(`${base}/registry`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Boom Tool Bridge registry failed: HTTP ${response.status}`)
  const registry = await response.json() as Registry
  const sessionAgents = new Map<string, string>()
  const sessionDirectories = new Map<string, string>()
  const progressRevision = new Map<string, string>()
  /**
   * The task directory of a session, as OpenCode recorded it. `pluginInput.worktree` is the
   * project worktree, which falls back to the filesystem root for an engagement that is not a git
   * repository; writing there is both wrong and impossible. Only `<root>/tasks/<slug>/<task-id>`
   * (or the legacy `<root>/engagements/<slug>`) is accepted, so a Flag session can never be pointed
   * at an arbitrary directory.
   */
  const engagementDirectory = async (sessionID: string) => {
    const cached = sessionDirectories.get(sessionID)
    if (cached) return cached
    const session = await pluginInput.client.session.get({ path: { id: sessionID } })
    const directory = session.data?.directory
    if (typeof directory !== "string" || directory === "" || !isEngagementWorkspace(directory))
      throw new Error(`Boom Flag session ${sessionID} is not running inside an engagement workspace`)
    sessionDirectories.set(sessionID, directory)
    return directory
  }
  const definitions = Object.fromEntries(Object.entries(registry.tools).flatMap(([name, descriptor]) => {
    if (descriptor.implementation !== "boom" || descriptor.schema.type !== "object") return []
    return [[name, tool({
      description: descriptor.description,
      args: shape(descriptor.schema),
      async execute(args, ctx) {
        const result = await fetch(`${base}/execute`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name,
            arguments: normalizeArguments(name, args, ctx.directory),
            directory: ctx.directory,
            agent: ctx.agent,
            sessionID: ctx.sessionID,
          }),
          signal: ctx.abort,
        })
        const body = await result.json() as { result?: { title: string; output: string; metadata?: Record<string, unknown> }; error?: string }
        if (!result.ok || !body.result) throw new Error(body.error || `Boom Tool Bridge failed: HTTP ${result.status}`)
        return body.result
      },
    })]]
  }))
  return {
    tool: definitions,
    "chat.message": async (input) => {
      if (input.agent) sessionAgents.set(input.sessionID, input.agent)
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task" || sessionAgents.get(input.sessionID) !== "boom-flag-hunt") return
      if (output.args?.subagent_type !== "boom-pentest-worker")
        throw new Error("boom-flag-hunt may delegate only to boom-pentest-worker")
      if (typeof output.args?.prompt !== "string" || output.args.prompt.trim() === "")
        throw new Error("Flag worker task prompt must be non-empty")
      const safeCallID = input.callID.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "worker"
      const relativeDirectory = `work/workers/${safeCallID}`
      await mkdir(path.join(await engagementDirectory(input.sessionID), relativeDirectory), {
        recursive: true,
        mode: 0o700,
      })
      output.args.prompt = [
        output.args.prompt,
        "",
        "# Host-enforced Boom worker contract",
        `- Your assigned output directory is ${relativeDirectory}. Put every created file there.`,
        "- You are bound to the current engagement; read task.json for current scope and objectives, but never edit it.",
        "- Work only on this assigned path. Do not delegate and do not modify the root NOTES.md.",
        "- On a concrete value, call pentest-flag immediately; evidence is optional and submission does not require verification.",
      ].join("\n")
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const agent = sessionAgents.get(input.sessionID)
      if (agent !== "boom-flag-hunt" && agent !== "boom-pentest-worker") return
      const directory = await engagementDirectory(input.sessionID).catch(() => undefined)
      if (!directory) return
      const progressResponse = await fetch(`${base}/pentest-progress`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          directory,
          agent,
          sessionID: input.sessionID,
        }),
      })
      if (!progressResponse.ok) return
      const progress = await progressResponse.json() as { revision?: unknown; text?: unknown }
      if (typeof progress.revision !== "string" || typeof progress.text !== "string" || !progress.text) return
      if (progressRevision.get(input.sessionID) === progress.revision) return
      progressRevision.set(input.sessionID, progress.revision)
      output.system.push(progress.text)
    },
    "tool.definition": async (input, output) => {
      const descriptor = registry.tools[input.toolID]
      if (descriptor?.implementation !== "boom") return
      output.description = descriptor.description
      ;(output as unknown as { jsonSchema: JsonSchema }).jsonSchema = descriptor.schema
    },
  }
}

/**
 * True when a session directory is a Boom engagement workspace: `<root>/tasks/<slug>/<task-id>`
 * in the current layout, or the legacy `<root>/engagements/<slug>`. Plugins are self-contained, so
 * the directory names are checked locally instead of importing Boom's layout module.
 */
function isEngagementWorkspace(directory: string): boolean {
  const resolved = path.resolve(directory)
  const parent = path.basename(path.dirname(resolved))
  const grandparent = path.basename(path.dirname(path.dirname(resolved)))
  return grandparent === "tasks" || parent === "engagements"
}

export default BoomBridgePlugin
