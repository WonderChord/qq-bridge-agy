# Antigravity 后端（AGY）

qq-bridge 可以把 Antigravity 当作聊天大脑：网桥负责收消息、合批、唤醒判定与发送，Antigravity 子代理通过 `scripts/agy-*.mjs` 零轮询领取唤醒并一次命令完成回复。

## 启用

1. `config.json → dsh.baseUrl` 设为 `agy://local`。
2. 按下文填好 `persona`、`napcat`，可选 `socialV2.tts` 与 `codexDraw`。
3. 安装插件：`powershell -ExecutionPolicy Bypass -File agy-plugin/install.ps1`，在 Antigravity 插件管理里启用 `qq-bridge`。
4. 新开一个干净的 Antigravity 窗口，说「启动 QQ 机器人全自动值守」，总控会按 `qq-bot-operator` 技能拉起三个子代理。

新安装默认进入二代仿真模式。已有安装沿用控制台保存的模式，使用值守 Worker 时选择「二代仿真」。控制台的「聊天后端」显示待命数、处理数和积压数。

## 线程分工

| 子代理 | 模型 | 作用 | 换新 |
|---|---|---|---|
| `qq-chat-worker`（w1） | inherit | 承接全部唤醒，`agy-reply-and-wait.mjs` 一次完成文字/表情/语音/画图/标已读 | 25 轮 |
| `qq-flash-judge` | flash | 名字/模糊称呼命中与潜水概率抽样的 yes/no 预筛 | 30 轮 |
| `qq-memory-archivist` | flash | 分舱长期记忆归纳（群 150 条 / 私聊 40 条一次） | 不换 |

## `persona`：人设与身份

人设正文写在 `roles/<角色>.md`（控制台可切换），`persona` 只放网桥需要的识别信息：

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
    "private:10001": { "dir": "memory/owner", "threshold": 40 },
    "group:20002": { "dir": "memory/groups/main", "threshold": 150 }
  }
}
```

- `nameKeywords` 命中视为点名；`ambiguousKeywords` 命中后交给 Flash 预筛判断是否真在叫机器人。
- `creatorUids` 留空时取 `ownerQQ`，拥有外包画图（`--codex-draw`）权限。
- 每个群使用独立的记忆目录。群聊挂载本群摘要，并默认挂载 Creator 私聊的摘要。设该群的 `includePrivate` 为 `false` 可关闭后者。归档任务的 `summaryPath` 和 `diaryDir` 只指向触发归档的会话。
- 私聊问到群友或话题时，桥接从配置的群摘要、人物条目、最近六份日记和近期群消息中检索。输出带群名、群号与来源，上限 800 字。可用 `groupName` 设置显示名称。目录变动通知会使索引失效，下次查询仅重读有变化的 Markdown 文件。文件系统不支持监视时，每两秒至多复核一次。
- `GET /api/agy/status` 的 `workers` 给出在线 Worker 的 `connectedAt` 与 `lastWakeAt`。`loadedSignatures` 按 Worker 和会话列出角色、记忆与表情签名。用同一 Worker ID 重挂 `/api/agy/wait` 或 `/api/agy/wait-wake`，未发言的原消息切片会换一个新回合 ID 重新投递。已确认处理完的切片直接关闭。

## `napcat`：无头 NapCat 守护

`scripts/ensure-daemons.ps1` 读取这些字段，无窗口拉起 NapCat 与网桥，并用 `get_stranger_info(no_cache)` 探测 NTQQ 内核假死后自动重启：

```json
"napcat": {
  "dir": "D:/NapCat/NapCat.Shell",
  "account": "10000",
  "dataDir": "D:/NapCat/qq_data",
  "userDataDir": "D:/NapCat/electron_user_data",
  "onebotConfig": "D:/NapCat/NapCat.Shell/versions/<ver>/resources/app/napcat/config/onebot11_10000.json",
  "webuiConfigPath": "D:/NapCat/NapCat.Shell/versions/<ver>/resources/app/napcat/config/webui.json",
  "nodeExe": ""
}
```

守护脚本从上述配置读取账号和 WebUI 凭据，兼容已有的 `state/napcat-auth.json`。目录路径相对于仓库根目录。

若日志出现 `KickedOffLine` 和“登录态已失效”，先运行 `node scripts/napcat-auto-relogin.mjs --status-only` 查看本机 WebUI 报告的登录阶段。正常守护优先等待 NapCat 自行重连。目标账号有可用票据时，同一离线期最多提交一次 `SetQuickLogin`，并以实际在线状态确认结果。看到 `need_qrcode` 时，在配置的本机 WebUI 用手机 QQ 扫码。已有二维码会保留，原生扫码确认或初始化期间不会重启进程。确认上线后，下次断线可以重新尝试快速登录。

如果持续被踢，可检查是否有其他实例登录同一个机器人号，确认 `dataDir` 和 `userDataDir` 始终指向同一组持久目录。NapCat 官方还建议检查账号限制及包拦截设置。账号侧已失效的登录态需要由 QQ 重新验证。[NapCat 账号安全说明](https://napneko.github.io/other/security)

## `socialV2.tts`：QQ 语音条

`agy-reply-and-wait.mjs --tts "台词"` → `POST /api/socialV2/send-tts` → 合成 MP3 → NapCat `record` 段发出原生语音条。

在控制台「二代仿真」的工具列表勾选 `qq_send_voice`，再在「语音库与语音发送」打开 AI 语音和台词合成，选择提供商后保存。保存立即生效。已有配置的备用提供商、模型、音量和额度会保留。

```json
"socialV2": {
  "tools": { "sendVoice": true },
  "voice": { "enabled": true, "maxPerMinute": 4, "maxPerHour": 30 },
  "tts": {
    "enabled": true,
    "provider": "fish",
    "fallbackProvider": "none",
    "fish": {
      "model": "drama-3",
      "apiKeyEnv": "FISH_API_KEY",
      "referenceDir": "audio/nya_aris_ref/restored_48k",
      "mp3Bitrate": 192,
      "temperature": 0.7,
      "topP": 0.7
    },
    "elevenlabs": { "voiceId": "<你的 voiceId>", "modelId": "eleven_v3" },
    "google": { "lang": "zh-CN" }
  }
}
```

- **Fish Audio Drama 3（推荐）**：读环境变量 `FISH_API_KEY`（或 `tts.fish.apiKey`），支持 `[...]` 句级演技指令、点状呼吸笑声标签、`<whisper>...</whisper>` / `<soft>...</soft>` 成对尖括号局部变形、MessagePack 零样本 48kHz 多情绪参考底包动态路由与 42 字自动短句分句。详见 [Fish Audio Drama 3 高表现力 TTS 指南](FISH_DRAMA3_TTS_GUIDE.md)。
- ElevenLabs 读环境变量 `ELEVENLABS_API_KEY`（或 `tts.elevenlabs.apiKey`）。
- Google 走免 Key 的翻译朗读接口，单次 200 字以内，适合作兜底。
- 需要本机有 `ffmpeg`（`socialV2.voice.ffmpegPath` 或 PATH）。

## `codexDraw`：外包画图

`--codex-draw '{"prompt":"…","selfRef":true}'` 调用本机已登录的 Codex CLI 生图，完成后发回原会话。群聊需用 `--reply` 引用最近三分钟内创作者在本群发出的消息，私聊按创作者 QQ 号授权。`selfRef` 会挂载 `persona.selfRefs` 并前置 `persona.appearanceAnchor`。`codexDraw.invokeScript` 默认指向仓库自带的 `scripts/Invoke-CodexImage.ps1`（需 PowerShell 7）。
