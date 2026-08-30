import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveTaskPath } from "../src/runtime/policy.ts"

const PROXY = path.join(import.meta.dir, "..", "src", "runtime", "ida-proxy.ts")
const UPSTREAM = path.join(import.meta.dir, "fixtures", "ida-proxy-upstream.ts")

type RpcID = number | string

type Rpc = {
  jsonrpc?: "2.0"
  id?: RpcID
  method?: string
  params?: Record<string, unknown>
  result?: any
  error?: { code: number; message: string }
}

class TestClient {
  private buffer = ""
  private nextID = 1
  private readonly pending = new Map<RpcID, (message: Rpc) => void>()
  readonly requests: Rpc[] = []
  readonly notifications: Rpc[] = []

  constructor(
    private readonly child: ChildProcess,
    private readonly rootsURI: string,
  ) {
    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => this.ingest(chunk))
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", () => {})
  }

  private ingest(chunk: string) {
    this.buffer += chunk
    let index = this.buffer.indexOf("\n")
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf("\n")
      if (!line) continue
      try {
        this.dispatch(JSON.parse(line) as Rpc)
      } catch {
        // 忽略坏帧。
      }
    }
  }

  private dispatch(message: Rpc) {
    if (message.id !== undefined && message.method !== undefined) {
      if (message.method === "roots/list") {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: this.rootsURI ? { roots: [{ uri: this.rootsURI }] } : { roots: [] },
        })
      } else {
        this.requests.push(message)
      }
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      this.pending.get(message.id)!(message)
      this.pending.delete(message.id)
      return
    }
    if (message.id === undefined) this.notifications.push(message)
  }

  send(message: Rpc) {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`)
  }

  request(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextID++
    return new Promise<Rpc>((resolve) => {
      this.pending.set(id, resolve)
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  close() {
    this.child.kill()
  }
}

const running: Array<{ child: ChildProcess; home: string }> = []
const policyRoots: string[] = []

afterEach(async () => {
  for (const item of running.splice(0)) {
    item.child.kill()
  }
  await Promise.all(running.map((item) => rm(item.home, { recursive: true, force: true })))
  await Promise.all(policyRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function startProxy(options: { roots?: boolean; offloadChars?: number } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "boom-ida-proxy-"))
  const workspace = path.join(home, "workspace")
  await mkdir(workspace, { recursive: true })
  const env = {
    ...process.env,
    BOOM_TEST_CALL_LOG: path.join(home, "calls.jsonl"),
    ...(options.offloadChars === undefined ? {} : { BOOM_IDA_OFFLOAD_CHARS: String(options.offloadChars) }),
  }
  const child = spawn(process.execPath, [PROXY, process.execPath, UPSTREAM], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const client = new TestClient(child, options.roots === false ? "" : pathToFileURL(workspace).href)
  running.push({ child, home })
  return { home, workspace, callLog: env.BOOM_TEST_CALL_LOG, client }
}

async function callLog(callLogPath: string) {
  const raw = await readFile(callLogPath, "utf8").catch(() => "")
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    name: string
    arguments: Record<string, unknown>
  })
}

describe("IDA result proxy", () => {
  test("forwards upstream tools and merges the retrieval tools", async () => {
    const { client } = await startProxy()
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    })
    expect(initialized.result.protocolVersion).toBe("2024-11-05")
    const listed = await client.request("tools/list", {})
    const names = (listed.result.tools as Array<{ name: string }>).map((tool) => tool.name)
    expect(names).toContain("idalib_analyze_batch")
    expect(names).toContain("idalib_decompile")
    expect(names).toContain("idalib_get_bytes")
    expect(names).toContain("boom_ida_get")
    expect(names).toContain("boom_ida_list")
  })

  test("keeps small results verbatim", async () => {
    const { client } = await startProxy()
    await client.request("initialize", {})
    const response = await client.request("tools/call", {
      name: "idalib_decompile",
      arguments: { function: "small" },
    })
    expect(response.result.content[0].text).toBe("small decompile body")
  })

  test("archives oversized results and returns a pointer with preview", async () => {
    const { client, workspace } = await startProxy({ offloadChars: 200 })
    await client.request("initialize", {})
    const response = await client.request("tools/call", {
      name: "idalib_decompile",
      arguments: { function: "big" },
    })
    const text = response.result.content[0].text as string
    expect(text).toContain("[IDA result archived]")
    expect(text).toContain("work/ida/results/")
    expect(text).toContain("idalib_boom_ida_get(id=")
    const id = text.match(/id="([^"]+)"/)?.[1]
    const file = text.match(/work\/ida\/results\/([^\s]+)/)?.[1]
    expect(id).toBeTruthy()
    expect(file).toBeTruthy()
    const full = await readFile(path.join(workspace, "work", "ida", "results", file!), "utf8")
    expect(full).toContain("BIG_BODY")
    expect(full.length).toBeGreaterThan(1_500)
    const manifest = await readFile(path.join(workspace, "work", "ida", "results", "index.jsonl"), "utf8")
    expect(manifest).toContain(id!)
    expect(manifest).toContain('"tool":"idalib_decompile"')
  })

  test("re-queries a truncated analyze_batch per function and archives each result", async () => {
    const { client, workspace, callLog: logPath } = await startProxy()
    await client.request("initialize", {})
    const response = await client.request("tools/call", {
      name: "idalib_analyze_batch",
      arguments: { queries: [{ addr: "sub_A" }, { addr: "sub_B" }] },
    })
    const text = response.result.content[0].text as string
    expect(text).toContain("[IDA analyze_batch split-and-archive]")
    expect(text).toContain("sub_A")
    expect(text).toContain("sub_B")
    const calls = await callLog(logPath)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({ name: "idalib_analyze_batch" })
    expect(calls[0].arguments.queries).toHaveLength(2)
    expect(calls[1].arguments.queries).toEqual([{ addr: "sub_A" }])
    const files = (await readdir(path.join(workspace, "work", "ida", "results")))
      .filter((entry) => entry.endsWith(".txt"))
    expect(files).toHaveLength(2)
    const contents = await Promise.all(files.map((entry) =>
      readFile(path.join(workspace, "work", "ida", "results", entry), "utf8"),
    ))
    expect(contents.join("\n")).toContain("decompiled sub_A body")
    expect(contents.join("\n")).toContain("decompiled sub_B body")
  })

  test("deduplicates identical repeat queries instead of writing a new artifact", async () => {
    const { client, workspace } = await startProxy({ offloadChars: 200 })
    await client.request("initialize", {})
    const first = await client.request("tools/call", {
      name: "idalib_decompile",
      arguments: { function: "big" },
    })
    const second = await client.request("tools/call", {
      name: "idalib_decompile",
      arguments: { function: "big" },
    })
    const firstID = (first.result.content[0].text as string).match(/id="([^"]+)"/)?.[1]
    const secondID = (second.result.content[0].text as string).match(/id="([^"]+)"/)?.[1]
    expect(second.result.content[0].text).toContain("not rewritten")
    expect(secondID).toBe(firstID)
    const files = (await readdir(path.join(workspace, "work", "ida", "results")))
      .filter((entry) => entry.endsWith(".txt"))
    expect(files).toHaveLength(1)
  })

  test("passes upstream errors through untouched", async () => {
    const { client } = await startProxy()
    await client.request("initialize", {})
    const response = await client.request("tools/call", {
      name: "idalib_get_bytes",
      arguments: { fail: true },
    })
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toBe("upstream failed")
  })

  test("boom_ida_get and boom_ida_list read the archive in bounded chunks", async () => {
    const { client, workspace } = await startProxy({ offloadChars: 200 })
    await client.request("initialize", {})
    const archived = await client.request("tools/call", {
      name: "idalib_decompile",
      arguments: { function: "big" },
    })
    const id = (archived.result.content[0].text as string).match(/id="([^"]+)"/)?.[1]!
    const chunk = await client.request("tools/call", {
      name: "boom_ida_get",
      arguments: { id, start_line: 1, max_lines: 5 },
    })
    const chunkText = chunk.result.content[0].text as string
    expect(chunkText).toContain("# work/ida/results/")
    expect(chunkText).toContain("lines 1-5 / 202 total")
    expect(chunkText).toContain("more lines")
    const listed = await client.request("tools/call", {
      name: "boom_ida_list",
      arguments: { limit: 10 },
    })
    expect(listed.result.content[0].text).toContain(id)
    expect(listed.result.content[0].text).toContain("idalib_decompile")
    expect((await readdir(path.join(workspace, "work", "ida", "results"))).length).toBeGreaterThan(0)
  })

  test("degrades to pass-through when no workspace root is available", async () => {
    const { client } = await startProxy({ roots: false, offloadChars: 200 })
    await client.request("initialize", {})
    const response = await client.request("tools/call", {
      name: "idalib_decompile",
      arguments: { function: "big" },
    })
    expect(response.result.content[0].text).toContain("BIG_BODY")
    const listed = await client.request("tools/call", {
      name: "boom_ida_list",
      arguments: {},
    })
    expect(listed.result.content[0].text).toContain("No archived IDA results.")
  })

  test("refuses poisoned manifest entries instead of reading escaped paths", async () => {
    const { client, home, workspace } = await startProxy({ offloadChars: 200 })
    await client.request("initialize", {})
    const archived = await client.request("tools/call", {
      name: "idalib_decompile",
      arguments: { function: "big" },
    })
    const legitID = (archived.result.content[0].text as string).match(/id="([^"]+)"/)?.[1]!

    // 模拟 manifest 被改写：插入指向归档目录之外的穿越条目与非 .txt 条目。
    const secret = path.join(home, "secret.txt")
    await writeFile(secret, "TOPSECRET_CREDENTIALS", "utf8")
    const manifestPath = path.join(workspace, "work", "ida", "results", "index.jsonl")
    const planted = [
      {
        v: 1,
        id: "evil-traversal",
        at: new Date().toISOString(),
        tool: "idalib_decompile",
        key: "planted",
        hash: "planted",
        file: "../../../secret.txt",
        chars: 20,
        lines: 1,
      },
      {
        v: 1,
        id: "evil-extension",
        at: new Date().toISOString(),
        tool: "idalib_decompile",
        key: "planted-2",
        hash: "planted-2",
        file: "secret.json",
        chars: 20,
        lines: 1,
      },
    ] satisfies Array<Record<string, unknown>>
    const existing = await readFile(manifestPath, "utf8")
    await writeFile(
      manifestPath,
      existing + planted.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    )

    for (const evil of ["evil-traversal", "evil-extension"]) {
      const attack = await client.request("tools/call", {
        name: "boom_ida_get",
        arguments: { id: evil },
      })
      // 与「条目不存在」同一错误风格，且绝不把越权文件内容带回模型上下文。
      expect(attack.error?.message).toContain(`archive ID not found: ${evil}`)
      expect(JSON.stringify(attack)).not.toContain("TOPSECRET_CREDENTIALS")
    }

    // 被污染的条目被拒绝，但不牵连同一 manifest 里的合法归档。
    const legit = await client.request("tools/call", {
      name: "boom_ida_get",
      arguments: { id: legitID },
    })
    expect(legit.error).toBeUndefined()
    expect(legit.result.content[0].text).toContain("BIG_BODY")
  })

  test("still serves archived artifacts with legitimate single-segment .txt names", async () => {
    const { client, workspace } = await startProxy({ offloadChars: 200 })
    await client.request("initialize", {})
    const archived = await client.request("tools/call", {
      name: "idalib_decompile",
      arguments: { function: "big" },
    })
    const pointer = archived.result.content[0].text as string
    expect(pointer).toContain("[IDA result archived]")
    const id = pointer.match(/id="([^"]+)"/)?.[1]!
    const file = pointer.match(/work\/ida\/results\/([^\s]+)/)?.[1]!
    expect(file).toMatch(/^[A-Za-z0-9._-]+\.txt$/)

    const chunk = await client.request("tools/call", {
      name: "boom_ida_get",
      arguments: { id, max_lines: 3 },
    })
    expect(chunk.error).toBeUndefined()
    expect(chunk.result.content[0].text).toContain("BIG_BODY")
    expect(await readFile(path.join(workspace, "work", "ida", "results", file), "utf8"))
      .toContain("BIG_BODY")
  })
})

describe("IDA archive write policy", () => {
  test("denies agent writes into the host-owned work/ida tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-ida-policy-"))
    policyRoots.push(root)
    await mkdir(path.join(root, "work", "ida", "results"), { recursive: true })
    await writeFile(path.join(root, "work", "ida", "results", "index.jsonl"), "{}\n")
    await writeFile(path.join(root, "work", "ida", "results", "artifact.txt"), "archived body\n")
    await writeFile(path.join(root, "work", "ida", "notes.txt"), "proxy-owned\n")
    await writeFile(path.join(root, "work", "draft.txt"), "agent-owned\n")

    for (const requested of [
      "work/ida/results/index.jsonl",
      "work/ida/results/artifact.txt",
      "work/ida/notes.txt",
    ]) {
      await expect(resolveTaskPath(root, requested, "write")).rejects.toThrow("host-owned task state")
    }
    // 只有 work/ida 被锁定；其余 work/ 文件保持可写。
    expect((await resolveTaskPath(root, "work/draft.txt", "write")).relative).toBe("work/draft.txt")
  })
})
