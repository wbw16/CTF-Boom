# Boom V3 Agent Runtime 设计与实施计划

> 历史 M0–M8 架构记录。当前精简产品已移除 V2 baseline/checkpoint/branch/verifier/recovery
> 路径；现役行为以 `README.md`、`MEMORY.md` 和当前代码为准。

状态：M1–M5 的已有成果保留；自 2026-08-06 起停止“以 Native 替换 OpenCode”的底层重构
路线，OpenCode 作为稳定产品 Runtime，后续转向直接提升 Boom 产品能力。当前能力切片为
Boom 管理的 MCP 配置、连接状态与工具接入。

开发分支：`codex/boom-v3`

稳定基线：`codex/runtime-decoupling` 及其当前提交保持可用，不在 V3 开发中重写历史

## 0. 决策摘要

> 2026-08-06 路线调整：本节以下内容保留为历史设计与已完成工程记录，但“最终删除
> OpenCode”及“Native 默认切换”不再是当前目标。新功能优先复用 OpenCode 已有且稳定的
> Runtime 能力，并由 Boom 提供配置、隔离、交互和产品语义。只有出现明确产品缺口时才扩展
> Boom 自有底层，不再为可替换性本身开展重构。

当前 MCP 决策：OpenCode 负责 MCP 协议、transport、发现、OAuth 与工具调用；Boom 负责独立
配置源、GUI/CLI、启停、状态展示和凭据引用。Boom 继续使用隔离的 OpenCode config home，
不得隐式继承用户全局或挑战项目中的 MCP 配置。

Boom V3 不再把“替换 OpenCode”理解成增加一个能力较弱的备用 adapter，而是开发 Boom
自己的完整 Agent Runtime。现有 OpenCode Runtime 在迁移期间作为稳定实现、行为参照和回退
路径，只有在 Native Runtime 通过能力等价、真实题目和安全验收后才从产品依赖中移除。

V3 的核心交付是：

1. Boom 自己拥有 Agent Loop、Prompt 编译、工具注册、权限策略、上下文治理、Provider
   驱动、事件流和证据审计；
2. CLI、桌面端、baseline、checkpoint、consultation、evidence branch、verifier 和 recovery
   只依赖 Boom 合约；
3. OpenCode 与 Native 在迁移期同时实现同一套合约，并通过共享 conformance suite；
4. Native 对 Boom 当前实际使用的底座能力达到语义等价，不以“能跑完简单题”作为完成标准；
5. 主 `boom` 和 worker 对 OpenCode 当前核心工具达到能力等价：`bash`、系统工具、文件工具、
   `task`、Skill、Web search/fetch 和 Boom 持久化工具默认可用，不以隐藏工具代替安全边界；
6. CTF 任务默认开放网络与搜索，不要求题目预声明目标；宿主通过任务文件系统隔离、凭据隔离、
   进程资源限制和审计约束影响范围，而不是限制公开网络目的地址；
7. 默认采用 autonomy-first：主 Agent 先直接解题，只有确认无实质进展后才渐进启用 analyzer、
   challenger、evidence branch 和 arbiter；`task` 始终可由 Agent 自主调用但受并发和累计预算约束；
8. 最终删除 OpenCode SDK、运行时、插件兼容资源及其安装逻辑，但继续保留 V2 分支供回退。

V3 不是照搬其他 Agent 产品。Claude Code、OpenCode 和其他成熟 Agent 只用于学习架构模式、
交互行为与 Prompt 组织方式；Boom 使用自己的模块、类型、状态、Prompt、错误文案和实现。

## 1. 背景与当前基线

Boom V2 已经证明以下产品层能力可用：

- 持久任务与多 turn continuation；
- baseline、checkpoint、会诊、证据分支、反证和独立验证；
- economy/strong 模型策略和累计预算；
- 受控命令执行、Python 环境绑定和隔离模式；
- `NOTES.md`、`boom-state.json`、运行事件和恢复状态；
- CLI 与 macOS 桌面端共享任务、历史、Provider 和模型配置；
- 取消、超时、输出截断、重复调用、空回复和 Provider 故障恢复；
- `AgentRuntime`、`RuntimeConversation`、`RuntimeEvent`、`RuntimePromptResult` 与
  `RuntimeHandle` 初步隔离了 Boom 核心和 OpenCode SDK。

当前边界仍然不完整：

- Agent Loop、内置文件工具、Web 工具、Skill 加载和上下文压缩仍由 OpenCode 实现；
- Agent frontmatter 同时承担 Boom 角色声明和 OpenCode 配置，缺少 Boom 自有中间表示；
- `boom-exec`、`ctf-note` 在 Native Tool Host 和 OpenCode 插件中存在两套实现；
- Provider 目录、认证、OAuth 和模型 transport 仍由 OpenCode 控制；
- 当前 fake runtime 测试只证明核心没有消费 OpenCode 类型，不能证明合约足以承载生产级
  Agent Runtime；
- OpenCode 的行为由第三方版本决定，Boom 无法独立控制升级节奏、安全边界和长期兼容性。
- V2 的固定前置 intake/checkpoint/branch 流程会给简单题增加不必要的模型调用和路线假设；
- 通过禁用 `bash`、`glob`、`grep`、`list` 或 `task` 获得的表面安全会直接损害 CTF 解题能力，
  也无法作为 Native 与 OpenCode 能力等价的长期方案。

V3 必须保留 V2 已验证能力，不能以重构为理由回退任务持久性、证据质量或安全约束。

## 2. 产品目标

### 2.1 首要目标

1. 建立 Boom 自有、可测试、可替换 Provider 的 Agent Runtime；
2. 对 Boom 当前依赖的 OpenCode 能力达到语义等价；
3. 将安全限制从 Prompt 和插件约定下沉为宿主强制策略；
4. 让 Prompt、Agent、Tool、Provider、Context 和 Event 各自拥有明确合约；
5. 允许后续独立演进交互模式、MCP、远程执行和更多网络安全工作流；
6. 保持现有任务目录可读、可继续、可评估，不要求迁移历史运行产物；
7. 建立来源可追踪的独立实现流程，避免代码、Prompt 和结构的不必要相似。
8. 保持 OpenCode 核心工具目录和调用语义，允许 Shell 调用系统 PATH 中的 CTF 工具；
9. 让简单题只承担主 Agent 求解成本，让复杂或停滞题按需获得多模型分析和隔离实验。

### 2.2 能力等价的定义

“与 OpenCode 等价”指 Boom 可观察行为等价，而不是复制 OpenCode 的全部产品和 Provider
生态。对于两个 Runtime 都声明支持的模型和能力：

- 相同 Boom Agent 能完成相同类别的工具循环；
- 主 Agent 在两个 Runtime 都能看到并调用等价的 `bash`、read/edit/list/glob/grep、`task`、
  Skill、Web search/fetch 和 Boom 工具；工具名、schema、取消、输出与错误语义可对照；
- 角色权限、路径限制和危险动作门控一致；
- 文本、工具、usage、retry、finish 和 error 能映射为相同 Boom 语义；
- continuation、取消、超时、compaction 和恢复保持相同任务状态；
- CLI 和 GUI 不需要知道底层 Provider SDK、消息格式或工具协议；
- 相同真实题目在合理随机性范围内生成同类证据、任务产物和候选结果。

Provider 集合可以不同。V3 不复制第三方产品的私有免费服务、账户体系或未经授权的 OAuth
流程；一个 Provider 只有在 Boom 实现并声明其 driver 与认证方式后才出现在 Native 目录中。

### 2.3 非目标

Boom V3 不做以下事情：

- 不重写模型本身，不训练或托管基础模型；
- 不复制 Claude Code、OpenCode 或其他 Agent 的源码、Prompt 原文和私有协议；
- 不实现 OpenCode 的完整 TUI、编辑器、团队协作或通用软件开发工作流；
- 不在 V3 底座中加入按题型写死的 CTF 解法；
- 不把 Shell 本身视为越界；但不允许 Shell 或系统工具逃逸任务文件系统隔离、读取宿主 HOME、
  凭据、Runtime 控制面或完整 `process.env`；
- 不要求 CTF 网络目标预先进入 allowlist，也不把正常联网、搜索、依赖安装或远程交互升级为
  多模型审批流程；
- 不保证不同模型产生逐字相同输出；
- 不在 Native 通过验收前删除或破坏稳定 OpenCode 路径；
- 不在本轮预设最终交互 UX、MCP profile 或云端账户产品形态。

## 3. 参考与独立实现原则

### 3.1 设计来源

V3 不从零发明一套与成熟 Agent 产品割裂的底座。每个重要子系统都先研究 Claude Code 和
OpenCode 已经验证过的产品设计，再结合 Boom 的 CTF 与网络安全目标形成自己的实现。

| 来源 | 重点学习内容 |
|---|---|
| Claude Code | 长任务 Agent Loop、分层 Prompt、工具说明、上下文压缩、恢复、权限治理、角色化 Agent |
| OpenCode | Provider 适配、模型目录、Session/Event、插件工具、流式处理 |
| Boom | 证据驱动、CTF 状态机、分支实验、Flag 验证、受控执行和网络安全边界 |

这里的“学习”是设计层面的吸收与组合，不是为了追求结构独特而刻意避开业界已验证方案，也
不是复制第三方源码或 Prompt。若 Boom 尚未明确知道某个能力应如何设计，默认动作是先调查
这两个成品方案的公开行为、文档和可合法参考的实现，再做选择，不凭直觉创造不必要的新范式。

#### 对照研究流程

设计 M1 之后的每个主要模块前，先形成简短的对照记录：

```text
docs/research/v3/<topic>.md

1. Boom 当前问题和必须保持的行为
2. Claude Code 的产品设计与 Prompt/交互模式
3. OpenCode 的产品设计、公开接口与实现边界
4. 两者共同采用的成熟模式
5. 两者存在分歧的地方
6. Boom 采用的设计及网络安全调整
7. 未采用方案和原因
8. 对应 conformance 与验收用例
```

研究记录先于正式实现。实现评审时应能从代码回到 Boom 规格，再从 Boom 规格回到对照研究，
避免“看过某段代码后直接照着写”或“没有研究成熟方案就自行设计”两种极端。

#### 设计决策优先级

遇到不确定或参考方案冲突时，按以下顺序决策：

1. Boom 已确定的产品、安全和数据边界；
2. Claude Code 与 OpenCode 共同验证的 Agent Harness 模式；
3. 更符合长任务稳定性、可恢复性和工具安全的一方；
4. 更容易通过 Boom 自有 conformance、替换 Provider 和长期维护的方案；
5. 只有前述方案都不满足时，才设计 Boom 独有机制，并记录为什么必须创新。

不为了显示差异而创新，也不为了表面兼容而保留不适合 CTF/网络安全的通用开发工具行为。

### 3.2 可以学习的内容

成熟 Agent 产品可用于学习：

- 模型、工具和结果组成的持续 Agent Loop；
- 稳定系统前缀、动态上下文和按需 Skill 的 Prompt 分层；
- 工具 schema、生命周期、权限过滤和结果回注；
- 上下文预算、压缩、恢复和会话 continuation；
- Provider driver、模型能力目录、认证和错误归一化；
- subagent/role 分工、事件流、成本累计和可取消执行；
- 插件、hook、策略引擎和可观测性边界。

### 3.3 不进入实现的内容

- 第三方源码片段、函数体、测试夹具和私有 Prompt 原文；
- 第三方特有的模块命名、错误文本、状态 schema 和隐藏协议；
- 反编译代码中的实现细节、未公开功能和账号认证流程；
- 未确认许可证或使用条款允许进入产品的资产。

### 3.4 V3 来源记录

新增 `docs/` 规格是实现的直接依据。重要模块的设计说明应记录：

- 对应的 Boom 产品需求；
- 使用的公开标准或第三方 SDK 文档；
- 通过旧 Runtime 黑盒观察得到的行为；
- Boom 自己做出的差异化决策；
- 是否包含需要保留许可证声明的第三方代码。

默认通过黑盒 conformance 和公开接口学习行为。若确需阅读 MIT 项目的具体实现，只提炼为
中性的行为或约束记录，后续代码仍按 Boom 规格独立编写。

## 4. 核心设计原则

### 4.1 产品核心不依赖 Runtime 形状

任务编排、状态、预算、检查点、分支、验证、历史和 GUI 只消费 Boom 合约。任何 Provider
消息、SDK event、tool call、OAuth response 和模型对象必须在 Runtime 边界归一化。

### 4.2 Prompt 不是安全边界

Prompt 用于解释规则和提高模型配合度，但路径、权限、网络、凭据、进程、预算和危险动作由
宿主策略强制执行。模型忽略 Prompt 时仍不能越界。

### 4.3 文件系统是持久状态，消息上下文是缓存

`challenge/`、`work/`、`NOTES.md`、任务状态、证据索引和审计事件是可恢复事实来源。模型
上下文可以压缩、重建或丢失，不能成为唯一任务记忆。

### 4.4 工具结果优先于模型叙述

可以由工具确定的事实不依赖模型自报。工具调用、输出、文件哈希、远程响应和候选验证进入
结构化状态；模型文字只作为解释与计划。

### 4.5 稳定前缀和渐进式上下文

不把所有政策、技能和历史一次性塞进 system prompt。静态身份与规则形成稳定前缀；环境、
记忆、技能和 turn 指令分层注入；大体量内容保留在磁盘并按需读取。

### 4.6 能力开放、边界强制、失败显式

Runtime、Provider、Agent 和 Tool 必须声明能力。主求解角色的核心工具默认开放，不因为某个
backend 的权限表达困难就禁用 `bash`、文件搜索、`task`、Web 或系统工具。路径、只读证据、
宿主凭据、进程资源和任务目录由 Tool Host、OS sandbox 与 Policy Engine 强制；未支持的附件、
认证、隔离或取消能力明确失败，不静默降级，也不伪造成功结果。

### 4.7 先兼容，再切换，再删除

每个 V3 模块先在 OpenCode 路径下验证中性合约，再由 Native 实现；Native 通过双运行与真实
题目验收后成为默认；最后才删除 OpenCode 依赖。

### 4.8 主 Agent 优先，升级流程按需触发

默认只启动拥有完整工具能力的主 `boom` Agent。intake、checkpoint、consultation、evidence
branch 和 arbiter 是停滞后的升级服务，不是每道题的固定前置流水线。宿主先用确定性进展事件
判断是否需要升级；多模型调用不能仅因任务启动、普通联网、系统工具调用或安装依赖而触发。

## 5. 总体架构

```text
┌────────────────────────────────────────────────────────────────────┐
│ Boom Product Core                                                  │
│ task / progress / escalation / checkpoint / branch / verifier      │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ Boom Runtime Contract
┌──────────────────────────────▼─────────────────────────────────────┐
│ Runtime Facade: src/runtime.ts                                     │
│ backend selection / lifecycle / doctor / provenance               │
└───────────────────┬──────────────────────────────┬─────────────────┘
                    │                              │
        ┌───────────▼───────────┐      ┌──────────▼──────────┐
        │ OpenCode Adapter      │      │ Boom Native Runtime │
        │ migration fallback    │      │ production target   │
        └───────────────────────┘      └──────────┬──────────┘
                                                 │
       ┌─────────────────────────────────────────┼────────────────────┐
       │                 │                 │      │                    │
┌──────▼──────┐  ┌───────▼───────┐  ┌────▼─────┐  ┌─────▼─────┐  ┌───▼────┐
│Agent Kernel │  │Prompt Compiler│  │Tool Host │  │Policy     │  │Context │
│conversation │  │layered IR     │  │schemas   │  │Engine     │  │Manager │
└──────┬──────┘  └───────────────┘  └────┬─────┘  └─────┬─────┘  └───┬────┘
       │                                  │              │            │
┌──────▼────────┐                  ┌──────▼───────┐ ┌────▼──────┐ ┌───▼──────┐
│Provider Driver│                  │Evidence Store│ │Network    │ │Transcript│
│stream / auth  │                  │artifact DAG  │ │Broker     │ │Compactor │
└───────────────┘                  └──────────────┘ └───────────┘ └──────────┘
```

### 5.1 模块职责

| 模块 | 职责 | 不负责 |
|---|---|---|
| Runtime Facade | 选择 backend、生命周期、能力、doctor、版本来源 | Agent Loop 细节 |
| Autonomy Orchestrator | 直接求解、进展监测、分级升级、冷却和预算 | 代替主 Agent 选择具体解题路线 |
| Agent Kernel | 会话、生成、工具循环、取消、结束状态 | CTF 路线选择 |
| Prompt Compiler | 分层 Prompt、稳定前缀、Provider 翻译 | 路径与网络强制 |
| Provider Driver | 模型目录、stream、usage、认证、错误归一化 | 工具权限 |
| Tool Host | schema、执行、结果、生命周期事件 | 模型消息协议 |
| Policy Engine | 角色权限、路径、网络、风险、凭据和预算决策 | 生成自然语言 |
| Context Manager | token 估计、压缩、恢复、会话消息 | Durable task truth |
| Evidence Store | 证据哈希、来源、信任级别、产物关系 | 替代 `work/` 文件 |
| Event Bus | 规范化事件、持久审计、GUI stream | 第三方 SDK event 外泄 |

### 5.2 Autonomy-first Orchestrator

默认状态是 L0 直接求解；宿主不预跑模型 intake、analyzer、challenger、arbiter 或 evidence
branch。廉价的文件 manifest 可以确定性生成，是否进一步枚举和分析由主 Agent 自己决定。

常规升级必须同时满足：

```text
eligible = activeSolveTime >= 20 minutes OR billableUsage >= challengeTokenBudget * 30%
stalled  = timeSinceMeaningfulProgress >= 5 minutes
           OR usageSinceMeaningfulProgress >= challengeTokenBudget * 10%
trigger  = eligible AND stalled AND noProductiveLongRunningTool
```

`activeSolveTime` 不包含排队和 Provider retry；仍在产生心跳、输出或资源进展的长命令不视为
停滞。实质进展来自带哈希的新产物、`ctf-note` 的证据事实或排除结论、非重复成功工具结果、
阶段推进和 `ctf-submit`，不以原始输出字符数或文件数量冒充信息增益。

以下异常可提前处理：重复相同调用、退化输出循环、空或 malformed 回复、Agent 明确请求会诊，
以及连续两次正常 yield 但没有候选或持久进展。第一次正常 yield 且无候选时，优先让同一主
Agent continuation 一次，不立即启动多模型分析。用户始终可以手动触发或跳过升级。

升级按需要逐级执行：

1. L1：一个独立 analyzer 诊断卡点并给出一至两个可证伪实验；
2. L2：只有仍存在互斥方向时才调用 challenger，或启动默认两个、最多四个隔离证据分支；
3. L3：只有报告或分支证据实质冲突、连续升级仍失败，或确有高成本路线决策时才调用 arbiter；
4. 每级产物交回同一任务的主 Agent；相同停滞 fingerprint 有冷却和次数上限，升级总成本受
   剩余预算约束。

主 Agent 的 `task` 能力独立于上述宿主升级流程：Agent 可以在 L0 直接分派 subagent，宿主只
限制总并发、递归深度、累计 token/时间和目录隔离。

## 6. Boom Runtime 合约

V2 合约保留为迁移起点，但 V3 需要从“能调用一次模型”扩展为“能描述完整 Agent Runtime”。

### 6.1 Runtime Handle

Runtime 必须声明：

- backend ID、版本和构建来源；
- streaming、tool calls、attachments、web、compaction、provider management、OAuth 等能力；
- Agent Runtime；
- 可选 Provider Control Plane；
- doctor 结果和关闭方法。

能力字段只描述真实可用行为。声明 `true` 的能力必须进入 conformance suite。

### 6.2 Conversation

Conversation 是一个绑定任务目录、Agent 角色和消息历史的运行单元：

- 创建时规范化并锁定真实任务根目录；
- 同一 Conversation 只允许一个活动生成；
- 支持多个顺序 prompt，用于 retry、length recovery 和 continuation；
- 订阅者可在 prompt 前建立，不能丢失早期事件；
- `abort()` 幂等，并终止模型请求和所有活动工具；
- 关闭后不能继续写入事件或任务文件；
- Runtime 内部消息不得泄漏 Provider 原生对象给产品核心。

### 6.3 Event

V3 标准事件至少包括：

- conversation lifecycle；
- text delta；
- reasoning summary/delta（Provider 可见时；不要求持久化隐藏推理）；
- tool pending/running/completed/error；
- step usage 与累计 cost；
- retry；
- compaction started/completed/failed；
- provider warning/error；
- cancellation；
- final finish reason。

事件写入审计记录后再广播给 GUI。GUI 只消费 Boom event，不识别 backend event name。

### 6.4 Prompt Result

结果统一包含：

- text、reasoning、tool、attachment/reference 等规范化 parts；
- final usage 和 cost；
- `stop`、`length`、`tool-calls`、`content-filter`、`cancelled`、`error` 等结束原因；
- 规范化失败：状态码、是否可重试、响应摘要和 Provider 分类；
- backend request/response ID 的非敏感诊断引用。

产品核心继续负责 Flag 提取、candidate provenance 和任务 stop 分类。

## 7. Agent Kernel

### 7.1 状态机

```text
created
  → preparing
  → generating
      → tool-pending → tool-running → generating
      → compacting → generating
      → retrying → generating
  → completed | cancelled | failed
```

关键不变量：

- 一个 Conversation 最多一个活动模型 stream；
- Tool call ID 在 Conversation 内唯一；
- tool result 必须与原 call 一一对应；
- 每个完成 step 只计费一次；
- 超过输出、token、时间、重复或工具次数上限时由宿主停止；
- Provider 返回 malformed tool call 时进入明确修复或错误路径；
- 模型不能自行把任务标记为 verified、archived 或 host-confirmed。

### 7.2 Agent Loop

Native Loop 的通用流程：

1. 编译当前 Agent Prompt；
2. Provider Driver 发起 stream；
3. Event Bus 发布文本、reasoning、usage 和 tool call；
4. Policy Engine 验证 tool、参数、路径、网络和风险；
5. Tool Host 执行并返回结构化结果；
6. Kernel 将 tool result 注入消息并继续生成；
7. 必要时 Context Manager 压缩并恢复；
8. 直到模型正常结束、宿主限制触发或发生不可恢复错误。

Loop 只负责通用执行，不理解“二维码”“RSA”“Pwn”等题型。

### 7.3 并发

- 一个 Conversation 内默认串行执行有副作用工具；
- 明确标记只读、可并行的工具可以并发；
- `task` 是主 Agent 和 worker 的常规能力，不得一刀切禁用；默认总并发 4、递归深度 2，
  用户可提高上限；父任务取消时取消完整子任务树；
- 每个 subagent 有独立 conversation、目录作用域和 token/时间账本，累计成本计入父任务；
- Evidence Branch 仍由 Boom Orchestrator 创建独立目录和 Conversation；
- 一个分支的取消、失败或 compaction 不影响其他分支；
- Provider Driver 可实现并发限制和每模型队列，但不能阻塞全局取消。

## 8. Prompt Compiler

### 8.1 Prompt IR

Boom 定义自己的分层 Prompt 中间表示：

```text
PromptBundle
  armor[]        模型稳定性或兼容提示
  policy[]       不可由用户覆盖的 Boom 安全与产品规则
  identity[]     Boom 产品和 Agent 身份
  role[]         solver/intake/worker/analyzer/challenger/arbiter/verifier
  tools[]        当前可用工具及必要使用约束
  environment[]  任务目录、Python、执行模式、目标和能力
  memory[]       NOTES、Boom state、rejected candidates 和恢复摘要
  skills[]       本轮实际加载的 Skill
  turn[]         本轮用户目标、hint、retry 或 recovery 指令
```

每个 section 记录：来源、稳定性、是否可缓存、敏感级别和内容哈希。Provider Driver 只负责把
Prompt IR 翻译为对应 API 的 system/developer/user/message 结构。

### 8.2 Prompt 顺序

默认顺序：

1. model armor；
2. Boom immutable policy；
3. product/agent identity；
4. role contract；
5. tool contract；
6. environment and authorization scope；
7. durable memory and loaded skills；
8. turn instruction。

静态前缀不包含绝对路径、当前日期、run ID 或随机值，保证 Provider prompt cache 可复用。

### 8.3 Prompt 设计原则

- 只规定身份、边界、记录和交付，不为主 solver 写死解题方法；
- 将参数格式和错误语义放入 tool schema/description，不重复堆进 system；
- 主 Agent 和 worker 的核心工具目录保持完整；辅助角色按 Boom 中性 profile 获得工具和副作用
  配额，不通过 backend frontmatter 的总 deny 意外隐藏 read/list/glob/grep/bash/task；
- Skill 按需加载，并保留来源与版本；
- 长历史通过 durable state 和摘要进入，不重放全部 transcript；
- recovery prompt 短、明确，只描述停止原因和继续要求；
- 同一规则只有一个权威来源，避免 frontmatter、插件和宿主三处漂移；
- Prompt 版本写入 turn provenance，便于对比模型效果。

### 8.4 Agent 资源格式

V3 资源建议改为 Boom 中性格式：

```text
resources/runtime/agents/<agent-id>/agent.json
resources/runtime/agents/<agent-id>/SYSTEM.md
resources/runtime/skills/<skill-id>/SKILL.md
resources/runtime/policies/*.md
```

`agent.json` 保存角色、温度、工具集合、权限 profile 和输出约束。OpenCode 迁移 adapter 如仍需
frontmatter，应由中性资源生成兼容文件，不再把 OpenCode frontmatter 当成权威配置。

## 9. Agent 角色

V3 首批角色与 V2 保持一致，但工具策略改为“能力可见、影响受控”：

| Agent | 目的 | 工具级别 |
|---|---|---|
| `boom` | 主求解与交付 | 完整文件、Shell/系统工具、网络/搜索、Skill、`task` 和 Boom 工具 |
| `boom-intake` | 可选基础采集 | 非默认前置；可用文件发现、搜索和系统工具，写入受 profile 约束 |
| `boom-worker` | 单一证据方向 | 分支内完整工具与 `task`，不写主 NOTES，累计并发和预算受限 |
| `boom-consultant` | 按需状态分析 | 工具可见；默认以快照为主，副作用和预算受角色 profile 约束 |
| `boom-analyzer` | L1 停滞分析 | 工具可见；可复核工作区，不能替主 Agent 宣布完成 |
| `boom-challenger` | L2 独立反证 | 工具可见；按需验证替代解释，受全局并发和预算约束 |
| `boom-arbiter` | L3 冲突裁决 | 工具可见；仅在证据冲突或连续升级失败时调用 |
| `boom-verifier` | 盲化验证 | 中性证据，按验证方式授予最小工具 |

角色输出合同由 Boom schema 验证。模型返回自由文本但角色要求 JSON 时，Kernel 可以做一次
有限修复调用；仍失败则保留原始诊断并返回 malformed，不伪造结构化结果。

`bash`、read/edit/list/glob/grep、`task`、Skill 和 Web 工具在 Runtime 层注册为稳定核心能力。
角色 profile 可以限制写入范围、网络凭据、递归配额和总成本，但不能因为兼容层配置冲突而把
主 Agent 或 worker 的核心工具从 Provider 请求中移除。

## 10. Tool Host

### 10.1 Tool 定义

每个工具包含：

- Boom tool ID 和版本；
- 自然语言 description；
- JSON input/output schema；
- side effect：none/read/write/process/network/memory；
- risk：safe/costly/risky；
- 可否并行、可否取消、默认 timeout 和输出上限；
- Agent/Policy profile；
- 执行器和审计字段。

Provider Driver 只获得经过角色和策略过滤后的工具集合。

### 10.2 V3 等价工具

| 工具 | Native 行为 |
|---|---|
| `read` | 文本分段读取；受支持媒体转附件；大文件明确拒绝并给出替代建议 |
| `list` | 有界目录清单，不跟随逃逸 symlink |
| `glob` | 任务根内模式匹配，结果数量和深度受限 |
| `grep` | 文本搜索、大小限制、二进制跳过和结果截断 |
| `edit` | 仅允许角色授权的 `work/` 文件；支持创建和精确替换 |
| `bash` | 完整 Shell 语法、管道、重定向、循环和 PATH 系统工具；在任务沙箱内执行 |
| `webfetch` | 默认联网获取 URL；限制单次时间、响应大小和敏感信息回传 |
| `websearch` | 默认可用的搜索 driver；支持 CTF 强依赖的资料、漏洞和工具检索 |
| `skill` | 只读取 Boom 注册的 Skill，并记录版本 |
| `todowrite` | Conversation 临时计划，不作为 durable task truth |
| `task` | 创建受并发、递归、预算、取消和目录作用域约束的 subagent |
| `boom-exec` | 可选结构化 argv 执行器；与 `bash` 共享沙箱、环境、日志和取消实现 |
| `ctf-note` | 原子维护 `NOTES.md` |
| `ctf-submit` | 原子记录当前 session 候选并结束 solver turn，供可选平台适配器或用户立即判定 |

Native 不维护狭窄的系统命令白名单。PATH 中的分析器、编译器、调试器、网络客户端、解压和
媒体工具可以调用；pip/npm/cargo 等依赖安装进入任务环境、`work/vendor` 或隔离环境。宿主包
管理器不得修改真实宿主，但可以在任务容器或可丢弃 overlay 中使用。

### 10.3 文件安全

- Conversation 创建时 realpath 固化任务根；
- 文件工具的相对路径拒绝 `..`、NUL、绝对路径和非预期平台前缀；
- 每层父目录检查 symlink；敏感读取使用 no-follow 打开；
- `challenge/` 文件不可修改；
- 写入只允许 `work/` 和由宿主授权的 `NOTES.md` 原子操作；
- Shell 可以执行绝对路径系统程序，但其文件系统视图不包含宿主 HOME、凭据和 Runtime 控制
  socket；`challenge/` 只读，持久写入只落在 `work/` 或任务私有环境；
- 大输出写入 `work/` 后只返回摘要和路径；
- Tool result 不返回 Provider key、宿主 HOME 或清洗前环境。

### 10.4 Tool 统一

`bash`、系统执行、`boom-exec`、`ctf-note` 与 `ctf-submit` 的权威实现归入 Boom Tool Host。
迁移期 OpenCode 原生工具或插件只负责 schema 注册和调用桥接，不再复制命令策略、沙箱、
候选或 NOTES 写入逻辑。OpenCode 与 Native 的核心工具名和 schema 由 snapshot/conformance
持续比较。

## 11. Policy Engine 与网络安全调整

### 11.1 Policy 输入

Policy Decision 至少考虑：

- Agent 角色；
- task/run/branch 根目录；
- Tool 与 side effect；
- 参数、目标路径、程序和网络地址；
- Python 环境、execution mode 和 install policy；
- 任务文件系统视图、宿主敏感边界和 Runtime 控制面；
- 并发、递归、预算、用户设置和 Runtime capability。

输出统一为 `allow`、`isolate` 或 `deny`，并带稳定 reason code。普通联网、搜索、系统工具、
依赖安装、长命令或大输出不触发 analyzer/checkpoint；Policy 直接在允许、任务隔离和拒绝之间
做宿主可执行的决定。

### 11.2 Network Broker

所有 Native 网络工具和受控命令网络请求遵循统一策略：

- CTF 任务默认开放网络，不要求主机、端口、协议或域名预先写入 `challenge.json`；
- Shell、Python、curl/wget、git、pip、Web search/fetch 和远程 Pwn/Web 交互共享开放出站能力；
- 默认不做域名、IP、loopback、RFC1918 或端口 allowlist；任务可启动本地服务和监听端口；
- DNS、连接、监听和重定向进入审计，但审计不改变正常网络可达性；
- 限制重定向、响应大小、请求时间、并发和总流量；
- Web search/fetch 不上传附件、密钥、完整反编译结果或其他任务敏感内容；
- 凭据由 Provider Driver 或 Network Broker 注入，模型和命令参数不可见；
- 每次网络操作记录目标、政策、耗时、状态、大小和证据路径，不记录敏感 header/body。

网络开放不等于宿主暴露：任务进程仍看不到宿主凭据、浏览器 cookie、云认证、Runtime 管理
socket 和完整环境。未来如提供更严格的企业 profile，应作为显式可选项，不能改变 CTF 默认值。

### 11.3 执行风险

- 默认允许调用系统 PATH 中的工具，不按程序名维护 CTF 工具白名单；
- `bash` 支持完整 Shell 语法，未知程序不会仅因未知而拒绝；Policy 根据任务文件系统、凭据、
  宿主控制面和平台能力选择 managed task sandbox 或 isolated 环境；
- 容器、sandbox 或任务环境必须明确报告实际边界；不能声称隔离后静默在无保护宿主执行；
- pip/npm/cargo 等安装写入任务环境；需要系统包管理器时使用任务容器或可丢弃 overlay；
- 长时间命令、大输出和开放网络由 timeout、资源、日志与取消控制，不触发多模型审批流程；
- 取消终止完整进程树；
- 审计记录实际 executable、argv、cwd、环境指纹和资源结果。

### 11.4 数据与隐私

- Boom 默认不发送产品遥测；
- 运行事件和调试信息保存在任务目录或 Boom 本地数据目录；
- 不默认持久化 Provider 隐藏 chain-of-thought；
- API key、OAuth token、cookie 和授权 header 不进入 Prompt、事件或命令环境；
- 错误 response body 在持久化前做 secret redaction 和大小限制。

## 12. Provider Driver 与控制面

### 12.1 Driver 合约

Provider Driver 负责：

- 模型目录和能力；
- Prompt IR 与 message/tool/media 的 Provider 翻译；
- 流式生成和 tool call delta；
- usage、cache、reasoning、cost 和 finish reason；
- Provider 错误、限流、重试提示和 request ID；
- API key 或 Provider 允许的 OAuth/云认证；
- 请求取消和连接清理。

Driver 不执行 Tool，也不决定 task policy。

### 12.2 首批 Driver

建议按以下顺序实现：

1. 本地 scripted/fake driver，用于所有确定性测试；
2. OpenAI-compatible driver，覆盖现有自定义 endpoint 和 MiMo 类配置；
3. OpenAI official driver，处理 Responses/工具/媒体特性；
4. Anthropic official driver，使用 API key、Bedrock 或 Vertex 等允许方式；
5. 根据真实使用需求增加其他 Provider。

不允许仅凭配置字符串动态加载任意 npm 包。可扩展 driver 必须由 Boom 明确注册、固定版本并
进入依赖和许可证审计。

### 12.3 Provider Control Plane

- Provider 目录来自 Boom driver registry 与用户配置，不来自某个 Runtime 私有目录；
- API key 使用 Boom credential store 或环境变量；
- OAuth 只对 Provider 官方允许第三方应用使用的流程开放；
- Native 与 OpenCode 可以在迁移期显示不同 Provider 集合，但相同模型的 Boom 配置保持一致；
- GUI 通过 Boom Provider contract 管理，不调用 backend-specific API；
- 删除凭据必须从实际 credential store 移除，不能只删除 UI 状态。

## 13. Context Manager

### 13.1 消息账本

Conversation 内部维护 Provider 无关的消息账本：

- system section 引用与版本；
- user/assistant 文本；
- tool call/result；
- attachment/reference；
- usage 和 Provider request ID；
- compaction 边界。

完整账本是 Runtime 内部数据，不直接成为 `NOTES.md`。需要持久化时只保存恢复所需内容，
并应用敏感信息和 reasoning 策略。

### 13.2 Token 预算

- 使用 Provider usage 作为计费事实；
- 发送前使用 tokenizer 或保守估算检查上下文上限；
- cache read 按 Boom 已定义权重计入挑战预算；
- 每个 compaction、修复和 retry 调用都计入 turn；
- 上下文预算与挑战总预算分开管理，不能以压缩绕过总预算。

### 13.3 Compaction

触发条件包括：

- 预计输入接近模型 context 上限；
- Tool output 和媒体引用累计过大；
- Provider 明确返回 context overflow；
- Runtime 恢复时旧消息不再安全或可用。

压缩结果必须：

- 保留任务目标、已确认事实、开放假设、已排除方向、关键路径、未完成工具调用和用户提示；
- 指向 `NOTES.md`、Boom state 和证据文件，而不是复制大输出；
- 保存为诊断产物并记录 Prompt/模型/usage；
- 允许自动继续；
- 失败时用 durable state 启动新 Conversation，而不是丢失任务。

## 14. Evidence Store

V3 在现有文件布局上增加轻量证据索引，不替代人类可读文件：

```text
work/.boom/evidence.jsonl
```

每条记录可包含：

- artifact path、大小、SHA-256 和 MIME；
- 来源：challenge/tool/command/network/model/user；
- 产生它的 turn、branch、agent、tool call 或 command ID；
- trust：raw/derived/model-claimed/verified/rejected；
- 父证据和转换关系；
- 是否可安全发送给 Provider；
- 创建时间与可选摘要。

关键约束：

- 原始题目附件 immutable；
- 模型文字不能把 artifact 提升为 verified；
- 文件路径不存在或哈希不匹配时不能作为事实证据；
- 正确 Flag 继续只存在宿主确认状态，不进入任务工作区；
- 历史 V2 任务没有索引时仍可读取，不强制回填。

## 15. 可观测性与审计

V3 事件分为：

1. 用户可见运行事件：状态、文本、工具、usage、checkpoint；
2. Runtime 诊断事件：Provider、compaction、retry、请求 ID；
3. 安全审计事件：Policy decision、网络、命令、路径拒绝；
4. 证据事件：artifact 创建、派生、验证和失效。

要求：

- 每类事件有 version 和稳定 type；
- 大内容存文件，事件只放摘要和路径；
- Secret redaction 在落盘前执行；
- GUI SSE 与磁盘事件来自同一 Boom event；
- backend-specific raw event 只在显式 debug 模式保存；
- 可重放事件重建任务视图，但不重复执行工具。

## 16. 兼容与迁移

### 16.1 Runtime 选择

迁移期支持：

```text
boom run --runtime opencode|native ...
boom gui --runtime opencode|native ...
boom doctor --runtime opencode|native
```

默认值在 M7 验收前保持 `opencode`。Runtime backend/version、Prompt version 和 Tool Host version
写入每个 turn provenance。

### 16.2 任务兼容

- 不移动、不重命名、不清理现有 `ctf/runs/`；
- V2 `task.json`、`result.json`、`NOTES.md` 和 Boom state 继续可读；
- 新字段采用可选字段或 schema version；
- Native continuation 可接管旧任务，但先创建兼容快照并保留原文件；
- OpenCode 与 Native 切换不改变 task ID、累计 usage、rejected candidates 和 host-confirmed flag；
- 不在任务工作区写入 Runtime credential 或正确答案。

### 16.3 OpenCode 删除条件

只有全部满足后才删除：

- Native 通过共享 conformance；
- CLI 与 GUI 全流程通过；
- 至少完成一轮真实简单题、一轮多工具题、一轮失败恢复题和一轮网络题；
- capability、Provider、认证和 doctor 文档完整；
- 运行结果和预算无系统性回退；
- 稳定 V2 分支/tag 可安装；
- package、lockfile、资源和第三方声明完成清理。

## 17. Conformance Suite

### 17.1 原则

共享 conformance 是 V3 的主要验收依据。测试比较 Boom 语义，不比较 Provider SDK 私有对象、
随机文本或内部事件数量。

### 17.2 确定性 Provider

建立本地 scripted Provider：

- 支持流式 text/reasoning/tool calls；
- 返回固定 usage、cache 和 finish；
- 可注入 malformed tool、429、5xx、断流、length、empty 和 context overflow；
- 可验证收到的 system/messages/tools/media；
- 可在工具结果后产生下一 step；
- 不联网、不产生 API 成本。

OpenCode Adapter 和 Native Driver 均连接该 Provider，执行同一场景并输出 normalized trace。

### 17.3 必测场景

| ID | 场景 |
|---|---|
| C01 | 角色只收到 Boom 中性 profile 声明的 Prompt 与工具，不受 backend frontmatter 漂移影响 |
| C02 | read/list/glob/grep 的正常与越界路径 |
| C03 | edit 只能写 `work/`，challenge 和 symlink 逃逸失败 |
| C04 | `bash`/`boom-exec` 环境、系统工具、审计、输出截断、长命令和取消 |
| C05 | `ctf-note` note/ruled-out/checkpoint 原子语义 |
| C06 | 单 step 多 tool 与连续多 step tool loop |
| C07 | streaming text、reasoning、usage、cost 和 finish |
| C08 | prompt 前取消、生成中取消、工具中取消和幂等 abort |
| C09 | transient failure、retry、length recovery、empty 和 malformed |
| C10 | 图片/文档附件、模型不支持附件和拒收恢复 |
| C11 | context threshold、compaction、autocontinue 和失败重建 |
| C12 | continuation 复用 Conversation 与新 turn 复用 task |
| C13 | Agent profile、副作用范围和工具可见性；主 Agent/worker 不丢失核心工具 |
| C14 | 默认开放网络、Web fetch/search、Shell 联网、本地监听、并发和敏感数据隔离 |
| C15 | Provider 目录、credential set/remove 和允许的 OAuth |
| C16 | Evidence Branch 与 `task` 并发、目录隔离、部分失败和父级取消 |
| C17 | Prompt 稳定前缀、armor、环境和 Skill 组合 |
| C18 | Secret redaction、日志大小和 backend provenance |
| C19 | OpenCode/Native 核心工具目录、名称、schema、结果和错误语义 snapshot 等价 |
| C20 | 任意 PATH 系统工具与完整 Shell 语法可用，同时不能读取宿主 HOME、凭据和控制面 |
| C21 | `task` subagent 递归、并发、预算、结果回注、取消和任务树审计 |

### 17.4 真实验收

确定性测试之后使用同一配置进行：

- 简单离线题：验证基本 Agent Loop，且默认不触发 intake/checkpoint/branch/arbiter；
- 需要脚本和多工具的离线题：验证文件与执行；
- 系统工具依赖题：验证 PATH 工具、Shell 组合、任务环境安装和 OpenCode/Native 工具等价；
- 人为制造 20 分钟/30% 预算门槛、尾部无进展、重复和长命令：验证 autonomy-first escalation；
- Web 与 Pwn 远程题：验证默认开放网络、搜索、Shell 联网和取消，不依赖目标 allowlist；
- 至少一个 Agent 自主 `task` 和一个宿主 evidence branch：验证两种并行机制可共存；
- 至少一个 continuation：验证跨模型或跨 backend 状态复用。

真实模型输出不要求一致，比较成功率、错误候选、首次有效证据时间、token、cost、strong 占比、
工具失败、安全拒绝、简单题额外编排成本、升级触发准确率以及升级前后的信息增益。

## 18. 实施里程碑

### M0：冻结基线与设计规格

交付：

- 创建并只在 `codex/boom-v3` 开发；
- 保留 `codex/runtime-decoupling`；
- 完成本文；
- 后续新增 clean-room/source provenance 记录；
- 建立 V3 决策日志。

退出条件：稳定分支可定位；V3 目标、非目标、能力等价和删除条件无歧义。

### M1：行为规格与 Conformance Harness

状态：**已完成（2026-08-02）**

交付：

- 完成 Agent Loop、Session/Event 和流式处理的首批 Claude Code/OpenCode 对照研究；
- 扩充 Boom Runtime contract；
- 定义 normalized trace；
- 实现 scripted Provider；
- 将当前 OpenCode Adapter 接入共享 conformance；
- 固化当前可接受行为和已知差异。

退出条件：不改求解行为也能稳定重放 C01–C09、C13 和 C17 的 OpenCode 基线。

#### M1 实施与验收记录

| 项目 | 状态 | 证据 |
|---|---|---|
| Agent Loop 对照研究 | 通过 | `docs/research/v3/agent-loop.md` |
| Session/Event 对照研究 | 通过 | `docs/research/v3/session-events.md` |
| Streaming 对照研究 | 通过 | `docs/research/v3/streaming.md` |
| Boom Runtime contract 扩展 | 通过 | lifecycle、reasoning、compaction、diagnostic、cancel、finish、capability 均为 Boom 类型 |
| `RuntimeConformanceCase` | 通过 | `src/runtime-conformance.ts` 已实现 C01–C20 及 M1/M2/M3 子集；C21 在 M4 落地 |
| normalized trace | 通过 | 稳定 conversation/call/request ID，合并 chunk，canonical workspace，secret/path 脱敏 |
| scripted Provider | 通过 | loopback OpenAI-compatible fixture；text/reasoning/tool/usage/error/断流/延迟/abort 可注入 |
| OpenCode adapter 基线 | 通过 | scripted Provider 驱动真实 `@opencode-ai/sdk` / `opencode-ai@1.18.4` |
| C01–C09、C13、C17 重放 | 通过（含已知差异） | 单一 OpenCode 矩阵覆盖 role、path、edit、exec、note、tool loop、stream、abort、retry/length/empty、稳定 prompt |
| 生产 turn 流式 | 通过 | baseline/checkpoint/consultation/branch/verifier 统一订阅先于 prompt；final 权威并有界排空 |
| 分支实时状态 | 通过 | queued/running/terminal 逐转移原子落盘；通知携带 settled/total 与累计 usage |
| 执行默认值 | 通过 | Tool Host/compatibility plugin 双重归一化；省略可选参数的 50ms 命令不再 0ms 超时 |
| Provider 参数可移植性 | 通过 | compatibility hook 不注入 `maxOutputTokens`；输出由 Boom budget/字符上限控制 |
| 候选提交契约 | 通过 | `ctf-submit` 原子写 session-scoped candidate slot；新运行不解析回复；旧 Markdown 只作历史兼容 |
| 候选实时刷新 | 通过 | tool completed 发布 `run.candidate-submitted`；GUI 全量刷新且 live overlay 保留 durable candidate |
| 候选生命周期 | 通过 | `pending / accepted / rejected` 为宿主状态；提交即停转，停转后显示人工判定；接受后 Writeup→归档，拒绝后记忆→续跑 |
| 平台适配边界 | 通过 | `CtfPlatformAdapter` 可分别实现题目获取、flag 提交或两者；未配置时稳定退回人工判定 |
| 单题停止 | 通过 | GUI 详情页按 slug 调用 `/api/runs/stop`，与全局停止共用 runner cancellation |
| 运行隔离 | 通过 | 主 Agent 保留 OpenCode native bash/read/glob/grep/list/task；合法任务读取成功、路径逃逸和 challenge 写入失败；tool 可见输出 32 KiB |
| GUI 增量链路 | 通过 | `run.event` 本地合并；生命周期才刷新 snapshot；重历史 snapshot 有总量上限 |
| 回归 | 通过（Boom 主仓范围） | 2026-08-03 干净 V3 工作树实测 `bun run typecheck`；`bun test test/`：115 pass、0 fail、537 assertions |

M1 固化的 OpenCode 1.18.4 差异：

1. compatible Provider 有时只发布累积 text/reasoning part、不带 `properties.delta`；adapter 使用
   conversation-local part 累积器只发新增后缀；
2. `session.status retry` 保留 attempt/message，但不稳定暴露原始 HTTP status；Boom trace 记录
   rate-limit 等可推导分类，不猜造缺失字段；
3. cached prompt tokens 在 OpenCode usage 中从 `input` 分离到 `cache.read`，Boom 沿用分项语义；
4. OpenCode 权限 frontmatter 存在规则优先级和 backend 版本漂移风险；M1 基线保留主 Agent 的
   bash/read/glob/grep/list/task，合法任务读取成功，越界读取与 challenge 写入失败。M2 将工具
   profile 收归 Boom 中性配置，M3 再由 Boom Policy/Tool Host 成为长期权威；
5. compatibility plugin 的 schema default 不能作为跨 backend 保证；Boom 已在 Native Tool Host 与
   compatibility handler 双重归一化所有可选参数。scripted tool case 故意只发送 program/args，
   并用 50ms delay 验证默认 timeout 不会退化为 0ms；M3 的 Boom Tool schema 仍是长期权威定义。

另外，adapter 现在在 conversation 创建时 realpath 固化任务根、按 conversation ID 过滤全局事件，
并在 prompt final response 后等待有界 terminal event 再关闭 conformance stream。这些边界修复
不要求移除 OpenCode 原生工具；Agent/Prompt/profile 的正式变化归 M2，Shell 与 Policy 归 M3。

生产回归的详细设计结论已追加到三个研究记录的第 9 节。直接执行无路径限定的 `bun test` 还会
进入仓库内独立 gitlink `web/`，其中当前提交自带的 starter-preview fixture 缺失导致 2 个既存失败；
M1 未修改该独立工作树。主仓声明的 `bun test test/` 与 typecheck 均通过。

### M1.5：Autonomy-first 产品编排基线

状态：**实现与确定性验收已完成；真实简单题 smoke 通过，复杂升级 smoke 部分通过并作为
非阻塞跟踪项（2026-08-03）**

交付：

- 默认直接启动拥有完整工具能力的主 `boom`，不预跑模型 intake/checkpoint/branch/arbiter；
- 定义确定性 meaningful-progress 事件、20 分钟或 30% 预算 eligibility、5 分钟或 10% 预算的
  尾部无进展窗口，以及 productive long-running tool 例外；
- 第一次正常 yield 且无候选时同 Agent continuation；重复、空回复、malformed、Agent 请求和
  用户手动操作可提前进入恢复或升级；
- 实现 L1 analyzer、L2 challenger/默认两个证据分支、L3 冲突 arbiter 的渐进升级；
- 为升级建立剩余预算、fingerprint、冷却、次数上限和可观察事件；
- 保持 `task` 在 L0 可用；区分 Agent 自主 subagent 与宿主停滞 evidence branch；
- 保留 verifier 和 recovery 的产品能力，不以 autonomy-first 为理由提前删除尚无替代的能力。

退出条件：简单题不产生额外模型编排调用；持续有进展的复杂题不被打断；构造停滞能按 L1–L3
条件升级并回到同一任务；长命令不误触发；一个真实简单题和一个真实复杂/停滞题通过，升级
成本和触发原因可审计。

#### M1.5 实施与验收记录

| 项目 | 状态 | 证据 |
|---|---|---|
| 默认 L0 直接求解 | 通过 | CLI `auto` 与 GUI 普通运行不再预跑 intake/checkpoint/branch/arbiter；显式 `baseline`、`critical` 和手动 checkpoint 保留 |
| meaningful-progress ledger | 通过 | `src/orchestration/progress.ts`；带哈希的新/变更产物、`ctf-note` 持久记录、非重复成功工具结果、阶段和候选进入 `work/.boom/autonomy.json` |
| eligibility 与 stalled 判定 | 通过 | 20 分钟或 30% budget eligibility；5 分钟或 10% budget tail；productive long-running tool 例外 |
| 正常 yield continuation | 通过 | 第一次正常 yield 且无候选只续跑同一主 Agent 一次；连续两次无候选且无持久进展可提前升级 |
| L1–L3 渐进升级 | 通过 | L1 单 analyzer；L2 在两个实验间默认启动两个隔离 evidence branch，否则调用 challenger；连续失败/冲突进入 L3 arbiter |
| fingerprint、冷却和上限 | 通过 | 相同 progress epoch 每级至多一次，失败有 5 分钟冷却，同一 fingerprint 最多 L1–L3 |
| 预算、取消和审计 | 通过 | 主 turn、recovery、角色和 branch 共用任务累计 token/active-time 剩余量；升级状态、usage、artifact path 和 follow-up 事件持久化 |
| 异常恢复与候选判定 | 通过 | 重复、空/malformed 恢复保留；候选只由可选平台、确定性 checker 或用户裁决，模型盲审不驱动终态 |
| Agent 自主 `task` | 通过（边界保持） | 主 `boom`/worker 工具配置未移除 `task`；宿主 evidence branch 使用独立 `autonomy.l2` 事件与 `work/branches/` 产物 |
| 确定性复杂停滞 smoke | 通过 | `test/autonomy.test.ts` 覆盖提前升级、阈值升级、长命令例外、L1 analyzer、L2 双 branch 和 L3 arbiter |
| 简单题零编排 smoke | 通过（fake runtime） | `test/runner-autonomy.test.ts`：solver `boom` 后只运行 Writeup `boom`，无候选盲审、intake/checkpoint/branch/arbiter |
| 主仓回归 | 通过 | `bun run typecheck`；`bun test test/`：132 pass、0 fail、653 assertions |
| 真实模型简单题 | 通过（候选链路） | `Quoted-printable/20260803T131943Z-task` 在 52 秒内以 `autonomy-l0` 单 turn 提交候选，无 intake/checkpoint/branch/arbiter；未配置平台适配器，因此终态依然等待人工判定 |
| 真实复杂/升级题 | 部分通过 | `哆来咪发唢拉西哆/20260803T132129Z-task` 在主 Agent 明确请求后完成 L1；触发原因、32,234 billable tokens、证据产物和 follow-up 均可审计，但任务随后被用户中止，未实测自动 20 分钟/30% 阈值路径 |

M1.5 的代码和确定性产品行为已经落地。真实 Provider 恢复后，L0 直接候选链路和 L1 升级/
回注链路均已取得真实运行证据。复杂题未解出且由显式请求而非自动阈值触发，因此仍不将 M1.5
标为完全关闭；该项作为不改变 M3 Tool Host/Policy 合约的非阻塞产品回归，在 M4 前补齐。

### M2：中性 Agent 与 Prompt Compiler

交付：

- 完成分层 Prompt、角色化 Agent、工具说明和权限注入的对照研究；
- Agent 中性资源格式；
- Prompt IR 和编译器；
- armor、环境、角色、Skill 和 turn 分层；
- 定义稳定 Tool Profile：主 `boom` 和 worker 包含 bash/read/edit/list/glob/grep/task/Skill/
  websearch/webfetch/Boom tools，不用总 deny 或兼容层优先级隐藏核心能力；
- 辅助角色用 Boom profile 控制副作用和成本，而不是把工具从 Runtime 注册表移除；
- OpenCode 兼容资源由中性定义生成或桥接；
- Prompt、工具目录/schema snapshot 和稳定前缀测试。

退出条件：OpenCode 实际 Prompt 和核心工具行为不回退；所有 Agent 只从 Boom 中性配置获得角色、
工具 profile 和权限；C01、C13、C17、C19 在 OpenCode 路径通过。

#### M2 实施与验收记录

| 交付 | 状态 | 证据 |
|---|---|---|
| Prompt/Agent/权限对照研究 | 通过 | `docs/research/v3/prompt-agent-profiles.md`；记录 OpenCode `tools: true` 覆盖细粒度 permission 的兼容差异 |
| Boom 中性 Agent Resource | 通过 | `resources/runtime/agents/**`；8 个角色的 mode、role、temperature、Tool Profile 和输出合同均不再以 frontmatter 为权威 |
| Prompt IR 与稳定前缀 | 通过 | `src/runtime/prompt.ts`；固定九层顺序、source/stability/cacheable/sensitivity/SHA-256 与 secret/cache 约束 |
| 稳定 Tool Profile/schema | 通过 | `resources/runtime/tool-profiles.json`；主 Agent/worker 核心工具完整，verifier 使用最小只读 profile |
| OpenCode 生成桥接 | 通过 | `src/runtime/agent.ts` 在安装时生成兼容 Markdown 与 `boom-agent-manifest.json`；旧 `resources/agent/*.md` 已移除 |
| 动态 turn 与版本追踪 | 通过 | solve/continue/writeup turn 通过 Prompt IR 编译；`prompt_version` 进入 CLI/Runner 结果与历史 |
| C01/C13/C17/C19 | 通过 | 中性资源 snapshot、真实 OpenCode scripted Provider request/schema、稳定 system、工具可见性和 challenge 只读回归 |
| 主仓回归 | 通过 | `bun run typecheck`；`bun test`：132 pass、0 fail、653 assertions |

M2 不伪造尚未存在的 Policy Engine。OpenCode 1.18.4 会从 Provider 请求中移除 permission-denied
工具，因此辅助角色在兼容路径保持既有核心能力；细粒度副作用配额在 M3 由 Boom Tool Host/Policy
强制。verifier 的最小工具集合不依赖总 deny；兼容子进程也不再合并用户全局 OpenCode MCP/Agent。
该版本以 `read(directory)` 覆盖中性 `list`，且没有默认 `websearch` driver，这两个明确差异由 C19
固定并留给 M3 Tool Host 补齐。M1.5 尚未闭环的自动阈值真实复杂题回归不影响 M2 的确定性和
真实 OpenCode scripted 验收结论，也不改变 M3 Tool Host/Policy 合约。

### M3：统一 Tool Host 与 Policy Engine

状态：**已完成（2026-08-03）**

交付：

- 完成工具注册、权限治理、插件工具和网络访问的对照研究；
- Tool schema/registry；
- Native 文件、Skill、Todo、Web search/fetch 工具；
- Native `bash`、完整 Shell 语法、PATH 系统工具、任务环境安装和本地监听；
- 统一 Shell/`boom-exec`、`ctf-note` 与 `ctf-submit`；
- Policy Engine、任务文件系统、challenge 只读、凭据/环境隔离和进程资源规则；
- 默认开放 Network Broker，不做目标 allowlist；网络并发、流量、日志、取消和敏感数据测试；
- 普通联网、系统工具、安装、长命令和大输出不触发模型 checkpoint；Policy 直接
  `allow`/`isolate`/`deny`；
- OpenCode 插件降为薄桥接。

退出条件：C02–C05、C13、C14、C18–C20 通过；OpenCode 与 Native 核心工具目录、schema、
Shell/System Tool、网络和 Tool Host 语义一致。

#### M3 实施记录

| 切片 | 状态 | 证据 |
|---|---|---|
| 对照研究 | 通过 | `docs/research/v3/tool-host-policy-network.md` 固化 OpenCode/Claude Code 的 Registry、权限、插件、Shell 与网络差异及 Boom 决策 |
| Boom Tool Registry | 通过 | `src/runtime/tool-registry.ts` 统一解析并冻结工具描述、实现归属、副作用、schema 和 profile；实现不再反向定义公共合约 |
| Prompt/Agent 消费端 | 通过 | `src/runtime/agent.ts` 从 Tool Registry 加载 M2 资源，C19 的稳定目录和 schema snapshot 保持 |
| Policy 与任务文件系统 | 通过 | `src/runtime/policy.ts` 在每次 dispatch 按 profile/effect 判定；任务相对路径逐级 no-follow，challenge/控制面只读，普通 edit 仅写 `work/` |
| Native 文件/状态工具 | 通过 | `src/runtime/file-tools.ts` 实现有界 read/list/glob/grep/edit；`src/runtime/state-tools.ts` 实现 Boom-owned Skill 与会话级 Todo |
| Shell/System Tool | 通过 | `src/command-executor.ts` 支持完整 Bash、PATH、绑定 Python、任务本地包目录和 loopback 监听；macOS sandbox、Linux bubblewrap、Windows/isolated container 不可用时 fail closed；进程树、超时、32 KiB 可见输出和 10 MB 日志上限已验证 |
| Network Broker/Web | 通过 | `src/runtime/network-broker.ts`、`web-tools.ts` 实现默认开放目标、DNS pin、逐跳重定向校验、并发/流量/响应/超时/取消和脱敏审计；仅精确拒绝 Boom 当前控制面 origin，strict profile 可额外拒绝私网 |
| OpenCode 薄桥接 | 通过 | `src/runtime/tool-bridge.ts` 持有权威 Host；`resources/plugin/boom-bridge.ts` 只从父进程 Registry 生成 Zod/Provider schema、归一化兼容路径并转发调用；旧三份重复插件不再安装 |
| C20 与全量回归 | 通过 | C02–C05、C13、C14、C18–C20 分布式验收；真实 OpenCode scripted Provider 验证桥接目录/schema/执行；`bun run typecheck`；`bun test`：154 pass、0 fail、845 assertions；默认 Network Broker 对 `https://example.com` 的真实 smoke 为 HTTP 200 |
| 明确留给 M4 | 非阻塞 | `task` subagent/多 step Native Agent Loop 属于 M4；OpenCode-only `write` 保留 compatibility provenance，Boom Native 写语义由有界 `edit` 与专用持久化工具承担 |

### M4：Native Agent Kernel

交付：

- 完成长任务 Agent Loop、消息回注、取消和恢复的对照研究；
- Conversation、消息账本和 Event Bus；
- 多 step tool loop；
- `task` subagent 创建、递归深度、总并发、独立目录/消息、结果回注和任务树取消；
- streaming、usage、finish、error 和 cancellation；
- scripted Provider driver；
- Runtime selector 的内部开发入口。

退出条件：Native 在 scripted Provider 下通过 C01–C09、C12、C13、C16–C21；默认总并发 4、
递归深度 2 可配置，父任务取消和累计预算可证明生效。

#### M4 实施记录

| 切片 | 状态 | 证据 |
|---|---|---|
| 对照研究 | 通过 | `docs/research/v3/native-agent-kernel.md` 固化 Claude Agent SDK、OpenCode 当前产品行为、锁定 compatibility 版本与 Boom 自有 loop/task tree 的边界 |
| Provider/Kernel 合约 | 通过 | `src/runtime/native-provider.ts` 定义 Provider-neutral message/tool/stream；`scripted-provider.ts` 可注入 text/reasoning/tool fragments、usage、finish、延迟、断流、错误和 abort，零网络/零成本 |
| Conversation、ledger、Event Bus | 通过 | `native-storage.ts` 在任务 `work/.boom/native/` 下实现 durable message ledger、单调事件审计和 persist-before-broadcast；provenance、secret redaction、顺序 continuation 和跨实例 resume 已验证 |
| 多 step Agent Loop | 通过 | `native-runtime.ts` 实现完整 tool result 回注、schema 完整性、retry、length continuation、empty/malformed、streaming、usage/cost、唯一 finish 和幂等 cancellation |
| task tree | 通过 | `native-task-tree.ts` 实现独立 challenge/NOTES/work/ledger、默认总活动并发 4、深度 2、部分失败隔离、父子结果回注、任务树 audit、父取消和跨树累计 token budget；嵌套等待不占 permit，避免递归死锁 |
| M3 Host/Policy 复用 | 通过 | Native scripted Provider 实际调用 read/edit、越界拒绝、ctf-note、受控 Bash 和 loopback webfetch；Kernel 不重写 M3 路径、Shell 或 Network Broker 规则 |
| Runtime selector | 通过 | `startRuntime({ backend: "native", native: ... })` 保留可注入 scripted Driver 的内部入口；M5 已在相同 selector 上增加 first-party managed Driver 组装，产品默认仍为 OpenCode |
| C21 与全量回归 | 通过 | C01–C09、C12、C13、C16–C21 在 Native scripted 场景和共享 M3 conformance 中通过；`bun run typecheck`；`bun test`：164 pass、0 fail、947 assertions |
| 明确留给 M5/M6 | 非阻塞 | M4 capability 对 attachment、compaction、Provider management/OAuth 明确为 false；真实 Provider、credential 控制面和 C15 属于 M5，附件/Context 属于 M6 |

### M5：真实 Provider Driver 与控制面

状态：**实现与自动验收已完成；真实外部 Provider smoke 待用户凭据（2026-08-04）**

交付：

- 完成 Provider 适配、模型目录、认证和流式差异的对照研究；
- OpenAI-compatible driver；
- OpenAI official driver；
- Anthropic official driver；
- Web search driver 与可替换搜索 Provider，默认供主 Agent 使用；
- Boom Provider registry、credential store 和 GUI/CLI 控制面；
- model capability、media、usage 和 cost 归一化；
- doctor 检查。

退出条件：每个 driver 至少一次真实流式 tool loop；认证和删除凭据不泄漏；C15 通过。

#### M5 实施记录

| 切片 | 状态 | 证据 |
|---|---|---|
| 对照研究 | 通过 | `docs/research/v3/provider-drivers.md` 固化 OpenAI Responses、Chat Completions compatibility、Anthropic Messages、OpenCode Provider 控制面、usage/cache 与 Web search 差异 |
| HTTP/SSE 边界 | 通过 | `provider-http.ts` 实现 credential-free URL、状态分类、request ID、已知密钥精确脱敏、有界错误/JSON、CRLF 与跨 chunk SSE、单事件上限和取消清理 |
| 三个 Provider Driver | 自动通过 | OpenAI-compatible Chat Completions、OpenAI Responses、Anthropic Messages 均用本地 HTTP/SSE fixture 完成真实 Kernel 两步 `read` tool loop、参数分片、原生结果回注、finish 与 usage/cost 归一化 |
| Registry/Router/模型 | 通过 | `resources/runtime/providers.json` 与 `provider-registry.ts` 合并并冻结 packaged/user 配置；显式 Driver 路由、动态 `/models`、capability/limit/pricing 和禁用状态不依赖任意 npm 动态加载 |
| Credential 与认证 | 通过 | `$BOOM_HOME/credentials.json` 使用 `0700/0600`、原子写、并发串行化、symlink 拒绝和环境变量覆盖；set/remove 操作真实 store，API Key 不进入 Provider 配置或任务树；OAuth capability 明确为 false |
| Web search | 通过 | M3 Network Broker 的默认 Exa 路径继续供主 `boom` profile 使用；managed Native 可注入替换 `searchProvider`，fixture 已证明工具调用仍走统一大小、流量与审计边界 |
| GUI/CLI/doctor | 通过 | GUI Provider 表单支持 Native Driver、模型 capability/limit/pricing 与 API Key lifecycle；本地 Native GUI 浏览器 smoke 验证三项 Provider、Driver 切换、价格字段、布局和零 console error，并修正遗留 OpenCode 凭据文案；`doctor` 只报告 credential readiness；`boom provider-smoke <provider/model>` 强制并验证真实 `read` 结果回注且本地 CLI fixture 通过 |
| C15 与全量回归 | 通过 | M5 subset 为 C06/C07/C09/C15/C18；Native GUI Runner 的 Driver/价格/set/remove 已走真实控制面；`bun run typecheck`；`bun test`：170 pass、0 fail、1015 assertions；`node --check prototype/boom-gui-v3.js` 通过 |
| 真实外部门禁 | **待人工** | 自动 fixture 无法证明公网 endpoint、真实账号权限、TLS/代理与模型实际 tool behavior；按 `docs/M5_MANUAL_PROVIDER_TEST.md` 对三个 Driver 各取得一次 `Provider smoke passed` 后才能宣告 M5 完成并进入 M6 |

### M6：附件、Context 与恢复等价

交付：

- 完成附件、上下文压缩、会话恢复和长期任务记忆的对照研究；
- 文本、图片和受支持文档附件；
- Context Manager、token 预估和 compaction；
- autocontinue、context overflow 和 rejected attachment 恢复；
- Evidence Store；
- subagent/evidence branch 的上下文隔离、部分失败、恢复和累计预算；
- 完整 retry 与诊断产物。

退出条件：C10–C12、C16、C18 通过；人为截断和压缩后任务可继续。

### M7：双 Runtime 产品验收

交付：

- CLI/GUI `--runtime`；
- 双 runtime 实际题目矩阵；
- OpenCode/Native 核心工具目录、schema、Shell/System Tool、开放网络、搜索和 `task` 对照；
- 简单题验证零前置编排开销；复杂/停滞题验证 20 分钟或 30% 预算门槛和 L1–L3 渐进升级；
- continuation、checkpoint、branch、verifier、recovery 全流程；
- 性能、token、成本、安全和正确率报告；
- 默认 Runtime 切换评审。

退出条件：Native 无阻断工具缺口，简单题无额外编排调用，复杂题能按需升级且结果无不可接受
回退；远程 Web/Pwn、搜索、Shell、系统工具和 `task` 真实题通过；用户可选择并明确看到 backend
provenance。

### M8：Native 默认与 OpenCode 移除

交付：

- Native 成为默认；
- 删除 OpenCode SDK/runtime/plugin 依赖；
- 删除兼容安装和环境变量；
- 更新 package、lockfile、README、doctor、迁移文档和第三方声明；
- 保留 V2 分支或 tag 的安装说明。

退出条件：打包产物中没有 OpenCode 运行时代码；Native 独立提供核心工具、开放网络、搜索和
`task`；全量测试、真实 smoke 和打包安装通过。

## 19. 建议代码布局

最终布局可按实施调整，但职责边界应保持：

```text
src/runtime.ts                         # 唯一 Runtime facade
src/runtime/contract.ts                # Boom-owned public contracts
src/runtime/native/kernel.ts           # Agent Loop
src/runtime/native/conversation.ts     # Conversation/message ledger
src/runtime/native/event-bus.ts        # normalized events
src/runtime/native/prompt.ts           # Prompt IR/compiler
src/runtime/native/context.ts          # budget/compaction/recovery
src/runtime/native/agent.ts            # Agent registry
src/runtime/native/provider.ts         # Provider registry facade
src/runtime/native/providers/*.ts      # explicit drivers
src/runtime/native/tool.ts             # Tool registry
src/runtime/native/tools/*.ts          # file/bash/system/web/search/skill/todo/task tools
src/runtime/native/policy.ts           # path/network/risk decisions
src/runtime/native/network.ts          # Network Broker
src/runtime/native/evidence.ts         # Evidence Store
src/orchestration/progress.ts           # meaningful progress ledger
src/orchestration/escalation.ts         # L0-L3 autonomy-first controller
src/runtime/opencode-conformance.ts     # 迁移期 adapter glue，最终删除
test/runtime-conformance.ts             # shared suite
test/runtime-scripted-provider.ts       # deterministic provider
resources/runtime/agents/**             # Boom-neutral agents
resources/runtime/skills/**             # skills
resources/runtime/policies/**           # immutable policy text
```

在迁移完成前，OpenCode SDK 仍只能由 `src/runtime.ts` 的兼容边界接触；Boom 产品核心不能为了
方便直接 import 相邻 OpenCode 源码。

## 20. 每个里程碑的工程纪律

1. 开始前更新本文状态和当前里程碑；
2. 检查 `git status`，不清理用户的 `ctf/runs/`、挑战和研究材料；
3. 先完成对应 Claude Code/OpenCode 对照研究，不清楚时先研究再设计；
4. 先增加或更新 conformance，再改变实现；
5. 一个提交只完成一个可验收边界，避免同时重写核心和 UI；
6. 新功能必须同时有取消、预算、错误和安全测试；
7. 记录 backend、Prompt、Tool Host 和 Provider driver 版本；
8. 不为通过测试加入题目专用分支；
9. 每个里程碑运行相关测试和 `bun run typecheck`；
10. 打包前运行 `bun run typecheck` 与 `bun test test/`；
11. Native 真实验收通过前，默认 Runtime 保持 OpenCode。
12. 工具安全问题优先在宿主沙箱和 Policy 修复，不以禁用主 Agent 核心工具作为长期补丁。
13. 简单题不得因为新增里程碑重新承担固定 intake/checkpoint/branch 成本。

## 21. Definition of Done

Boom V3 完成必须同时满足：

- Boom 自己实现完整 Agent Loop；
- Boom 自己实现 Prompt、Agent、Tool、Policy、Context、Event 和 Evidence 层；
- 产品核心不依赖 OpenCode、Claude Code 或某个 Provider 的原生类型；
- 主 Boom Agent 与 worker 的 bash/read/edit/list/glob/grep/task/Skill/Web/Boom 工具达到
  OpenCode 可观察语义等价，PATH 系统工具可在任务沙箱内调用；
- CTF 默认网络和搜索开放，不依赖目标 allowlist，同时宿主 HOME、凭据、Runtime 控制面和
  challenge 不可变边界保持隔离；
- `task` 默认可用，并发、递归、累计预算、目录和父级取消可控；
- 默认 autonomy-first；简单题没有固定多模型前置成本，复杂停滞题才渐进升级；
- CLI 与 GUI 的任务、历史、Provider、取消、继续和 Flag 审核可用；
- baseline、checkpoint、consultation、branch、verifier 和 recovery 全部运行在 Native；
- 网络、路径、凭据、危险执行和证据安全验收通过；
- 历史 V2 任务继续可读，正确 Flag 不进入工作区；
- 共享 conformance、核心测试、typecheck、打包和真实题目矩阵通过；
- 默认安装不包含 OpenCode runtime 或 plugin 依赖；
- 文档、许可证和第三方声明与最终依赖一致；
- 稳定 V2 分支/tag 可用于紧急回退。

## 22. 已知风险与控制

| 风险 | 控制 |
|---|---|
| 范围膨胀为重写通用 IDE Agent | 只实现 Boom 可见能力和 CTF 产品需求 |
| Provider 差异拖慢 Kernel | Driver 合约、scripted Provider、逐个显式支持 |
| Prompt 重构导致解题率下降 | Prompt snapshot、双 runtime A/B、稳定前缀指标 |
| 工具重写引入路径漏洞 | no-follow、symlink、property/fuzz 和越界测试 |
| 开放 Shell/系统工具影响宿主 | 任务文件系统、challenge 只读、无宿主 HOME/凭据/控制 socket、进程和资源沙箱 |
| 默认开放网络导致数据外泄 | 不注入宿主凭据、敏感内容出站检测、大小/并发限制和目标审计；严格网络作为显式 profile |
| `task` 递归或并发失控 | 默认总并发 4、递归深度 2、父级累计预算和整棵任务树取消 |
| 多模型编排拖慢简单题 | L0 直接求解、20 分钟或 30% 门槛、尾部无进展检查和简单题零升级验收 |
| 停滞判断把长命令当作无进展 | 进程心跳/输出/资源活动、productive tool 例外和可审计 trigger |
| Compaction 丢失任务进度 | durable state 优先、压缩产物、失败新会话恢复 |
| usage/cost 统计不一致 | step ledger、Provider usage fixture、预算 invariant |
| OpenCode 删除过早 | M8 硬门槛、默认延后、稳定分支回退 |
| 参考实现造成不必要相似 | 规格先行、来源记录、独立命名与实现审查 |

## 23. 延后决策

以下问题不阻塞 M0–M2，在对应里程碑前决策：

- Native 首发需要正式支持哪些 Provider；
- Web search 使用哪个可替换 driver；
- 严格企业网络 profile 的目的地址、代理和出站内容策略；CTF 默认开放网络不因该决策延后；
- `task` 默认并发 4、深度 2 之外的用户可配置硬上限；
- Provider credential store 是否使用系统 Keychain；
- 完整消息账本的持久化级别与可选加密；
- Linux/Windows 的主机级沙箱实现；
- MCP profile、交互式权限和远程 worker 的最终产品形态；
- Evidence Store 是否升级为 SQLite 或保持 JSONL；
- Native 稳定后是否保留隐藏的 OpenCode compatibility build。

## 24. 下一步

路线调整后的下一步是产品能力建设：

1. 实现 `$BOOM_HOME/mcp.json`，由 Boom 校验并编译到隔离 Runtime 的 `boom.json`；
2. 复用 OpenCode MCP status/connect/disconnect/OAuth 控制面，不实现第二套 MCP Client；
3. 增加 `boom mcp` CLI、桌面 MCP 管理界面、连接测试和 `doctor` 状态；
4. MCP 凭据只通过环境变量引用或后续 Boom credential store 提供，不写入挑战或运行目录；
5. 保持用户全局与项目 OpenCode 配置隔离，并为配置、连接和真实工具暴露增加回归测试；
6. Native Runtime 保留为现有实验与测试资产，不再作为新功能的前置门禁。

任何后续实现若与本文冲突，应先修改设计、说明原因并更新里程碑，而不是在代码中静默偏离。
