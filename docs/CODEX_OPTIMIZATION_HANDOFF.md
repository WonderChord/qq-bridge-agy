# QQ-Bridge (AGY Edition) — Codex 交接与深度优化指南

> **更新日期**：2026-11-04
> **上游仓库**：`https://github.com/WonderChord/qq-bridge-agy.git`（`main` 分支）
> **部署目录**：运行库 `E:\AI\qq-bridge` ｜ 开源发布库 `E:\AI\qq-bridge-release`

---

## 一、项目现状与架构基线（优化时必须 100% 保留）

本项目是基于 **Headless NapCat (OneBot v11) + qq-bridge + Google Antigravity (AGY)** 的超省流全自动 QQ 机器人桥接系统。采用「零轮询 HTTP 长轮询挂起 + 单步脚本回传」架构，平时待命零 Token 消耗。

### 1. 三监听并发角色分工
| 监听通道 | 脚本入口 | 服务端端点 | 职责与换新周期 |
| :--- | :--- | :--- | :--- |
| **主力聊天线程 (`w1`)** | `scripts/agy-wait-wake.mjs`<br>`scripts/agy-reply-and-wait.mjs` | `GET /api/agy/wait-wake`<br>`POST /api/agy/claim`<br>`POST /api/agy/finish-turn` | 处理私聊与通过预筛的群聊唤醒，单步完成回复/贴图/语音/外包生图并原地重回监听；满 25 轮无状态换新 |
| **前置预筛门控 (`judge`)** | `scripts/agy-wait-judge.mjs` | `GET /api/agy/wait-judge`<br>`POST /api/agy/judge-result` | 对群聊名字/关键词（`Nya/Nia/基米`）及潜水 `0.12` 概率抽样拉取最近 14 条上下文秒判 `yes/no`，拦截无效唤醒；满 30 轮换新 |
| **分舱记忆归纳 (`archivist`)** | `scripts/agy-wait-archive.mjs` | `GET /api/agy/wait-archive`<br>`POST /api/agy/archive-done` | 当群聊满 150 条或私聊满 40 条新消息时异步提炼 `summary.md` 与 `diary/YYYY-MM-DD.md`，零聊天阻塞；满 10 轮换新 |

### 2. 已实装且不可回退的 6 项核心特性
1. **单向记忆隔离 + 私聊按需巡回群记忆**（`src/bridge.js`）：
   - **群聊单向挂载（`buildWorkerHotReloadPrefixV2`）**：每个群（`group:*`）同时挂载「本群专属长期记忆 `summary.md`」与「Creator 私聊长期记忆 `owner.md`」（可通过 `persona.memoryCompartments[key].includePrivate = false` 关闭），按 `${ownMtime}:${privMtime}` 联合签名热更新；群与群之间严格物理隔离，群聊归档仅写入本群目录，绝不反向污染私聊记忆。
   - **私聊按需巡回（`recallGroupMemoryForPrivateV2` + `scripts/agy-recall-group.mjs`）**：私聊（`private:*`）主挂载 `owner.md`；每次私聊唤醒时自动提取 Creator 消息中的群友昵称、ASCII 型号词与 CJK n-gram，检索各群 `summary.md`、`people/*.md`、最近 6 份 `diary/*.md` 及内存 `recentMessages`，命中时注入 `【私聊按需巡回的群聊记忆与近期动态】`（上限 800 字），未提及群相关内容时零注入。
2. **引用回复双键解析与 400 自动降级**：
   - `resolveReplyTargetV2` 同时在会话 `recentMessages` 与 `unread` 中按本地 `seq` 和平台 `messageId` 双键匹配，不强依赖易超时的 OneBot `get_msg`。
   - `scripts/agy-reply-and-wait.mjs` 发送带 `--reply` 的消息若遇 `400（无法解析被引用消息）`，自动剥离 `replyToMessageId` 重试发送纯文本；若 `/api/agy/claim` 返回 `404`（跨轮重复提交或旧回合已结算），自动跳过发送并原地重回 `waitForNextWake()`，防止 Worker 掉出监听池。
3. **表情夹内容哈希热更新与作废 MD5 屏蔽**：
   - `buildWorkerHotReloadPrefixV2` 使用前 `maxS` 张表情的 `md5:localNote` SHA-1 签名检测变更，替换同名表情（总张数不变但 MD5 改变）时立即向 Worker 推送新短 ID 清单。
   - `syncStickersFromQQ` 维护 `supersededMd5s` 集合，自动屏蔽本地同名文件已更新的旧版表情 MD5，防止已废弃旧图从 QQ 云端收藏夹回流。
4. **Windows 无头 NapCat 环境变量透传与守护脚本**：
   - `scripts/ensure-daemons.ps1` 使用 `cmd.exe /c "set NAPCAT_DATA_DIR=... && set NAPCAT_USER_DATA_DIR=... && ..."` 配合 `Win32_Process.Create` (`ShowWindow=0`) 隐藏启动，确保 `config.json` 中的 `napcat.dataDir` / `userDataDir` / `onebotConfig` 100% 透传生效，并支持 `-ForceRestartBridge` 参数。
5. **TTS 语音守门与重试**：
   - `src/tts.js` 与 `src/bridge.js` 支持合成前校验目标会话、静默状态与并发额度；ElevenLabs `eleven_v3` 具备 2 次自动重试，且严格尊重 `fallbackProvider: "none"`（不擅自退回机械感重的兜底源）。
6. **主动冒泡（Proactive Speaking）与 Creator 专属外包生图**：
   - 支持群聊/私聊空闲概率触发 `proactiveCheck` 唤醒及 `POST /api/socialV2/proactive-now` 立即触发；
   - `--codex-draw`（`scripts/agy-codex-draw.mjs`）调用本机 Codex CLI 生图，群聊中严格校验触发消息直接引用了 Creator 本人最近发出的消息。

---

## 二、本次交接给 Codex 的重点优化任务

请在不破坏上述 6 项现有特性及全部既有测试的前提下，按以下 4 个方向对项目进行重构与加固：

### 任务 1（P0）：`src/bridge.js` 模块化拆分与减重
- **现状痛点**：`src/bridge.js` 目前高达 **14,240+ 行（约 786 KB）**，单文件内耦合了内联 WebUI HTML/CSS/JS、OneBot 消息归一化、Social V2 状态机、AGY 三通道调度器、分舱记忆与私聊巡回检索、HTTP API 路由等全部逻辑，维护成本高。
- **优化要求**：
  1. 将内联的控制台前端页面（HTML/CSS/JS）抽离为独立模块（如 `src/webui-page.js` 或静态资源加载）。
  2. 将 **分舱长期记忆与私聊按需巡回逻辑**（`MEMORY_COMPARTMENTS`、`maybeEnqueueMemoryArchiveV2`、`buildWorkerHotReloadPrefixV2`、`recallGroupMemoryForPrivateV2`）抽离至独立模块（如 `src/memory-compartment.js`），导出清晰纯函数或工厂接口。
  3. 将 **AGY 调度队列与回合生命周期管理**（`waitingWorkers`、`waitingJudges`、`waitingArchivists`、`activeTurns`、`/api/agy/*` 路由处理）抽离至独立模块（如 `src/agy-coordinator.js`）。
  4. 保持 `node src/bridge.js` 启动入口、配置文件格式与全部 HTTP/MCP 接口 100% 向后兼容。

### 任务 2（P1）：私聊按需巡回群记忆（`recallGroupMemoryForPrivateV2`）性能与召回率升级
- **现状痛点**：
  1. 当前 `recallGroupMemoryForPrivateV2` 在每次私聊唤醒时都会同步执行多次 `fs.readdirSync` / `fs.readFileSync` 读取 `summary.md`、`people/*.md` 与 `diary/*.md`。
  2. `knownEntities` 中包含硬编码的群友昵称列表（如 `半瓶醋`、`Cyber马` 等），新群或新常驻群友无法自动享受高权重实体加分。
- **优化要求**：
  1. **基于 `mtimeMs` 的内存索引缓存**：为每个 `group:*` 分舱建立基于文件修改时间的内存行缓存与解析后实体集合，文件未发生改动时零磁盘 I/O 直接内存检索。
  2. **动态实体词典提取**：自动从各群 `summary.md`、`people/*.md` 的反引号 `` `昵称` ``、粗体词条以及 `recentMessages` 发言人昵称中动态构建 `knownEntities` 及其 2 字尾缀别名，彻底移除代码中的硬编码人名列表。
  3. **时间衰减与多群标识**：对 `diary/YYYY-MM-DD.md` 按日期新旧加入轻微时间衰减分（近期事件优先于旧账），并在输出条目前清晰标注群名称/群号（方便未来接入 `noa_group` 等多群时区分来源）。

### 任务 3（P2）：AGY Worker 断线重连自愈与僵尸回合清理
- **现状痛点**：当外部 AGY 宿主重启或子代理偶发中断并重新拉起同一个 `workerId`（如 `w1`）时，如果旧 `w1` 恰好有一个已派发但未调用 `finish-turn` 的 `activeTurn`，该回合会一直占用并发槽位直到超时。
- **优化要求**：
  1. 当 `GET /api/agy/wait-wake?workerId=w1` 收到来自同一 `workerId` 的新长轮询挂起请求时，检查 `activeTurns` 中是否仍有绑定在该 `workerId` 上的未完成旧回合：
     - 若该旧回合尚未产生任何实际发言动作（`!agyTurnActionClaims`），自动释放其 `agyClaimedMsgOwner` 切片锁并安全关闭旧回合（或允许新唤醒重新覆盖认领未读消息），避免消息因宿主重启而漏回或卡死。
  2. 在 `GET /api/agy/status` 返回值中补充每个在线 Worker 的 `connectedAt`、`lastWakeAt` 以及当前各会话已加载的记忆/角色/表情签名摘要，便于主代理一键诊断。

### 任务 4（P3）：自动化回归测试补齐（`npm test`）
- **优化要求**：在 `scripts/test-agy-bridge.mjs`（及 `scripts/test-audit.mjs`）中新增以下回归测试用例，确保 `npm test` 一键全绿通过：
  1. **单向记忆隔离测试**：验证 `group:*` 唤醒热前缀同时包含本群 `summary.md` 与私聊 `owner.md`，且不同群之间互不串台、群归档只写本群目录。
  2. **私聊按需巡回测试**：验证 `private:*` 唤醒在提及群友/群话题时自动在唤醒提示中注入匹配的群记忆与近期群消息，而在普通私密对话（如“抱抱”“晚安”）时零注入。
  3. **引用 400 降级与本地 `messageId` 解析测试**：验证 `resolveReplyTargetV2` 可直接从 `recentMessages` / `unread` 匹配字符串 `messageId`，且无效引用不会导致整条回复丢失。
  4. **Worker 重连清理残留回合测试**：验证同一 `workerId` 重新挂起 `wait-wake` 时能自动回收未发言的残留回合锁。

---

## 三、本地验证命令清单

优化完成后，请依次执行以下命令完成验收：

```bash
# 1. 运行全套单元与回归测试（包含 AGY 桥接专项测试）
npm test
node scripts/test-agy-bridge.mjs

# 2. 验证私聊群记忆主动检索脚本
node scripts/agy-recall-group.mjs "宝马" "半瓶醋"

# 3. 安全审计（保持 0 漏洞）
npm audit --omit=dev
```

---

## 四、给用户直接复制发给 Codex 的提示词（Prompt）

```text
请优化 https://github.com/WonderChord/qq-bridge-agy 项目（仓库根目录已包含最新代码与 docs/CODEX_OPTIMIZATION_HANDOFF.md 交接文档）。
请先完整阅读 docs/CODEX_OPTIMIZATION_HANDOFF.md，严格保留文档第一节列出的 6 项已实装核心特性（单向记忆隔离、私聊按需巡回群记忆 recallGroupMemoryForPrivateV2、引用回复双键解析与 400 降级、表情夹 SHA-1 热重载与 supersededMd5s 过滤、无头 NapCat 环境变量透传、TTS 与主动冒泡），然后按文档第二节依次完成 P0~P3 四项优化任务：
1. P0：对 src/bridge.js（当前 1.4 万行）进行高内聚模块化拆分（抽离 WebUI 模板、分舱记忆与私聊巡回模块、AGY 调度器模块），保持对外接口与 CLI 100% 兼容；
2. P1：升级 recallGroupMemoryForPrivateV2，加入基于 mtimeMs 的内存缓存、从 summary.md/recentMessages 动态提取群友实体词典（移除硬编码人名列表）、支持时间衰减与多群来源标注；
3. P2：加固 AGY Worker 断线重连自愈（同一 workerId 重新挂起 wait-wake 时自动回收未发言的僵尸 activeTurn 与切片锁，并在 /api/agy/status 中补充健康度诊断字段）；
4. P3：在 scripts/test-agy-bridge.mjs 中为单向记忆挂载、私聊按需巡回、引用降级、Worker 重连自愈补齐回归测试，确保 npm test 全绿通过。
```
