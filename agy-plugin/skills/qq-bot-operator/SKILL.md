---
name: qq-bot-operator
description: 运行和值守基于无头 NapCat + qq-bridge 的全自动 QQ 机器人（本地网桥前置分流路由 + 单主对话子代理 30/20 轮换新 + 低频卡死超时看门狗 + 主模型 4 批换新记忆归档）。
---

# QQ 全自动机器人值守规程

## 一、协同与省流架构要点

- **底层常驻服务与本地前置路由（脱离聊天窗口生命周期）**：
  - 无头 NapCat：HTTP `127.0.0.1:3000`，WS `127.0.0.1:3001`，WebUI `127.0.0.1:6099`（路径与账号见 `config.json → napcat`）。
  - 桥接主服务与前置分流：`<QQ_BRIDGE_DIR>\src\bridge.js`（控制台 `http://127.0.0.1:3100`，`dsh.baseUrl = "agy://local"`，路由配置读取 `<QQ_BRIDGE_DIR>\.env`）：
    - **私聊白名单直通（零外部请求）**：命中 `OWNER_QQ_IDS` / `ownerQQ` 的私聊完全跳过外部路由接口，直接排入队首唤醒本地主对话线程 `w1`。
    - **群聊前置轻量路由（`ROUTER_MODEL`）**：群聊候选消息在网桥内部直接调用 `gpt-6-luna`（`reasoning: { effort: "none" }`，纯中立分类器，不含任何角色卡或记忆内容，10 秒超时且异常时仅 `@自身QQ号` 或引用自身消息降级放行）；`should_reply: false` 的消息在网桥层静默忽略，所有进入本地 Worker 的消息均已确认需要回复。
    - **在途回合续期与超时自愈**：网桥每 30 秒巡检在途回合，单轮默认 10 分钟租约（看图/工具调用自动续期），超时未认领自动切新 Turn 回退重排。
  - 状态体检：`node "<QQ_BRIDGE_DIR>\scripts\bridge-status.mjs"` 可实时核验服务在线状态、前置路由统计、活跃监听线程与累计轮次。
- **双宿主运行选择（Antigravity vs Codex）**：
  - **在 Antigravity 中运行**：使用干净新窗口（推荐 `Gemini 4 Carbon (Low/Medium)`，总控超过 80 步建议 `/compact` 或换新窗口）并行拉起 `qq-chat-worker`（`w1`）+ `qq-memory-archivist` 双子代理，并挂一个**每 30 分钟触发一次的低频 `schedule` 防卡死巡检**（正常时仅输出单字符 `.` 结束，绝不堆叠主窗口上下文）。
  - **在 Codex 中运行**：使用后台守护驱动器 `node "<QQ_BRIDGE_DIR>\scripts\codex-driver.mjs" start`（WMI 脱离终端常驻，内置 **180 秒流式空闲强杀 + 480 秒单轮硬超时自愈**与归档 UTF-8 损坏自动回滚），切勿在交互界面直接手跑长阻塞循环（防多图 `view_image` 上游流挂起）。

## 二、Antigravity 总控窗口启动步骤

1. **确保底层服务在线 & 清场**：
   - 执行 `powershell -ExecutionPolicy Bypass -File "<QQ_BRIDGE_DIR>\scripts\ensure-daemons.ps1"`（修改 `.env` 后加 `-ForceRestartBridge`；切勿误杀个人桌面 `QQ.exe`）。
   - 执行 `node "<QQ_BRIDGE_DIR>\scripts\napcat-auto-relogin.mjs"` 确认 `already_online`；票据失效时按提示扫码。
   - 执行 `manage_subagents(Action: "kill_all")` 清理本窗口旧子代理。
2. **并行拉起 2 个本地子代理 + 1 个低频防卡死定时器**（直接 `invoke_subagent`，严禁 `define_subagent` 以免带入冗余全局规则与 MCP 工具表；带命名空间时用 `qq-bridge_<name>`）：
   1. `TypeName: "qq-chat-worker"`，`Role: "QQ Chat Worker w1"`，`Model: "inherit"`，`Prompt: "你是 w1 线程，请按规程启动 --worker-id w1 --priority 10 监听待命，日常满 30 轮（沉浸扮演 20 轮）退出换新。"`
   2. `TypeName: "qq-memory-archivist"`，`Role: "QQ Memory Archivist"`，`Model: "inherit"`，`Prompt: "请立即启动 agy-wait-archive.mjs 进入低频记忆归纳监听，满 4 批退出换新。"`
   3. 同时调用 `schedule` 启动低频巡检：`CronExpression: "*/30 * * * *"`, `IsDaemon: false`, `Prompt: "低频巡检：运行 node <QQ_BRIDGE_DIR>/scripts/agy-watchdog-check.mjs；若输出 STUCK 则立即 kill 旧 w1 并重拉新 w1；若输出 OK 则仅回复一个句号 . 结束本轮，严禁输出多余文字堆叠主窗口。"`
3. **静默换新与极简收尾（防主窗口堆叠）**：
   - 收到 `[ROTATE:w1]` 或巡检输出 `STUCK`：`manage_subagents(Action: "kill")` 销毁旧 `w1`，用相同参数重拉新 `w1`，回复 ≤10 字。
   - 收到 `[ROTATE:archive]`：`manage_subagents(Action: "kill")` 销毁旧 `qq-memory-archivist` 并重拉新线程，回复 ≤10 字。
   - 30 分钟巡检为 `OK` 时：只输出单字符 `.` 立即收尾。

## 三、排障

- 私聊或群聊返回 403 时，核对本次唤醒下发的 `key` 与 `agentToken`，使用同一条唤醒的参数重试。
- NapCat 端口在但不回消息：多为 NTQQ 内核假死，`ensure-daemons.ps1` 的 `no_cache` 探针会自动 `-ForceRestartNapCat`。
