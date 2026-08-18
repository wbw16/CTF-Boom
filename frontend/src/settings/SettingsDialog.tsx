import { useMemo, useState, type ReactNode } from "react"
import {
  Blocks,
  Cable,
  Cpu,
  Flag,
  Gauge,
  KeyRound,
  Plug,
  Shield,
  Terminal,
  Timer,
} from "lucide-react"
import { useApp } from "../context"
import { patchJSON, postJSON } from "../api"
import { Modal, Segmented, Select, Toggle, type SelectOption } from "../ui"
import type { GuiSettings } from "../types"

const SECTIONS = [
  { id: "models", label: "模型", icon: Cpu },
  { id: "env", label: "运行环境", icon: Terminal },
  { id: "budget", label: "预算与超时", icon: Gauge },
  { id: "flag", label: "Flag 提取", icon: Flag },
  { id: "integrations", label: "集成", icon: Blocks },
] as const

type SectionId = (typeof SECTIONS)[number]["id"]

export function SettingsDialog() {
  const { data, toast, refresh, closeDialog, openDialog } = useApp()
  const [section, setSection] = useState<SectionId>("models")
  const [draft, setDraft] = useState<GuiSettings | null>(() =>
    data ? { ...data.settings } : null,
  )
  const [envId, setEnvId] = useState(() => data?.environments.defaultProfileId ?? "")
  const [saving, setSaving] = useState(false)
  const [migratingCredentials, setMigratingCredentials] = useState(false)
  const [interpreterPath, setInterpreterPath] = useState("")

  const modelOptions = useMemo(() => {
    if (!data) return []
    const connected = data.models.filter((model) => model.connected)
    const source = connected.length ? connected : data.models.slice(0, 200)
    const current = new Set([
      data.settings.economyModel,
      data.settings.strongModel,
      data.settings.visionModel,
      ...data.settings.consultModels,
    ])
    const models = [...source]
    for (const id of current) {
      if (id && !models.some((model) => model.id === id))
        models.unshift({ id, name: id, connected: false })
    }
    return models.map(
      (model): SelectOption<string> => ({
        value: model.id,
        label: model.name || model.id,
        group: model.id.split("/")[0],
        dot: model.connected,
        tag: model.connected ? "已连接" : "未连接",
        tagKind: model.connected ? "ok" : "off",
      }),
    )
  }, [data])

  const visionOptions = useMemo((): SelectOption<string>[] => {
    if (!data) return []
    return [
      { value: "", label: "不启用" },
      ...data.models
        .filter((model) => model.connected && model.attachment === true)
        .map((model) => ({
          value: model.id,
          label: model.name || model.id,
          group: model.id.split("/")[0],
          dot: true,
          tag: "图片",
          tagKind: "ok" as const,
        })),
    ]
  }, [data])

  const envOptions = useMemo(() => {
    const profiles = data?.environments.profiles ?? []
    return profiles.map(
      (profile): SelectOption<string> => ({
        value: profile.id,
        label: profile.displayName,
        sub: `Python ${profile.pythonVersion} · ${profile.kind}`,
        dot: profile.status === "ready",
        tag: profile.status === "ready" ? "就绪" : profile.status,
        tagKind: profile.status === "ready" ? "ok" : "off",
        disabled: profile.status !== "ready",
      }),
    )
  }, [data])

  if (!data || !draft) return null

  const set = <K extends keyof GuiSettings>(key: K, value: GuiSettings[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current))

  const toggleConsult = (model: string, checked: boolean) => {
    setDraft((current) => {
      if (!current) return current
      const next = checked
        ? current.consultModels.length < 4 && !current.consultModels.includes(model)
          ? [...current.consultModels, model]
          : current.consultModels
        : current.consultModels.filter((item) => item !== model)
      return { ...current, consultModels: next }
    })
  }

  const save = async () => {
    if (!draft) return
    if (!draft.economyModel.includes("/") || !draft.strongModel.includes("/")) {
      toast("Economy 与 Strong 模型都必须是 provider/model", "error")
      return
    }
    if (draft.visionModel && !visionOptions.some((option) => option.value === draft.visionModel)) {
      toast("Vision 模型必须是已连接且支持图片的模型", "error")
      return
    }
    if (
      draft.consultModels.length !== 0 &&
      (draft.consultModels.length < 2 || draft.consultModels.length > 4)
    ) {
      toast("多模型会诊池必须留空或选择 2–4 个模型", "error")
      return
    }
    if (draft.flagFormat.trim()) {
      try {
        new RegExp(draft.flagFormat.trim())
      } catch {
        toast("flag 格式不是有效正则", "error")
        return
      }
    }
    if (!((!draft.tokenBudgetEnabled || draft.tokens > 0) && draft.repeats >= 2 && draft.minutes > 0 && draft.concurrency > 0)) {
      toast("运行参数必须为正数，repeats 至少为 2", "error")
      return
    }
    const profileId = envId || data.environments.defaultProfileId
    if (!profileId) {
      toast("请选择默认 Python 环境", "error")
      return
    }
    setSaving(true)
    try {
      const saved = await patchJSON<{
        switches?: { active: number; queued: number; warnings: string[] }
      }>("/api/settings", {
        ...draft,
        flagFormat: draft.flagFormat.trim(),
      })
      await patchJSON("/api/environments/default", { profileId })
      const active = saved.switches?.active ?? 0
      const compatibility = saved.switches?.warnings ?? []
      toast(
        active > 0
          ? `设置已保存；${active} 个运行将在下一消息或工具边界切换${compatibility.length ? `（${compatibility.join("；")}）` : ""}`
          : "运行设置已保存",
      )
      closeDialog()
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setSaving(false)
    }
  }

  const addInterpreter = async () => {
    if (!interpreterPath.trim()) {
      toast("请输入 Python 解释器路径", "error")
      return
    }
    try {
      const result = await postJSON<{ profile: { id: string } }>("/api/environments", {
        interpreter: interpreterPath.trim(),
        makeDefault: true,
      })
      setEnvId(result.profile.id)
      setInterpreterPath("")
      toast("环境已通过测试")
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const discoverConda = async () => {
    try {
      const result = await postJSON<{ discovered: number; store: { defaultProfileId?: string } }>(
        "/api/environments/discover",
      )
      if (result.store.defaultProfileId) setEnvId(result.store.defaultProfileId)
      toast(`发现并探测 ${result.discovered} 个 Conda 环境`)
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const migrateOpenCodeCredentials = async () => {
    setMigratingCredentials(true)
    try {
      const result = await postJSON<{
        migration: {
          imported: Array<{ id: string; type: "api" | "oauth" }>
          skipped: number
        }
      }>("/api/providers/import-opencode-credentials")
      const imported = result.migration.imported
      toast(
        imported.length > 0
          ? `已迁移 ${imported.length} 个凭据：${imported.map((item) => item.id).join("、")}`
          : "OpenCode 中没有可迁移的 Provider API Key / OAuth",
      )
      await refresh()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setMigratingCredentials(false)
    }
  }

  const consultCount = draft.consultModels.length
  const consultCountClass = consultCount === 0 ? "zero" : consultCount === 1 ? "warn" : "ok"
  const selectedEnv = envOptions.find((option) => option.value === envId)

  return (
    <Modal
      title="运行设置"
      subtitle="模型 / Provider 修改会在运行中的下一消息或工具边界热切换；预算与超时只约束新的一轮。"
      icon={<Cpu size={16} />}
      className="settings-modal"
      onClose={closeDialog}
      nav={
        <nav className="modal-nav">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              className={`modal-nav-btn${section === id ? " active" : ""}`}
              onClick={() => setSection(id)}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>
      }
      footer={
        <>
          <span className="note" style={{ margin: 0, flex: 1 }}>
            模型更改在安全边界立即接管
          </span>
          <button type="button" className="btn" onClick={closeDialog}>取消</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存设置"}
          </button>
        </>
      }
    >
      <section className={`modal-section${section === "models" ? " active" : ""}`}>
        <h3 style={{ marginTop: 0 }}>模型</h3>
        <div className="grid-2">
          <div className="field">
            <div className="field-label"><span className="req">Economy 模型</span><span className="tag">轻量 · 整理</span></div>
            <Select
              value={draft.economyModel}
              options={modelOptions}
              onChange={(value) => set("economyModel", value)}
              ariaLabel="Economy 模型"
            />
            <p className="field-hint">整理、规则比较和可自动验收工作使用。</p>
          </div>
          <div className="field">
            <div className="field-label"><span className="req">Strong 模型</span><span className="tag">求解 · 推理</span></div>
            <Select
              value={draft.strongModel}
              options={modelOptions}
              onChange={(value) => set("strongModel", value)}
              ariaLabel="Strong 模型"
            />
            <p className="field-hint">求解、开放推理、检查点分析与裁决使用。</p>
          </div>
        </div>
        <div className="field">
          <div className="field-label"><span>Vision 模型</span><span className="tag">按需看图</span></div>
          <Select
            value={draft.visionModel ?? ""}
            options={visionOptions}
            onChange={(value) => set("visionModel", value)}
            ariaLabel="Vision 模型"
          />
          <p className="field-hint">仅当 Strong 模型不支持图片时，向求解 Agent 提供按需看图工具。</p>
        </div>
        <div className="field">
          <div className="field-label">
            <span className="req">多模型会诊池</span>
            <span className="tag">2–4 个</span>
            <span className={`count-badge ${consultCountClass}`}>{consultCount}/4</span>
          </div>
          <div className="chips" style={{ border: "1px solid var(--line2)", borderRadius: 10, background: "var(--bg)", padding: 8, gap: 6, display: "flex", flexWrap: "wrap", alignItems: "center", minHeight: 44 }}>
            {consultCount === 0 ? (
              <span className="chips-empty">未启用 · 手动会诊与盲审都不会使用</span>
            ) : (
              draft.consultModels.map((id) => (
                <span className="chip" key={id}>
                  <span className="select-dot on" />
                  <span className="chip-id">{id}</span>
                  <button type="button" className="chip-x" aria-label={`移除 ${id}`} onClick={() => toggleConsult(id, false)}>
                    ×
                  </button>
                </span>
              ))
            )}
            <Select
              multiple
              selected={draft.consultModels}
              options={modelOptions.map((option) => ({
                ...option,
                disabled: option.disabled || (consultCount >= 4 && !draft.consultModels.includes(option.value)),
              }))}
              onToggle={toggleConsult}
              placeholder="添加模型…"
              ariaLabel="会诊模型"
              className="select-inline"
              searchable
              footer={
                <>
                  <span className="select-tip">触发会诊时并行给出方案并综合；留空表示不启用</span>
                </>
              }
            />
          </div>
          <p className="field-hint">盲审只从池中抽取一个模型；池为空时不会触发盲审。</p>
        </div>
        <Toggle
          checked={draft.blindReview}
          onChange={(checked) => set("blindReview", checked)}
          title="候选 Flag 自动盲审"
          desc="得到候选 Flag 时，从会诊池抽取一个模型盲审；关闭后仅保留手动会诊。"
        />
        <Toggle
          checked={draft.consultOnCompaction}
          onChange={(checked) => set("consultOnCompaction", checked)}
          title="压缩后先会诊"
          desc="实验开关：开启时压缩后先运行会诊；关闭时原 solver session 直接继续。每次运行都会记录该策略。"
        />
        <div className="note">两个档次可以选择同一个模型。修改会诊池不会影响 Economy / Strong 的当前选择。</div>
      </section>

      <section className={`modal-section${section === "env" ? " active" : ""}`}>
        <h3 style={{ marginTop: 0 }}>运行环境</h3>
        <div className="grid-2">
          <div className="field">
            <div className="field-label"><span className="req">默认 Python 环境</span></div>
            <Select
              value={envId}
              options={envOptions}
              onChange={setEnvId}
              placeholder="— 请选择现有环境 —"
              ariaLabel="默认 Python 环境"
            />
            {selectedEnv ? (
              <p className="field-hint mono">
                {selectedEnv.sub} · {selectedEnv.value}
              </p>
            ) : (
              <p className="field-hint">必须选择一个已存在的环境；Boom 不创建 venv，也不会回退到系统 Python。</p>
            )}
          </div>
          <div className="field">
            <div className="field-label"><span className="req">执行模式</span></div>
            <Segmented
              name="execution-mode"
              value={draft.executionMode}
              onChange={(value) => set("executionMode", value as GuiSettings["executionMode"])}
              options={[
                { value: "managed", label: "managed", desc: "受控宿主工具链" },
                { value: "isolated", label: "isolated", desc: "非 root 容器" },
                { value: "static-only", label: "static-only", desc: "禁止未知程序" },
              ]}
            />
          </div>
        </div>
        <div className="field">
          <div className="field-label"><span>手动添加已有 Python / Conda 解释器</span></div>
          <div className="inline-row">
            <input
              className="input mono"
              placeholder="/path/to/env/bin/python"
              spellCheck={false}
              value={interpreterPath}
              onChange={(event) => setInterpreterPath(event.target.value)}
            />
            <button type="button" className="btn" onClick={() => void addInterpreter()}>测试并添加</button>
            <button type="button" className="btn btn-ghost" onClick={() => void discoverConda()}>发现 Conda</button>
          </div>
        </div>
        <Toggle
          checked={draft.network === "deny"}
          onChange={(checked) => set("network", checked ? "deny" : "allow")}
          title="完全离线运行"
          desc="关闭后拒绝 webfetch / websearch，并隔离 bash / boom-exec 的网络访问；开启后照常联网（查文档、下载工具、访问远程服务）。"
        />
      </section>

      <section className={`modal-section${section === "budget" ? " active" : ""}`}>
        <h3 style={{ marginTop: 0 }}>预算与超时</h3>
        <div className="grid-4">
          <div className="field">
            <div className="field-label"><span className="req">每轮 tokens</span></div>
            <div className="num-wrap">
              <input
                type="number"
                value={draft.tokens}
                min={1000}
                step={10000}
                disabled={!draft.tokenBudgetEnabled}
                onChange={(event) => set("tokens", Number(event.target.value))}
              />
              <span className="unit">tokens</span>
            </div>
          </div>
          <div className="field">
            <div className="field-label"><span className="req">重复调用上限</span></div>
            <div className="num-wrap">
              <input type="number" value={draft.repeats} min={2} onChange={(event) => set("repeats", Number(event.target.value))} />
              <span className="unit">次</span>
            </div>
          </div>
          <div className="field">
            <div className="field-label"><span className="req">每轮分钟</span></div>
            <div className="num-wrap">
              <input type="number" value={draft.minutes} min={1} onChange={(event) => set("minutes", Number(event.target.value))} />
              <span className="unit">min</span>
            </div>
          </div>
          <div className="field">
            <div className="field-label"><span className="req">并发任务</span></div>
            <div className="num-wrap">
              <input type="number" value={draft.concurrency} min={1} max={32} onChange={(event) => set("concurrency", Number(event.target.value))} />
              <span className="unit">任务</span>
            </div>
          </div>
        </div>
        <Toggle
          checked={draft.tokenBudgetEnabled}
          onChange={(checked) => set("tokenBudgetEnabled", checked)}
          title="启用 token 预算"
          desc="关闭后不设 token 上限；每轮仍受分钟数、重复调用保护、无活动监测与输出上限约束。"
        />
        <div className="note">repeats 至少为 2；并发上限 32。预算设置只约束新开始的一轮。</div>
      </section>

      <section className={`modal-section${section === "flag" ? " active" : ""}`}>
        <h3 style={{ marginTop: 0 }}>Flag 提取</h3>
        <div className="field">
          <div className="field-label"><span className="req">Flag 格式（正则）</span><span className="tag">留空 = 由模型判断</span></div>
          <input
            className="input mono"
            placeholder="例如 CTF\{[^}]+\} 或 flag\{[^}]+\}"
            value={draft.flagFormat}
            onChange={(event) => set("flagFormat", event.target.value)}
            spellCheck={false}
          />
          <p className="field-hint">保存时校验正则合法性；非法正则不会被接受。</p>
        </div>
      </section>

      <section className={`modal-section${section === "integrations" ? " active" : ""}`}>
        <h3 style={{ marginTop: 0 }}>集成</h3>
        <div className="integ-grid">
          <IntegrationCard icon={<Plug size={15} />} title="Provider 与模型" desc="连接或移除凭据，自定义兼容端点，控制模型是否出现在上方选择器。" onClick={() => openDialog("providers")} />
          <IntegrationCard
            icon={<KeyRound size={15} />}
            title={migratingCredentials ? "正在迁移凭据…" : "从 OpenCode 迁移凭据"}
            desc="只复制 Provider API Key / OAuth 到 Boom 独立凭据库；不迁移会话、日志、MCP 或项目配置。"
            disabled={migratingCredentials}
            onClick={() => void migrateOpenCodeCredentials()}
          />
          <IntegrationCard icon={<Cable size={15} />} title="MCP Server" desc="Boom 保存独立配置并注入隔离的 Boom Runtime，不读取用户或项目 OpenCode 配置。" onClick={() => openDialog("mcp")} />
          <IntegrationCard icon={<Timer size={15} />} title="西湖论剑控制台" desc="专用接入、AccessKey、自动拉题、线上资源与赛方大模型网关。" onClick={() => openDialog("competition")} />
          <IntegrationCard icon={<Shield size={15} />} title="破甲提示词" desc="维护可复用的置顶系统提示词；然后在每个 Provider 模型上选择一项。" onClick={() => openDialog("armor")} />
        </div>
      </section>

    </Modal>
  )
}

function IntegrationCard({
  icon,
  title,
  desc,
  disabled = false,
  onClick,
}: {
  icon: ReactNode
  title: string
  desc: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className="integ-card" disabled={disabled} onClick={onClick}>
      <span className="integ-icon">{icon}</span>
      <span className="integ-text"><b>{title}</b><small>{desc}</small></span>
      <span className="select-caret">→</span>
    </button>
  )
}
