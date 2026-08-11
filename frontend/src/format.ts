export function shortModel(model: string | undefined | null) {
  const tail = String(model || "—").split("/").pop() || "—"
  return tail.length > 22 ? `${tail.slice(0, 19)}…` : tail
}

export function compactNumber(value: number | string | undefined | null) {
  const number = Number(value) || 0
  return number >= 1000 ? `${(number / 1000).toFixed(number >= 100000 ? 0 : 1)}k` : String(number)
}

export function mmss(seconds: number) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
}

export function durationMs(run: {
  startedAt?: string
  durationMs?: number
  stop?: string
}, now = Date.now()) {
  if ((run.stop === "running" || run.stop === "queued") && run.startedAt)
    return Math.floor((now - new Date(run.startedAt).valueOf()) / 1000)
  if (run.durationMs !== undefined) return Math.floor(run.durationMs / 1000)
  if (run.startedAt) return Math.floor((now - new Date(run.startedAt).valueOf()) / 1000)
  return 0
}

export function eventStart(run: { startedAt?: string; events?: Array<{ at: number }> }) {
  return run.startedAt ? new Date(run.startedAt).valueOf() : run.events?.[0]?.at ?? 0
}

export function verificationText(run: {
  platformSubmission?: { verdict: string; adapter: string; detail: string }
  acceptedFlag?: string
  verification?: { level: string; detail: string }
}) {
  if (run.platformSubmission && !(run.platformSubmission.verdict === "pending" && run.acceptedFlag)) {
    const verdict: Record<string, string> = { accepted: "已接受", rejected: "已拒绝", pending: "等待人工判定" }
    return `${run.platformSubmission.adapter} · ${verdict[run.platformSubmission.verdict] ?? run.platformSubmission.verdict} · ${run.platformSubmission.detail}`
  }
  if (!run.verification) return "等待人工判定"
  const labels: Record<string, string> = {
    remote: "远程服务验证",
    "local-checker": "本地 checker 验证",
    "offline-derivation": "离线推导",
    unverified: "未验证",
  }
  return `${labels[run.verification.level] ?? run.verification.level} · ${run.verification.detail}`
}

export function parseVariables(text: string) {
  const variables: Record<string, string> = {}
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator < 1) throw new Error(`同步变量第 ${index + 1} 行必须是 name=value`)
    variables[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return variables
}
