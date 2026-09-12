import { useCallback, useState } from "react"
import { FolderOpen, RefreshCw, Settings } from "lucide-react"
import { useApp } from "./context"
import { chooseDirectory } from "./bridge"
import { api, postJSON } from "./api"
import type { GuiState } from "./types"

/**
 * The workspace cluster shared by the pentest mission header and the CTF header:
 * switch the workspace root, rescan it, and open the run-settings popover.
 */
export function HeaderUtilities() {
  const { data, toast, refresh, setSettingsOpen, settingsOpen } = useApp()
  const [refreshing, setRefreshing] = useState(false)
  const mode = data?.settings.mode ?? "ctf"

  const pickRoot = useCallback(async () => {
    if (!data) return
    const root = await chooseDirectory({
      title: mode === "pentest"
        ? "选择渗透任务的工作区根目录"
        : "选择包含 challenges/ 的 Boom 题库根目录",
      initial: data.root,
    })
    if (!root) return
    try {
      await postJSON<GuiState>("/api/root", { root })
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [data, mode, refresh, toast])

  const rescan = useCallback(async () => {
    if (!data || refreshing) return
    setRefreshing(true)
    try {
      await api<GuiState>("/api/state", { signal: AbortSignal.timeout(8000) })
      await refresh()
      toast(mode === "pentest" ? "已重新扫描工作区" : `已扫描 ${data.challenges.length} 题`)
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setRefreshing(false)
    }
  }, [data, mode, refreshing, refresh, toast])

  if (!data) return null
  const workspaceName = data.root.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? data.root

  return (
    <div className="header-utilities" aria-label="工作区操作">
      <button
        type="button"
        className="secondary-button header-workspace"
        title={`切换工作区：${data.root}`}
        onClick={() => void pickRoot()}
      >
        <FolderOpen className="icon sm" />
        <span className="utility-label">{workspaceName}</span>
      </button>
      <button
        type="button"
        className="icon-button"
        data-refresh-button={mode}
        title={mode === "pentest" ? "重新扫描工作区" : "重新扫描 challenges/"}
        aria-label={mode === "pentest" ? "重新扫描工作区" : "重新扫描 challenges/"}
        disabled={refreshing}
        onClick={() => void rescan()}
      >
        <RefreshCw className={`icon${refreshing ? " spinner" : ""}`} />
      </button>
      <button
        type="button"
        className="secondary-button header-settings"
        title="打开运行设置"
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen(!settingsOpen)}
      >
        <Settings className="icon sm" />
        <span className="utility-label">设置</span>
      </button>
    </div>
  )
}
