import { describe, expect, test } from "bun:test"
import { PlatformAdapterRegistry } from "../src/platform-adapter.ts"

const input = {
  root: "/tmp/ctf",
  challenge: {
    slug: "sample",
    directory: "/tmp/ctf/challenges/sample",
    description: "",
    files: [],
    flagFormat: "",
  },
  workspace: {
    directory: "/tmp/ctf/runs/sample/task",
    runID: "task",
    extracted: [],
  },
  candidate: "flag{x}",
}

describe("optional CTF platform adapters", () => {
  test("falls back to manual confirmation when no adapter is configured", async () => {
    expect(await new PlatformAdapterRegistry().submitFlag(input)).toMatchObject({
      adapter: "manual",
      verdict: "pending",
    })
  })

  test("keeps acquisition and submission behind one platform-specific boundary", async () => {
    const calls: string[] = []
    const registry = new PlatformAdapterRegistry([{
      id: "demo",
      async acquireChallenges() {
        calls.push("acquire")
        return []
      },
      async submitFlag(request) {
        calls.push(`submit:${request.candidate}`)
        return {
          adapter: "demo",
          verdict: "rejected",
          detail: "wrong flag",
          submittedAt: "2026-08-03T00:00:00.000Z",
        }
      },
    }])
    await registry.acquireChallenges("demo", { root: input.root })
    const result = await registry.submitFlag({
      ...input,
      challenge: { ...input.challenge, platform: { adapter: "demo", challengeID: "42" } },
    })
    expect(result.verdict).toBe("rejected")
    expect(calls).toEqual(["acquire", "submit:flag{x}"])
  })

  test("loads a configured adapter lazily for either capability", async () => {
    const loaded: string[] = []
    const registry = new PlatformAdapterRegistry([], async (id, root) => {
      loaded.push(`${id}:${root}`)
      return {
        id,
        async acquireChallenges() { return [] },
        async submitFlag() {
          return { adapter: id, verdict: "accepted", detail: "ok", submittedAt: "2026-08-05T00:00:00.000Z" }
        },
      }
    })
    expect(await registry.capabilities("lazy", input.root)).toEqual({
      listChallenges: false,
      acquireChallenges: true,
      submitFlag: true,
    })
    expect((await registry.submitFlag({
      ...input,
      challenge: { ...input.challenge, platform: { adapter: "lazy", challengeID: "1" } },
    })).verdict).toBe("accepted")
    expect(loaded).toEqual([`lazy:${input.root}`])
  })

  test("does not reuse a root-loaded adapter after the GUI root changes", async () => {
    const registry = new PlatformAdapterRegistry([], async (id, root) => ({
      id,
      async acquireChallenges() { return [] },
      async submitFlag() {
        return { adapter: id, verdict: "pending", detail: root, submittedAt: "2026-08-05T00:00:00.000Z" }
      },
    }))
    const first = await registry.submitFlag({
      ...input,
      root: "/tmp/one",
      challenge: { ...input.challenge, platform: { adapter: "same" } },
    })
    const second = await registry.submitFlag({
      ...input,
      root: "/tmp/two",
      challenge: { ...input.challenge, platform: { adapter: "same" } },
    })
    expect(first.detail).toBe("/tmp/one")
    expect(second.detail).toBe("/tmp/two")
  })
})
