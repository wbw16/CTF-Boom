import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppProvider, type AppContextValue } from "../frontend/src/context.tsx"
import { Detail } from "../frontend/src/Detail.tsx"
import type { GuiState, RunHistory } from "../frontend/src/types.ts"

function run(overrides: Partial<RunHistory> = {}): RunHistory {
  return {
    id: "run-live",
    model: "test/model",
    stop: "running",
    tokens: 10,
    billableTokens: 10,
    cost: 0,
    candidates: ["flag{live}"],
    primaryCandidate: "flag{live}",
    alternatives: [],
    flagFormat: "flag\\{[^}]*\\}",
    reply: "",
    events: [],
    notes: "",
    files: [],
    ...overrides,
  }
}

function state(...runs: RunHistory[]): GuiState {
  return {
    root: "/tmp/boom-detail-render",
    settings: {
      economyModel: "test/model",
      strongModel: "test/model",
      tokens: 10_000,
      tokenBudgetEnabled: true,
      repeats: 3,
      minutes: 5,
      concurrency: 1,
      flagFormat: "flag\\{[^}]*\\}",
      executionMode: "managed",
      consultModels: [],
      blindReview: true,
      consultOnCompaction: true,
      network: "allow",
      competition: { remoteSlots: 3, localSlots: 5, matchMinutes: 180, endgameMinutes: 20 },
    },
    models: [{ id: "test/model", name: "Test", connected: true }],
    runtime: { status: "ready", active: 1, queued: 0, concurrency: 1 },
    environments: { version: 1, profiles: [] },
    challenges: [{
      slug: "alpha",
      category: "MISC",
      storagePath: "MISC/alpha",
      files: [],
      serviceRequired: true,
      runs,
    }],
  }
}

describe("GUI task detail rendering", () => {
  test("uses the live rich snapshot for activity, evidence, and results", () => {
    const summary = run({ notes: "", writeup: "", files: [], events: [] })
    const detail = run({
      notes: "proof from NOTES",
      writeup: "# Live writeup\n\nflag{live}",
      files: [{ path: "work/exploit.py", size: 42, directory: false }],
      events: [{ at: 100, type: "text", text: "live activity line" }],
    })
    const noop = () => {}
    const value: AppContextValue = {
      theme: "light",
      setTheme: noop,
      data: state(summary),
      selected: "alpha",
      detail,
      filter: "",
      collapsed: new Set(),
      toasts: [],
      dialog: null,
      menu: null,
      deleteTarget: null,
      now: 200,
      notices: [],
      unreadNoticeCount: 0,
      select: noop,
      setFilter: noop,
      toggleCollapsed: noop,
      refresh: async () => {},
      refreshNotices: async () => {},
      markNoticeRead: noop,
      loadDetail: async () => {},
      toast: noop,
      openDialog: noop,
      closeDialog: noop,
      requestDelete: noop,
      setMenu: noop,
    }

    const html = renderToStaticMarkup(
      createElement(AppProvider, { value, children: createElement(Detail) }),
    )
    expect(html).toContain("live activity line")
    expect(html).toContain("proof from NOTES")
    expect(html).toContain("exploit.py")
    expect(html).toContain("Live writeup")
    expect(html).toContain("flag{live}")
    expect(html.indexOf("service-endpoint")).toBeLessThan(html.indexOf("detail-flag"))
  })

  test("keeps a resumed historical run focused while it is live", () => {
    const resumedSummary = run({ id: "run-old", events: [] })
    const newerFinished = run({
      id: "run-newer",
      stop: "completed",
      events: [{ at: 90, type: "text", text: "unrelated newer task" }],
      notes: "",
    })
    const resumedDetail = run({
      id: "run-old",
      notes: "resumed proof",
      events: [{ at: 100, type: "text", text: "resumed live activity" }],
    })
    const noop = () => {}
    const value: AppContextValue = {
      theme: "light",
      setTheme: noop,
      data: state(resumedSummary, newerFinished),
      selected: "alpha",
      detail: resumedDetail,
      filter: "",
      collapsed: new Set(),
      toasts: [],
      dialog: null,
      menu: null,
      deleteTarget: null,
      now: 200,
      notices: [],
      unreadNoticeCount: 0,
      select: noop,
      setFilter: noop,
      toggleCollapsed: noop,
      refresh: async () => {},
      refreshNotices: async () => {},
      markNoticeRead: noop,
      loadDetail: async () => {},
      toast: noop,
      openDialog: noop,
      closeDialog: noop,
      requestDelete: noop,
      setMenu: noop,
    }

    const html = renderToStaticMarkup(
      createElement(AppProvider, { value, children: createElement(Detail) }),
    )
    expect(html).toContain("resumed live activity")
    expect(html).toContain("resumed proof")
    expect(html).not.toContain("unrelated newer task")
  })

  test("keeps a resumed historical run focused after it finishes", () => {
    const resumedSummary = run({ id: "run-old", stop: "completed", events: [] })
    const newerFinished = run({
      id: "run-newer",
      stop: "completed",
      events: [{ at: 90, type: "text", text: "unrelated newer task" }],
    })
    const resumedDetail = run({
      id: "run-old",
      stop: "completed",
      notes: "finished resumed proof",
      events: [{ at: 100, type: "text", text: "finished resumed activity" }],
    })
    const noop = () => {}
    const value: AppContextValue = {
      theme: "light", setTheme: noop, data: state(resumedSummary, newerFinished),
      selected: "alpha", detail: resumedDetail, filter: "", collapsed: new Set(),
      toasts: [], dialog: null, menu: null, deleteTarget: null, now: 200, notices: [], unreadNoticeCount: 0,
      select: noop, setFilter: noop, toggleCollapsed: noop,
      refresh: async () => {}, refreshNotices: async () => {}, markNoticeRead: noop, loadDetail: async () => {}, toast: noop,
      openDialog: noop, closeDialog: noop, requestDelete: noop, setMenu: noop,
    }

    const html = renderToStaticMarkup(
      createElement(AppProvider, { value, children: createElement(Detail) }),
    )
    expect(html).toContain("finished resumed activity")
    expect(html).toContain("finished resumed proof")
    expect(html).not.toContain("unrelated newer task")
  })
})
