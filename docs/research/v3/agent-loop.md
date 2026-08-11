# M1 对照研究：Agent Loop

状态：M1 设计依据（2026-08-02）

## 1. Boom 当前问题和必须保持的行为

Boom V2 的产品编排已经拥有持久任务、多 turn continuation、baseline、checkpoint、会诊、
evidence branch、verifier、recovery、累计预算和宿主取消，但底层循环仍由 OpenCode 执行。
当前 `AgentRuntime` 只抽象了“创建 conversation、发出 prompt、订阅少量事件、abort”，不能表达
循环的准备、生成、工具回注、压缩、重试和终止阶段。

M1 必须保持：

- 一个任务可顺序发出多个 prompt，模型切换不改变任务目录；
- 工具结果进入下一次模型判断，工具调用与结果按 call ID 对应；
- 每个 step 的 usage 只累计一次，cache read 仍由产品层按既定权重计费；
- 外部取消、输出上限、长度恢复、空回复和 Provider 故障仍有明确结果；
- solver 方法不写死在底层循环，正确 flag 也不能由 Runtime 自行确认。

## 2. Claude Code 的产品设计与 Prompt/交互模式

Claude Code 官方将 harness 描述为持续循环：模型接收 prompt、system、工具和历史，返回文本和
零个或多个工具调用；宿主执行工具并把结果回注；没有后续工具调用时才产生最终结果。官方 SDK
把初始化、assistant message、tool result 和最终 result 作为不同消息，并在 result 中汇总 usage、
cost、session ID 与限制类结束状态。工具权限和 hooks 位于工具执行前后，能够拒绝调用并把拒绝
结果反馈给模型，而不是依赖模型自律。

产品层还把 turn/budget 上限、并行工具、subagent 成本、interrupt/steer 和自动 compaction 视为
循环控制的一部分。压缩会发出可观察边界；早期细节可能被摘要替换，因此长期规则与 durable
memory 不应只存在于首轮对话。

公开依据：

- [Claude Code：How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Claude Code：How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Claude Code：Hooks reference](https://code.claude.com/docs/en/hooks)

## 3. OpenCode 的产品设计、公开接口与实现边界

OpenCode 将 session 作为多消息容器，由 prompt 驱动循环。锁定的 1.18.4 SDK 将 response 分成
text、reasoning、tool、step-start、step-finish、retry、compaction 等 part；工具具有
pending/running/completed/error 状态，step-finish 携带 finish、usage 和 cost。HTTP/SDK 提供
session create、prompt、abort、summarize 及全局事件订阅。

相邻 MIT 仓库只用于提炼行为：循环持续到非 `tool-calls` finish；工具 step、自动压缩、retry 和
abort 都由 session 层协调。Boom 不导入该仓库源码，也不复用其函数、状态 schema 或错误文案。

公开依据：

- [OpenCode Server API](https://opencode.ai/docs/server/)
- [OpenCode Agents and permissions](https://opencode.ai/docs/agents/)
- [OpenCode Custom tools](https://opencode.ai/docs/custom-tools/)
- 本地锁定接口：`@opencode-ai/sdk@1.18.4` 的公开 `.d.ts`
- MIT 行为参照：`/Volumes/Storage/Code/opencode`，观察提交 `0a601cf`，不作为 Boom 代码依赖

## 4. 两者共同采用的成熟模式

- session/conversation 拥有消息历史，产品调用方不自己拼 Provider 原生历史；
- 每次模型输出可能包含文本与多个工具调用，工具结果回注后继续同一循环；
- 工具执行有宿主生命周期和权限检查点；
- stream 中间事件与最终聚合结果并存，最终结果是结算 usage/finish 的权威边界；
- retry、cancel、compaction 和限制结束均是明确控制流，而非普通 assistant 文本；
- agent/role 决定可见工具与权限，subagent 是隔离的子执行单元。

## 5. 两者存在分歧的地方

- Claude Code SDK 对调用者暴露更明确的 init/result 消息和限制错误 subtype；OpenCode 1.18.4
  更偏向 session part 与全局事件总线，prompt HTTP response 同时返回最终 message parts。
- Claude Code 公开说明同一模型 turn 可并行执行工具；Boom 锁定 OpenCode 行为允许模型产生多
  tool part，但 Boom 目前没有独立声明副作用和并行安全性。
- 两者的 permission、hook、session status、compaction 和 Provider 错误名称均为产品私有形状，
  不能成为 Boom 公共合约。

## 6. Boom 采用的设计及网络安全调整

Boom 定义自己的 Conversation 状态与事件，不照搬任一产品消息类型：

1. `created -> preparing -> generating`；
2. 每个 tool call 依次经历 pending/running/completed 或 error；
3. 工具结果由 Tool Host 回注后再次 generating；
4. retrying/compacting 是可观察的临时阶段；
5. completed/cancelled/failed 只能出现一次，随后 conversation 不再产生事件。

M1 先扩展合约和测试轨迹，不提前实现 Native Loop。未来 Kernel 默认串行执行有副作用工具，只有
工具声明 read-only 且 parallel-safe 才可并发。Policy Engine 在工具执行前强制路径、命令、网络、
凭据和预算约束；模型看到拒绝结果但不能绕过。任务事实继续落在 `work/`、`NOTES.md` 和 Boom
state，消息历史只是可压缩缓存。

## 7. 未采用方案和原因

- 不把 OpenCode session part 直接升级为 Boom event：会继续泄漏 backend 版本差异。
- 不把 Claude Code SDK/CLI 包装成第二 Runtime：M1 的 scripted Provider 要验证 Boom 合约，
  不是引入另一套完整且绑定单一厂商的 harness。
- 不复制 Claude Code 或 OpenCode 的 Prompt、函数、fixture 和错误文本。
- `claude-code-source-code/` 只作只读的产品行为研究材料：可提炼 task 的显式终态、父子关系、
  有界 activity window 和 durable output offset 等模式；不以其中模块/函数命名决定 Boom 结构，
  不复制源码、Prompt、schema、常量或错误文案。规范依据仍优先采用 Anthropic 官方公开行为。
- 不在 M1 将工具并行设为普遍能力：缺少 side-effect 元数据时会破坏证据与文件一致性。

## 8. 对应 conformance 与验收用例

- C01：无工具 role 的输入与单 step 终止；
- C04/C05：受控命令与 durable note 工具的生命周期；
- C06：同 step 多工具、跨 step 回注、call ID 唯一和一一对应；
- C08：prompt 前、生成中、工具中取消以及幂等 abort；
- C09：transient retry、length、empty、malformed 和不可恢复 error；
- C12（M1 只固化合约）：同 conversation 顺序 prompt；
- C13：role 工具集合隔离；
- C17：稳定 role/prompt 输入。

M1 normalized trace 比较状态顺序、call 对应、usage、finish 与错误分类，不比较随机文本、真实
session ID、时间戳或 backend 内部事件数量。

## 9. 生产回归补充（2026-08-02）

本轮真实批次暴露了 M1 原基线没有覆盖的四个 loop 级问题：

1. compatibility tool schema 声明的 `.default()` 没有稳定传到插件 handler，省略 `timeoutMs` 时
   实际定时器接近 0ms；因此所有默认值、范围、枚举和布尔开关必须在 Boom Tool Host 执行边界
   再归一化，schema 只负责模型交互，不是安全边界；
2. baseline/checkpoint/consultation/branch/verifier 都调用同一个 one-shot turn，却没有订阅事件；
   编排阶段与主 solver 必须共享同一条“先订阅、再 prompt、final 权威、有界排空”的 loop 语义；
3. branch 不能只有内存中的 running 和最终批量落盘。每个 queued/running/terminal 转移必须先
   持久化，再向产品 Event Bus 广播；
4. 子任务输出必须带 Boom 自有 scope（stage/role/branch ID）。父运行只显示有界活动摘要和工具
   生命周期，完整模型报告继续写入 branch/checkpoint artifact，不能把大段报告塞回事件历史。
5. compatibility hook 不得无条件写入 Provider 可选请求参数。`maxOutputTokens` 会被部分兼容端点
   翻译为不支持的 `max_output_tokens` 并使整轮 400；输出控制应由 Boom budget/字符上限承担，
   直到 Provider Driver 明确声明并映射自己的 token-limit capability。
6. OpenCode 旧后端只通过 Agent Prompt 约定 WRITEUP 模板，再由主机正则读取候选；它没有提供
   可依赖的结构化“解题成功”响应。模型把 `**Flag:** value` 写成视觉等价的
   `**Flag: value**` 就会漏报；即使正文出现 `FINAL_FLAG`，候选也要等整轮结束才进入 host state，
   期间还可能错误触发 recovery checkpoint。Boom 因此不再从新运行的回复正文提取候选，而由
   `ctf-submit` 原子写入 session-scoped `work/.boom/candidate.json`。Tool completed 事件触发 GUI
   权威 snapshot 刷新，submitted candidate 直接进入登记/验证而不先跑恢复检查点。历史读取仍兼容
   两种旧 Markdown；`completed` 仍只表示 turn 正常结束，候选必须独立验证后才能归档为 solved。
7. `ctf-submit` 表示“发现候选”，不是“任务已解出”。tool completed 后宿主立即终止当前 solver
   turn，并进入 `pending / accepted / rejected` 判定：未配置比赛平台适配器时等待人工判定；拒绝值
   写入 task/NOTES 后续跑同一题；接受后启动独立 Writeup turn，只有 Writeup 含已确认 flag 和可复现
   步骤才归档。比赛题目获取与 flag 提交统一位于可选 `CtfPlatformAdapter` 边界，核心状态机不依赖
   具体平台、认证或请求格式。模型盲审只能提供辅助证据，不能代替平台/用户判定。

相邻 OpenCode 当前实现对外部目录 effect 的检查，以及 Claude Code 公开的 subagent parent ID、
result/stream 边界，支持这些修订；Boom 的实现仍使用自己的 RuntimeTurn、branch progress 和
RunEvent 形状。
