import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { FolderInput, Pencil, Plus, Search } from "lucide-react"
import { useApp } from "./context"
import { useActions } from "./actions"
import { chooseDirectory } from "./bridge"
import { patchJSON, postJSON } from "./api"
import { fitOverlayToViewport } from "./overlay"
import {
  CATEGORY_ORDER,
  bucket,
  categoryOf,
  confirmedRun,
  label,
  last,
  matches,
  orderedChallenges,
  runnableChallenges,
} from "./state"
import { compactNumber } from "./format"
import type { ChallengeGui } from "./types"

/** CTF-mode challenge queue: import, search, category groups, and the solved-progress footer. */
export function Queue() {
  const {
    data,
    selected,
    filter,
    collapsed,
    sidebarOpen,
    setSidebarOpen,
    setFilter,
    toggleCollapsed,
    select,
    setMenu,
    refresh,
    toast,
    openChallengeEditor,
  } = useApp()
  const { runChallenges } = useActions()

  const runCategory = useCallback(
    (category: string) => {
      if (!data) return
      void runChallenges(runnableChallenges(data.challenges, category).map((challenge) => challenge.slug))
    },
    [data, runChallenges],
  )

  const retryCategory = useCallback(
    (category: string) => {
      if (!data) return
      void runChallenges(
        data.challenges
          .filter((challenge) => categoryOf(challenge) === category && bucket(challenge, data.settings.flagFormat) === "attn")
          .map((challenge) => challenge.slug),
      )
    },
    [data, runChallenges],
  )

  const restoreCategory = useCallback(
    async (category: string) => {
      if (!data) return
      try {
        await Promise.all(
          data.challenges
            .filter((challenge) => challenge.state === "removed" && categoryOf(challenge) === category)
            .map((challenge) =>
              patchJSON(`/api/challenges/${encodeURIComponent(challenge.slug)}`, { state: null })),
        )
        await refresh()
      } catch (error) {
        toast((error as Error).message, "error")
        await refresh()
      }
    },
    [data, refresh, toast],
  )

  const importChallenge = useCallback(async () => {
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

  const onMenu = (slug: string, x: number, y: number) => setMenu({ slug, x, y })

  if (!data) return null
  const { challenges, settings } = data
  const shown = challenges.filter((challenge) => matches(challenge, filter))
  const ordered = orderedChallenges(shown, settings.flagFormat)
  const solved = challenges.filter((challenge) => confirmedRun(challenge)).length
  const progress = challenges.length ? Math.round((solved / challenges.length) * 100) : 0

  return (
    <aside className={`ctf-queue${sidebarOpen ? " open" : ""}`}>
      <header className="ctf-queue-head">
        <div>
          <p className="eyebrow">Challenge queue</p>
          <h1>CTF 题目</h1>
        </div>
        <span className="spacer" />
        <span className="tag blue">{challenges.length} 题</span>
      </header>
      <div className="ctf-queue-tools">
        <div className="ctf-create-actions">
          <button
            className="new-task"
            type="button"
            onClick={() => openChallengeEditor({ mode: "create" })}
          >
            <Plus className="icon sm" /> 新建题目
          </button>
          <button
            className="icon-button"
            type="button"
            title="从已有目录导入题目"
            aria-label="从已有目录导入题目"
            onClick={() => void importChallenge()}
          >
            <FolderInput className="icon sm" />
          </button>
        </div>
        <div className="search-wrap">
          <Search className="icon" />
          <input
            aria-label="搜索 CTF 题目"
            className="search"
            placeholder="搜索题目、Flag 或状态"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      </div>
      <div className="ctf-queue-scroll">
        {shown.length === 0 ? <div className="empty">没有匹配项</div> : null}
        {(CATEGORY_ORDER as readonly string[]).map((category) => {
          const list = ordered.filter((challenge) => categoryOf(challenge) === category)
          if (!list.length) return null
          const hidden = collapsed.has(category) && !filter
          const runnable = runnableChallenges(challenges, category)
          const needAttention = list.some(
            (challenge) => bucket(challenge, settings.flagFormat) === "attn",
          )
          const hasRemoved = list.some((challenge) => challenge.state === "removed")
          return (
            <div key={category}>
              <div
                className="ctf-category"
                role="button"
                tabIndex={0}
                aria-expanded={!hidden}
                title={hidden ? "展开分类" : "收起分类"}
                onClick={() => toggleCollapsed(category)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    toggleCollapsed(category)
                  }
                }}
              >
                <span className="caret">{hidden ? "▸" : "▾"}</span>
                <span>{category}</span>
                <em>{list.length}</em>
                <span className="group-actions" onClick={(event) => event.stopPropagation()}>
                  {runnable.length ? (
                    <button
                      type="button"
                      className="group-btn"
                      title={`运行或继续 ${category} 分类中可运行的 ${runnable.length} 道题`}
                      onClick={() => runCategory(category)}
                    >
                      运行 {runnable.length}
                    </button>
                  ) : null}
                  {needAttention ? (
                    <button type="button" className="group-btn" onClick={() => retryCategory(category)}>
                      继续
                    </button>
                  ) : null}
                  {hasRemoved ? (
                    <button type="button" className="group-btn" onClick={() => void restoreCategory(category)}>
                      恢复
                    </button>
                  ) : null}
                </span>
              </div>
              {!hidden
                ? list.map((challenge) => (
                    <QueueItem
                      key={challenge.slug}
                      challenge={challenge}
                      selected={challenge.slug === selected}
                      onSelect={() => select(challenge.slug)}
                      onMenu={(x, y) => onMenu(challenge.slug, x, y)}
                    />
                  ))
                : null}
            </div>
          )
        })}
      </div>
      <div className="ctf-queue-footer">
        <div className="ctf-queue-footer-top">
          <b>{solved} / {challenges.length} 已完成</b>
          <span className="spacer" />
          <span className="mono">{progress}%</span>
        </div>
        <div className="ctf-progress" aria-label="解题进度">
          <i style={{ width: `${progress}%` }} />
        </div>
      </div>
      {sidebarOpen ? <div className="backdrop open" onPointerDown={() => setSidebarOpen(false)} /> : null}
      <ContextMenu />
    </aside>
  )
}

function statusClasses(challenge: ChallengeGui, flagFormat: string) {
  const [statusText, statusColor] = label(challenge, flagFormat)
  if (statusColor === "c-run") return { statusText, statusClass: "running", dot: "running" }
  if (statusColor === "c-ok") return { statusText, statusClass: "solved", dot: "running" }
  if (statusColor === "c-err") return { statusText, statusClass: "failed", dot: "failed" }
  if (statusColor === "c-warn") return { statusText, statusClass: "candidate", dot: "paused" }
  return { statusText, statusClass: "queued", dot: "" }
}

function QueueItem({
  challenge,
  selected,
  onSelect,
  onMenu,
}: {
  challenge: ChallengeGui
  selected: boolean
  onSelect: () => void
  onMenu: (x: number, y: number) => void
}) {
  const { data } = useApp()
  const flagFormat = data?.settings.flagFormat ?? ""
  const run = last(challenge)
  const solved = !!confirmedRun(challenge)
  const { statusText, statusClass, dot } = statusClasses(challenge, flagFormat)
  const rounds = run?.turns?.length
    ? `第 ${run.turns.length} 轮`
    : challenge.runs.length > 1
      ? `${challenge.runs.length} 个旧任务`
      : "未开始"

  return (
    <article
      className={`ctf-challenge${selected ? " selected" : ""}${solved ? " solved" : ""}`}
      role="button"
      tabIndex={0}
      data-slug={challenge.slug}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault()
          onSelect()
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(event.clientX, event.clientY)
      }}
    >
      <div className="ctf-challenge-row">
        <i className={`state-dot ${dot}`} />
        <span className="ctf-challenge-name">{challenge.slug}</span>
        <span className="spacer" />
        <span className={`ctf-status ${statusClass}`}>{statusText}</span>
      </div>
      <div className="ctf-challenge-info">
        <span>{challenge.files.length} 个附件</span>
        <span>·</span>
        <span>{rounds}</span>
        {run ? <span className="mono">{compactNumber(run.tokens)} tok</span> : null}
      </div>
    </article>
  )
}

export function ContextMenu() {
  const { data, menu } = useApp()
  if (!menu || !data) return null
  const challenge = data.challenges.find((item) => item.slug === menu.slug)
  if (!challenge) return null

  return <ChallengeContextMenu challenge={challenge} menu={menu} />
}

function ChallengeContextMenu({
  challenge,
  menu,
}: {
  challenge: ChallengeGui
  menu: { slug: string; x: number; y: number }
}) {
  const { data, setMenu, openDialog, openChallengeEditor, requestDelete, setSidebarOpen } = useApp()
  const { runChallenges, patchState, resetChallenge, startConsultation } = useActions()
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: menu.x, top: menu.y })

  useLayoutEffect(() => {
    const updatePosition = () => {
      const element = menuRef.current
      if (!element) return
      const bounds = element.getBoundingClientRect()
      setPosition(
        fitOverlayToViewport(
          { x: menu.x, y: menu.y },
          { width: bounds.width, height: bounds.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      )
    }
    updatePosition()
    window.addEventListener("resize", updatePosition)
    return () => window.removeEventListener("resize", updatePosition)
  }, [challenge.runs.length, menu.x, menu.y])

  if (!data) return null

  const act = (action: string) => {
    setMenu(null)
    if (action === "rerun") void runChallenges([challenge.slug], { runID: last(challenge)?.id })
    if (action === "newtask") {
      if (window.confirm(`为 ${challenge.slug} 新建一个空白任务？旧任务与产物会保留。`))
        void runChallenges([challenge.slug], { newTask: true })
    }
    if (action === "edit") openChallengeEditor({ mode: "edit", slug: challenge.slug })
    if (action === "settings") openDialog("settings")
    if (action === "consult") void startConsultation(challenge.slug, data.settings, last(challenge)?.id)
    if (action === "giveup")
      void patchState(
        challenge.slug,
        challenge.state === "given-up" ? null : "given-up",
        challenge.state === "given-up" ? "已恢复" : "已放弃（文件保留）",
      )
    if (action === "remove")
      void patchState(
        challenge.slug,
        challenge.state === "removed" ? null : "removed",
        challenge.state === "removed" ? "已回到批次" : "已移出批次（文件保留）",
      )
    if (action === "reset") void resetChallenge(challenge.slug, challenge.runs.length > 0)
    if (action === "delete") {
      requestDelete(challenge.slug)
      openDialog("delete")
    }
    setSidebarOpen(false)
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={position}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest("[data-menu-action]")
        if (button) act((button as HTMLElement).dataset.menuAction ?? "")
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="menu-head">运行</div>
      <button type="button" className="menu-item" data-menu-action="rerun">
        ▶ {challenge.runs.length ? "继续当前任务" : "开始任务"}
      </button>
      {challenge.runs.length ? (
        <button type="button" className="menu-item" data-menu-action="newtask">＋ 新建独立任务</button>
      ) : null}
      <div className="menu-head">题目</div>
      <button type="button" className="menu-item" data-menu-action="edit">
        <Pencil className="icon sm" /> 编辑题面 / 附件 / 答案
      </button>
      <div className="menu-head">任务工具</div>
      <button type="button" className="menu-item" data-menu-action="consult">
        ⚖ 发起多模型会诊
      </button>
      <button type="button" className="menu-item" data-menu-action="settings">
        ⚙ 运行设置
      </button>
      <div className="menu-sep" />
      <button type="button" className="menu-item" data-menu-action="giveup">
        {challenge.state === "given-up" ? "↺ 取消放弃" : "⊘ 放弃这题"}
      </button>
      <button type="button" className="menu-item" data-menu-action="remove">
        {challenge.state === "removed" ? "↺ 回到批次" : "✕ 从批次移除"}
      </button>
      <button type="button" className="menu-item" data-menu-action="reset">⟲ 清空运行历史</button>
      <div className="menu-sep" />
      <button type="button" className="menu-item danger" data-menu-action="delete">🗑 删除磁盘目录…</button>
    </div>
  )
}
