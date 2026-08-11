import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import type { RuntimeEvent } from "../runtime-contract.ts"
import type { NativeProviderMessage } from "./native-provider.ts"

const SECRET_KEY = /authorization|api[-_ ]?key|token|secret|password|cookie/i
const SECRET_VALUE = /((?:authorization|api[-_ ]?key|token|secret|password)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"'\s,;}]+/gi

function redacted(value: string, maxString: number) {
  return value.replace(SECRET_VALUE, "$1[redacted]").slice(0, maxString)
}

function safeValue(value: unknown, key = "", maxString = 32_768): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]"
  if (typeof value === "string") return redacted(value, maxString)
  if (Array.isArray(value)) return value.map((item) => safeValue(item, "", maxString))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([name, item]) => [name, safeValue(item, name, maxString)]),
  )
}

export function sanitizeNativeState<T>(value: T, maxString = 32_768): T {
  return safeValue(value, "", maxString) as T
}

export function sanitizeRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return sanitizeNativeState(event)
}

async function assertRealFile(file: string) {
  const info = await lstat(file).catch(() => undefined)
  if (info && (!info.isFile() || info.isSymbolicLink()))
    throw new Error(`Boom Native state is not a real file: ${file}`)
}

export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await assertRealFile(file)
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temporary, file)
}

class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = []
  #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false
  #onClose: () => void

  constructor(onClose: () => void) {
    this.#onClose = onClose
  }

  push(value: T) {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.#values.push(value)
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    this.#onClose()
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve))
      },
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      },
    }
  }
}

/** Persist-before-broadcast conversation Event Bus with independent bounded-lifetime subscribers. */
export class NativeEventBus {
  readonly file: string
  #sequence = 0
  #subscribers = new Set<AsyncQueue<RuntimeEvent>>()
  #writeTail: Promise<void> = Promise.resolve()
  #closed = false

  private constructor(file: string) {
    this.file = file
  }

  static async open(directory: string) {
    await mkdir(directory, { recursive: true })
    const file = path.join(directory, "events.jsonl")
    await assertRealFile(file)
    const source = await readFile(file, "utf8").catch(() => "")
    const bus = new NativeEventBus(file)
    bus.#sequence = source.split("\n").filter(Boolean).length
    return bus
  }

  async emit(input: RuntimeEvent) {
    if (this.#closed) return
    const event = sanitizeRuntimeEvent(input)
    const record = {
      version: 1,
      sequence: ++this.#sequence,
      timestamp: new Date().toISOString(),
      event,
    }
    const write = this.#writeTail.then(() => appendFile(
      this.file,
      `${JSON.stringify(record)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ))
    this.#writeTail = write.catch(() => {})
    await write
    if (this.#closed) return
    for (const subscriber of this.#subscribers) subscriber.push(event)
  }

  subscribe(signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    let queue: AsyncQueue<RuntimeEvent>
    const remove = () => {
      this.#subscribers.delete(queue)
      signal?.removeEventListener("abort", abort)
    }
    const abort = () => queue.close()
    queue = new AsyncQueue(remove)
    if (this.#closed || signal?.aborted) queue.close()
    else {
      this.#subscribers.add(queue)
      signal?.addEventListener("abort", abort, { once: true })
    }
    return queue
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    await this.#writeTail.catch(() => {})
    for (const subscriber of [...this.#subscribers]) subscriber.close()
  }
}

export type NativeLedgerEntry = {
  version: 1
  id: string
  timestamp: string
  message: NativeProviderMessage
  synthetic?: "length-continuation"
}

/** Durable message ledger. Provider requests are rebuilt from this ledger on continuation/resume. */
export class NativeMessageLedger {
  readonly file: string
  #entries: NativeLedgerEntry[]
  #writeTail: Promise<void> = Promise.resolve()

  private constructor(file: string, entries: NativeLedgerEntry[]) {
    this.file = file
    this.#entries = entries
  }

  static async open(directory: string) {
    await mkdir(directory, { recursive: true })
    const file = path.join(directory, "messages.jsonl")
    await assertRealFile(file)
    const source = await readFile(file, "utf8").catch(() => "")
    const entries = source.split("\n").filter(Boolean).map((line, index) => {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Invalid Boom Native message ledger JSON at line ${index + 1}`)
      }
      const item = value as Partial<NativeLedgerEntry>
      if (
        item.version !== 1 || typeof item.id !== "string" || typeof item.timestamp !== "string" ||
        !item.message || typeof item.message !== "object"
      ) throw new Error(`Invalid Boom Native message ledger entry at line ${index + 1}`)
      return item as NativeLedgerEntry
    })
    return new NativeMessageLedger(file, entries)
  }

  messages(): NativeProviderMessage[] {
    return structuredClone(this.#entries.map((entry) => entry.message))
  }

  entries(): NativeLedgerEntry[] {
    return structuredClone(this.#entries)
  }

  get length() {
    return this.#entries.length
  }

  /** Seed a newly-created ledger while preserving source IDs so fork provenance stays addressable. */
  async seed(entries: readonly NativeLedgerEntry[]) {
    if (this.#entries.length > 0) throw new Error("Boom Native message ledger is not empty")
    const ids = new Set<string>()
    const safe = entries.map((entry) => {
      if (entry.version !== 1 || !entry.id || ids.has(entry.id) || !entry.timestamp)
        throw new Error("Boom Native fork contains an invalid message ledger entry")
      ids.add(entry.id)
      return sanitizeNativeState(structuredClone(entry), 1_048_576)
    })
    const write = this.#writeTail.then(async () => {
      await assertRealFile(this.file)
      const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`
      await writeFile(
        temporary,
        safe.length ? `${safe.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "",
        { encoding: "utf8", mode: 0o600 },
      )
      await rename(temporary, this.file)
    })
    this.#writeTail = write.catch(() => {})
    await write
    this.#entries = safe
  }

  async append(message: NativeProviderMessage, synthetic?: NativeLedgerEntry["synthetic"]) {
    const entry: NativeLedgerEntry = {
      version: 1,
      id: `message-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      message: sanitizeNativeState(structuredClone(message), 1_048_576),
      ...(synthetic ? { synthetic } : {}),
    }
    const write = this.#writeTail.then(() => appendFile(
      this.file,
      `${JSON.stringify(entry)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ))
    this.#writeTail = write.catch(() => {})
    await write
    this.#entries.push(entry)
    return entry
  }
}
