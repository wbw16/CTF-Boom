export type ReadNotices = Record<string, number[]>
export const READ_NOTICE_STORAGE_KEY = "boom-platform-read-notices-v2"
const MAX_IDS = 1_000

export function noticeScope(root: string, platform: string) {
  return JSON.stringify([root, platform])
}

export function parseReadNotices(raw: string | null): ReadNotices {
  try {
    const value: unknown = JSON.parse(raw ?? "{}")
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).flatMap(([scope, ids]) => Array.isArray(ids)
      ? [[scope, [...new Set(ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0))].slice(-MAX_IDS)]]
      : []))
  } catch { return {} }
}

export function markRead(current: ReadNotices, scope: string, id: number): ReadNotices {
  const ids = current[scope] ?? []
  if (!Number.isSafeInteger(id) || id <= 0 || ids.includes(id)) return current
  return { ...current, [scope]: [...ids, id].slice(-MAX_IDS) }
}
