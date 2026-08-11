# M3 对照研究：Tool Host、Policy 与 Network Broker

状态：M3 设计与实现依据（2026-08-03）

## 1. 研究边界与版本依据

Boom 的长期目标不是复制 OpenCode 或 Claude Code 的配置格式，而是让 Registry、Policy、Tool Host
和 Runtime adapter 各自只有一个明确职责。兼容性判断以本机锁定的 OpenCode `0a601cf` 源码为准，
当前公开文档只用于理解仍在演进的产品边界。

本地只读检查覆盖：

- `packages/opencode/src/tool/registry.ts`：内置、插件和 MCP 工具的动态注册；
- `packages/opencode/src/session/tools.ts`：工具 schema、权限询问和插件 hook 的 Provider 映射；
- `packages/opencode/src/tool/{read,glob,grep,edit,webfetch,websearch}.ts`：文件和网络工具行为；
- `packages/opencode/src/permission/**`：agent/user 规则的合并与匹配。

公开依据：

- [OpenCode tools](https://dev.opencode.ai/docs/tools/)
- [OpenCode permissions](https://dev.opencode.ai/docs/permissions/)
- [OpenCode custom tools](https://opencode.ai/docs/custom-tools/)
- [OpenCode plugins](https://dev.opencode.ai/docs/plugins/)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)

## 2. 对照结论

OpenCode 的 Tool Registry 会组合内置、插件和 MCP 工具，并在 Provider 调用前转换 schema、过滤权限、
执行插件 hook。具体工具仍各自处理路径、输出上限和 `ask`。这套实现适合作为兼容 adapter，但动态插件
定义和 Runtime 私有权限不能成为 Boom 公共合约。

Claude Code 明确区分内置文件工具权限和 Bash 隔离：仅禁止内置 Edit 并不能阻止 Bash 写文件，
仅限制 WebFetch 也不能阻止 `curl`。其 OS sandbox、文件边界、网络代理和工具权限是互补层，而不是
同一份规则的别名。这验证了 Boom 必须在所有执行入口前做统一决策，并让 Shell 服从同一文件与网络
边界。

两者的共同经验是：

- schema 告诉模型如何调用，不等同于授权；
- 权限必须在执行时按角色、副作用和实际资源重新判定；
- 路径字符串的词法前缀不足以防止 `..`、符号链接和 TOCTOU；
- Shell 能绕过高层文件/网络工具，因此必须由 OS 级隔离兜底；
- 插件适合做格式和生命周期适配，不适合复制业务 schema 与策略。

## 3. Boom 冻结的职责边界

### Tool Registry

`resources/runtime/tool-profiles.json` 是稳定公共目录，只定义工具 ID、描述、JSON schema、实现归属、
副作用和角色 profile。Prompt compiler、Native Tool Host 与兼容 bridge 必须消费同一份冻结对象，
不得在插件里重写 schema。

### Policy Engine

每次分派都产生 `allow | isolate | deny` 决策，输入至少包括 profile、tool、副作用、任务根目录和规范化
资源。默认无人值守求解不引入交互式 `ask`；需要额外权限的动作由宿主隔离或拒绝。Registry 中可见
不代表当前调用被允许。

文件策略固定为：

- 所有路径必须是任务根目录内的相对路径；拒绝绝对路径、NUL 和词法逃逸；
- 路径的每一级都用 `lstat` 检查，Native 工具绝不跟随符号链接；
- `challenge/` 和任务控制文件只读；普通写入只允许 `work/`；
- `work/.boom/**` 与 `work/RESULT.json` 是宿主控制面，普通文件工具不可写；
- `NOTES.md` 由 `ctf-note` 维护，候选结果由 `ctf-submit` 维护。

### Tool Host 与 adapter

Boom 实现的工具先做 Registry schema 校验，再做 Policy 判定，最后进入实现。OpenCode 插件最终只把
Runtime 调用转换成这个入口并转换结果；尚未迁移的 `task`/`write` 仍属于 compatibility 路径，不能
被记录成 Boom Native 已验收。

所有工具必须支持取消、稳定输出上限和可审计元数据。Native `read/list/glob/grep/edit` 使用同一
task-path resolver；Shell、Skill、Todo 和网络工具随后接入同一分派管线。

## 4. Network Broker 决策

CTF 求解可能访问未知公网、RFC1918、loopback 或本地监听目标，因此 Boom 默认不采用域名/IP/端口
allowlist。Network Broker 仍必须：

- 固定 DNS 解析结果，并在每次重定向后重新解析和固定，避免目的地址静默漂移；
- 不继承宿主凭据、代理密钥或无关环境变量；
- 为请求设置并发、超时、重定向、响应字节和审计上限；
- 不允许 URL 内嵌用户名/密码，也不把敏感 header/body 写入审计；
- 精确拒绝当前 Boom Tool Bridge/OpenCode server 的随机 loopback origin，而不封禁其他 loopback CTF 目标；
- 可选 strict profile 才拒绝 private/link-local/metadata 地址，不能改变 CTF 默认开放语义。

Shell 还必须允许任务内 loopback 监听和客户端联调；`webfetch/websearch` 与 Shell 共享默认开放目标
语义，但分别使用 HTTP Broker 限额和进程 sandbox 限额。这是 Boom 面向未知 CTF 目标的产品选择，
与 Claude Code 面向通用开发仓库的域名 allowlist 不同；差异必须由 C20 明确验收。

## 5. M3 验收映射

- Registry/Host 漂移：启动时验证所有 `implementation=boom` 工具都有且只有一个 handler；
- 文件边界：正常读、`work/` edit、`challenge/` 写拒绝、绝对路径/`..`/符号链接逃逸测试；
- 角色权限：verifier 只能调用只读工具，solver/worker 的写入仍受各自 workspace 边界控制；
- Shell 边界：全 Shell 语义、取消、输出上限、challenge 只读和 work 可写；
- 网络边界：未知公网/私网/loopback 目标默认可达，凭据继承和超限响应被拒绝，strict profile 可拒绝私网；
- bridge 一致性：OpenCode 和 Native 使用同一个 registry snapshot 与 Policy 决策；
- C20：把上述工具、Policy、Shell、插件和 Network Broker 行为纳入 scripted conformance。
