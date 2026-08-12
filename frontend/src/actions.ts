import { useCallback } from "react"
import { useApp } from "./context"
import { del, patchJSON, postJSON } from "./api"
import type { ExecutionMode, GuiSettings, RunHistory } from "./types"

export function useActions() {
  const { data, toast, refresh } = useApp()

  const requireEnvironment = useCallback(() => {
    const profileId =
      data?.environments.defaultProfileId ?? data?.environments.profiles[0]?.id ?? ""
    if (!profileId) {
      toast("先在设置中选择默认 Python 环境", "error")
      return undefined
    }
    return profileId
  }, [data, toast])

  const runChallenges = useCallback(
    async (
      slugs: string[],
      extra: {
        hint?: string
        newTask?: boolean
        runID?: string
        settings?: GuiSettings
        executionMode?: ExecutionMode
      } = {},
    ) => {
      if (!slugs.length) {
        toast("没有可运行的题目", "error")
        return false
      }
      const settings = extra.settings ?? data?.settings
      if (!settings) return false
      if (settings.consultModels.length !== 0 &&
        (settings.consultModels.length < 2 || settings.consultModels.length > 4)) {
        toast("多模型会诊池必须留空或选择 2–4 个模型", "error")
        return false
      }
      const profileId = requireEnvironment()
      if (!profileId) return false
      try {
        await postJSON("/api/runs", {
          slugs,
          hint: extra.hint || undefined,
          newTask: extra.newTask === true,
          runIDs: extra.runID ? { [slugs[0]!]: extra.runID } : undefined,
          environmentProfileId: profileId,
          executionMode: extra.executionMode ?? settings.executionMode,
        })
        toast(`${slugs.length} 题已进入运行队列`)
        await refresh()
        return true
      } catch (error) {
        toast((error as Error).message, "error")
        return false
      }
    },
    [data, refresh, requireEnvironment, toast],
  )

  const reviewFlag = useCallback(
    async (slug: string, run: RunHistory, flag: string, correct: boolean, hint = "") => {
      if (correct && !window.confirm(`确认 ${slug} 的 flag 正确并归档任务？\n\n${flag}`)) return
      try {
        await postJSON("/api/flags", {
          slug,
          runID: run.id,
          flag,
          correct,
          hint: hint || undefined,
        })
        toast(correct ? "Flag 已确认，主流程结束；需要时点击「生成 Writeup」" : "已否定该 Flag，并继续同一任务")
        await refresh()
      } catch (error) {
        toast((error as Error).message, "error")
      }
    },
    [refresh, toast],
  )

  const startConsultation = useCallback(
    async (slug: string, settings: GuiSettings, runID?: string) => {
      if (settings.consultModels.length < 2 || settings.consultModels.length > 4) {
        toast("请先在运行设置中选择 2–4 个会诊模型", "error")
        return false
      }
      try {
        const result = await postJSON<{ mode?: "queued" | "before-start" | "live-handoff" }>("/api/consultations", {
          slug,
          sourceRunID: runID,
          expertModels: settings.consultModels,
          model: settings.strongModel,
          synthesizerModel: settings.strongModel,
        })
        toast(
          result.mode === "live-handoff"
            ? "会诊请求已接收；当前工具完成后会暂停主 agent，会诊后自动继续"
            : "多模型会诊已排队，综合后会自动继续求解",
        )
        await refresh()
        return true
      } catch (error) {
        toast((error as Error).message, "error")
        return false
      }
    },
    [refresh, toast],
  )

  const writeupRun = useCallback(
    async (slug: string, runID: string) => {
      try {
        await postJSON("/api/runs/writeup", { slug, runID })
        toast("已排队生成 Writeup；完成后任务自动归档")
        await refresh()
      } catch (error) {
        toast((error as Error).message, "error")
      }
    },
    [refresh, toast],
  )

  const stopRun = useCallback(
    async (slug?: string) => {
      try {
        const result = await postJSON<{ stopped: number }>("/api/runs/stop", slug ? { slug } : {})
        toast(slug ? `已请求停止 ${slug}` : `已请求停止 ${result.stopped} 个运行`)
        await refresh()
      } catch (error) {
        toast((error as Error).message, "error")
      }
    },
    [refresh, toast],
  )

  const patchState = useCallback(
    async (slug: string, state: "given-up" | "removed" | null, message: string) => {
      try {
        await patchJSON("/api/challenges/" + encodeURIComponent(slug), { state })
        toast(message)
        await refresh()
      } catch (error) {
        toast((error as Error).message, "error")
      }
    },
    [refresh, toast],
  )

  const resetChallenge = useCallback(
    async (slug: string, hasRuns: boolean) => {
      if (!hasRuns) {
        toast("该题没有运行历史", "error")
        return
      }
      if (!window.confirm(`清空 ${slug} 的全部运行历史与 work/ 产物？`)) return
      try {
        await del(`/api/challenges/${encodeURIComponent(slug)}/runs`)
        toast("运行历史已清空")
        await refresh()
      } catch (error) {
        toast((error as Error).message, "error")
      }
    },
    [refresh, toast],
  )

  const deleteChallenge = useCallback(
    async (slug: string, storagePath: string, category: string) => {
      try {
        await del(`/api/challenges/${encodeURIComponent(slug)}`, { confirm: true })
        toast("题目及其运行历史已删除")
        await refresh()
      } catch (error) {
        toast((error as Error).message, "error")
      }
    },
    [refresh, toast],
  )

  const switchTaskEnvironment = useCallback(
    async (slug: string, runID: string, profileId: string, executionMode: ExecutionMode) => {
      try {
        await patchJSON("/api/environments/task", {
          slug,
          runID,
          profileId,
          executionMode,
        })
        toast("任务环境已切换；下次继续将创建使用新环境的新会话")
        await refresh()
      } catch (error) {
        toast((error as Error).message, "error")
      }
    },
    [refresh, toast],
  )

  return {
    runChallenges,
    reviewFlag,
    startConsultation,
    writeupRun,
    stopRun,
    patchState,
    resetChallenge,
    deleteChallenge,
    switchTaskEnvironment,
    requireEnvironment,
  }
}
