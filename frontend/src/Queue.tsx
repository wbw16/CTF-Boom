import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { Copy, Flag as FlagIcon, Search } from "lucide-react"
import { useApp } from "./context"
import { useActions } from "./actions"
import { patchJSON } from "./api"
import { fitOverlayToViewport } from "./overlay"
import {
  CATEGORY_ORDER,
  bucket,
  categoryOf,
  label,
  last,
  latestFlagRun,
  matches,
  orderedChallenges,
  primary,
  runnableChallenges,
  why,
} from "./state"
import { compactNumber, durationMs, shortModel } from "./format"
import type { ChallengeGui } from "./types"

export function Queue() {
  const { data, selected, filter, collapsed, now, setFilter, toggleCollapsed, select, setMenu, refresh, toast } = useApp()
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

  const onMenu = (slug: string, x: number, y: number) => setMenu({ slug, x, y })

  if (!data) return null
  const { challenges, settings } = data
  const shown = challenges.filter((challenge) => matches(challenge, filter))
  const ordered = orderedChallenges(shown, settings.flagFormat)

  return (
    <aside className="sidebar">
      <div className="queue-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          placeholder="搜索题目、flag、原因…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="queue">
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
                className="group"
                role="button"
                tabIndex={0}
                aria-expanded={!hidden}
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
                <span className="line" />
                <span className="group-actions">
                  {runnable.length ? (
                    <button
                      type="button"
                      className="group-btn primary"
                      title={`运行或继续 ${category} 分类中可运行的 ${runnable.length} 道题`}
                      onClick={(event) => {
                        event.stopPropagation()
                        runCategory(category)
                      }}
                    >
                      运行本类 · {runnable.length}
                    </button>
                  ) : null}
                  {needAttention ? (
                    <button
                      type="button"
                      className="group-btn"
                      onClick={(event) => {
                        event.stopPropagation()
                        retryCategory(category)
                      }}
                    >
                      继续本类
                    </button>
                  ) : null}
                  {hasRemoved ? (
                    <button
                      type="button"
                      className="group-btn"
                      onClick={(event) => {
                        event.stopPropagation()
                        void restoreCategory(category)
                      }}
                    >
                      恢复本类
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
                      now={now}
                      onSelect={() => select(challenge.slug)}
                      onMenu={(x, y) => onMenu(challenge.slug, x, y)}
                    />
                  ))
                : null}
            </div>
          )
        })}
      </div>
      <ContextMenu />
    </aside>
  )
}

function QueueItem({
  challenge,
  selected,
  now,
  onSelect,
  onMenu,
}: {
  challenge: ChallengeGui
  selected: boolean
  now: number
  onSelect: () => void
  onMenu: (x: number, y: number) => void
}) {
  const { data, toast } = useApp()
  const flagFormat = data?.settings.flagFormat ?? ""
  const run = last(challenge)
  const latestFlag = primary(latestFlagRun(challenge))
  const key = bucket(challenge, flagFormat)
  const [statusText, statusColor] = label(challenge, flagFormat)
  const muted = ["gaveup", "removed"].includes(key)

  const copyFlag = async () => {
    try {
      await navigator.clipboard.writeText(latestFlag)
      toast("flag 已复制")
    } catch {
      toast("复制失败，请手动选中", "error")
    }
  }

  return (
    <div
      className={`item${selected ? " selected" : ""}${muted ? " done" : ""}${latestFlag ? " has-flag" : ""}`}
      role="button"
      tabIndex={0}
      data-slug={challenge.slug}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === "Enter") onSelect()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(event.clientX, event.clientY)
      }}
    >
      <span className="r1">
        <span className="slug">{challenge.slug}</span>
        {run?.turns?.length ? <span className="runs">{run.turns.length} 轮</span> : challenge.runs.length > 1 ? <span className="runs">{challenge.runs.length} 个旧任务</span> : null}
        {run?.consultation ? <span className="runs" title="本次任务使用了多模型会诊">⚖</span> : null}
        <span className={`st ${statusColor}`}>{statusText}</span>
        <button
          type="button"
          className="kebab"
          title="更多操作"
          onClick={(event) => {
            event.stopPropagation()
            const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect()
            onMenu(rect.left - 160, rect.bottom + 4)
          }}
        >
          ⋯
        </button>
      </span>
      {latestFlag ? (
        <button
          type="button"
          className="queue-flag"
          title={`点击复制 ${latestFlag}`}
          aria-label={`复制 Flag ${latestFlag}`}
          onClick={(event) => {
            event.stopPropagation()
            void copyFlag()
          }}
        >
          <span className="queue-flag-label"><FlagIcon size={10} aria-hidden="true" /> 已找到 Flag</span>
          <span className="queue-flag-value">{latestFlag}</span>
          <Copy size={11} aria-hidden="true" />
        </button>
      ) : (
        <span className="r2">{why(challenge, flagFormat)}</span>
      )}
      {run ? (
        <span className="r3">
          <span className="num">
            {compactNumber(run.tokens)} tokens · {formatDuration(run, now)}
          </span>
        </span>
      ) : null}
    </div>
  )
}

function formatDuration(run: { startedAt?: string; durationMs?: number; stop?: string }, now: number) {
  const seconds = durationMs(run, now)
  const value = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
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
  const { data, setMenu, openDialog, requestDelete } = useApp()
  const { runChallenges, patchState, resetChallenge } = useActions()
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
    if (action === "settings") openDialog("settings")
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
      <div className="menu-head">模型策略</div>
      <button type="button" className="menu-item" data-menu-action="settings">
        ⚙ E {shortModel(data.settings.economyModel)} / S {shortModel(data.settings.strongModel)}
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
