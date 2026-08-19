# Boom 多设备分布式解题计划

状态：第一版已实现并通过自测（2026-08-19）。目标是无人值守下稳定分工，不把 Relay 做成完整的分布式调度平台。实现状态与验收对照见第 15 节。

## 1. 目标

一台主设备能连接比赛平台，其他设备不能。主设备负责同步题目、创建线上环境和提交 flag；多台设备分别独立运行 Boom 解题。

系统要稳定完成以下闭环：

1. 主机同步题面和附件，上传到公网 Relay。
2. Relay 将不同题目分给不同设备。
3. 从机独立解题，只上传成果包、候选 flag 和 writeup。
4. 主机统一提交 flag，回写 accepted/rejected。
5. 网络抖动、进程重启和重复 HTTP 请求不能丢题、丢 flag 或重复占满任务槽位。

## 2. 范围与取舍

保留的设计：

- 普通从机优先处理离线题，主机优先处理需要线上环境的题。
- remote 题分为离线分析和在线联调两个阶段，离线重活可交给从机，线上环境仍由主机控制。
- 离线成果包把 exploit、脚本和运行说明交给在线阶段使用。
- accepted 后自动产出一份 writeup，优先让解出题目的设备写，失联时主机兜底。
- SQLite、任务租约、本地 outbox、flag 去重和有限重试。

第一版明确不做：

- 共享 Agent 上下文、`NOTES.md`、完整分析过程或实时进度。
- 打分调度、设备能力画像、复杂负载均衡、抢占和迁移。
- pin、gave-up、stuck 状态、手工重分配命令和事件游标系统。
- Redis、消息队列、WebSocket、多副本数据库和分布式锁。
- writeup 内容审核或多轮编辑。

Relay 可以偶尔晚分配或重新投递同一任务；这比丢失任务或 flag 更可接受。系统采用至少一次投递，不承诺 exactly-once。

## 3. 三个角色

### Relay Server

公网 Relay 是持久化信箱。使用 Bun + SQLite，附件、成果包和 writeup bundle 放在服务器本地目录。

它只负责保存题目、分配 assignment、维护租约、保存 flag 和返回状态。它不访问比赛平台、不保存比赛 AccessKey、不运行 Agent，也不判断 flag 正确性。

### Master Connector

主机上唯一能访问比赛平台的常驻进程，负责：

- 同步题目、下载附件、发布题目 bundle。
- 对 remote 题申请、回收和轮转线上环境，最多持有平台允许的三个环境。
- 轮询 Relay 中的待提交 flag，复用 Boom 提交台账后调用比赛 adapter。
- 把 accepted/rejected 写回 Relay。
- 在 remote 离线阶段完成后发布线上阶段，并在 accepted 后派发 writeup。

### Worker

包括主机上的 `master-worker` 和普通从机。它们走同一套 worker 代码和 Relay 接口，只是角色不同：

- 普通 worker：只领取 offline 阶段。
- master-worker：优先领取 online 阶段；没有 ready online 题时可以领取 offline 题作为兜底。

每台 worker 默认最多并行 5 个任务。主机 worker 可以设置为 1 到 2 个槽位，避免拖慢 connector。

## 4. 题目和任务状态

Relay 不维护复杂工作流，只维护题目的当前阶段和当前 assignment。

```text
离线题：
  queued_offline -> assigned_offline -> solved

remote 题：
  queued_offline -> assigned_offline -> ready_online
  ready_online   -> queued_online   -> assigned_online -> solved

所有任务：
  assigned_* -> queued_*     主动结束或租约过期
  assigned_* -> solved       flag accepted

writeup：
  none -> pending -> done
```

`ready_online` 不可由 worker 领取。connector 只有在获取到有效环境 URL 且有空余环境槽位时，才把它改成 `queued_online`。环境 URL 过期后，connector 关闭或重建环境，再发布新的线上阶段 revision。

每道题最多有一个 active assignment。SQLite 的唯一约束是此规则的最后保护；租约过期的旧设备可能仍在本地运行，但它的迟到 flag 仍可上传，由主机去重。

## 5. 简单分配规则

设备在注册时被固定角色和最大槽位数。worker 每 15 秒调用一次 poll，并报告本机的 `freeSlots` 和仍在运行的 assignment。

Relay 的分配逻辑只有以下规则：

1. 先续租当前设备仍在运行的 assignment，并返回该设备的全部 active assignment。这样即使一次 poll 响应丢失，下一次 poll 只会重新拿到原任务，不会再多分题。
2. 当前 active 数量达到该设备 `maxSlots` 时，不再发新题。
3. 普通 worker 只从 `queued_offline` 领取。
4. master-worker 先从 `queued_online` 领取，再从 `queued_offline` 领取。
5. 每次最多新发 `min(freeSlots, maxSlots - activeCount)` 个任务。
6. 领取、写 assignment、更新题目状态和租约在同一个 SQLite 事务中完成。

新设备注册后，下一次 poll 直接领取剩余 queued 题，不抢已经 assigned 的题。设备离线超过租约后，对应任务回到队列，由下一个有空位的合适设备领取。

不设置主机宽限期、难度评分或设备能力权重。主机偶尔先拿到一个离线题可以接受；当 remote 题 ready 时，主机总是优先处理它。

## 6. remote 两阶段

remote 题通常有两种完全不同的工作：离线逆向/分析/写 exploit 很重，真正连接环境验证往往很轻。两阶段保留这一分工，但不共享完整 workspace。

```text
connector 发布 remote 题的离线阶段
        -> 普通 worker 领取并分析附件
        -> 上传成果包：脚本 + HOW_TO_RUN.md
        -> Relay 标记 ready_online
connector 申请环境并发布线上阶段：URL + 成果包
        -> master-worker 领取，导入成果包后联调
        -> 上传候选 flag
accepted -> connector 释放环境，Relay 派发 writeup
```

成果包是唯一需要跨设备传递的分析产物。它至少包含：

- `HOW_TO_RUN.md`：入口、参数、预期结果。
- 必要的 exploit、解题脚本或补丁文件。

成果包不得包含 flag、平台凭据或完整本地 workspace。普通离线题不进入这个阶段，直到找到 flag 或租约结束。

默认线上阶段只给 master-worker。以后确认所有从机都能稳定直连比赛环境后，可以增加一个配置让从机也领取 online 任务，但不是第一版要求。

## 7. Writeup

accepted 后自动生成一份 `WRITEUP.md` 并上传 Relay 保存。

1. connector 先标记题目 solved，并释放对应线上环境。
2. Relay 把 writeup assignment 优先发给解出该题的设备。
3. worker 用固定 prompt 生成一个 `WRITEUP.md`，最多调用模型 3 次，只重试网络失败或空文件。
4. worker 上传 writeup bundle；Relay 将 `writeup_status` 标为 done。
5. 原设备的 writeup 租约过期时，Relay 将任务改派给 master-worker。主机没有原 workspace 时，使用题目快照、成果包和 accepted flag 成文。

writeup 不影响题目的 solved 状态，也不阻塞下一题调度。Relay 每题只保存一份 writeup，重复上传同一 assignment 直接返回成功。

## 8. 持久化数据

第一版只需要下列核心表：

```text
devices:
  id, role, name, token_hash, max_slots, last_seen_at

challenges:
  id, slug, category, type, revision,
  status, bundle_sha256,
  remote_url?, remote_expire_at?, result_bundle_sha256?,
  writeup_status, writeup_target_device?, writeup_bundle_sha256?,
  created_at

assignments:
  id, challenge_id, device_id, revision,
  phase, status, lease_until, created_at, finished_at?

flags:
  id, challenge_id, assignment_id, device_id,
  value, status, detail?, created_at

results:
  assignment_id, result_bundle_sha256, created_at

writeups:
  challenge_id, assignment_id, device_id, bundle_sha256, created_at
```

约束：

- `assignments` 对 active assignment 建立按 `challenge_id` 的唯一索引。
- `flags.id` 是 worker 生成的 `submissionId`，网络重试使用同一个 ID。
- `results.assignment_id` 唯一。离线成果上传成功后，即使响应丢失，重复上传同一个 assignment 仍返回成功。
- `writeups.challenge_id` 和 `writeups.assignment_id` 唯一。

Relay 用 `WAL` 模式运行 SQLite；数据库文件只允许 Relay 单进程写入。bundle 先写入临时文件、校验 SHA256 后原子 rename，不能一次读入全部内存。

## 9. 最小接口

全部使用 HTTPS 和 Bearer Token。

```text
POST /v1/devices/register
  一次性加入令牌换取设备令牌。

PUT /v1/challenges/:id
  主机发布或更新题目和 bundle 信息。

PUT /v1/bundles/:sha256
GET /v1/bundles/:sha256
  上传、下载题目附件、成果包和 writeup。

POST /v1/worker/poll
  心跳、续租、返回当前 active assignment、领取新题、返回 stop 和 rejected flag。

POST /v1/results
  remote 离线阶段上传成果包，推进到 ready_online；空成果表示结束本任务并重新入队。

POST /v1/flags
  worker 上传 submissionId + assignmentId + flag。

POST /v1/writeups
  上传 accepted 后生成的 WRITEUP.md。

GET /v1/master/state
  connector 每 5 秒轮询：待提交 flag、ready_online、过期任务、writeup 状态。

PATCH /v1/flags/:id
  connector 回写 accepted、rejected 或 pending。
```

不需要事件 cursor 或 SSE。`GET /v1/master/state` 返回当前状态，connector 每次按幂等方式处理即可；比赛题目和 flag 数量很小，轮询足够可靠和直观。

`/worker/poll` 的简化语义：Relay 返回该设备所有 active assignment。worker 按 assignment ID 幂等导入，先把 assignment 写入本地状态，再下载 bundle 或启动 Runner。这样 poll 响应丢失只会导致同一 assignment 重新返回，不会产生额外任务。

rejected flag 也通过 poll 返回给原设备。worker 本地只应用一次，再让 Runner 继续原题；重复返回 rejected 不影响正确性。pending 不需要回传给 worker，accepted 通过 stop 和 writeup assignment 表达。

## 10. Flag 提交

所有候选 flag 只由 connector 提交比赛平台，必须复用现有 [src/competition/submissions.ts](../src/competition/submissions.ts) 的去重和每题提交上限。

流程：

```text
worker 上传 flag
-> Relay 保存 pending flag
-> connector 轮询到 flag
-> 主机台账检查重复和提交上限
-> 先写 pending attempt，再调用比赛 adapter
-> 回写 accepted / rejected / pending
```

accepted 时，connector 在 Relay 中原子完成：题目设为 solved、关闭该题 active solve assignment、设置 writeup 目标设备。rejected 时，assignment 保持有效，worker 收到判定后继续。

平台响应丢失时不可能同时保证绝对不重发和绝对不遗漏正确 flag。采用简单、有界的策略：connector 重启后先查询平台题目是否已 solved；未 solved 的 pending flag 最多自动重试一次，再继续保留 pending 并报警，不无限重发。每次调用都计入主机提交台账。

## 11. 重启和断网

### Relay

- SQLite 和 bundle 目录是唯一持久状态。
- 重启后继续提供当前 queued、assigned、pending flag 和 writeup 状态。

### Worker

- 本地持久化 active assignment、已处理的 rejected flag 和待上传 outbox。
- Relay 不通时继续已领取任务；flag、成果和 writeup 先写 outbox，恢复后重试上传。
- 重启后从本地 active assignment 恢复，然后 poll；若 Relay 已回收该任务则停止本地 run。

### Connector

- 启动后先读取 `/v1/master/state`，处理 pending flag、ready_online 和未完成 writeup。
- 无法确认的线上环境按比赛平台规则释放或重建；相关题目重新发布 online 阶段。
- 同一题目的平台提交在 connector 内串行，避免同时提交重复候选。

建议 poll 间隔 15 秒，租约 10 分钟。这个租约故意偏长，优先容忍网络抖动；设备失联后晚一点重分配比频繁重复解题更合适。

relay、connector 和每个 worker 都由 systemd、launchd 或 Docker 的 restart policy 守护。重启是正常恢复路径，不应依赖内存状态。

## 12. 安全边界

- Relay 使用 HTTPS。
- 每台设备都有独立设备令牌；主机 connector 使用单独 master 令牌。
- 只有主机保存比赛 AccessKey，Relay 和从机永不保存它。
- 令牌和凭据不写入 `BOOM_ROOT`、bundle、run workspace 或日志。
- 限制请求大小、flag 长度和 bundle 大小；解包拒绝绝对路径、`..` 路径和符号链接。
- Relay 是可信服务器：题目、成果包和 flag 明文会经过并保存在其中。

## 13. 实现顺序

1. 建立 `protocol.ts` 和 `store.ts`：SQLite 表、注册、题目发布、租约和原子领取。
2. 实现 `server.ts`：bundle 服务、worker poll、flag 上传和 master state。
3. 实现 `worker.ts`：加入、5 槽并发、任务导入、本地 outbox、恢复和 rejected 继续。
4. 实现 `master.ts`：题目发布、统一 flag 提交、3 个远程环境、两阶段推进和 writeup 派发。
5. 接入现有 `runner.ts` 和 `competition/submissions.ts`，确保从机永远不会调用比赛 adapter。
6. 做故障测试：poll 响应丢失、Relay/worker/connector 重启、重复 flag、成果上传响应丢失、租约过期、accepted 后停止和 writeup 兜底。

建议新增模块：

```text
src/relay/protocol.ts
src/relay/store.ts
src/relay/server.ts
src/relay/worker.ts
src/relay/master.ts
```

## 14. 验收标准

1. 一台主机加两台从机能自动领取不同 offline 题，每台不超过 5 槽。
2. master-worker 优先领取 online 题，线上环境同时不超过 3 个。
3. remote 题可完成“从机离线分析 -> 成果包 -> 主机在线联调 -> flag 提交”。
4. 新从机加入后自动领取未分配题目，不抢已运行任务。
5. Relay、worker 或 connector 重启后不丢题、flag、成果包或 writeup。
6. poll 响应丢失不导致同一 worker 超过槽位数或多领任务。
7. 相同 flag 重传不重复调用比赛平台；rejected 后原 worker 能继续解题。
8. accepted 后停止其他任务、释放环境，并最终在 Relay 保存一份 writeup。

这版的边界是：优先保证分题、独立解题、统一提交、自动恢复和两阶段 PWN 工作流；其余复杂运维能力以后确有需要再加入。

## 15. 实现状态（2026-08-19）

第一版实现已完成：relay 相关 10 个测试全部通过，全量 `bun test` 相对干净 checkout 无新增失败。

- 新增模块：`src/relay/protocol.ts`、`store.ts`、`server.ts`、`worker.ts`、`master.ts`、`client.ts`、`bundle.ts`、`config.ts`、`command.ts`、`process-command.ts`。
- CLI：`boom relay serve`（Relay）、`boom relay worker register|run`（从机）、`boom relay master sync|run`（主机 connector）。
- 集成：`src/runner.ts` 新增 `CandidateSubmitter` 与 `manageCompetitionEnvironments`，从机把候选 flag 写入本地 outbox 并交给 Relay，永不调用比赛 adapter；主机仍复用 `competition/submissions.ts` 台账后提交。
- 测试：`test/relay-server.test.ts`、`test/relay-distributed.test.ts`、`test/relay-faults.test.ts`。
- 本分支修复的两个问题：
  1. `Bun.Archive.write` 对惰性 `Bun.file` blob 会写入空文件；`bundle.ts` 改为显式读取并加单文件大小上限。
  2. `RelayMaster` 原来只从 `readyOnline` / `activeRemote` / `pendingWriteups` 中查找 flag 对应的题目，离线题（`assigned_offline` / `queued_offline`）的候选 flag 永远不会被主机提交；`/v1/master/state` 新增 `pendingFlagChallenges` 后修复。
- 已知：全量套件仍有 11 个与本分支无关的既有失败（IDA result proxy、consultation、durable task metadata、run workspace、adapter 连接矩阵文案），在干净 checkout 上同样失败，不阻塞本计划。

### 验收标准对照

| # | 标准 | 覆盖测试 |
|---|------|----------|
| 1 | 主机加两台从机自动领取不同 offline 题，各不超过 5 槽 | relay-distributed：master plus two local worker endpoints |
| 2 | master-worker 优先 online，线上环境同时不超过 3 个 | relay-faults：master provisions at most three environments |
| 3 | remote 两阶段闭环（从机离线 -> 成果包 -> 主机在线 -> flag） | relay-server：remote result delivery ... survive retries |
| 4 | 新从机自动领取未分配题，不抢已运行任务 | relay-server：poll renews ... / expired lease ...；relay-faults：Relay restart |
| 5 | Relay / worker / connector 重启不丢题、flag、成果包、writeup | relay-faults：三个 restart 测试 |
| 6 | poll 响应丢失不超槽位、不多领 | relay-server：never fills a worker beyond its reported capacity |
| 7 | 相同 flag 重传不重复调用平台；rejected 后原 worker 继续 | relay-server：deduplicated flags；relay-faults：worker restart outbox 重试 |
| 8 | accepted 后停止任务、释放环境，最终保存一份 writeup | relay-server：writeup handoff / undelivered writeup falls back |
