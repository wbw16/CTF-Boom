import { lstat, mkdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import type {
  AgentRuntime,
  RuntimeConversation,
  RuntimeEvent,
  RuntimeFailure,
  RuntimeFinishReason,
  RuntimeForkInput,
  RuntimeHandle,
  RuntimeMessage,
  RuntimePrompt,
  RuntimePromptResult,
  ProviderRuntime,
  RuntimeResponsePart,
  RuntimeToolState,
} from "../runtime-contract.ts"
import { resolveRuntimeForkBoundary } from "../runtime-messages.ts"
import { createBoomToolHost, type BoomToolName, type BoomToolResult } from "../tool-runtime.ts"
import type { BoomNetworkBroker } from "./network-broker.ts"
import {
  compileBoomAgentRegistry,
  type CompiledBoomAgent,
  type CompiledBoomAgentRegistry,
} from "./agent.ts"
import {
  assertBoomPolicy,
  decideBoomToolPolicy,
} from "./policy.ts"
import { compilePromptText } from "./prompt.ts"
import {
  addRuntimeUsage,
  NativeProviderFailure,
  cloneRuntimeUsage,
  emptyRuntimeUsage,
  subtractRuntimeUsage,
  type NativeProviderDriver,
  type NativeProviderTool,
  type NativeProviderToolCall,
} from "./native-provider.ts"
import {
  DEFAULT_NATIVE_KERNEL_LIMITS,
  NativeBudgetExceeded,
  NativeTaskCoordinator,
  normalizeNativeKernelLimits,
  type NativeKernelLimits,
} from "./native-task-tree.ts"
import {
  atomicJson,
  NativeEventBus,
  NativeMessageLedger,
  sanitizeNativeState,
  type NativeLedgerEntry,
} from "./native-storage.ts"
import { validateBoomToolArguments } from "./tool-registry.ts"

const DEFAULT_RESOURCE_ROOT = path.resolve(import.meta.dir, "..", "..", "resources")
const MAX_TOOL_RESULT = 32_768
const CONVERSATION_ID = /^native-[0-9a-f-]+$/i

type NativeRuntimeOptions = {
  provider: NativeProviderDriver
  providerRuntime?: ProviderRuntime
  networkBroker?: BoomNetworkBroker
  resourceRoot?: string
  version?: string
  limits?: Partial<NativeKernelLimits>
  /** Host-wide network switch; "deny" makes the compiled registry and tool sandboxes offline. */
  network?: "allow" | "deny"
}

type NativeManifest = {
  version: 1
  backend: "native"
  conversationID: string
  title: string
  createdAt: string
  provider: { id: string; version: string }
  promptVersion: string
  limits: NativeKernelLimits
  taskID?: string
  parentTaskID?: string
  forkedFrom?: { conversationID: string; messageID: string }
  depth: number
}

type ToolAccumulator = {
  index: number
  id?: string
  name?: string
  arguments: string
}

type ProviderStep = {
  text: string
  reasoning: string
  tools: ToolAccumulator[]
  usage: ReturnType<typeof emptyRuntimeUsage>
  cost: number
  requestID?: string
  finish: RuntimeFinishReason
}

type ToolOutcome = {
  callID: string
  name: string
  input?: Record<string, unknown>
  title: string
  output: string
  error?: string
  terminal?: boolean
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

function failureFrom(error: unknown, signal?: AbortSignal): RuntimeFailure {
  if (error instanceof NativeProviderFailure) return sanitizeNativeState(error.failure, 2_000)
  if (error instanceof NativeBudgetExceeded) return sanitizeNativeState({
    name: error.name,
    message: error.message,
    category: "invalid-request",
    retryable: false,
  }, 2_000)
  if (signal?.aborted) return sanitizeNativeState({
    name: error instanceof Error ? error.name : "AbortError",
    message: errorMessage(signal.reason ?? error ?? "Boom Native conversation cancelled"),
    category: "cancelled",
    retryable: false,
  }, 2_000)
  return sanitizeNativeState({
    ...(error instanceof Error ? { name: error.name } : {}),
    message: errorMessage(error),
    category: "unknown",
    retryable: false,
  }, 2_000)
}

function malformed(message: string) {
  return new NativeProviderFailure({
    name: "MalformedProviderResponse",
    message,
    category: "malformed-response",
    retryable: false,
  })
}

function combineSignals(...signals: Array<AbortSignal | undefined>) {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (available.length === 0) return new AbortController().signal
  return available.length === 1 ? available[0]! : AbortSignal.any(available)
}

function responseText(parts: RuntimeResponsePart[]) {
  const text = parts.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("\n").trim()
  if (text) return text
  return parts.flatMap((part) => part.type === "reasoning" && part.text ? [part.text] : []).join("\n").trim()
}

function providerTools(agent: CompiledBoomAgent, registry: CompiledBoomAgentRegistry): NativeProviderTool[] {
  return agent.profile.tools.flatMap((name) => {
    const descriptor = registry.catalog.tools[name]
    if (!descriptor || descriptor.implementation === "compatibility" || descriptor.schema.type !== "object") return []
    return [{
      name,
      description: descriptor.description,
      parameters: descriptor.schema,
    }]
  })
}

function usagePartState(input: Record<string, unknown> | undefined, outcome: ToolOutcome): RuntimeToolState {
  return outcome.error
    ? { status: "error", ...(input ? { input } : {}), title: outcome.title, error: outcome.error }
    : { status: "completed", ...(input ? { input } : {}), title: outcome.title }
}

function nativeCreatedAt(timestamp: string) {
  const value = Date.parse(timestamp)
  return Number.isFinite(value) ? value : undefined
}

/** Project the durable Native ledger without collapsing tool-use/tool-result records. */
export function normalizeNativeMessages(entries: readonly NativeLedgerEntry[]): RuntimeMessage[] {
  return entries.map((entry) => {
    const createdAt = nativeCreatedAt(entry.timestamp)
    const timestamp = createdAt === undefined ? {} : { createdAt }
    const message = entry.message
    if (message.role === "user") {
      return {
        id: entry.id,
        role: entry.synthetic ? "synthetic" : "user",
        ...timestamp,
        parts: [{ type: "text", text: message.content }],
      }
    }
    if (message.role === "tool") {
      return {
        id: entry.id,
        role: "tool",
        ...timestamp,
        parts: [{
          type: "tool",
          tool: message.name,
          callID: message.toolCallID,
          state: message.isError ? "error" : "completed",
          ...(message.isError ? { error: message.content } : { output: message.content }),
        }],
      }
    }
    return {
      id: entry.id,
      role: "assistant",
      ...timestamp,
      parts: [
        ...(message.content ? [{ type: "text", text: message.content }] : []),
        ...(message.reasoning ? [{ type: "reasoning", text: message.reasoning }] : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: "tool",
          tool: call.name,
          callID: call.id,
          state: "pending" as const,
          input: call.arguments,
        })),
      ],
    }
  })
}

async function assertTaskDirectory(directory: string) {
  const canonical = await realpath(path.resolve(directory))
  const [rootInfo, workInfo] = await Promise.all([
    lstat(canonical),
    lstat(path.join(canonical, "work")),
  ])
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !workInfo.isDirectory() || workInfo.isSymbolicLink())
    throw new Error(`Boom Native task directory is invalid: ${directory}`)
  return canonical
}

class NativeConversation implements RuntimeConversation {
  readonly id: string
  readonly directory: string
  readonly storageDirectory: string
  #title: string
  #provider: NativeProviderDriver
  #registry: CompiledBoomAgentRegistry
  #toolHost: ReturnType<typeof createBoomToolHost>
  #limits: NativeKernelLimits
  #ledger: NativeMessageLedger
  #bus: NativeEventBus
  #coordinator: NativeTaskCoordinator
  #depth: number
  #taskID?: string
  #seenCalls = new Set<string>()
  #providerStep = 0
  #localUsage = emptyRuntimeUsage()
  #localCost = 0
  #promptTail: Promise<void> = Promise.resolve()
  #activeTurn?: Promise<RuntimePromptResult>
  #closed = false

  private constructor(input: {
    id: string
    directory: string
    storageDirectory: string
    title: string
    provider: NativeProviderDriver
    registry: CompiledBoomAgentRegistry
    toolHost: ReturnType<typeof createBoomToolHost>
    limits: NativeKernelLimits
    ledger: NativeMessageLedger
    bus: NativeEventBus
    coordinator: NativeTaskCoordinator
    depth: number
    taskID?: string
  }) {
    this.id = input.id
    this.directory = input.directory
    this.storageDirectory = input.storageDirectory
    this.#title = input.title
    this.#provider = input.provider
    this.#registry = input.registry
    this.#toolHost = input.toolHost
    this.#limits = input.limits
    this.#ledger = input.ledger
    this.#bus = input.bus
    this.#coordinator = input.coordinator
    this.#depth = input.depth
    this.#taskID = input.taskID
    const messages = this.#ledger.messages()
    this.#providerStep = messages.filter((message) => message.role === "assistant").length
    for (const message of messages) {
      if (message.role !== "assistant") continue
      for (const call of message.toolCalls ?? []) this.#seenCalls.add(call.id)
    }
  }

  static async createRoot(input: {
    id: string
    directory: string
    title: string
    provider: NativeProviderDriver
    registry: CompiledBoomAgentRegistry
    toolHost: ReturnType<typeof createBoomToolHost>
    limits: NativeKernelLimits
    tokenBudget?: number
    seedEntries?: readonly NativeLedgerEntry[]
    forkedFrom?: { conversationID: string; messageID: string }
  }) {
    const directory = await assertTaskDirectory(input.directory)
    const storageDirectory = path.join(directory, "work", ".boom", "native", "conversations", input.id)
    await mkdir(storageDirectory, { recursive: true })
    const [ledger, bus] = await Promise.all([
      NativeMessageLedger.open(storageDirectory),
      NativeEventBus.open(storageDirectory),
    ])
    if (input.seedEntries) await ledger.seed(input.seedEntries)
    const coordinator = await NativeTaskCoordinator.open({
      rootDirectory: directory,
      rootSessionID: input.id,
      storageDirectory,
      limits: input.limits,
      tokenBudget: input.tokenBudget,
      bus,
    })
    const manifest: NativeManifest = {
      version: 1,
      backend: "native",
      conversationID: input.id,
      title: input.title,
      createdAt: new Date().toISOString(),
      provider: { id: input.provider.id, version: input.provider.version },
      promptVersion: input.registry.promptVersion,
      limits: input.limits,
      ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
      depth: 0,
    }
    await atomicJson(path.join(storageDirectory, "manifest.json"), manifest)
    const conversation = new NativeConversation({
      ...input,
      directory,
      storageDirectory,
      ledger,
      bus,
      coordinator,
      depth: 0,
    })
    await bus.emit({ type: "conversation-state", sessionID: input.id, state: "created" })
    return conversation
  }

  static async resumeRoot(input: {
    id: string
    directory: string
    provider: NativeProviderDriver
    registry: CompiledBoomAgentRegistry
    toolHost: ReturnType<typeof createBoomToolHost>
    limits?: Partial<NativeKernelLimits>
    tokenBudget?: number
  }) {
    if (!CONVERSATION_ID.test(input.id)) throw new Error(`Invalid Boom Native conversation ID: ${input.id}`)
    const directory = await assertTaskDirectory(input.directory)
    const storageDirectory = path.join(directory, "work", ".boom", "native", "conversations", input.id)
    const source = await readFile(path.join(storageDirectory, "manifest.json"), "utf8")
    const manifest = JSON.parse(source) as NativeManifest
    if (
      manifest.version !== 1 || manifest.backend !== "native" || manifest.conversationID !== input.id ||
      manifest.provider?.id !== input.provider.id || manifest.promptVersion !== input.registry.promptVersion
    ) throw new Error("Boom Native conversation provenance does not match this Runtime")
    const limits = normalizeNativeKernelLimits(input.limits ?? manifest.limits)
    const [ledger, bus] = await Promise.all([
      NativeMessageLedger.open(storageDirectory),
      NativeEventBus.open(storageDirectory),
    ])
    const coordinator = await NativeTaskCoordinator.open({
      rootDirectory: directory,
      rootSessionID: input.id,
      storageDirectory,
      limits,
      tokenBudget: input.tokenBudget,
      bus,
    })
    return new NativeConversation({
      id: input.id,
      directory,
      storageDirectory,
      title: manifest.title,
      provider: input.provider,
      registry: input.registry,
      toolHost: input.toolHost,
      limits,
      ledger,
      bus,
      coordinator,
      depth: 0,
    })
  }

  static async createChild(input: {
    id: string
    directory: string
    title: string
    provider: NativeProviderDriver
    registry: CompiledBoomAgentRegistry
    toolHost: ReturnType<typeof createBoomToolHost>
    limits: NativeKernelLimits
    coordinator: NativeTaskCoordinator
    depth: number
    taskID: string
  }) {
    const directory = await assertTaskDirectory(input.directory)
    const storageDirectory = path.join(directory, "work", ".boom", "native", "conversations", input.id)
    await mkdir(storageDirectory, { recursive: true })
    const [ledger, bus] = await Promise.all([
      NativeMessageLedger.open(storageDirectory),
      NativeEventBus.open(storageDirectory),
    ])
    const manifest: NativeManifest = {
      version: 1,
      backend: "native",
      conversationID: input.id,
      title: input.title,
      createdAt: new Date().toISOString(),
      provider: { id: input.provider.id, version: input.provider.version },
      promptVersion: input.registry.promptVersion,
      limits: input.limits,
      taskID: input.taskID,
      depth: input.depth,
    }
    await atomicJson(path.join(storageDirectory, "manifest.json"), manifest)
    const conversation = new NativeConversation({
      ...input,
      directory,
      storageDirectory,
      ledger,
      bus,
    })
    await bus.emit({ type: "conversation-state", sessionID: input.id, state: "created" })
    return conversation
  }

  async events(signal?: AbortSignal): Promise<AsyncIterable<RuntimeEvent>> {
    return this.#bus.subscribe(signal)
  }

  async messages() {
    return normalizeNativeMessages(this.#ledger.entries())
  }

  async activeContext() {
    // Native has no compaction yet, so its effective provider window is the complete durable ledger.
    return this.messages()
  }

  async fork(input: RuntimeForkInput = {}) {
    await this.#promptTail
    if (this.#closed) throw new Error("Boom Native conversation is closed")
    input.signal?.throwIfAborted()
    const messageID = resolveRuntimeForkBoundary(await this.messages(), input.messageID)
    const entries = this.#ledger.entries()
    const boundary = entries.findIndex((entry) => entry.id === messageID)
    if (boundary < 0) throw new Error(`Boom Native fork message does not exist: ${messageID}`)
    return NativeConversation.createRoot({
      id: `native-${crypto.randomUUID()}`,
      directory: this.directory,
      title: `${this.#title} (fork)`,
      provider: this.#provider,
      registry: this.#registry,
      toolHost: this.#toolHost,
      limits: this.#limits,
      tokenBudget: input.tokenBudget,
      seedEntries: entries.slice(0, boundary + 1),
      forkedFrom: { conversationID: this.id, messageID },
    })
  }

  async prompt(input: RuntimePrompt): Promise<RuntimePromptResult> {
    let release: (() => void) | undefined
    const previous = this.#promptTail
    this.#promptTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (this.#closed) throw new Error("Boom Native conversation is closed")
      if (this.#coordinator.signal.aborted)
        return await this.#cancelledResult([], this.#coordinator.signal.reason)
      const active = this.#runPrompt(input)
      this.#activeTurn = active
      return await active
    } finally {
      this.#activeTurn = undefined
      release?.()
    }
  }

  async #runPrompt(input: RuntimePrompt): Promise<RuntimePromptResult> {
    const agent = this.#registry.agents.find((item) => item.resource.id === input.agent)
    const usageBefore = this.#resultUsage()
    const costBefore = this.#resultCost()
    const parts: RuntimeResponsePart[] = []
    let requestID: string | undefined
    let lengthContinuations = 0
    const signal = combineSignals(this.#coordinator.signal, input.signal)
    try {
      signal.throwIfAborted()
      if (!agent) throw new Error(`Unknown Boom agent: ${input.agent}`)
      if (!input.model.trim()) throw new Error("Boom Native model must be non-empty")
      await this.#bus.emit({ type: "conversation-state", sessionID: this.id, state: "preparing" })
      await this.#ledger.append({ role: "user", content: input.text })
      for (let localStep = 1; localStep <= this.#limits.maxSteps; localStep += 1) {
        signal.throwIfAborted()
        await this.#bus.emit({ type: "conversation-state", sessionID: this.id, state: "generating" })
        const step = await this.#providerStepWithRetry({
          input,
          agent,
          signal,
          step: ++this.#providerStep,
        })
        if (step.requestID) requestID = step.requestID
        if (step.text) parts.push({ type: "text", text: step.text })
        if (step.reasoning) parts.push({ type: "reasoning", text: step.reasoning })
        const toolCalls: NativeProviderToolCall[] = step.tools.map((tool, index) => ({
          id: tool.id ?? `malformed-${this.#providerStep}-${index + 1}`,
          name: tool.name ?? "unknown",
          arguments: tool.arguments,
        }))
        await this.#ledger.append({
          role: "assistant",
          content: step.text,
          ...(step.reasoning ? { reasoning: step.reasoning } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
        })

        if (toolCalls.length > 0) {
          const outcomes = await this.#executeTools(
            step.tools,
            input.model,
            agent.resource.toolProfile,
            signal,
          )
          for (const outcome of outcomes) {
            const content = `${outcome.title}\n${outcome.output}`.slice(0, MAX_TOOL_RESULT)
            await this.#ledger.append({
              role: "tool",
              toolCallID: outcome.callID,
              name: outcome.name,
              content,
              isError: outcome.error !== undefined,
            })
            parts.push({
              type: "tool",
              tool: outcome.name,
              callID: outcome.callID,
              state: usagePartState(outcome.input, outcome),
            })
          }
          if (outcomes.some((outcome) => outcome.terminal))
            return await this.#completedResult(parts, "stop", usageBefore, costBefore, requestID)
          continue
        }

        if (step.finish === "length" && lengthContinuations < this.#limits.maxLengthContinuations) {
          lengthContinuations += 1
          await this.#ledger.append(
            { role: "user", content: "Continue from the exact point where the previous response reached its output limit." },
            "length-continuation",
          )
          continue
        }
        if (!step.text && !step.reasoning) throw malformed("Provider returned an empty response")
        return await this.#completedResult(parts, step.finish, usageBefore, costBefore, requestID)
      }
      return await this.#completedResult(parts, "length", usageBefore, costBefore, requestID)
    } catch (error) {
      if (signal.aborted && !(signal.reason instanceof NativeBudgetExceeded))
        return await this.#cancelledResult(parts, signal.reason ?? error, usageBefore, costBefore)
      const failure = failureFrom(error, signal)
      await this.#bus.emit({
        type: "provider-diagnostic",
        sessionID: this.id,
        level: "error",
        error: failure,
      })
      await this.#bus.emit({ type: "conversation-state", sessionID: this.id, state: "failed" })
      await this.#bus.emit({ type: "finish", sessionID: this.id, reason: "error", error: failure })
      return {
        parts,
        usage: subtractRuntimeUsage(this.#resultUsage(), usageBefore),
        cost: Math.max(0, this.#resultCost() - costBefore),
        finish: "error",
        error: failure,
        ...(requestID ? { requestID } : {}),
      }
    }
  }

  async #providerStepWithRetry(input: {
    input: RuntimePrompt
    agent: CompiledBoomAgent
    signal: AbortSignal
    step: number
  }): Promise<ProviderStep> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#coordinator.runActive(input.signal, async () => {
          const text: string[] = []
          const reasoning: string[] = []
          const tools = new Map<number, ToolAccumulator>()
          let usage = emptyRuntimeUsage()
          let cost = 0
          let requestID: string | undefined
          let finish: RuntimeFinishReason | undefined
          for await (const event of this.#provider.stream({
            conversationID: this.id,
            step: input.step,
            agent: input.input.agent,
            model: input.input.model,
            system: compilePromptText(input.agent.prompt, ["policy", "identity", "role", "tools"]),
            messages: this.#ledger.messages(),
            tools: providerTools(input.agent, this.#registry),
            signal: input.signal,
          })) {
            input.signal.throwIfAborted()
            if (event.type === "text-delta") {
              if (finish) throw malformed("Provider emitted text after finish")
              text.push(event.delta)
              if (event.delta) await this.#bus.emit({ type: "text-delta", sessionID: this.id, delta: event.delta })
              continue
            }
            if (event.type === "reasoning-delta") {
              if (finish) throw malformed("Provider emitted reasoning after finish")
              reasoning.push(event.delta)
              if (event.delta) await this.#bus.emit({ type: "reasoning-delta", sessionID: this.id, delta: event.delta })
              continue
            }
            if (event.type === "tool-call-delta") {
              if (finish || !Number.isInteger(event.index) || event.index < 0)
                throw malformed("Provider emitted an invalid tool-call fragment")
              const tool = tools.get(event.index) ?? { index: event.index, arguments: "" }
              if (event.id !== undefined) tool.id = event.id
              if (event.name !== undefined) tool.name = event.name
              if (event.arguments !== undefined) tool.arguments += event.arguments
              tools.set(event.index, tool)
              continue
            }
            if (event.type === "usage") {
              usage = cloneRuntimeUsage(event.usage)
              cost = event.cost
              requestID = event.requestID
              continue
            }
            if (finish) throw malformed("Provider emitted more than one finish event")
            finish = event.reason
          }
          if (!finish) throw malformed("Provider stream ended without a finish event")
          const orderedTools = [...tools.values()].sort((left, right) => left.index - right.index)
          if (finish === "tool-calls" && orderedTools.length === 0)
            throw malformed("Provider declared tool calls without a tool call")
          let budgetError: unknown
          addRuntimeUsage(this.#localUsage, usage)
          this.#localCost += cost
          try {
            await this.#coordinator.charge(usage, cost)
          } catch (error) {
            budgetError = error
          }
          await this.#bus.emit({
            type: "step-finish",
            sessionID: this.id,
            usage,
            cost,
            reason: finish,
          })
          if (budgetError) throw budgetError
          return {
            text: text.join(""),
            reasoning: reasoning.join(""),
            tools: orderedTools,
            usage,
            cost,
            ...(requestID ? { requestID } : {}),
            finish,
          }
        })
      } catch (error) {
        input.signal.throwIfAborted()
        const failure = failureFrom(error, input.signal)
        if (failure.retryable === true && attempt < this.#limits.maxRetries) {
          await this.#bus.emit({ type: "conversation-state", sessionID: this.id, state: "retrying" })
          await this.#bus.emit({
            type: "retry",
            sessionID: this.id,
            attempt: attempt + 1,
            error: failure,
          })
          await this.#bus.emit({ type: "conversation-state", sessionID: this.id, state: "generating" })
          continue
        }
        throw error
      }
    }
  }

  async #executeTools(
    tools: ToolAccumulator[],
    model: string,
    profileID: string,
    signal: AbortSignal,
  ) {
    const outcomes: ToolOutcome[] = new Array(tools.length)
    let index = 0
    while (index < tools.length) {
      if (tools[index]?.name === "task") {
        let end = index
        while (end < tools.length && tools[end]?.name === "task") end += 1
        const group = await Promise.all(
          tools.slice(index, end).map((tool) => this.#executeTool(tool, model, profileID, signal)),
        )
        group.forEach((outcome, offset) => { outcomes[index + offset] = outcome })
        index = end
      } else {
        outcomes[index] = await this.#executeTool(tools[index]!, model, profileID, signal)
        index += 1
      }
    }
    return outcomes
  }

  async #executeTool(
    tool: ToolAccumulator,
    model: string,
    profileID: string,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const callID = tool.id?.trim() || `malformed-${this.#providerStep}-${tool.index + 1}`
    const name = tool.name?.trim() || "unknown"
    let input: Record<string, unknown> | undefined
    const fail = async (message: string): Promise<ToolOutcome> => {
      await this.#bus.emit({
        type: "tool-state",
        sessionID: this.id,
        callID,
        tool: name,
        state: { status: "error", ...(input ? { input } : {}), error: message },
      })
      return { callID, name, input, title: `${name} failed`, output: message, error: message }
    }
    if (this.#seenCalls.has(callID)) return await fail(`Duplicate tool call ID: ${callID}`)
    this.#seenCalls.add(callID)
    try {
      const parsed = JSON.parse(tool.arguments)
      input = object(parsed)
      if (!input) return await fail("Tool arguments must be one complete JSON object")
    } catch (error) {
      return await fail(`Malformed tool arguments: ${errorMessage(error)}`)
    }
    await this.#bus.emit({
      type: "tool-state",
      sessionID: this.id,
      callID,
      tool: name,
      state: { status: "pending", input },
    })
    try {
      const descriptor = validateBoomToolArguments(this.#registry.catalog, name, input)
      assertBoomPolicy(decideBoomToolPolicy(this.#registry.catalog, profileID, name), name)
      await this.#bus.emit({
        type: "tool-state",
        sessionID: this.id,
        callID,
        tool: name,
        state: { status: "running", input },
      })
      let result: BoomToolResult
      if (name === "task") result = await this.#executeTask(callID, input, model, signal)
      else {
        if (descriptor.implementation !== "boom")
          throw new Error(`Tool is unavailable in Boom Native: ${name}`)
        result = await this.#coordinator.runActive(signal, () => this.#toolHost.execute({
          name: name as BoomToolName,
          arguments: input!,
          directory: this.directory,
          profileID,
          sessionID: this.id,
          signal,
        }))
      }
      signal.throwIfAborted()
      await this.#bus.emit({
        type: "tool-state",
        sessionID: this.id,
        callID,
        tool: name,
        state: { status: "completed", input, title: result.title },
      })
      return {
        callID,
        name,
        input,
        title: result.title,
        output: result.output,
        terminal: name === "ctf-submit" || name === "ctf-consult",
      }
    } catch (error) {
      if (signal.aborted) {
        await fail(errorMessage(signal.reason ?? error))
        throw error
      }
      return await fail(errorMessage(error))
    }
  }

  async #executeTask(
    callID: string,
    input: Record<string, unknown>,
    model: string,
    signal: AbortSignal,
  ): Promise<BoomToolResult> {
    if (this.#depth >= this.#limits.maxTaskDepth)
      throw new Error(`Boom Native task depth limit reached: ${this.#depth} >= ${this.#limits.maxTaskDepth}`)
    const title = String(input.description)
    const prompt = String(input.prompt)
    const agent = String(input.subagent_type)
    const taskID = `task-${crypto.randomUUID()}`
    const depth = this.#depth + 1
    const workspace = await this.#coordinator.createTaskWorkspace(taskID, this.directory)
    const audit = async (
      state: "queued" | "running" | "completed" | "failed" | "cancelled",
      extra: { usage?: ReturnType<typeof emptyRuntimeUsage>; cost?: number; error?: string } = {},
    ) => this.#coordinator.recordTask({
      taskID,
      ...(this.#taskID ? { parentTaskID: this.#taskID } : {}),
      callID,
      state,
      depth,
      title,
      directory: workspace.relative,
      ...extra,
    })
    await audit("queued")
    let child: NativeConversation | undefined
    try {
      signal.throwIfAborted()
      await audit("running")
      child = await NativeConversation.createChild({
        id: `native-${crypto.randomUUID()}`,
        directory: workspace.workspace,
        title,
        provider: this.#provider,
        registry: this.#registry,
        toolHost: this.#toolHost,
        limits: this.#limits,
        coordinator: this.#coordinator,
        depth,
        taskID,
      })
      const result = await child.prompt({ agent, model, text: prompt, signal })
      if (result.error) throw new NativeProviderFailure(result.error)
      const report = responseText(result.parts)
      await audit("completed", {
        usage: result.usage ?? emptyRuntimeUsage(),
        cost: result.cost,
      })
      return {
        title: `${title} · completed`,
        output: [
          report || "Subagent completed without a text report.",
          `task=${taskID} directory=${workspace.relative}`,
        ].join("\n\n").slice(0, MAX_TOOL_RESULT),
        metadata: {
          taskID,
          directory: workspace.relative,
          depth,
          usage: result.usage ?? emptyRuntimeUsage(),
          cost: result.cost,
        },
      }
    } catch (error) {
      const cancelled = signal.aborted && !(signal.reason instanceof NativeBudgetExceeded)
      await audit(cancelled ? "cancelled" : "failed", { error: errorMessage(signal.reason ?? error) }).catch(() => {})
      throw error
    } finally {
      await child?.close().catch(() => {})
    }
  }

  async #completedResult(
    parts: RuntimeResponsePart[],
    finish: RuntimeFinishReason,
    usageBefore: ReturnType<typeof emptyRuntimeUsage>,
    costBefore: number,
    requestID?: string,
  ): Promise<RuntimePromptResult> {
    await this.#bus.emit({ type: "conversation-state", sessionID: this.id, state: "completed" })
    await this.#bus.emit({ type: "finish", sessionID: this.id, reason: finish })
    return {
      parts,
      usage: subtractRuntimeUsage(this.#resultUsage(), usageBefore),
      cost: Math.max(0, this.#resultCost() - costBefore),
      finish,
      ...(requestID ? { requestID } : {}),
    }
  }

  async #cancelledResult(
    parts: RuntimeResponsePart[],
    error: unknown,
    usageBefore = emptyRuntimeUsage(),
    costBefore = 0,
  ): Promise<RuntimePromptResult> {
    const failure = sanitizeNativeState<RuntimeFailure>({
      name: error instanceof Error ? error.name : "AbortError",
      message: errorMessage(error ?? "Boom Native conversation cancelled"),
      category: "cancelled",
      retryable: false,
    }, 2_000)
    await this.#bus.emit({ type: "cancelled", sessionID: this.id, reason: failure.message })
    await this.#bus.emit({ type: "conversation-state", sessionID: this.id, state: "cancelled" })
    await this.#bus.emit({ type: "finish", sessionID: this.id, reason: "cancelled", error: failure })
    return {
      parts,
      usage: subtractRuntimeUsage(this.#resultUsage(), usageBefore),
      cost: Math.max(0, this.#resultCost() - costBefore),
      finish: "cancelled",
      error: failure,
    }
  }

  async abort() {
    this.#coordinator.abort()
    await this.#activeTurn?.catch(() => {})
  }

  /**
   * A turn is in flight while `prompt()` awaits its agent loop, including a provider step whose
   * driver batches deltas and therefore emits no events. The watchdog may treat that silence as
   * alive; only an idle conversation with no events is a hang.
   */
  async isBusy(signal?: AbortSignal) {
    signal?.throwIfAborted()
    return this.#activeTurn !== undefined
  }

  #resultUsage() {
    return this.#depth === 0 ? this.#coordinator.usage() : cloneRuntimeUsage(this.#localUsage)
  }

  #resultCost() {
    return this.#depth === 0 ? this.#coordinator.cost : this.#localCost
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    await this.#bus.close()
  }

}

class NativeAgentRuntime implements AgentRuntime {
  #provider: NativeProviderDriver
  #registry: CompiledBoomAgentRegistry
  #toolHost: ReturnType<typeof createBoomToolHost>
  #limits: NativeKernelLimits
  #conversations = new Set<NativeConversation>()
  #closed = false

  constructor(input: {
    provider: NativeProviderDriver
    registry: CompiledBoomAgentRegistry
    limits: NativeKernelLimits
    networkBroker?: BoomNetworkBroker
  }) {
    this.#provider = input.provider
    this.#registry = input.registry
    this.#toolHost = createBoomToolHost(input.registry.catalog, {
      ...(input.networkBroker ? { networkBroker: input.networkBroker } : {}),
      network: input.registry.network,
    })
    this.#limits = input.limits
  }

  async createConversation(input: {
    directory: string
    title: string
    signal?: AbortSignal
    tokenBudget?: number
  }): Promise<RuntimeConversation> {
    if (this.#closed) throw new Error("Boom Native Runtime is closed")
    input.signal?.throwIfAborted()
    const conversation = await NativeConversation.createRoot({
      id: `native-${crypto.randomUUID()}`,
      directory: input.directory,
      title: input.title,
      provider: this.#provider,
      registry: this.#registry,
      toolHost: this.#toolHost,
      limits: this.#limits,
      tokenBudget: input.tokenBudget,
    })
    if (input.signal) input.signal.addEventListener("abort", () => void conversation.abort(), { once: true })
    this.#conversations.add(conversation)
    return this.#wrap(conversation)
  }

  async resumeConversation(input: {
    directory: string
    id: string
    signal?: AbortSignal
    tokenBudget?: number
  }): Promise<RuntimeConversation> {
    if (this.#closed) throw new Error("Boom Native Runtime is closed")
    input.signal?.throwIfAborted()
    const conversation = await NativeConversation.resumeRoot({
      id: input.id,
      directory: input.directory,
      provider: this.#provider,
      registry: this.#registry,
      toolHost: this.#toolHost,
      limits: this.#limits,
      tokenBudget: input.tokenBudget,
    })
    if (input.signal) input.signal.addEventListener("abort", () => void conversation.abort(), { once: true })
    this.#conversations.add(conversation)
    return this.#wrap(conversation)
  }

  #wrap(conversation: NativeConversation): RuntimeConversation {
    return {
      id: conversation.id,
      events: (signal) => conversation.events(signal),
      prompt: (input) => conversation.prompt(input),
      abort: () => conversation.abort(),
      activeContext: () => conversation.activeContext(),
      messages: () => conversation.messages(),
      isBusy: (signal) => conversation.isBusy(signal),
      fork: async (input) => {
        const forked = await conversation.fork(input)
        if (input?.signal)
          input.signal.addEventListener("abort", () => void forked.abort(), { once: true })
        this.#conversations.add(forked)
        return this.#wrap(forked)
      },
      close: async () => {
        this.#conversations.delete(conversation)
        await conversation.close()
      },
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const conversation of this.#conversations) {
      void conversation.abort()
      void conversation.close()
    }
    this.#conversations.clear()
  }
}

export async function createNativeRuntime(options: NativeRuntimeOptions): Promise<RuntimeHandle> {
  const registry = await compileBoomAgentRegistry(
    options.resourceRoot ?? DEFAULT_RESOURCE_ROOT,
    undefined,
    undefined,
    undefined,
    options.network ?? "allow",
  )
  const limits = normalizeNativeKernelLimits(options.limits)
  const agent = new NativeAgentRuntime({
    provider: options.provider,
    registry,
    limits,
    ...(options.networkBroker ? { networkBroker: options.networkBroker } : {}),
  })
  return {
    backend: "native",
    version: options.version ?? "0.1.0-native",
    promptVersion: registry.promptVersion,
    capabilities: {
      eventStreaming: true,
      toolCalls: true,
      reasoning: true,
      attachments: false,
      web: true,
      cancellation: true,
      providerManagement: Boolean(options.providerRuntime),
      providerOAuth: false,
      compaction: false,
      compactionHooks: false,
      mcp: false,
    },
    agent,
    ...(options.providerRuntime ? { provider: options.providerRuntime } : {}),
    close: () => agent.close(),
  }
}

export { DEFAULT_NATIVE_KERNEL_LIMITS }
export type { NativeRuntimeOptions }
