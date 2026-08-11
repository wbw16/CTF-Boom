import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"

export type BoomStateToolName = "skill" | "todowrite"

export type BoomTodo = {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "high" | "medium" | "low"
}

export type BoomStateToolResult = {
  title: string
  output: string
  metadata?: Record<string, unknown>
}

const MAX_SKILL_BYTES = 128 * 1024
const MAX_VISIBLE_BYTES = 32_768
const MAX_SKILL_FILES = 100
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/

function inside(base: string, target: string): boolean {
  const relative = path.relative(base, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function bounded(text: string): { output: string; truncated: boolean } {
  const bytes = Buffer.from(text)
  if (bytes.byteLength <= MAX_VISIBLE_BYTES) return { output: text, truncated: false }
  const suffix = "\n… skill content truncated by Boom …"
  return {
    output: new TextDecoder().decode(bytes.subarray(0, MAX_VISIBLE_BYTES - Buffer.byteLength(suffix))) + suffix,
    truncated: true,
  }
}

async function skillFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const visit = async (current: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted()
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (files.length >= MAX_SKILL_FILES) return
      const target = path.join(current, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const info = await lstat(target)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await visit(target, relative)
      else if (info.isFile() && relative !== "SKILL.md") files.push(relative)
    }
  }
  await visit(directory, "")
  return files
}

async function executeSkill(
  skillRoot: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BoomStateToolResult> {
  const name = typeof input.name === "string" ? input.name : ""
  if (!SKILL_NAME.test(name)) throw new Error(`Invalid Boom skill name: ${name || "<empty>"}`)
  const root = await realpath(skillRoot)
  if (!(await lstat(root)).isDirectory()) throw new Error("Boom skill root is not a directory")
  const directory = path.join(root, name)
  const directoryInfo = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Boom skill not found: ${name}`)
    throw error
  })
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error(`Boom skill is not a real directory: ${name}`)
  const canonical = await realpath(directory)
  if (!inside(root, canonical)) throw new Error(`Boom skill escapes the resource root: ${name}`)
  const file = path.join(canonical, "SKILL.md")
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Boom skill has no SKILL.md: ${name}`)
    throw error
  })
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Boom skill entry is not a real file: ${name}`)
  if (info.size > MAX_SKILL_BYTES) throw new Error(`Boom skill exceeds the ${MAX_SKILL_BYTES}-byte limit: ${name}`)
  signal?.throwIfAborted()
  const content = (await readFile(file, "utf8")).trim()
  const files = await skillFiles(canonical, signal)
  const rendered = bounded([
    `<skill_content name="${name}">`,
    `# Skill: ${name}`,
    "",
    content,
    "",
    `Base directory: skills/${name}`,
    "Relative references are resolved from this Boom-owned skill directory.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n"))
  return {
    title: `Loaded skill: ${name}`,
    output: rendered.output,
    metadata: { name, files, truncated: rendered.truncated },
  }
}

function todoItems(input: Record<string, unknown>): BoomTodo[] {
  if (!Array.isArray(input.todos)) throw new Error("todowrite todos must be an array")
  return input.todos.map((item) => ({ ...(item as BoomTodo) }))
}

export function createBoomStateToolExecutor(skillRoot: string) {
  const todos = new Map<string, readonly BoomTodo[]>()
  return async (input: {
    name: BoomStateToolName
    arguments: Record<string, unknown>
    directory: string
    profileID: string
    sessionID?: string
    signal?: AbortSignal
  }): Promise<BoomStateToolResult> => {
    if (input.name === "skill") return executeSkill(skillRoot, input.arguments, input.signal)
    if (!input.sessionID) throw new Error("todowrite requires a runtime session ID")
    const root = await realpath(input.directory)
    const key = `${root}\0${input.sessionID}`
    const next = todoItems(input.arguments)
    todos.set(key, Object.freeze(next.map((item) => Object.freeze(item))))
    const open = next.filter((item) => item.status !== "completed" && item.status !== "cancelled").length
    return {
      title: `${open} todos`,
      output: JSON.stringify(next, undefined, 2),
      metadata: { todos: next, sessionID: input.sessionID },
    }
  }
}
