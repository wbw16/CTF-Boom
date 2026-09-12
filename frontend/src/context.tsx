import { createContext, useContext, type ReactNode } from "react"
import type { GuiState, PlatformNotice, PlatformSummary, RunHistory } from "./types"
import type { ToastItem } from "./ui"

export type DialogName =
  | "settings"
  | "challenge"
  | "providers"
  | "mcp"
  | "competition"
  | "notices"
  | "armor"
  | "delete"
  | null

/**
 * Challenge authoring target: a blank draft, or one existing challenge opened for editing. The
 * dialog itself reads the challenge from `data`, so a refresh never leaves it showing stale fields.
 */
export type ChallengeEditorState = { mode: "create" } | { mode: "edit"; slug: string } | null

export type MenuState = {
  slug: string
  x: number
  y: number
} | null

export type AppContextValue = {
  theme: "light" | "dark"
  setTheme: (theme: "light" | "dark") => void
  data: GuiState | null
  selected: string
  detail: RunHistory | null
  filter: string
  collapsed: Set<string>
  toasts: ToastItem[]
  dialog: DialogName
  challengeEditor: ChallengeEditorState
  menu: MenuState
  /** Quick run-config popover shared by the rail and the mode headers. */
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  /** Narrow-viewport drawer for the task sidebar (engagements or challenge queue). */
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  deleteTarget: string | null
  now: number
  notices: PlatformNotice[]
  /** Active competition platform summary; null until the registry is fetched. */
  platform: PlatformSummary | null
  unreadNoticeCount: number
  select: (slug: string) => void
  setFilter: (value: string) => void
  toggleCollapsed: (category: string) => void
  refresh: () => Promise<void>
  refreshNotices: () => Promise<void>
  markNoticeRead: (id: number) => void
  loadDetail: (slug?: string) => Promise<void>
  toast: (message: string, kind?: "error" | "success") => void
  openDialog: (name: Exclude<DialogName, null>) => void
  openChallengeEditor: (editor: Exclude<ChallengeEditorState, null>) => void
  closeDialog: () => void
  requestDelete: (slug: string | null) => void
  setMenu: (menu: MenuState) => void
}

export const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error("useApp must be used inside App")
  return value
}

export function AppProvider({ children, value }: { children: ReactNode; value: AppContextValue }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
