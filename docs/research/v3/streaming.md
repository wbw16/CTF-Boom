# M1 对照研究：流式处理

状态：M1 设计依据（2026-08-02）

## 1. Boom 当前问题和必须保持的行为

Boom 当前能转发 OpenCode text delta、tool state 和 step usage，但 reasoning delta、tool 参数碎片、
断流、背压、早订阅和最终聚合一致性没有共享规格。`prompt()` 返回最终 parts，`events()` 返回实时
流，两者可能重复表达相同内容；若直接拼接两者会重复输出或重复计费。

M1 必须明确：delta 是预览/增量，final result 是权威聚合；usage 只按已完成 step 结算；流中断
保留已接收诊断但不能伪造成功；订阅取消和生成取消是相关但不同的控制信号。

## 2. Claude Code 的产品设计与 Prompt/交互模式

Claude Code headless 的 `stream-json` 在开启 partial messages 后按 token 发出增量，最终一行 result
包含结算信息。官方 Agent SDK 要求即使看到 result 也继续迭代到 stream 结束。Claude API 的公开
SSE 采用 message/content-block start、delta、stop 的层次；tool input 可细粒度流式输出，但可能在
截断时留下不完整 JSON，消费者必须累积并验证，不能把碎片当作可执行参数。

这些行为支持两个关键结论：实时 delta 可以丢失或被切分为任意粒度，最终聚合不能依赖 delta
数量；工具只能在完整、通过 schema 的参数上执行。

公开依据：

- [Claude Code：stream-json and retry events](https://code.claude.com/docs/en/headless)
- [Claude API：Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Claude API：Fine-grained tool streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming)

## 3. OpenCode 的产品设计、公开接口与实现边界

OpenCode SDK 通过 SSE 订阅事件。锁定版本的 `message.part.updated` 可同时包含完整 part 与 delta；
text/reasoning 的 delta 和 tool state 更新都沿同一 part 通道出现。step-finish 提供一次模型 step 的
最终 usage、cost 和 reason，prompt HTTP response 提供最终 parts。

当前 Boom adapter 只转发 text delta；reasoning 的 `delta` 被忽略，session idle/error/compacted
也未翻译。OpenCode 的 retry part 是模型重试进度，不等同于 Boom 产品层 length-recovery prompt。
两者必须保留为不同来源的 trace entry。

公开依据：

- [OpenCode Server API: `/event` SSE](https://opencode.ai/docs/server/)
- [OpenCode SDK async iterable streams](https://opencode.ai/v2/docs/build/client)
- 本地 `@opencode-ai/sdk@1.18.4` 公开 Event/Part 类型

## 4. 两者共同采用的成熟模式

- 传输使用增量事件，宿主同时维护最终聚合对象；
- text、reasoning、tool input/status 和 usage 具有不同生命周期；
- delta 的切片边界不是业务语义，比较时应合并连续同类 delta；
- finish/error 到达前不能把 partial stream 当作成功结果；
- abort signal 应向下传播到网络请求和活动工具，流消费者也能独立停止读取。

## 5. 两者存在分歧的地方

- Claude 消息 API 使用细粒度 content block 事件；OpenCode 1.18.4 对 Boom 暴露较高层的 part 更新。
- Claude Code headless 是 NDJSON query stream；OpenCode 是实例级 SSE 加单独 prompt response。
- Provider 对 reasoning 与 tool argument delta 的可见性不同。Boom capability 必须如实声明，不能用
空事件模拟支持。

## 6. Boom 采用的设计及网络安全调整

- Runtime event 表达“已归一化增量”，不暴露 SSE/NDJSON chunk；
- normalized trace 合并相邻同类型 text/reasoning delta，使不同 chunk 边界可比较；
- tool call 在参数未完整并通过 schema 前只允许 pending；Tool Host 只接收完整 input；
- step-finish 是 usage/cost 的唯一累计点，prompt result 的 usage 用于缺失事件时的最终核对，不能
  与相同步骤重复相加；
- `finish` 事件和 prompt result 使用同一 Boom finish reason 集；未知 Provider reason 映射到
  `unknown`，原值只进脱敏 diagnostic reference；
- response body、header、request URL 和 tool output 在 trace 前做大小限制与 secret redaction；
- 背压由 async iterable 自然传播；实现不得无限缓存完整输出，超限内容写入 `work/` 后只传摘要。

## 7. 未采用方案和原因

- 不按 token/chunk 数断言 streaming：Provider 和代理会任意重分块。
- 不从 partial tool JSON 猜测或修复参数后直接执行：截断输入可能改变危险操作含义。
- 不把“事件流断开”自动解释为 cancelled；只有用户/宿主 abort 才是 cancelled，其他断流是
  retryable 或 terminal provider error。
- 不复制第三方 SSE fixture；Boom scripted Provider 从本规格独立生成最小协议响应。

## 8. 对应 conformance 与验收用例

- C06：多 tool delta 聚合及 tool result 后下一 step；
- C07：任意 text/reasoning 分块归一为相同 trace，usage/cost 不重复；
- C08：订阅取消、请求取消和工具取消；
- C09：429、5xx、断流、length、empty、malformed tool；
- C10（后续）：media capability 与拒收恢复；
- C11（后续）：context overflow、compaction、autocontinue；
- C18：日志/响应大小和 secret redaction。

scripted Provider 必须可记录收到的 messages/tools/media，按 step 返回固定 delta/tool/usage/finish，
并注入 HTTP error、断流、延迟和 malformed tool。测试比较 normalized trace，不比较网络分块。

## 9. 生产回归补充（2026-08-02）

本轮 `/api/state` 单次约 526 KiB，旧前端收到任何 SSE 都在 250ms 后重拉整份状态；与此同时，
最长达数分钟的预处理 turn 没有转发一个 delta。网络本身不慢，但产品表现为长时间静默、随后
整页突变。

修订后的端到端规则是：

1. 所有模型 turn 在 prompt 前建立 conversation-scoped subscription；
2. final result 仍是回复、finish 和最终 usage 的权威值，事件只用于活动、工具、retry 和实时预览；
3. final 后等待 terminal/stream close 的时间有上限，然后独立取消订阅并释放 adapter 资源；
4. 预处理 text/reasoning delta 不原样写入产品历史，只按字符量和时间窗口生成有界 activity；
5. `run.event` 由前端直接合并到当前 run，避免对每个增量请求完整 notes/files/checkpoints/events；
6. 大命令完整输出保存在 `work/.boom/commands/`，返回模型的可见部分最多 32 KiB，避免兼容
   Runtime 把超大 tool result 外置到宿主全局目录并形成跨任务证据污染。

这与 Claude Code 的 bounded drain/backpressure、OpenCode 的 SSE event + prompt response 双通道
一致，但 Boom 自行定义排空窗口、activity 聚合和产品增量协议。
