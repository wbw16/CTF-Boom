import { useCallback, useEffect, useRef, useState } from "react"
import {
  AppProvider,
  type AppContextValue,
  type ChallengeEditorState,
  type DialogName,
  type MenuState,
} from "./context"
import { api } from "./api"
import { setNativeAppearance } from "./bridge"
import {
  applyRunEvent,
  applyRunEventToDetail,
  applyRunnerNotification,
  currentRun,
  mergeRunEventState,
  orderedChallenges,
  resolveRunDetail,
  type RunDetailSnapshot,
} from "./state"
import type { ChallengeGui, GuiState, PlatformNotice, PlatformRegistry, PlatformSummary, RunnerNotification, RunHistory } from "./types"
import { ToastStack, type ToastItem } from "./ui"
import { Rail } from "./Rail"
import { HeaderUtilities } from "./HeaderUtilities"
import { SettingsPopover } from "./SettingsPopover"
import { Queue } from "./Queue"
import { Detail } from "./Detail"
import { SettingsDialog } from "./settings/SettingsDialog"
import { ProvidersDialog } from "./providers/ProvidersDialog"
import { McpDialog } from "./mcp/McpDialog"
import { CompetitionDialog } from "./competition/CompetitionDialog"
import { PentestWorkspace } from "./pentest/PentestWorkspace"
import { NoticeDialog } from "./competition/NoticeDialog"
import { ArmorPromptsDialog } from "./armor/ArmorPromptsDialog"
import { DeleteDialog } from "./delete/DeleteDialog"
import { ChallengeDialog } from "./challenge/ChallengeDialog"

const REQUEST_TIMEOUT_MS = 10_000
const EVENT_REPLAY_LIMIT = 2_000
const READ_NOTICE_STORAGE_KEY = "boom-platform-read-notice-ids-v1"
const LEGACY_READ_NOTICE_STORAGE_KEY = "boom-xihulunjian-read-notice-ids-v1"
const MAX_REMEMBERED_NOTICE_IDS = 1_000

function loadReadNoticeIDs() {
  try {
    // Migrate the competition-era key on first read so previously read notices stay read.
    if (localStorage.getItem(READ_NOTICE_STORAGE_KEY) === null && localStorage.getItem(LEGACY_READ_NOTICE_STORAGE_KEY) !== null)
      localStorage.setItem(READ_NOTICE_STORAGE_KEY, localStorage.getItem(LEGACY_READ_NOTICE_STORAGE_KEY)!)
    const stored = JSON.parse(localStorage.getItem(READ_NOTICE_STORAGE_KEY) ?? "[]")
    if (!Array.isArray(stored)) return []
    return [...new Set(stored.filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
      .slice(-MAX_REMEMBERED_NOTICE_IDS)
  } catch {
    return []
  }
}

function detailRun(challenge: ChallengeGui, focused?: { slug: string; id: string } | null) {
  const confirmed = [...challenge.runs].reverse().find(
    (run) => run.taskStatus === "archived" || !!run.confirmedFlag,
  )
  const accepted = [...challenge.runs].reverse().find((run) => !!run.acceptedFlag)
  return (
    confirmed ??
    accepted ??
    [...challenge.runs].reverse().find((run) => run.stop === "running") ??
    [...challenge.runs].reverse().find((run) => run.stop === "queued") ??
    challenge.runs.find((run) => focused?.slug === challenge.slug && run.id === focused.id) ??
    currentRun(challenge)
  )
}

export default function App() {
  const [theme, setThemeState] = useState<"light" | "dark">(() =>
    localStorage.getItem("boom-theme") === "dark" ? "dark" : "light",
  )
  const [data, setData] = useState<GuiState | null>(null)
  const [selected, setSelected] = useState("")
  const [detailSnapshot, setDetailSnapshot] = useState<RunDetailSnapshot | null>(null)
  const [filter, setFilter] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [dialog, setDialog] = useState<DialogName>(null)
  const [challengeEditor, setChallengeEditor] = useState<ChallengeEditorState>(null)
  const [menu, setMenu] = useState<MenuState>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [notices, setNotices] = useState<PlatformNotice[]>([])
  const [platform, setPlatform] = useState<PlatformSummary | null>(null)
  const [readNoticeIDs, setReadNoticeIDs] = useState<number[]>(loadReadNoticeIDs)
  const toastID = useRef(0)
  const dataRef = useRef<GuiState | null>(null)
  const selectedRef = useRef("")
  const detailRef = useRef<RunDetailSnapshot | null>(null)
  const detailRequest = useRef(0)
  const detailAcceptedRequest = useRef(0)
  const detailSelectionEpoch = useRef(0)
  const focusedRun = useRef<{ slug: string; id: string } | null>(null)
  const notificationLog = useRef<RunnerNotification[]>([])
  const sseDisconnected = useRef(false)
  const detailDirty = useRef(true)
  const detailDirtyGeneration = useRef(0)
  const stateDirty = useRef(true)
  const stateDirtyGeneration = useRef(0)
  const detailRefreshTimer = useRef(0)
  const refreshTimer = useRef(0)
  const refreshInFlight = useRef<Promise<void> | null>(null)
  const refreshPending = useRef(false)
  const detail = resolveRunDetail(data, selected, detailSnapshot)

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

  const storeDetail = useCallback((next: RunDetailSnapshot | null) => {
    detailRef.current = next
    setDetailSnapshot(next)
  }, [])

  const loadDetail = useCallback(async (slug?: string) => {
    const dirtyGeneration = detailDirtyGeneration.current
    const target = slug ?? selectedRef.current
    const requestID = ++detailRequest.current
    const selectionEpoch = detailSelectionEpoch.current
    const snapshot = dataRef.current
    if (!snapshot || !target) {
      if (target === selectedRef.current) storeDetail(null)
      if (
        dirtyGeneration === detailDirtyGeneration.current
      ) detailDirty.current = false
      return
    }
    const challenge = snapshot.challenges.find((item) => item.slug === target)
    const run = challenge ? detailRun(challenge, focusedRun.current) : undefined
    if (!challenge || !run) {
      if (target === selectedRef.current) storeDetail(null)
      if (
        dirtyGeneration === detailDirtyGeneration.current
      ) detailDirty.current = false
      return
    }
    try {
      const result = await api<{ instanceID?: string; sequence?: number; root?: string; run: RunHistory }>(
        `/api/challenges/${encodeURIComponent(challenge.slug)}/runs/${encodeURIComponent(run.id)}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      )
      if (
        selectionEpoch !== detailSelectionEpoch.current ||
        selectedRef.current !== target ||
        requestID < detailAcceptedRequest.current
      ) return
      const latestChallenge = dataRef.current?.challenges.find((item) => item.slug === target)
      if (
        !latestChallenge ||
        detailRun(latestChallenge, focusedRun.current)?.id !== run.id ||
        (result.root !== undefined && result.root !== snapshot.root) ||
        (snapshot.instanceID && result.instanceID && snapshot.instanceID !== result.instanceID)
      ) return
      const current = detailRef.current
      const matchingCurrent = current?.slug === target && current.run.id === run.id
        ? current
        : undefined
      if (
        matchingCurrent?.instanceID === result.instanceID &&
        (matchingCurrent?.sequence ?? -1) > (result.sequence ?? -1)
      ) {
        if (
          dirtyGeneration === detailDirtyGeneration.current
        ) detailDirty.current = false
        return
      }
      let next: RunDetailSnapshot = {
        instanceID: result.instanceID,
        slug: target,
        sequence: result.sequence,
        run: mergeRunEventState(
          result.run,
          matchingCurrent?.run,
        ),
      }
      for (const update of notificationLog.current) {
        if (update.instanceID && result.instanceID && update.instanceID !== result.instanceID)
          continue
        if ((update.sequence ?? 0) <= (result.sequence ?? 0)) continue
        next = applyRunEventToDetail(next, update) ?? next
      }
      detailAcceptedRequest.current = requestID
      storeDetail(next)
      if (
        dirtyGeneration === detailDirtyGeneration.current
      ) detailDirty.current = false
    } catch {
      // A lifecycle refresh may race a queued ID becoming its durable run ID. The next SSE
      // notification retries with the authoritative state without blanking a visible snapshot.
    }
  }, [storeDetail])

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshPending.current = true
      await refreshInFlight.current
      return
    }
    const operation = (async () => {
      try {
        do {
          refreshPending.current = false
          const dirtyGeneration = stateDirtyGeneration.current
          try {
            const previousRoot = dataRef.current?.root
            let next = await api<GuiState>("/api/state", {
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
            const installedInstanceID = dataRef.current?.instanceID
            if (
              installedInstanceID &&
              next.instanceID &&
              installedInstanceID !== next.instanceID
            ) {
              notificationLog.current = notificationLog.current.filter(
                (update) => update.instanceID === next.instanceID,
              )
              detailSelectionEpoch.current += 1
              detailAcceptedRequest.current = 0
              focusedRun.current = null
              storeDetail(null)
            }
            const snapshotSequence = next.sequence ?? 0
            for (const update of notificationLog.current) {
              if (update.instanceID && next.instanceID && update.instanceID !== next.instanceID)
                continue
              if ((update.sequence ?? 0) <= snapshotSequence) continue
              next = applyRunEvent(next, update)
            }
            if (sseDisconnected.current)
              next = {
                ...next,
                runtime: { ...next.runtime, status: "error", error: "reconnecting" },
              }
            const installed = dataRef.current
            if (
              installed?.root === next.root &&
              installed.instanceID === next.instanceID &&
              (installed.sequence ?? -1) > (next.sequence ?? -1)
            ) {
              refreshPending.current = true
              continue
            }
            const current = selectedRef.current
            const previousSelectedChallenge = dataRef.current?.challenges.find(
              (challenge) => challenge.slug === current,
            )
            const target = current && next.challenges.some((challenge) => challenge.slug === current)
              ? current
              : next.challenges[0]?.slug ?? ""
            const resetDetail = target !== current || (previousRoot !== undefined && previousRoot !== next.root)
            dataRef.current = next
            setData(next)
            if (target !== current) {
              selectedRef.current = target
              setSelected(target)
            }
            if (resetDetail) {
              detailSelectionEpoch.current += 1
              detailAcceptedRequest.current = 0
              focusedRun.current = null
              storeDetail(null)
            }
            const targetChallenge = next.challenges.find((challenge) => challenge.slug === target)
            const resultTarget = targetChallenge
              ? [...targetChallenge.runs].reverse().find(
                  (run) => run.taskStatus === "archived" || !!run.confirmedFlag,
                ) ?? [...targetChallenge.runs].reverse().find((run) => !!run.acceptedFlag)
              : undefined
            const liveTarget = targetChallenge
              ? [...targetChallenge.runs].reverse().find((run) => run.stop === "running") ??
                [...targetChallenge.runs].reverse().find((run) => run.stop === "queued")
              : undefined
            const focusedStillExists = !!targetChallenge &&
              focusedRun.current?.slug === target &&
              targetChallenge.runs.some((run) => run.id === focusedRun.current?.id)
            const previousRunIDs = new Set(previousSelectedChallenge?.runs.map((run) => run.id) ?? [])
            const addedTarget = targetChallenge?.runs.findLast((run) => !previousRunIDs.has(run.id))
            if (resultTarget) focusedRun.current = { slug: target, id: resultTarget.id }
            else if (liveTarget) focusedRun.current = { slug: target, id: liveTarget.id }
            else if (addedTarget) focusedRun.current = { slug: target, id: addedTarget.id }
            else if (!focusedStillExists) {
              const targetRun = currentRun(targetChallenge)
              focusedRun.current = targetRun ? { slug: target, id: targetRun.id } : null
            }
            if (dirtyGeneration === stateDirtyGeneration.current) stateDirty.current = false
            detailDirty.current = true
            detailDirtyGeneration.current += 1
            void loadDetail(target)
          } catch (error) {
            toast((error as Error).message, "error")
          }
        } while (refreshPending.current)
      } finally {
        refreshInFlight.current = null
      }
    })()
    refreshInFlight.current = operation
    await operation
  }, [loadDetail, storeDetail, toast])

  const refreshNotices = useCallback(async () => {
    // Notices are a competition-platform surface; the pentest workspace stays quiet about them.
    if (dataRef.current?.settings.mode === "pentest") return
    try {
      const registry = await api<PlatformRegistry>("/api/platform", {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      setPlatform(registry.active)
      const result = await api<{ notices: PlatformNotice[] }>(`/api/platform/${registry.active.id}/notices`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      setNotices(result.notices)
    } catch {
      // A missing credential or a transient platform error should not produce a toast every minute.
      // Keep the most recently received list visible until a successful refresh replaces it.
    }
  }, [])

  const markNoticeRead = useCallback((id: number) => {
    setReadNoticeIDs((current) => {
      if (current.includes(id)) return current
      return [...current].slice(-MAX_REMEMBERED_NOTICE_IDS)
    })
  }, [])

  const readNoticeIDSet = new Set(readNoticeIDs)
  const unreadNoticeCount = notices.reduce(
    (count, notice) => count + (readNoticeIDSet.has(notice.id) ? 0 : 1),
    0,
  )

  const scheduleRefresh = useCallback(() => {
    stateDirty.current = true
    stateDirtyGeneration.current += 1
    if (refreshTimer.current) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = 0
      void refresh()
    }, 250)
  }, [refresh])

  const scheduleDetailRefresh = useCallback(() => {
    detailDirty.current = true
    detailDirtyGeneration.current += 1
    if (detailRefreshTimer.current) return
    detailRefreshTimer.current = window.setTimeout(() => {
      detailRefreshTimer.current = 0
      void loadDetail()
    }, 250)
  }, [loadDetail])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refreshNotices()
    const timer = window.setInterval(() => void refreshNotices(), 60_000)
    return () => window.clearInterval(timer)
  }, [refreshNotices])

  useEffect(() => {
    try {
      localStorage.setItem(READ_NOTICE_STORAGE_KEY, JSON.stringify(readNoticeIDs))
    } catch {
      // Reading still works for this session if browser storage is unavailable.
    }
  }, [readNoticeIDs])

  useEffect(() => {
    const source = new EventSource("/api/events")
    source.onopen = () => {
      if (!sseDisconnected.current) return
      sseDisconnected.current = false
      scheduleRefresh()
      scheduleDetailRefresh()
    }
    source.addEventListener("state", (event) => {
      let update: RunnerNotification
      try {
        update = JSON.parse((event as MessageEvent).data) as RunnerNotification
        if ((update.type === "run.error" || update.type === "runtime.error") && update.detail)
          toast(update.detail, "error")
      } catch {
        // Heartbeats and non-JSON packets are fine; the full refresh reconciles.
        scheduleRefresh()
        return
      }
      notificationLog.current.push(update)
      if (notificationLog.current.length > EVENT_REPLAY_LIMIT)
        notificationLog.current.splice(0, notificationLog.current.length - EVENT_REPLAY_LIMIT)
      const installedInstanceID = dataRef.current?.instanceID
      if (installedInstanceID && update.instanceID && installedInstanceID !== update.instanceID) {
        scheduleRefresh()
        return
      }
      const result = applyRunnerNotification(
        dataRef.current,
        detailRef.current,
        selectedRef.current,
        update,
      )
      if (result.data !== dataRef.current) {
        dataRef.current = result.data
        setData(result.data)
      }
      if (
        update.slug === selectedRef.current &&
        update.runID &&
        (update.type === "run.started" || update.type === "run.queued")
      ) focusedRun.current = { slug: update.slug, id: update.runID }
      if (result.detail !== detailRef.current) storeDetail(result.detail)
      if (result.revalidate === "detail") scheduleDetailRefresh()
      if (result.revalidate === "state") scheduleRefresh()
    })
    source.onerror = () => {
      sseDisconnected.current = true
      const current = dataRef.current
      if (current) {
        const next = { ...current, runtime: { ...current.runtime, status: "error" as const, error: "reconnecting" } }
        dataRef.current = next
        setData(next)
      }
      scheduleRefresh()
      scheduleDetailRefresh()
    }
    return () => source.close()
  }, [scheduleDetailRefresh, scheduleRefresh, storeDetail, toast])

  useEffect(() => {
    // Only CTF surfaces show wall-clock durations; pentest timestamps come from stored data,
    // so skip the per-second tick (and the full-tree re-render it causes) there.
    if (data?.settings.mode === "pentest") return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [data?.settings.mode])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      if (sseDisconnected.current || stateDirty.current) void refresh()
      if (sseDisconnected.current || detailDirty.current) void loadDetail()
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [loadDetail, refresh])

  useEffect(() => () => {
    window.clearTimeout(refreshTimer.current)
    window.clearTimeout(detailRefreshTimer.current)
    detailSelectionEpoch.current += 1
  }, [])

  const select = useCallback(
    (slug: string) => {
      const changed = selectedRef.current !== slug
      selectedRef.current = slug
      setSelected(slug)
      if (changed) {
        detailSelectionEpoch.current += 1
        detailAcceptedRequest.current = 0
        detailDirty.current = true
        detailDirtyGeneration.current += 1
        focusedRun.current = null
        storeDetail(null)
      } else {
        detailDirty.current = true
        detailDirtyGeneration.current += 1
      }
      void loadDetail(slug)
    },
    [loadDetail, storeDetail],
  )

  const toggleCollapsed = useCallback((category: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }, [])

  const openDialog = useCallback((name: Exclude<DialogName, null>) => {
    setChallengeEditor(null)
    setDialog(name)
  }, [])
  const openChallengeEditor = useCallback((editor: Exclude<ChallengeEditorState, null>) => {
    setChallengeEditor(editor)
    setDialog("challenge")
  }, [])
  const closeDialog = useCallback(() => {
    setDialog(null)
    setChallengeEditor(null)
  }, [])
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
        if (settingsOpen) setSettingsOpen(false)
        if (sidebarOpen) setSidebarOpen(false)
        return
      }
      // Queue shortcuts (j/k/c/y/r/m) are CTF-mode affordances; the pentest workspace has its own focus.
      if (data?.settings.mode === "pentest") return
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
        // Copy pending flags: re-use the header behavior
        document.querySelector(".pending-pill")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      } else if (event.key === "r") {
        event.preventDefault()
        document.querySelector("[data-run-action]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      } else if (event.key === "/") {
        event.preventDefault()
        ;(document.querySelector(".ctf-queue .search") as HTMLInputElement | null)?.focus()
      } else if (event.key === "m") {
        event.preventDefault()
        const challenge = data?.challenges.find((item) => item.slug === selected)
        if (challenge) setMenu({ slug: challenge.slug, x: 220, y: 180 })
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [data, dialog, menu, move, selected, settingsOpen, sidebarOpen, toast])

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
    challengeEditor,
    menu,
    settingsOpen,
    setSettingsOpen,
    sidebarOpen,
    setSidebarOpen,
    deleteTarget,
    now,
    notices,
    platform,
    unreadNoticeCount,
    select,
    setFilter,
    toggleCollapsed,
    refresh,
    refreshNotices,
    markNoticeRead,
    loadDetail,
    toast,
    openDialog,
    openChallengeEditor,
    closeDialog,
    requestDelete,
    setMenu,
  }

  const pentest = data?.settings.mode === "pentest"

  return (
    <AppProvider value={value}>
      <div className={`shell${sidebarOpen ? " drawer-open" : ""}`}>
        <Rail />
        {data ? (
          pentest ? (
            <PentestWorkspace />
          ) : (
            <>
              <Queue />
              <Detail />
            </>
          )
        ) : null}
      </div>
      <ToastStack toasts={toasts} />
      <SettingsPopover />
      {dialog === "settings" ? <SettingsDialog /> : null}
      {dialog === "providers" ? <ProvidersDialog /> : null}
      {dialog === "mcp" ? <McpDialog /> : null}
      {dialog === "competition" ? <CompetitionDialog /> : null}
      {dialog === "notices" ? <NoticeDialog /> : null}
      {dialog === "armor" ? <ArmorPromptsDialog /> : null}
      {dialog === "delete" ? <DeleteDialog /> : null}
      {dialog === "challenge" ? <ChallengeDialog /> : null}
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
