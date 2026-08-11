import { useEffect, useState } from "react"
import { Plus, Shield } from "lucide-react"
import { useApp } from "../context"
import { api, putJSON } from "../api"
import { Modal } from "../ui"
import type { ArmorPromptPreset } from "../types"

export function ArmorPromptsDialog() {
  const { toast, openDialog, refresh } = useApp()
  const [draft, setDraft] = useState<ArmorPromptPreset[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void api<{ prompts: ArmorPromptPreset[] }>("/api/armor-prompts")
      .then((result) => setDraft(structuredClone(result.prompts)))
      .catch((error) => toast((error as Error).message, "error"))
  }, [toast])

  const add = () => {
    setDraft((current) => [
      ...current,
      { id: crypto.randomUUID(), name: "", prompt: "" },
    ])
  }

  const save = async () => {
    if (draft.some((prompt) => !prompt.name.trim() || !prompt.prompt.trim())) {
      toast("每条破甲提示词都需要名称和内容", "error")
      return
    }
    setSaving(true)
    try {
      await putJSON("/api/armor-prompts", { prompts: draft })
      toast("破甲提示词已保存")
      openDialog("settings")
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="破甲提示词"
      subtitle="这里维护具名提示词。模型选中后，内容会置于该模型每次调用的 Agent 系统提示词之前。"
      icon={<Shield size={16} />}
      onClose={() => openDialog("settings")}
      footer={
        <>
          <span className="field-hint" style={{ margin: 0, flex: 1 }}>
            删除并保存一个提示词时，引用它的模型会自动改为“不使用”。
          </span>
          <button type="button" className="btn" onClick={() => openDialog("settings")}>取消</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存提示词"}
          </button>
        </>
      }
    >
      <div className="inline-row" style={{ justifyContent: "flex-end", marginBottom: 10 }}>
        <button type="button" className="btn btn-tiny" onClick={add}><Plus size={12} /> 提示词</button>
      </div>
      <div className="armor-list">
        {draft.length === 0 ? (
          <div className="empty">还没有破甲提示词。<br />点击“＋ 提示词”创建第一项。</div>
        ) : (
          draft.map((prompt, index) => (
            <div className="armor-card" key={prompt.id}>
              <input
                className="input mono"
                placeholder="提示词名称，例如：通用越狱"
                maxLength={120}
                value={prompt.name}
                onChange={(event) =>
                  setDraft((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, name: event.target.value } : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="btn btn-tiny"
                onClick={() => setDraft((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              >
                删除
              </button>
              <textarea
                className="textarea mono"
                maxLength={100000}
                placeholder="输入要置于 Agent 提示词最前面的系统提示词…"
                value={prompt.prompt}
                onChange={(event) =>
                  setDraft((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, prompt: event.target.value } : item,
                    ),
                  )
                }
              />
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}
