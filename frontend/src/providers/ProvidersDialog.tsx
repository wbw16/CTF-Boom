import { useEffect, useMemo, useState } from "react"
import { Plug, Plus, Search, Trash2 } from "lucide-react"
import { useApp } from "../context"
import { api, del, putJSON } from "../api"
import { Modal, Select } from "../ui"
import type {
  ArmorPromptPreset,
  ManagedProviderConfig,
  ProviderDetails,
  ProviderModel,
  ProviderSummary,
} from "../types"

export function ProvidersDialog() {
  const { data, toast, refresh, openDialog } = useApp()
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState("")
  const [draft, setDraft] = useState<ProviderDetails | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [armorPrompts, setArmorPrompts] = useState<ArmorPromptPreset[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [apiKey, setApiKey] = useState("")

  useEffect(() => {
    void load()
  }, [])

  const load = async () => {
    setLoading(true)
    try {
      const [providerResult, armorResult] = await Promise.all([
        api<{ providers: ProviderSummary[] }>("/api/providers"),
        api<{ prompts: ArmorPromptPreset[] }>("/api/armor-prompts"),
      ])
      setProviders(providerResult.providers)
      setArmorPrompts(armorResult.prompts)
      const next =
        providerResult.providers.find((provider) => provider.id === selected)?.id ??
        providerResult.providers.find((provider) => provider.configured)?.id ??
        providerResult.providers[0]?.id ??
        ""
      if (next) await selectProvider(next)
      else newProvider()
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setLoading(false)
    }
  }

  const selectProvider = async (id: string) => {
    setSelected(id)
    setIsNew(false)
    setDetailLoading(true)
    setDraft(null)
    try {
      const result = await api<{ provider: ProviderDetails }>(`/api/providers/${encodeURIComponent(id)}`)
      setDraft(structuredClone(result.provider))
    } catch (error) {
      setDraft(null)
      toast((error as Error).message, "error")
    } finally {
      setDetailLoading(false)
    }
  }

  const newProvider = () => {
    setSelected("")
    setIsNew(true)
    setDetailLoading(false)
    setDraft({
      id: "",
      name: "",
      custom: true,
      disabled: false,
      connected: false,
      configured: false,
      modelCount: 0,
      visibleModelCount: 0,
      authMethods: [{ type: "api", label: "API Key", index: 0 }],
      npm: "@ai-sdk/openai-compatible",
      driver: "openai-compatible",
      api: "",
      baseURL: "",
      models: [],
    })
  }

  const setModel = (index: number, patch: Partial<ProviderModel>) => {
    setDraft((current) => {
      if (!current) return current
      const models = current.models.map((model, modelIndex) =>
        modelIndex === index ? { ...model, ...patch } : model,
      )
      return { ...current, models }
    })
  }

  const readProvider = (): ManagedProviderConfig | null => {
    if (!draft) return null
    const id = draft.id.trim()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
      toast("Provider ID 必须为 1–64 位小写字母、数字、.、_ 或 -，且以字母或数字开头", "error")
      return null
    }
    const models = draft.models.map((model) => ({
      id: model.id.trim(),
      name: model.name.trim(),
      context: Number(model.context) || 300000,
      output: Number(model.output) || 16384,
      reasoning: model.reasoning,
      attachment: model.attachment,
      ...(model.pricing ? { pricing: model.pricing } : {}),
      ...(model.armorPrompt ? { armorPrompt: model.armorPrompt } : {}),
    }))
    if (models.some((model) => !model.id || /\s/.test(model.id))) {
      toast("每个模型都需要不含空格的 Model ID", "error")
      return null
    }
    return {
      id,
      custom: draft.custom === true,
      disabled: false,
      name: draft.name.trim() || undefined,
      npm: draft.npm?.trim() || undefined,
      api: draft.api?.trim() || undefined,
      baseURL: draft.baseURL?.trim() || undefined,
      driver: draft.driver,
      models,
      hiddenModels: draft.models.filter((model) => !model.enabled).map((model) => model.id),
    }
  }

  const save = async (reloadRuntime = false) => {
    const provider = readProvider()
    if (!provider) return
    if (!provider.id) {
      toast("Provider ID 不能为空", "error")
      return
    }
    setSaving(true)
    try {
      const result = await putJSON<{ provider: ProviderDetails }>(
        `/api/providers/${encodeURIComponent(provider.id)}`,
        { provider, apiKey: apiKey.trim() || undefined },
      )
      setApiKey("")
      setSelected(result.provider.id)
      setIsNew(false)
      setDraft(structuredClone(result.provider))
      const live = (data?.runtime.active ?? 0) > 0
      toast(
        reloadRuntime
          ? `Boom Runtime 已应用 Provider 配置并刷新模型目录${live ? "；使用该 Provider 的运行将在下一边界接管" : ""}`
          : `Provider 已保存，运行时已重载${live ? "；使用该 Provider 的运行将在下一边界接管" : ""}`,
      )
      await Promise.all([load(), refresh()])
    } catch (error) {
      toast(reloadRuntime ? `Boom Runtime 应用 Provider 失败：${(error as Error).message}` : (error as Error).message, "error")
    } finally {
      setSaving(false)
    }
  }

  const visible = useMemo(
    () =>
      providers.filter(
        (provider) =>
          !query || `${provider.name} ${provider.id}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [providers, query],
  )

  const removeProvider = async () => {
    if (!draft || isNew) return
    const action = draft.custom ? "删除" : "禁用"
    if (!window.confirm(`${action} Provider ${draft.name}（${draft.id}）？`)) return
    try {
      await del(`/api/providers/${encodeURIComponent(draft.id)}`)
      toast(`Provider 已${action}`)
      setDraft(null)
      setSelected("")
      await Promise.all([load(), refresh()])
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const removeCredential = async () => {
    if (!draft || isNew) return
    if (!window.confirm(`移除 ${draft.name} 的 Runtime 凭据？`)) return
    try {
      await del(`/api/providers/${encodeURIComponent(draft.id)}/credential`)
      toast("凭据已移除")
      await Promise.all([selectProvider(draft.id), refresh()])
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const startOAuth = async (method: number) => {
    if (!draft || isNew) return
    try {
      const result = await api<{ authorization: { method: string; instructions?: string } }>(
        `/api/providers/${encodeURIComponent(draft.id)}/oauth`,
        { method: "POST", body: JSON.stringify({ method }) },
      )
      let code: string | undefined
      if (result.authorization.method === "code") {
        code = window.prompt(
          `${result.authorization.instructions || "请在浏览器完成授权，然后粘贴授权码。"}\n\n授权页面已打开。`,
          "",
        ) ?? undefined
        if (code === undefined) return
      } else {
        window.alert(result.authorization.instructions || "授权页面已在浏览器打开。完成授权后返回 Boom，点击确定继续。")
      }
      const completed = await api<{ provider: ProviderDetails }>(
        `/api/providers/${encodeURIComponent(draft.id)}/oauth/callback`,
        { method: "POST", body: JSON.stringify({ method, code }) },
      )
      setDraft(structuredClone(completed.provider))
      toast("OAuth 登录已完成")
      await Promise.all([load(), refresh()])
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const oauthMethods = (draft?.authMethods ?? []).filter((method) => method.type === "oauth")

  return (
    <Modal
      title="Provider 与模型"
      subtitle="可随时修改；运行中使用该 Provider 的任务会在下一消息或工具结果边界保留上下文并接管。"
      icon={<Plug size={16} />}
      wide
      className="provider-modal"
      onClose={() => openDialog("settings")}
      nav={
        <nav className="modal-nav provider-nav">
          <div className="select-search" style={{ marginBottom: 6 }}>
            <Search size={13} />
            <input placeholder="搜索 Provider…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <button type="button" className="btn btn-tiny" onClick={newProvider}>
            <Plus size={12} /> 自定义
          </button>
          <div className="modal-nav-sep" />
          <div className="provider-list">
            {visible.map((provider) => (
              <button
                type="button"
                key={provider.id}
                className={`provider-item${provider.id === selected ? " selected" : ""}`}
                onClick={() => void selectProvider(provider.id)}
              >
                <span className="pname">
                  <i className={`status-dot${provider.disabled ? " error" : provider.connected ? " busy" : ""}`} />
                  <span>{provider.name}</span>
                  {provider.custom ? <span className="badge">自定义</span> : null}
                </span>
                <span className="pid">{provider.id}</span>
                <span className="pmeta">
                  {provider.disabled ? "已禁用" : provider.connected ? "已连接" : provider.configured ? "已配置" : "未连接"} ·{" "}
                  {provider.visibleModelCount}/{provider.modelCount} 模型可见
                </span>
              </button>
            ))}
            {loading ? <div className="empty">正在加载 Provider…</div> : visible.length === 0 ? <div className="empty">没有匹配的 Provider</div> : null}
          </div>
        </nav>
      }
      footer={
        <>
          <button type="button" className="btn btn-danger" disabled={!draft || isNew} onClick={() => void removeProvider()}>
            {draft?.custom ? "删除 Provider" : "禁用 Provider"}
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={() => (isNew ? newProvider() : draft ? void selectProvider(draft.id) : undefined)}>
            放弃修改
          </button>
          <button type="button" className="btn" disabled={!draft || saving} onClick={() => void save(true)}>
            应用并刷新 Boom Runtime
          </button>
          <button type="button" className="btn btn-primary" disabled={!draft || saving} onClick={() => void save(false)}>
            {saving ? "保存中…" : "保存并重载 Boom Runtime"}
          </button>
        </>
      }
    >
      {!draft ? (
        <div className="empty">
          {loading || detailLoading ? "正在加载 Provider 与模型…" : "从左侧选择 Provider 或新增 OpenAI-compatible API"}
        </div>
      ) : (
        <div className="provider-main">
          <div className="provider-title">
            <i className={`status-dot${draft.disabled ? " error" : draft.connected ? " busy" : ""}`} />
            <h3>{draft.name || "新 Provider"}</h3>
            <code>{draft.id || "尚未保存"}</code>
            <span className={`badge${draft.connected && !draft.disabled ? " good" : draft.disabled ? " bad" : ""}`}>
              {draft.custom ? "自定义" : "Boom 内置"}
            </span>
            <span className="badge">{draft.disabled ? "已禁用" : draft.connected ? "已连接" : "未连接"}</span>
          </div>
          <div className="grid-2" style={{ marginTop: 14 }}>
            <div className="field">
              <div className="field-label"><span className="req">Provider ID</span></div>
              <input className="input mono" value={draft.id} disabled={!isNew} placeholder="例如 siliconflow" onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
              {isNew ? <span className="field-hint">仅小写字母、数字、.、_、-；显示名称可使用中文。</span> : null}
            </div>
            <div className="field">
              <div className="field-label"><span>显示名称</span></div>
              <input className="input" value={draft.name ?? ""} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </div>
            <div className="field">
              <div className="field-label"><span>Native 协议 Driver</span></div>
              <Select
                value={draft.driver ?? "openai-compatible"}
                options={[
                  { value: "openai-compatible", label: "OpenAI-compatible", sub: "兼容 /v1 API" },
                  { value: "openai", label: "OpenAI Responses", sub: "OpenAI 官方协议" },
                  { value: "anthropic", label: "Anthropic Messages", sub: "Anthropic 协议" },
                ]}
                onChange={(value) => setDraft({ ...draft, driver: value as ProviderDetails["driver"] })}
                ariaLabel="Driver"
              />
            </div>
            <div className="field">
              <div className="field-label"><span>兼容 Runtime NPM Adapter</span></div>
              <input className="input mono" value={draft.npm ?? ""} disabled={!draft.custom} onChange={(event) => setDraft({ ...draft, npm: event.target.value })} />
            </div>
            <div className="field">
              <div className="field-label"><span>API / 文档地址（可选）</span></div>
              <input className="input mono" value={draft.api ?? ""} onChange={(event) => setDraft({ ...draft, api: event.target.value })} />
            </div>
            <div className="field">
              <div className="field-label"><span>Base URL</span></div>
              <input className="input mono" value={draft.baseURL ?? ""} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} />
              <span className="field-hint">
                默认在 URL 后拼接 /chat/completions；若网关本身已是完整端点（如赛方大模型网关，直接 POST 根地址），在末尾加 `!` 表示原样使用。
              </span>
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <div className="field-label"><span>API Key（留空不修改）</span></div>
              <span className="credential-row">
                <input className="input mono" type="password" autoComplete="new-password" placeholder="sk-…" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
                <button type="button" className="btn" disabled={isNew || !draft.connected} onClick={() => void removeCredential()}>
                  移除凭据
                </button>
              </span>
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <div className="field-label"><span>OAuth 登录</span></div>
              <div className="inline-row">
                {oauthMethods.length ? (
                  oauthMethods.map((method) => (
                    <button type="button" className="btn btn-tiny" key={method.index} onClick={() => void startOAuth(method.index)}>
                      {method.label}
                    </button>
                  ))
                ) : (
                  <span className="field-hint" style={{ margin: 0 }}>该 Provider 没有可用的 OAuth 登录方式，可使用 API Key 或本地配置。</span>
                )}
              </div>
            </div>
          </div>
          <div className="model-section-head">
            <div className="model-section-copy">
              <span className="model-section-title">
                <h3>可用模型</h3>
                <span className="count-badge">
                  {draft.models.filter((model) => model.enabled).length}/{draft.models.length} 显示
                </span>
              </span>
              <p>模型目录由 Boom Runtime 返回；内置目录复用兼容运行时，保存后会重载并刷新选择器。</p>
            </div>
            <button type="button" className="btn btn-tiny" onClick={() => setDraft({ ...draft, models: [...draft.models, { id: "", name: "", context: 300000, output: 16384, reasoning: false, attachment: false, armorPrompt: undefined, pricing: undefined, enabled: true, source: "custom" }] })}>
              <Plus size={12} /> 模型
            </button>
          </div>
          <div className="model-list">
            {draft.models.map((model, index) => (
              <div className={`model-card${model.enabled ? "" : " model-card-hidden"}`} key={`${model.id}-${index}`}>
                <div className="model-card-head">
                  <label className="model-visible-toggle" title="是否在 Boom 模型选择器中显示">
                    <input type="checkbox" checked={model.enabled} onChange={(event) => setModel(index, { enabled: event.target.checked })} />
                    <span>显示</span>
                  </label>
                  <label className="model-field">
                    <span>Model ID</span>
                    <input className="mono" value={model.id} title={model.id} disabled={model.source !== "custom"} placeholder="model-id" onChange={(event) => setModel(index, { id: event.target.value })} />
                  </label>
                  <label className="model-field">
                    <span>名称</span>
                    <input value={model.name} placeholder="模型名称" onChange={(event) => setModel(index, { name: event.target.value })} />
                  </label>
                  {model.source === "custom" ? (
                    <button
                      type="button"
                      className="btn btn-ghost model-remove"
                      aria-label={`删除模型 ${model.name || model.id || index + 1}`}
                      title="删除自定义模型"
                      onClick={() => setDraft({ ...draft, models: draft.models.filter((_, modelIndex) => modelIndex !== index) })}
                    >
                      <Trash2 size={15} />
                    </button>
                  ) : <span className="model-source-tag">目录模型</span>}
                </div>
                <div className="model-card-settings">
                  <label className="model-field">
                    <span>最大输出</span>
                    <input type="number" value={model.output || 16384} min={1} onChange={(event) => setModel(index, { output: Number(event.target.value) })} />
                  </label>
                  <label className="model-field">
                    <span>输入价格 <small>$/M</small></span>
                    <input type="number" min={0} step="0.000001" placeholder="未知" value={model.pricing?.input ?? ""} onChange={(event) => setModel(index, { pricing: { ...(model.pricing ?? { output: 0 }), input: Number(event.target.value) } })} />
                  </label>
                  <label className="model-field">
                    <span>输出价格 <small>$/M</small></span>
                    <input type="number" min={0} step="0.000001" placeholder="未知" value={model.pricing?.output ?? ""} onChange={(event) => setModel(index, { pricing: { ...(model.pricing ?? { input: 0 }), output: Number(event.target.value) } })} />
                  </label>
                  <div className="model-field">
                    <span>破甲提示词</span>
                    <Select
                      value={model.armorPrompt ?? ""}
                      options={[
                        { value: "", label: "不使用" },
                        ...armorPrompts.map((prompt) => ({ value: prompt.id, label: prompt.name })),
                      ]}
                      onChange={(value) => setModel(index, { armorPrompt: value || undefined })}
                      ariaLabel="破甲提示词"
                    />
                  </div>
                  <div className="model-field">
                    <span>能力</span>
                    <div className="model-caps">
                      <label title="推理模型"><input type="checkbox" checked={model.reasoning} onChange={(event) => setModel(index, { reasoning: event.target.checked })} />推理</label>
                      <label title="支持图片附件"><input type="checkbox" checked={model.attachment} onChange={(event) => setModel(index, { attachment: event.target.checked })} />图片</label>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {draft.models.length === 0 ? <div className="empty">还没有模型，请点击“＋ 模型”添加。</div> : null}
          </div>
        </div>
      )}
    </Modal>
  )
}
