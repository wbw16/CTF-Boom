# 比赛平台接入（Platform Adapters）

Boom 的比赛能力（自动拉题、靶机调度、无人值守巡航、Flag 提交）是**平台无关**的；
平台差异全部收敛在适配器层。接入一个新的 CTF 平台 = 实现一个适配器 + 在注册表
登记一个条目，不改动 runner / GUI / autopilot 的任何核心代码。

## 架构

```
src/platform/adapter.ts      PlatformAdapter 接口与共享类型（提交、公告、环境、限额）
src/platform/registry.ts     内置适配器注册表：id/别名解析、实例缓存、GUI 概览
src/platform/credentials.ts  通用凭证存储：$BOOM_HOME/platforms/<id>.json（0600），
                             env 优先，支持旧 env/旧文件自动迁移
src/platform/adapters/       内置适配器实现（当前：dasctf.ts）
src/competition/             平台无关的比赛层：policy（调度纯函数）、autopilot、
                             environments（环境租约池）、submissions（提交台账）
```

运行时的接线方式：

- 题目 `meta.json` 的 `platform: { adapter, challenge_id, options }` 标记归属，
  runner 提交与环境编排按 `adapter` id 经注册表分发，不出现具体平台名。
- GUI 路由统一为 `/api/platform`（列表）与 `/api/platform/:id/*`
  （credential / server-host / sync / overview / notices）；SSE 事件为
  `platform.synced`、`platform.credential.changed`、`platform.server-host.changed`。
- 每个根工作区的活动平台记录在 `settings.competition.platformId`（未设置时取
  第一个内置适配器）；控制台 UI 的文案（显示名、默认 Server Host 占位符）由
  注册表元数据驱动。

## 实现一个适配器

1. 在 `src/platform/adapters/` 下实现 `PlatformAdapter` 接口：

   - 元数据：`id`、`displayName`、`limits.maxSubmissionsPerChallenge`、
     `ownedAdapterIds`（含历史别名，用于识别旧 meta.json 的归属）。
   - 能力方法：`acquireChallenges`（同步题目到标准布局）、`submitFlag`、
     `ensureEnvironment` / `recoverEnvironment`（靶机生命周期）、`overview`（排名）、
     `notices` / `noticeDetail`（公告）。
   - 可选钩子：`normalizeFlag`（提交前剥离 flag 包装）、`inferChallengeCategory`
     （离线分类规则）。

   手写客户端是推荐做法：DASCTF 的实践证明声明式 manifest 引擎塞不下真实平台的
   信封/嵌套/多态字段（详见 [platforms/dasctf.md](./platforms/dasctf.md) 的实测偏差）。

2. 在 `src/platform/registry.ts` 登记条目：id、别名、显示名、凭证规格
   （env 变量名、凭证文件名，可声明旧来源）、实例工厂。

3. 凭证经 `platformCredentials(spec)` 获得，自动获得 0600 原子写、env 优先、
   状态查询与旧格式迁移；不要自建存储。

4. 为适配器写 mock 测试（参考 `test/dasctf-platform-adapter.test.ts`，
   852 行覆盖信封解析、限流退避、增量同步、环境生命周期）。

## 安全边界

- AccessKey 只落 `$BOOM_HOME/platforms/<id>.json`（0600），不进入题目目录、
  运行工作区或 API 响应；前端只显示是否已配置。
- 附件下载不得转发平台 API 凭证（CDN 通常是独立域）。
- Boom 自设每题提交上限（默认 15 次，适配器可经 `limits` 覆盖），远低于平台
  硬上限，且台账去重，杜绝爆破形态的提交。

## 内置平台

| ID | 平台 | 说明 |
| --- | --- | --- |
| `dasctf` | DASCTF Agent API | 西湖论剑等 agent CTF 赛事；别名 `xihulunjian` 兼容旧工作区 |

比赛调度默认值（3 小时赛制、3 个线上环境、分批放题节奏）编码在
`src/competition/policy.ts`，均可在比赛平台控制台调整；详见
[platforms/dasctf.md](./platforms/dasctf.md)。
