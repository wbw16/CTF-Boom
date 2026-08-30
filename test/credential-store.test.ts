import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  boomOpenCodeAuthContent,
  credentialStorePath,
  getProviderAPIKey,
  hasProviderAPIKey,
  importOpenCodeCredentials,
  setProviderAPIKey,
} from "../src/runtime/credential-store.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

async function useTemporaryBoomHome(prefix: string) {
  const boomHome = await mkdtemp(path.join(os.tmpdir(), prefix))
  directories.push(boomHome)
  const previousHome = process.env.BOOM_HOME
  process.env.BOOM_HOME = boomHome
  return {
    restore() {
      if (previousHome === undefined) delete process.env.BOOM_HOME
      else process.env.BOOM_HOME = previousHome
    },
  }
}

test("imports only OpenCode API and OAuth credentials into Boom's private store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boom-credential-import-"))
  directories.push(root)
  const boomHome = path.join(root, "boom")
  const source = path.join(root, "foreign", "opencode", "auth.json")
  await mkdir(path.dirname(source), { recursive: true })
  await writeFile(source, JSON.stringify({
    openai: {
      type: "oauth",
      refresh: "oauth-refresh-secret",
      access: "oauth-access-secret",
      expires: 1_900_000_000_000,
      accountId: "account-1",
    },
    deepseek: { type: "api", key: "deepseek-api-secret" },
    github: { type: "wellknown", key: "unsupported-secret" },
    "Invalid Provider": { type: "api", key: "invalid-id-secret" },
  }))
  const previousHome = process.env.BOOM_HOME
  process.env.BOOM_HOME = boomHome
  try {
    const result = await importOpenCodeCredentials(source)
    expect(result).toEqual({
      source,
      imported: [
        { id: "openai", type: "oauth" },
        { id: "deepseek", type: "api" },
      ],
      skipped: 2,
    })
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(await hasProviderAPIKey("openai")).toBe(true)
    const stored = JSON.parse(await readFile(credentialStorePath(), "utf8"))
    expect(stored).toMatchObject({
      version: 2,
      providers: {
        openai: { type: "oauth", accountId: "account-1" },
        deepseek: { type: "api" },
      },
    })
    expect(stored.providers.github).toBeUndefined()
    expect((await stat(credentialStorePath())).mode & 0o777).toBe(0o600)
    expect((await stat(boomHome)).mode & 0o777).toBe(0o700)
  } finally {
    if (previousHome === undefined) delete process.env.BOOM_HOME
    else process.env.BOOM_HOME = previousHome
  }
})

test("converts the previous Boom API-key store format for the in-memory runtime", async () => {
  const boomHome = await mkdtemp(path.join(os.tmpdir(), "boom-credential-v1-"))
  directories.push(boomHome)
  const previousHome = process.env.BOOM_HOME
  process.env.BOOM_HOME = boomHome
  try {
    await writeFile(
      credentialStorePath(),
      JSON.stringify({ version: 1, apiKeys: { openai: "legacy-boom-secret" } }),
    )
    const content = JSON.parse(await boomOpenCodeAuthContent())
    expect(content.openai).toEqual({ type: "api", key: "legacy-boom-secret" })
  } finally {
    if (previousHome === undefined) delete process.env.BOOM_HOME
    else process.env.BOOM_HOME = previousHome
  }
})

test("skips a damaged provider entry instead of bricking the whole store", async () => {
  const { restore } = await useTemporaryBoomHome("boom-credential-corrupt-")
  const warn = spyOn(console, "warn")
  try {
    await writeFile(credentialStorePath(), JSON.stringify({
      version: 2,
      providers: {
        openai: { type: "api", key: "good-openai-secret" },
        deepseek: { type: "api" },
        github: { type: "api", key: "good-github-secret" },
      },
    }))

    expect(await hasProviderAPIKey("openai")).toBe(true)
    expect(await hasProviderAPIKey("github")).toBe(true)
    expect(await getProviderAPIKey("deepseek")).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deepseek"))

    // Rewriting the store keeps the surviving entries intact.
    await setProviderAPIKey("anthropic", "new-anthropic-secret")
    const stored = JSON.parse(await readFile(credentialStorePath(), "utf8"))
    expect(stored.providers.openai).toEqual({ type: "api", key: "good-openai-secret" })
    expect(stored.providers.github).toEqual({ type: "api", key: "good-github-secret" })
    expect(stored.providers.anthropic).toEqual({ type: "api", key: "new-anthropic-secret" })
    expect(stored.providers.deepseek).toBeUndefined()
  } finally {
    warn.mockRestore()
    restore()
  }
})

test("refuses to mutate while another process holds the store lock", async () => {
  const { restore } = await useTemporaryBoomHome("boom-credential-lock-")
  try {
    await writeFile(credentialStorePath(), JSON.stringify({
      version: 2,
      providers: { openai: { type: "api", key: "before-secret" } },
    }))
    // A fresh lock (current mtime) belongs to a live process: retry briefly, then give up.
    const lockFile = `${credentialStorePath()}.lock`
    await writeFile(lockFile, `${JSON.stringify({ pid: 999_999 })}\n`)

    await expect(setProviderAPIKey("openai", "blocked-secret"))
      .rejects.toThrow("另一个 Boom 进程正在更新凭据")

    const stored = JSON.parse(await readFile(credentialStorePath(), "utf8"))
    expect(stored.providers.openai.key).toBe("before-secret")
  } finally {
    restore()
  }
})

test("breaks a stale lock left behind by a crashed process", async () => {
  const { restore } = await useTemporaryBoomHome("boom-credential-stale-lock-")
  try {
    const lockFile = `${credentialStorePath()}.lock`
    await writeFile(lockFile, `${JSON.stringify({ pid: 999_999 })}\n`)
    const stale = new Date(Date.now() - 40_000)
    await utimes(lockFile, stale, stale)

    await setProviderAPIKey("openai", "after-stale-takeover")

    expect(await getProviderAPIKey("openai")).toBe("after-stale-takeover")
    await expect(stat(lockFile)).rejects.toThrow()
  } finally {
    restore()
  }
})
