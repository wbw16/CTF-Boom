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
import type { CompetitionState, DistributedSessionState, GuiSettings } from "../types"

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
  const [distributed, setDistributed] = useState<DistributedSessionState | null>(data?.distributed ?? null)
  const [accessKey, setAccessKey] = useState("")
  const [serverHost, setServerHost] = useState("")
  const [relayURL, setRelayURL] = useState("")
  const [joinToken, setJoinToken] = useState("")
  const [masterToken, setMasterToken] = useState("")
  const [distributedRole, setDistributedRole] = useState<"master" | "worker">("master")
  const [deviceName, setDeviceName] = useState("")
  const [workerSlots, setWorkerSlots] = useState(1)
  const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState(10)
  const [remoteSlots, setRemoteSlots] = useState(3)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [nextConnection, nextCompetition, nextDistributed] = await Promise.all([
        api<XihulunjianStatus>("/api/xihulunjian"),
        api<CompetitionState>("/api/competition"),
        api<DistributedSessionState>("/api/distributed"),
      ])
      setConnection(nextConnection)
      setServerHost(nextConnection.credential.serverHost)
      setDistributed(nextDistributed)
      if (nextDistributed.relayURL) setRelayURL(nextDistributed.relayURL)
      if (nextDistributed.device) {
        setDeviceName(nextDistributed.device.name)
        setWorkerSlots(nextDistributed.device.maxSlots)
      }
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
      void Promise.all([
        api<CompetitionState>("/api/competition"),
        api<DistributedSessionState>("/api/distributed"),
      ])
        .then(([next, session]) => {
          if (!next.unavailable) setCompetition(next)
          setDistributed(session)
        })
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
      const result = await postJSON<{ challenges: string[]; published?: number }>("/api/xihulunjian/sync", {})
      toast(`已同步 ${result.published ?? result.challenges.length} 道已开放赛题`)
      await refresh()
      await load()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const startDistributed = async () => {
    setBusy(true)
    try {
      const common = {
        relayURL,
        joinToken,
        deviceName: deviceName || undefined,
        maxSlots: workerSlots,
      }
      const session = distributedRole === "master"
        ? await postJSON<DistributedSessionState>("/api/distributed/master/start", {
            ...common,
            masterToken,
            maxRemoteSlots: remoteSlots,
          })
        : await postJSON<DistributedSessionState>("/api/distributed/worker/start", common)
      setDistributed(session)
      setJoinToken("")
      setMasterToken("")
      toast(distributedRole === "master" ? "主机已连接 Relay，并启动本机 master-worker" : "从机已加入比赛，正在领取题目")
      await refresh()
      await load()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const resumeDistributedWorker = async () => {
    setBusy(true)
    try {
      const session = await postJSON<DistributedSessionState>("/api/distributed/worker/resume", {})
      setDistributed(session)
      toast("已恢复从机，正在向 Relay 续租并领取任务")
      await refresh()
      await load()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setBusy(false)
    }
  }

  const stopDistributed = async () => {
    if (!window.confirm("停止该设备的分布式比赛会话？正在运行的本机 Relay 任务会停止；主机会同时尝试回收已申请的靶机。"))
      return
    setBusy(true)
    try {
      const session = await postJSON<DistributedSessionState>("/api/distributed/stop", {})
      setDistributed(session)
      toast("分布式比赛会话已停止")
      await refresh()
      await load()
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
  const session = distributed ?? data?.distributed
  const distributedActive = session?.role === "master" || session?.role === "worker"

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

        <section className="competition-card competition-distributed">
          <div className="competition-card-head">
            <span className="competition-card-icon"><Server size={16} /></span>
            <div><h3>分布式比赛会话</h3><p>同一个 Boom 以主机或从机身份，通过 Relay 协作解题</p></div>
            <span className={`competition-status${session?.status === "running" ? " ok" : ""}`}>
              {session?.status === "running" ? (session.role === "master" ? "主机运行中" : "从机运行中") : "未加入"}
            </span>
          </div>

          {distributedActive ? (
            <div className="distributed-live">
              <div className="competition-rule"><ShieldCheck size={14} />{session?.relayURL} · {session?.device?.name ?? session?.device?.id}</div>
              <dl className="distributed-metrics">
                <div><dt>本机任务</dt><dd>{session?.worker?.activeAssignments ?? 0}</dd></div>
                {session?.role === "master" && <>
                  <div><dt>待判 flag</dt><dd>{session.master?.pendingFlags ?? 0}</dd></div>
                  <div><dt>线上题</dt><dd>{session.master?.activeRemote ?? 0}</dd></div>
                  <div><dt>待写题解</dt><dd>{session.master?.pendingWriteups ?? 0}</dd></div>
                </>}
              </dl>
              {session?.worker?.assignmentSlugs.length ? <p className="competition-footnote">当前领取：{session.worker.assignmentSlugs.join("、")}</p> : <p className="competition-footnote">当前没有任务；Relay 会在下一次轮询时自动分配未领取的题目。</p>}
              {session?.lastError && <div className="competition-rule distributed-error"><CircleAlert size={14} />{session.lastError}</div>}
              <div className="competition-actions">
                {session?.role === "master" && <button type="button" className="btn btn-primary" disabled={busy || !remotelyConfigured} onClick={() => void sync()}><CloudDownload size={15} />同步并发布题目</button>}
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void stopDistributed()}><Power size={15} />停止会话</button>
              </div>
            </div>
          ) : (
            <>
              <div className="competition-role-switch" role="group" aria-label="分布式角色">
                <button type="button" className={`btn ${distributedRole === "master" ? "btn-primary" : ""}`} disabled={busy} onClick={() => setDistributedRole("master")}>作为主机</button>
                <button type="button" className={`btn ${distributedRole === "worker" ? "btn-primary" : ""}`} disabled={busy} onClick={() => setDistributedRole("worker")}>作为从机</button>
              </div>
              <div className="competition-form-grid">
                <label className="competition-field full"><span>Relay 服务地址</span><input className="input mono" type="url" value={relayURL} onChange={(event) => setRelayURL(event.target.value)} placeholder="https://relay.example.com" autoComplete="url" spellCheck={false} /></label>
                <label className="competition-field"><span>设备名称（可选）</span><input className="input" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} placeholder="MacBook-worker-1" autoComplete="off" /></label>
                <label className="competition-field"><span>本机解题并发</span><input className="input" type="number" min={1} max={5} value={workerSlots} onChange={(event) => setWorkerSlots(Number(event.target.value) || 1)} /></label>
              </div>
              <label className="competition-field"><span>比赛加入令牌</span><input className="input mono" type="password" value={joinToken} onChange={(event) => setJoinToken(event.target.value)} placeholder="由主机安全分享；仅用于换取本机设备令牌" autoComplete="off" spellCheck={false} /></label>
              {distributedRole === "master" && <>
                <label className="competition-field"><span>Relay 主控令牌</span><input className="input mono" type="password" value={masterToken} onChange={(event) => setMasterToken(event.target.value)} placeholder="仅主机持有，用于发布题目、申请靶机和统一提交" autoComplete="off" spellCheck={false} /></label>
                <div className="competition-rule"><CircleAlert size={14} />主机必须先在本机配置平台 AccessKey；从机不保存该凭据，也不会直接向比赛平台提交 flag。</div>
              </>}
              <div className="competition-actions">
                <button type="button" className="btn btn-primary" disabled={busy || !relayURL || !joinToken || (distributedRole === "master" && (!masterToken || !remotelyConfigured))} onClick={() => void startDistributed()}><Server size={15} />{distributedRole === "master" ? "启动主机" : "加入比赛"}</button>
                {distributedRole === "worker" && <button type="button" className="btn" disabled={busy} onClick={() => void resumeDistributedWorker()}><RefreshCw size={15} />恢复已加入从机</button>}
              </div>
              <p className="competition-footnote">Relay 是公网 HTTPS 服务。主机连接平台并统一提交；从机只领取题目、解题并回传结果。加入令牌不会保存在题目或工作区。</p>
            </>
          )}
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
