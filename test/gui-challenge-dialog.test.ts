import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppProvider, type AppContextValue } from "../frontend/src/context.tsx"
import { ChallengeDialog } from "../frontend/src/challenge/ChallengeDialog.tsx"
import type { GuiState } from "../frontend/src/types.ts"

function state(): GuiState {
  return {
    root: "/tmp/boom-challenge-dialog",
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
    challenges: [{
      slug: "alpha",
      category: "CRYPTO",
      storagePath: "challenges/CRYPTO/alpha",
      difficulty: "hard",
      description: "# alpha\n\nRecover the key",
      files: [{ path: "cipher.txt", size: 2048, directory: false }],
      flagFormat: "flag\\{[^}]*\\}",
      remote: "http://127.0.0.1:9001",
      runs: [],
    }],
  }
}

function context(editor: AppContextValue["challengeEditor"]): AppContextValue {
  const noop = () => {}
  return {
    theme: "light",
    setTheme: noop,
    data: state(),
    selected: "alpha",
    detail: null,
    filter: "",
    collapsed: new Set(),
    toasts: [],
    dialog: "challenge",
    challengeEditor: editor,
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

function render(editor: AppContextValue["challengeEditor"]) {
  return renderToStaticMarkup(
    createElement(AppProvider, { value: context(editor), children: createElement(ChallengeDialog) }),
  )
}

describe("GUI challenge dialog rendering", () => {
  test("offers a blank draft with the directory it will create", () => {
    const html = render({ mode: "create" })
    expect(html).toContain("新建题目")
    expect(html).toContain("challenges/MISC/&lt;题目 ID&gt;/")
    expect(html).toContain("选择文件")
    expect(html).toContain("创建题目")
  })

  test("prefills one challenge's editable fields", () => {
    const html = render({ mode: "edit", slug: "alpha" })
    expect(html).toContain("编辑题目 · alpha")
    expect(html).toContain("challenges/CRYPTO/alpha")
    expect(html).toContain("Recover the key")
    // The field edits the prose; the README title line is Boom's bookkeeping, not prose.
    expect(html).not.toContain("# alpha")
    expect(html).toContain("cipher.txt")
    expect(html).toContain("http://127.0.0.1:9001")
    expect(html).toContain("保存修改")
    expect(html).not.toContain("创建题目")
  })
})
