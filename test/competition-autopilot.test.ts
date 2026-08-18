import { expect, test } from "bun:test"
import {
  CompetitionAutopilot,
  isRetryableAutopilotError,
} from "../src/competition/autopilot.ts"

test("unattended polling retries transient failures, then schedules the next ten-minute pass", async () => {
  let calls = 0
  const delays: number[] = []
  const autopilot = new CompetitionAutopilot({
    intervalMs: 600_000,
    retryDelaysMs: [1, 2],
    sleep: async (delay) => { delays.push(delay) },
    sync: async () => {
      calls += 1
      if (calls < 3) throw new Error("fetch failed: temporary network outage")
      return { downloaded: 4, queued: 3, skipped: 1 }
    },
  })
  try {
    autopilot.start({ immediate: false })
    await autopilot.syncNow()
    expect(calls).toBe(3)
    expect(delays).toEqual([1, 2])
    expect(autopilot.state()).toMatchObject({
      enabled: true,
      syncing: false,
      retries: 2,
      lastResult: { downloaded: 4, queued: 3, skipped: 1 },
    })
    expect(autopilot.state().nextSyncAt).toBeNumber()
  } finally {
    autopilot.stop()
  }
})

test("starting unattended mode performs its first sync immediately", async () => {
  let calls = 0
  const autopilot = new CompetitionAutopilot({
    intervalMs: 600_000,
    sync: async () => {
      calls += 1
      return { downloaded: 3, queued: 3, skipped: 0 }
    },
  })
  try {
    autopilot.start()
    await autopilot.syncNow()
    expect(calls).toBe(1)
    expect(autopilot.state()).toMatchObject({
      enabled: true,
      syncing: false,
      lastResult: { downloaded: 3, queued: 3, skipped: 0 },
    })
  } finally {
    autopilot.stop()
  }
})

test("a non-retryable catalog error is recorded but never disables future unattended polls", async () => {
  let calls = 0
  const autopilot = new CompetitionAutopilot({
    intervalMs: 600_000,
    retryDelaysMs: [1, 2, 3],
    sleep: async () => {},
    sync: async () => {
      calls += 1
      throw new Error("西湖论剑接口 GET /ctf/exercise-list 失败 (401): AccessKey 无效")
    },
  })
  try {
    autopilot.start({ immediate: false })
    await autopilot.syncNow()
    expect(calls).toBe(1)
    expect(autopilot.state()).toMatchObject({
      enabled: true,
      syncing: false,
      retries: 0,
      lastError: expect.stringContaining("401"),
    })
    expect(autopilot.state().nextSyncAt).toBeNumber()
  } finally {
    autopilot.stop()
  }
})

test("overlapping triggers coalesce into one catalog sync", async () => {
  let calls = 0
  let release: (() => void) | undefined
  const autopilot = new CompetitionAutopilot({
    intervalMs: 600_000,
    sync: async () => {
      calls += 1
      await new Promise<void>((resolve) => { release = resolve })
      return { downloaded: 1, queued: 1, skipped: 0 }
    },
  })
  try {
    autopilot.start({ immediate: false })
    const first = autopilot.syncNow()
    const second = autopilot.syncNow()
    expect(calls).toBe(1)
    release?.()
    await Promise.all([first, second])
    expect(calls).toBe(1)
  } finally {
    autopilot.stop()
  }
})

test("retry classification excludes credential and malformed-data failures", () => {
  expect(isRetryableAutopilotError(new Error("fetch failed"))).toBe(true)
  expect(isRetryableAutopilotError(new Error("平台失败 (503)"))).toBe(true)
  expect(isRetryableAutopilotError(new Error("平台失败 (401): AccessKey 无效"))).toBe(false)
  expect(isRetryableAutopilotError(new Error("题目列表结构异常"))).toBe(false)
})
