import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppProvider, type AppContextValue } from "../frontend/src/context.tsx"
import { SettingsDialog } from "../frontend/src/settings/SettingsDialog.tsx"
import type { GuiState } from "../frontend/src/types.ts"

function state(): GuiState {
  return {
    root: "/tmp/boom-settings-workspace",
    defaultRoot: "/Users/operator/BoomProject",
    settings: {
      mode: "ctf",
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
    runtime: { status: "ready", active: 0, queued: 0, concurrency: 1 },
    environments: { version: 1, profiles: [] },
    challenges: [],
  }
}

function context(): AppContextValue {
  const noop = () => {}
  return {
    theme: "light",
    setTheme: noop,
    data: state(),
    selected: "",
    detail: null,
    filter: "",
    collapsed: new Set(),
    toasts: [],
    dialog: "settings",
    challengeEditor: null,
    menu: null,
    settingsOpen: false,
    setSettingsOpen: noop,
    sidebarOpen: false,
    setSidebarOpen: noop,
    deleteTarget: null,
    now: 1,
    notices: [],
    platform: null,
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
    openChallengeEditor: noop,
    closeDialog: noop,
    requestDelete: noop,
    setMenu: noop,
  }
}

/** Every section is rendered at once; a CSS class decides which one is visible. */
function render() {
  return renderToStaticMarkup(
    createElement(AppProvider, { value: context(), children: createElement(SettingsDialog) }),
  )
}

describe("GUI settings workspace panel", () => {
  test("edits the working directory and offers the built-in default", () => {
    const html = render()
    expect(html).toContain("工作目录")
    expect(html).toContain("默认工作目录")
    // The editable field starts on the folder in use, and the default stays one click away.
    expect(html).toContain('value="/tmp/boom-settings-workspace"')
    expect(html).toContain("/Users/operator/BoomProject")
    expect(html).toContain("切换到此目录")
    expect(html).toContain("打开工作目录")
  })

  test("offers a named backup and a guarded workspace reset", () => {
    const html = render()
    expect(html).toContain("备份工作区")
    expect(html).toContain("开始备份")
    expect(html).toContain("打开备份目录")
    // The reset stays behind its first click, and says what it will and will not delete.
    expect(html).toContain("清空工作区")
    expect(html).toContain("不可撤销")
    expect(html).not.toContain("确认清空")
  })
})
