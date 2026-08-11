import { useCallback, useEffect, useRef, useState } from "react"
import { AppProvider, type AppContextValue, type DialogName, type MenuState } from "./context"
import { api } from "./api"
import { setNativeAppearance } from "./bridge"
import { applyRunEvent, orderedChallenges } from "./state"
import type { GuiState, RunnerNotification, RunHistory } from "./types"
import { ToastStack, type ToastItem } from "./ui"
import { TopBar } from "./TopBar"
import { Queue } from "./Queue"
import { Detail } from "./Detail"
import { SettingsDialog } from "./settings/SettingsDialog"
import { ProvidersDialog } from "./providers/ProvidersDialog"
import { McpDialog } from "./mcp/McpDialog"
import { PlatformsDialog } from "./platforms/PlatformsDialog"
import { ArmorPromptsDialog } from "./armor/ArmorPromptsDialog"
import { DeleteDialog } from "./delete/DeleteDialog"

export default function App() {
  const [theme, setThemeState] = useState<"light" | "dark">(() =>
    localStorage.getItem("boom-theme") === "dark" ? "dark" : "light",
  )
  const [data, setData] = useState<GuiState | null>(null)
  const [selected, setSelected] = useState("")
  const [detail, setDetail] = useState<RunHistory | null>(null)
  const [filter, setFilter] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [dialog, setDialog] = useState<DialogName>(null)
  const [menu, setMenu] = useState<MenuState>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const toastID = useRef(0)
  const refreshTimer = useRef(0)
  const refreshInFlight = useRef(false)

  const setTheme = useCallback((next: "light" | "dark") => {
    setThemeState(next)
    document.documentElement.dataset.theme = next
    localStorage.setItem("boom-theme", next)
    setNativeAppearance(next)
  }, [])

  const toast = useCallback((message: string, kind?: "error" | "success") => {
    const id = ++toastID.current
    setToasts((current) => [...current.slice(-3), { id, message, kind }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id))
    }, 2600)
  }, [])

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    try {
      const next = await api<GuiState>("/api/state")
      setData(next)
      setSelected((current) => {
        if (current && next.challenges.some((challenge) => challenge.slug === current)) return current
        return next.challenges[0]?.slug ?? ""
      })
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      refreshInFlight.current = false
    }
  }, [toast])

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => void refresh(), 250)
  }, [refresh])

  const loadDetail = useCallback(
    async (slug?: string) => {
      const target = slug ?? selected
      if (!data || !target) {
        setDetail(null)
        return
      }
      const challenge = data.challenges.find((item) => item.slug === target)
      const run = challenge?.runs[challenge.runs.length - 1]
      if (!challenge || !run) {
        setDetail(null)
        return
      }
      try {
        const result = await api<{ run: RunHistory }>(
          `/api/challenges/${encodeURIComponent(challenge.slug)}/runs/${encodeURIComponent(run.id)}`,
        )
        setDetail(result.run)
      } catch (error) {
        setDetail(null)
      }
    },
    [data, selected],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const source = new EventSource("/api/events")
    source.addEventListener("state", (event) => {
      try {
        const update = JSON.parse((event as MessageEvent).data) as RunnerNotification
        if ((update.type === "run.error" || update.type === "runtime.error") && update.detail)
          toast(update.detail, "error")
        if (update.type === "run.candidate-submitted") {
          scheduleRefresh()
          return
        }
        if (update.type === "run.event" && update.slug && update.event) {
          setData((current) => (current ? applyRunEvent(current, update) : current))
          return
        }
      } catch {
        // Heartbeats and non-JSON packets are fine; the full refresh reconciles.
      }
      scheduleRefresh()
    })
    source.onerror = () => {
      setData((current) =>
        current
          ? { ...current, runtime: { ...current.runtime, status: "error", error: "reconnecting" } }
          : current,
      )
    }
    return () => source.close()
  }, [refresh, scheduleRefresh, toast])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    void loadDetail(selected)
    // Detail content only changes when the selected challenge or its run set changes; live run
    // events are merged into `data` directly and must not trigger a fresh detail fetch each event.
  }, [selected, data?.challenges.length])

  const select = useCallback(
    (slug: string) => {
      setSelected(slug)
      void loadDetail(slug)
    },
    [loadDetail],
  )

  const toggleCollapsed = useCallback((category: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }, [])

  const openDialog = useCallback((name: Exclude<DialogName, null>) => setDialog(name), [])
  const closeDialog = useCallback(() => setDialog(null), [])
  const requestDelete = useCallback((slug: string | null) => setDeleteTarget(slug), [])

  const move = useCallback(
    (offset: number) => {
      if (!data) return
      const ordered = orderedChallenges(data.challenges, data.settings.flagFormat)
      const index = ordered.findIndex((challenge) => challenge.slug === selected)
      const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + offset))]
      if (next) select(next.slug)
    },
    [data, select, selected],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialog) {
        if (event.key === "Escape") {
          if (!(event.target as HTMLElement).closest?.(".select")) setDialog(null)
        }
        return
      }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement).tagName)
      if (event.key === "Escape") {
        if (typing) (event.target as HTMLElement).blur()
        if (menu) setMenu(null)
        return
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault()
        move(1)
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault()
        move(-1)
      } else if (event.key === "c") {
        event.preventDefault()
        // copy current flag: use DOM to find the verdict text
        const verdict = document.querySelector(".vflag")
        if (verdict?.textContent && verdict.textContent !== "尚未运行")
          void navigator.clipboard.writeText(verdict.textContent).then(() => toast("flag 已复制"))
      } else if (event.key === "y") {
        event.preventDefault()
        // Copy pending flags: re-use the topbar behavior
        document.querySelector(".pending-pill")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      } else if (event.key === "r") {
        event.preventDefault()
        document.querySelector("[data-run-action]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      } else if (event.key === "/") {
        event.preventDefault()
        ;(document.querySelector(".queue-search input") as HTMLInputElement | null)?.focus()
      } else if (event.key === "m") {
        event.preventDefault()
        const challenge = data?.challenges.find((item) => item.slug === selected)
        if (challenge) setMenu({ slug: challenge.slug, x: 220, y: 180 })
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [data, dialog, menu, move, selected, toast])

  const value: AppContextValue = {
    theme,
    setTheme,
    data,
    selected,
    detail,
    filter,
    collapsed,
    toasts,
    dialog,
    menu,
    deleteTarget,
    now,
    select,
    setFilter,
    toggleCollapsed,
    refresh,
    loadDetail,
    toast,
    openDialog,
    closeDialog,
    requestDelete,
    setMenu,
  }

  return (
    <AppProvider value={value}>
      <div className="app">
        <TopBar />
        <div className="body">
          <Queue />
          <Detail />
        </div>
      </div>
      <ToastStack toasts={toasts} />
      {dialog === "settings" ? <SettingsDialog /> : null}
      {dialog === "providers" ? <ProvidersDialog /> : null}
      {dialog === "mcp" ? <McpDialog /> : null}
      {dialog === "platforms" ? <PlatformsDialog /> : null}
      {dialog === "armor" ? <ArmorPromptsDialog /> : null}
      {dialog === "delete" ? <DeleteDialog /> : null}
      {menu ? (
        <div
          className="menu-backdrop"
          style={{ position: "fixed", inset: 0, zIndex: 299 }}
          onPointerDown={() => setMenu(null)}
        />
      ) : null}
    </AppProvider>
  )
}
