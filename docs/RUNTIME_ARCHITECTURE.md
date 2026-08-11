# Boom 运行时架构

Boom 的 CTF 求解、任务状态、证据、会诊和预算属于产品核心，不依赖某个 Agent
底座。具体底座通过 `src/runtime-contract.ts` 接入。

## 边界

核心只使用以下 Boom 自有概念：

- `AgentRuntime`：创建一个绑定任务目录的对话；
- `RuntimeConversation`：接收提示、订阅规范化事件、取消执行，并分别访问活动上下文、完整历史和完整轮次 fork；
- `RuntimeEvent`：文本增量、工具状态、步骤用量和重试；
- `RuntimePromptResult`：回复片段、用量、成本、结束原因和规范化错误；
- `RuntimeHandle`：运行时生命周期及可选的 Provider 控制面；
- `BoomToolHost`：不依赖插件 SDK 的 `boom-exec` / `ctf-note` / `ctf-consult` /
  `ctf-submit` 宿主实现。

OpenCode 是产品使用的 Provider、认证和模型目录 adapter。SDK client、session API、
`message.part.updated`、`providerID/modelID`、Provider OAuth 和兼容环境变量只能出现在 `src/runtime.ts` 及
`resources/plugin/` 下的 OpenCode 兼容包装中。GUI 和 CLI 使用 `startOpenCodeRuntime()`；Boom 不直连
Provider 的 `/models` API。

Native 保留为内部的协议 fixture adapter，供 Driver 和 Kernel 测试显式注入。`native-runtime.ts` 只依赖
`NativeProviderDriver`；`managed-native-runtime.ts` 可组装 Boom 注册的 OpenAI-compatible、OpenAI Responses 与
Anthropic Messages Driver。它不是 GUI、CLI 或 Provider 管理的产品路径。

Boom 仅将非敏感 Provider 表单编译为 OpenCode 配置。API Key、OAuth、连接状态和模型目录
均由 OpenCode 控制面处理；GUI “应用并刷新 OpenCode”之后只读取 OpenCode 返回的目录。

## 替换底座

新的底座至少实现 `AgentRuntime`。不具备模型目录或 OAuth 的底座可以不提供
`RuntimeHandle.provider`，求解仍然可运行；GUI 的 Provider 管理入口会返回明确的能力缺失错误。

一个 adapter 需要完成：

1. 把 Boom 的 `provider/model` 模型引用翻译为底座模型引用；
2. 把底座流式事件映射为 `RuntimeEvent`；
3. 把回复、用量、finish reason 和错误映射为 `RuntimePromptResult`；
4. 提供取消语义；
5. 将 `boom-exec` 和 `ctf-note` 注册到底座，或直接使用 `createBoomToolHost()`；
6. 为需要持久实验访问的底座实现 resume、`activeContext()`、`messages()` 和完整 API round 边界的 `fork()`；
7. 明确声明 capabilities；可选实现 Provider 控制面。

`GuiRunner` 接受 `RuntimeLauncher` 注入，因此测试或其他发行版可以使用不同底座而不修改
Runner。CLI 和 GUI 当前通过同一个 `GuiRunner` 使用 `startOpenCodeRuntime()`；未来的运行时选择只需在
启动边界选择 launcher，不应修改 solver、progress 或 consultation。

## 适配器验收

替代 adapter 至少需要通过：

- 一个带文本、工具和 usage 事件的完整 solver turn；
- 外部取消与超时；
- L1 只读 second opinion 与 2–4 模型会诊的单次调用；
- length、empty、provider failure 的规范化；
- continuation 后的新 turn 能读取同一工作区持久状态；
- `ctf-note`、`ctf-consult`、`ctf-submit` 和受控命令工具的安全边界。

核心测试使用 fake `AgentRuntime`，不启动 OpenCode。这是替换边界的回归保护。
