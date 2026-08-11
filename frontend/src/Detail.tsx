import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, Copy, FileText, Flag as FlagIcon, MoreHorizontal, Play, Square, X } from "lucide-react"
import { useApp } from "./context"
import { useActions } from "./actions"
import { patchJSON, postJSON } from "./api"
import { compactNumber, durationMs, eventStart, mmss, shortModel, verificationText } from "./format"
import { renderMarkdown } from "./markdown"
import {
  alternatives,
  categoryOf,
  displayFlagRun,
  flagEntries,
  flagHistoryStatus,
  formatMismatch,
  isLive,
  isUnconfirmedFlag,
  last,
  primary,
} from "./state"
import type { ChallengeGui, RunFile, RunHistory } from "./types"

const TABS = ["activity", "evidence", "results"] as const
type Tab = (typeof TABS)[number]

export function Detail() {
  const { data, selected, detail, now, toast, refresh, loadDetail, openDialog } = useApp()
  const actions = useActions()
  const [tab, setTab] = useState<Tab>("activity")
  const [hint, setHint] = useState("")
  const [detailMenu, setDetailMenu] = useState(false)
  const challenge = data?.challenges.find((item) => item.slug === selected)
  const [remoteDraft, setRemoteDraft] = useState("")
  const [savingRemote, setSavingRemote] = useState(false)
  useEffect(() => setDetailMenu(false), [selected])
  useEffect(() => setRemoteDraft(challenge?.remote ?? ""), [selected, challenge?.remote])
  useEffect(() => {
    if (!detailMenu) return
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailMenu(false)
    }
    document.addEventListener("keydown", close)
    return () => document.removeEventListener("keydown", close)
  }, [detailMenu])
  if (!data) return null
  if (!challenge) {
    return (
      <main className="main">
        <div className="empty">没有题目</div>
      </main>
    )
  }
  const run = detail ?? last(challenge)
  const live = isLive(run)
  const settings = data.settings
  const flagRun = displayFlagRun(challenge)
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
    await actions.runChallenges([challenge.slug], { hint, runID: last(challenge)?.id, settings })
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
      toast(remote ? "服务地址已保存，下次运行会自动使用" : "服务地址已清除，将继续进行本地分析", "success")
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
      await postJSON("/api/settings", { ...settings, tokens })
      await actions.runChallenges([challenge.slug], { hint, runID: last(challenge)?.id })
      toast("已提高上限并继续")
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
      <><Square size={12} /> 停止本题</>
    ) : primaryKind === "confirm" ? (
      <><Check size={12} /> 确认 Flag</>
    ) : primaryKind === "writeup" ? (
      <><FileText size={12} /> 生成 Writeup</>
    ) : (
      <><Play size={12} /> {run ? "继续任务" : "开始任务"}</>
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

  return (
    <main className="main">
      <div className="detail-header">
        <div className="detail-title">
          <h2>{categoryOf(challenge)} / {challenge.slug}</h2>
          <span className="tag">{challenge.files.length} 个附件{challenge.difficulty ? ` · ${challenge.difficulty}` : ""}</span>
          {flag ? (
            <button
              type="button"
              className="detail-flag"
              title={`点击复制 ${flag}`}
              aria-label={`复制 Flag ${flag}`}
              onClick={() => void verdictAction("copy")}
            >
              <span className="detail-flag-label"><FlagIcon size={11} aria-hidden="true" /> 已找到 Flag</span>
              <span className="detail-flag-value">{flag}</span>
              <Copy size={12} aria-hidden="true" />
            </button>
          ) : null}
          <span className="spacer" />
          <span className="num detail-stats">
            {compactNumber(run?.tokens ?? 0)} tokens · {run ? mmss(durationMs(run, now)) : "00:00"} · $
            {(run?.cost ?? 0).toFixed(4)}
          </span>
        </div>
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
            <button
              type="button"
              className="btn btn-tiny"
              disabled
              title="接入平台的单题取址接口后在这里启用"
            >
              从平台获取
            </button>
            <span className="service-endpoint-help">不填写也会启动任务，并先完成本地分析。</span>
          </form>
        ) : null}
        <div className="detail-actions">
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
          ) : <span className="spacer" />}
          <button
            type="button"
            className={`btn ${primaryKind === "stop" ? "" : "btn-primary"}`}
            data-run-action={primaryKind === "run" ? "true" : undefined}
            onClick={() => void runPrimaryAction()}
          >
            {primaryContent}
          </button>
          <div className={`detail-menu-wrap${detailMenu ? " open" : ""}`}>
            <button
              type="button"
              className="icon-btn detail-more"
              aria-label="更多任务操作"
              aria-expanded={detailMenu}
              onClick={() => setDetailMenu((current) => !current)}
            >
              <MoreHorizontal size={17} />
            </button>
            {detailMenu ? (
              <div className="context-menu detail-menu">
                {primaryKind !== "run" && !live ? (
                  <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void rerun() }}>
                    <Play size={13} /> 继续当前任务
                  </button>
                ) : null}
                {flag ? (
                  <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void verdictAction("copy") }}>
                    <Copy size={13} /> 复制 Flag
                  </button>
                ) : null}
                {pendingCandidate ? (
                  <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void verdictAction("wrong") }}>
                    <X size={13} /> 否定候选
                  </button>
                ) : null}
                <div className="menu-sep" />
                <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void actions.startConsultation(challenge.slug, settings, last(challenge)?.id) }}>
                  ⚖ 发起会诊
                </button>
                {run && !live ? (
                  <>
                    <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void switchEnvironment(challenge, run, settings, actions.switchTaskEnvironment, data) }}>
                      切换运行环境
                    </button>
                    <button type="button" className="menu-item" onClick={() => { setDetailMenu(false); void openWork(challenge, run) }}>
                      打开 work/
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <Alerts
          challenge={challenge}
          run={run}
          flag={flag}
          mismatch={!!mismatch}
          flagFormat={settings.flagFormat}
          onFixFormat={fixFormat}
          onRaiseBudget={() => void raiseBudget()}
        />
      </div>

      <div className="tabs">
        {TABS.map((name) => (
          <button
            type="button"
            key={name}
            className={tab === name ? "active" : ""}
            onClick={() => setTab(name)}
          >
            {TAB_LABELS[name]}
          </button>
        ))}
      </div>
      <div className="panes">
        <Pane active={tab === "activity"} compound>
          <div className="activity-layout">
            <section className="workspace-section">
              <h3>运行日志</h3>
              <StreamPane run={run} />
            </section>
            <section className="workspace-section activity-side">
              <h3>检查点与会诊</h3>
              <ConsultationPane run={run} />
            </section>
          </div>
        </Pane>
        <Pane active={tab === "evidence"} compound>
          <div className="evidence-layout">
            <section className="workspace-section">
              <h3>NOTES</h3>
              <MarkdownPane text={run?.notes} fallback="（尚无 NOTES.md 内容）" />
            </section>
            <section className="workspace-section">
              <h3>文件</h3>
              <FilesPane run={run} challenge={challenge} />
            </section>
          </div>
        </Pane>
        <Pane active={tab === "results"} compound>
          <div className="results-layout">
            <section className="workspace-section">
              <h3>Flag</h3>
              <Verdict
                challenge={challenge}
                run={run}
                flagRun={flagRun}
                flag={flag}
                mismatch={!!mismatch}
                accepted={accepted}
                archived={archived}
                onAction={(action) => void verdictAction(action)}
              />
              <FlagsPane challenge={challenge} />
            </section>
            <section className="workspace-section">
              <h3>Writeup</h3>
              <MarkdownPane text={flag ? flagRun?.writeup ?? "" : ""} fallback="暂无 Writeup" />
              <details className="result-meta">
                <summary>运行元数据</summary>
                <MetaPane run={run} flag={flag} flagRun={flagRun} now={now} />
              </details>
            </section>
          </div>
        </Pane>
      </div>
      {detailMenu ? <div className="detail-menu-backdrop" onPointerDown={() => setDetailMenu(false)} /> : null}
    </main>
  )
}

const TAB_LABELS: Record<Tab, string> = {
  activity: "活动",
  evidence: "证据",
  results: "结果",
}

function Pane({ active, children, compound = false }: { active: boolean; children: ReactNode; compound?: boolean }) {
  return <div className={`pane${active ? " active" : ""}${compound ? " compound" : ""}`}>{children}</div>
}

function StreamPane({ run }: { run?: RunHistory }) {
  if (!run?.events?.length) return <div className="empty">该历史运行没有事件日志；结果、NOTES 和文件仍可复核。</div>
  const start = eventStart(run)
  const lines = run.events.slice(-600).map((event) => eventLine(event, start))
  return <pre className="stream-pre" dangerouslySetInnerHTML={{ __html: lines.join("\n") }} />
}

function eventLine(event: RunHistory["events"][number], start: number) {
  const at = `${mmss((event.at - start) / 1000)} `
  if (event.type === "tool")
    return `${at}<span class="${event.status === "error" ? "bad" : "tool"}">${escapeHtml(event.tool)}</span> ${escapeHtml(event.text ?? event.status ?? "")}`
  if (event.type === "usage")
    return `${at}<span class="tool">usage</span> ${compactNumber(event.tokens)} tokens · $${Number(event.cost || 0).toFixed(4)}`
  if (event.type === "text") return `${at}<span class="say">${escapeHtml(event.text ?? "")}</span>`
  const bad = ["error", "budget", "stalled", "timeout", "aborted"].includes(event.status ?? "")
  return `${at}<span class="${bad ? "bad" : event.status === "completed" ? "good" : "tool"}">${escapeHtml(event.status ?? event.type)}</span> ${escapeHtml(event.text ?? "")}`
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"]/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string)
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

function Verdict({
  challenge,
  run,
  flagRun,
  flag,
  mismatch,
  accepted,
  archived,
  onAction,
}: {
  challenge: ChallengeGui
  run?: RunHistory
  flagRun?: RunHistory
  flag: string
  mismatch: boolean
  accepted: boolean
  archived: boolean
  onAction: (action: "copy" | "wrong") => void
}) {
  const { toast } = useApp()
  const sourceParts: string[] = []
  if (flag && flagRun) {
    const source =
      flagRun.candidateSource === "submission"
        ? "由 Boom 提交槽接收"
        : flagRun.candidateSource === "regex"
          ? "按设定正则提取"
          : "由模型判定"
    sourceParts.push(`${source} · ${verificationText(flagRun)}`)
  }
  if (archived) sourceParts.push("✓ Writeup 已完成，任务已归档")
  else if (accepted) sourceParts.push("✓ Flag 已确认，主流程结束；需要时点击「生成 Writeup」")
  if (flagRun?.rejectedFlags?.includes(flag)) sourceParts.push("已标记为错误，仍会保留；如果判断有误可重新确认。")
  const others = alternatives(flagRun)
  const candidateRun = displayFlagRun(challenge)
  if (flag && candidateRun !== run) sourceParts.push("历史任务中的候选；当前运行没有新 flag。")

  return (
    <div className={`verdict${flag ? " has-flag" : ""}${mismatch ? " mismatch" : ""}${flag && !mismatch && !accepted ? " candidate" : ""}${flag && !mismatch && accepted ? " accepted" : ""}`}>
      {flag ? (
        <div className="verdict-head">
          <span><FlagIcon size={13} aria-hidden="true" /> 已找到 Flag</span>
          <em>{mismatch ? "格式不符" : archived ? "已归档" : accepted ? "已确认" : "待确认"}</em>
        </div>
      ) : null}
      <span className={`vflag${flag ? mismatch ? " miss" : "" : " none"}`}>
        {flag || (run ? "本次运行未得到 flag" : "尚未运行")}
      </span>
      {flag ? (
        <div className="flag-actions">
          <button type="button" className="btn btn-tiny" onClick={() => onAction("copy")}>
            <Copy size={11} /> 复制
          </button>
          {!accepted ? (
            <button type="button" className="btn btn-tiny" onClick={() => onAction("wrong")}>
              <X size={11} /> 否定
            </button>
          ) : null}
        </div>
      ) : null}
      {sourceParts.length ? (
        <span className="src">
          {sourceParts.map((part, index) => (
            <span key={index}>{part}<br /></span>
          ))}
        </span>
      ) : null}
      {others.length ? (
        <span className="src">
          本任务历史候选：
          {others.map((candidate) => (
            <button
              type="button"
              key={candidate}
              className="alt"
              onClick={() =>
                void navigator.clipboard.writeText(candidate).then(
                  () => toast("已复制备选串"),
                  () => toast("复制失败，请手动选中", "error"),
                )
              }
            >
              {candidate}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  )
}

function FlagsPane({ challenge }: { challenge: ChallengeGui }) {
  const { toast } = useApp()
  const actions = useActions()
  const entries = flagEntries(challenge)
  if (!entries.length) return <div className="empty">尚无 flag 历史</div>
  return (
    <div className="flag-history">
      {entries.map((entry, index) => {
        const [status, style] = flagHistoryStatus(entry)
        const unconfirmed = isUnconfirmedFlag(entry)
        return (
          <div className={`flag-history-row${style ? ` ${style}` : ""}`} key={`${entry.run.id}-${entry.value}`}>
            <div className="flag-history-main">
              <button
                type="button"
                className={`flag-history-value${style ? ` ${style}` : ""}`}
                title="点击复制 flag"
                onClick={() =>
                  void navigator.clipboard.writeText(entry.value).then(
                    () => toast("flag 已复制"),
                    () => toast("复制失败", "error"),
                  )
                }
              >
                <span className="flag-history-copy-label"><FlagIcon size={10} aria-hidden="true" /> Flag</span>
                <span className="flag-history-copy-value">{entry.value}</span>
                <Copy size={11} aria-hidden="true" />
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
            ) : null}
            <span className={`flag-history-status ${style}`}>{status}</span>
          </div>
        )
      })}
    </div>
  )
}

function MarkdownPane({ text, fallback }: { text?: string; fallback: string }) {
  const html = text?.trim() ? renderMarkdown(text) : ""
  if (!html) return <div className="empty">{fallback || "暂无内容"}</div>
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

function ConsultationPane({ run }: { run?: RunHistory }) {
  if (run?.consultation) {
    const consultation = run.consultation
    return (
      <div className="consultation">
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
  return <div className="empty">该任务还没有会诊记录</div>
}

function FilesPane({ run, challenge }: { run?: RunHistory; challenge: ChallengeGui }) {
  const { toast } = useApp()
  const files = run?.files
  if (!files?.length) return <div className="empty">尚无运行文件</div>
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
            <button type="button" className="btn btn-tiny" onClick={() => onOpen(node.path)}>打开</button>
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

  return <div className="file-tree">{[...root.children.entries()].map(([name, node]) => renderNode(name, node))}</div>
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
            `${shortModel(turn.model)} · ${turn.stop} · ${compactNumber(turn.tokens)} tokens${turn.prompt ? ` · 提示：${turn.prompt}` : ""}`,
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

async function openWork(challenge: ChallengeGui, run: RunHistory) {
  try {
    await postJSON("/api/open", { kind: "work", slug: challenge.slug, runID: run.id })
  } catch (error) {
    window.alert((error as Error).message)
  }
}
