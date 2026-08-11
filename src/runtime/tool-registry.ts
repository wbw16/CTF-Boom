import { readFile } from "node:fs/promises"
import path from "node:path"

export type BoomToolImplementation = "boom" | "runtime" | "compatibility"

export type ToolEffectPolicy = {
  write: "run" | "branch" | "none"
  process: "allow" | "deny"
  network: "allow" | "deny"
  memory: "allow" | "deny"
  submit: "allow" | "deny"
  delegate: "allow" | "deny"
}

export type BoomToolDescriptor = {
  description: string
  implementation: BoomToolImplementation
  sideEffect: "none" | "read" | "write" | "process" | "network" | "memory"
  schema: Readonly<Record<string, unknown>>
}

export type BoomToolProfile = {
  tools: readonly string[]
  effects: ToolEffectPolicy
}

/** Boom-owned public tool contract. Implementations must consume this registry, never redefine it. */
export type BoomToolRegistry = {
  version: 1
  tools: Readonly<Record<string, BoomToolDescriptor>>
  profiles: Readonly<Record<string, BoomToolProfile>>
}

// Compatibility name retained while callers migrate from the M2 terminology.
export type BoomToolCatalog = BoomToolRegistry

const TOOL_ID = /^[a-z][a-z0-9-]*$/
const IMPLEMENTATIONS = new Set<BoomToolImplementation>(["boom", "runtime", "compatibility"])
const SIDE_EFFECTS = new Set<BoomToolDescriptor["sideEffect"]>([
  "none", "read", "write", "process", "network", "memory",
])

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function parseEffects(value: unknown, id: string): ToolEffectPolicy {
  const item = object(value)
  if (
    (item?.write !== "run" && item?.write !== "branch" && item?.write !== "none") ||
    (item.process !== "allow" && item.process !== "deny") ||
    (item.network !== "allow" && item.network !== "deny") ||
    (item.memory !== "allow" && item.memory !== "deny") ||
    (item.submit !== "allow" && item.submit !== "deny") ||
    (item.delegate !== "allow" && item.delegate !== "deny")
  ) throw new Error(`Invalid Boom tool effect policy: ${id}`)
  return item as ToolEffectPolicy
}

/** Parse and freeze the resource format used by Prompt compilation and every Tool Host. */
export function parseBoomToolRegistry(value: unknown): BoomToolRegistry {
  const input = object(value)
  const rawTools = object(input?.tools)
  const rawProfiles = object(input?.profiles)
  if (input?.version !== 1 || !rawTools || !rawProfiles)
    throw new Error("Invalid Boom tool registry")
  const tools = Object.fromEntries(Object.entries(rawTools).map(([id, raw]) => {
    const item = object(raw)
    const schema = object(item?.schema)
    if (
      !TOOL_ID.test(id) || !item || !schema ||
      typeof item.description !== "string" || !item.description.trim() ||
      typeof item.implementation !== "string" ||
      !IMPLEMENTATIONS.has(item.implementation as BoomToolImplementation) ||
      !SIDE_EFFECTS.has(item.sideEffect as BoomToolDescriptor["sideEffect"])
    ) throw new Error(`Invalid Boom tool descriptor: ${id}`)
    if (item.implementation === "boom" && schema.type !== "object")
      throw new Error(`Boom tool schema must be an object contract: ${id}`)
    return [id, {
      description: item.description,
      implementation: item.implementation,
      sideEffect: item.sideEffect,
      schema,
    } as BoomToolDescriptor]
  }))
  const profiles = Object.fromEntries(Object.entries(rawProfiles).map(([id, raw]) => {
    const item = object(raw)
    if (
      !TOOL_ID.test(id) || !item || !Array.isArray(item.tools) ||
      !item.tools.every((tool) => typeof tool === "string" && tools[tool])
    ) throw new Error(`Invalid Boom tool profile: ${id}`)
    if (new Set(item.tools).size !== item.tools.length)
      throw new Error(`Duplicate tool in Boom profile: ${id}`)
    return [id, { tools: [...item.tools], effects: parseEffects(item.effects, id) }]
  }))
  return freeze({ version: 1, tools, profiles })
}

export async function loadBoomToolRegistry(resourceRoot: string): Promise<BoomToolRegistry> {
  const source = await readFile(path.join(resourceRoot, "runtime", "tool-profiles.json"), "utf8")
  return parseBoomToolRegistry(JSON.parse(source))
}

function invalid(name: string, location: string, detail: string): never {
  throw new Error(`Invalid ${name} arguments at ${location}: ${detail}`)
}

function validateValue(name: string, schema: Record<string, unknown>, value: unknown, location: string): void {
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value)))
    invalid(name, location, `expected one of ${schema.enum.join(", ")}`)
  if (schema.type === "object") {
    const item = object(value)
    if (!item) invalid(name, location, "expected object")
    const properties = object(schema.properties) ?? {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (typeof key === "string" && !Object.hasOwn(item, key))
        invalid(name, `${location}.${key}`, "required value is missing")
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(item)) {
        if (!Object.hasOwn(properties, key)) invalid(name, `${location}.${key}`, "unknown property")
      }
    }
    for (const [key, child] of Object.entries(item)) {
      const childSchema = object(properties[key])
      if (childSchema) validateValue(name, childSchema, child, `${location}.${key}`)
    }
    return
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) invalid(name, location, "expected array")
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      invalid(name, location, `minimum item count is ${schema.minItems}`)
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      invalid(name, location, `maximum item count is ${schema.maxItems}`)
    const itemSchema = object(schema.items)
    if (itemSchema) value.forEach((item, index) => validateValue(name, itemSchema, item, `${location}[${index}]`))
    return
  }
  if (schema.type === "string") {
    if (typeof value !== "string") invalid(name, location, "expected string")
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      invalid(name, location, `minimum length is ${schema.minLength}`)
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      invalid(name, location, `maximum length is ${schema.maxLength}`)
    return
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)))
      invalid(name, location, `expected ${schema.type}`)
    if (typeof schema.minimum === "number" && value < schema.minimum)
      invalid(name, location, `minimum is ${schema.minimum}`)
    if (typeof schema.maximum === "number" && value > schema.maximum)
      invalid(name, location, `maximum is ${schema.maximum}`)
    return
  }
  if (schema.type === "boolean" && typeof value !== "boolean")
    invalid(name, location, "expected boolean")
}

/** Validate provider arguments against the same schema that Prompt and compatibility bridges expose. */
export function validateBoomToolArguments(
  registry: BoomToolRegistry,
  name: string,
  input: Record<string, unknown>,
): BoomToolDescriptor {
  const descriptor = registry.tools[name]
  if (!descriptor) throw new Error(`Unknown Boom tool: ${name}`)
  validateValue(name, descriptor.schema as Record<string, unknown>, input, "$")
  return descriptor
}
