import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import type { Challenge } from "../challenge.ts"
import type { TaskRecord } from "../task.ts"

const MAX_NOTES = 6_000
const MAX_ARTIFACTS = 20
const MAX_TURNS = 4
const MAX_DETAIL = 400

function bounded(value: string | undefined, maximum: number) {
  const text = value?.trim() ?? ""
  if (text.length <= maximum) return text
  return `${text.slice(0, maximum)}\n[已截断，原长度 ${text.length} 字符]`
}

export async function recentArtifacts(directory: string, maximum: number) {
  const root = await realpath(directory)
  const work = path.join(root, "work")
  const files: Array<{ path: string; mtime: number }> = []
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === ".boom") continue
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await visit(target); continue }
      if (!entry.isFile()) continue
      const canonical = await realpath(target)
      const relative = path.relative(root, canonical)
      if (relative.startsWith("..") || path.isAbsolute(relative) || !relative.startsWith("work")) continue
      const info = await lstat(canonical).catch(() => undefined)
      if (!info) continue
      files.push({ path: relative.split(path.sep).join("/"), mtime: info.mtimeMs })
    }
  }
  await visit(work)
  return files.sort((left, right) => right.mtime - left.mtime).slice(0, maximum).map((file) => file.path)
}

/**
 * A deterministic, no-model-call handoff injected at the start of every continuation turn.
 * It gives the solver the durable essentials without forcing it to re-read a long conversation:
 * task state, recent turns, NOTES.md, and the newest artifacts.
 */
export async function buildHandoffSummary(input: {
  directory: string
  challenge: Challenge
  task: TaskRecord
}) {
  const notes = await readFile(path.join(input.directory, "NOTES.md"), "utf8").catch(() => "")
  const artifacts = await recentArtifacts(input.directory, MAX_ARTIFACTS)
  const turns = input.task.turns.slice(-MAX_TURNS).reverse()
  const lines: string[] = [
    "## 紧凑交接（自动生成，续轮起点）",
    "",
    `题目：${input.challenge.slug} · 任务状态：${input.task.status} · 已运行 ${input.task.turns.length} 轮 · 已排除候选 ${input.task.rejectedFlags.length} 个。`,
  ]
  if (turns.length > 0) {
    lines.push("", "最近轮次：")
    for (const turn of turns) {
      const candidate = turn.candidates.length > 0 ? ` · 候选 ${turn.candidates.length} 个` : ""
      const detail = turn.detail ? ` · ${bounded(turn.detail, MAX_DETAIL)}` : ""
      lines.push(`- ${turn.model} · ${turn.stop} · ${turn.tokens} tokens${candidate}${detail}`)
    }
  }
  if (notes.trim()) lines.push("", "NOTES.md（摘要）：", bounded(notes, MAX_NOTES))
  if (artifacts.length > 0) lines.push("", "最近产物：", ...artifacts.map((file) => `- ${file}`))
  lines.push("", "以上为自动交接。若与 challenge/、work/ 或 NOTES.md 的实际内容冲突，以实际文件为准。")
  return lines.join("\n")
}
