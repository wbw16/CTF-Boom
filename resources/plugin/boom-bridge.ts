import { tool, type Plugin } from "@opencode-ai/plugin"
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

const BoomBridgePlugin: Plugin = async () => {
  const base = process.env.BOOM_TOOL_BRIDGE_URL
  const token = process.env.BOOM_TOOL_BRIDGE_TOKEN
  if (!base || !token) return {}
  const response = await fetch(`${base}/registry`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Boom Tool Bridge registry failed: HTTP ${response.status}`)
  const registry = await response.json() as Registry
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
    "tool.definition": async (input, output) => {
      const descriptor = registry.tools[input.toolID]
      if (descriptor?.implementation !== "boom") return
      output.description = descriptor.description
      ;(output as unknown as { jsonSchema: JsonSchema }).jsonSchema = descriptor.schema
    },
  }
}

export default BoomBridgePlugin
