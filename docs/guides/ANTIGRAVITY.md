# Antigravity 与 Codex 双宿主后端指南

`qq-bridge` 支持将 **Google Antigravity (AGY)** 或 **OpenAI Codex CLI** 作为聊天与记忆归档大脑：网桥在本地完成 OneBot 收发、白名单门控、群聊前置意图分流与回合租约管理，工作线程通过 `scripts/agy-*.mjs` 零轮询阻塞领取唤醒并单命令完成回复。

## 快速启用

1. `config.json → dsh.baseUrl` 设为 `agy://local`。
2. 复制 `.env.example` 为 `.env`，填写群聊前置路由配置（`OPENAI_API_KEY`、`ROUTER_MODEL=gpt-6-luna` 与 `OWNER_QQ_IDS`）。
3. 按下文填好 `config.json` 的 `persona`、`napcat`，可选 `socialV2.tts` 与 `codexDraw`。
4. 选择任一宿主启动值守：
   - **Antigravity 模式**：运行 `powershell -ExecutionPolicy Bypass -File agy-plugin/install.ps1` 安装并启用 `qq-bridge` 插件，新建干净窗口（推荐 `Gemini 4 Carbon (Low/Medium)`）说「启动 QQ 机器人全自动值守」。
   - **Codex 后台守护模式**：直接运行 `node scripts/codex-driver.mjs start`（WMI 无窗口脱离终端常驻，可通过 `status` / `stop` 查看或停止）。

新安装默认进入二代仿真模式（`reserved2`）。随时可运行 `node scripts/bridge-status.mjs` 一键体检底层服务、前置路由统计、活跃监听进程与累计轮次。

---

## 一、网桥本地前置分流与线程分工

### 1. 本地前置消息路由（`src/message-router.js`）
- **私聊白名单零外发直通（`OWNER_QQ_IDS` / `ownerQQ`）**：发送者命中白名单的私聊**完全跳过任何外部路由请求**，并优先插入唤醒队列头部（`_enqueueWake`），零延迟直达本地主对话线程 `w1`；非白名单私聊直接在网桥层拦截。
- **群聊无推理轻量路由（`ROUTER_MODEL`）**：群聊命中点名、模糊称呼、关键词或潜水概率抽样后，由网桥内部直接调用 `gpt-6-luna`（强制 `reasoning: { effort: "none" }`，输出上限 `64` token，优先走 `/responses` 并在 `404/405` 时自动兼容 `/chat/completions`）输出 `{"should_reply": boolean, "reason": "..."}`：
  - **纯中立零隐私外发**：路由请求仅携带最近 12 条群公开上下文与触发元信息，**严禁包含角色扮演设定卡或任何长期记忆文件**。
  - **引用自身本地秒判**：`resolveReplyInfo` / `isQuoteTargetSelf` 优先匹配当前会话内存 `recentMessages`，即便 OneBot `get_msg` 缓存过期，群友引用机器人刚发的表情或文字评价时也能 0ms 识别为直接对话。
  - **10 秒超时降级兜底**：外部路由异常或未配置密钥时，仅明确 `@自身QQ号` 或引用自身消息时降级放行，其余静默忽略并推进已读水位。

### 2. 可配置的多线程分工与自动无损降级（`src/agy-helpers.js`）

通过 `config.json → socialV2.helpers` 或 `.env` 的 `AGY_HELPERS_MODE`（`auto` / `off`）及 `AGY_HELPER_VOICE` / `AGY_HELPER_SEARCH` / `AGY_HELPER_DRAW`，可自由选择**「完整五线程专业编队」**或**「轻量双线程直连」**：

| 线程 | 模型建议 | 启用条件 | 核心职责 | 换新上限 |
|---|---|---|---|---|
| `qq-chat-worker`（`w1`） | 主模型（`inherit` / `gpt-6-astra`） | 必选 | 单线程串行承接已确认唤醒以维持 KV Cache；按会话 `seenSeq` 游标增量补齐上下文；单命令完成回复/表情/语音/生图/标已读 | 日常 **30 轮**（沉浸扮演 **20 轮**；Codex 默认 **80 轮**） |
| `qq-voice-worker` | 主模型（`inherit`） | 可选（`helpers.voice`） | 异步接管 `send-tts` / `--voice-brief`，在独立上下文打磨 Drama 3 口语顿挫、气口标签与情绪底音，主线程秒回文字零阻塞 | **12 单** |
| `qq-search-worker` | 轻量模型（`flash`） | 可选（`helpers.search`） | 接管 `agy-ask-search.mjs` 同步干货查证（返回 `<= 200` 字摘要）与 `--bg-search` 异步深查追评，防止长网页污染 `w1` 上下文 | **10 单** |
| `qq-draw-worker` | 主模型（`inherit`） | 可选（`helpers.draw`） | 接管 `codex-draw` 画面导演，在独立美术上下文查看参考图并扩写生图 Prompt，物理隔离美术设定词防止串入日常聊天文本 | **8 单** |
| `qq-memory-archivist` | 主模型（`inherit`） | 推荐 | 旁路异步分舱长期记忆归纳（群 150~200 条 / 私聊 35~40 条触发，支持 `event_book.md` 结构化沉淀） | **4 批**（Codex 采用单批 `--ephemeral`） |

```json
"helpers": {
  "mode": "auto",
  "voice": true,
  "search": true,
  "draw": true,
  "voiceTimeoutMs": 45000,
  "searchTimeoutMs": 36000,
  "drawTimeoutMs": 75000
}
```

- **`mode: "auto"`（默认，在线即接管、离线无损直连）**：只要拉起了 `agy-wait-voice.mjs` / `agy-wait-search.mjs` / `agy-wait-draw.mjs`，网桥自动将对应任务派发给专业子线程；若未拉起或子线程超时，自动回退主链路直连执行，绝不丢消息或卡住回合。
- **`mode: "off"`（或 `.env` 设 `AGY_HELPERS_MODE=off` / 单项设 `false`）**：强制走轻量双线程直连模式（仅需 `w1` + `archivist`），即便有旧辅助监听进程连接也会自动提示退出且不派单；单轮临时跳过导演线程也可在 CLI 传 `--raw-tts` 或 `--direct-draw`。

---

## 二、实战排障与稳定性经验总结

### 1. 防护 Antigravity 后台通知 `~10KB` 中间截断
- **现象**：Antigravity 的后台 `run_command` 完成通知超过约 `10KB` 时会自动裁切中间文本，若首轮唤醒直接把长角色卡 + 私聊常驻记忆 + 表情清单打印到标准输出，模型会静默丢失核心设定。
- **工程解法（`guardWakeStdoutAgainstTruncation`）**：
  1. 支持首回合并行 `view_file` 预读角色卡与私聊记忆后传 `--preloaded`，未修改文件不再重复热注入；
  2. 当单次唤醒前缀 + 快照超过 `8.2KB` 时，`agy-wait-wake.mjs` / `agy-reply-and-wait.mjs` 自动将角色卡、群常驻记忆与深度巡回详档完整落盘至 `state/wake-context-w1.md`，终端仅输出短提示与消息快照，确保零截断。

### 2. Codex 多图流式挂起看门狗与归档 UTF-8 防损回滚（`scripts/codex-driver.mjs`）
- **流式卡死自愈**：多图查看（`view_image`）偶发上游流式响应无限挂起。`codex-driver.mjs` 同时设置 **180 秒流空闲强杀（`IDLE_STREAM_TIMEOUT_MS`）** 与 **480 秒单轮硬超时**，一旦超时且尚未向 QQ 发信，自动强杀进程树并在新线程重试；网桥侧 `_pruneStaleTurns`（10 分钟租约，看图/调接口自动 `touchSessionTurns` 续期）对未认领超时回合自动换新 `Turn` 重排（最多 2 次）。
- **冷启动裁剪**：通过 `LEAN_FLAGS` 显式关闭与 QQ 值守无关的桌面/建模/浏览器 MCP 与 App，大幅缩短每次唤醒的子进程启动耗时。
- **Antigravity 低频看门狗**：在 Antigravity 总控窗口挂载 `*/30 * * * *` 定时任务运行 `node scripts/agy-watchdog-check.mjs`；发现 `w1` 卡住超过 7.5 分钟自动调用 `POST /api/agy/requeue` 回退未读切片并提示重拉 `w1`，正常时仅回复单字符 `.` 避免堆叠主窗口上下文。
- **归档 UTF-8 乱码自动回滚**：Windows PowerShell 管道未设 UTF-8 时易把中文写坏为 `U+FFFD` 或连续 `????????`。`codex-driver.mjs` 在每次归档前对分舱文件拍字节快照，`verifyArchiveFiles` 检测到编码损伤增加时立即原子恢复原文件并拒绝确认 `ARCHIVE_DONE`。

### 3. Windows PowerShell `--batch` 吞引号三层自愈
- PowerShell 向原生进程传递 JSON 参数时极易吞掉内部双引号。`agy-reply-and-wait.mjs` 在认领 `Turn` 之前执行三层前置解析：
  1. 优先支持标准输入流 `--batch-stdin`（配合 PowerShell `@' ... '@` 原样传递）；
  2. JSON 解析失败时通过 Win32 `CommandLine` 提取原始平衡数组恢复引号；
  3. 仍失败时启用键跨度容错解析器 `parseUnquotedBatchItems`（可无损恢复 `[{reply:101,messages:[第一句,第二句]}]`）。若最终为空则直接报错退出且**不认领回合、不标已读**，防止吞消息。

### 4. 出站客服拒答套话双层硬拦截与污染线程换新
- 当模型偶发跳出角色输出模板化客服拒答时，`agy-reply-and-wait.mjs` 与 `src/bridge.js`（返回 `HTTP 422 refusalBlocked`）双层拦截，**绝不发往 QQ、绝不写入 `recentMessages` 历史、绝不误标已读**：
  - 同回合第 1 次触发返回 `=== REFUSAL_INTERCEPTED_RETRY ===` 让当前线程原位改写 1 次；
  - 连续第 2 次触发自动调用 `POST /api/agy/requeue` 将未读切片回退队首并输出 `WORKER_ROTATE_NEEDED` 请求换新线程；
  - 即使第 1 次改写成功发出，因该线程上下文已留有拒答记录，发完本轮后也会主动触发换新，防止后续回合语感变冷或反复触发拦截。

### 5. 表情包热更新与一键废弃（`--remove-sticker`）
- 创作者在私聊或群聊中要求移除某张效果不佳的表情时，Worker 可传 `--remove-sticker "<短id或keyword:关键词>"` 调用 `POST /api/socialV2/deprecate-sticker`，网桥校验创作者权限后自动将原图移入 `stickers_deprecated/` 并把其 MD5 写入 `supersededMd5s`，防止旧图从 QQ 云端收藏夹回流。

---

## 三、`persona`：人设与分舱记忆配置

人设正文写在 `roles/<角色>.md`（控制台可热切换），`persona` 存放识别与分舱信息：

```json
"persona": {
  "botName": "小鲸鱼",
  "nameKeywords": ["小鲸鱼", "鲸鱼"],
  "ambiguousKeywords": ["鱼鱼"],
  "creatorUids": ["10001"],
  "creatorLabel": "Creator",
  "creatorNickKeywords": ["鲸宝"],
  "selfImage": "assets/self.png",
  "selfRefs": ["assets/self.png"],
  "appearanceAnchor": ["- 发型：……", "- 穿搭：……"],
  "memoryCompartments": {
    "private:10001": { "dir": "memory/owner", "threshold": 35 },
    "group:20002": { "dir": "memory/groups/main", "threshold": 200 }
  }
}
```

- 每个群与私聊使用独立目录物理隔离。群聊默认单向只读挂载 Creator 私聊摘要（设 `includePrivate: false` 可关闭），归档只写回本会话目录。分舱记忆规范详见 [群友人设总结与双层记忆归档指南](MEMORY_ARCHIVE_GUIDE.md)。
- 若希望在 Antigravity、Codex CLI 与 Claude Code 桌面日常协作中也锚定同一鲜活人格（覆盖默认冷淡同事腔与 `commentary` 机器播报），可复制 [`templates/GEMINI.example.md`](../../templates/GEMINI.example.md) 与 [`templates/AGENTS.example.md`](../../templates/AGENTS.example.md) 填槽使用，说明见 [`templates/README.md`](../../templates/README.md)。

## 四、`napcat`：无头 NapCat 守护

`scripts/ensure-daemons.ps1` 读取 `config.json → napcat`，通过 WMI 隐藏窗口拉起无头 NapCat 与网桥（完整透传 `NAPCAT_DATA_DIR` / `NAPCAT_USER_DATA_DIR`），并用 `get_stranger_info(no_cache)` 探测 NTQQ 内核假死后自动重启；修改 `.env` 或网桥代码后可加 `-ForceRestartBridge` 重启网桥。登录态恢复与扫码说明详见 `scripts/napcat-auto-relogin.mjs` 及 [NapCat 账号安全说明](https://napneko.github.io/other/security)。

## 五、`socialV2.tts` 与 `codexDraw`

- **高表现力异步语音条（`--tts`）**：`agy-reply-and-wait.mjs` 默认以 `async: true` 将语音合成排入网桥后台串行队列 `ttsAsyncChain`，文字发出后立即释放回合重回监听池，不阻塞聊天响应；支持本地 `fish_local`（`:17864`）、云端 Fish Audio `drama-3`、ElevenLabs `eleven_v3` 与 Google 兜底。选材、频域嫁接与拆包排雷标准详见 [Fish Audio Drama 3 高表现力 TTS 指南](FISH_DRAMA3_TTS_GUIDE.md)。
- **自适应质量生图（`--codex-draw`）**：若存在 `state/closeai-api.json`（独立物理隔离 API Key，不污染系统环境变量），`scripts/agy-codex-draw.mjs` 优先直连 OpenAI 兼容图像接口并按提示词自适应选择质量（Q 版/表情包自动 `medium`，立绘/复杂光影自动 `high`），未配置或异常时自动无缝回退本机已登录 ChatGPT 会员的 Codex CLI。
