import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startRelayServer } from "../src/relay/server.ts"
import {
  loadRelayTokens,
  relayTokensFilePath,
  resolveRelayTokens,
} from "../src/relay/tokens.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-relay-tokens-"))
  roots.push(root)
  return root
}

test("auto-generates distinct tokens once and reuses them across restarts", async () => {
  const root = await directory()
  const first = await resolveRelayTokens(root, {})
  expect(first.source).toBe("generated")
  expect(first.file).toBe(relayTokensFilePath(root))
  expect(first.joinToken).not.toBe(first.masterToken)
  for (const token of [first.joinToken, first.masterToken]) {
    expect(token.length).toBeGreaterThanOrEqual(16)
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true)
  }
  const info = await stat(first.file)
  expect(info.mode & 0o777).toBe(0o600)

  const second = await resolveRelayTokens(root, {})
  expect(second.source).toBe("file")
  expect(second.joinToken).toBe(first.joinToken)
  expect(second.masterToken).toBe(first.masterToken)

  const loaded = await loadRelayTokens(root)
  expect(loaded?.joinToken).toBe(first.joinToken)
  expect(loaded?.masterToken).toBe(first.masterToken)
})

test("environment tokens win and are never written to disk", async () => {
  const root = await directory()
  const resolved = await resolveRelayTokens(root, {
    BOOM_RELAY_JOIN_TOKEN: "environment-join-token-123456",
    BOOM_RELAY_MASTER_TOKEN: "environment-master-token-123456",
  })
  expect(resolved.source).toBe("environment")
  expect(resolved.joinToken).toBe("environment-join-token-123456")
  expect(resolved.masterToken).toBe("environment-master-token-123456")
  await expect(stat(relayTokensFilePath(root))).rejects.toThrow()
})

test("rejects partial, equal, or weak environment tokens", async () => {
  const root = await directory()
  await expect(resolveRelayTokens(root, { BOOM_RELAY_JOIN_TOKEN: "only-join-token-here-12345" })).rejects.toThrow(
    /both BOOM_RELAY_JOIN_TOKEN and BOOM_RELAY_MASTER_TOKEN/,
  )
  await expect(
    resolveRelayTokens(root, {
      BOOM_RELAY_JOIN_TOKEN: "same-token-value-1234567890",
      BOOM_RELAY_MASTER_TOKEN: "same-token-value-1234567890",
    }),
  ).rejects.toThrow(/must be different/)
  await expect(
    resolveRelayTokens(root, {
      BOOM_RELAY_JOIN_TOKEN: "short",
      BOOM_RELAY_MASTER_TOKEN: "long-enough-master-token-123",
    }),
  ).rejects.toThrow(/16-512/)
})

test("rejects a corrupted tokens file", async () => {
  const root = await directory()
  const file = relayTokensFilePath(root)
  await writeFile(file, '{"version":2,"joinToken":"x","masterToken":"y"}\n', { encoding: "utf8" })
  await expect(loadRelayTokens(root)).rejects.toThrow(/invalid/)
  await expect(resolveRelayTokens(root, {})).rejects.toThrow(/invalid/)
})

test("generated tokens authenticate against a running Relay", async () => {
  const root = await directory()
  const tokens = await resolveRelayTokens(root, {})
  const running = await startRelayServer({
    dataDirectory: root,
    hostname: "127.0.0.1",
    port: 0,
    joinToken: tokens.joinToken,
    masterToken: tokens.masterToken,
  })
  try {
    const denied = await fetch(`${running.url}/v1/master/state`)
    expect(denied.status).toBe(401)
    const accepted = await fetch(`${running.url}/v1/master/state`, {
      headers: { Authorization: `Bearer ${tokens.masterToken}` },
    })
    expect(accepted.status).toBe(200)
    const enrolled = await fetch(`${running.url}/v1/devices/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.joinToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "device-1", name: "Device One", role: "worker", maxSlots: 1 }),
    })
    expect(enrolled.status).toBe(201)
  } finally {
    await running.close()
  }
})
