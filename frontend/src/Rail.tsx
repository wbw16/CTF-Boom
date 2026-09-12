import { useState } from "react"
import { Crosshair, LayoutGrid, Moon, Settings, Sun } from "lucide-react"
import { useApp } from "./context"
import { patchJSON } from "./api"

/** Left product rail: brand, the two product modes, theme, and the full settings entry. */
export function Rail() {
  const { data, theme, setTheme, toast, refresh, openDialog, setSettingsOpen } = useApp()
  const [switching, setSwitching] = useState(false)
  const mode = data?.settings.mode ?? "ctf"

  const switchMode = async (next: "ctf" | "pentest") => {
    if (switching || !data || data.settings.mode === next) return
    setSwitching(true)
    try {
      await patchJSON<{ settings: { mode: "ctf" | "pentest" } }>("/api/settings", { mode: next })
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setSwitching(false)
    }
  }

  return (
    <nav className="rail" aria-label="产品导航">
      <div aria-label="Boom" className="brand-mark">
        <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
          <path d="M3.9 6.6 9.8 12 3.9 17.4" stroke="currentColor" />
          <path
            d="M16.9 7.6Q17.6 11.3 21.3 12Q17.6 12.7 16.9 16.4Q16.2 12.7 12.5 12Q16.2 11.3 16.9 7.6Z"
            className="spark"
            stroke="none"
          />
        </svg>
      </div>
      <button
        type="button"
        className={`rail-button${mode === "ctf" ? " active" : ""}`}
        aria-pressed={mode === "ctf"}
        aria-label="CTF 模式"
        title="CTF 模式"
        disabled={switching}
        onClick={() => void switchMode("ctf")}
      >
        <LayoutGrid className="icon" />
        <span className="rail-label">CTF 模式</span>
      </button>
      <button
        type="button"
        className={`rail-button${mode === "pentest" ? " active" : ""}`}
        aria-pressed={mode === "pentest"}
        aria-label="渗透模式"
        title="渗透模式"
        disabled={switching}
        onClick={() => void switchMode("pentest")}
      >
        <Crosshair className="icon" />
        <span className="rail-label">渗透模式</span>
      </button>
      <span className="rail-spacer" />
      <button
        type="button"
        className="rail-button"
        aria-label="切换明暗"
        title="切换明暗"
        onClick={() => setTheme(theme === "light" ? "dark" : "light")}
      >
        {theme === "light" ? <Moon className="icon" /> : <Sun className="icon" />}
        <span className="rail-label">{theme === "light" ? "切换到深色" : "切换到浅色"}</span>
      </button>
      <button
        type="button"
        className="rail-button"
        aria-label="运行设置"
        title="运行设置"
        onClick={() => {
          // The rail sits far from the quick-config popover's pinned corner, so opening that panel
          // here reads as a detached window. Go straight to the full settings dialog, and close a
          // popover left open by the header entry so the two never stack.
          setSettingsOpen(false)
          openDialog("settings")
        }}
      >
        <Settings className="icon" />
        <span className="rail-label">运行设置</span>
      </button>
    </nav>
  )
}
