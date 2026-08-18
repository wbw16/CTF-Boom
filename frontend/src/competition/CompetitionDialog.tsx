import { useCallback, useEffect, useState } from "react"
import {
  CircleAlert,
  CloudDownload,
  Cpu,
  KeyRound,
  Power,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer,
} from "lucide-react"
import { useApp } from "../context"
import { api, patchJSON, postJSON, putJSON } from "../api"
import { Modal } from "../ui"
import type { CompetitionState, GuiSettings } from "../types"

type XihulunjianStatus = {
  credential: { configured: boolean; serverHost: string }
}

/**
 * The only competition screen in this build. Its API intentionally has no adapter IDs, manifests,
 * or OpenAPI parameters: all actions target the dedicated 西湖论剑 Agent API.
 */
export function CompetitionDialog() {
  const { data, toast, refresh, closeDialog, openDialog } = useApp()
  const [competition, setCompetition] = useState<CompetitionState | null>(null)
  const [connection, setConnection] = useState<XihulunjianStatus | null>(null)
  const [accessKey, setAccessKey] = useState("")
  const [serverHost, setServerHost] = useState("")
  const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState(10)
  const [remoteSlots, setRemoteSlots] = useState(3)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [nextConnection, nextCompetition] = await Promise.all([
        api<XihulunjianStatus>("/api/xihulunjian"),
        api<CompetitionState>("/api/competition"),
      ])
      setConnection(nextConnection)
      setServerHost(nextConnection.credential.serverHost)
      if (!nextCompetition.unavailable) {
        setCompetition(nextCompetition)
        setRefreshIntervalMinutes(nextCompetition.settings.refreshIntervalMinutes ?? 10)
        setRemoteSlots(nextCompetition.settings.remoteSlots)
      }
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api<CompetitionState>("/api/competition")
        .then((next) => { if (!next.unavailable) setCompetition(next) })
        .catch(() => {})
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const saveAccessKey = async () => {
    setBusy(true)
    try {
      await putJSON("/api/xihulunjian/credential", { value: accessKey })
      setAccessKey("")
      toast(accessKey.trim() ? "AccessKey 已安全保存" : "AccessKey 已清除")
      await load()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const saveServerHost = async () => {
    setBusy(true)
    try {
      const saved = await putJSON<{ serverHost: string }>("/api/xihulunjian/server-host", { value: serverHost })
      setServerHost(saved.serverHost)
      toast("西湖论剑 Server Host 已保存")
      await load()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const sync = async () => {
    setBusy(true)
    try {
      const result = await postJSON<{ challenges: string[] }>("/api/xihulunjian/sync", {})
      toast(`已同步 ${result.challenges.length} 道已开放赛题`)
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const saveCapacity = async () => {
    if (!data) return
    setBusy(true)
    try {
      const updated = await patchJSON<{ settings: GuiSettings }>("/api/settings", {
        ...data.settings,
        competition: {
          ...data.settings.competition,
          remoteSlots,
          refreshIntervalMinutes,
        },
      })
      toast(`自动化设置已保存：每 ${updated.settings.competition.refreshIntervalMinutes ?? 10} 分钟刷新一次`)
      await load()
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const closeAllEnvironments = async () => {
    if (!window.confirm("这会停止所有依赖靶机的任务、关闭当前全部靶机，并停止自动巡航。离线分析和 Writeup 不会受影响。是否继续？"))
      return
    setBusy(true)
    try {
      const result = await postJSON<{ closed: { released: number; stopped: number; errors: string[] } }>(
        "/api/competition/environments/close",
        {},
      )
      const { released, stopped, errors } = result.closed
      toast(
        errors.length === 0
          ? `已关闭 ${released} 个靶机，停止 ${stopped} 个远程任务`
          : `已请求关闭 ${released} 个靶机；${errors.length} 个回收请求失败`,
        errors.length === 0 ? "success" : "error",
      )
      await load()
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const activeEnvironments = competition?.environments.used ?? 0
  const remotelyConfigured = connection?.credential.configured ?? false
  const autopilot = competition?.autopilot

  return (
    <Modal
      title="西湖论剑控制台"
      subtitle="专用接入 · 自动拉题 · 赛方大模型网关"
      icon={<Timer size={17} />}
      onClose={closeDialog}
      wide
      className="competition-modal"
    >
      <div className="competition-overview" aria-label="比赛状态">
        <div className="competition-overview-main">
          <span className={`competition-live-dot${autopilot?.enabled ? " active" : ""}`} />
          <div>
            <b>{autopilot?.enabled ? "无人值守运行中" : "自动巡航待命"}</b>
            <small>{autopilot?.syncing ? "正在同步赛题…" : `主界面开始比赛后，每 ${refreshIntervalMinutes} 分钟检查新题`}</small>
          </div>
        </div>
        <dl className="competition-metrics">
          <div><dt>线上容器</dt><dd>{activeEnvironments}<span>/{competition?.settings.remoteSlots ?? remoteSlots}</span></dd></div>
          <div><dt>刷新间隔</dt><dd>{refreshIntervalMinutes}<span> 分钟</span></dd></div>
          <div><dt>平台凭证</dt><dd className={remotelyConfigured ? "ok" : "warn"}>{remotelyConfigured ? "已就绪" : "待配置"}</dd></div>
        </dl>
      </div>

      <div className="competition-grid">
        <section className="competition-card competition-connection">
          <div className="competition-card-head">
            <span className="competition-card-icon"><Server size={16} /></span>
            <div><h3>平台接入</h3><p>配置西湖论剑 Agent API 地址与 AccessKey</p></div>
          </div>
          <label className="competition-field">
            <span>Server Host</span>
            <input
              className="input mono"
              type="url"
              value={serverHost}
              onChange={(event) => setServerHost(event.target.value)}
              placeholder="https://pro.dasctf.com"
              autoComplete="url"
              spellCheck={false}
            />
          </label>
          <label className="competition-field">
            <span>AccessKey</span>
            <input
              className="input mono"
              type="password"
              value={accessKey}
              onChange={(event) => setAccessKey(event.target.value)}
              placeholder={remotelyConfigured ? "已配置；留空保存可清除" : "ak_live_..."}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p className="competition-note"><ShieldCheck size={14} /> 仅以 0600 权限保存在本机，不进入题目目录或运行工作区。</p>
          <div className="competition-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void saveServerHost()}><Server size={15} />保存地址</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void saveAccessKey()}><KeyRound size={15} />保存凭证</button>
            <button type="button" className="btn btn-primary" disabled={busy || !remotelyConfigured} onClick={() => void sync()}><CloudDownload size={15} />同步已开放题目</button>
          </div>
          <p className="competition-footnote">赛题会分批放出；每次放题后可再次同步，已有题目不会被覆盖。</p>
        </section>

        <section className="competition-card">
          <div className="competition-card-head">
            <span className="competition-card-icon"><RefreshCw size={16} /></span>
            <div><h3>自动同步与资源</h3><p>控制赛题发现频率与线上容器用量</p></div>
          </div>
          <div className="competition-form-grid">
            <label className="competition-field">
              <span>刷新赛题间隔（分钟）</span>
              <input className="input" type="number" min={1} max={60} value={refreshIntervalMinutes} onChange={(event) => setRefreshIntervalMinutes(Number(event.target.value) || 1)} />
            </label>
            <label className="competition-field">
              <span>线上容器并发上限</span>
              <input className="input" type="number" min={1} max={3} value={remoteSlots} onChange={(event) => setRemoteSlots(Number(event.target.value) || 1)} />
            </label>
          </div>
          <div className="competition-rule"><CircleAlert size={14} />线上容器最多 3 个；可按机器承载能力选择 1–3 个。</div>
          <div className="competition-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveCapacity()}>保存自动化设置</button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || (activeEnvironments === 0 && !autopilot?.enabled)}
              onClick={() => void closeAllEnvironments()}
            ><Power size={15} />关闭全部靶机</button>
          </div>
          <p className="competition-footnote">本地并发由“设置 → 运行参数”统一控制。关闭全部靶机会停止远程任务和自动巡航，但保留本地分析与离线 Writeup。</p>
        </section>

        <section className="competition-card competition-gateway">
          <div className="competition-card-head">
            <span className="competition-card-icon"><Cpu size={16} /></span>
            <div><h3>赛方大模型网关</h3><p>通过已有 Provider 转发全部 LLM 流量</p></div>
            <span className="competition-status">手动确认</span>
          </div>
          <div className="competition-rule"><CircleAlert size={14} />赛方地址本身就是完整接口；不要附加 <code>/v1</code> 或 <code>/chat/completions</code>。</div>
          <ol className="competition-steps">
            <li>打开 <b>Provider 与模型</b>，编辑你正在使用的 Provider（无需新建比赛专用 Provider）。</li>
            <li>将 Base URL 直接改为赛方网关地址；不要添加 <code>/v1</code>，Boom 会自动适配完整端点。</li>
            <li>保留该 Provider 的 API Key 与所需 Model ID，再将 Economy、Strong（以及启用时的 Vision）选择为对应模型。</li>
          </ol>
          <div className="competition-actions">
            <button type="button" className="btn btn-primary" onClick={() => openDialog("providers")}><Cpu size={15} />前往 Provider 与模型</button>
          </div>
          <p className="competition-footnote">Boom 会保持 SSE、tool_calls 与 usage 的原有处理链路；请在开赛前用一道题确认所有已启用模型都经赛方网关。</p>
        </section>
      </div>
    </Modal>
  )
}
