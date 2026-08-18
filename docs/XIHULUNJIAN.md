# 西湖论剑比赛适配（competition build）

本分支 `codex/xihulunjian-adaptation` 是**比赛专用构建**，不保留通用模式的原有行为。

## 赛制参数

| 项目 | 值 |
| --- | --- |
| 总时长 | 3 小时 |
| 错误提交 | 不罚时、无冷却 |
| 每题提交上限 | 50 次（平台硬限制，禁止爆破） |
| Flag 格式 | `DASCTF{}` 或 `flag{}`，**提交时只交 `{}` 内内容** |
| 同时在线环境 | 最多 3 个 |
| Agent 接入 | 每队仅允许 1 个 Agent |
| 计分 | 递减模式：每多一人解出降初始分 1%，最低为初始分 80% |
| 排名 | 分数优先，同分按时间先后 |
| 放题方式 | **分批放题**，需周期性重新拉取题目列表 |

两条影响成绩有效性的硬性规则：

1. **必须经平台大模型网关**访问 LLM，有流量审计；未经网关将取消成绩。
2. **必须提交解题报告**，报告需与流量日志、平台日志吻合；未提交者取消获奖资格。
   因此 writeup 不是可选项，每道解出的题都必须产出报告。

## 接口实测偏差（2026-08-18 用真实凭证验证）

Base URL `https://pro.dasctf.com`，`{serverHost}/slab-match/api/v1/agent`。
`docs/api_doc.md` 与真实响应有以下差异，照文档实现会直接出错：

1. **`attachment` 形状不是文档写的 `{files:[...]}`**。
   - 有附件时是**单个对象**：`{key, signature, url, name, previewUrl, extension}`。
   - 无附件时是**空数组 `[]`**。
   - 同一字段在两种情况下类型不同（object / array），映射必须同时容错。
2. **`difficulty` 存在 `VERY_EASY` 档**，不只是文档示例里的 `EASY`。
3. **`score` 是字符串**（如 `"50.0"`），不是数字。
4. 真实响应包含文档未列出的字段：`ownerId`、`hasSubmit`、`costTime`、
   `checkScore`、`relationType`（`resource` / `none`）。
5. **附件位于独立 CDN 域** `pro-resource.dasctf.com`，**无需鉴权**即可下载。
   跨域下载时绝不能转发 AccessKey；现有 `sameOrigin` 凭证隔离行为正确，需保留。
6. `endpointType` 除文档的 `monopoly` 外还有 `none`（纯本地题，无靶机）。
7. `isNeedInit=true` 表示需要先启动环境；此时 `endpoints` 为空数组。
8. **接口有限流，文档完全未提**：请求过快返回 HTTP 429 +
   业务码 `40001`（"请求过于频繁，请稍后重试"）。实测**连续 3 次详情请求即触发**。
   适配器因此将所有调用串行化并保持最小间隔（700ms），遇限流按指数退避重试。
   这是比赛期间的关键健壮性要求：并发爆发式请求会导致拉题中途失败。
9. **`exposeIps` 条目本身已包含端口**（如 `1.14.76.59:27629`），
   而 `ports` 是协议限定形式（如 `http/80`）。二者不能直接拼接成地址。

### 环境生命周期实测（10661，已即时回收）

`ensureEnvironment` 全流程验证通过：`isNeedInit=true` -> `build-exercise-env`
-> 轮询详情 -> 就绪后得到 `remote=1.14.76.59:27629`、
`expireTime` 约为启动后 24 小时 -> `recover-exercise-env` 回收成功。
`isProxy=true` 时优先取 `proxyIps[0]:portMappings[0].proxy`。

## 首批赛题快照（验证时）

| exerciseId | 分类 | 名称 | 分值 | 难度 | 需要环境 |
| --- | --- | --- | --- | --- | --- |
| 10661 | Web | web-unserialize-1-3 | 50.0 | VERY_EASY | 是 |
| 10662 | Pwn | shopping | 100.0 | EASY | 是 |
| 10663 | Misc | 解压缩 | 50.0 | VERY_EASY | 否 |

分类 ID（3109-3111）与题目 ID（10661+）是不同层级；
`corpus[].id` 即后续所有调用使用的 `exerciseId`。
分类名为英文（`Web`/`Pwn`/`Misc`），命中现有 `CATEGORY_ALIASES`。

## 设计要点

### 提交策略：激进

错误不罚时且计分递减，因此**早交优于稳交**：

- 候选一出现立即提交，平台 `isCorrect` 作为唯一权威验证器。
- **不在 pending 时跑盲审**（3 小时赛内是纯粹的时间与 token 浪费）。
- 代码侧做确定性的花括号剥离：模型输出完整 `DASCTF{xxx}`，提交 `xxx`。
  已是裸内容的原样提交。不依赖模型记住该规则。
- 反爆破：每题提交上限设 ~15 次（远低于平台 50 次红线），同 flag 去重，
  被拒候选回灌解题上下文。

### 调度：资源感知双槽位

- `remote` 槽硬上限 3（比赛规则），`local` 槽 4-6（受本机 CPU/内存限制）。
- PWN/Web 两阶段解题：阶段一不占 remote 槽做逆向与 exp 开发；
  阶段二才申请槽位开容器、只做联调。显著提高 3 个槽的周转率。
- 槽位释放必须与 `recover-exercise-env` 在 `finally` 中严格配对，
  否则泄漏槽位会让后续所有环境题永久卡死。
- 优先级：本地可解 > 需环境；VERY_EASY > EASY > 更难；同难度按分值降序。

### 时间纪律

3 小时意味着几乎只有一轮机会，没有回头重试的余量：

- 全局赛时预算；最后约 20 分钟进入收尾模式（停止开新题，交完已有候选）。
- 每题墙钟硬上限，到点无候选自动 `given-up` 并释放资源。
- `AUTONOMY_THRESHOLDS` 现值按小时级预算标定（eligible 20 分钟、冷却 5 分钟），
  在 3 小时赛里全部过大，需按赛时比例整体重标定。
- 止损优于死磕：未做题的边际收益高于死磕题。

### 并发

- 模型随 prompt 传入（`session.ts`），入队已支持 `models[slug]` 逐题指定。
- **边界**：economy/strong 的 tier 资源是 runtime 级全局配置，
  修改会触发 `restartRuntime()` 并打断并发中的其他题。
  因此逐题指定必须限制在同一 tier 内更换 provider/model。
- 本机 CPU/内存压力主要靠保守的 local 槽数控制，而非换模型。
- 多机分布式本次不实现，仅预留接口位置。

## 凭证

- Server Host 与 AccessKey 可在前端修改。
- AccessKey 按既有安全边界经环境变量引用，不明文存入 manifest，
  前端只显示是否已配置、不回显明文。
- 大模型网关 baseURL 作为 provider 配置项，可随时修改，不硬编码。

AccessKey 的落盘位置是 `~/.config/boom/platform-credentials.json`（0600，
可用 `BOOM_HOME` 改写），由 `src/platform-credentials.ts` 管理。
GUI 用户无法为已运行的进程设置环境变量，因此 Boom 在启动时把存储的凭证
加载进 `process.env`；**已存在的环境变量优先**，避免显式导出的密钥被旧值覆盖。
该值不写入 `<root>/platforms/*.json`、不进入题目目录或运行工作区、不回传前端。

## 使用方式

无 OpenAPI 文档，因此用内置 profile 而非文档推断创建适配器：

```sh
boom platform adapt --id xihu --profile xihulunjian \
  --base-url https://pro.dasctf.com --root ./ctf

export BOOM_PLATFORM_XIHU_TOKEN=<AccessKey>   # 或在前端填写
boom platform sync --id xihu --root ./ctf
```

GUI 对应接口：

- `POST /api/platforms/profile`（`{profile:"xihulunjian", id, baseURL}`）创建适配器
- `PUT /api/platforms/<id>/credential`（`{value}`）写入 AccessKey，只写不读

## 调度实现说明

调度决策集中在 `src/competition/policy.ts`（纯函数，可独立测试），
副作用留在 `src/runner.ts`：

- `pump()` 不再是先进先出：改为按 `priorityOf` 排序 + 槽位准入。
  某个作业当前不可启动（槽位满、已进入收尾）时会被跳过而不是堵住队列，
  这样线上环境占满时本地题不会被饿死。
- `EnvironmentPool`（`src/competition/environments.ts`）管理三个环境租约。
  释放是幂等的，且**即使 `recover-exercise-env` 失败也会释放本地槽位**——
  失去远端状态后继续占着槽位会让本场比赛剩余的环境题全部卡死，
  而平台侧会在过期后自行回收。
- 租约释放挂在 `pump()` 现有的 `.finally()` 里，覆盖包括抛异常在内的所有终止路径。
- 同一题目已有后续轮次排队时保留环境，避免"本地分析 -> 联调"过渡时
  白白回收再重开。
- 提交台账 `competition/submissions/<slug>.json` 持久化，
  **刻意不放在 `runs/<slug>/` 下**：那里的条目会被当作 run ID 枚举。

### 已重标定的阈值

`AUTONOMY_THRESHOLDS`（`src/orchestration/escalation.ts`）原按小时级预算标定
（20 分钟才够 eligible、5 分钟冷却）。3 小时赛里每题只有 12-35 分钟，
这些闸门在题目自身预算耗尽前根本不会打开，停滞将无法被发现。
现已整体缩小（eligible 5 分钟、停滞 2 分钟、冷却 90 秒）。

本地优先轮次预算也从 25k tokens / 5 分钟提高到 120k / 12 分钟：
在比赛版里这一轮是真正的逆向与 exp 开发，而不再是等人填 URL 前的粗筛。

## 已验证行为（对照真实平台）

- 题目列表两层结构展开、`isOpen=false` 的未放题被跳过
- 业务码非 `00000` 视为失败（即使 HTTP 200）
- 限流自动退避重试
- `attachment` 两种形态、`endpointType:"none"` 判定为纯本地题
- 同步阶段**不启动任何环境**（槽位由解题调度按需申请）
- 附件下载不携带 AccessKey（跨域 CDN）
- 环境 build/poll/recover 全流程
- 提交只发送花括号内内容；`isCorrect` 缺失时判定为 `pending`，绝不假定成功
