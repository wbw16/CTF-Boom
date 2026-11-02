import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppProvider, type AppContextValue } from "../frontend/src/context"
import { Queue } from "../frontend/src/Queue"
import { queueFlag } from "../frontend/src/state"
import type { ChallengeGui, GuiState, RunHistory } from "../frontend/src/types"

const format = "flag\\{[^}]*\\}"
function run(overrides: Partial<RunHistory> = {}): RunHistory {
  return {
    id: "run-1", model: "test/model", stop: "completed", tokens: 10,
    billableTokens: 10, cost: 0, candidates: [], alternatives: [],
    flagFormat: format, reply: "", events: [], notes: "", files: [], ...overrides,
  }
}
function challenge(...runs: RunHistory[]): ChallengeGui {
  return { slug: "alpha", category: "MISC", storagePath: "MISC/alpha", files: [], runs }
}
function render(item: ChallengeGui) {
  const noop = () => {}
  const data: GuiState = {
    root: "/tmp/boom-queue-render",
    settings: {
      mode: "ctf", economyModel: "test/model", strongModel: "test/model", tokens: 10000,
      tokenBudgetEnabled: true, repeats: 3, minutes: 5, concurrency: 1, flagFormat: format,
      executionMode: "managed", consultModels: [], blindReview: true,
      consultOnCompaction: true, network: "allow",
      competition: { remoteSlots: 3, localSlots: 5, matchMinutes: 180, endgameMinutes: 20 },
    },
    models: [], runtime: { status: "ready", active: 0, queued: 0, concurrency: 1 },
    environments: { version: 1, profiles: [] }, challenges: [item],
  }
  const value: AppContextValue = {
    theme: "light", setTheme: noop, data, selected: "alpha", detail: null,
    filter: "", collapsed: new Set(), toasts: [], dialog: null, challengeEditor: null,
    menu: null, settingsOpen: false, setSettingsOpen: noop, sidebarOpen: false,
    setSidebarOpen: noop, deleteTarget: null, now: 0, notices: [], platform: null,
    unreadNoticeCount: 0, select: noop, setFilter: noop, toggleCollapsed: noop,
    refresh: async () => {}, refreshNotices: async () => {}, markNoticeRead: noop,
    loadDetail: async () => {}, toast: noop, openDialog: noop, openChallengeEditor: noop,
    closeDialog: noop, requestDelete: noop, setMenu: noop,
  }
  return renderToStaticMarkup(createElement(AppProvider, { value, children: createElement(Queue) }))
}

describe("CTF queue flag presentation", () => {
  test("does not present an unsolved or rejected-only run as having a flag", () => {
    for (const item of [challenge(), challenge(run({ stop: "timeout" })), challenge(run({
      primaryCandidate: "flag{wrong}", candidates: ["flag{wrong}"],
      rejectedFlags: ["flag{wrong}"], candidateHistory: ["flag{old}"],
    }))]) {
      expect(queueFlag(item, format)).toBeUndefined()
      expect(render(item)).not.toContain("ctf-flag-copy")
    }
  })

  test("shows a pending candidate with a separate copy button and full value", () => {
    const flag = `flag{${"long_value_".repeat(30)}}`
    const item = challenge(run({ primaryCandidate: flag }))
    expect(queueFlag(item, format)?.status).toBe("pending")
    const html = render(item)
    expect(html).toContain("has-flag flag-pending")
    expect(html).toContain("Flag 待验证")
    expect(html).toContain(`>${flag}</code>`)
    expect(html).toContain('aria-label="复制 alpha 的 Flag"')
    expect(html).toContain('aria-label="查看题目 alpha" aria-current="true"')
    expect(html).not.toContain('<article role="button"')
  })

  test("keeps confirmed results visible after a newer empty run", () => {
    const item = challenge(run({ confirmedFlag: "flag{confirmed}", taskStatus: "archived" }), run({ id: "new" }))
    expect(queueFlag(item, format)).toEqual({
      value: "flag{confirmed}", status: "confirmed", label: "Flag 已确认", historical: true,
    })
    expect(render(item)).toContain("flag-confirmed")
    expect(render(item)).toContain("历史任务")
  })

  test("distinguishes accepted, malformed, and historical candidates", () => {
    expect(queueFlag(challenge(run({ acceptedFlag: "flag{accepted}", taskStatus: "solved" })), format)?.status).toBe("confirmed")
    const malformed = challenge(run({ primaryCandidate: "not-a-flag" }))
    expect(queueFlag(malformed, format)?.status).toBe("mismatch")
    expect(render(malformed)).toContain("Flag 格式不符")
    const historical = challenge(run({ primaryCandidate: "flag{older}" }), run({ id: "new", stop: "running" }))
    expect(queueFlag(historical, format)?.historical).toBe(true)
    expect(render(historical)).toContain("运行中")
    expect(render(historical)).toContain("Flag 待验证")
  })

  test("does not promote rejected primary values over active alternatives", () => {
    const item = challenge(run({ primaryCandidate: "flag{wrong}", rejectedFlags: ["flag{wrong}"], alternatives: ["flag{next}"] }))
    expect(queueFlag(item, format)?.value).toBe("flag{next}")
    expect(render(item)).not.toContain("flag{wrong}")
  })
})
