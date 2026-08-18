import { useEffect, useState } from "react"
import { Bell, ExternalLink, FileText, RefreshCw } from "lucide-react"
import { api } from "../api"
import { useApp } from "../context"
import type { XihulunjianNoticeDetail } from "../types"
import { Modal } from "../ui"

function announcementTime(notice: { createdAt?: string; createdTime?: number }) {
  const value = notice.createdTime ?? (notice.createdAt ? new Date(notice.createdAt).valueOf() : undefined)
  if (!value || Number.isNaN(value)) return "时间未知"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value)
}

/** Read-only platform announcements, refreshed by the app once a minute. */
export function NoticeDialog() {
  const { notices, refreshNotices, markNoticeRead, closeDialog, toast } = useApp()
  const [selectedID, setSelectedID] = useState<number | null>(null)
  const [detail, setDetail] = useState<XihulunjianNoticeDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    setSelectedID((current) => {
      if (current && notices.some((notice) => notice.id === current)) return current
      return notices[0]?.id ?? null
    })
  }, [notices])

  useEffect(() => {
    if (selectedID) markNoticeRead(selectedID)
  }, [markNoticeRead, selectedID])

  useEffect(() => {
    if (!selectedID) {
      setDetail(null)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setDetail(null)
    void api<XihulunjianNoticeDetail>(`/api/xihulunjian/notices/${selectedID}`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setDetail(next)
      })
      .catch((error) => {
        if (!controller.signal.aborted) toast((error as Error).message, "error")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [selectedID, toast])

  const refresh = async () => {
    setRefreshing(true)
    await refreshNotices()
    setRefreshing(false)
  }

  const selected = notices.find((notice) => notice.id === selectedID)
  const content = detail?.content ?? selected?.content

  return (
    <Modal
      title="通知公告"
      subtitle="每 60 秒自动更新；点击公告查看完整内容与附件"
      icon={<Bell size={17} />}
      onClose={closeDialog}
      className="notice-modal"
      footer={
        <>
          <span className="note">公告由西湖论剑平台提供</span>
          <button type="button" className="btn btn-tiny" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw size={13} className={refreshing ? "spin" : undefined} />刷新
          </button>
        </>
      }
    >
      <div className="notice-layout">
        <aside className="notice-list" aria-label="公告列表">
          {notices.length === 0 ? (
            <div className="notice-empty">暂无公告。请确认已在西湖论剑控制台配置 AccessKey。</div>
          ) : notices.map((notice) => (
            <button
              key={notice.id}
              type="button"
              className={`notice-item${notice.id === selectedID ? " active" : ""}`}
              onClick={() => setSelectedID(notice.id)}
            >
              <span className="notice-item-title">{notice.title}</span>
              <span className="notice-item-meta">{announcementTime(notice)}{notice.userName ? ` · ${notice.userName}` : ""}</span>
            </button>
          ))}
        </aside>
        <article className="notice-detail" aria-live="polite">
          {!selected ? <div className="notice-empty">选择一则公告以查看内容。</div> : (
            <>
              <div className="notice-detail-head">
                <div>
                  <h3>{detail?.title ?? selected.title}</h3>
                  <p>{announcementTime(detail ?? selected)}{(detail?.userName ?? selected.userName) ? ` · ${detail?.userName ?? selected.userName}` : ""}</p>
                </div>
                {loading ? <RefreshCw size={16} className="spin" aria-label="正在加载" /> : null}
              </div>
              <div className="notice-content">{content || "该公告暂无文字内容。"}</div>
              {(detail?.files.length ?? 0) > 0 ? (
                <div className="notice-files">
                  <h4>附件</h4>
                  {detail!.files.map((file) => (
                    <a key={`${file.url}:${file.name}`} href={file.url} target="_blank" rel="noreferrer">
                      <FileText size={15} />
                      <span>{file.name}</span>
                      {file.ext ? <small>{file.ext.toUpperCase()}</small> : null}
                      <ExternalLink size={13} />
                    </a>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </article>
      </div>
    </Modal>
  )
}
