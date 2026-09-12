import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Bell, Check, Copy, FileText, Flag as FlagIcon, Menu, MoreHorizontal, Play, Square, Trophy, X } from "lucide-react"
import { useApp } from "./context"
import { useActions } from "./actions"
import { api, patchJSON, postJSON } from "./api"
import { compactNumber, durationMs, eventStart, mmss, verificationText } from "./format"
import { renderMarkdown } from "./markdown"
import { HeaderUtilities } from "./HeaderUtilities"
import {
  alternatives,
  categoryOf,
  currentRun,
  displayFlagRun,
  flagEntries,
  flagHistoryStatus,
  formatMismatch,
  isLive,
  isUnconfirmedFlag,
  latestFlagRun,
  primary,
  withRunDetail,
} from "./state"
import type { ChallengeGui, CompetitionState, RunFile, RunHistory } from "./types"

const TABS = ["activity", "evidence", "results"] as const
type Tab = (typeof TABS)[number]

const TAB_LABELS: Record<Tab, string> = {
  activity: "活动",
  evidence: "证据",
  results: "结果",
}

type MatchOverview = { point: number; rank?: number }

function hms(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

/** CTF-mode main surface: the pinned competition strip, the challenge header, flag verdict, and the three panes. */
export function Detail() {
  const { data, selected, detail, now, toast, refresh, loadDetail, openDialog, openChallengeEditor, platform, unreadNoticeCount, setSidebarOpen } = useApp()
  const actions = useActions()
  const [tab, setTab] = useState<Tab>("activity")
  const [hint, setHint] = useState("")
  const [detailMenu, setDetailMenu] = useState(false)
  const summaryChallenge = data?.challenges.find((item) => item.slug === selected)
  const challenge = summaryChallenge ? withRunDetail(summaryChallenge, detail) : undefined
  const [remoteDraft, setRemoteDraft] = useState("")
  const [savingRemote, setSavingRemote] = useState(false)
  const [competition, setCompetition] = useState<CompetitionState | null>(null)
  const [overview, setOverview] = useState<MatchOverview | null>(null)
  useEffect(() => setDetailMenu(false), [selected])
  useEffect(() => setRemoteDraft(challenge?.remote ?? ""), [selected, challenge?.remote])

  // Match state (clock, autopilot) and platform ranking only matter in CTF mode.
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

  useEffect(() => {
    if (!platform?.id) return
    let cancelled = false
    const read = () => {
      void api<MatchOverview>(`/api/platform/${platform.id}/overview`)
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
  }, [platform?.id])

  useEffect(() => {
    if (!detailMenu) return
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailMenu(false)
    }
    document.addEventListener("keydown", close)
    return () => document.removeEventListener("keydown", close)
  }, [detailMenu])

  const runAll = useCallback(async () => {
    try {
      const result = await postJSON<{ competition: CompetitionState }>("/api/competition/autopilot/start")
      setCompetition(result.competition)
      toast("比赛已开始：正在同步题目，并每 10 分钟自动检查新题")
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [refresh, toast])

  const halt = useCallback(async () => {
    try {
      const result = await postJSON<{ stopped: number; competition: CompetitionState }>("/api/competition/autopilot/stop")
      setCompetition(result.competition)
      toast(`无人值守已停止，并已请求停止 ${result.stopped} 个运行`)
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }, [refresh, toast])

  // Pending flags span every challenge, so the count is global: it feeds the strip badge and
  // the copy-all action below.
  const pendingRows = useMemo(
    () =>
      (data?.challenges ?? [])
        .map((item) => [item, latestFlagRun(item)] as const)
        .filter(
          ([item, run]) =>
            run && primary(run) && run.taskStatus !== "archived" && !run.confirmedFlag,
        ),
    [data],
  )

  const copyPending = useCallback(async () => {
    if (!pendingRows.length) {
      toast("还没有得到任何 flag")
      return
    }
    const text = pendingRows.map(([item, run]) => `${item.slug}\t${primary(run)}`).join("\n")
    try {
      await navigator.clipboard.writeText(text)
      toast(`已复制 ${pendingRows.length} 个 flag`)
    } catch {
      toast("复制失败，请手动选中", "error")
    }
  }, [pendingRows, toast])

  // Two bars, two scopes: this one holds competition state and app-wide controls, the challenge
  // header below holds the selected challenge and its task actions. Competition state never
  // depends on the selected challenge, so the strip is pinned outside the scrolling detail area
  // and also renders in the no-challenge empty state below.
  const autopilotOn = competition?.autopilot?.enabled === true
  const matchStrip = (
    <header className="match-strip" aria-label="赛事与全局操作">
      <button type="button" className="icon-button mobile-only" aria-label="打开题目队列" onClick={() => setSidebarOpen(true)}>
        <Menu className="icon" />
      </button>
      <span className="match-identity">
        <Trophy className="icon lg" />
        <span className="match-name">{platform?.displayName ?? "比赛平台"}</span>
        <span className={`match-live${autopilotOn ? "" : " paused"}`}>
          <i className={`state-dot ${autopilotOn ? "running" : "paused"}`} />
          {competition
            ? autopilotOn
              ? competition.autopilot?.syncing ? "正在同步赛题" : "无人值守运行中"
              : "自动巡航已停止"
            : "未接入"}
        </span>
      </span>
      <span className="match-tail">
        {competition?.clock?.started ? (
          <span className="match-metric match-clock" title="比赛剩余时间">
            <b>{competition.clock.over ? "已结束" : hms(competition.clock.remainingMs)}</b>
          </span>
        ) : null}
        <span className="match-metric match-rank">排名 <b>{overview?.rank ? `#${overview.rank}` : "—"}</b></span>
        {overview ? <span className="match-metric match-points">积分 <b>{overview.point}</b></span> : null}
        {competition ? (
          <span className="match-metric match-containers">
            容器 <b>{competition.usage.remote}/{competition.settings.remoteSlots}</b>
          </span>
        ) : null}
        <button
          type="button"
          className={`pending-pill${pendingRows.length ? "" : " zero"}`}
          onClick={() => void copyPending()}
          title="复制全部待确认 flag"
        >
          <Copy className="icon sm" />
          <b>{pendingRows.length}</b>
          <span>待确认</span>
        </button>
        <span className="match-actions">
          <button type="button" className="quiet-button" onClick={() => openDialog("competition")} title="打开比赛平台控制台">
            <Trophy className="icon sm" /> 比赛控制台
          </button>
          <button
            type="button"
            className="quiet-button"
            onClick={() => openDialog("notices")}
            title={unreadNoticeCount ? `通知公告（${unreadNoticeCount} 条未读，每 60 秒自动更新）` : "通知公告（已全部阅读）"}
          >
            <Bell className="icon sm" /> 公告 {unreadNoticeCount > 0 ? <span className="notice-count">{unreadNoticeCount}</span> : null}
          </button>
          {autopilotOn ? (
            <button type="button" className="quiet-button danger" onClick={() => void halt()}>
              <Square className="icon sm" /> <span>停止比赛</span>
            </button>
          ) : (
            <button type="button" className="quiet-button" onClick={() => void runAll()}>
              <Play className="icon sm" /> <span>开始比赛</span>
            </button>
          )}
        </span>
        {/* Workspace utilities close the row: the quick-config popover drops from this corner. */}
        <HeaderUtilities />
      </span>
    </header>
  )

  if (!data) return null
  if (!challenge) {
    return (
      <main className="ctf-main">
        {matchStrip}
        <div className="empty" style={{ margin: "auto" }}>没有题目</div>
      </main>
    )
  }
  const run = detail
    ? challenge.runs.find((item) => item.id === detail.id) ?? currentRun(challenge)
    : currentRun(challenge)
  const live = isLive(run)
  const settings = data.settings
  const flagRun = displayFlagRun(challenge, run)
  const flag = primary(flagRun)
  const mismatch = flag && formatMismatch(flagRun, flag, settings.flagFormat)
  const archived = flagRun?.taskStatus === "archived" || !!flagRun?.confirmedFlag
  const accepted = flagRun?.taskStatus === "solved" || !!flagRun?.acceptedFlag || archived
  const pendingCandidate = !!flag && !mismatch && !accepted && !live
  const primaryKind = live
    ? "stop"
    : pendingCandidate
      ? "confirm"
      : accepted && !archived
        ? "writeup"
        : "run"

  const rerun = async () => {
    await actions.runChallenges([challenge.slug], { hint, runID: run?.id, settings })
    setHint("")
  }

  const saveRemote = async (value = remoteDraft) => {
    const remote = value.trim()
    setSavingRemote(true)
    try {
      await patchJSON(`/api/challenges/${encodeURIComponent(challenge.slug)}`, {
        remote: remote || null,
      })
      setRemoteDraft(remote)
      await refresh()
      toast(remote ? "服务地址已保存，下次继续会进行远程操作" : "服务地址已清除；下次仅进行本地分析，之后等待重新填写", "success")
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setSavingRemote(false)
    }
  }

  const fixFormat = () => {
    const match = /^([A-Za-z0-9_.-]{1,32})\{.*\}$/s.exec(flag)
    // The settings dialog is the only place to persist the format; this surfaces it for review.
    toast(match ? `建议格式：${match[1]}\\{[^}]*\\}` : "无法从当前 flag 推断格式")
    openDialog("settings")
  }

  const raiseBudget = async () => {
    const tokens = settings.tokens * 2
    try {
      // Settings are updated through PATCH.  Using POST made this recovery action fail with a
      // misleading 404 before the run could be queued.
      await patchJSON("/api/settings", { ...settings, tokens, tokenBudgetEnabled: true })
      const queued = await actions.runChallenges([challenge.slug], { hint, runID: run?.id })
      if (queued) toast("已提高上限并继续")
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const runPrimaryAction = async () => {
    if (primaryKind === "stop") await actions.stopRun(challenge.slug)
    if (primaryKind === "confirm" && flagRun)
      await actions.reviewFlag(challenge.slug, flagRun, flag, true, hint)
    if (primaryKind === "writeup" && flagRun) await actions.writeupRun(challenge.slug, flagRun.id)
    if (primaryKind === "run") await rerun()
  }

  const primaryContent =
    primaryKind === "stop" ? (
      <><Square className="icon sm" /> <span className="button-label">停止本题</span></>
    ) : primaryKind === "confirm" ? (
      <><Check className="icon sm" /> <span className="button-label">确认 Flag</span></>
    ) : primaryKind === "writeup" ? (
      <><FileText className="icon sm" /> <span className="button-label">生成 Writeup</span></>
    ) : (
      <><Play className="icon sm" /> <span className="button-label">{run ? "继续任务" : "开始任务"}</span></>
    )

  const verdictAction = async (action: "copy" | "wrong") => {
    if (action === "copy") {
      try {
        await navigator.clipboard.writeText(flag)
        toast("flag 已复制")
      } catch {
        toast("复制失败，请手动选中", "error")
      }
    }
    if (action === "wrong" && flagRun)
      await actions.reviewFlag(challenge.slug, flagRun, flag, false, hint)
  }

  const runStateText = live
    ? run!.stop === "queued"
      ? "排队中"
      : "运行中"
    : pendingCandidate
      ? "等待人工确认"
      : archived
        ? "已归档"
        : accepted
          ? "已解出"
          : run
            ? "等待继续"
            : "等待运行"
  const verdictClass = pendingCandidate
    ? ""
    : accepted
      ? " confirmed"
      : mismatch
        ? " mismatch"
        : " running"
  const verdictStatus = pendingCandidate
    ? "候选 Flag · 等待确认"
    : accepted
      ? archived ? "Flag 已确认 · 已归档" : "Flag 已确认"
      : mismatch
        ? "候选 flag 不符合格式"
        : live
          ? "Boom 正在解题"
          : run
            ? "本次运行未得到 flag"
            : "尚未开始"
  const verdictValue = flag
    ? flag
    : live
      ? "正在分析附件与远程服务…"
      : run
        ? "本次运行未得到 flag"
        : "开始后，运行活动会显示在下方"
  const defaultEnvironment = data.environments.profiles.find(
    (profile) => profile.id === data.environments.defaultProfileId,
  ) ?? data.environments.profiles[0]

  return (
    <main className="ctf-main">
      {matchStrip}

      <header className="ctf-header" aria-label="当前题目">
        <div className="ctf-title">
          <div className="ctf-title-row">
            <h2>{challenge.slug}</h2>
            <span className="tag blue">
              {categoryOf(challenge)}{challenge.difficulty ? ` · ${challenge.difficulty}` : ""}
            </span>
          </div>
          <p>
            {challenge.files.length} 个附件 · 独立任务 {challenge.runs.length}
            {run?.turns?.length ? ` · 已完成 ${run.turns.length} 轮` : run ? " · 进行中" : " · 未开始"}
          </p>
        </div>
        <div className="ctf-header-metrics">
          <span><b>{compactNumber(run?.tokens ?? 0)}</b> tokens</span>
          <span><b>{run ? mmss(durationMs(run, now)) : "00:00"}</b></span>
          <span><b>${(run?.cost ?? 0).toFixed(4)}</b></span>
        </div>
        {primaryKind === "run" ? (
          <input
            className="hint-input"
            placeholder="给 Boom 一条提示（可选）"
            value={hint}
            onChange={(event) => setHint(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void rerun()
              }
            }}
          />
        ) : null}
        <button
          type="button"
          className={`primary-button${primaryKind === "stop" ? " pause" : ""}`}
          data-run-action={primaryKind === "run" ? "true" : undefined}
          onClick={() => void runPrimaryAction()}
        >
          {primaryContent}
        </button>
        <div className={`detail-menu-wrap${detailMenu ? " open" : ""}`}>
          <button
            type="button"
            className="icon-button"
            aria-label="更多任务操作"
            aria-expanded={detailMenu}
            onClick={() => setDetailMenu((current) => !current)}
          >
            <MoreHorizontal className="icon" />
          </button>
          {detailMenu ? (
            <div className="context-menu detail-menu">
              {primaryKind !== "run" && !live ? (
                <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void rerun() }}>
                  <Play className="icon sm" /> 继续当前任务
                </button>
              ) : null}
              {flag ? (
                <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void verdictAction("copy") }}>
                  <Copy className="icon sm" /> 复制 Flag
                </button>
              ) : null}
              {pendingCandidate ? (
                <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void verdictAction("wrong") }}>
                  <X className="icon sm" /> 否定候选
                </button>
              ) : null}
              <div className="menu-sep" />
              <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); openChallengeEditor({ mode: "edit", slug: challenge.slug }) }}>
                ✎ 编辑题面 / 附件 / 答案
              </button>
              <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void actions.startConsultation(challenge.slug, settings, run?.id) }}>
                ⚖ 发起会诊
              </button>
              {run && !live ? (
                <>
                  <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void switchEnvironment(challenge, run, settings, actions.switchTaskEnvironment, data) }}>
                    切换运行环境
                  </button>
                  <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void openTaskDirectory(challenge, run) }}>
                    打开任务目录
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <div className="ctf-main-scroll">
        {challenge.serviceRequired ? (
          <form
            className="service-endpoint"
            onSubmit={(event) => {
              event.preventDefault()
              void saveRemote()
            }}
          >
            <label htmlFor="challenge-service-remote">服务地址</label>
            <input
              id="challenge-service-remote"
              className="service-endpoint-input"
              placeholder="https://target.example 或 host:port（可选）"
              value={remoteDraft}
              disabled={savingRemote}
              onChange={(event) => setRemoteDraft(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-tiny"
              disabled={savingRemote || remoteDraft.trim() === (challenge.remote ?? "").trim()}
            >
              {savingRemote ? "保存中…" : "保存地址"}
            </button>
            {(challenge.remote ?? "").trim() ? (
              <button
                type="button"
                className="btn btn-tiny"
                disabled={savingRemote}
                onClick={() => void saveRemote("")}
              >
                清除
              </button>
            ) : null}
            <span className="service-endpoint-help">
              {challenge.remote?.trim()
                ? "已填写服务地址，继续任务时会进行远程操作。"
                : "首次运行会先完成本地分析；之后需要填写地址才能继续。"}
            </span>
          </form>
        ) : null}

        <Alerts
          challenge={challenge}
          run={run}
          flag={flag}
          mismatch={!!mismatch}
          flagFormat={settings.flagFormat}
          onFixFormat={fixFormat}
          onRaiseBudget={() => void raiseBudget()}
        />

        <div className="ctf-summary-grid">
          <section className={`flag-verdict${verdictClass}`} aria-label="Flag 判定">
            <span className="flag-verdict-icon">
              <FlagIcon className="icon lg" />
            </span>
            <span className="flag-verdict-copy">
              <span>{verdictStatus}</span>
              <code className="vflag">{verdictValue}</code>
              <SourceNotes
                run={run}
                flagRun={flagRun}
                flag={flag}
                archived={archived}
                accepted={accepted}
                onCopyAlternative={(value) =>
                  void navigator.clipboard.writeText(value).then(
                    () => toast("已复制备选串"),
                    () => toast("复制失败，请手动选中", "error"),
                  )
                }
              />
            </span>
            {flag ? (
              <span className="flag-verdict-actions">
                <button type="button" className="secondary-button" title="复制 Flag" onClick={() => void verdictAction("copy")}>
                  <Copy className="icon sm" /> 复制
                </button>
                {!accepted ? (
                  <button type="button" className="quiet-button danger" onClick={() => void verdictAction("wrong")}>
                    否定
                  </button>
                ) : null}
              </span>
            ) : null}
          </section>
          <section className="run-facts" aria-label="运行摘要">
            <div className="run-fact"><span>状态</span><b>{runStateText}</b></div>
            <div className="run-fact"><span>主模型</span><b title={run?.model}>{run?.model ?? settings.strongModel}</b></div>
            <div className="run-fact">
              <span>运行环境</span>
              <b title={run?.environment?.displayName ?? defaultEnvironment?.displayName}>
                {run?.environment?.displayName ?? defaultEnvironment?.displayName ?? "未绑定"}
              </b>
            </div>
            <div className="run-fact"><span>Flag 格式</span><b>{settings.flagFormat || "未设置"}</b></div>
          </section>
        </div>

        <div className="ctf-tabs" role="tablist" aria-label="题目视图">
          {TABS.map((name) => (
            <button
              type="button"
              key={name}
              role="tab"
              aria-selected={tab === name}
              className={`ctf-tab${tab === name ? " active" : ""}`}
              onClick={() => setTab(name)}
            >
              {TAB_LABELS[name]}
            </button>
          ))}
          <span className="spacer" />
          <span className="muted" style={{ fontSize: 12 }}>任务记录已保存</span>
        </div>

        <div className={`ctf-pane${tab === "activity" ? " active" : ""}`}>
          <div className="ctf-activity-layout">
            <section className="panel">
              <header className="panel-head">
                <h3>运行活动</h3>
                <span className="meta">最近事件优先 · 完整日志保留</span>
              </header>
              <EventList run={run} />
            </section>
            <aside className="panel">
              <header className="panel-head">
                <h3>检查点与会诊</h3>
                <span className="meta">{run?.turns?.length ? `第 ${run.turns.length} 轮` : "—"}</span>
              </header>
              <ConsultationPane run={run} />
            </aside>
          </div>
        </div>
        <div className={`ctf-pane${tab === "evidence" ? " active" : ""}`}>
          <div className="evidence-grid">
            <section className="panel">
              <header className="panel-head">
                <h3>NOTES.md</h3>
                <span className="meta">自动保存</span>
              </header>
              <MarkdownPane text={run?.notes} fallback="（尚无 NOTES.md 内容）" />
            </section>
            <section className="panel">
              <header className="panel-head">
                <h3>附件与产物</h3>
                <span className="meta">{run?.files?.length ?? challenge.files.length} 个文件</span>
              </header>
              <FilesPane run={run} challenge={challenge} />
            </section>
          </div>
        </div>
        <div className={`ctf-pane${tab === "results" ? " active" : ""}`}>
          <div className="results-grid">
            <section className="panel">
              <header className="panel-head">
                <h3>Flag 记录</h3>
                <span className="meta">完整候选历史</span>
              </header>
              <FlagsPane challenge={challenge} run={run} />
            </section>
            <section className="panel">
              <header className="panel-head">
                <h3>Writeup</h3>
                <span className="meta">{flagRun?.writeup ? "已生成" : "待生成"}</span>
              </header>
              {flag && flagRun?.writeup ? (
                <div className="writeup-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(flagRun.writeup) }} />
              ) : (
                <div className="writeup-preview">
                  <h3>确认 Flag 后生成</h3>
                  <p>Boom 将基于已保存的 NOTES、命令、脚本和 Flag 证据整理完整解题过程。</p>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!accepted}
                    style={{ width: "100%", marginTop: 9 }}
                    onClick={() => flagRun && void actions.writeupRun(challenge.slug, flagRun.id)}
                  >
                    生成 Writeup
                  </button>
                </div>
              )}
              <details className="result-meta">
                <summary>运行元数据</summary>
                <MetaPane run={flagRun ?? run} flag={flag} flagRun={flagRun} now={now} />
              </details>
            </section>
          </div>
        </div>
      </div>
      {detailMenu ? <div className="detail-menu-backdrop" onPointerDown={() => setDetailMenu(false)} /> : null}
    </main>
  )
}

function EventList({ run }: { run?: RunHistory }) {
  if (!run?.events?.length)
    return <div className="ctf-event-list"><div className="empty">该历史运行没有事件日志；结果、NOTES 和文件仍可复核。</div></div>
  const start = eventStart(run)
  const rows = run.events.slice(-600).reverse().map((event, index) => {
    const at = mmss((event.at - start) / 1000)
    if (event.type === "tool")
      return (
        <div className="ctf-event" key={index}>
          <time>{at}</time>
          <span className="ctf-event-kind">{event.tool}</span>
          <span>{event.text ?? event.status ?? ""}</span>
          <small>{event.status ?? ""}</small>
        </div>
      )
    if (event.type === "usage")
      return (
        <div className="ctf-event" key={index}>
          <time>{at}</time>
          <span className="ctf-event-kind">usage</span>
          <span>{compactNumber(event.tokens)} tokens · ${Number(event.cost || 0).toFixed(4)}</span>
          <small></small>
        </div>
      )
    if (event.type === "text")
      return (
        <div className="ctf-event" key={index}>
          <time>{at}</time>
          <span className="ctf-event-kind good">结论</span>
          <span>{event.text ?? ""}</span>
          <small></small>
        </div>
      )
    const bad = ["error", "budget", "stalled", "timeout", "aborted"].includes(event.status ?? "")
    const kind = event.status ?? event.type
    return (
      <div className="ctf-event" key={index}>
        <time>{at}</time>
        <span className={`ctf-event-kind${bad ? " bad" : kind === "completed" || kind === "start" ? " good" : ""}`}>{kind}</span>
        <span>{event.text ?? ""}</span>
        <small></small>
      </div>
    )
  })
  return <div className="ctf-event-list">{rows}</div>
}

function SourceNotes({
  run,
  flagRun,
  flag,
  archived,
  accepted,
  onCopyAlternative,
}: {
  run?: RunHistory
  flagRun?: RunHistory
  flag: string
  archived: boolean
  accepted: boolean
  onCopyAlternative: (value: string) => void
}) {
  const parts: string[] = []
  if (flag && flagRun) {
    const source =
      flagRun.candidateSource === "submission"
        ? "由 Boom 提交槽接收"
        : flagRun.candidateSource === "regex"
          ? "按设定正则提取"
          : "由模型判定"
    parts.push(`${source} · ${verificationText(flagRun)}`)
  }
  if (archived) parts.push("✓ Writeup 已完成，任务已归档")
  else if (accepted) parts.push("✓ Flag 已确认，主流程结束；需要时点击「生成 Writeup」")
  if (flagRun?.rejectedFlags?.includes(flag)) parts.push("已标记为错误，仍会保留；如果判断有误可重新确认。")
  if (flag && flagRun !== run) parts.push("历史任务中的候选；当前运行没有新 flag。")
  const others = useMemo(() => alternatives(flagRun), [flagRun])
  if (!parts.length && !others.length) return null
  return (
    <span className="src">
      {parts.map((part, index) => <span key={index}>{part}<br /></span>)}
      {others.length ? (
        <>
          本任务历史候选：
          {others.map((candidate) => (
            <button type="button" key={candidate} className="alt" onClick={() => onCopyAlternative(candidate)}>
              {candidate}
            </button>
          ))}
        </>
      ) : null}
    </span>
  )
}

function Alerts({
  challenge,
  run,
  flag,
  mismatch,
  flagFormat,
  onFixFormat,
  onRaiseBudget,
}: {
  challenge: ChallengeGui
  run?: RunHistory
  flag: string
  mismatch: boolean
  flagFormat: string
  onFixFormat: () => void
  onRaiseBudget: () => void
}) {
  const alerts: ReactNode[] = []
  if (mismatch) {
    alerts.push(
      <div className="alert warn" key="mismatch">
        <b>候选 flag 不符合当前格式</b>
        <span className="m">{flag}</span> 不匹配 <span className="m">{flagFormat}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-tiny" onClick={onFixFormat}>按此串放宽格式</button>
      </div>,
    )
  }
  const messages: Record<string, [string, string]> = {
    error: ["err", "运行时错误"],
    stalled: ["warn", "重复调用保护触发"],
    budget: ["warn", "token 预算耗尽"],
    timeout: ["warn", "运行超时"],
    empty: ["warn", "模型没有产生文本或工具调用"],
    aborted: ["warn", "运行已由用户停止"],
    interrupted: ["warn", "该历史工作区没有 result.json，可能曾异常中断"],
  }
  if (run && messages[run.stop]) {
    const [style, title] = messages[run.stop]!
    alerts.push(
      <div className={`alert ${style}`} key={run.stop}>
        <b>{title}</b>
        <span className="m">{run.detail ?? ""}</span>
        <span className="spacer" />
        {run.stop === "budget" ? (
          <button type="button" className="btn btn-tiny" onClick={onRaiseBudget}>提高上限并继续</button>
        ) : null}
      </div>,
    )
  }
  return <>{alerts}</>
}

function FlagsPane({ challenge, run }: { challenge: ChallengeGui; run?: RunHistory }) {
  const { toast } = useApp()
  const actions = useActions()
  const entries = flagEntries(challenge, run)
  if (!entries.length) return <div className="flag-history"><div className="empty">尚无 flag 历史</div></div>
  return (
    <div className="flag-history">
      {entries.map((entry) => {
        const [status] = flagHistoryStatus(entry)
        const unconfirmed = isUnconfirmedFlag(entry)
        const rejected = entry.run.rejectedFlags?.includes(entry.value)
        return (
          <div className="flag-history-row" key={`${entry.run.id}-${entry.value}`}>
            <div className="flag-history-main">
              <button
                type="button"
                className="flag-history-value"
                title="点击复制 flag"
                onClick={() =>
                  void navigator.clipboard.writeText(entry.value).then(
                    () => toast("flag 已复制"),
                    () => toast("复制失败", "error"),
                  )
                }
              >
                <FlagIcon className="icon sm" style={{ flex: "none", color: "var(--text-3)" }} />
                <span className="flag-history-copy-value">{entry.value}</span>
                <Copy className="icon sm" />
              </button>
              <span className="flag-history-meta">
                {entry.historical ? "历史运行" : "当前运行"} · {entry.run.id}
              </span>
            </div>
            {unconfirmed ? (
              <span className="flag-history-actions">
                <button type="button" className="btn btn-tiny" onClick={() => void actions.reviewFlag(challenge.slug, entry.run, entry.value, true)}>
                  确认正确
                </button>
                <button type="button" className="btn btn-tiny" onClick={() => void actions.reviewFlag(challenge.slug, entry.run, entry.value, false)}>
                  否定
                </button>
              </span>
            ) : (
              <span className={`flag-history-status ${rejected ? "rejected" : ""}`}>{status}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function MarkdownPane({ text, fallback }: { text?: string; fallback: string }) {
  const html = text?.trim() ? renderMarkdown(text) : ""
  if (!html) return <div className="md"><div className="empty">{fallback || "暂无内容"}</div></div>
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

function ConsultationPane({ run }: { run?: RunHistory }) {
  if (run?.consultation) {
    const consultation = run.consultation
    return (
      <div className="consultation" style={{ padding: 14 }}>
        <div className="cmeta">多模型会诊 · {consultation.trigger} · {compactNumber(consultation.tokens)} tokens</div>
        {consultation.degraded ? (
          <div className="consultation-degraded">
            <strong>会诊已降级</strong>
            <span>{consultation.degraded.detail}</span>
          </div>
        ) : null}
        {consultation.plans.map((plan, index) => (
          <section key={index}>
            <h3>专家 {String.fromCharCode(65 + index)} · {plan.model}</h3>
            <pre>{plan.text}</pre>
          </section>
        ))}
        {consultation.merged ? (
          <section className={`merged${consultation.degraded ? " degraded" : ""}`}>
            <h3>{consultation.degraded ? "降级计划" : "综合计划"} · {consultation.merged.model}</h3>
            <pre>{consultation.merged.text}</pre>
          </section>
        ) : null}
      </div>
    )
  }
  return (
    <div className="checkpoint">
      <h4>检查点</h4>
      <p>{run?.reply?.split("\n")[0] || "该任务还没有会诊记录；需要多模型交叉验证时，从右上角菜单发起会诊。"}</p>
      {run?.turns?.length ? (
        <div className="checkpoint-meta"><span className="tag">{run.turns.length} 轮</span></div>
      ) : null}
    </div>
  )
}

function FilesPane({ run, challenge }: { run?: RunHistory; challenge: ChallengeGui }) {
  const { toast } = useApp()
  const files = run?.files
  if (!files?.length) return <div className="file-list"><div className="empty">尚无运行文件</div></div>
  const openFile = async (path: string) => {
    try {
      await postJSON("/api/open", { kind: "file", slug: challenge.slug, runID: run?.id, path })
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }
  return <FileTree files={files} onOpen={(path) => void openFile(path)} />
}

function FileTree({ files, onOpen }: { files: RunFile[]; onOpen: (path: string) => void }) {
  type TreeNode = { path: string; children: Map<string, TreeNode>; file?: RunFile }
  const root = useMemo(() => {
    const tree: TreeNode = {
      path: "",
      children: new Map(),
    }
    for (const file of files) {
      const parts = file.path.split("/").filter(Boolean)
      if (!parts.length) continue
      let node = tree
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index]!
        const childPath = node.path ? `${node.path}/${name}` : name
        if (!node.children.has(name))
          node.children.set(name, { path: childPath, children: new Map() })
        node = node.children.get(name)!
      }
      node.file = file
    }
    return tree
  }, [files])

  const renderNode = (name: string, node: TreeNode): ReactNode => {
    const directory = node.file?.directory || node.children.size > 0
    if (directory)
      return (
        <details className="fdir" key={name}>
          <summary>
            <span className="fdir-name">{name}/</span>
            <span className="sz">目录</span>
            <button type="button" className="btn btn-tiny" onClick={(event) => { event.preventDefault(); onOpen(node.path) }}>打开</button>
          </summary>
          <div className="fchildren">{[...node.children.entries()].map(([child, childNode]) => renderNode(child, childNode))}</div>
        </details>
      )
    return (
      <div className="frow" key={name}>
        <code>{name}</code>
        <span className="sz">{compactNumber(node.file?.size ?? 0)} B</span>
        <button type="button" className="btn btn-tiny" onClick={() => onOpen(node.path)}>打开</button>
      </div>
    )
  }

  return <div className="file-list">{[...root.children.entries()].map(([name, node]) => renderNode(name, node))}</div>
}

function MetaPane({ run, flag, flagRun, now }: { run?: RunHistory; flag: string; flagRun?: RunHistory; now: number }) {
  const rows: Array<[string, string]> = run
    ? [
        ["task id", run.id],
        ["任务状态", run.taskStatus || "旧运行"],
        ["当前模型", run.model],
        ["Python 环境", run.environment ? `${run.environment.displayName} · ${run.environment.kind} · Python ${run.environment.pythonVersion}` : "未绑定"],
        ["执行模式", run.environment?.executionMode || "—"],
        ["环境指纹", run.environment?.fingerprint || "—"],
        ["轮次", String(run.turns?.length || 1)],
        ["最近 stop", run.stop],
        ["tokens", String(run.tokens || 0)],
        ["billable", String(run.billableTokens || 0)],
        ["费用", `$${Number(run.cost || 0).toFixed(4)}`],
        ["耗时", mmss(durationMs(run, now))],
        ["最后调用", run.lastTool || "—"],
        ["flag", flag || "—"],
        ["来源", flagRun?.candidateSource || "—"],
        ["判定", flag && flagRun ? verificationText(flagRun) : "—"],
        ["否定的 flag", (run.rejectedFlags || []).join(", ") || "—"],
        ...(run.turns ?? []).map(
          (turn, index): [string, string] => [
            `轮次 ${index + 1}`,
            `${turn.stop} · ${compactNumber(turn.tokens)} tokens${turn.prompt ? ` · 提示：${turn.prompt}` : ""}`,
          ],
        ),
      ]
    : [["—", "尚未运行"]]
  return (
    <dl className="kv-grid">
      {rows.map(([key, value]) => (
        <div key={key} className={key === "flag" && flag ? "kv-flag-row" : undefined}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

async function switchEnvironment(
  challenge: ChallengeGui,
  run: RunHistory,
  settings: { executionMode: string },
  action: (slug: string, runID: string, profileId: string, executionMode: "managed" | "isolated" | "static-only") => Promise<void>,
  data: { environments: { defaultProfileId?: string; profiles: Array<{ id: string }> } },
) {
  const profileId = data.environments.defaultProfileId ?? data.environments.profiles[0]?.id
  if (!profileId) {
    window.alert("先在运行设置中选择 Python 环境")
    return
  }
  await action(
    challenge.slug,
    run.id,
    profileId,
    settings.executionMode as "managed" | "isolated" | "static-only",
  )
}

/** Opens the task's own directory (`<root>/tasks/<slug>/<run>/`), not just its `work/`. */
async function openTaskDirectory(challenge: ChallengeGui, run: RunHistory) {
  try {
    await postJSON("/api/open", { kind: "task", slug: challenge.slug, runID: run.id })
  } catch (error) {
    window.alert((error as Error).message)
  }
}
