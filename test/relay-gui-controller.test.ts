import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadRelayConfig } from "../src/relay/config.ts"
import { RelayGuiController } from "../src/relay/gui-controller.ts"
import { startRelayServer, type RunningRelayServer } from "../src/relay/server.ts"

const JOIN = "standard+/base64=join-token-for-gui-controller"
const MASTER = "standard+/base64=master-token-for-gui-controller"
const directories: string[] = []
const relays: RunningRelayServer[] = []
const homes: Array<string | undefined> = []

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  const previous = homes.pop()
  if (previous === undefined) delete process.env.BOOM_HOME
  else process.env.BOOM_HOME = previous
})

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boom-relay-gui-controller-"))
  directories.push(directory)
  homes.push(process.env.BOOM_HOME)
  process.env.BOOM_HOME = path.join(directory, "home")
  const relay = await startRelayServer({
    dataDirectory: path.join(directory, "relay"),
    hostname: "127.0.0.1",
    port: 0,
    joinToken: JOIN,
    masterToken: MASTER,
  })
  relays.push(relay)
  return { directory, relay, root: path.join(directory, "worker-root") }
}

test("GUI worker joins with a standard-base64 enrollment secret and resumes from its private device token", async () => {
  const { relay, root } = await setup()
  const first = new RelayGuiController({ root })
  try {
    const joined = await first.startWorker({
      relayURL: relay.url,
      joinToken: JOIN,
      deviceID: "desktop-worker",
      deviceName: "Desktop worker",
      maxSlots: 1,
      model: "test/model",
    })
    expect(joined).toMatchObject({
      role: "worker",
      status: "running",
      device: { id: "desktop-worker", role: "worker", maxSlots: 1 },
      worker: { activeAssignments: 0 },
    })
    expect(await loadRelayConfig()).toMatchObject({
      relayURL: relay.url,
      deviceID: "desktop-worker",
      role: "worker",
      root,
    })
  } finally {
    await first.stop()
  }

  const resumed = new RelayGuiController({ root })
  try {
    const state = await resumed.resumeWorker()
    expect(state).toMatchObject({
      role: "worker",
      status: "running",
      device: { id: "desktop-worker", role: "worker" },
    })
  } finally {
    await resumed.stop()
  }
})

test("GUI master authenticates separately, enrolls a master-worker, and can stop cleanly", async () => {
  const { relay, root } = await setup()
  const controller = new RelayGuiController({ root })
  try {
    const state = await controller.startMaster({
      relayURL: relay.url,
      masterToken: MASTER,
      joinToken: JOIN,
      deviceID: "competition-host",
      deviceName: "Competition host",
      maxSlots: 2,
      model: "test/model",
      maxRemoteSlots: 3,
    })
    expect(state).toMatchObject({
      role: "master",
      status: "running",
      device: { id: "competition-host", role: "master-worker", maxSlots: 2 },
    })
    await controller.stop()
    expect(controller.snapshot()).toEqual({ role: "inactive", status: "idle" })
  } finally {
    await controller.stop()
  }
})
