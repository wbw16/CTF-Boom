import { useApp } from "../context"
import { useActions } from "../actions"
import { Modal } from "../ui"
import { categoryOf } from "../state"

export function DeleteDialog() {
  const { data, deleteTarget, closeDialog, requestDelete } = useApp()
  const { deleteChallenge, patchState } = useActions()
  if (!data || !deleteTarget) return null
  const challenge = data.challenges.find((item) => item.slug === deleteTarget)
  if (!challenge) return null
  const path = `challenges/${challenge.storagePath || `${categoryOf(challenge)}/${challenge.slug}`}/ + runs/${challenge.slug}/`

  return (
    <Modal
      title="删除磁盘上的题目目录？"
      subtitle="将永久删除，无法撤销。如果只是不想再跑这题，用「放弃」或「从批次移除」，文件会保留。"
      onClose={closeDialog}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={closeDialog}>取消</button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              requestDelete(null)
              void patchState(challenge.slug, "removed", "已改为从批次移除")
            }}
          >
            改为从批次移除
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              closeDialog()
              requestDelete(null)
              void deleteChallenge(challenge.slug, challenge.storagePath, categoryOf(challenge))
            }}
          >
            永久删除
          </button>
        </>
      }
    >
      <div className="note" style={{ margin: 0 }}>
        <code style={{ wordBreak: "break-all" }}>{path}</code>
        <p style={{ margin: "8px 0 0", color: "var(--mu)" }}>
          附件、运行历史和 NOTES.md 都会一起消失，无法撤销。
        </p>
      </div>
    </Modal>
  )
}
