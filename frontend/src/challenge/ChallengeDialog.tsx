import { useEffect, useState } from "react"
import { FilePlus, Paperclip, Pencil, X } from "lucide-react"
import { useApp } from "../context"
import { api, del, patchJSON, postJSON } from "../api"
import { chooseFiles } from "../bridge"
import { Modal, Select, Toggle } from "../ui"
import { CATEGORY_ORDER, categoryOf } from "../state"

const DIFFICULTIES = ["easy", "medium", "hard", "insane"]

const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function sizeLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function fileName(path: string) {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? path
}

/**
 * The stored description is the whole `README.md`; the field edits the prose below its title line,
 * which Boom maintains from the challenge id and rewrites on every save.
 */
function descriptionBody(description: string | undefined) {
  const text = description ?? ""
  const [first, ...rest] = text.split("\n")
  if (first === undefined || !first.trimStart().startsWith("#")) return text
  return rest.join("\n").replace(/^\s+/, "")
}

/**
 * Operator-side challenge authoring.
 *
 * Creation writes `<root>/challenges/<CATEGORY>/<slug>/` (description, metadata, copied
 * attachments) plus the answer in `<root>/eval/answers.txt`; editing rewrites the same files in
 * place and follows a category change. Nothing here requires the operator to touch the filesystem.
 */
export function ChallengeDialog() {
  const { data, challengeEditor, closeDialog, refresh, toast, select } = useApp()
  const editSlug = challengeEditor?.mode === "edit" ? challengeEditor.slug : undefined
  const current = editSlug ? data?.challenges.find((item) => item.slug === editSlug) : undefined

  const [slug, setSlug] = useState(editSlug ?? "")
  const [category, setCategory] = useState(current ? categoryOf(current) : "MISC")
  const [difficulty, setDifficulty] = useState(current?.difficulty ?? "")
  const [description, setDescription] = useState(descriptionBody(current?.description))
  const [remote, setRemote] = useState(current?.remote ?? "")
  const [serviceRequired, setServiceRequired] = useState(current?.serviceRequired === true)
  const [flagFormat, setFlagFormat] = useState(current?.flagFormat ?? "")
  const [answer, setAnswer] = useState("")
  const [additions, setAdditions] = useState<string[]>([])
  const [removals, setRemovals] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // The answer lives in `<root>/eval/answers.txt` and is deliberately absent from the queue state,
  // so the edit dialog reads it once for this one challenge.
  useEffect(() => {
    if (!editSlug) return
    let cancelled = false
    void api<{ answer: string | null }>(`/api/challenges/${encodeURIComponent(editSlug)}`)
      .then((result) => {
        if (!cancelled) setAnswer(result.answer ?? "")
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [editSlug])

  if (!data || !challengeEditor) return null

  const categories = current && !(CATEGORY_ORDER as readonly string[]).includes(categoryOf(current))
    ? [categoryOf(current), ...CATEGORY_ORDER]
    : [...CATEGORY_ORDER]
  const attachments = current
    ? current.files.filter((file) => !file.directory && !removals.includes(fileName(file.path)))
    : []

  const pickAttachments = async () => {
    const picked = await chooseFiles({
      title: editSlug ? `为 ${editSlug} 添加附件` : "选择题目附件",
      initial: data.root,
      multiple: true,
    })
    if (!picked) return
    setAdditions((previous) => [...new Set([...previous, ...picked])])
  }

  const save = async () => {
    const name = slug.trim()
    if (!editSlug && !SLUG_PATTERN.test(name)) {
      toast("题目 ID 只能包含字母、数字、点、下划线和短横线，且以字母或数字开头", "error")
      return
    }
    setSaving(true)
    try {
      if (editSlug) {
        await patchJSON(`/api/challenges/${encodeURIComponent(editSlug)}`, {
          description,
          category,
          difficulty,
          flagFormat,
          serviceRequired,
          remote,
          answer,
        })
        for (const removed of removals)
          await del(`/api/challenges/${encodeURIComponent(editSlug)}/files/${encodeURIComponent(removed)}`)
        if (additions.length > 0)
          await postJSON(`/api/challenges/${encodeURIComponent(editSlug)}/files`, { sources: additions })
        toast(
          `已保存 ${editSlug}${removals.length || additions.length ? `（附件 ${attachments.length + additions.length} 个）` : ""}`,
        )
        closeDialog()
        await refresh()
        return
      }
      const created = await postJSON<{ slug: string; category: string }>("/api/challenges", {
        slug: name,
        category,
        description,
        difficulty,
        remote,
        serviceRequired,
        flagFormat,
        answer,
        files: additions,
      })
      toast(`题目 ${created.slug} 已创建到 ${created.category}`)
      closeDialog()
      await refresh()
      select(created.slug)
    } catch (error) {
      toast((error as Error).message, "error")
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={editSlug ? `编辑题目 · ${editSlug}` : "新建题目"}
      subtitle={
        editSlug
          ? "题面、分类、附件与答案都会原地更新；改了分类会移动题目目录。"
          : "直接在 Boom 工作目录里创建题目，不需要手动准备目录结构。"
      }
      icon={editSlug ? <Pencil size={16} /> : <FilePlus size={16} />}
      onClose={closeDialog}
      footer={
        <>
          <span className="field-hint" style={{ margin: 0, flex: 1 }}>
            {editSlug
              ? current?.storagePath
              : `将创建 challenges/${category}/${slug.trim() || "<题目 ID>"}/`}
          </span>
          <button type="button" className="btn" onClick={closeDialog}>取消</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : editSlug ? "保存修改" : "创建题目"}
          </button>
        </>
      }
    >
      <div className="challenge-form">
        <div className="challenge-form-row">
          <div className="field">
            <div className="field-label">
              <span className="req">题目 ID</span>
            </div>
            <input
              className="input mono"
              placeholder="例如 warmup-base64"
              maxLength={128}
              disabled={!!editSlug}
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            />
            <p className="field-hint">
              {editSlug ? "题目 ID 就是目录名，创建后不可更改。" : "也是题目目录名，建议用平台上的题目名。"}
            </p>
          </div>
          <div className="field">
            <div className="field-label">
              <span className="req">分类</span>
            </div>
            <Select
              value={category}
              onChange={setCategory}
              ariaLabel="题目分类"
              options={categories.map((value) => ({ value, label: value }))}
            />
            <p className="field-hint">决定题目落在哪个分类目录下。</p>
          </div>
          <div className="field">
            <div className="field-label">
              <span>难度</span>
            </div>
            <input
              className="input"
              placeholder="easy / medium / hard"
              maxLength={40}
              list="challenge-difficulties"
              value={difficulty}
              onChange={(event) => setDifficulty(event.target.value)}
            />
            <datalist id="challenge-difficulties">
              {DIFFICULTIES.map((value) => <option key={value} value={value} />)}
            </datalist>
          </div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>题面</span>
            <small>Markdown，写入 README.md</small>
          </div>
          <textarea
            className="textarea"
            placeholder="粘贴题目描述、提示与线索…"
            maxLength={20000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="challenge-form-row">
          <div className="field">
            <div className="field-label">
              <span>服务地址</span>
            </div>
            <input
              className="input mono"
              placeholder="https://target.example 或 host:port"
              maxLength={300}
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
            />
          </div>
          <div className="field">
            <div className="field-label">
              <span>Flag 格式</span>
            </div>
            <input
              className="input mono"
              placeholder="flag\{[^}]*\}"
              maxLength={200}
              value={flagFormat}
              onChange={(event) => setFlagFormat(event.target.value)}
            />
            <p className="field-hint">留空则用工作目录的默认格式。</p>
          </div>
          <div className="field">
            <div className="field-label">
              <span>已知答案</span>
            </div>
            <input
              className="input mono"
              placeholder="可留空"
              maxLength={500}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <p className="field-hint">写入 eval/answers.txt，供自动判题使用。</p>
          </div>
        </div>

        <Toggle
          checked={serviceRequired}
          onChange={setServiceRequired}
          title="需要访问远程服务"
          desc="题目要求连接外部服务时打开；缺少服务地址的运行会被标记为阻塞。"
        />

        <div className="field">
          <div className="field-label">
            <span>附件</span>
            <small>{editSlug ? `${attachments.length + additions.length} 个` : `${additions.length} 个`}</small>
            <span className="spacer" />
            <button type="button" className="btn btn-tiny" onClick={() => void pickAttachments()}>
              <Paperclip size={12} /> 选择文件
            </button>
          </div>
          <div className="challenge-files">
            {attachments.length === 0 && additions.length === 0 ? (
              <div className="empty">还没有附件。<br />点击「选择文件」从磁盘添加，文件会被复制进题目目录。</div>
            ) : (
              <>
                {attachments.map((file) => (
                  <div className="challenge-file" key={file.path}>
                    <span className="mono">{fileName(file.path)}</span>
                    <span className="spacer" />
                    <span className="challenge-file-size">{sizeLabel(file.size)}</span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除 ${fileName(file.path)}`}
                      onClick={() => setRemovals((previous) => [...previous, fileName(file.path)])}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
                {additions.map((path) => (
                  <div className="challenge-file new" key={path}>
                    <span className="mono">{fileName(path)}</span>
                    <span className="spacer" />
                    <span className="challenge-file-size">待复制</span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`取消 ${fileName(path)}`}
                      onClick={() => setAdditions((previous) => previous.filter((item) => item !== path))}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
