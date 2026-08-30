import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deflateRawSync, gzipSync } from "node:zlib"
import type { Challenge } from "../src/challenge.ts"
import { prepareWorkspace, runID } from "../src/workspace.ts"

describe("run workspace", () => {
  test("creates an isolated workspace without leaking a known answer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-"))
    const source = path.join(root, "source")
    await mkdir(source)
    await Bun.write(path.join(source, "encoded.txt"), "ZmxhZ3t0ZXN0fQ==\n")

    const challenge: Challenge = {
      slug: "warmup",
      category: "CRYPTO",
      difficulty: "Easy",
      serviceRequired: true,
      directory: source,
      description: "Decode it",
      files: ["encoded.txt"],
      flagFormat: "flag\\{[^}]*\\}",
    }
    const workspace = await prepareWorkspace(root, challenge, "free/test")
    const metadata = await Bun.file(path.join(workspace.directory, "challenge", "challenge.json")).json()

    expect(metadata.flag).toBeUndefined()
    expect(metadata.flag_format).toBe(challenge.flagFormat)
    expect(metadata.category).toBe("CRYPTO")
    expect(metadata.difficulty).toBe("Easy")
    expect(metadata.service_required).toBe(true)
    const notes = await Bun.file(path.join(workspace.directory, "NOTES.md")).text()
    expect(notes).toContain("Shared cross-turn, cross-model task memory")
    expect(notes).toContain("## Next steps")
    expect(await Bun.file(path.join(workspace.directory, "challenge", "encoded.txt")).text()).toContain("Zmxh")
  })

  test("protects attachments from edits but leaves the workspace deletable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-"))
    const source = path.join(root, "source")
    await mkdir(source)
    await Bun.write(path.join(source, "encoded.txt"), "ZmxhZ3t0ZXN0fQ==\n")

    const workspace = await prepareWorkspace(
      root,
      {
        slug: "warmup",
        directory: source,
        description: "Decode it",
        files: ["encoded.txt"],
        flagFormat: "flag\\{[^}]*\\}",
      },
      "free/test",
    )
    const copied = path.join(workspace.directory, "challenge", "encoded.txt")
    expect((await stat(copied)).mode & 0o222).toBe(0)

    // A read-only challenge directory would make the run undeletable, stranding every past workspace.
    await rm(workspace.directory, { recursive: true })
    expect(await Bun.file(copied).exists()).toBe(false)
  })

  test("uses a stable public model slug in the run id", () => {
    expect(runID("free/test", new Date("2026-07-28T10:12:59Z"))).toBe("20260728T101259Z-test")
  })

  test("keeps runs of one challenge distinct a second apart", () => {
    // Parallel batches and retries can start runs of the same slug in the same minute; colliding ids
    // would overwrite a workspace and lose the earlier attempt.
    const first = runID("free/test", new Date("2026-07-28T10:12:59Z"))
    const second = runID("free/test", new Date("2026-07-28T10:13:00Z"))
    expect(first).not.toBe(second)
  })

  test("keeps runs of one model distinct when created at the exact same instant", () => {
    const now = new Date("2040-01-02T03:04:05.678Z")
    const ids = [runID("free/test", now), runID("free/test", now), runID("free/test", now)]

    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual([
      "20400102T030405Z-test",
      "20400102T030405Z-2-test",
      "20400102T030405Z-3-test",
    ])
  })

  test("refuses a runs symlink that escapes the Boom root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-root-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "boom-runs-outside-"))
    const source = path.join(root, "source")
    try {
      await mkdir(source)
      await writeFile(path.join(source, "payload.txt"), "challenge data")
      await symlink(outside, path.join(root, "runs"))

      await expect(
        prepareWorkspace(
          root,
          {
            slug: "linked-runs",
            directory: source,
            description: "",
            files: ["payload.txt"],
            flagFormat: "",
          },
          "free/test",
        ),
      ).rejects.toThrow("Runs directory escapes Boom root")
      expect(await Bun.file(path.join(outside, "linked-runs")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("rejects a zip whose member escapes the destination and writes nothing", async () => {
    const { root, challenge } = await attachmentChallenge("trap-zip", {
      "trap.zip": makeZip([{ name: "../evil.txt", data: Buffer.from("pwned\n") }]),
    })
    try {
      await expect(prepareWorkspace(root, challenge, "free/test")).rejects.toThrow(/evil\.txt/)
      expect(await containsFileNamed(path.join(root, "runs"), "evil.txt")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a tar whose member escapes the destination and writes nothing", async () => {
    const { root, challenge } = await attachmentChallenge("trap-tar", {
      "trap.tar": makeTar([
        { name: "harmless.txt", data: Buffer.from("fine\n") },
        { name: "../evil.txt", data: Buffer.from("pwned\n") },
      ]),
    })
    try {
      await expect(prepareWorkspace(root, challenge, "free/test")).rejects.toThrow(/evil\.txt/)
      expect(await containsFileNamed(path.join(root, "runs"), "evil.txt")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refuses a high-compression zip bomb on the declared-size quota", async () => {
    // 64 KiB of zeros deflate to well under a kilobyte while the headers declare 3 GiB, so the
    // listing-stage quota check must refuse long before any byte is written.
    const zeros = Buffer.alloc(65_536)
    const { root, challenge } = await attachmentChallenge("zip-bomb", {
      "bomb.zip": makeZip([
        {
          name: "bomb.bin",
          data: zeros,
          method: 8,
          compressed: deflateRawSync(zeros),
          declaredSize: 3 * 1024 * 1024 * 1024,
        },
      ]),
    })
    try {
      await expect(prepareWorkspace(root, challenge, "free/test")).rejects.toThrow(/quota/i)
      expect(await containsFileNamed(path.join(root, "runs"), "bomb.bin")).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("still unpacks normal zip and tar.gz attachments", async () => {
    const tgz = gzipSync(makeTar([{ name: "from_tar.txt", data: Buffer.from("tarred\n") }]))
    const { root, challenge } = await attachmentChallenge("normal-archives", {
      "bundle.zip": makeZip([
        { name: "hello.txt", data: Buffer.from("hi there\n") },
        { name: "nested/payload.txt", data: Buffer.from("0101\n") },
      ]),
      "pack.tgz": tgz,
    })
    try {
      const workspace = await prepareWorkspace(root, challenge, "free/test")
      expect(workspace.extracted).toContain("work/extracted/bundle")
      expect(workspace.extracted).toContain("work/extracted/pack")
      expect(
        await Bun.file(path.join(workspace.directory, "work/extracted/bundle/hello.txt")).text(),
      ).toBe("hi there\n")
      expect(
        await Bun.file(path.join(workspace.directory, "work/extracted/bundle/nested/payload.txt")).text(),
      ).toBe("0101\n")
      expect(
        await Bun.file(path.join(workspace.directory, "work/extracted/pack/from_tar.txt")).text(),
      ).toBe("tarred\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("kills a hung archive tool instead of wedging the slot", async () => {
    // PATH mock: a `tar` that sleeps forever. The env-tunable listing timeout lets the suite prove
    // the SIGTERM/SIGKILL path in milliseconds; production keeps the 30 s/120 s ceilings.
    const root = await mkdtemp(path.join(os.tmpdir(), "boom-hang-"))
    const mockBin = path.join(root, "mock-bin")
    await mkdir(mockBin)
    await writeFile(path.join(mockBin, "tar"), "#!/bin/sh\nsleep 60\n")
    await chmod(path.join(mockBin, "tar"), 0o755)
    const previousPath = process.env.PATH
    const previousListTimeout = process.env.BOOM_ARCHIVE_LIST_TIMEOUT_MS
    const tgz = gzipSync(makeTar([{ name: "slow.txt", data: Buffer.from("x\n") }]))
    const { challenge } = await attachmentChallenge("hung-tool", { "slow.tgz": tgz })
    try {
      process.env.PATH = `${mockBin}:${previousPath ?? ""}`
      process.env.BOOM_ARCHIVE_LIST_TIMEOUT_MS = "250"
      await expect(prepareWorkspace(root, challenge, "free/test")).rejects.toThrow(/timed out/)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousListTimeout === undefined) delete process.env.BOOM_ARCHIVE_LIST_TIMEOUT_MS
      else process.env.BOOM_ARCHIVE_LIST_TIMEOUT_MS = previousListTimeout
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

const CRC32_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(bytes: Uint8Array) {
  let crc = -1
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

type ZipEntry = {
  name: string
  data: Uint8Array
  /** 0 = stored (default), 8 = deflated. */
  method?: number
  compressed?: Buffer
  /** Uncompressed size written to the headers; defaults to the real size. */
  declaredSize?: number
}

/** Minimal STORED/DEFLATE zip writer so tests can forge archives without shelling out to a tool. */
function makeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const centralEntries: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const method = entry.method ?? 0
    const data = entry.compressed ?? Buffer.from(entry.data)
    const size = entry.declaredSize ?? entry.data.byteLength
    const checksum = crc32(entry.data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6) // UTF-8 name flag, matching what modern writers emit
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12) // date 1980-01-01
    // Local header layout: crc@14, compressed size@18, uncompressed size@22.
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(method === 0 ? size : data.byteLength, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4) // created on Unix so external attrs carry a mode
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(method === 0 ? size : data.byteLength, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0o100644 * 0x10000, 38) // << 16 would wrap into negative int32 territory
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    parts.push(local, data)
    centralEntries.push(central)
    offset += local.length + data.byteLength
  }
  const directory = Buffer.concat(centralEntries)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, "utf8")
  header.write("0000644\0", 100, "latin1")
  header.write("0000000\0", 108, "latin1")
  header.write("0000000\0", 116, "latin1")
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1")
  header.write("00000000000\0", 136, "latin1")
  header.write("        ", 148, "latin1") // checksum placeholder: spaces while summing
  header.write("0", 156, "latin1") // regular file
  header.write("ustar\0", 257, "latin1")
  header.write("00", 263, "latin1")
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1")
  return header
}

function makeTar(entries: { name: string; data: Uint8Array }[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    blocks.push(tarHeader(entry.name, entry.data.byteLength))
    const padded = Buffer.alloc(Math.ceil(entry.data.byteLength / 512) * 512)
    Buffer.from(entry.data).copy(padded)
    blocks.push(padded)
  }
  blocks.push(Buffer.alloc(1024)) // end-of-archive marker
  return Buffer.concat(blocks)
}

async function attachmentChallenge(slug: string, files: Record<string, Buffer>) {
  const root = await mkdtemp(path.join(os.tmpdir(), `boom-${slug}-`))
  const source = path.join(root, "source")
  await mkdir(source)
  for (const [name, data] of Object.entries(files)) await writeFile(path.join(source, name), data)
  const challenge: Challenge = {
    slug,
    directory: source,
    description: "",
    files: Object.keys(files),
    flagFormat: "",
  }
  return { root, challenge }
}

/** True when any non-directory entry under `root` is named `target` — used to prove nothing landed. */
async function containsFileNamed(root: string, target: string): Promise<boolean> {
  let found = false
  const walk = async (directory: string): Promise<void> => {
    if (found) return
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() && entry.name === target) found = true
      else if (entry.isDirectory()) await walk(path.join(directory, entry.name))
    }
  }
  await walk(root)
  return found
}
