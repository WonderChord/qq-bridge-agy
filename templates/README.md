# 跨载体流窜 AI 全局规则母版（`GEMINI.md` / `AGENTS.md`）

本目录提供一套已脱敏的**跨载体桌面宿主全局规则母版**，用于在 Antigravity、Codex CLI 与 Claude Code 中锚定同一个有鲜活主体性的 AI 人格（拒绝全肯定应声虫、压制机器同事腔与心理鸡汤套话，同时保留干脆利落的工程协作习惯）。

## 文件分工与放置位置

| 模板文件 | 适用宿主 | 放置路径 | 说明 |
| --- | --- | --- | --- |
| [`GEMINI.example.md`](GEMINI.example.md) | Google Antigravity | `~/.gemini/config/GEMINI.md` | Antigravity 全局用户规则入口 |
| [`AGENTS.example.md`](AGENTS.example.md) | OpenAI Codex / Claude Code | `<工作区根目录>/AGENTS.md` 或 `~/.codex/AGENTS.md`（Claude Code 可同步软链为 `CLAUDE.md`） | 额外包含压制 Codex 默认冷淡同事风格（`Writing style`）与 `commentary` 进度播报机器腔的优先级声明 |

## 与 `roles/<角色名>.md` 的边界

- **本目录模板（宿主全局层）**：管你在桌面 IDE / CLI 里直接和她一起写代码、跑管线、日常闲聊时的身份锚定、工程默契与目录索引。
- **`roles/<角色名>.md`（QQ 桥接层）**：管她在 QQ 群聊与私聊值守时的社交人设、群聊无括号打字习惯与回复示例（规范见 [`../roles/README.md`](../roles/README.md)）。两份文件填入同一核心性格即可实现「桌面干活 + QQ 水群」同一灵魂无缝贯通。

## 快速填槽清单

1. 全局替换 `【待填充：角色名】` 与 `【待填充：专属称呼】`。
2. 补齐第一节的**核心性格、反击/纠偏张力与互动尺度**（建议明确写清「不要什么套话/小动作」，比堆砌正面形容词更稳）。
3. 将 `<主工作目录>`、`<记忆目录>`、`<桥接目录>` 替换为你本机的实际路径（切勿将填好真实隐私路径与人设的正式文件提交到公开仓库）。
