# M5 真实 Provider 人工验收

自动测试已经用本地 HTTP/SSE fixture 覆盖三个 Driver 的工具循环、分片、usage/cost、错误分类、
credential set/remove 和密钥隔离。本页只验证自动 fixture 无法证明的公网 endpoint、真实账号权限、
模型行为和 TLS/代理链路。每条 smoke 通常会产生两次很小的模型请求。

## 1. 准备

```sh
bun install
bun link
boom doctor
```

使用默认 GUI，Provider、认证和模型目录都由 OpenCode 管理：

```sh
boom gui
```

打开 **设置 → Provider 与模型**：

- OpenAI：填写 API Key，点击“应用并刷新 OpenCode”，再选择 OpenCode 返回的一个支持函数调用的模型；
- Anthropic：填写 API Key 或按 OpenCode 的兼容配置完成认证，点击“应用并刷新 OpenCode”，再选择 OpenCode 返回的支持 tool use 的模型；
- OpenAI-compatible：新建 Provider，选择 `OpenAI-compatible` Driver，填写
  credential-free Base URL 和 API Key，点击“应用并刷新 OpenCode”；如果 OpenCode 没有返回所需模型，可继续
  手工添加模型 ID。endpoint 必须支持 Chat Completions SSE 和
  `tools`/`tool_calls`。

“应用并刷新 OpenCode”会把表单交给 OpenCode 配置和认证接口，重载 OpenCode 后直接读取它返回的
Provider 与模型目录。Boom 不再直连 Provider 的 `/models` API。已手工添加的模型 ID 仍会作为 OpenCode 配置中的显式模型保留。

也可只在当前 shell 提供环境变量；变量名由 Provider ID 生成：

```sh
export BOOM_OPENAI_API_KEY='...'
export BOOM_ANTHROPIC_API_KEY='...'
export BOOM_MY_COMPAT_API_KEY='...'
```

启动时 Boom 会将上述环境变量写入生成的 OpenCode 配置；在 GUI 中保存的凭据则由 OpenCode 保管。不要把真实 key 提交到仓库、测试 fixture 或任务目录。

## 2. 用 OpenCode 模型运行小型验证

在 Boom 的 Economy 和 Strong 下拉框选择刚刷新出来的 OpenCode 模型，对一道小型题目发起一次运行。

通过标志是 GUI 显示运行已启动，且事件流中有来自已选模型的回复或可诊断的 OpenCode 错误。输出中不应出现 API Key。

## 3. 失败时收集什么

请保留以下非敏感信息即可：

- GUI 提示和相关事件；
- Provider ID、Base URL 和模型 ID；
- OpenCode 返回的 HTTP status、错误信息和 request ID（若有）。

不要发送 API Key。`authentication` 通常是 key 或账号权限；`invalid-request` 通常是模型 ID、
endpoint 协议或工具 schema 不兼容；`rate-limit`/`server` 可在稍后重试。
