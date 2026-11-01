# Antigravity 后端（AGY）

qq-bridge 可以把 Antigravity 当作聊天大脑：网桥负责收消息、合批、唤醒判定与发送，Antigravity 子代理通过 `scripts/agy-*.mjs` 零轮询领取唤醒并一次命令完成回复。

## 启用

1. `config.json → dsh.baseUrl` 设为 `agy://local`。
2. 按下文填好 `persona`、`napcat`，可选 `socialV2.tts` 与 `codexDraw`。
3. 安装插件：`powershell -ExecutionPolicy Bypass -File agy-plugin/install.ps1`，在 Antigravity 插件管理里启用 `qq-bridge`。
4. 新开一个干净的 Antigravity 窗口，说「启动 QQ 机器人全自动值守」，总控会按 `qq-bot-operator` 技能拉起三个子代理。

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
- `creatorUids` 缺省取 `ownerQQ`，拥有外包画图（`--codex-draw`）权限。
- 每个记忆舱位 = `<dir>/summary.md` + `<dir>/diary/`，多个会话可共用同一个 `dir`；未列出的会话不做归纳。

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

## `socialV2.tts`：QQ 语音条

`agy-reply-and-wait.mjs --tts "台词"` → `POST /api/socialV2/send-tts` → 合成 MP3 → NapCat `record` 段发出原生语音条。

```json
"socialV2": {
  "tools": { "sendVoice": true },
  "voice": { "enabled": true, "maxPerMinute": 4, "maxPerHour": 30 },
  "tts": {
    "provider": "elevenlabs",
    "fallbackProvider": "google",
    "elevenlabs": { "voiceId": "<你的 voiceId>", "modelId": "eleven_v3" },
    "google": { "lang": "zh-CN" }
  }
}
```

- ElevenLabs 读环境变量 `ELEVENLABS_API_KEY`（或 `tts.elevenlabs.apiKey`）。
- Google 走免 Key 的翻译朗读接口，单次 200 字以内，适合作兜底。
- 需要本机有 `ffmpeg`（`socialV2.voice.ffmpegPath` 或 PATH）。

## `codexDraw`：外包画图

`--codex-draw '{"prompt":"…","selfRef":true}'` 调用本机已登录的 Codex CLI 生图，约 45 秒后自动引用创作者发出。`selfRef` 会挂载 `persona.selfRefs` 并前置 `persona.appearanceAnchor`。`codexDraw.invokeScript` 默认指向仓库自带的 `scripts/Invoke-CodexImage.ps1`（需 PowerShell 7）。
