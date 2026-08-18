import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  XIHULUNJIAN_DEFAULT_SERVER_HOST,
  XIHULUNJIAN_ACCESS_KEY_ENV,
  loadXihulunjianAccessKey,
  loadXihulunjianServerHost,
  normalizeXihulunjianServerHost,
  saveXihulunjianAccessKey,
  saveXihulunjianServerHost,
  xihulunjianCredentialPath,
} from "../src/xihulunjian-config.ts"

const roots: string[] = []
const originalHome = process.env.BOOM_HOME
const originalKey = process.env[XIHULUNJIAN_ACCESS_KEY_ENV]

afterEach(async () => {
  if (originalHome === undefined) delete process.env.BOOM_HOME
  else process.env.BOOM_HOME = originalHome
  if (originalKey === undefined) delete process.env[XIHULUNJIAN_ACCESS_KEY_ENV]
  else process.env[XIHULUNJIAN_ACCESS_KEY_ENV] = originalKey
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("stores the dedicated AccessKey outside the challenge root and never returns it through status", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "boom-xihu-config-"))
  roots.push(home)
  process.env.BOOM_HOME = home
  delete process.env[XIHULUNJIAN_ACCESS_KEY_ENV]

  expect(await loadXihulunjianAccessKey()).toBeUndefined()
  expect(await loadXihulunjianServerHost()).toBe(XIHULUNJIAN_DEFAULT_SERVER_HOST)
  expect(await saveXihulunjianServerHost("https://contest.example.test/agent/")).toEqual({
    serverHost: "https://contest.example.test/agent",
  })
  expect(await loadXihulunjianServerHost()).toBe("https://contest.example.test/agent")
  expect(await saveXihulunjianAccessKey("ak_live_secret")).toEqual({ configured: true })
  expect(await loadXihulunjianAccessKey()).toBe("ak_live_secret")
  expect(JSON.parse(await readFile(xihulunjianCredentialPath(), "utf8"))).toEqual({
    version: 1,
    accessKey: "ak_live_secret",
    serverHost: "https://contest.example.test/agent",
  })
  expect((await stat(xihulunjianCredentialPath())).mode & 0o777).toBe(0o600)

  expect(await saveXihulunjianAccessKey("")).toEqual({ configured: false })
  expect(await loadXihulunjianAccessKey()).toBeUndefined()
})

test("rejects a Server Host with credentials or a query", async () => {
  expect(() => normalizeXihulunjianServerHost("https://token@example.test/api")).toThrow("不含凭据")
  expect(() => normalizeXihulunjianServerHost("https://example.test/api?token=secret")).toThrow("不含凭据")
})
