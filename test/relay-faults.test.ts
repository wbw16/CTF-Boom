import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type Challenge } from "../src/challenge.ts"
import { startRelayServer, type RunningRelayServer } from "../src/relay/server.ts"
import { RelayClient } from "../src/relay/client.ts"
import { packChallengeBundle } from "../src/relay/bundle.ts"
import { RelayMaster } from "../src/relay/master.ts"
import { RelayWorker } from "../src/relay/worker.ts"
import { XIHULUNJIAN_ADAPTER_ID, type XihulunjianSubmissionResult } from "../src/xihulunjian-platform-adapter.ts"

const JOIN_TOKEN = "join-token-for-relay-fault-tests-123456"
const MASTER_TOKEN = "master-token-for-relay-fault-tests-123456"
const roots: string[] = []
const relays: RunningRelayServer[] = []

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

async function start(dataDirectory?: string) {
  const root = dataDirectory ?? await mkdtemp(path.join(os.tmpdir(), "boom-relay-fault-"))
  roots.push(root)
  const server = await startRelayServer({
    dataDirectory: root,
    hostname: "127.0.0.1",
    port: 0,
    joinToken: JOIN_TOKEN,
    masterToken: MASTER_TOKEN,
  })
  relays.push(server)
  return { root, server }
}

async function request<T>(
  server: RunningRelayServer,
  pathname: string,
  options: { method?: string; token?: string; body?: unknown } = {},
) {
  const response = await fetch(`${server.url}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const body = await response.json() as T
  return { response, body }
}

async function upload(server: RunningRelayServer, token: string, value: string) {
  const sha256 = digest(value)
  const response = await fetch(`${server.url}/v1/bundles/${sha256}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: value,
  })
  expect(response.status).toBe(201)
  return sha256
}

async function publish(server: RunningRelayServer, id: string, input: Record<string, unknown>) {
  const { response, body } = await request<{ challenge: { status: string; revision: number } }>(
    server,
    `/v1/challenges/${id}`,
    { method: "PUT", token: MASTER_TOKEN, body: input },
  )
  expect(response.status).toBe(200)
  return body.challenge
}

async function enroll(server: RunningRelayServer, id: string, role: "worker" | "master-worker", maxSlots = 1) {
  const registration = await RelayClient.register({
    url: server.url,
    joinToken: JOIN_TOKEN,
    id,
    name: id,
    role,
    maxSlots,
  })
  return registration.token
}

/** Pack a real challenge bundle, upload it with the master client, and publish it. */
async function publishPackedChallenge(input: {
  server: RunningRelayServer
  root: string
  id: string
  slug: string
  kind: "offline" | "remote"
  file: string
  content: string
}) {
  const client = RelayClient.master({ url: input.server.url, token: MASTER_TOKEN })
  const source = path.join(input.root, "source", input.slug)
  await mkdir(source, { recursive: true })
  await Bun.write(path.join(source, input.file), input.content)
  const challenge: Challenge = {
    slug: input.slug,
    category: input.kind === "remote" ? "PWN" : "MISC",
    directory: source,
    description: input.slug,
    files: [input.file],
    flagFormat: "DASCTF\\{[^}]+\\}",
    platform: { adapter: "xihulunjian", challengeID: input.id },
  }
  const packed = await packChallengeBundle({ challengeID: input.id, challenge, target: path.join(input.root, `${input.slug}.tar.gz`) })
  await client.putBundle(packed.sha256, packed.path)
  await publish(input.server, input.id, {
    id: input.id,
    slug: input.slug,
    category: challenge.category,
    kind: input.kind,
    phase: "offline",
    revision: 1,
    bundleSha256: packed.sha256,
  })
  return packed
}

function fakeRunner() {
  return {
    setConcurrency() {},
    stop() {},
    close: async () => {},
    hasWork: () => false,
    enqueue: async () => [],
  }
}

function submitStub(verdict: "accepted" | "rejected" | "pending") {
  return async (): Promise<XihulunjianSubmissionResult> => ({
    adapter: XIHULUNJIAN_ADAPTER_ID,
    verdict,
    detail: `fault-test ${verdict}`,
    submittedAt: new Date().toISOString(),
  })
}

test("Relay restart preserves queued challenges, active assignments, and pending flags", async () => {
  const { root, server } = await start()
  const bundle = await upload(server, MASTER_TOKEN, "restart bundle")
  await publish(server, "restart-a", {
    slug: "restart-a", kind: "offline", phase: "offline", revision: 1, bundleSha256: bundle,
  })
  await publish(server, "restart-b", {
    slug: "restart-b", kind: "offline", phase: "offline", revision: 1, bundleSha256: bundle,
  })
  const token = await enroll(server, "restart-worker", "worker")
  const first = await request<{ assignments: Array<{ id: string; challenge: { id: string } }> }>(
    server,
    "/v1/worker/poll",
    { method: "POST", token, body: { freeSlots: 1, activeAssignmentIds: [] } },
  )
  expect(first.body.assignments).toHaveLength(1)
  const assignmentID = first.body.assignments[0]!.id
  await request(server, "/v1/flags", {
    method: "POST",
    token,
    body: { id: "restart-flag-1", assignmentId: assignmentID, value: "DASCTF{restart-flag}" },
  })
  await server.close()
  relays.splice(relays.indexOf(server), 1)

  const restarted = await start(root)
  try {
    const state = await request<{ pendingFlags: Array<{ id: string }> }>(
      restarted.server,
      "/v1/master/state",
      { token: MASTER_TOKEN },
    )
    expect(state.body.pendingFlags.map((flag) => flag.id)).toContain("restart-flag-1")
    // The same worker resumes its single assignment instead of receiving a duplicate.
    const resumed = await request<{ assignments: Array<{ id: string }> }>(
      restarted.server,
      "/v1/worker/poll",
      { method: "POST", token, body: { freeSlots: 1, activeAssignmentIds: [assignmentID] } },
    )
    expect(resumed.body.assignments.map((item) => item.id)).toEqual([assignmentID])
    // A brand new device claims the remaining queued challenge.
    const freshToken = await enroll(restarted.server, "restart-worker-2", "worker")
    const fresh = await request<{ assignments: Array<{ challenge: { id: string } }> }>(
      restarted.server,
      "/v1/worker/poll",
      { method: "POST", token: freshToken, body: { freeSlots: 1, activeAssignmentIds: [] } },
    )
    expect(fresh.body.assignments.map((item) => item.challenge.id)).toEqual(["restart-b"])
  } finally {
    await restarted.server.close()
  }
})

test("worker restart recovers its active assignment and retries the outbox", async () => {
  const { root, server } = await start()
  await publishPackedChallenge({
    server, root, id: "worker-restart", slug: "worker-restart", kind: "offline",
    file: "solve.py", content: "print('recover')\n",
  })
  const token = await enroll(server, "restart-worker", "worker")
  const workerRoot = path.join(root, "worker")
  const makeWorker = () => RelayWorker.open({
    relay: new RelayClient({ url: server.url, token }),
    root: workerRoot,
    model: "test/model",
    maxSlots: 1,
    runner: fakeRunner() as never,
  })
  const worker = await makeWorker()
  const polled = await worker.poll()
  expect(polled.assignments).toHaveLength(1)
  const assignmentID = polled.assignments[0]!.id
  await worker.stop()

  // Simulate a crash before the previous process flushed this candidate to the Relay.
  const statePath = path.join(workerRoot, "relay", "worker-state.json")
  const saved = JSON.parse(await readFile(statePath, "utf8")) as { outbox: unknown[] }
  saved.outbox.push({ id: "submission-restart-1", kind: "flag", assignmentId: assignmentID, value: "DASCTF{restart-outbox}" })
  await writeFile(statePath, JSON.stringify(saved))

  const restarted = await makeWorker()
  try {
    await restarted.poll()
    const state = await request<{ pendingFlags: Array<{ id: string; value: string }> }>(
      server,
      "/v1/master/state",
      { token: MASTER_TOKEN },
    )
    expect(state.body.pendingFlags).toContainEqual(
      expect.objectContaining({ id: "submission-restart-1", value: "DASCTF{restart-outbox}" }),
    )
    // The recovered assignment stays alive on the following poll.
    const again = await restarted.poll()
    expect(again.assignments.map((item) => item.id)).toContain(assignmentID)
  } finally {
    await restarted.stop()
  }
})

test("connector restart continues judging an offline flag and hands the writeup to the solver", async () => {
  const { root, server } = await start()
  const client = RelayClient.master({ url: server.url, token: MASTER_TOKEN })
  await publishPackedChallenge({
    server, root, id: "offline-flag", slug: "offline-flag", kind: "offline",
    file: "solve.py", content: "print('solve')\n",
  })
  const token = await enroll(server, "solver", "worker")
  const worker = new RelayClient({ url: server.url, token })
  const polled = await worker.poll({ freeSlots: 1, activeAssignmentIds: [] })
  expect(polled.assignments).toHaveLength(1)
  const assignmentID = polled.assignments[0]!.id
  await worker.submitFlag({ id: "offline-flag-1", assignmentId: assignmentID, value: "DASCTF{offline}" })

  const masterRoot = path.join(root, "master")
  const first = await RelayMaster.open({
    relay: client,
    root: masterRoot,
    submitFlag: submitStub("pending"),
  })
  await first.cycle()
  first.stop()
  const stateAfterFirst = await client.masterState()
  expect(stateAfterFirst.pendingFlags).toHaveLength(1)
  expect(stateAfterFirst.pendingFlagChallenges.map((challenge) => challenge.id)).toContain("offline-flag")

  // A restarted connector instance rebuilds from Relay state and continues the submission.
  const second = await RelayMaster.open({
    relay: client,
    root: masterRoot,
    submitFlag: submitStub("accepted"),
  })
  await second.cycle()
  second.stop()
  const afterAccept = await client.masterState()
  expect(afterAccept.pendingFlags).toHaveLength(0)
  expect(afterAccept.pendingWriteups.map((challenge) => challenge.id)).toEqual(["offline-flag"])

  // The original solving device receives the writeup assignment.
  const writeupPoll = await worker.poll({ freeSlots: 1, activeAssignmentIds: [assignmentID] })
  expect(writeupPoll.assignments.map((assignment) => assignment.phase)).toContain("writeup")
})

test("master provisions at most three environments and the master worker takes online work first", async () => {
  const { root, server } = await start()
  const client = RelayClient.master({ url: server.url, token: MASTER_TOKEN })
  const resultBundle = await upload(server, MASTER_TOKEN, "result bundle")
  for (let index = 0; index < 4; index += 1) {
    await publishPackedChallenge({
      server, root, id: `remote-${index}`, slug: `remote-${index}`, kind: "remote",
      file: "exploit.py", content: `print('remote-${index}')\n`,
    })
  }
  const workerToken = await enroll(server, "offline-worker", "worker", 5)
  const offline = await request<{ assignments: Array<{ id: string }> }>(server, "/v1/worker/poll", {
    method: "POST", token: workerToken, body: { freeSlots: 5, activeAssignmentIds: [] },
  })
  expect(offline.body.assignments).toHaveLength(4)
  for (const assignment of offline.body.assignments) {
    const result = await request<{ challenge: { status: string } }>(server, "/v1/results", {
      method: "POST", token: workerToken, body: { assignmentId: assignment.id, bundleSha256: resultBundle },
    })
    expect(result.body.challenge.status).toBe("ready_online")
  }

  let provisions = 0
  const master = await RelayMaster.open({
    relay: client,
    root: path.join(root, "master"),
    maxRemoteSlots: 3,
    provision: async () => {
      provisions += 1
      return { remoteUrl: `https://env-${provisions}.example.test:4000`, remoteExpiresAt: Date.now() + 600_000 }
    },
  })
  await master.cycle()
  master.stop()
  const after = await client.masterState()
  expect(provisions).toBe(3)
  expect(after.readyOnline).toHaveLength(1)
  expect(after.activeRemote).toHaveLength(3)

  const masterWorkerToken = await enroll(server, "master-worker", "master-worker", 5)
  const online = await request<{
    assignments: Array<{ id: string; phase: "offline" | "online"; challenge: { id: string } }>
  }>(server, "/v1/worker/poll", {
    method: "POST", token: masterWorkerToken, body: { freeSlots: 5, activeAssignmentIds: [] },
  })
  expect(online.body.assignments.filter((assignment) => assignment.phase === "online")).toHaveLength(3)
  expect(online.body.assignments.every((assignment) => assignment.phase === "online")).toBe(true)
})
