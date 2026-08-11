# M4 对照研究：Native Agent Kernel、消息回注、取消与恢复

状态：M4 实现依据（2026-08-04）

## 1. 研究范围与来源边界

本轮只研究可观察产品行为和公开合约，不复制第三方 Agent Loop、Prompt、schema、错误文案或
fixture。Boom compatibility 的精确行为以仓库锁定的 `opencode-ai@1.18.4`、公开 SDK 类型及
`/Volumes/Storage/Code/opencode@0a601cf` 为版本化参照；OpenCode 当前文档用于理解产品方向，
不反向改变锁定版本的兼容事实。

公开依据：

- [Claude Agent SDK：Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Claude Agent SDK：Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude Code：Subagents](https://code.claude.com/docs/en/sub-agents)
- [OpenCode：Agents](https://opencode.ai/docs/agents/)
- [OpenCode：Server / SSE](https://opencode.ai/docs/server/)

## 2. 成熟实现的共同模式

Claude 的公开 loop 是“模型响应 → 完整工具参数 → 工具结果回注 → 下一 turn”，直到无工具调用；
最终 result 与实时 stream 分工明确。它公开 max turns、总预算、session resume/fork，并明确说明
subagent 使用独立上下文、只把最终结果作为父级 tool result 回注；subagent 成本计入总预算，达到
上限会阻止新任务并终止仍在运行的后台任务。

OpenCode 把 primary/subagent、`task` 权限和 step 上限作为 Agent 配置；subagent 有 child session，
父子 session 可导航。锁定版本使用 session/message/part 保存模型轮次，工具结果进入后续消息，
全局 SSE 负责实时事件，prompt response 负责最终聚合。

两者共同支持以下结论：

1. 消息历史必须保留 user、assistant tool call 和一一对应的 tool result，不能把工具输出拼进下一条
   普通用户 Prompt；
2. Provider delta 只用于预览，完整且通过 schema 的工具参数才可执行，最终 result 才是权威结算；
3. continuation 复用同一消息序列，跨进程 resume 需要稳定 session ID、持久 ledger 和来源校验；
4. subagent 不继承父会话全文，只获得明确任务和独立目录，最终报告作为父级对应 call ID 的结果；
5. 取消必须从父级传播到生成、活动工具和全部后代；总预算必须覆盖整棵任务树；
6. 只读/明确可并行工作可以并行，有副作用工具默认串行，不能因一个普通子任务失败取消兄弟任务。

## 3. Boom Native 采用的设计

### 3.1 Conversation 与消息账本

每个 Native Conversation 在任务自己的
`work/.boom/native/conversations/<conversation-id>/` 下保存：

- `manifest.json`：Native backend、Provider ID/version、Prompt version、Kernel 限制；
- `messages.jsonl`：Boom 自有 user/assistant/tool 消息，写入后才进入下一次 Provider request；
- `events.jsonl`：单调 sequence 的 Boom RuntimeEvent，先落盘、后广播；
- `budget.json`：跨 continuation/resume 的任务树累计 usage、cost 和硬上限；
- `task-tree.jsonl`：subagent queued/running/terminal 状态及相对目录。

`resumeConversation` 只在 conversation ID、Native provenance、Provider ID 和 Prompt version 一致时
重建请求；不读取或重放 backend 私有对象。Provider retry 中的 partial delta 不进入 ledger，避免把
失败半包伪装成有效 assistant 消息。工具输入和诊断在 durable state 前做有界 secret redaction。

### 3.2 多 step loop 与错误恢复

Kernel 每 step 向 Driver 提供稳定 system、当前 Agent 的 Registry 工具定义和完整 ledger。Driver
返回 text/reasoning delta、tool-call fragments、usage 和唯一 finish。Kernel 完整聚合参数后执行：

- JSON 或 Registry schema malformed：不执行，生成带同一 call ID 的 error tool result，允许模型
  下一 step 修复；
- retryable Provider failure：在有界次数内重试同一步，不重复 user message；
- length：最多进行配置数量的显式 continuation；
- empty、缺失/重复 finish、非法 fragment：作为 `malformed-response` 终止；
- 每 step usage 只结算一次，最终 prompt result 汇总本轮完整任务树 usage。

普通 Boom Tool Host 调用串行。相邻 `task` 调用可并行，因为它们有独立 workspace/ledger；全局
semaphore 限制实际 Provider/Tool 活动而非“等待子任务的父调用”本身，避免四个父任务都持有 permit
并等待孙任务造成递归死锁。

### 3.3 task tree

默认总活动并发为 4、最大递归深度为 2，均可配置。每个 `task`：

1. 从父任务只读 `challenge/` 和 `NOTES.md` 创建快照；
2. 使用独立 `work/`、消息账本、事件流和 `boom-worker` profile；
3. queued/running/terminal 先写根 task-tree audit，再发父 Conversation 的 `task-state`；
4. 只把有界最终报告、task ID、相对目录和 usage 作为父级 tool result 回注；
5. 普通失败只使对应 tool call 为 error，兄弟继续；父 abort 或累计预算越界取消整棵树。

任务事实仍以各 workspace 的 `work/`、`NOTES.md` 和 Boom state 为准。消息 ledger 是可恢复的模型
上下文，不替代 durable CTF evidence；M6 compaction 可以重建 ledger，但不能删改事实文件。

## 4. 未采用方案

- 不包装 Claude Code 或 OpenCode 作为“Native”：这只会产生第二个兼容 adapter，无法验证 Boom
  自有 Kernel、Registry、Policy 和任务树预算。
- 不把 Provider SSE/SDK event 持久化为公共日志：其 schema 不稳定且可能包含 credential/raw body。
- 不让 subagent 直接共享父 `work/`：并发写会破坏证据归属，父级也无法证明结果来自哪个任务。
- 不让一个 subagent error 自动取消 siblings：只有父级取消和共享硬预算具有树级终止权限。
- 不把 parent 等待时间计为活动并发 permit：会在合法递归深度内形成资源死锁。
- 不在 M4 假装支持 attachment、compaction、Provider credential 或真实 OAuth；对应 capability 明确为
  false，留给 M5/M6。

## 5. 对应验收

- C01/C13/C17/C19：中性 system/profile/Registry 工具定义，Native 排除 compatibility-only `write`；
- C02–C05/C20：所有真实工具继续通过 M3 Tool Host/Policy，不在 Kernel 重写路径或 Shell 规则；
- C06/C07：同 step 多工具、跨 step 回注、delta、usage、cost 和唯一 finish；
- C08：prompt 前、生成中、任务工具中取消及幂等 abort；
- C09：retry、length、empty、malformed 和断流分类；
- C12/C18：顺序 continuation、durable resume、provenance、redaction 和有界诊断；
- C16/C21：隔离目录、部分失败、深度 2、并发 4、结果回注、累计预算和任务树取消。
