import { appendFile, lstat, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  executeControlledCommand,
  executeControlledShell,
  formatControlledCommand,
  type CommandRequest,
} from "./command-executor.ts"
import { CANDIDATE_SUBMISSION_PATH, submitCandidate } from "./candidate-submission.ts"
import { CONSULTATION_REQUEST_PATH, requestConsultation } from "./consultation-request.ts"
import { loadTaskEnvironment } from "./environment.ts"
import { executeBoomFileTool, type BoomFileToolName } from "./runtime/file-tools.ts"
import {
  assertBoomPolicy,
  decideBoomEffectPolicy,
  decideBoomToolPolicy,
} from "./runtime/policy.ts"
import { createBoomStateToolExecutor, type BoomStateToolName } from "./runtime/state-tools.ts"
import { createBoomNetworkBroker, type BoomNetworkBroker } from "./runtime/network-broker.ts"
import { createBoomWebToolExecutor, type BoomWebToolName } from "./runtime/web-tools.ts"
import {
  validateBoomToolArguments,
  type BoomToolDescriptor,
  type BoomToolRegistry,
} from "./runtime/tool-registry.ts"

export type BoomToolName =
  | BoomFileToolName
  | BoomStateToolName
  | BoomWebToolName
  | "bash"
  | "boom-exec"
  | "ctf-note"
  | "ctf-consult"
  | "ctf-submit"
const MAX_VISIBLE_OUTPUT_BYTES = 32_768

export type BoomToolResult = {
  title: string
  output: string
  metadata?: Record<string, unknown>
}

export interface BoomToolHost {
  readonly names: readonly BoomToolName[]
  readonly definitions: Readonly<Record<BoomToolName, BoomToolDescriptor>>
  execute(input: {
    name: BoomToolName
    arguments: Record<string, unknown>
    directory: string
    profileID: string
    sessionID?: string
    signal?: AbortSignal
  }): Promise<BoomToolResult>
}

const NOTE_HEADER = "# NOTES\n\n这是跨轮次、跨模型共享的任务记忆。由 ctf-note 工具维护。\n"

function strings(value: unknown) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("boom-exec args must be an array of strings")
  return value
}

function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
}

async function executeCommand(
  directory: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BoomToolResult> {
  if (typeof input.program !== "string" || !input.program.trim())
    throw new Error("boom-exec requires program")
  const binding = await loadTaskEnvironment(directory)
  if (!binding) throw new Error("This task has no Python environment binding")
  const requestedMode = input.mode
  const mode = requestedMode === "managed" || requestedMode === "isolated" || requestedMode === "static-only"
    ? requestedMode
    : binding.executionMode
  const purpose = input.purpose === "install" ? "install" : "analysis"
  const timeoutMs = Math.max(100, Math.min(300_000, finite(input.timeoutMs, 30_000)))
  const requestedMaxOutputBytes = Math.max(1_024, Math.min(1_000_000, finite(input.maxOutputBytes, MAX_VISIBLE_OUTPUT_BYTES)))
  const maxOutputBytes = Math.min(requestedMaxOutputBytes, MAX_VISIBLE_OUTPUT_BYTES)
  const request: CommandRequest = {
    program: input.program,
    args: input.args === undefined ? [] : strings(input.args),
    cwd: typeof input.cwd === "string" ? input.cwd : ".",
    mode,
    timeoutMs,
    maxOutputBytes,
    network: input.network === true,
    purpose,
  }
  const result = await executeControlledCommand({ directory, request, signal })
  return {
    title: `${path.basename(result.command[0] ?? request.program)} · exit ${result.exitCode}`,
    output: formatControlledCommand(result),
    metadata: {
      id: result.id,
      exitCode: result.exitCode,
      mode: result.mode,
      logPath: result.logPath,
      environmentFingerprint: result.environmentFingerprint,
      requestedMaxOutputBytes,
      visibleMaxOutputBytes: maxOutputBytes,
    },
  }
}

async function executeShell(
  directory: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<BoomToolResult> {
  const result = await executeControlledShell({
    directory,
    signal,
    request: {
      command: typeof input.command === "string" ? input.command : "",
      ...(typeof input.workdir === "string" ? { workdir: input.workdir } : {}),
      ...(typeof input.timeout === "number" ? { timeout: input.timeout } : {}),
      network: true,
    },
  })
  return {
    title: `bash · exit ${result.exitCode}`,
    output: `${result.output}\nexit=${result.exitCode} duration=${result.durationMs}ms log=${result.logPath}`,
    metadata: {
      id: result.id,
      exitCode: result.exitCode,
      mode: result.mode,
      logPath: result.logPath,
      environmentFingerprint: result.environmentFingerprint,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncated: result.truncated,
    },
  }
}

async function executeNote(directory: string, input: Record<string, unknown>): Promise<BoomToolResult> {
  const kind = input.kind
  const text = typeof input.text === "string" ? input.text.trim() : ""
  if (!["note", "ruled-out", "checkpoint"].includes(String(kind)) || !text)
    throw new Error("ctf-note requires kind=note|ruled-out|checkpoint and non-empty text")
  const target = path.join(directory, "NOTES.md")
  const info = await lstat(target).catch(() => undefined)
  if (info?.isSymbolicLink() || (info && !info.isFile()))
    throw new Error("NOTES.md is not a real file")
  const existing = await readFile(target, "utf8").catch(() => undefined)
  if (kind === "checkpoint") {
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    await writeFile(
      temporary,
      `${text.startsWith("# NOTES") ? text : `${NOTE_HEADER}\n${text}`}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
    await rename(temporary, target)
    return { title: "checkpoint -> NOTES.md", output: `Replaced NOTES.md with a ${text.length}-character task checkpoint.` }
  }
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  await appendFile(
    target,
    `${existing === undefined ? NOTE_HEADER : ""}\n## [${timestamp}] ${kind}\n\n${text}\n`,
    { encoding: "utf8", mode: 0o600 },
  )
  return {
    title: `${kind} -> NOTES.md`,
    output: `Appended ${kind} entry (${(existing?.match(/^## \[/gm)?.length ?? 0) + 1} total).`,
  }
}

async function executeSubmission(
  directory: string,
  sessionID: string | undefined,
  input: Record<string, unknown>,
): Promise<BoomToolResult> {
  if (!sessionID) throw new Error("ctf-submit requires a runtime session ID")
  const submission = await submitCandidate({
    directory,
    sessionID,
    candidate: typeof input.candidate === "string" ? input.candidate : "",
  })
  return {
    title: "candidate recorded",
    output: "Stored the candidate in work/RESULT.json; Boom will stop this solve turn and request a verdict.",
    metadata: { path: CANDIDATE_SUBMISSION_PATH, recordedAt: submission.recordedAt },
  }
}

async function executeConsultationRequest(
  directory: string,
  sessionID: string | undefined,
  input: Record<string, unknown>,
): Promise<BoomToolResult> {
  if (!sessionID) throw new Error("ctf-consult requires a runtime session ID")
  const request = await requestConsultation({
    directory,
    sessionID,
    reason: typeof input.reason === "string" ? input.reason : "",
  })
  return {
    title: "multi-model consultation requested",
    output: "Stored the request; Boom will end this solve turn, run the expert panel, and continue with its synthesis.",
    metadata: { path: CONSULTATION_REQUEST_PATH, requestedAt: request.requestedAt },
  }
}

export function createBoomToolHost(
  registry: BoomToolRegistry,
  options: { skillRoot?: string; networkBroker?: BoomNetworkBroker } = {},
): BoomToolHost {
  const executeStateTool = createBoomStateToolExecutor(
    options.skillRoot ?? path.join(import.meta.dir, "..", "resources", "runtime", "skills"),
  )
  const executeWebTool = createBoomWebToolExecutor(options.networkBroker ?? createBoomNetworkBroker())
  const handlers = {
    bash: (input: Parameters<BoomToolHost["execute"]>[0]) =>
      executeShell(input.directory, input.arguments, input.signal),
    read: (input: Parameters<BoomToolHost["execute"]>[0]) => executeBoomFileTool({ ...input, name: "read" }),
    list: (input: Parameters<BoomToolHost["execute"]>[0]) => executeBoomFileTool({ ...input, name: "list" }),
    glob: (input: Parameters<BoomToolHost["execute"]>[0]) => executeBoomFileTool({ ...input, name: "glob" }),
    grep: (input: Parameters<BoomToolHost["execute"]>[0]) => executeBoomFileTool({ ...input, name: "grep" }),
    edit: (input: Parameters<BoomToolHost["execute"]>[0]) => executeBoomFileTool({ ...input, name: "edit" }),
    skill: (input: Parameters<BoomToolHost["execute"]>[0]) => executeStateTool({ ...input, name: "skill" }),
    todowrite: (input: Parameters<BoomToolHost["execute"]>[0]) => executeStateTool({ ...input, name: "todowrite" }),
    websearch: (input: Parameters<BoomToolHost["execute"]>[0]) => executeWebTool({ ...input, name: "websearch" }),
    webfetch: (input: Parameters<BoomToolHost["execute"]>[0]) => executeWebTool({ ...input, name: "webfetch" }),
    "boom-exec": (input: Parameters<BoomToolHost["execute"]>[0]) =>
      executeCommand(input.directory, input.arguments, input.signal),
    "ctf-note": (input: Parameters<BoomToolHost["execute"]>[0]) =>
      executeNote(input.directory, input.arguments),
    "ctf-consult": (input: Parameters<BoomToolHost["execute"]>[0]) =>
      executeConsultationRequest(input.directory, input.sessionID, input.arguments),
    "ctf-submit": (input: Parameters<BoomToolHost["execute"]>[0]) =>
      executeSubmission(input.directory, input.sessionID, input.arguments),
  } satisfies Record<BoomToolName, (input: Parameters<BoomToolHost["execute"]>[0]) => Promise<BoomToolResult>>
  const names = Object.entries(registry.tools)
    .filter(([, descriptor]) => descriptor.implementation === "boom")
    .map(([name]) => name)
  const handlerNames = Object.keys(handlers)
  if (
    names.length !== handlerNames.length ||
    names.some((name) => !Object.hasOwn(handlers, name)) ||
    handlerNames.some((name) => registry.tools[name]?.implementation !== "boom")
  ) throw new Error("Boom Tool Registry and Tool Host implementations are out of sync")
  const typedNames = names as BoomToolName[]
  const definitions = Object.fromEntries(
    typedNames.map((name) => [name, registry.tools[name]!]),
  ) as Record<BoomToolName, BoomToolDescriptor>
  return {
    names: typedNames,
    definitions,
    async execute(input) {
      const descriptor = validateBoomToolArguments(registry, input.name, input.arguments)
      if (descriptor.implementation !== "boom")
        throw new Error(`Tool is not implemented by the Boom Tool Host: ${input.name}`)
      assertBoomPolicy(decideBoomToolPolicy(registry, input.profileID, input.name), input.name)
      if (input.name === "boom-exec" && input.arguments.network === true)
        assertBoomPolicy(decideBoomEffectPolicy(registry, input.profileID, "network"), `${input.name} network`)
      return await handlers[input.name](input)
    },
  }
}
