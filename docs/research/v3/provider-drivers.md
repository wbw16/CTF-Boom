# M5 Provider Driver、认证与目录对照研究

日期：2026-08-04

## 1. Boom 当前问题和必须保持的行为

M4 已经拥有 Provider-neutral Agent Loop，但只接 scripted Driver。M5 必须让真实协议进入同一
Kernel，同时保持以下边界：Provider 只生成流和工具调用，不执行工具；API Key 不进入任务目录、
消息账本或诊断；模型的 capability、usage、cost、finish 与错误先归一化，再交给上层；Native
不能通过任意 npm 字符串加载代码。

## 2. OpenAI 的公开协议

OpenAI 当前推荐的有状态生成表面是 Responses API。其流由带类型的 SSE 事件组成，文本使用
`response.output_text.delta`，完成态携带最终 response；函数调用使用 `function_call`，本地执行后
以相同 `call_id` 的 `function_call_output` 回注。来源：

- [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)

“OpenAI-compatible”不是一个完整统一标准。大量第三方 endpoint 实际兼容的是 Chat Completions：
`choices[].delta`、分片 `tool_calls[].function.arguments`、`finish_reason`，以及可选的最终 usage chunk。
因此 Boom 把 official Responses 与 compatibility Chat Completions 作为两个显式 Driver，不通过
endpoint 名称猜协议。

## 3. Anthropic 的公开协议

Anthropic Messages 流使用 `message_start`、content block start/delta/stop、`message_delta` 和
`message_stop`。工具参数以 `input_json_delta.partial_json` 分片，必须先完整累积，再解析；本地工具
结果作为 user 消息中的 `tool_result` block 回注。usage 会在开始和后续 message delta 中累计，
cache read/create 分桶独立。来源：

- [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
- [How tool use works](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works)
- [Claude API errors](https://platform.claude.com/docs/en/api/errors)

## 4. OpenCode 的产品模式

OpenCode 将 Provider 目录、认证、模型选择和自定义 endpoint 组合为用户控制面，并用模型目录
覆盖配置；自定义兼容 endpoint 通过 adapter 配置。公开文档同时支持交互式 connect、环境变量和
配置模型。来源：[Providers](https://opencode.ai/docs/providers)、
[Models](https://opencode.ai/docs/models)。

Boom 保留“目录 + 用户覆盖 + credential lifecycle”这一成熟产品模式，但 Native registry 只允许
Boom 注册的三个协议 Driver。迁移期的 npm adapter 字段仅为 OpenCode compatibility backend 保留，
不会进入 Native Driver 选择或动态执行。

## 5. 共同模式与关键分歧

共同模式：SSE 增量输出、工具参数需跨 chunk 累积、工具结果必须用 Provider 原生关联 ID 回注、
usage 以服务端最终统计为准、认证与普通模型配置分离。

关键分歧：OpenAI Responses 使用 item/call 事件与 `function_call_output`；Chat Completions 使用
assistant/tool message；Anthropic 使用 content blocks 与 user `tool_result`。缓存用量字段的包含关系
也不同。把三者压成一个“近似 OpenAI”请求会丢失关联 ID、缓存成本或停止原因，因此差异只在
Driver 内消化，Kernel 不识别任何原生事件名。

## 6. Boom 采用的设计

1. `provider-http.ts` 是共享 HTTP/SSE 边界：credential-free Base URL、认证 header、取消、状态码
   分类、有界并脱敏的错误、CRLF/多 chunk SSE framing 和 4 MiB 单事件上限。
2. `openai-compatible-driver.ts` 只实现 Chat Completions；`openai-responses-driver.ts` 只实现
   official Responses；`anthropic-driver.ts` 只实现 Messages。
3. `provider-registry.ts` 合并只读 packaged registry 与 `$BOOM_HOME/providers.json` 的非秘密覆盖；
   驱动 ID、Base URL、模型能力、上下文、输出上限和每百万 token 价格被校验并冻结。
4. `credential-store.ts` 把 API Key 单独保存在 `$BOOM_HOME/credentials.json`，目录权限 `0700`、
   文件 `0600`，拒绝 symlink；`BOOM_<PROVIDER>_API_KEY` 可覆盖文件。Native OAuth 未实现且
   capability 明确为 false，避免复用未经授权的第三方登录流程。
5. 标准 usage 分桶为 uncached input、ordinary output、reasoning、cache read/write；价格缺失时
   cost 明确为 0，而不是估算一个看似精确的值。
6. 后台模型发现是 best-effort、10 秒有界的 `/models` 请求；显式 `discoverModels()` 则向 GUI
   返回可诊断错误，并支持尚未保存的 Key、Driver 与 Base URL。获取结果与草稿合并，静态用户模型
   始终保留，目录失败不删除已配置模型。
   Anthropic 代理同时区分官方 `x-api-key` 与兼容 Bearer 凭据；SDK 风格的 Base URL 是路径前缀，
   Driver 会统一补全 `/v1`，确保目录和 Messages 使用同一认证与路径语义。
7. Web search 继续复用 M3 的 Network Broker：主 `boom` profile 默认拥有 `websearch`，默认
   Exa 路径仍受 DNS pin、大小、超时、累计流量和审计约束；宿主可注入 `searchProvider` 替换。
   不把 Provider 托管搜索伪装成本地工具，以免绕过 Boom Policy 与统一网络审计。

## 7. 未采用方案

- 不用一个通用 Driver 猜测三种协议；协议错误应在配置时显式，而不是运行中静默 fallback。
- 不把 SDK 对象或原生事件传入 Runtime contract；这会重新耦合 GUI、预算和恢复逻辑。
- 不把 API Key 写入 Provider 配置、任务环境或请求审计。
- 不允许 Native 从配置加载任意 npm adapter；compatibility backend 可继续读取旧字段。
- 不宣称附件已可传输。M5 只归一化目录 capability，真正 media message 与恢复属于 M6。

## 8. Conformance 与验收

- C06/C07：三个本地 HTTP fixture 均完成两步流式工具循环，覆盖参数分片、结果回注、唯一 finish、
  usage 与 cost。
- C09/C18：HTTP 401 分类为 authentication，request ID 保留，响应中回显的 credential 被精确
  脱敏；SSE framing、非 SSE、断流和 malformed JSON 走显式失败。
- C15：Native catalog/auth method/set/remove 走真实 Boom store；并发写入不丢 key；密钥不出现
  在 Provider 配置或任务树中；文件与目录权限被测试。
- 自动 fixture 不能证明公网 endpoint、账号权限、代理/TLS 与实际模型行为。M5 最终人工门禁是
  使用用户自己的 OpenAI-compatible、OpenAI 与 Anthropic 凭据各运行一次真实流式 tool loop。
