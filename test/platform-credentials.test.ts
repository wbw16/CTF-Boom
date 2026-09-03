import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  normalizePlatformServerHost,
  platformCredentialPath,
  platformCredentials,
  type PlatformCredentialSpec,
} from "../src/platform/credentials.ts"
import { findPlatformAdapterEntry } from "../src/platform/registry.ts"

/**
 * A synthetic adapter spec exercising every legacy mechanism (previous env vars and file names)
 * without depending on any concrete built-in adapter.
 */
const DEMO_SPEC: PlatformCredentialSpec = {
  id: "demo",
  label: "Demo",
  accessKeyEnvVar: "BOOM_DEMO_ACCESS_KEY",
  legacyAccessKeyEnvVars: ["BOOM_OLD_DEMO_ACCESS_KEY"],
  credentialFileName: "demo.json",
  legacyCredentialFileNames: ["demo-legacy.json"],
  defaultServerHost: "https://demo.example.test",
}

const TRACKED_ENV = ["BOOM_HOME", DEMO_SPEC.accessKeyEnvVar, ...DEMO_SPEC.legacyAccessKeyEnvVars!]
const roots: string[] = []
const original = new Map(TRACKED_ENV.map((name) => [name, process.env[name]]))

afterEach(async () => {
  for (const name of TRACKED_ENV) {
    const value = original.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("stores the AccessKey outside the challenge root with 0600 permissions and reports status only", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "boom-platform-credentials-"))
  roots.push(home)
  process.env.BOOM_HOME = home
  delete process.env[DEMO_SPEC.accessKeyEnvVar]
  const credentials = platformCredentials(DEMO_SPEC)

  expect(await credentials.loadAccessKey()).toBeUndefined()
  expect(await credentials.loadServerHost()).toBe(DEMO_SPEC.defaultServerHost)
  expect(await credentials.saveServerHost("https://contest.example.test/agent/")).toEqual({
    serverHost: "https://contest.example.test/agent",
  })
  expect(await credentials.loadServerHost()).toBe("https://contest.example.test/agent")
  expect(await credentials.saveAccessKey("ak_live_secret")).toEqual({ configured: true })
  expect(await credentials.loadAccessKey()).toBe("ak_live_secret")
  expect(await credentials.status()).toEqual({
    configured: true,
    serverHost: "https://contest.example.test/agent",
  })

  const target = platformCredentialPath(DEMO_SPEC.credentialFileName)
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
    version: 1,
    accessKey: "ak_live_secret",
    serverHost: "https://contest.example.test/agent",
  })
  expect((await stat(target)).mode & 0o777).toBe(0o600)

  expect(await credentials.saveAccessKey("")).toEqual({ configured: false })
  expect(await credentials.loadAccessKey()).toBeUndefined()
})

test("rejects a Server Host with credentials or a query", () => {
  expect(() => normalizePlatformServerHost("Demo", "https://token@example.test/api")).toThrow("不含凭据")
  expect(() => normalizePlatformServerHost("Demo", "https://example.test/api?token=secret")).toThrow("不含凭据")
})

test("reads the legacy env var and legacy credential file before any migration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "boom-platform-legacy-"))
  roots.push(home)
  process.env.BOOM_HOME = home
  delete process.env[DEMO_SPEC.accessKeyEnvVar]
  const credentials = platformCredentials(DEMO_SPEC)

  // Legacy env var wins over every file source.
  process.env[DEMO_SPEC.legacyAccessKeyEnvVars![0]!] = "legacy-env-key"
  expect(await credentials.loadAccessKey()).toBe("legacy-env-key")
  delete process.env[DEMO_SPEC.legacyAccessKeyEnvVars![0]!]

  // Legacy file is read when the current file does not exist yet.
  await writeFile(
    path.join(home, DEMO_SPEC.legacyCredentialFileNames![0]!),
    `${JSON.stringify({ version: 1, accessKey: "legacy-file-key", serverHost: "https://legacy.example.test" })}\n`,
  )
  expect(await credentials.loadAccessKey()).toBe("legacy-file-key")
  expect(await credentials.loadServerHost()).toBe("https://legacy.example.test")

  // Saving writes the current file (preserving the legacy-sourced fields) and leaves the legacy file untouched.
  await credentials.saveServerHost("https://next.example.test")
  const migrated = JSON.parse(await readFile(platformCredentialPath(DEMO_SPEC.credentialFileName), "utf8"))
  expect(migrated).toEqual({
    version: 1,
    accessKey: "legacy-file-key",
    serverHost: "https://next.example.test",
  })
  const legacy = JSON.parse(await readFile(path.join(home, DEMO_SPEC.legacyCredentialFileNames![0]!), "utf8"))
  expect(legacy.serverHost).toBe("https://legacy.example.test")
})

test("the built-in DASCTF entry still accepts its xihulunjian-era sources", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "boom-platform-dasctf-legacy-"))
  roots.push(home)
  process.env.BOOM_HOME = home
  const entry = findPlatformAdapterEntry("xihulunjian")
  expect(entry?.id).toBe("dasctf")
  expect(entry?.credentials.spec.legacyAccessKeyEnvVars).toContain("BOOM_XIHULUNJIAN_ACCESS_KEY")

  process.env.BOOM_XIHULUNJIAN_ACCESS_KEY = "xhlj-era-key"
  expect(await entry?.credentials.loadAccessKey()).toBe("xhlj-era-key")
  delete process.env.BOOM_XIHULUNJIAN_ACCESS_KEY

  await writeFile(
    path.join(home, "xihulunjian.json"),
    `${JSON.stringify({ version: 1, accessKey: "xhlj-era-file-key" })}\n`,
  )
  expect(await entry?.credentials.loadAccessKey()).toBe("xhlj-era-file-key")
})
