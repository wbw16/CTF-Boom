import { useCallback, useEffect, useState } from "react"
import { Timer } from "lucide-react"
import { useApp } from "../context"
import { api, patchJSON, postJSON, putJSON } from "../api"
import { Modal } from "../ui"
import type { CompetitionState, GuiState, PlatformSummary } from "../types"

const DEFAULT_HOST = "https://pro.dasctf.com"

/**
 * Competition control panel.
 *
 * Owns the three things an operator must set before a match: the platform endpoint, the AccessKey,
 * and the match clock. The AccessKey is write-only here — the server stores it outside the challenge
 * root and only ever reports whether it is configured, so this dialog can show status but never the
 * value.
 */
export function CompetitionDialog() {
  const { data, toast, refresh, closeDialog } = useApp()
  const [platforms, setPlatforms] = useState<PlatformSummary[]>([])
  const [state, setState] = useState<CompetitionState | null>(null)
  const [adapterID, setAdapterID] = useState("xihu")
  const [host, setHost] = useState(DEFAULT_HOST)
  const [accessKey, setAccessKey] = useState("")
  const [minutes, setMinutes] = useState(180)
  const [remoteSlots, setRemoteSlots] = useState(3)
  const [localSlots, setLocalSlots] = useState(5)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [listed, competition] = await Promise.all([
        api<{ platforms: PlatformSummary[] }>("/api/platforms"),
        api<CompetitionState>("/api/competition"),
      ])
      setPlatforms(listed.platforms)
      if (!competition.unavailable) {
        setState(competition)
        setRemoteSlots(competition.settings.remoteSlots)
        setLocalSlots(competition.settings.localSlots)
        setMinutes(competition.settings.matchMinutes)
      }
      const existing = listed.platforms.find((item) => item.profile === "xihulunjian-agent-v1")
      if (existing) setAdapterID(existing.id)
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  // Keep the countdown live while the dialog is open.
  useEffect(() => {
    if (!state?.clock.started) return
    const timer = setInterval(() => {
      void api<CompetitionState>("/api/competition")
        .then((next) => { if (!next.unavailable) setState(next) })
        .catch(() => {})
    }, 5_000)
    return () => clearInterval(timer)
  }, [state?.clock.started])

  const adapter = platforms.find((item) => item.id === adapterID)

  const createAdapter = async () => {
    if (!host.trim()) {
      toast("请填写 Server Host", "error")
      return
    }
    setBusy(true)
    try {
      await postJSON("/api/platforms/profile", {
        profile: "xihulunjian",
        id: adapterID.trim() || "xihu",
        baseURL: host.trim(),
        force: true,
      })
      toast("比赛平台适配器已就绪")
      await load()
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const saveKey = async () => {
    if (!adapter) {
      toast("请先创建适配器", "error")
      return
    }
    setBusy(true)
    try {
      await putJSON(`/api/platforms/${encodeURIComponent(adapter.id)}/credential`, {
        value: accessKey,
      })
      // Never keep the secret in component state once it is stored.
      setAccessKey("")
      toast(accessKey.trim() ? "AccessKey 已保存" : "AccessKey 已清除")
      await load()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const saveSlots = async () => {
    if (!data) return
    setBusy(true)
    try {
      const updated = await patchJSON<{ settings: GuiState["settings"] }>("/api/settings", {
        ...data.settings,
        competition: {
          ...data.settings.competition,
          remoteSlots,
          localSlots,
          matchMinutes: minutes,
        },
      })
      toast(`并发已保存：线上 ${updated.settings.competition.remoteSlots} / 本地 ${updated.settings.competition.localSlots}`)
      await load()
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const clock = async (action: "start" | "clear") => {
    setBusy(true)
    try {
      await postJSON("/api/competition/clock", { action, minutes })
      toast(action === "start" ? `比赛计时已开始：${minutes} 分钟` : "比赛计时已清除")
      await load()
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const sync = async () => {
    if (!adapter) return
    setBusy(true)
    try {
      const result = await postJSON<{ challenges: string[] }>(
        `/api/platforms/${encodeURIComponent(adapter.id)}/sync`,
        { selection: { all: true } },
      )
      toast(`已同步 ${result.challenges.length} 道题目`)
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="比赛控制台"
      subtitle="西湖论剑：平台接入、赛时计时与资源并发"
      icon={<Timer size={15} />}
      onClose={closeDialog}
      wide
    >
      <section className="field-group">
        <h3>平台接入</h3>
        <label className="field">
          <span>Server Host</span>
          <input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder={DEFAULT_HOST}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>适配器 ID</span>
          <input
            value={adapterID}
            onChange={(event) => setAdapterID(event.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void createAdapter()}>
            保存并创建适配器
          </button>
          {adapter ? <span className="hint">当前状态：{adapter.status}</span> : <span className="hint">尚未创建</span>}
        </div>

        <label className="field">
          <span>AccessKey</span>
          <input
            type="password"
            value={accessKey}
            onChange={(event) => setAccessKey(event.target.value)}
            placeholder={adapter?.credential?.configured ? "已配置（留空提交则清除）" : "ak_live_..."}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="row">
          <button type="button" className="btn" disabled={busy || !adapter} onClick={() => void saveKey()}>
            保存 AccessKey
          </button>
          <span className="hint">
            {adapter?.credential?.configured ? "凭证已配置" : "凭证未配置"}
            ：仅保存在本机（0600），不写入题库目录，也不会回显。
          </span>
        </div>
        <div className="row">
          <button type="button" className="btn" disabled={busy || !adapter?.credential?.configured} onClick={() => void sync()}>
            拉取题目列表
          </button>
          <span className="hint">比赛分批放题，开赛后需要多次拉取。</span>
        </div>
      </section>

      <section className="field-group">
        <h3>赛时计时</h3>
        <label className="field">
          <span>比赛总时长（分钟）</span>
          <input
            type="number"
            min={1}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value) || 0)}
          />
        </label>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void clock("start")}>
            开始计时
          </button>
          <button type="button" className="btn" disabled={busy || !state?.clock.started} onClick={() => void clock("clear")}>
            清除计时
          </button>
          <span className="hint">
            {state?.clock.started
              ? `剩余 ${formatRemaining(state.clock.remainingMs)}${state.clock.endgame ? "（收尾阶段：不再开新题）" : ""}`
              : "未开始：不会触发收尾与超时放弃"}
          </span>
        </div>
      </section>

      <section className="field-group">
        <h3>资源并发</h3>
        <label className="field">
          <span>线上环境上限</span>
          <input
            type="number"
            min={1}
            value={remoteSlots}
            onChange={(event) => setRemoteSlots(Number(event.target.value) || 1)}
          />
        </label>
        <label className="field">
          <span>本地并发上限</span>
          <input
            type="number"
            min={1}
            value={localSlots}
            onChange={(event) => setLocalSlots(Number(event.target.value) || 1)}
          />
        </label>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveSlots()}>
            保存并发设置
          </button>
          <span className="hint">
            线上环境上限由赛方规则决定（本场为 3），超过会被平台拒绝。
          </span>
        </div>
        {state ? (
          <div className="hint">
            当前占用：线上 {state.usage.remote}/{state.settings.remoteSlots} · 本地 {state.usage.local}/{state.settings.localSlots}
            {state.environments.leases.length
              ? `｜持有环境：${state.environments.leases.map((lease) => `${lease.slug}${lease.remote ? ` (${lease.remote})` : ""}`).join("、")}`
              : ""}
          </div>
        ) : null}
      </section>
    </Modal>
  )
}

export function formatRemaining(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`
}
