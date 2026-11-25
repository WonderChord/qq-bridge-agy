---
name: qq-bot-operator
description: 运行和值守基于无头 NapCat + qq-bridge 的全自动 QQ 机器人（网桥本地前置分流路由 + 可选启用语音导演/后台搜索/绘图助手多线程编队或轻量双线程直连 + 低频防卡死看门狗）。
---

# QQ 全自动机器人值守规程

## 一、协同架构与多线程开关

- **底层常驻服务与本地前置路由（脱离聊天窗口生命周期）**：
  - 无头 NapCat：HTTP `127.0.0.1:3000`，WS `127.0.0.1:3001`，WebUI `127.0.0.1:6099`（路径与账号见 `config.json → napcat`）。
  - 桥接主服务：`<QQ_BRIDGE_DIR>\src\bridge.js`（控制台 `http://127.0.0.1:3100`，`dsh.baseUrl = "agy://local"`，路由与多线程配置读 `config.json` 与 `.env`）：
    - **私聊白名单直通（零外部请求）**：命中 `OWNER_QQ_IDS` / `ownerQQ` 的私聊跳过外部路由，直接排入队首唤醒 `w1`。
    - **群聊前置轻量路由（`ROUTER_MODEL`）**：在网桥内调用 `gpt-6-luna`（`reasoning: { effort: "none" }`）判定 `should_reply`，仅需回复的消息才唤醒 `w1`。
- **可配置的三路专业辅助子线程（`src/agy-helpers.js`）**：
  - 通过 `config.json → socialV2.helpers` 或 `.env` 的 `AGY_HELPERS_MODE`（`auto` / `off`）及 `AGY_HELPER_VOICE` / `AGY_HELPER_SEARCH` / `AGY_HELPER_DRAW` 控制是否走多线程分流：
    1. **语音导演线程（`qq-voice-worker`，默认 `voice: true`）**：异步接管 `send-tts` / `--voice-brief`，专职打磨 Drama 3 口语顿挫、呼吸标签与情绪参考底音，`w1` 秒回文字零阻塞。
    2. **后台搜索线程（`qq-search-worker`，默认 `search: true`）**：接管 `agy-ask-search.mjs` 同步干货查证与 `--bg-search` 异步深查追评，防止长网页污染 `w1` 上下文。
    3. **绘图助手线程（`qq-draw-worker`，默认 `draw: true`）**：接管 `codex-draw` 画面导演，在独立美术上下文查看参考图并扩写生图 Prompt，物理隔离美术设定词防串入聊天文本。
  - **无损自动降级**：`mode: "auto"` 下任一辅助子代理未启动或超时，网桥与脚本均自动回退单主线程直连执行；若希望固定走轻量模式，设 `AGY_HELPERS_MODE=off`（或只拉起 `w1 + archivist`）即可。

## 二、Antigravity 总控窗口启动步骤

1. **确保底层服务在线 & 清场**：
   - 执行 `powershell -ExecutionPolicy Bypass -File "<QQ_BRIDGE_DIR>\scripts\ensure-daemons.ps1"`（改代码或 `.env` 后加 `-ForceRestartBridge`；切勿误杀个人桌面 `QQ.exe`）。
   - 执行 `node "<QQ_BRIDGE_DIR>\scripts\napcat-auto-relogin.mjs"` 确认 `already_online`。
   - 执行 `manage_subagents(Action: "kill_all")` 清理本窗口旧子代理。
2. **按所选模式并行拉起子代理 + 1 个低频防卡死定时器**（带命名空间时子代理名为 `qq-bridge_<name>`）：
   - **完整五线程专业编队（默认推荐，`AGY_HELPERS_MODE=auto`）**：同一回合并行调用 5 次 `invoke_subagent`：
     1. `TypeName: "qq-chat-worker"`，`Role: "QQ Chat Worker w1"`，`Model: "inherit"`，`Prompt: "你是 w1 线程，请按规程启动 --worker-id w1 --priority 10 监听待命，日常满 30 轮（沉浸扮演 20 轮）退出换新。"`
     2. `TypeName: "qq-voice-worker"`，`Role: "QQ Voice Director"`，`Model: "inherit"`，`Prompt: "请立即启动 agy-wait-voice.mjs 进入语音导演精修监听，满 12 单退出换新。"`
     3. `TypeName: "qq-search-worker"`，`Role: "QQ Background Search"`，`Model: "flash"`，`Prompt: "请立即启动 agy-wait-search.mjs 进入后台搜索查证监听，满 10 单退出换新。"`
     4. `TypeName: "qq-draw-worker"`，`Role: "QQ Draw Director"`，`Model: "inherit"`，`Prompt: "请立即启动 agy-wait-draw.mjs 进入绘图导演精修监听，满 8 单退出换新。"`
     5. `TypeName: "qq-memory-archivist"`，`Role: "QQ Memory Archivist"`，`Model: "inherit"`，`Prompt: "请立即启动 agy-wait-archive.mjs 进入低频记忆归纳监听，满 4 批退出换新。"`
   - **轻量双线程模式（省子代理槽位，或已设 `AGY_HELPERS_MODE=off`）**：仅拉起上述第 `1`（`qq-chat-worker`）和第 `5`（`qq-memory-archivist`）两个子代理；语音、搜索与生图自动在主链路直连完成。
   - **同时调用 `schedule` 启动低频巡检**：`CronExpression: "*/30 * * * *"`, `IsDaemon: false`, `Prompt: "低频巡检：运行 node <QQ_BRIDGE_DIR>/scripts/agy-watchdog-check.mjs；若输出 STUCK 则立即 kill 旧 w1 并重拉新 w1；若输出 OK 则仅回复一个句号 . 结束本轮，严禁输出多余文字堆叠主窗口。"`
3. **静默换新与极简收尾（防主窗口堆叠）**：
   - 收到 `[ROTATE:w1]` / `[ROTATE:voice]` / `[ROTATE:search]` / `[ROTATE:draw]` / `[ROTATE:archive]` 或巡检输出 `STUCK` 时：`manage_subagents(Action: "kill")` 销毁对应旧子代理，用相同参数重拉对应新子代理，回复不超过 10 个字。
   - 30 分钟巡检为 `OK` 时：只输出单字符 `.` 立即收尾。
