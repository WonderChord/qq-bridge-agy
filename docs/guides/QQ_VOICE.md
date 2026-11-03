# QQ 语音

## 从控制台试发

把音频放进仓库的 `audio/`，在本机控制台的「二代仿真」页选择白名单会话和文件。先做试运行，确认目标、时长和音量，再点发送。网关返回消息 ID 后，桥接可用 `get_msg` 检查消息里是否有 `record` 段。

## 允许 AI 发送

AI 发语音默认是关的。启用二代仿真模式，在 `config.json` 的 `socialV2` 下打开 `voice.enabled` 和 `tools.sendVoice`。DSH 会话使用 `qq_list_voices` 查看资料库，再用 `qq_send_voice` 发送。语音库位置、时长、体积以及每分钟和每小时的额度在 `socialV2.voice` 设置。

Antigravity 可把台词直接合成为语音条。在控制台「语音库与语音发送」勾选台词合成并保存，在 Worker 的回复命令中加入 `--tts "台词"`。使用文件配置时，打开 `socialV2.tts.enabled`，选好提供商后重启桥接。现有语音库与 TTS 共用会话额度。Google 单次最多 200 字，ElevenLabs 最多 500 字。配置示例见 [Antigravity 指南](ANTIGRAVITY.md)。

## 独立工具

如果另行安装了相邻目录 `../voice-tool/`，可运行 `npm run voice-cli` 使用 `voice-cli.mjs`，或运行 `npm run voice-gui` 打开 `voice-gui.mjs` 图形界面。配套 Windows 启动器名为 `发语音-图形界面.cmd`。单独克隆此仓库即可使用前两节的桥接功能。
