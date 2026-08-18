import { createContext, useContext, type ReactNode } from "react"
import type { GuiState, RunHistory, XihulunjianNotice } from "./types"
import type { ToastItem } from "./ui"

export type DialogName =
  | "settings"
  | "providers"
  | "mcp"
  | "competition"
  | "notices"
  | "armor"
  | "delete"
  | null

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
  menu: MenuState
  deleteTarget: string | null
  now: number
  notices: XihulunjianNotice[]
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
