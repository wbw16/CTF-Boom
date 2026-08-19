import { useCallback, useEffect, useState } from "react"
import {
  Bell,
  FolderOpen,
  FolderPlus,
  Medal,
  Moon,
  Play,
  RefreshCw,
  Settings,
  Square,
  Sun,
  Trophy,
} from "lucide-react"
import { useApp } from "./context"
import { chooseDirectory } from "./bridge"
import { api, postJSON } from "./api"
import { CATEGORY_ORDER, latestFlagRun, primary } from "./state"
import type { CompetitionState, GuiState } from "./types"

type MatchOverview = { point: number; rank?: number }

export function TopBar() {
  const { data, unreadNoticeCount, toast, refresh, openDialog, theme, setTheme } = useApp()
  const [competition, setCompetition] = useState<CompetitionState | null>(null)
  const [overview, setOverview] = useState<MatchOverview | null>(null)

  // Poll the match clock so the countdown and slot usage stay honest without a full state refresh.
  useEffect(() => {
    let cancelled = false
    const read = () => {
      void api<CompetitionState>("/api/competition")
        .then((next) => {
          if (!cancelled) setCompetition(next.unavailable ? null : next)
        })
        .catch(() => {})
    }
    read()
    const timer = setInterval(read, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // Rankings change fast enough to be useful during a match, but do not require a high-frequency
  // poll that competes with challenge acquisition. The adapter serializes this with other platform calls.
  useEffect(() => {
    let cancelled = false
    const read = () => {
      void api<MatchOverview>("/api/xihulunjian/overview")
        .then((next) => {
          if (!cancelled) setOverview(next)
        })
        .catch(() => {})
    }
    read()
    const timer = setInterval(read, 20_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const pickRoot = useCallback(async () => {
    if (!data) return
    const root = await chooseDirectory({
      title: "选择包含 challenges/ 的 Boom 题库根目录",
      initial: data.root,
    })
    if (!root) return
    try {
      await postJSON<GuiState>("/api/root", { root })
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [data, refresh, toast])

  const addChallenge = useCallback(async () => {
    if (!data) return
    const source = await chooseDirectory({
      title: "选择要导入的题目目录",
      initial: data.root,
    })
    if (!source) return
    const parent = source.replaceAll("\\", "/").split("/").filter(Boolean).slice(-2, -1)[0]?.toUpperCase() ?? ""
    let category = (CATEGORY_ORDER as readonly string[]).includes(parent)
      ? parent
      : window.prompt(`题目分类（${CATEGORY_ORDER.join(" / ")}）`, "OTHER")
    if (category === null) return
    category = category.trim().toUpperCase()
    if (!(CATEGORY_ORDER as readonly string[]).includes(category)) {
      toast(`不支持的题目分类：${category}`, "error")
      return
    }
    try {
      const imported = await postJSON<{ slug: string; category: string }>("/api/challenges/import", {
        source,
        category,
      })
      toast(`题目已导入到 ${imported.category}`)
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [data, refresh, toast])

  const runAll = useCallback(async () => {
    if (!data) return
    try {
      const result = await postJSON<{ competition: CompetitionState }>("/api/competition/autopilot/start")
      setCompetition(result.competition)
      toast("比赛已开始：正在同步题目，并每 10 分钟自动检查新题")
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [data, refresh, toast])

  const halt = useCallback(async () => {
    try {
      if (data?.distributed?.role === "master" || data?.distributed?.role === "worker") {
        await postJSON("/api/distributed/stop")
        toast("分布式比赛会话已停止")
        await refresh()
        return
      }
      const result = await postJSON<{ stopped: number; competition: CompetitionState }>("/api/competition/autopilot/stop")
      setCompetition(result.competition)
      toast(`无人值守已停止，并已请求停止 ${result.stopped} 个运行`)
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [data?.distributed?.role, refresh, toast])

  const copyPending = useCallback(async () => {
    if (!data) return
    const challenges = data.challenges
    const pendingRows = challenges
      .map((challenge) => [challenge, latestFlagRun(challenge)] as const)
      .filter(
        ([challenge, run]) =>
          run && primary(run) && run.taskStatus !== "archived" && !run.confirmedFlag,
      )
    if (!pendingRows.length) {
      toast("还没有得到任何 flag")
      return
    }
    const text = pendingRows.map(([challenge, run]) => `${challenge.slug}\t${primary(run)}`).join("\n")
    try {
      await navigator.clipboard.writeText(text)
      toast(`已复制 ${pendingRows.length} 个 flag`)
    } catch {
      toast("复制失败，请手动选中", "error")
    }
  }, [data, toast])

  if (!data) return null
  const { runtime, challenges } = data
  const unattended = competition?.autopilot?.enabled === true
  const distributedActive = data.distributed?.role === "master" || data.distributed?.role === "worker"
  const busy = runtime.active > 0 || runtime.queued > 0 || unattended || distributedActive
  const pendingRows = challenges
    .map((challenge) => [challenge, latestFlagRun(challenge)] as const)
    .filter(
      ([challenge, run]) =>
        run && primary(run) && run.taskStatus !== "archived" && !run.confirmedFlag,
    )
  const workspaceName = data.root.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? data.root

  return (
    <header className="topbar">
      <nav className="global-nav" aria-label="全局导航">
        <span className="brand">
          <img src="/boom-icon.svg" width="26" height="26" alt="" />
          <span>Boom</span>
        </span>
        <button type="button" className="workspace-pill" onClick={pickRoot} title={data.root}>
          <FolderOpen size={13} />
          <span>{workspaceName}</span>
          <small>{challenges.length}</small>
        </button>
        <button
          type="button"
          className="icon-btn"
          title="重新扫描 challenges/"
          aria-label="重新扫描 challenges/"
          onClick={() => void refresh().then(() => toast(`已扫描 ${challenges.length} 题`))}
        >
          <RefreshCw size={14} />
        </button>
        <button type="button" className="icon-btn" onClick={addChallenge} title="导入题目" aria-label="导入题目">
          <FolderPlus size={14} />
        </button>
        <button
          type="button"
          className="competition-entry"
          onClick={() => openDialog("competition")}
          title="打开西湖论剑控制台"
        >
          <Trophy size={14} aria-hidden="true" />
          <span>西湖论剑控制台</span>
        </button>
        <button
          type="button"
          className="notice-entry"
          onClick={() => openDialog("notices")}
          title={unreadNoticeCount ? `通知公告（${unreadNoticeCount} 条未读，每 60 秒自动更新）` : "通知公告（已全部阅读）"}
          aria-label={unreadNoticeCount ? `查看通知公告，${unreadNoticeCount} 条未读` : "查看通知公告，已全部阅读"}
        >
          <Bell size={14} aria-hidden="true" />
          <span>公告</span>
          {unreadNoticeCount > 0 ? <b>{unreadNoticeCount}</b> : null}
        </button>
        <span
          className="rank-chip"
          title="西湖论剑实时排名，每 20 秒更新一次"
          aria-label={`实时排名：${overview?.rank ? `第 ${overview.rank} 名` : "暂未获取"}`}
        >
          <Medal size={14} aria-hidden="true" />
          <span>实时排名</span>
          <b>{overview?.rank ? `#${overview.rank}` : "—"}</b>
          {overview ? <small>{overview.point} 分</small> : null}
        </span>
        <span className="spacer" />
        <div className="run-summary">
          <span className="runtime-status-stack">
            <span className="runtime-status-row" title={runtime.error ?? runtime.status}>
            <i className={`status-dot${busy || runtime.status === "starting" ? " busy" : ""}${runtime.status === "error" ? " error" : ""}`} />
              <span>运行时</span>
              <b>{runtime.error ? "异常" : busy ? `运行中 ${runtime.active}/${runtime.concurrency}` : runtime.status}</b>
            </span>
            {competition ? (
              <span
                className="runtime-status-row"
                title={
                  competition.autopilot?.enabled
                    ? `${competition.autopilot.syncing ? "正在同步赛题" : "无人值守运行中"}｜线上容器 ${competition.usage.remote}/${competition.settings.remoteSlots}`
                    : "无人值守未启动"
                }
              >
              <RefreshCw size={12} className={competition.autopilot?.syncing ? "spin" : undefined} />
                <span>{competition.autopilot?.enabled ? competition.autopilot.syncing ? "正在同步" : "自动运行" : "自动待机"}</span>
                <small>容器 {competition.usage.remote}/{competition.settings.remoteSlots}</small>
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className={`pending-pill${pendingRows.length ? "" : " zero"}`}
            onClick={copyPending}
            title="复制全部待确认 flag"
          >
            <b>{pendingRows.length}</b>
            <span>待确认</span>
          </button>
        </div>
        {busy ? (
          <button type="button" className="btn btn-dark-utility" onClick={halt}>
            <Square size={12} /> 停止
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={runAll}>
            <Play size={12} /> 开始比赛
          </button>
        )}
        <button type="button" className="btn btn-dark-utility" onClick={() => openDialog("settings")} title="运行参数会独立保存">
          <Settings size={13} /> 设置
        </button>
        <button
          type="button"
          className="icon-btn theme-toggle"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          title={theme === "light" ? "切换到深色" : "切换到浅色"}
          aria-label={theme === "light" ? "切换到深色" : "切换到浅色"}
        >
          {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
        </button>
      </nav>
    </header>
  )
}
