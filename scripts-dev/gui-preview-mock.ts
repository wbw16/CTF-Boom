/**
 * Standalone preview server for the rebuilt GUI: serves frontend/dist against a mock API with
 * realistic sample data for both product modes. For visual verification only — never shipped.
 *   bun scripts-dev/gui-preview-mock.ts [port]
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const DIST = new URL("../frontend/dist", import.meta.url).pathname
const PORT = Number(process.argv[2] ?? 5177)

const now = Date.now()
const iso = (offsetMin: number) => new Date(now - offsetMin * 60_000).toISOString()

const settings = {
  mode: "ctf",
  economyModel: "gpt-5-mini",
  strongModel: "claude-sonnet-4",
  tokens: 400_000,
  tokenBudgetEnabled: true,
  repeats: 3,
  minutes: 25,
  concurrency: 6,
  flagFormat: "flag\\{[^}]*\\}",
  executionMode: "managed",
  consultModels: ["gpt-5-mini", "claude-sonnet-4"],
  blindReview: false,
  consultOnCompaction: true,
  network: "allow",
  competition: { platformId: "dasctf", remoteSlots: 4, localSlots: 5, refreshIntervalMinutes: 10, matchMinutes: 240, endgameMinutes: 30, deadline: now + 6_136_000 },
}

const runtime = { status: "ready", active: 1, queued: 0, concurrency: 6, backend: "opencode", version: "0.15.0", promptVersion: "v3" }

const environments = {
  version: 1,
  defaultProfileId: "py312",
  profiles: [{
    id: "py312", displayName: "python-3.12-ctf", kind: "conda", interpreter: "/opt/conda/bin/python",
    prefix: "/opt/conda/envs/ctf", pythonVersion: "3.12.4", architecture: "arm64",
    packages: { pwntools: "4.14.0" }, installPolicy: "allow", fingerprint: "abc123", status: "ready",
  }],
}

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run-004",
    model: "claude-sonnet-4",
    stop: "completed",
    tokens: 31_842,
    billableTokens: 30_100,
    cost: 0.184,
    candidates: ["flag{schema_paths_are_not_secrets}"],
    primaryCandidate: "flag{schema_paths_are_not_secrets}",
    candidateSource: "regex",
    verification: { level: "local-checker", detail: "本地校验通过" },
    flagFormat: settings.flagFormat,
    reply: "Flag 来自 schema 中对象依赖关系的有序拼接，已用独立脚本复现并通过格式校验。",
    startedAt: iso(64),
    finishedAt: iso(2),
    durationMs: 3_720_000,
    lastTool: "bash",
    events: [
      { at: 0, type: "status", status: "start", text: "创建任务并绑定 python-3.12-ctf 环境" },
      { at: 1_000, type: "tool", tool: "inspect", status: "completed", text: "读取附件 app.js、schema.graphql、README.txt" },
      { at: 12_000, type: "text", text: "入口返回 Apollo Server 指纹，将从通用探测切到 GraphQL 只读验证。" },
      { at: 15_000, type: "tool", tool: "curl", status: "completed", text: "POST /graphql · introspection query · HTTP 200" },
      { at: 30_000, type: "usage", tokens: 12_400, cost: 0.07 },
      { at: 42_000, type: "status", status: "checkpoint", text: "确认 introspection 结果包含 18 个自定义对象" },
      { at: 55_000, type: "tool", tool: "python", status: "completed", text: "对 schema 字段进行拓扑排序并还原路径 · exit 0" },
      { at: 58_000, type: "status", status: "candidate", text: "提取候选 flag{schema_paths_are_not_secrets}" },
    ],
    notes: "# web-graphql-vault\n\n目标是从 GraphQL schema 中恢复隐藏路径。服务允许未认证 introspection，但直接查询 `flag` 字段会被 resolver 拒绝。\n\n## 已确认\n\n18 个自定义对象通过 `nextType` 构成单向关系；按依赖顺序拼接对象首字母得到隐藏 resolver 名称。\n\n## 复现\n\n运行 `work/solve.py`，读取保存的 `work/schema.json`，输出与候选 Flag 一致。\n\n## 已排除\n\nSQL 注入与 alias batching 均无效，不再重复尝试。",
    writeup: "# Writeup · web-graphql-vault\n\n1. 未认证 introspection 拿到完整 schema（18 个自定义对象）。\n2. 对象通过 `nextType` 构成单向依赖图，拓扑排序。\n3. 按依赖序拼接对象首字母得到隐藏 resolver 名称，读取 flag 字段。\n\n`flag{schema_paths_are_not_secrets}`",
    files: [
      { path: "attachments", size: 0, directory: true },
      { path: "attachments/schema.graphql", size: 18_432, directory: false },
      { path: "attachments/app.js", size: 9_216, directory: false },
      { path: "attachments/README.txt", size: 1_024, directory: false },
      { path: "work", size: 0, directory: true },
      { path: "work/solve.py", size: 2_048, directory: false },
      { path: "work/schema.json", size: 85_940, directory: false },
      { path: "NOTES.md", size: 3_072, directory: false },
    ],
    taskStatus: "solved",
    acceptedFlag: "flag{schema_paths_are_not_secrets}",
    turns: [
      { id: "t1", model: "claude-sonnet-4", startedAt: iso(64), finishedAt: iso(40), stop: "completed", tokens: 14_200, billableTokens: 13_500, cost: 0.08, candidates: [], prompt: "开始分析附件" },
      { id: "t2", model: "claude-sonnet-4", startedAt: iso(40), finishedAt: iso(2), stop: "completed", tokens: 17_642, billableTokens: 16_600, cost: 0.104, candidates: ["flag{schema_paths_are_not_secrets}"] },
    ],
    rejectedFlags: ["flag{graphql_is_fun}"],
    candidateHistory: ["flag{graphql_is_fun}", "schema_paths_are_not_secrets"],
    consultation: {
      trigger: "operator",
      expertModels: ["gpt-5-mini", "claude-sonnet-4"],
      synthesizerModel: "claude-sonnet-4",
      tokens: 8_400, billableTokens: 8_000, cost: 0.05,
      plans: [
        { model: "gpt-5-mini", text: "先做 introspection，注意别名深度限制。" },
        { model: "claude-sonnet-4", text: "检查对象关系字段 nextType，可能是拓扑序拼接。" },
      ],
      merged: { model: "claude-sonnet-4", text: "按依赖图拼接 resolver 名称，写脚本验证。" },
    },
    environment: {
      profileId: "py312", displayName: "python-3.12-ctf", kind: "conda", interpreter: "/opt/conda/bin/python",
      pythonVersion: "3.12.4", architecture: "arm64", packages: {}, installPolicy: "allow",
      fingerprint: "abc123", source: "default", executionMode: "managed", boundAt: iso(64),
    },
    ...over,
  }
}

const challenges = [
  {
    slug: "web-graphql-vault", category: "WEB", storagePath: "WEB/web-graphql-vault", difficulty: "Hard",
    description: "GraphQL introspection", serviceRequired: false,
    files: [{ path: "schema.graphql", size: 18_432, directory: false }, { path: "app.js", size: 9_216, directory: false }, { path: "README.txt", size: 1_024, directory: false }],
    runs: [run()],
  },
  {
    slug: "web-cache-maze", category: "WEB", storagePath: "WEB/web-cache-maze", difficulty: "Medium",
    files: [{ path: "app.py", size: 4_096, directory: false }],
    runs: [run({ id: "run-006", stop: "running", taskStatus: undefined, acceptedFlag: undefined, candidates: [], primaryCandidate: undefined, lastTool: "bash", tokens: 9_120, cost: 0.05, reply: "正在分析缓存键生成逻辑", writeup: "", notes: "# web-cache-maze\n\n分析中。", acceptedFlag: undefined as never, events: run().events.slice(0, 4) })],
  },
  {
    slug: "web-tiny-upload", category: "WEB", storagePath: "WEB/web-tiny-upload", difficulty: "Easy",
    files: [{ path: "upload.py", size: 2_048, directory: false }, { path: "Dockerfile", size: 512, directory: false }],
    runs: [run({ id: "run-002", taskStatus: "archived", confirmedFlag: "flag{tiny_upload_rce}" , acceptedFlag: "flag{tiny_upload_rce}", candidates: ["flag{tiny_upload_rce}"], primaryCandidate: "flag{tiny_upload_rce}", stop: "completed" })],
  },
  {
    slug: "pwn-silent-heap", category: "PWN", storagePath: "PWN/pwn-silent-heap", difficulty: "Hard",
    files: [{ path: "chall", size: 16_384, directory: false }, { path: "libc.so.6", size: 1_900_000, directory: false }],
    runs: [],
  },
  {
    slug: "pwn-armory", category: "PWN", storagePath: "PWN/pwn-armory", difficulty: "Medium",
    files: [{ path: "chall", size: 12_288, directory: false }],
    runs: [run({ id: "run-007", stop: "running", taskStatus: undefined, acceptedFlag: undefined as never, candidates: [], primaryCandidate: undefined, tokens: 4_420, cost: 0.02, reply: "检查保护与堆布局" })],
  },
  {
    slug: "crypto-orbit", category: "CRYPTO", storagePath: "CRYPTO/crypto-orbit", difficulty: "Medium",
    files: [{ path: "task.sage", size: 3_072, directory: false }],
    runs: [run({ id: "run-003", taskStatus: "archived", confirmedFlag: "flag{orbit_lattice}" , acceptedFlag: "flag{orbit_lattice}", candidates: ["flag{orbit_lattice}"], primaryCandidate: "flag{orbit_lattice}" })],
  },
  {
    slug: "rev-glass-box", category: "REVERSE", storagePath: "REVERSE/rev-glass-box", difficulty: "Hard",
    files: [{ path: "crackme", size: 24_576, directory: false }],
    runs: [],
  },
  {
    slug: "misc-graphql-notes", category: "MISC", storagePath: "MISC/misc-graphql-notes", difficulty: "Easy",
    files: [{ path: "notes.txt", size: 512, directory: false }],
    runs: [run({ id: "run-008", stop: "timeout", taskStatus: undefined, acceptedFlag: undefined as never, candidates: [], primaryCandidate: undefined, detail: "运行超时（25 分钟）", tokens: 51_200, cost: 0.3, reply: "" })],
  },
]

let state = {
  instanceID: "preview-1",
  sequence: 1,
  root: "/Volumes/Storage/Code/boom-preview",
  settings,
  models: [
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", connected: true },
    { id: "gpt-5-mini", name: "GPT-5 mini", connected: true },
  ],
  runtime,
  environments,
  challenges,
}

const pentestEngagement = {
  version: 1,
  slug: "eng-001",
  target: "api.acme-labs.cn",
  objective: "验证外网 API 暴露面与访问控制",
  authorization: "operator-declared",
  scope: ["api.acme-labs.cn", "10.24.8.0/24"],
  mode: "assessment",
  status: "active",
  counters: { asset: 18, observation: 11, finding: 4, evidence: 6, run: 4 },
  createdAt: iso(600),
  updatedAt: iso(4),
  assets: [
    { id: "asset-001", type: "root-domain", value: "acme-labs.cn", meta: "", at: iso(300) },
    { id: "asset-007", type: "endpoint", value: "https://api.acme-labs.cn/graphql", meta: "POST · Apollo", parentId: "asset-002", at: iso(120) },
    { id: "asset-012", type: "service", value: "tcp/8443 api-gateway", meta: "TLS 1.3", at: iso(90) },
  ],
  observations: [
    { id: "obs-003", kind: "http", target: "https://api.acme-labs.cn", detail: "Apollo Server 指纹，/graphql 接受 POST", confidence: 0.9, at: iso(60) },
    { id: "obs-011", kind: "vuln", target: "/graphql", detail: "未认证 introspection 可用", confidence: 0.95, at: iso(30) },
  ],
  evidence: [
    { id: "ev-004", provenance: "tool-run", path: "work/recon.xml", excerpt: "<port portid=\"443\"><state state=\"open\"/>", note: "nmap 服务探测", at: iso(45) },
    { id: "ev-005", provenance: "tool-run", path: "work/error.json", excerpt: "/srv/app/src/resolvers/user.ts:84", note: "错误响应泄露路径", at: iso(20) },
    { id: "ev-006", provenance: "tool-run", path: "work/introspection.json", excerpt: "__schema.types: 18", note: "introspection 响应", at: iso(10) },
  ],
  findings: [
    {
      id: "finding-001", title: "GraphQL introspection 在生产环境公开", severity: "high", status: "candidate",
      description: "未认证请求可获取完整 schema，其中包含内部管理对象与字段命名。该发现本身不等同于数据泄露，但显著降低了后续攻击成本。",
      evidenceIds: ["ev-004", "ev-006"], reproducibleSteps: ["向 /graphql 发送未认证 POST", "查询 __schema 字段", "确认响应包含内部对象定义"],
      affectedAssetId: "asset-007", at: iso(30),
    },
    {
      id: "finding-002", title: "API 错误响应泄露内部包路径", severity: "medium", status: "candidate",
      description: "构造错误变量类型后，响应返回服务端 TypeScript 包路径及 resolver 文件名。",
      evidenceIds: ["ev-005"], reproducibleSteps: ["向用户查询传入数组类型 ID", "检查 JSON 错误体的 stack 字段"],
      affectedAssetId: "asset-012", at: iso(20),
    },
    { id: "finding-003", title: "管理面板弱口令策略", severity: "low", status: "confirmed", description: "已确认。", evidenceIds: ["ev-004"], reproducibleSteps: ["x"], at: iso(200), decidedAt: iso(150) },
  ],
  flagObjectives: [],
  run: {
    phase: "running", turns: 3, startedAt: iso(40), lastEndedAt: iso(1),
    lastError: undefined, lastReply: "已确认目标使用 Apollo GraphQL。正在对 schema 可见性与对象级授权做低影响验证；下一步将对 /graphql 的两个候选对象执行只读请求。",
    checkpointAt: iso(30), checkpointNote: "已保存 introspection 结果；下一步只读验证未开始。",
  },
}

const pentestEngagement2 = {
  slug: "eng-002", target: "10.10.20.15", objective: "获取 Web 与内网横向 Flag", authorization: "operator-declared",
  scope: ["10.10.20.15"], mode: "flag-hunt", status: "active",
  run: { phase: "paused", turns: 5, lastEndedAt: iso(300), lastError: undefined },
  counts: { assets: 9, observations: 6, findings: 2, candidates: 0, confirmed: 1, runs: 3, flags: 3, flagCandidates: 1, flagsConfirmed: 1 },
  createdAt: iso(2000), updatedAt: iso(300),
}

/** Flag-hunt engagement: one confirmed objective, one waiting on a decision, one not taken yet. */
const pentestFlagEngagement = {
  version: 1,
  slug: "eng-002",
  target: "10.10.20.15",
  objective: "获取 Web 与内网横向 Flag",
  authorization: "operator-declared",
  scope: ["10.10.20.15"],
  mode: "flag-hunt",
  status: "active",
  counters: { asset: 9, observation: 6, finding: 2, evidence: 5, run: 3 },
  createdAt: iso(2000),
  updatedAt: iso(4),
  assets: [
    { id: "asset-001", type: "ip", value: "10.10.20.15", meta: "Linux 5.15", at: iso(900) },
    { id: "asset-004", type: "service", value: "tcp/8080 tomcat", meta: "Tomcat 9.0.85", parentId: "asset-001", at: iso(700) },
    { id: "asset-006", type: "endpoint", value: "http://10.10.20.15:8080/manager", meta: "管理后台", parentId: "asset-004", at: iso(600) },
  ],
  observations: [
    { id: "obs-002", kind: "http", target: "http://10.10.20.15:8080", detail: "Tomcat 管理后台默认页，未改 banner", confidence: 0.9, at: iso(650) },
    { id: "obs-005", kind: "vuln", target: "/manager/html", detail: "弱口令 tomcat/tomcat 可登录", confidence: 0.85, at: iso(320) },
  ],
  evidence: [
    { id: "ev-101", provenance: "tool-run", path: "work/manager.png", note: "管理后台登录成功截图", at: iso(300) },
    { id: "ev-102", provenance: "tool-run", path: "work/deploy.war", excerpt: "PUT /manager/deploy", note: "WAR 部署接口可用", at: iso(120) },
    { id: "ev-103", provenance: "tool-run", path: "work/ssh-key", excerpt: "id_rsa BEGIN OPENSSH PRIVATE KEY", note: "Web 主机上的运维私钥", at: iso(30) },
  ],
  findings: [
    {
      id: "finding-101", title: "内部管理后台使用默认口令", severity: "high", status: "candidate",
      description: "Tomcat 管理后台保留出厂口令，且可从 Web 主机跳转至内网网段。",
      evidenceIds: ["ev-101", "ev-102"], reproducibleSteps: ["访问 /manager/html", "使用 tomcat/tomcat 登录", "上传 WAR 验证部署权限"],
      affectedAssetId: "asset-006", at: iso(120),
    },
  ],
  flagObjectives: [
    {
      id: "flag-001", label: "Flag 1 · Web 入口", hint: "站点根目录或常见路径",
      submissions: [{
        id: "sub-001", value: "flag{w3b_1ntr0_4dm1n}", status: "confirmed", evidenceIds: ["ev-101"], findingIds: [],
        source: "agent", note: "", at: iso(300), decidedAt: iso(280),
      }],
    },
    {
      id: "flag-002", label: "Flag 2 · 内网横向", hint: "从 Web 主机向 10.10.20.0/24 横向",
      submissions: [{
        id: "sub-002", value: "flag{p1v0t_v14_ssh_k3y}", status: "candidate", evidenceIds: ["ev-102", "ev-103"], findingIds: [],
        source: "agent", note: "", at: iso(20),
      }],
    },
    { id: "flag-003", label: "Flag 3 · 数据库", hint: "MySQL 只读账号", submissions: [] },
  ],
  run: {
    phase: "paused", turns: 5, startedAt: iso(900), lastEndedAt: iso(300),
    lastReply: "Flag 1 已确认：Web 入口来自 Tomcat 管理后台的默认口令，证据为登录成功截图与管理页响应。\n\n当前掌握的情况：\n- 已获得 Web 主机上的命令执行能力，运行身份为 www-data，尚未提权\n- 已从 /home/deploy/.ssh 提取运维私钥，保存为 work/ssh-key，未对任何内网主机尝试登录\n- 部署接口 PUT /manager/deploy 可用，但未上传任何载荷，避免对目标产生持久化影响\n- 目标所在网段 10.10.20.0/24 尚未做任何主动探测，扫描面严格限制在授权范围内\n\nFlag 2 的候选值同时来自运维私钥与部署接口两条证据，属于同一横向路径的两个环节，因此合并为一次人工确认；确认后才会用私钥尝试网段内的 SSH 登录。\n\nFlag 3 需要 MySQL 只读账号，目前只做了配置文件的静态检查，未发现明文凭证；下一步会在 Web 应用的配置目录与容器环境变量中继续查找，仍然只读，不做任何写入或导出。\n\n风险与限制：所有横向动作都要求先获批；每个动作执行前记录证据编号，执行后立即归档输出；不进行口令喷洒、不修改目标文件、不建立持久化通道。",
    checkpointAt: iso(300), checkpointNote: "已保存私钥与部署接口证据；横向尚未开始。",
  },
}

const flagAgentActivity = [
  { at: iso(660), kind: "status", text: "服务识别" },
  { at: iso(650), kind: "tool", callID: "f1", tool: "nmap", title: "端口扫描 · 10.10.20.15", status: "completed", detail: "8080 开放", argv: { command: "nmap -sV -p- 10.10.20.15 -oX work/ports.xml" }, endedAt: iso(640) },
  { at: iso(600), kind: "tool", callID: "f2", tool: "ffuf", title: "目录发现", status: "completed", detail: "manager/ 命中", argv: { command: "ffuf -u http://10.10.20.15:8080/FUZZ -w wordlist.txt" }, endedAt: iso(590) },
  { at: iso(320), kind: "status", text: "Flag 获取" },
  { at: iso(120), kind: "tool", callID: "f3", tool: "curl", title: "部署接口只读验证", status: "completed", detail: "HTTP 200 · ev-102", argv: { command: "curl -sS -u tomcat:tomcat -X OPTIONS http://10.10.20.15:8080/manager/deploy" }, endedAt: iso(110) },
  { at: iso(20), kind: "text", text: "Web 主机存在运维私钥，结合部署接口可将 Flag 2 候选值与横向路径绑定；等待人工确认。" },
]

const flagToolRuns = [
  { version: 1, id: "run-101", tool: "nmap", args: ["-sV", "-p-", "10.10.20.15"], reason: "端口扫描 · 10.10.20.15", status: "done", startedAt: iso(650), endedAt: iso(640), exitCode: 0, parsed: { assets: 9, observations: 6 } },
  { version: 1, id: "run-102", tool: "ffuf", args: ["-u", "http://10.10.20.15:8080/FUZZ", "-w", "wordlist.txt"], reason: "目录发现", status: "done", startedAt: iso(600), endedAt: iso(590), exitCode: 0, parsed: { assets: 2, observations: 1 } },
  { version: 1, id: "run-103", tool: "curl", args: ["-sS", "-u", "tomcat:tomcat", "-X", "OPTIONS", "http://10.10.20.15:8080/manager/deploy"], reason: "部署接口只读验证", status: "interrupted", startedAt: iso(120), endedAt: iso(110), interruption: "stopped" },
]

const pentestEngagement3 = {
  slug: "eng-003", target: "portal.redwood.internal", objective: "复核登录入口与文件上传链路", authorization: "operator-declared",
  scope: ["portal.redwood.internal"], mode: "assessment", status: "active",
  run: { phase: "failed", turns: 2, lastEndedAt: iso(700), lastError: "目标连接在 TLS 握手阶段超时" },
  counts: { assets: 7, observations: 4, findings: 1, candidates: 1, confirmed: 0, runs: 2, flags: 0, flagCandidates: 0, flagsConfirmed: 0 },
  createdAt: iso(1500), updatedAt: iso(700),
}
const pentestEngagement4 = {
  slug: "eng-004", target: "vpn.northstar.dev", objective: "VPN 网关基线安全评估", authorization: "operator-declared",
  scope: ["vpn.northstar.dev"], mode: "assessment", status: "archived",
  run: { phase: "idle", turns: 8, lastEndedAt: iso(10_000) },
  counts: { assets: 3, observations: 3, findings: 3, candidates: 0, confirmed: 3, runs: 6, flags: 0, flagCandidates: 0, flagsConfirmed: 0 },
  createdAt: iso(20_000), updatedAt: iso(10_000),
}

const engagementSummaries = [pentestEngagement2, pentestEngagement3, pentestEngagement4].map((item) => ({
  slug: item.slug, target: item.target, objective: item.objective, authorization: item.authorization,
  scope: item.scope, mode: item.mode, status: item.status, run: item.run, counts: item.counts,
  createdAt: item.createdAt, updatedAt: item.updatedAt,
}))
engagementSummaries.unshift({
  slug: pentestEngagement.slug, target: pentestEngagement.target, objective: pentestEngagement.objective,
  authorization: pentestEngagement.authorization, scope: pentestEngagement.scope, mode: pentestEngagement.mode,
  status: "active", run: pentestEngagement.run,
  counts: { assets: 18, observations: 11, findings: 4, candidates: 2, confirmed: 1, runs: 4, flags: 0, flagCandidates: 0, flagsConfirmed: 0 },
  createdAt: pentestEngagement.createdAt, updatedAt: pentestEngagement.updatedAt,
})

const agentActivity = [
  { at: iso(45), kind: "status", text: "攻击面枚举" },
  { at: iso(44), kind: "tool", callID: "c1", tool: "nmap", title: "服务探测 · api.acme-labs.cn", status: "completed", detail: "18 端口开放", argv: { command: "nmap -sV -Pn -T3 --top-ports 1000 api.acme-labs.cn -oX work/recon.xml" }, endedAt: iso(43) },
  { at: iso(40), kind: "tool", callID: "c2", tool: "httpx", title: "HTTP 指纹与响应头采集", status: "completed", detail: "Apollo Server", argv: { command: "httpx -u https://api.acme-labs.cn -title -tech-detect" }, endedAt: iso(39) },
  { at: iso(38), kind: "text", text: "入口返回 Apollo Server 指纹，`/graphql` 接受 POST。\n\n- 已完成：服务探测与指纹识别，18 个端口开放\n- 下一步：对 `__schema` 执行只读查询，确认 introspection 是否开放\n- 不做：任何写操作与速率限制绕过\n\n**判断**：introspection 本身不等于数据泄露，但会显著降低后续攻击成本，因此按 High 记录并附上证据与复现步骤。" },
  { at: iso(30), kind: "status", text: "漏洞验证" },
  { at: iso(20), kind: "tool", callID: "c3", tool: "nuclei", title: "GraphQL 配置与敏感信息模板", status: "running", argv: { command: "nuclei -u https://api.acme-labs.cn/graphql -tags graphql,exposure -rate-limit 5" } },
  { at: iso(10), kind: "tool", callID: "c4", tool: "curl", title: "验证 introspection query", status: "completed", detail: "HTTP 200 · ev-006", argv: { command: "curl -sS https://api.acme-labs.cn/graphql --data @work/introspection.json" }, endedAt: iso(9) },
]

const pentestToolRuns = [
  { version: 1, id: "run-0003", tool: "nuclei", args: ["-u", "https://api.acme-labs.cn/graphql", "-tags", "graphql,exposure", "-rate-limit", "5"], reason: "GraphQL 配置与敏感信息模板", status: "running", startedAt: iso(20) },
  { version: 1, id: "run-0002", tool: "nmap", args: ["-sV", "-Pn", "-T3", "--top-ports", "1000", "api.acme-labs.cn", "-oX", "work/recon.xml"], reason: "服务探测 · api.acme-labs.cn", status: "done", startedAt: iso(45), endedAt: iso(43), exitCode: 0, parsed: { assets: 18, observations: 7 } },
  { version: 1, id: "run-0001", tool: "httpx", args: ["-u", "https://api.acme-labs.cn", "-tech-detect"], reason: "HTTP 指纹与响应头采集", status: "failed", startedAt: iso(60), endedAt: iso(59), exitCode: 2 },
]

const hostTools = [
  { name: "nmap", version: "7.95" }, { name: "nuclei", version: "3.4.10" }, { name: "ffuf", version: "2.1.0" },
  { name: "sqlmap", version: "1.9" }, { name: "httpx" }, { name: "masscan", version: "1.3.2" },
  { name: "nikto" }, { name: "gobuster", version: "3.6" },
]

const competition = {
  settings: settings.competition,
  clock: { started: true, remainingMs: 6_136_000, elapsedMs: 2_860_000, endgame: false, over: false },
  environments: { used: 2, limit: 4, leases: [{ slug: "web-cache-maze", exerciseId: "ex-41", remote: "http://10.0.8.21:8080", expireTime: now + 900_000 }] },
  usage: { local: 1, remote: 2 },
  autopilot: { enabled: true, syncing: false, retries: 0, nextSyncAt: now + 300_000, lastSyncAt: iso(6), lastSuccessAt: iso(6), lastResult: { downloaded: 1, queued: 1, skipped: 6 } },
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === "/api/events") {
      let timer: ReturnType<typeof setInterval> | undefined
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(`: preview heartbeat\n\n`)
          timer = setInterval(() => {
            try { controller.enqueue(`: ping\n\n`) } catch { if (timer) clearInterval(timer) }
          }, 15_000)
        },
        cancel() { if (timer) clearInterval(timer) },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    }

    if (request.method === "PATCH" && path === "/api/settings") {
      const body = (await request.json()) as { mode?: string }
      if (body?.mode) state = { ...state, settings: { ...state.settings, mode: body.mode as "ctf" | "pentest" } }
      return json({ settings: state.settings })
    }

    if (path === "/api/state") return json(state)
    if (path === "/api/competition") return json(competition)
    if (path === "/api/platform")
      return json({ active: { id: "dasctf", displayName: "DASCTF 秋季赛", defaultServerHost: "", credential: { configured: true, serverHost: "" } }, platforms: [] })
    if (path === "/api/platform/dasctf/notices")
      return json({ notices: [
        { id: 1, title: "比赛延长 30 分钟", createdAt: iso(30) },
        { id: 2, title: "web-4 附件更新", createdAt: iso(120) },
      ] })
    if (path === "/api/platform/dasctf/overview") return json({ point: 1250, rank: 18 })
    if (path === "/api/pentest/engagements") return json({ engagements: engagementSummaries })
    if (path === "/api/pentest/tools") return json({ tools: [], host: hostTools })
    if (path === "/api/pentest/engagements/eng-001") {
      return json({
        engagement: pentestEngagement,
        toolRuns: pentestToolRuns,
        agent: {
          phase: "running", turns: 3, startedAt: iso(40), lastEndedAt: iso(1),
          lastReply: pentestEngagement.run.lastReply, checkpointAt: pentestEngagement.run.checkpointAt,
          checkpointNote: pentestEngagement.run.checkpointNote, live: true,
          activity: agentActivity,
          liveText: "正在对 schema 可见性与对象级授权做低影响验证。\n\n已确认 /graphql 在未认证状态下接受 POST，并返回包含内部对象定义的 __schema 结果；nuclei 的 graphql 模板组仍在运行。下一步会针对 user 与 order 两个候选对象执行只读查询，比对返回字段与前端实际调用的字段集合，判断是否存在对象级授权缺失。\n\n本轮不触发任何写操作，也不尝试绕过速率限制；如果只读查询显示越权返回，会先整理证据编号与可复现步骤，再交由操作员确认，不直接写入结论。",
        },
      })
    }
    if (path === "/api/pentest/engagements/eng-001/tool-runs/run-0002")
      return json({ run: pentestToolRuns[1], stdout: "Starting Nmap 7.95 ( https://nmap.org )\nNmap scan report for api.acme-labs.cn (1.2.3.4)\nPORT    STATE SERVICE\n443/tcp open  https\n\nNmap done: 1 IP address (1 host up) scanned in 2.04 seconds", stderr: "" })
    if (path === "/api/pentest/engagements/eng-002") {
      return json({
        engagement: pentestFlagEngagement,
        toolRuns: flagToolRuns,
        agent: {
          phase: "paused", turns: 5, startedAt: iso(900), lastEndedAt: iso(300),
          lastReply: pentestFlagEngagement.run.lastReply, checkpointAt: pentestFlagEngagement.run.checkpointAt,
          checkpointNote: pentestFlagEngagement.run.checkpointNote, live: false,
          activity: flagAgentActivity,
        },
      })
    }
    if (path === "/api/pentest/engagements/eng-003") {
      return json({
        engagement: { ...pentestEngagement3, counters: { asset: 7, observation: 4, finding: 1, evidence: 2, run: 2 }, assets: [], observations: [], evidence: [], findings: [], flagObjectives: [] },
        toolRuns: [],
        agent: {
          phase: "failed", turns: 2, startedAt: iso(900), lastEndedAt: iso(700),
          lastError: "目标连接在 TLS 握手阶段超时", live: false, activity: [],
        },
      })
    }
    // Decisions mutate the in-memory flag engagement so the preview shows the gate resolving.
    const flagDecision = /^\/api\/pentest\/engagements\/[^/]+\/flags\/([^/]+)\/submissions\/([^/]+)\/(confirm|reject)$/.exec(path)
    if (request.method === "POST" && flagDecision) {
      const [, flagId, submissionId, action] = flagDecision
      const flag = pentestFlagEngagement.flagObjectives.find((item) => item.id === flagId)
      const submission = flag?.submissions.find((item) => item.id === submissionId)
      if (submission) {
        submission.status = action === "confirm" ? "confirmed" : "rejected"
        submission.decidedAt = new Date().toISOString()
      }
      return json({ ok: true })
    }
    const findingDecision = /^\/api\/pentest\/engagements\/[^/]+\/findings\/([^/]+)\/(confirm|reject)$/.exec(path)
    if (request.method === "POST" && findingDecision) {
      const [, findingId, action] = findingDecision
      const finding = [...pentestEngagement.findings, ...pentestFlagEngagement.findings].find((item) => item.id === findingId)
      if (finding && finding.status === "candidate") {
        finding.status = action === "confirm" ? "confirmed" : "rejected"
        finding.decidedAt = new Date().toISOString()
      }
      return json({ ok: true })
    }
    if (request.method === "POST" && path.startsWith("/api/pentest/")) return json({ ok: true })

    const runMatch = /^\/api\/challenges\/([^/]+)\/runs\/([^/]+)$/.exec(path)
    if (runMatch) {
      const challenge = state.challenges.find((item) => item.slug === decodeURIComponent(runMatch[1]!))
      return json({ instanceID: state.instanceID, sequence: state.sequence, root: state.root, run: challenge?.runs.at(-1) ?? run() })
    }

    if (path.startsWith("/api/")) return json({ error: "not mocked" }, 404)

    let file = join(DIST, path === "/" ? "index.html" : path)
    if (!existsSync(file)) file = join(DIST, "index.html")
    const type = file.endsWith(".js") ? "text/javascript"
      : file.endsWith(".css") ? "text/css"
      : file.endsWith(".svg") ? "image/svg+xml"
      : "text/html"
    return new Response(readFileSync(file), { headers: { "content-type": type } })
  },
})

console.log(`preview: http://localhost:${server.port}`)
