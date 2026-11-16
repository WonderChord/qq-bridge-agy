---
name: qq-bot-operator
description: 运行和值守基于无头 NapCat + qq-bridge 的全自动 QQ 机器人（超省流架构：单聊天 Worker 30 轮换新 + Flash 预筛 60 轮换新 + 主模型 4 批换新记忆归纳 + 无继承极简上下文）。
---

# QQ 全自动机器人值守规程

## 一、省流架构要点

- **常驻服务（独立于聊天窗口）**：
  - 无头 NapCat：HTTP `127.0.0.1:3000`，WS `127.0.0.1:3001`，WebUI `127.0.0.1:6099`（路径与账号见 `config.json → napcat`）。
  - 桥接主服务：`<QQ_BRIDGE_DIR>\src\bridge.js`，控制台 `http://127.0.0.1:3100`，`config.json → dsh.baseUrl` 设为 `agy://local` 启用 Antigravity 后端。
  - 状态体检：`node "<QQ_BRIDGE_DIR>\scripts\bridge-status.mjs"` 可实时核验服务在线状态、活跃监听线程与累计轮次。
- **必须使用全新干净窗口 + `Low` 思考档位启动总控（严禁在 >30k 上下文的老窗口长期挂总控）**：
  - 推荐总控窗口选用 **`Gemini 4 Carbon (Low)`**（享促销计价且保持细腻文笔，同时 `Low` 档位可削减约 70% 思考输出 Token）。每次子代理满轮换新都会唤醒总控父窗口跑 2 步；保持父窗口在 `~8k~15k` 上下文可节省 90%+ 换新费。总控运行超过 **80 步**务必重开新总控窗口或执行 `/compact`。
- **3 个极简子代理（插件 `agents/` 内置，`inheritCustomizations: false` + `inheritMcp: false` + 全员强制设轮换上限）**：
  1. `qq-chat-worker`（`w1`，`Model: "inherit"`）：单线程承接全部唤醒以持续命中 5 分钟 KV Cache（网桥已做 2s 合批），通过 `state/agy-worker-cursor.json` 按会话 `seenSeq` 增量补齐群聊潜水上下文、跨会话切换恢复 4 条纯文字锚点与现场态势卡，日常满 **30 轮**（沉浸扮演模式满 **20 轮**）退出换新。
  2. `qq-flash-judge`（`Model: "flash"`）：名字/模糊称呼命中与潜水概率抽样的 14 条上下文秒判，满 **60 轮**换新（若配置了本机反代则可传 `--auto-flash` 零子代理唤醒）。
  3. `qq-memory-archivist`（`Model: "inherit"`，满 **4 批**强制换新）：群聊每满 200 条（私聊 35 条）异步归档一次分舱记忆，跟随主模型保证归纳细腻度，且每满 4 批强制清零上下文杜绝滚雪球膨胀。

## 二、启动步骤

1. **确保服务在线 & 清场**：
   - `powershell -ExecutionPolicy Bypass -File "<QQ_BRIDGE_DIR>\scripts\ensure-daemons.ps1"`
   - `node "<QQ_BRIDGE_DIR>\scripts\napcat-auto-relogin.mjs"` 确认 `already_online`；票据失效时按提示扫码。
   - `manage_subagents(Action: "kill_all")` 清理本窗口旧子代理。
2. **并行拉起 3 个子代理**（直接 `invoke_subagent`，严禁 `define_subagent` 以免重新带入冗余全局规则与 MCP 工具表；带命名空间时用 `qq-bridge_<name>`）：
   1. `TypeName: "qq-chat-worker"`，`Role: "QQ Chat Worker w1"`，`Model: "inherit"`，`Prompt: "你是 w1 线程，请按规程启动 --worker-id w1 --priority 10 监听待命，满 30 轮退出换新。"`
   2. `TypeName: "qq-flash-judge"`，`Role: "QQ Flash Judge"`，`Model: "flash"`，`Prompt: "请立即启动 agy-wait-judge.mjs 进入预筛监听，满 60 轮退出换新。"`
   3. `TypeName: "qq-memory-archivist"`，`Role: "QQ Memory Archivist"`，`Model: "inherit"`，`Prompt: "请立即启动 agy-wait-archive.mjs 进入低频记忆归纳监听，满 4 批退出换新。"`
3. **静默总控换新（极简回复）**：
   - 收到 `[ROTATE:w1]`：`manage_subagents(Action: "kill")` 销毁旧 `w1`，用相同参数重拉，回复 ≤15 字。
   - 收到 `[ROTATE:judge]`：同样销毁并用 `Model: "flash"` 重拉，回复 ≤15 字。
   - 收到 `[ROTATE:archive]`：同样销毁并用 `Model: "inherit"` 重拉，回复 ≤15 字。

## 三、排障

- 私聊或群聊返回 403 时，核对本次唤醒下发的 `key` 与 `agentToken`，使用同一条唤醒的参数重试。
- NapCat 端口在但不回消息：多为 NTQQ 内核假死，`ensure-daemons.ps1` 的 `no_cache` 探针会自动 `-ForceRestartNapCat`。
