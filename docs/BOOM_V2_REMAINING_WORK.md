# Boom V2 完成记录与维护交接

> 归档验收记录。V2 编排随后在 solver-focused slimming 中移除；下文命令、角色和路径均
> 不应作为当前接口使用。

更新时间：2026-08-01

本文档原用于跨会话继续实现 Boom V2。2026-08-01 已按推荐顺序完成其中列出的工程工作；
现保留原清单并全部勾选，作为实现验收记录和后续维护边界。完整设计背景见
`docs/BOOM_V2.md`。

## 1. 当前结论

仓库当前状态：

```text
M1 状态与检查点骨架                    已完成（原有实现，未重做）
M2 模式 A、多模型分析/挑战/裁决         已完成（原有实现，未重做）
finish=length 单次恢复                  已完成（保持最多一次）
P0 基础采集与正确 checkpoint 时机       已完成
M2.5 受控执行环境与 Python GUI          已完成
M3 模式 B 证据分支                      已完成
M4 自动触发和阶段循环                    已完成
M5 模式 C/D 反证与验证                  已完成
P4 输出异常、compaction 与上下文治理     已完成
P5 测试、评估命令和公开文案             已完成
```

维护时仍不要重新实现 `boom-state.json`、基础 checkpoint 数据结构、分析者/挑战者/裁决者
并行调用、economy/strong 模型配置或 `finish=length` 的第一次恢复重试。新增行为应保持本文
第 3 节的产品决策和下述宿主边界。

### 1.1 本轮落地模块

- `src/baseline.ts`：宿主确定性清单 + economy 有界采集，部分失败可继续且同题只运行一次；
- `src/environment.ts`、`src/command-executor.ts`、`resources/plugin/boom-exec.ts`：共享
  Python 档案、任务绑定、清洁环境、argv-only 命令、三种执行模式和命令审计；
- `src/branches.ts`：独立证据分支、并发、预算/取消、路径验证和宿主合并；
- `src/orchestrator.ts`：信息增益、阶段推进、自动 trigger、冷却/去重和动作前门控；
- `src/verifier.ts`：远程适配器接口、本地 checker、离线复现、盲化模型验证和用户审核；
- `src/evaluation.ts`：单模型、V1、V2 模式 A、V2 完整模式的历史结果聚合；
- `resources/agent/boom-intake.md`、`boom-verifier.md`：新增受限采集与独立验证角色；
- CLI、GUI、历史详情和最终 agent/skill 提示均已接入上述能力。

### 1.2 需要继续保持的实现边界

- `--checkpoint off` 明确跳过 V2 baseline/checkpoint，作为兼容模式；
- 没有任务环境时立即失败，不回退到系统 Python；老任务首次继续要求用户选择环境；
- 全局默认环境只影响新任务；停止的任务可显式切换环境，已有产物不删除；
- `isolated` 依赖 Docker/Podman，缺失或 daemon 不可用时明确失败，不降级；
- 远程确定性验证通过题目/部署方提供的 `DeterministicVerifier` 适配器接入，因为 CTF
  服务提交协议没有统一格式；没有适配器时依次尝试本地 checker、离线复现和盲化验证；
- Provider 目录中的超大 output 声明不再直接控制 Boom：运行时单回合模型输出上限为
  32K tokens，宿主还执行字符上限、重复流检测、预算检查和 compaction 事件记录；
- `ctf/runs/` 是用户运行产物，不属于本轮清理或迁移范围，本轮未修改、删除或重置其中内容。

## 2. 已完成基础

### 2.1 M1 状态与检查点骨架

已经具备：

- `work/boom-state.json` 的创建、持久化和恢复；
- 阶段、事实、假设、分支、候选、进展和检查点类型；
- 从题目、任务、NOTES 和产物构造 `TaskSnapshot`；
- V1 历史兼容；
- 检查点文件和路径边界检查。

主要文件：

- `src/boom-state.ts`
- `src/checkpoint.ts`
- `src/task.ts`
- `src/history.ts`

### 2.2 M2 模式 A

已经具备：

- analyzer 与 challenger 独立并行；
- arbiter 读取原始快照和两份报告后裁决；
- economy/strong 模型档次；
- 不强制不同角色使用不同模型；
- 结构化事实、假设和实验；
- 检查点预算计入任务预算；
- GUI/CLI 创建初始或人工检查点。

当前限制：这只是模式 A 的检查点能力，不等于完整 A/B/C/D 编排。

### 2.3 `finish=length` 恢复

`src/session.ts` 已实现：

- 第一次收到 `finish=length` 时不立即失败；
- 在同一会话中发送一次恢复提示；
- 要求停止重复、把长数据写入 `work/`、更新 NOTES 后继续；
- 记录 `length-recovery` 事件；
- 第二次仍然为 `length` 时才结束为错误。

相关测试位于 `test/session-run.test.ts`。不要把它改回无界重试，也不要简单重发原始提示。

## 3. 已确定且不得回退的产品决策

1. 只组合模型 API 调用，不研究训练、权重融合或其他算法级 MoE。
2. 多模型是关键检查点能力，不是每一步都常驻调用。
3. 完成首轮基础采集后必须调用一次多模型检查点。
4. 阶段突破、证据冲突、高成本动作、低信息增益和候选出现都应主动检查，不能等待 timeout。
5. 模式 A/B/C/D 分别负责探索、取证、反证和验证。
6. economy 模型处理边界明确、可验收和批量工作；strong 模型处理开放推理、跨证据综合和关键裁决。
7. Python 使用用户长期维护的共享 Conda/Python 环境，不按题创建或克隆环境。
8. GUI 必须选择默认 Python 环境；单题可以覆盖选择另一个已有环境。
9. 环境优先级固定为“单题选择 > GUI 默认”，缺失时失败，不回退到系统 Python。
10. 每题只隔离工作目录、缓存和临时文件，不复制 Python 解释器和依赖。
11. Python 环境不是安全沙箱；未知二进制的隔离由受控执行器和容器完成。
12. solver/worker 最终不得直接获得继承宿主环境的无限制 `bash`。
13. Provider 凭据和完整宿主环境不得进入模型命令子进程。
14. `finish=length` 只自动恢复一次。

## 4. P0：修正首个检查点的实际时机（已完成）

### 4.1 原问题

当前 `baseline-complete` 检查点在 solver 开始前运行。它只能看到附件清单和初始 NOTES，
不满足“先分析附件并收集足够基础信息，再由多模型分析”的产品流程。

### 4.2 目标流程

```text
创建任务
  → 有界基础采集
  → 持久化基础事实和产物
  → baseline-complete 检查点
  → 将裁决实验交给 solver
  → 持续侦查和实验
```

### 4.3 实施要求

- [x] 新任务先进入 `intake`，不能直接把空快照标记为 `baseline-complete`；
- [x] 增加一次有界基础采集调用，默认使用 economy，必要时可升级 strong；
- [x] 基础采集只负责文件类型、目录结构、元数据、可见协议/入口和已生成产物，不提前宣布解题路线正确；
- [x] 基础采集输出写入机器状态和 `NOTES.md`，大型内容写入 `work/`；
- [x] 宿主验证基础报告和引用路径后，再运行 `baseline-complete`；
- [x] 老任务继续时不得重复执行已经完成的基础采集；
- [x] 基础采集失败时保留部分事实，并允许检查点以 `partial` 输入继续；
- [x] CLI 与 GUI 使用相同流程。

### 4.4 验收

- 首个 checkpoint 快照包含真实的附件分析结果，而不只是附件文件名；
- 同一任务只完成一次 baseline，除非用户显式重建；
- baseline 失败不会删除已生成产物；
- baseline 的模型、token、耗时和产物可在历史中检查；
- `checkpoint=off` 时保持明确的兼容行为。

## 5. P0：M2.5 受控执行环境（已完成）

这是进入模式 B 前的硬前置条件。

### 5.1 共享 Python 环境配置档案

建议数据结构至少包含：

```typescript
type PythonEnvironmentProfile = {
  id: string
  displayName: string
  kind: "conda" | "python"
  interpreter: string
  prefix?: string
  pythonVersion: string
  architecture: string
  installPolicy: "deny" | "allow"
  fingerprint: string
  status: "ready" | "missing" | "invalid"
}

type TaskEnvironmentBinding = {
  profileId: string
  interpreter: string
  fingerprint: string
  source: "default" | "task-override"
  boundAt: string
}
```

实施：

- [x] 使用 `conda info --json` / `conda env list --json` 发现环境；
- [x] 允许手动选择 Conda prefix 或 Python 可执行文件；
- [x] 规范化真实路径并探测版本、架构、关键包和可执行性；
- [x] GUI 设置保存默认环境配置档案；
- [x] 新建任务默认继承当前默认环境；
- [x] 新建任务和任务详情支持单题覆盖；
- [x] 修改全局默认值不改变已有任务；
- [x] 不自动创建 venv，不自动克隆 Conda 环境；
- [x] 默认 `installPolicy=deny`；只有用户显式允许后才能修改共享环境；
- [x] 任务保存环境绑定和指纹，不复制解释器；
- [x] 每题缓存、HOME 和临时目录指向 `work/.boom/`；
- [x] 环境失效时明确失败，不静默换解释器。

### 5.2 System Prompt 环境声明

每次创建 solver 或 worker 会话时，动态加入不可由用户提示覆盖的 system 声明：

```text
本题选择的 Python 环境是“{displayName}”（{kind}，Python {version}，安装策略：{installPolicy}，执行模式：{executionMode}，指纹：{fingerprint}）；python/pip 已由 Boom 路由到该环境，禁止自行激活、切换或修改其他 Python 环境。
```

要求：

- [x] 声明来自任务固化绑定，不从 shell 或模型输入猜测；
- [x] 主 agent 和所有 worker 使用同一绑定；
- [x] checkpoint 快照包含环境摘要；
- [x] 路径等调试细节保留在状态文件和 GUI，不必进入 prompt；
- [x] 环境切换先停止旧命令和旧会话，再创建使用新声明的会话；
- [x] 测试声明、实际 `python` 和 `pip` 指向完全一致。

### 5.3 受控命令执行器

- [x] 禁用 `resources/agent/boom.md` 和 `boom-worker.md` 的内置 `bash` 直通；
- [x] 新增 Boom 自己的命令工具；
- [x] 固定 cwd 在当前任务或当前证据分支；
- [x] 由白名单构造子进程环境，不传递完整 `process.env`；
- [x] Provider API key、Boom 凭据和宿主 HOME 不进入子进程；
- [x] 将所选 Python 环境的 bin 放入受控 PATH；
- [x] 统一处理超时、输出上限、取消、退出码和完整进程树终止；
- [x] 记录命令、解释器、cwd、环境指纹、耗时和退出状态；
- [x] 拒绝工作区外写入和宿主包管理器；
- [x] 安装依赖必须经过独立环境工具，并执行 profile 的安装策略。

### 5.4 执行模式

- [x] `managed`：常规分析脚本使用所选共享 Python 环境；
- [x] `isolated`：未知二进制、不可信安装脚本和高风险动态分析进入非 root 容器；
- [x] `static-only`：缺少容器时禁止执行未知程序；
- [x] `challenge/` 在容器中只读，`work/` 可写；
- [x] 容器默认无网络，只允许题目声明的目标；
- [x] 限制 CPU、内存、进程数、磁盘和墙钟；
- [x] 不允许从 `isolated` 静默降级到宿主 `managed`；
- [x] `boom doctor` 和 GUI 显示环境、容器和隔离能力。

### 5.5 验收

- `python`/`pip` 始终指向用户选择的环境；
- 多个任务复用同一 Python 环境，但缓存、HOME、临时目录和工作产物分离；
- 单题覆盖不修改全局默认值或其他任务；
- 模型命令无法读取 Provider 凭据和宿主用户目录；
- 未安装容器时无法执行未知二进制；
- 取消和预算停止能终止命令及全部子进程；
- 老任务首次继续时要求选择或确认环境，不迁移已有产物。

## 6. P1：M3 模式 B 证据分支（已完成）

- [x] 为每个分支建立独立 `work/branches/<branch-id>/`；
- [x] 分支共享题目选择的 Python 环境，但不共享可写产物目录；
- [x] worker 接收单一方向、已知事实、目标、预算、停止条件和输出合同；
- [x] 支持 economy/strong worker；
- [x] 支持并行、单分支超时、整体取消和分支预算；
- [x] worker 只能返回结构化报告，长输出必须留在分支目录；
- [x] 宿主验证报告引用路径存在且没有逃逸分支目录；
- [x] 一个分支失败不影响其他分支完成；
- [x] arbiter 合并报告，但不能把无路径支持的猜测提升为事实；
- [x] 有效证据、关闭假设和阶段突破更新任务状态。

验收重点：两个并行 worker 不能覆盖文件；失败隔离；路径安全；预算和取消准确。

## 7. P2：M4 自动触发与阶段循环（已完成）

原交接时 trigger 类型已经存在但大多没有自动检测；现由 `src/orchestrator.ts` 统一检测，
CLI 与 GUI runner 均接入。

- [x] 实现 `new-surface`；
- [x] 实现 `hypothesis-conflict`；
- [x] 实现 `root-assumption-rejected` 的自动路径，保留现有用户拒绝路径；
- [x] 实现 `phase-transition`；
- [x] 实现 `high-cost-action` 和 `risky-action` 的执行前门控；
- [x] 实现 `low-information-gain`；
- [x] 实现 `candidate-found` 的实际验证调度，而不只是 pending 记录；
- [x] 根据事实新增、假设关闭、关键产物和验证升级计算信息增益；
- [x] 正确维护 `consecutiveNoProgressExperiments`；
- [x] 增加 trigger 去重、冷却和预算门槛，避免频繁会诊；
- [x] 实现 `intake → baseline → recon → breakthrough → exploit → verify → done` 转换；
- [x] GUI 展示当前阶段、触发原因、模型、裁决和下一步。

验收重点：无需 timeout/stalled 即可主动检查；正常推进不会每一步重复调用多模型。

## 8. P3：M5 模式 C/D 与验证（已完成）

- [x] 模式 C 能实际执行反证实验，而不只是生成第二意见；
- [x] 高置信但高风险结论必须经过独立反证；
- [x] 候选优先使用本地 checker 或题目远程服务进行确定性验证；
- [x] 无确定性验证器时才调用盲化模型验证；
- [x] 验证模型不能直接看到原求解模型的自信结论；
- [x] 原 solver 不能单独把候选标记为 verified；
- [x] 区分 `remote`、`local-checker`、`offline-derivation`、`unverified`；
- [x] 用户拒绝候选后保留证据、禁止重复提交并重新进入反证检查点；
- [x] 正确 Flag 只保存在宿主状态，不写回解题工作区。

## 9. P4：输出异常和上下文治理（已完成）

保留原有一次 `length-recovery`，并已补齐：

- [x] 流式检测明显的文本重复/退化循环；
- [x] 达到重复阈值时提前中止当前生成，避免等 Provider 输出上限；
- [x] 增加 Boom 自己的可配置单回合输出上限，不直接信任模型目录中的超大值；
- [x] 校准 Provider 配置中的真实 context/output 能力，特别是当前 DeepSeek 的 384K 声明；
- [x] 自动把首次截断的部分回复保存为诊断/恢复产物；
- [x] 恢复调用前检查剩余 token 和时间预算；
- [x] 区分输出截断、输入上下文溢出、Provider 限流和模型空回复；
- [x] 在运行时配置中显式启用上下文 compaction，并记录 compact 事件；
- [x] compaction 失败时从 NOTES、机器状态和产物启动新会话恢复；
- [x] GUI 将首次 `length` 显示为“正在恢复”，而不是立即显示运行时错误。

## 10. P5：测试、评估和收尾（工程已完成）

- [x] 为每个自动 trigger 增加去重和预算测试；
- [x] 增加环境发现、默认继承、单题覆盖、环境失效和 prompt 一致性测试；
- [x] 增加凭据隔离、路径逃逸、容器缺失和进程树取消测试；
- [x] 增加分支并发、失败隔离和证据路径测试；
- [x] 增加确定性验证优先和盲化验证测试；
- [x] 增加文本重复检测、一次恢复、二次截断和预算不足测试；
- [ ] 使用相同题目和预算实跑比较单模型、V1 会诊、V2 模式 A、完整 A/B/C/D；当前已完成
  聚合器和只读基线报告，但磁盘没有 V2 样本；该项需要可用模型凭据并会产生真实 API 消耗，
  未在实现收尾中擅自发起；
- [x] 统计成功率、错误候选率、首次有效证据时间、费用和 strong token 占比；
- [x] 更新 CLI help、GUI 文案和最终 Boom prompt；
- [x] 完成后运行 `bun run typecheck` 和 `bun test`。

完成时测试基线：

- `bun run typecheck` 通过；
- Boom 核心和新增 V2 测试通过；
- `resources/plugin/boom-exec.ts` 可由 Bun 独立构建；
- 完整 `bun test` 的最终结果见本文末尾“完成验证”，其中 `web` 预览测试若仍因仓库缺失
  `SkeletonPreview.tsx` / `codex-preview` meta 失败，继续按既有独立基线记录，不归因于 V2。

## 11. 实际完成顺序

```text
1. 修正基础采集与 baseline 检查点时机
2. 实现共享 Python 环境配置档案和 GUI 选择
3. 实现受控命令执行器并切断内置 bash
4. 实现 managed/static-only，再实现 isolated
5. 实现模式 B 证据分支
6. 实现自动 trigger 和阶段循环
7. 实现模式 C/D 与确定性验证
8. 完成输出循环防护、compaction 治理和效果评估
```

实现严格遵守了这一顺序；模式 B 在受控执行器、环境绑定和禁用内置 `bash` 之后接入。

## 12. 后续维护会话的操作要求

1. 先阅读仓库根目录 `AGENTS.md`、本文和 `docs/BOOM_V2.md`；
2. 使用代码索引确认现状，不凭文档假设代码已经实现；
3. 检查 `git status`，保留用户已有修改；
4. 不清理或重置 `ctf/runs/`，其中包含用户运行产物；
5. 每完成一个里程碑都运行相关测试和 `bun run typecheck`；
6. 打包前运行仓库要求的完整测试；
7. 不把正确 Flag、Provider key 或宿主凭据写入工作区。

## 13. 完成验证（2026-08-01）

- `bun run typecheck`：通过；
- V2 相关定向测试：44 passed / 0 failed；
- 全量 `bun test`：87 passed / 2 failed；两项失败均为交接前已知的独立 `web` 预览基线：
  缺少 `codex-preview=development` meta，以及缺少
  `web/app/_sites-preview/SkeletonPreview.tsx`；
- `bun build resources/plugin/boom-exec.ts --external @opencode-ai/plugin --target bun`：通过；
- `boom evaluate --root ctf`（只读）：成功聚合 22 个 `single-model` 和 2 个
  `v1-consultation` 历史运行；当前磁盘还没有可形成横向样本的 V2 实际运行，因此不能从
  现有数据声称 V2 提升了成功率或单位成本。

本轮没有清理、重置或迁移 `ctf/runs/`。`git status` 中该目录原有的已修改与未跟踪运行产物
均按用户要求保留。
