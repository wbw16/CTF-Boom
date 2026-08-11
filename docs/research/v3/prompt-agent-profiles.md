# M2 对照研究：Prompt、Agent Resource 与 Tool Profile

状态：M2 设计与实现依据（2026-08-03）

## 1. Boom 当前问题和必须保持的行为

M1 以前，`resources/agent/*.md` 同时保存 Boom 角色正文和 OpenCode frontmatter。角色、温度、
工具可见性、权限以及稳定 system prompt 因此都以兼容 Runtime 的私有格式为权威，Native Runtime
无法复用，也无法对 Prompt 分层、来源、缓存稳定性和内容版本做独立验收。

M2 必须保持：

- 主 `boom` 和 worker 的文件发现、Shell、任务、Skill、Web 与 Boom 工具不回退；
- `challenge/` edit 继续被拒绝，`work/` edit 继续允许；
- analyzer、challenger、arbiter 等角色的提示词和温度不发生无意漂移；
- 绝对 workspace、日期和 run ID 不进入稳定 Prompt 前缀；
- OpenCode 仍是默认 Runtime，M2 不提前实现 Tool Host 或 Native Agent Loop。

## 2. Claude Code 与 OpenCode 的共同模式

两者都把 Agent/角色配置、system instruction、工具目录与单轮用户输入视为不同来源；工具 schema
由宿主提供，模型只选择调用。权限属于工具执行边界，而不是普通用户消息。稳定身份/规则适合缓存，
workspace、历史和当前目标则随任务或 turn 改变。

Boom 因此不复制任一产品的配置 schema，而是建立自己的 Agent Resource、Prompt IR 和 Tool Profile，
再由 adapter 输出目标 Runtime 所需格式。

公开与本地依据：

- Claude Code 的 system prompt、subagent、tool permission 与 hook 生命周期公开文档；
- OpenCode Agents/permissions 与 custom tools 公开文档；
- 锁定的 `@opencode-ai/sdk@1.18.4` `AgentConfig`、`Agent`、`ToolListItem` 类型；
- M1 scripted Provider 的真实 OpenCode request/permission conformance。

## 3. 关键兼容差异

OpenCode 1.18.4 的 Markdown agent 同时接受 `tools` 与 `permission`。实际回归发现：显式生成
`tools.edit: true` 会追加一条较晚的 edit allow，覆盖先前的 `challenge/**: deny`。因此 Boom 的
兼容编译器只为“从 profile 排除的工具”输出 `false`；profile 中允许的工具沿用 Runtime 默认注册，
路径和副作用规则由 `permission` 表达。C03 回归负责证明题目输入仍然只读。

同一 Runtime 会把 permission deny 的工具从 Provider 请求中移除，无法同时做到“Provider 看见
工具”和“兼容 Runtime 拒绝副作用”。为保持 M2 的核心工具可见性和既有行为，solver、worker、
intake、reasoning profile 在 OpenCode 路径保持核心能力；verifier 使用明确的最小只读目录。
更细的副作用配额由 M3 Boom Policy Engine 执行，不能在 M2 假装已经隔离。

OpenCode 还会先合并用户的全局配置，单独设置 `OPENCODE_CONFIG_DIR` 不能阻止全局 MCP/Agent
进入 Boom。兼容 Runtime 现在以子进程专用 XDG config home 启动，并禁用外部 Skill 扫描；不会
修改宿主 `HOME`，也不会继承用户的 OpenCode MCP、Agent 或插件配置。conformance 用一个故意
覆盖 `boom-consultant` 的外部配置证明该内容不会进入真实 Provider request。

锁定的 OpenCode 1.18.4 没有独立 `list` 工具（目录清单由 `read` 承担），也没有默认可用的
`websearch` driver，但会暴露兼容专用 `write`。Boom 中性 profile 仍保留 `list`/`websearch` 作为
V3 稳定目标，并显式记录 `write` 兼容能力；C19 固定当前真实请求的精确目录。M3 Tool Host 负责
补齐稳定名称/实现，M2 不用伪工具宣称搜索成功。

## 4. Boom 采用的中性格式

- `resources/runtime/agents/<id>/agent.json`：角色、模式、温度、颜色、Tool Profile 和输出合同；
- `resources/runtime/agents/<id>/SYSTEM.md`：只保存角色合同；
- `resources/runtime/policies/immutable.md` 与 `identity.md`：稳定 policy/identity 层；
- `resources/runtime/tool-profiles.json`：稳定工具 ID、schema snapshot、副作用类型和角色 profile；
- `resources/runtime/skills/**`：Boom 权威 Skill 资源。

`src/runtime/prompt.ts` 的 Prompt IR 固定 armor → policy → identity → role → tools → environment →
memory → skills → turn 顺序。每个 section 记录 source、stability、cacheable、sensitivity 和 SHA-256；
只有 stable 且非 secret 的 section 可以进入缓存前缀。

`src/runtime/agent.ts` 加载并验证中性资源，生成 OpenCode agent Markdown 和
`boom-agent-manifest.json`。运行结果记录 registry `prompt_version`，使模型效果可按 Prompt 版本对比。

## 5. 分层在兼容 Runtime 中的落点

- policy、identity、role、tools：由中性 Agent 编译器组成稳定 system block；
- armor：由 Boom provider 配置插件处理；求解角色仍遵守当前“不注入解题经验”的产品规则；
- environment：由 Boom environment binding 插件注入，动态路径会从稳定 system block 清除；
- skills：从 `resources/runtime/skills/**` 安装，由兼容 Runtime 按需加载；
- turn：`session.ts` 通过同一个 Prompt IR 编译 solve/continue/writeup/recovery 指令；
- memory：大体量内容继续留在 `NOTES.md`/Boom state，turn 只引用，不复制完整历史。

Native Provider message 映射属于 M4/M5；M2 只要求上述来源已有 Boom 中性表达和 OpenCode bridge。

## 6. 验收映射

- C01：角色 prompt 隔离和标准化结果；
- C13：profile 工具/权限隔离，verifier 最小工具，challenge edit 拒绝；
- C17：稳定 layer 顺序、来源、哈希和跨 conversation system 一致；
- C19：中性工具目录/schema snapshot 与真实 OpenCode Provider request 兼容。

M1 scripted matrix 与全量测试是回归硬门槛。任何 OpenCode frontmatter 行为差异必须固化到 adapter
测试，不能回写为 Boom 公共语义。
