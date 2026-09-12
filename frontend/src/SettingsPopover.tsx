import { useEffect, useRef } from "react"
import { ChevronRight, Database, Layers, Settings, Shield, Trophy } from "lucide-react"
import { useApp } from "./context"

/**
 * The quick run-config popover opened from the mode headers, where it drops from the header entry
 * it belongs to. It shows the effective agent/model/concurrency/environment at a glance and links
 * into the full dialogs; the rail opens the full settings dialog directly.
 */
export function SettingsPopover() {
  const { data, settingsOpen, setSettingsOpen, openDialog } = useApp()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!settingsOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setSettingsOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [settingsOpen, setSettingsOpen])

  if (!data || !settingsOpen) return null
  const pentest = data.settings.mode === "pentest"
  const defaultProfile = data.environments.profiles.find(
    (profile) => profile.id === data.environments.defaultProfileId,
  ) ?? data.environments.profiles[0]

  const entries: Array<{ icon: typeof Settings; label: string; dialog: Parameters<typeof openDialog>[0] }> = [
    { icon: Settings, label: "完整设置", dialog: "settings" },
    { icon: Database, label: "Provider 与模型", dialog: "providers" },
    { icon: Layers, label: "MCP Server", dialog: "mcp" },
    { icon: Shield, label: "破甲提示词", dialog: "armor" },
  ]
  if (!pentest) entries.push({ icon: Trophy, label: "比赛平台", dialog: "competition" })

  return (
    <aside className="settings-popover open" ref={rootRef} aria-label="当前运行配置">
      <h3>当前运行配置</h3>
      <div className="setting-row"><span>Agent</span><b>{pentest ? "boom-pentest" : "boom"}</b></div>
      <div className="setting-row"><span>主模型</span><b title={data.settings.strongModel}>{data.settings.strongModel}</b></div>
      <div className="setting-row"><span>并发上限</span><b>{data.settings.concurrency}</b></div>
      <div className="setting-row">
        <span>执行环境</span>
        <b title={defaultProfile?.displayName ?? "本机"}>
          {pentest ? "本机 · 自动选择" : defaultProfile?.displayName ?? "未绑定"}
        </b>
      </div>
      <div className="settings-actions">
        {entries.map(({ icon: Icon, label, dialog }) => (
          <button
            type="button"
            className="settings-entry"
            key={label}
            onClick={() => {
              setSettingsOpen(false)
              openDialog(dialog)
            }}
          >
            <Icon className="icon sm" />
            <span>{label}</span>
            <ChevronRight className="icon sm" />
          </button>
        ))}
      </div>
    </aside>
  )
}
