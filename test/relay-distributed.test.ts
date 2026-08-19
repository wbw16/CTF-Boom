import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startRelayServer, type RunningRelayServer } from "../src/relay/server.ts"
import { RelayClient } from "../src/relay/client.ts"
import { packChallengeBundle, unpackChallengeBundle } from "../src/relay/bundle.ts"
import { RelayMaster } from "../src/relay/master.ts"
import { RelayWorker } from "../src/relay/worker.ts"
import type { Challenge } from "../src/challenge.ts"

const JOIN = "local-three-endpoint-join-token-123456"
const MASTER = "local-three-endpoint-master-token-123456"
const roots: string[] = []
const relays: RunningRelayServer[] = []

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

async function start() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-distributed-test-"))
  roots.push(root)
  const server = await startRelayServer({ dataDirectory: path.join(root, "relay"), hostname: "127.0.0.1", port: 0, joinToken: JOIN, masterToken: MASTER })
  relays.push(server)
  return { root, server, client: RelayClient.master({ url: server.url, token: MASTER }) }
}

test("challenge bundles round-trip with no workspace or credential files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-bundle-test-"))
  roots.push(root)
  const source = path.join(root, "challenge")
  await mkdir(source, { recursive: true })
  await Bun.write(path.join(source, "exploit.py"), "print('ok')\n")
  const challenge: Challenge = {
    slug: "bundle",
    category: "PWN",
    directory: source,
    description: "bundle test",
    files: ["exploit.py"],
    flagFormat: "DASCTF\\{[^}]+\\}",
    platform: { adapter: "xihulunjian", challengeID: "42" },
  }
  const packed = await packChallengeBundle({ challengeID: "42", challenge, target: path.join(root, "bundle.tar.gz") })
  const unpacked = await unpackChallengeBundle({ bundle: packed.path, directory: path.join(root, "out") })
  expect(unpacked.manifest.challengeID).toBe("42")
  expect(unpacked.challenge.files).toEqual(["exploit.py"])
  expect(await Bun.file(path.join(root, "out", "exploit.py")).text()).toContain("print('ok')")
})

test("master plus two local worker endpoints use separate Relay devices and divide offline work", async () => {
  const { root, server, client } = await start()
  const sourceRoot = path.join(root, "source")
  await mkdir(sourceRoot, { recursive: true })
  await Bun.write(path.join(sourceRoot, "one.txt"), "one")
  await Bun.write(path.join(sourceRoot, "two.txt"), "two")
  const makeChallenge = (slug: string, file: string): Challenge => ({
    slug,
    category: "MISC",
    directory: sourceRoot,
    description: slug,
    files: [file],
    flagFormat: "",
  })
  const master = await RelayMaster.open({ relay: client, root: path.join(root, "master") })
  expect(await master.sync([makeChallenge("one", "one.txt"), makeChallenge("two", "two.txt")])).toBe(2)

  const workerTokens = await Promise.all(["worker-a", "worker-b"].map(async (id) => {
    const result = await RelayClient.register({ url: server.url, joinToken: JOIN, id, name: id, role: "worker", maxSlots: 1 })
    return result.token
  }))
  const fakeRunner = () => ({
    setConcurrency() {},
    stop() {},
    close: async () => {},
    hasWork: () => false,
    enqueue: async () => [],
  })
  const workers = await Promise.all(workerTokens.map((token, index) => RelayWorker.open({
    relay: new RelayClient({ url: server.url, token }),
    root: path.join(root, `worker-${index}`),
    model: "test/model",
    maxSlots: 1,
    runner: fakeRunner() as never,
  })))
  const assignments = await Promise.all(workers.map((worker) => worker.poll()))
  expect(assignments.map((item) => item.assignments.map((assignment) => assignment.challenge.slug)).flat().sort()).toEqual(["one", "two"])
  expect(new Set(assignments.flatMap((item) => item.assignments.map((assignment) => assignment.deviceId))).size).toBe(2)
  await Promise.all(workers.map((worker) => worker.stop()))
})
