import { useEffect, useState } from "react"
import { Send } from "lucide-react"
import { useApp } from "../context"
import { api, postJSON, putJSON } from "../api"
import { Modal, Select } from "../ui"
import { parseVariables } from "../format"
import type {
  PlatformCatalog,
  PlatformCatalogItem,
  PlatformCredential,
  PlatformManifest,
  PlatformSummary,
} from "../types"

export function PlatformsDialog() {
  const { toast, refresh, openDialog } = useApp()
  const [platforms, setPlatforms] = useState<PlatformSummary[]>([])
  const [selected, setSelected] = useState("")
  const [manifest, setManifest] = useState<PlatformManifest | null>(null)
  const [manifestText, setManifestText] = useState("")
  const [warnings, setWarnings] = useState("")
  const [credential, setCredential] = useState<PlatformCredential | undefined>()
  const [variablesText, setVariablesText] = useState("")
  const [catalog, setCatalog] = useState<PlatformCatalog>({
    items: [],
    page: 0,
    pageSize: 50,
    total: 0,
    categories: [],
    difficulties: [],
  })
  const [selection, setSelection] = useState<{ all: boolean; ids: Set<string> }>({
    all: false,
    ids: new Set(),
  })
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState("")
  const [difficulty, setDifficulty] = useState("")
  const [saving, setSaving] = useState(false)

  const [genID, setGenID] = useState("")
  const [genName, setGenName] = useState("")
  const [genDocument, setGenDocument] = useState("")
  const [genBaseURL, setGenBaseURL] = useState("")
  const [genForce, setGenForce] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  const load = async (select = "") => {
    try {
      const result = await api<{ platforms: PlatformSummary[] }>("/api/platforms")
      setPlatforms(result.platforms)
      const next =
        result.platforms.find((platform) => platform.id === select) ??
        result.platforms.find((platform) => platform.id === selected) ??
        result.platforms[0]
      await selectPlatform(next?.id ?? "")
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const resetCatalog = () => {
    setCatalog({ items: [], page: 0, pageSize: 50, total: 0, categories: [], difficulties: [] })
    setSelection({ all: false, ids: new Set() })
    setCatalogLoaded(false)
    setSearch("")
    setCategory("")
    setDifficulty("")
  }

  const selectPlatform = async (id: string) => {
    setSelected(id)
    resetCatalog()
    const summary = platforms.find((platform) => platform.id === id)
    if (!id) {
      setManifest(null)
      setManifestText("")
      setWarnings("")
      setCredential(undefined)
      return
    }
    try {
      const result = await api<{ manifest: PlatformManifest; credential?: PlatformCredential }>(
        `/api/platforms/${encodeURIComponent(id)}`,
      )
      setManifest(result.manifest)
      setManifestText(JSON.stringify(result.manifest, null, 2))
      setGenID(result.manifest.id)
      setGenName(result.manifest.name ?? "")
      setWarnings("")
      setCredential(result.credential)
    } catch (error) {
      setManifest(null)
      setManifestText("")
      setWarnings((error as Error).message)
      toast((error as Error).message, "error")
    }
  }

  const adapt = async () => {
    if (!genID.trim() || !genDocument.trim()) {
      toast("请填写 Adapter ID 和接口文档地址", "error")
      return
    }
    setSaving(true)
    try {
      const result = await postJSON<{ manifest: PlatformManifest; warnings?: string[] }>(
        "/api/platforms/adapt",
        {
          id: genID.trim(),
          document: genDocument.trim(),
          name: genName.trim() || undefined,
          baseURL: genBaseURL.trim() || undefined,
          force: genForce,
        },
      )
      await load(result.manifest.id)
      setWarnings(
        result.warnings?.length
          ? result.warnings.map((warning) => `• ${warning}`).join("\n")
          : "自动推断没有留下警告；仍建议在首次同步前检查清单。",
      )
      toast(`适配器 ${result.manifest.id} 已生成：${result.manifest.status}`)
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setSaving(false)
    }
  }

  const saveManifest = async () => {
    if (!selected) {
      toast("请先选择或生成一个适配器", "error")
      return
    }
    let parsed: PlatformManifest
    try {
      parsed = JSON.parse(manifestText) as PlatformManifest
    } catch (error) {
      toast(`JSON 格式错误：${(error as Error).message}`, "error")
      return
    }
    setSaving(true)
    try {
      const result = await putJSON<{ manifest: PlatformManifest }>(
        `/api/platforms/${encodeURIComponent(selected)}`,
        { manifest: parsed },
      )
      await load(result.manifest.id)
      toast(`适配器 ${selected} 已保存`)
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setSaving(false)
    }
  }

  const query = () => ({
    page: catalog.page || 1,
    pageSize: catalog.pageSize || 50,
    search: search.trim() || undefined,
    category: category || undefined,
    difficulty: difficulty || undefined,
  })

  const loadCatalog = async (page = 1, resetSelection = false) => {
    if (!selected) {
      toast("请先选择或生成一个适配器", "error")
      return
    }
    setSaving(true)
    try {
      if (resetSelection) setSelection({ all: false, ids: new Set() })
      const variables = parseVariables(variablesText)
      const result = await postJSON<PlatformCatalog>(
        `/api/platforms/${encodeURIComponent(selected)}/catalog`,
        { variables, query: query() },
      )
      setCatalog(result)
      setCatalogLoaded(true)
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setSaving(false)
    }
  }

  const toggleItem = (id: string, checked: boolean) => {
    setSelection((current) => {
      const ids = new Set(current.ids)
      if (current.all) {
        if (checked) ids.delete(id)
        else ids.add(id)
      } else if (checked) ids.add(id)
      else ids.delete(id)
      return { ...current, ids }
    })
  }

  const selectionCount = selection.all
    ? Math.max(0, catalog.total - selection.ids.size)
    : selection.ids.size

  const itemSelected = (id: string) =>
    selection.all ? !selection.ids.has(id) : selection.ids.has(id)

  const sync = async () => {
    if (!selected) {
      toast("请先选择一个适配器", "error")
      return
    }
    if (!catalogLoaded || selectionCount === 0) {
      toast("请先获取清单并选择至少一道题目", "error")
      return
    }
    setSaving(true)
    try {
      const variables = parseVariables(variablesText)
      const { page: _page, pageSize: _pageSize, ...rest } = query()
      const body = selection.all
        ? { variables, selection: { all: true, exclude: [...selection.ids], query: rest } }
        : { variables, selection: { ids: [...selection.ids] } }
      const result = await postJSON<{ challenges: string[] }>(
        `/api/platforms/${encodeURIComponent(selected)}/sync`,
        body,
      )
      await refresh()
      await load(selected)
      toast(`已同步 ${result.challenges.length} 道题目`)
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setSaving(false)
    }
  }

  const pages = catalog.total ? Math.ceil(catalog.total / catalog.pageSize) : 0
  const summary = platforms.find((platform) => platform.id === selected)
  const capabilities = summary
    ? [
        summary.listChallenges === false ? "无远端清单" : "可选择同步",
        summary.acquireChallenges === false ? "无题目下载" : "题目下载",
        summary.submitFlag ? "flag 提交" : "无自动提交",
      ].join(" · ")
    : ""
  const credentialText = credential
    ? `${credential.configured ? "凭证已配置" : "凭证未配置"}：${credential.env}`
    : "接口未声明凭证"

  return (
    <Modal
      title="比赛接口适配"
      subtitle="题目下载与 flag 提交共享同一份声明式清单；凭证仍只从环境变量读取。"
      icon={<Send size={16} />}
      onClose={() => openDialog("settings")}
      footer={
        <>
          <span className="field-hint" style={{ margin: 0, flex: 1 }}>
            {summary?.status ? `状态 ${summary.status}` : ""}
          </span>
          <button type="button" className="btn btn-primary" disabled={!catalogLoaded || selectionCount === 0 || saving} onClick={() => void sync()}>
            同步所选
          </button>
        </>
      }
    >
      <div className="card">
        <h3>已有适配器</h3>
        <div className="inline-row">
          <Select
            value={selected}
            options={platforms.map((platform) => ({
              value: platform.id,
              label: `${platform.name || platform.id} · ${platform.id}`,
              sub: platform.status,
              tag: platform.status,
              tagKind: platform.status === "ready" ? "ok" : "off",
            }))}
            onChange={(value) => void selectPlatform(value)}
            placeholder="— 选择已有适配器 —"
            ariaLabel="已有适配器"
          />
          <button type="button" className="btn" onClick={() => void load()}>重新读取</button>
        </div>
        <div className="platform-status" style={{ marginTop: 8 }}>
          <span className={`badge${summary?.status === "ready" ? " good" : " bad"}`}>{summary?.status ?? "未选择"}</span>
          <span>{capabilities}</span>
          <span>{credentialText}</span>
          {summary?.error ? <span className="field-hint" style={{ color: "var(--red)" }}>{summary.error}</span> : null}
        </div>
      </div>

      <div className="card">
        <h3>从接口文档生成</h3>
        <div className="grid-2">
          <div className="field">
            <div className="field-label"><span className="req">Adapter ID</span></div>
            <input className="input mono" value={genID} onChange={(event) => setGenID(event.target.value)} />
          </div>
          <div className="field">
            <div className="field-label"><span>显示名称（可选）</span></div>
            <input className="input" value={genName} onChange={(event) => setGenName(event.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <div className="field-label"><span className="req">OpenAPI / Swagger URL 或本地文件路径</span></div>
            <input className="input mono" value={genDocument} placeholder="https://ctf.example/openapi.json" onChange={(event) => setGenDocument(event.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <div className="field-label"><span>Base URL（文档未声明或需要覆盖时填写）</span></div>
            <input className="input mono" value={genBaseURL} placeholder="https://ctf.example/api" onChange={(event) => setGenBaseURL(event.target.value)} />
          </div>
          <label className="switch-row" style={{ gridColumn: "1 / -1", margin: 0 }}>
            <input className="switch-input" type="checkbox" checked={genForce} onChange={(event) => setGenForce(event.target.checked)} />
            <span className="switch-track"><span className="switch-thumb" /></span>
            <span className="switch-body"><b>覆盖同 ID 的现有清单</b></span>
          </label>
        </div>
        <div className="inline-row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void adapt()}>读取文档并生成</button>
        </div>
      </div>

      <div className="card">
        <h3>检查与同步</h3>
        <p className="note" style={{ margin: "0 0 10px" }}>
          自动推断不确定时清单会保持 draft。检查字段路径与提交判定后，再手动将 status 改为 ready 并保存。
        </p>
        <pre className="platform-warnings">{warnings}</pre>
        <div className="grid-2">
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <div className="field-label"><span className="req">声明式适配器 JSON</span></div>
            <textarea className="textarea mono" rows={9} value={manifestText} onChange={(event) => setManifestText(event.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <div className="field-label"><span>本次同步变量，每行 name=value（例如 game_id=42）</span></div>
            <textarea className="textarea mono" rows={3} placeholder="game_id=42" value={variablesText} onChange={(event) => setVariablesText(event.target.value)} />
          </div>
        </div>
        <div className="inline-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" disabled={!selected || saving} onClick={() => void saveManifest()}>保存清单</button>
        </div>
      </div>

      <div className="card">
        <h3>远端题目清单</h3>
        <p className="note" style={{ margin: "0 0 10px" }}>
          先获取题目元数据，再选择需要同步的题目；只有点击“同步所选”后才会获取题面和附件。
        </p>
        <div className="platform-tools">
          <input className="input" placeholder="搜索题目名称或描述" value={search} onChange={(event) => setSearch(event.target.value)} />
          <Select
            value={category}
            options={[{ value: "", label: "全部分类" }, ...catalog.categories.map((value) => ({ value, label: value }))]}
            onChange={setCategory}
            ariaLabel="题目分类"
          />
          <Select
            value={difficulty}
            options={[{ value: "", label: "全部难度" }, ...catalog.difficulties.map((value) => ({ value, label: value }))]}
            onChange={setDifficulty}
            ariaLabel="题目难度"
          />
          <button type="button" className="btn" disabled={saving} onClick={() => void loadCatalog(1, true)}>获取题目清单</button>
        </div>
        <div className="inline-row" style={{ margin: "10px 0" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--tx)", fontSize: 11 }}>
            <input type="checkbox" checked={selection.all} onChange={(event) => setSelection({ all: event.target.checked, ids: new Set() })} />
            全选当前筛选结果
          </label>
          <button type="button" className="btn btn-tiny" onClick={() => setSelection({ all: false, ids: new Set() })}>清空选择</button>
          <span className="field-hint" style={{ margin: 0 }}>
            {catalogLoaded ? `共 ${catalog.total} 道，已选择 ${selectionCount} 道` : "尚未获取远端题目"}
          </span>
        </div>
        <div className="platform-list">
          {catalog.items.length ? (
            catalog.items.map((item: PlatformCatalogItem) => {
              const metadata = [item.group?.name, item.category, item.difficulty, item.solved ? "已解出" : ""]
                .filter(Boolean)
                .join(" · ")
              return (
                <label className="platform-challenge" key={item.id}>
                  <input
                    type="checkbox"
                    checked={itemSelected(item.id)}
                    onChange={(event) => toggleItem(item.id, event.target.checked)}
                  />
                  <span className="platform-challenge-main">
                    <span className="platform-challenge-title">{item.title}</span>
                    <span className="platform-challenge-meta">{metadata || item.challengeID}</span>
                  </span>
                  <span className="platform-challenge-points">{item.points == null ? "" : `${item.points} pts`}</span>
                </label>
              )
            })
          ) : (
            <div className="empty">
              {catalogLoaded ? "当前筛选条件下没有题目" : "点击“获取题目清单”后选择要同步的题目"}
            </div>
          )}
        </div>
        <div className="pager" style={{ marginTop: 10 }}>
          <button type="button" className="btn btn-tiny" disabled={!catalogLoaded || catalog.page <= 1 || saving} onClick={() => void loadCatalog(catalog.page - 1)}>上一页</button>
          <span>第 {catalog.page || 0} / {pages} 页</span>
          <button type="button" className="btn btn-tiny" disabled={!catalogLoaded || catalog.page >= pages || saving} onClick={() => void loadCatalog(catalog.page + 1)}>下一页</button>
        </div>
      </div>
    </Modal>
  )
}
