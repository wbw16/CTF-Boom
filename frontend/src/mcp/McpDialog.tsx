import { useEffect, useState } from "react"
import { Cable, Plus } from "lucide-react"
import { useApp } from "../context"
import { api, del, putJSON } from "../api"
import { Modal, Segmented, Select, Toggle } from "../ui"
import type { McpServer, McpServerDetails } from "../types"

const AGENTS = ["boom", "boom-worker", "boom-consultant"]

export function McpDialog() {
  const { toast, openDialog } = useApp()
  const [servers, setServers] = useState<McpServerDetails[]>([])
  const [draft, setDraft] = useState<McpServerDetails | null>(null)
  const [selected, setSelected] = useState("")
  const [isNew, setIsNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [commandText, setCommandText] = useState("")
  const [environmentText, setEnvironmentText] = useState("")
  const [headersText, setHeadersText] = useState("")

  const applyDraft = (server: McpServerDetails) => {
    setDraft(structuredClone(server))
    setHeadersText(JSON.stringify(server.type === "remote" ? server.headers : {}, null, 2))
    setCommandText(JSON.stringify(server.type === "local" ? server.command : [], null, 2))
    setEnvironmentText(JSON.stringify(server.type === "local" ? server.environment : {}, null, 2))
  }

  useEffect(() => {
    void load()
  }, [])

  const load = async (select = "") => {
    try {
      const result = await api<{ servers: McpServerDetails[] }>("/api/mcp")
      setServers(result.servers)
      const next =
        result.servers.find((server) => server.id === select) ??
        result.servers.find((server) => server.id === selected) ??
        result.servers[0]
      if (!next) {
        newServer()
        return
      }
      setSelected(next.id)
      setIsNew(false)
      applyDraft(next)
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const newServer = () => {
    setSelected("")
    setIsNew(true)
    applyDraft({
      id: "",
      name: "",
      type: "remote",
      enabled: true,
      timeout: 5000,
      agents: ["boom", "boom-worker"],
      url: "",
      headers: {},
      oauth: false,
      runtime: { status: "尚未保存" },
    } as McpServerDetails)
  }

  const parseJSON = (text: string, fallback: unknown, kind: string): unknown => {
    const value = text.trim()
    if (!value) return structuredClone(fallback)
    try {
      return JSON.parse(value)
    } catch {
      toast(`${kind} 必须是有效 JSON`, "error")
      throw new Error(`${kind} 必须是有效 JSON`)
    }
  }

  const readServer = (): McpServer | null => {
    if (!draft) return null
    const id = draft.id.trim()
    if (!id) {
      toast("Server ID 不能为空", "error")
      return null
    }
    if (!draft.agents.length) {
      toast("至少允许一个 Boom Agent", "error")
      return null
    }
    const base = {
      id,
      name: draft.name.trim() || id,
      enabled: draft.enabled,
      timeout: Number(draft.timeout) || 5000,
      agents: draft.agents,
    }
    if (draft.type === "local") {
      const command = parseJSON(commandText, [], "命令")
      if (!Array.isArray(command) || !command.length || command.some((item) => typeof item !== "string")) {
        toast("本地命令必须是非空字符串数组", "error")
        return null
      }
      const environment = parseJSON(environmentText, {}, "环境变量映射")
      if (!environment || Array.isArray(environment) || typeof environment !== "object") {
        toast("环境变量映射必须是 JSON 对象", "error")
        return null
      }
      return { ...base, type: "local", command: command as string[], environment: environment as Record<string, string> }
    }
    const headers = parseJSON(headersText, {}, "HTTP Headers")
    if (!headers || Array.isArray(headers) || typeof headers !== "object") {
      toast("HTTP Headers 必须是 JSON 对象", "error")
      return null
    }
    return {
      ...base,
      type: "remote",
      url: draft.url.trim(),
      headers: headers as Record<string, string>,
      oauth: draft.oauth === false ? false : {},
    }
  }

  const save = async () => {
    const server = readServer()
    if (!server) return
    setSaving(true)
    try {
      const result = await putJSON<{ server: McpServerDetails }>(
        `/api/mcp/${encodeURIComponent(server.id)}`,
        { server },
      )
      setSelected(result.server.id)
      setIsNew(false)
      toast("MCP 配置已保存并重载 Boom Runtime")
      await load(result.server.id)
    } catch (error) {
      toast((error as Error).message, "error")
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    if (!selected || isNew) return
    try {
      const result = await api<{ status: { status: string } }>(
        `/api/mcp/${encodeURIComponent(selected)}/test`,
        { method: "POST", body: "{}" },
      )
      await load(selected)
      toast(`MCP 连接状态：${result.status.status}`)
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const remove = async () => {
    if (!selected || isNew) return
    if (!window.confirm(`删除 MCP Server ${selected}？`)) return
    try {
      await del(`/api/mcp/${encodeURIComponent(selected)}`)
      toast("MCP Server 已删除")
      setSelected("")
      await load("")
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const oauth = async () => {
    if (!selected || isNew) return
    try {
      await api(`/api/mcp/${encodeURIComponent(selected)}/oauth`, { method: "POST", body: "{}" })
      const code = window.prompt("浏览器授权完成后，粘贴授权码。若服务已自动完成回调，可取消。", "")
      if (code?.trim()) {
        await api(`/api/mcp/${encodeURIComponent(selected)}/oauth/callback`, {
          method: "POST",
          body: JSON.stringify({ code: code.trim() }),
        })
      }
      await load(selected)
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const removeOAuth = async () => {
    if (!selected || isNew) return
    try {
      await del(`/api/mcp/${encodeURIComponent(selected)}/oauth`)
      await load(selected)
      toast("MCP OAuth 凭据已移除")
    } catch (error) {
      toast((error as Error).message, "error")
    }
  }

  const status = draft?.runtime?.status || (isNew ? "尚未保存" : "unknown")
  const remoteOAuth = draft?.type === "remote" && draft.oauth !== false && !isNew

  return (
    <Modal
      title="MCP Server"
      subtitle="Boom 管理独立配置并注入隔离的 Boom Runtime；不会读取用户或项目 OpenCode MCP 配置。"
      icon={<Cable size={16} />}
      onClose={() => openDialog("settings")}
      footer={
        <>
          <span className="field-hint" style={{ margin: 0, flex: 1 }}>
            保存会重启空闲 Runtime。正在运行题目时不能修改 MCP 配置。
          </span>
          <button type="button" className="btn btn-danger" disabled={!selected || isNew} onClick={() => void remove()}>删除</button>
          <button type="button" className="btn" disabled={!selected || isNew} onClick={() => void test()}>测试连接</button>
          {remoteOAuth && status !== "connected" ? (
            <button type="button" className="btn" onClick={() => void oauth()}>OAuth 登录</button>
          ) : null}
          {remoteOAuth ? (
            <button type="button" className="btn" onClick={() => void removeOAuth()}>移除 OAuth</button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存并重载 Boom Runtime"}
          </button>
        </>
      }
    >
      <div className="card">
        <h3>服务器</h3>
        <div className="inline-row">
          <Select
            value={selected}
            options={servers.map((server) => ({
              value: server.id,
              label: `${server.name} · ${server.runtime?.status ?? "unknown"}`,
              sub: server.id,
            }))}
            onChange={(value) => {
              const server = servers.find((item) => item.id === value)
              if (server) {
                setSelected(value)
                setIsNew(false)
                applyDraft(server)
              }
            }}
            placeholder="— 选择已有 Server —"
            ariaLabel="MCP Server"
          />
          <button type="button" className="btn" onClick={() => void load()}>重新读取</button>
          <button type="button" className="btn" onClick={newServer}><Plus size={13} /> 新建</button>
        </div>
        <div className="platform-status" style={{ marginTop: 8 }}>
          <span className={`badge${status === "connected" ? " good" : status === "error" ? " bad" : ""}`}>{status}</span>
          <span>{draft?.name || "新 MCP Server"} · {draft?.type ?? "remote"}</span>
          {draft?.runtime?.error ? <span className="field-hint" style={{ color: "var(--red)" }}>{draft.runtime.error}</span> : null}
        </div>
      </div>
      <div className="card">
        <h3>配置</h3>
        <div className="grid-2">
          <div className="field">
            <div className="field-label"><span className="req">Server ID</span></div>
            <input className="input mono" value={draft?.id ?? ""} disabled={!isNew} onChange={(event) => setDraft({ ...draft!, id: event.target.value })} />
          </div>
          <div className="field">
            <div className="field-label"><span>显示名称</span></div>
            <input className="input" value={draft?.name ?? ""} onChange={(event) => setDraft({ ...draft!, name: event.target.value })} />
          </div>
          <div className="field">
            <div className="field-label"><span>连接类型</span></div>
            <Segmented
              name="mcp-type"
              layout="two"
              value={draft?.type ?? "remote"}
              onChange={(value) => {
                setDraft({ ...draft!, type: value } as McpServerDetails)
                if (value === "local") setCommandText(JSON.stringify((draft as McpServerDetails & { command?: string[] })?.command ?? [], null, 2))
                else setHeadersText(JSON.stringify((draft as McpServerDetails & { headers?: Record<string, string> })?.headers ?? {}, null, 2))
              }}
              options={[
                { value: "remote", label: "远程 HTTP", desc: "URL + Headers + OAuth" },
                { value: "local", label: "本地进程", desc: "命令数组 + 环境映射" },
              ]}
            />
          </div>
          <div className="field">
            <div className="field-label"><span>请求超时（毫秒）</span></div>
            <div className="num-wrap">
              <input type="number" min={100} max={120000} value={draft?.timeout ?? 5000} onChange={(event) => setDraft({ ...draft!, timeout: Number(event.target.value) })} />
              <span className="unit">ms</span>
            </div>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <Toggle
              checked={draft?.enabled ?? true}
              onChange={(checked) => setDraft({ ...draft!, enabled: checked })}
              title="Runtime 启动时自动连接"
            />
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <div className="field-label"><span className="req">可调用此 Server 的 Boom Agent</span></div>
            <div className="inline-row">
              {AGENTS.map((agent) => (
                <label key={agent} style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--mu)", font: "10px var(--mono)" }}>
                  <input
                    type="checkbox"
                    checked={draft?.agents.includes(agent) ?? false}
                    onChange={(event) => {
                      const agents = event.target.checked
                        ? [...(draft?.agents ?? []), agent]
                        : (draft?.agents ?? []).filter((item) => item !== agent)
                      setDraft({ ...draft!, agents })
                    }}
                  />
                  {agent}
                </label>
              ))}
            </div>
          </div>
          {draft?.type === "remote" ? (
            <>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <div className="field-label"><span>远程 MCP URL</span></div>
                <input className="input mono" value={draft.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => setDraft({ ...draft!, url: event.target.value })} />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <div className="field-label"><span>HTTP Headers（JSON；敏感值必须使用 {"{env:NAME}"}）</span></div>
                <textarea className="textarea mono" rows={4} value={headersText} placeholder='{"Authorization":"Bearer {env:GITHUB_TOKEN}"}' onChange={(event) => setHeadersText(event.target.value)} />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <Toggle
                  checked={draft.oauth !== false}
                  onChange={(checked) => setDraft({ ...draft!, oauth: checked ? {} : false })}
                  title="允许 Boom Runtime 自动发现 OAuth"
                />
              </div>
            </>
          ) : (
            <>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <div className="field-label"><span>命令与参数（JSON 数组，不经 Shell）</span></div>
                <textarea className="textarea mono" rows={4} value={commandText} placeholder='["npx","-y","@modelcontextprotocol/server-filesystem","/data"]' onChange={(event) => setCommandText(event.target.value)} />
              </div>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <div className="field-label"><span>环境变量映射（JSON：目标变量 → 宿主变量名）</span></div>
                <textarea className="textarea mono" rows={4} value={environmentText} placeholder='{"GITHUB_TOKEN":"GITHUB_TOKEN"}' onChange={(event) => setEnvironmentText(event.target.value)} />
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
