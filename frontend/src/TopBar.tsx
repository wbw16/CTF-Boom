import { useCallback } from "react"
import {
  FolderOpen,
  FolderPlus,
  Moon,
  Play,
  RefreshCw,
  Settings,
  Square,
  Sun,
} from "lucide-react"
import { useApp } from "./context"
import { chooseDirectory } from "./bridge"
import { postJSON } from "./api"
import { useActions } from "./actions"
import { CATEGORY_ORDER, latestFlagRun, primary, runnableChallenges } from "./state"
import type { GuiState } from "./types"

export function TopBar() {
  const { data, toast, refresh, openDialog, theme, setTheme } = useApp()
  const { runChallenges } = useActions()

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
    const challenges = data.challenges
    await runChallenges(runnableChallenges(challenges).map((challenge) => challenge.slug))
  }, [data, runChallenges])

  const halt = useCallback(async () => {
    try {
      const result = await postJSON<{ stopped: number }>("/api/runs/stop")
      toast(`已请求停止 ${result.stopped} 个运行`)
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [refresh, toast])

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
  const { settings, runtime, challenges } = data
  const busy = runtime.active > 0 || runtime.queued > 0
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
        <span className="spacer" />
        <span className="runtime-chip" title={runtime.error ?? runtime.status}>
          <i className={`status-dot${busy || runtime.status === "starting" ? " busy" : ""}${runtime.status === "error" ? " error" : ""}`} />
          {runtime.error ? "error" : busy ? `运行中 ${runtime.active}/${runtime.concurrency}` : runtime.status}
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
        {busy ? (
          <button type="button" className="btn btn-dark-utility" onClick={halt}>
            <Square size={12} /> 停止
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={runAll}>
            <Play size={12} /> 运行可做题
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
