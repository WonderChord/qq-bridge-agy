---
name: qq-bot-operator
description: 运行和值守基于无头 NapCat + qq-bridge 的全自动 QQ 机器人（省流架构：单聊天 Worker 25 轮换新 + Flash 预筛 30 轮换新 + Flash 低频记忆归纳 + 无继承极简上下文）。
---

# QQ 全自动机器人值守规程

## 一、架构

- **常驻服务（独立于聊天窗口）**：
  - 无头 NapCat：HTTP `127.0.0.1:3000`，WS `127.0.0.1:3001`，WebUI `127.0.0.1:6099`（路径与账号见 `config.json → napcat`）。
  - 桥接主服务：`<QQ_BRIDGE_DIR>\src\bridge.js`，控制台 `http://127.0.0.1:3100`，`config.json → dsh.baseUrl` 设为 `agy://local` 启用 Antigravity 后端。
- **总控窗口保持干净**：每次子代理满轮换新都会唤醒总控跑 2 步，总控上下文越小换新越便宜；步数过多时 `/compact` 或换新窗口。
- **3 个子代理**（插件 `agents/` 内置，`inheritCustomizations: false` + `inheritMcp: false` + 最小工具集）：
  1. `qq-chat-worker`（`w1`，`Model: "inherit"`）：单线程承接全部唤醒以持续命中 KV Cache（网桥已做 2s 合批），满 25 轮退出换新。
  2. `qq-flash-judge`（`Model: "flash"`）：名字/模糊称呼命中与潜水概率抽样的 14 条上下文秒判，满 30 轮换新。
  3. `qq-memory-archivist`（`Model: "flash"`）：群聊每满 150 条（私聊 40 条）异步归档一次分舱记忆。

## 二、启动步骤

1. **确保服务在线**：
   - `powershell -ExecutionPolicy Bypass -File "<QQ_BRIDGE_DIR>\scripts\ensure-daemons.ps1"`
   - `node "<QQ_BRIDGE_DIR>\scripts\napcat-auto-relogin.mjs"` 确认 `already_online`；票据失效时按提示扫码。
   - `manage_subagents(Action: "kill_all")` 清理本窗口旧子代理。
2. **并行拉起 3 个子代理**（直接 `invoke_subagent`，不要 `define_subagent`；带命名空间时用 `qq-bridge_<name>`）：
   1. `TypeName: "qq-chat-worker"`，`Role: "QQ Chat Worker w1"`，`Model: "inherit"`，`Prompt: "你是 w1 线程，请按规程启动 --worker-id w1 --priority 10 监听待命，满 25 轮退出换新。"`
   2. `TypeName: "qq-flash-judge"`，`Role: "QQ Flash Judge"`，`Model: "flash"`，`Prompt: "请立即启动 agy-wait-judge.mjs 进入预筛监听，满 30 轮退出换新。"`
   3. `TypeName: "qq-memory-archivist"`，`Role: "QQ Memory Archivist"`，`Model: "flash"`，`Prompt: "请立即启动 agy-wait-archive.mjs 进入低频记忆归纳监听。"`
3. **换新**：
   - 收到 `[ROTATE:w1]`：`manage_subagents(Action: "kill")` 销毁旧 `w1`，用相同参数重拉，回复 ≤15 字。
   - 收到 `[ROTATE:judge]`：同样销毁并用 `Model: "flash"` 重拉。

## 三、排障

- 私聊/群聊回复 `403 agent token 无效`：`/api/agy/wait` 会随唤醒下发 `agentToken`，`agy-reply-and-wait.mjs` 也会按 `--key` 自动校正；仍失败时检查 `state/social-v2.json` 是否存在该会话。
- NapCat 端口在但不回消息：多为 NTQQ 内核假死，`ensure-daemons.ps1` 的 `no_cache` 探针会自动 `-ForceRestartNapCat`。
