# M1 对照研究：Session 与 Event

状态：M1 设计依据（2026-08-02）

## 1. Boom 当前问题和必须保持的行为

Boom 当前只归一化 text delta、tool state、step-finish 和 retry。GUI 的用户事件、磁盘
`events.jsonl` 与 Runtime 诊断尚未共享完整生命周期语义；OpenCode 全局 event subscription 还可能
包含其他 session 的事件。合约也不能表达 reasoning、compaction、Provider warning/error、取消和
最终 finish。

必须保持订阅先于 prompt，避免首个 delta 丢失；产品只消费 Boom 类型；conversation 绑定已解析
任务目录；abort 能从任意阶段调用；旧 Runtime 和 fake 测试仍可渐进迁移。

## 2. Claude Code 的产品设计与 Prompt/交互模式

Claude Code 的公开 headless/SDK 流以 system init 开始，随后产生 assistant/user/tool 相关消息和
可选 partial stream event，最后产生 result；官方明确提醒 result 后仍可能有少量尾随系统事件，
消费者应读到 stream 完成。`stream-json` 每行一个事件，最后 result 汇总最终文本、cost 和 session
元数据。session ID 可用于 resume；hooks 公开 SessionStart、Pre/PostToolUse、Stop、PreCompact、
SessionEnd 等生命周期点。

这说明“最终结果已得到”与“事件流已关闭”是两个相邻但不同的边界；resume 依赖持久 session ID，
而 hook/event 是可观察性与控制面，不应混入 assistant 内容。

公开依据：

- [Claude Code：Run programmatically / stream-json](https://code.claude.com/docs/en/headless)
- [Claude Code：Agent loop message lifecycle](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Claude Code：Hooks lifecycle](https://code.claude.com/docs/en/hooks)

## 3. OpenCode 的产品设计、公开接口与实现边界

OpenCode 1.18.4 的 `/event` 是全局 SSE；`message.part.updated` 同时承载完整 part 和可选 delta。
session status、idle、compacted 和 error 是独立事件。工具状态属于 message part，step-finish 包含
本 step usage/cost。SDK prompt response 返回最终 assistant message，事件流负责实时增量。

Boom 当前 adapter 只选取 `message.part.updated`，且尚未按 conversation ID 过滤；因此 M1 必须在
边界过滤，避免并发任务串流。SDK 暴露的 session/message/part ID 只用于 adapter 内关联，不能写入
稳定 Boom schema，除非被降格为非敏感 diagnostic reference。

公开依据：

- [OpenCode Server API and SSE endpoint](https://opencode.ai/docs/server/)
- [OpenCode SDK client streaming](https://opencode.ai/v2/docs/build/client)
- 本地锁定接口：`@opencode-ai/sdk@1.18.4` 公开 Event/Part 类型
- MIT 行为参照：`/Volumes/Storage/Code/opencode` 提交 `0a601cf`

## 4. 两者共同采用的成熟模式

- 稳定 session/conversation ID 关联所有消息、工具与诊断；
- 生命周期、增量内容、工具状态、usage 和错误是 discriminated events；
- 事件流用于实时显示，最终聚合对象用于权威结算；
- resume/continue 复用会话历史；取消与压缩有独立可观察边界；
- 调用者必须容忍新增事件类型，并按 session 隔离并发流量。

## 5. 两者存在分歧的地方

- Claude Code headless stream 是单次 query/session 视角；OpenCode `/event` 是实例级总线。
- Claude Code result 是显式终止消息；OpenCode 1.18.4 常由 prompt response、step finish、session
  idle/error 的组合推断终止。
- Claude Code 公开流中 system/assistant/result 是消息类别；OpenCode 主要以 session event 与
  message part 表达。Boom 不选择任一命名体系作为公共 API。

## 6. Boom 采用的设计及网络安全调整

Boom event 采用版本化、conversation-scoped 的 discriminated union。M1 至少表达：

- `conversation-state`：preparing/generating/retrying/compacting/completed/cancelled/failed；
- `text-delta`、可见的 `reasoning-delta`；
- `tool-state`：pending/running/completed/error；
- `step-finish`：step usage/cost/finish；
- `retry`：attempt、归一化 failure、可选 delay；
- `compaction`：started/completed/failed；
- `provider-diagnostic`：warning/error 与脱敏 failure；
- `cancelled` 与唯一 `finish`。

OpenCode adapter 在返回 Boom event 前按 conversation ID 过滤。normalized trace 将真实
conversation/call/request ID 映射为出现顺序稳定别名，并移除时间戳、绝对临时目录、原始 Provider
body 与 secret。审计“先落盘再广播”属于后续 Event Bus 实现，M1 只规定 contract/trace。

## 7. 未采用方案和原因

- 不把 GUI `RunEvent` 作为 Runtime event：前者包含 CTF 产品状态，职责不同。
- 不持久化 raw backend event 作为默认审计：schema 不稳定且可能含敏感响应。
- 不要求 hidden chain-of-thought；只归一化 Provider 明确允许展示的 reasoning summary/delta。
- 不使用全局事件数量或 part ID 做等价判断：不同 adapter 的拆分粒度可以不同。
- 不从逆向 Claude Code 材料复制 transcript schema；公开 stream 行为足以形成 Boom 规格。

## 8. 对应 conformance 与验收用例

- C06：tool call 状态有序、call/result 一一对应；
- C07：text/reasoning delta、step usage/cost 与唯一 finish；
- C08：取消顺序、幂等 abort、取消后无新事件；
- C09：retry 与 provider error 归一化；
- C11（M1 contract）：compaction 状态；
- C12：conversation continuation；
- C16（M1 contract）：并发分支事件不串流；
- C18：secret redaction、稳定 ID、backend provenance。

基线 trace 只断言语义偏序：例如 tool pending 必须先于 completed，但允许 backend 插入额外
running 或 diagnostic；finish 必须唯一且位于该次 prompt 的语义结尾。

## 9. 生产回归补充（2026-08-02）

真实批次中已有 9 个 branch report 完成，但父 `boom-state.json` 仍把全部分支显示为 queued；同时
父运行的 token/cost 只有所有 Promise 结束后才跳变。这说明“最终能写对”不足以支撑可恢复任务。

Boom 增补以下约束：

- child 生命周期使用 `queued/running/completed/failed/cancelled`，每次转移均 atomic save；
- 持久化成功后才发送 branch progress，通知携带 branch ID、settled/total 和累计 usage；
- Runtime 原始 session ID 只作进程内关联，产品事件用 stage/role/branch scope，不泄漏 backend ID；
- GUI SSE 的 `run.event` 是可直接应用的增量；`state.changed`、started/finished 和 reconnect 才触发
  权威 snapshot reconciliation；
- SSE 保留单调 event ID 和 heartbeat。未来 Event Bus 增加 replay cursor 时，仍保持
  persist-before-broadcast，避免重连看到从未落盘的状态。

Claude Code 的 subagent parent relationship 和本地研究材料中的 task terminal guard/offset 只作为
行为参照；OpenCode 的 instance/workspace 过滤只作为边界参照。Boom 不复用两者事件 schema。
