# Boom Relay 服务端运维手册

本手册面向在公网服务器上部署和运维 `boom relay serve` 的管理员，覆盖安装、令牌、守护进程、备份、监控与故障排查。协议设计与主从工作流见 [distributed-solving-plan.md](./distributed-solving-plan.md)。

## 1. Relay 是什么、不是什么

Boom Relay 是分布式解题的**公网持久化信箱**：保存题目 bundle、任务租约、成果包、候选 flag 和 writeup，仅此而已。

| 它会做 | 它不会做 |
|---|---|
| 持久化 SQLite 状态和 bundle 文件 | 运行 Boom agent 或解题任务 |
| 校验设备/主控令牌 | 访问比赛平台 |
| 在主机与从机之间转发成果 | 保存比赛 AccessKey |
| 自动生成并保管服务端令牌 | 提供网页管理界面（刻意不设） |

唯一的平台连接和 flag 提交都发生在**主机**上；服务器被攻破也不会泄漏平台凭据（但仍会泄漏候选 flag，见第 9 节）。

## 2. 环境要求

- Linux 服务器（1C1G 起步即可，比赛规模下瓶颈是磁盘）
- [Bun](https://bun.sh/) 1.3 或更高
- 磁盘余量：预计题目与成果总量 × 2（Relay 会同时保存原始 bundle 与成果包）
- 开放一个 TCP 端口（下文以 `10057` 为例，默认 7332）

## 3. 安装部署

### 3.1 安装 Bun

```sh
curl -fsSL https://bun.sh/install | bash
exec $SHELL -l
bun --version   # 确认 1.3+
```

### 3.2 上传代码

只需要 `src/`、`package.json`、`bun.lock` 三个东西。在开发机上：

```sh
rsync -av \
  <本地仓库>/src \
  <本地仓库>/package.json \
  <本地仓库>/bun.lock \
  root@<服务器IP>:/www/boom/
```

> ⚠️ 不要整目录 rsync 开发仓库——历史 run 产物（`ctf/`、`ctf-bak/` 等）包含题目与答案，绝不能带上服务器。

### 3.3 安装依赖并首次启动

```sh
cd /www/boom
bun install
mkdir -p /www/boom-relay-data

# 手动跑一次确认正常（令牌此时自动生成）
bun src/index.ts relay serve --data /www/boom-relay-data --host 0.0.0.0 --port 10057
```

看到下面两行即成功，`Ctrl+C` 停掉：

```
Boom Relay listening on http://0.0.0.0:10057
Relay tokens generated at /www/boom-relay-data/relay-tokens.json (mode 0600); run `boom relay tokens --data <directory>` to copy them.
```

`--host 0.0.0.0` 必须显式传入：默认只监听 `127.0.0.1`，公网访问不到。

### 3.4 放行端口（两处都要）

1. 宝塔面板 → 安全 → 添加端口规则 `10057/TCP`（其他防火墙同理）；
2. 云厂商控制台 → 安全组 → 入方向放行 `10057/TCP`。**漏掉第 2 步是最常见的"连不上"原因。**

## 4. 令牌管理

### 4.1 三个令牌一览

| 令牌 | 谁持有 | 用途 | 存放位置 |
|---|---|---|---|
| 主控令牌（master） | 仅主机 | 发布题目、申请/回收靶机记录、回写 flag 判定、读全局状态 | 服务端 `relay-tokens.json`，复制到主机 GUI |
| 加入令牌（join） | 主机 + 所有从机 | 首次注册时换取设备令牌，之后不再使用 | 同上，分享给从机 |
| 设备令牌（device） | 每台设备各自 | poll、上传 flag / 成果 / writeup | 各设备 `~/.config/boom/relay.json`（0600） |

设备令牌由 Relay 自动签发，无需人工管理。

### 4.2 查看

```sh
cd /www/boom
bun src/index.ts relay tokens --data /www/boom-relay-data
# 加 --json 输出机器可读格式
```

### 4.3 轮换

```sh
systemctl stop boom-relay
rm /www/boom-relay-data/relay-tokens.json
systemctl start boom-relay
cd /www/boom && bun src/index.ts relay tokens --data /www/boom-relay-data
```

轮换后：已注册从机**不受影响**（设备令牌在 SQLite 里），主机 GUI 需填新主控令牌，新从机需新加入令牌。

### 4.4 手动指定（可选）

想用服务管理器的私有环境文件管理令牌时，设置 `BOOM_RELAY_JOIN_TOKEN` 和 `BOOM_RELAY_MASTER_TOKEN`（两个必须同时设，各 ≥16 字符且不同）。环境变量优先于文件，且**不会**在数据目录落盘：

```sh
export BOOM_RELAY_JOIN_TOKEN="$(openssl rand -base64 32)"
export BOOM_RELAY_MASTER_TOKEN="$(openssl rand -base64 32)"
```

## 5. 守护进程

### 方案 A：systemd（推荐）

```sh
cat > /etc/systemd/system/boom-relay.service <<'EOF'
[Unit]
Description=Boom Relay
After=network.target

[Service]
WorkingDirectory=/www/boom
ExecStart=/root/.bun/bin/bun src/index.ts relay serve --data /www/boom-relay-data --host 0.0.0.0 --port 10057
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now boom-relay
```

`ExecStart` 里 bun 的路径以 `which bun` 实际输出为准。租约可调：加 `--lease-seconds 600`（范围 60–3600，默认 600；偏长是为了容忍网络抖动，失联设备晚些重分配比频繁重复解题更划算）。

### 方案 B：宝塔 Supervisor

软件商店装「Supervisor管理器」→ 添加守护进程：运行目录 `/www/boom`，启动命令同 `ExecStart`，**进程数量必须是 1**。

> **单进程约束**：同一数据目录只能跑一个 Relay 实例（SQLite 单写者）。`Restart=always` 的崩溃自拉起是安全恢复路径。

## 6. 客户端接入

各机器运行 `boom gui` → **西湖论剑控制台 → 分布式比赛会话**：

- **主机**：先在本机配置平台 Server Host 与 AccessKey，再填 Relay 地址 `http://<服务器IP>:10057`、主控令牌、加入令牌。启动后自动注册本机 `master-worker`；点"同步并发布题目"后由它统一提交 flag。
- **从机**：填 Relay 地址 + 加入令牌即可。

命令行快速验证连通性与令牌（在任意机器上）：

```sh
curl http://<服务器IP>:10057/health
# → {"name":"Boom Relay","version":1}

curl -H "Authorization: Bearer <主控令牌>" http://<服务器IP>:10057/v1/master/state
# → 200 表示主控令牌正确；401 表示令牌错
```

## 7. 日常运维

### 7.1 健康检查与日志

```sh
curl -s http://127.0.0.1:10057/health   # 服务器本机自检
journalctl -u boom-relay -f             # 实时日志
journalctl -u boom-relay -e             # 最近错误
```

### 7.2 查看内部状态（只读）

Relay 没有网页管理界面（刻意设计，保持最小攻击面）。用 SQLite 只读模式查询：

```sh
sqlite3 "file:/www/boom-relay-data/relay.sqlite?mode=ro" \
  "SELECT id, role, name, max_slots, datetime(last_seen_at/1000,'unixepoch') FROM devices;"

sqlite3 "file:/www/boom-relay-data/relay.sqlite?mode=ro" \
  "SELECT c.id, a.status FROM assignments a JOIN challenges c ON c.id = a.challenge_id;"

sqlite3 "file:/www/boom-relay-data/relay.sqlite?mode=ro" \
  "SELECT value, status FROM flags;"
```

> WAL 模式下务必带 `?mode=ro`，避免和 Relay 抢写锁。

### 7.3 备份与恢复

`/www/boom-relay-data/` 是全部状态：`relay.sqlite`(+`-wal`/`-shm`)、`bundles/`、`relay-tokens.json`。

```sh
# 每日备份（宝塔计划任务或 cron）
tar -czf /www/backup/boom-relay-$(date +%F).tar.gz /www/boom-relay-data
```

恢复 = 停服 → 解包回原路径 → 启动。备份包含令牌与候选 flag，**按敏感数据保管**。换服务器时整个目录搬走即可，与端口无关。

## 8. 升级 Relay 版本

```sh
systemctl stop boom-relay
# 开发机上重新 rsync src/ package.json bun.lock
cd /www/boom && bun install
systemctl start boom-relay
```

SQLite 结构由 Relay 启动时自动迁移；升级前先做一次备份。

## 9. 安全边界

- **没有 HTTPS 时的风险要清楚**：纯 HTTP 公网下，主控令牌与候选 flag 都是明文过线，可被链路窃听。比赛期间是可接受的务实选择，但须遵守：
  - **赛后立即轮换令牌**（见 4.3）；
  - 服务器上**不放任何比赛 AccessKey**（Relay 也用不到）；
  - `relay-tokens.json` 与备份文件按机密对待。
- Relay 是可信服务器：题目、成果包和 flag 明文保存在其中，服务器本身要守好（SSH 密钥登录、及时打补丁）。
- 限制请求大小：JSON ≤1MB，bundle ≤512MB，flag 长度有上限；解包拒绝绝对路径、`..` 与符号链接。

## 10. 升级到 HTTPS（以后有域名时）

1. 宝塔新建站点，绑定域名，一键申请 Let's Encrypt 证书；
2. 站点设置 → 反向代理，目标 `http://127.0.0.1:10057`；
3. 反代配置中加 `client_max_body_size 512m;`（宝塔默认 50m 会拦掉大 bundle）;
4. Relay 改回 `--host 127.0.0.1` 只监听回环，公网端口关闭；
5. 客户端 Relay 地址换成 `https://<域名>`。

## 11. 故障排查

| 现象 | 排查 |
|---|---|
| 客户端连不上 | 服务器本机 `curl http://127.0.0.1:10057/health`：通则是防火墙/安全组漏放行；不通看服务状态 `systemctl status boom-relay` |
| 启动报 `EADDRINUSE` | 端口被占：`ss -tlnp \| grep 10057`，换端口或清理占用 |
| 主机启动报主控鉴权失败（401） | 令牌抄错，或轮换后 GUI 还在用旧令牌；重新 `relay tokens` 查看 |
| 新从机注册被拒（401） | 加入令牌错误；确认与服务器上 `relay-tokens.json` 的一致 |
| Relay 重启后设备全部掉线？ | 不会。设备令牌在 SQLite 中，重启不影响；从机会自动重连 |
| `sqlite3` 报 database is locked | 没带 `?mode=ro`，或起了第二个 Relay 实例 |
| 磁盘暴涨 | 检查 `bundles/` 是否有异常大文件；bundle 上限 512MB/个 |
