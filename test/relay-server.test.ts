import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startRelayServer, type RunningRelayServer } from "../src/relay/server.ts"

const roots: string[] = []
const relays: RunningRelayServer[] = []
const JOIN_TOKEN = "join-token-for-relay-tests-123456"
const MASTER_TOKEN = "master-token-for-relay-tests-123456"

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

async function relay(options: { leaseMs?: number; now?: () => number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-relay-test-"))
  roots.push(root)
  const running = await startRelayServer({
    dataDirectory: root,
    hostname: "127.0.0.1",
    port: 0,
    joinToken: JOIN_TOKEN,
    masterToken: MASTER_TOKEN,
    ...options,
  })
  relays.push(running)
  return running
}

async function request<T>(
  running: RunningRelayServer,
  pathname: string,
  options: { method?: string; token?: string; body?: unknown } = {},
) {
  const response = await fetch(`${running.url}${pathname}`, {
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

async function enroll(running: RunningRelayServer, id: string, role: "worker" | "master-worker", maxSlots = 1) {
  const { response, body } = await request<{
    token: string
    device: { id: string; role: string }
  }>(running, "/v1/devices/register", {
    method: "POST",
    token: JOIN_TOKEN,
    body: { id, name: id, role, maxSlots },
  })
  expect(response.status).toBe(201)
  return body.token
}

async function upload(running: RunningRelayServer, token: string, value: string) {
  const sha256 = digest(value)
  const response = await fetch(`${running.url}/v1/bundles/${sha256}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: value,
  })
  expect(response.status).toBe(201)
  return sha256
}

async function publish(
  running: RunningRelayServer,
  id: string,
  input: Record<string, unknown>,
) {
  const { response, body } = await request<{ challenge: { status: string; revision: number } }>(
    running,
    `/v1/challenges/${id}`,
    { method: "PUT", token: MASTER_TOKEN, body: input },
  )
  expect(response.status).toBe(200)
  return body.challenge
}

test("poll renews an existing lease and never fills a worker beyond its reported capacity", async () => {
  let now = 1_700_000_000_000
  const running = await relay({ leaseMs: 600_000, now: () => now })
  const bundle = await upload(running, MASTER_TOKEN, "offline challenge")
  await publish(running, "offline-a", {
    slug: "offline-a", kind: "offline", phase: "offline", revision: 1, bundleSha256: bundle,
  })
  await publish(running, "offline-b", {
    slug: "offline-b", kind: "offline", phase: "offline", revision: 1, bundleSha256: bundle,
  })
  const token = await enroll(running, "worker-a", "worker")

  const first = await request<{ assignments: Array<{ id: string; challenge: { id: string }; leaseUntil: string }> }>(
    running,
    "/v1/worker/poll",
    { method: "POST", token, body: { freeSlots: 1, activeAssignmentIds: [] } },
  )
  expect(first.response.status).toBe(200)
  expect(first.body.assignments).toHaveLength(1)
  const assignment = first.body.assignments[0]!
  expect(assignment.challenge.id).toBe("offline-a")

  now += 15_000
  const submitted = await request<{ flag: { id: string } }>(running, "/v1/flags", {
    method: "POST",
    token,
    body: { id: "rejected-1", assignmentId: assignment.id, value: "DASCTF{not-it}" },
  })
  expect(submitted.response.status).toBe(202)
  await request(running, "/v1/flags/rejected-1", {
    method: "PATCH", token: MASTER_TOKEN, body: { status: "rejected", detail: "wrong candidate" },
  })

  const resumed = await request<{
    assignments: Array<{ id: string; challenge: { id: string }; leaseUntil: string }>
    rejectedFlags: Array<{ id: string; status: string }>
  }>(
    running,
    "/v1/worker/poll",
    { method: "POST", token, body: { freeSlots: 1, activeAssignmentIds: [assignment.id] } },
  )
  expect(resumed.response.status).toBe(200)
  expect(resumed.body.assignments.map((item) => item.id)).toEqual([assignment.id])
  expect(Date.parse(resumed.body.assignments[0]!.leaseUntil)).toBe(now + 600_000)
  expect(resumed.body.rejectedFlags.map((item) => ({ id: item.id, status: item.status }))).toContainEqual({
    id: "rejected-1",
    status: "rejected",
  })

  const otherToken = await enroll(running, "worker-b", "worker")
  const other = await request<{ assignments: Array<{ challenge: { id: string } }> }>(running, "/v1/worker/poll", {
    method: "POST",
    token: otherToken,
    body: { freeSlots: 1, activeAssignmentIds: [] },
  })
  expect(other.body.assignments.map((item) => item.challenge.id)).toEqual(["offline-b"])
})

test("an expired lease is reassigned and an old worker is told to stop", async () => {
  let now = 1_700_000_000_000
  const running = await relay({ leaseMs: 60_000, now: () => now })
  const bundle = await upload(running, MASTER_TOKEN, "lease challenge")
  await publish(running, "lease", {
    slug: "lease", kind: "offline", phase: "offline", revision: 1, bundleSha256: bundle,
  })
  const firstToken = await enroll(running, "lease-first", "worker")
  const secondToken = await enroll(running, "lease-second", "worker")
  const first = await request<{ assignments: Array<{ id: string }> }>(running, "/v1/worker/poll", {
    method: "POST", token: firstToken, body: { freeSlots: 1, activeAssignmentIds: [] },
  })
  const oldID = first.body.assignments[0]!.id
  now += 60_000

  const second = await request<{ assignments: Array<{ id: string }> }>(running, "/v1/worker/poll", {
    method: "POST", token: secondToken, body: { freeSlots: 1, activeAssignmentIds: [] },
  })
  expect(second.body.assignments).toHaveLength(1)
  expect(second.body.assignments[0]!.id).not.toBe(oldID)
  const stale = await request<{ stopAssignments: Array<{ id: string; reason: string }> }>(running, "/v1/worker/poll", {
    method: "POST", token: firstToken, body: { freeSlots: 0, activeAssignmentIds: [oldID] },
  })
  expect(stale.body.stopAssignments).toContainEqual({ id: oldID, reason: "expired" })
})

test("an undelivered writeup assignment falls back to the master worker after one lease", async () => {
  let now = 1_700_000_000_000
  const running = await relay({ leaseMs: 60_000, now: () => now })
  const bundle = await upload(running, MASTER_TOKEN, "writeup source")
  await publish(running, "writeup-fallback", {
    slug: "writeup-fallback", kind: "offline", phase: "offline", revision: 1, bundleSha256: bundle,
  })
  const workerToken = await enroll(running, "writer-lost", "worker")
  const masterWorkerToken = await enroll(running, "writer-master", "master-worker")
  const assigned = await request<{ assignments: Array<{ id: string }> }>(running, "/v1/worker/poll", {
    method: "POST", token: workerToken, body: { freeSlots: 1, activeAssignmentIds: [] },
  })
  const solveAssignment = assigned.body.assignments[0]!.id
  await request(running, "/v1/flags", {
    method: "POST", token: workerToken,
    body: { id: "fallback-flag", assignmentId: solveAssignment, value: "DASCTF{fallback}" },
  })
  await request(running, "/v1/flags/fallback-flag", {
    method: "PATCH", token: MASTER_TOKEN, body: { status: "accepted" },
  })

  now += 60_000
  const state = await request<{ pendingWriteups: Array<{ writeupTargetDevice?: string }> }>(
    running,
    "/v1/master/state",
    { token: MASTER_TOKEN },
  )
  expect(state.body.pendingWriteups).toHaveLength(1)
  const fallback = await request<{ assignments: Array<{ phase: string }> }>(running, "/v1/worker/poll", {
    method: "POST", token: masterWorkerToken, body: { freeSlots: 1, activeAssignmentIds: [] },
  })
  expect(fallback.body.assignments.map((assignment) => assignment.phase)).toEqual(["writeup"])
})

test("remote result delivery, master online assignment, deduplicated flags, and writeup handoff survive retries", async () => {
  const running = await relay()
  const sourceBundle = await upload(running, MASTER_TOKEN, "remote source")
  const onlineBundle = await upload(running, MASTER_TOKEN, "online source")
  const resultBundle = await upload(running, MASTER_TOKEN, "exploit bundle")
  const writeupBundle = await upload(running, MASTER_TOKEN, "writeup bundle")
  await publish(running, "remote", {
    slug: "remote", kind: "remote", phase: "offline", revision: 1, bundleSha256: sourceBundle,
  })
  const offlineToken = await enroll(running, "offline-worker", "worker")
  const offline = await request<{ assignments: Array<{ id: string }> }>(running, "/v1/worker/poll", {
    method: "POST", token: offlineToken, body: { freeSlots: 1, activeAssignmentIds: [] },
  })
  const offlineAssignment = offline.body.assignments[0]!.id
  const result = await request<{ challenge: { status: string } }>(running, "/v1/results", {
    method: "POST", token: offlineToken, body: { assignmentId: offlineAssignment, bundleSha256: resultBundle },
  })
  expect(result.body.challenge.status).toBe("ready_online")
  const repeatedResult = await request<{ idempotent: boolean }>(running, "/v1/results", {
    method: "POST", token: offlineToken, body: { assignmentId: offlineAssignment, bundleSha256: resultBundle },
  })
  expect(repeatedResult.body.idempotent).toBe(true)

  await publish(running, "remote", {
    slug: "remote", kind: "remote", phase: "online", revision: 2, bundleSha256: onlineBundle,
    remoteUrl: "https://challenge.example.test:4000", remoteExpiresAt: Date.now() + 600_000,
  })
  const masterWorkerToken = await enroll(running, "master-worker", "master-worker")
  const online = await request<{ assignments: Array<{ id: string; phase: string; challenge: { resultBundleSha256?: string } }> }>(
    running,
    "/v1/worker/poll",
    { method: "POST", token: masterWorkerToken, body: { freeSlots: 1, activeAssignmentIds: [] } },
  )
  expect(online.body.assignments).toHaveLength(1)
  expect(online.body.assignments[0]!.phase).toBe("online")
  expect(online.body.assignments[0]!.challenge.resultBundleSha256).toBe(resultBundle)
  const onlineAssignment = online.body.assignments[0]!.id

  const submitted = await request<{ flag: { id: string; status: string } }>(running, "/v1/flags", {
    method: "POST", token: masterWorkerToken,
    body: { id: "submission-1", assignmentId: onlineAssignment, value: "DASCTF{relay}" },
  })
  expect(submitted.response.status).toBe(202)
  const repeated = await request<{ idempotent: boolean }>(running, "/v1/flags", {
    method: "POST", token: masterWorkerToken,
    body: { id: "submission-1", assignmentId: onlineAssignment, value: "DASCTF{relay}" },
  })
  expect(repeated.body.idempotent).toBe(true)
  const accepted = await request<{ flag: { status: string } }>(running, "/v1/flags/submission-1", {
    method: "PATCH", token: MASTER_TOKEN, body: { status: "accepted", detail: "accepted" },
  })
  expect(accepted.body.flag.status).toBe("accepted")

  const afterAccept = await request<{
    assignments: Array<{ id: string; phase: string }>
    stopAssignments: Array<{ id: string; reason: string }>
  }>(
    running,
    "/v1/worker/poll",
    { method: "POST", token: masterWorkerToken, body: { freeSlots: 1, activeAssignmentIds: [onlineAssignment] } },
  )
  expect(afterAccept.body.stopAssignments).toContainEqual({ id: onlineAssignment, reason: "finished" })
  expect(afterAccept.body.assignments.map((item) => item.phase)).toEqual(["writeup"])
  const writeupAssignment = afterAccept.body.assignments[0]!.id
  const writeup = await request<{ idempotent: boolean }>(running, "/v1/writeups", {
    method: "POST", token: masterWorkerToken, body: { assignmentId: writeupAssignment, bundleSha256: writeupBundle },
  })
  expect(writeup.body.idempotent).toBe(false)
  const repeatedWriteup = await request<{ idempotent: boolean }>(running, "/v1/writeups", {
    method: "POST", token: masterWorkerToken, body: { assignmentId: writeupAssignment, bundleSha256: writeupBundle },
  })
  expect(repeatedWriteup.body.idempotent).toBe(true)
})
