// Codex 本地会话后台守护驱动器：零轮询监听 qq-bridge（前置路由已在网桥内完成），
// 事件到达时用 `codex exec` / `codex exec resume` 交由主对话线程处理，本地记忆归档另起独立一次性线程。
//
// 用法：
//   node scripts/codex-driver.mjs start   [--model gpt-6-astra] [--effort low] [--rotate 80]   隐藏后台启动（WMI，脱离调用终端）
//   node scripts/codex-driver.mjs start   --profile gemini-standard [--model gemini-4-carbon]
//   node scripts/codex-driver.mjs stop                                                         停止驱动器及其监听
//   node scripts/codex-driver.mjs status                                                       查看线程 / 轮次 / 用量
//   node scripts/codex-driver.mjs run     [...同 start 参数]                                    前台运行（调试用）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, loadConfig, readStudioRelay } from './bridge-local.mjs';
import { softenWakeText } from './agy-wait-wake.mjs';

const SCRIPTS = path.join(ROOT, 'scripts');
const STATE_FILE = path.join(ROOT, 'state', 'codex-driver.json');
const LOG_FILE = path.join(ROOT, 'state', 'codex-driver.log');
const ARCHIVIST_MD = path.join(ROOT, 'agy-plugin', 'agents', 'qq-memory-archivist.md');
const NODE = process.execPath;
const CHAT_TIMEOUT_MS = 480_000;
const IDLE_STREAM_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_INPUT = 320_000;
const MIN_CHAT_RETRY_MS = 12_000;
const ARCHIVE_TIMEOUT_MS = 600_000;
const REPLY_SCRIPT = /\bagy-reply-and-wait\.mjs\b/i;
const REPLY_ROUTE = /\/api\/(?:agy\/(?:claim|complete|finish-turn)|socialV2\/(?:send-[a-z-]+|codex-draw|mark-read|wake-config))\b/i;
const SAFETY_REFUSAL_RE = /^\s*(?:I cannot fulfill|I(?:'m| am) sorry,?\s+I can(?:not|'t)|I must decline|I cannot participate|Sorry,?\s+I can(?:not|'t) fulfill)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseOpts(argv) {
  const o = {
    model: '', profile: '', judgeModel: '',
    effort: 'low', archiveEffort: '', rotate: 80, maxInput: DEFAULT_MAX_INPUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--model' && v) { o.model = v; i += 1; }
    else if (a === '--profile') {
      if (!/^[\w-]+$/.test(v || '')) throw new Error('请为 --profile 提供有效的 Codex 配置名。');
      o.profile = v;
      i += 1;
    } else if (a === '--judge-model') {
      if (!/^gemini-[a-z0-9][a-z0-9.-]*$/.test(v || '')) throw new Error('请为 --judge-model 提供有效的 Gemini 模型名。');
      o.judgeModel = v;
      i += 1;
    } else if (a === '--effort' && v) { o.effort = v; i += 1; }
    else if (a === '--archive-effort' && v) { o.archiveEffort = v; i += 1; }
    else if (a === '--rotate' && v) { o.rotate = Math.max(1, Number(v) || 80); i += 1; }
    else if (a === '--max-input' && v) { o.maxInput = Math.max(50000, Number(v) || DEFAULT_MAX_INPUT); i += 1; }
    else if (a === '--reset-thread') { o.resetThread = true; }
  }
  if (o.profile === 'gemini-standard') {
    o.model ||= 'gemini-4-carbon';
    o.judgeModel ||= 'gemini-4-hydrogen';
  }
  o.model ||= 'gpt-6-astra';
  o.archiveEffort ||= o.profile === 'gemini-standard' ? 'low' : 'medium';
  return o;
}

async function verifyStudioModels({ profile, model }) {
  const expected = [profile === 'gemini-standard' ? model : ''].filter(Boolean);
  if (!expected.length) return;
  const { baseUrl, key } = readStudioRelay();
  let res;
  try {
    res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new Error('本地 Gemini 订阅反代未在线，请先启动本机反代服务。');
  }
  if (!res.ok) throw new Error(`订阅反代模型列表返回 HTTP ${res.status}。`);
  const { data } = await res.json();
  const available = new Set(data?.map(({ id }) => id));
  const missing = expected.filter((id) => !available.has(id));
  if (missing.length) throw new Error(`订阅反代的模型列表缺少 ${missing.join('、')}。`);
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch {}
  if (process.stdout.isTTY) process.stdout.write(line);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeState(patch) {
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch {}
  return next;
}

function findCodexExe() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase() === 'codex.exe') {
        const t = fs.statSync(p).mtimeMs;
        if (!best || t > best.t) best = { p, t };
      }
    }
  };
  walk(base, 0);
  if (!best) throw new Error(`codex.exe not found under ${base}`);
  return best.p;
}

function codexEnv() {
  const env = { ...process.env, QQ_BRIDGE_FORCE_NO_WAIT: '1', QQ_BRIDGE_HOST: 'codex' };
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_EXE']) delete env[k];
  return env;
}

// 关掉与 QQ 值守无关的常用 MCP / 插件，显著缩短每次唤醒的冷启动耗时。
const LEAN_FLAGS = [
  '-c', 'notify=[]',
  '-c', 'suppress_unstable_features_warning=true',
  '-c', 'mcp_servers.node_repl.enabled=false',
  '-c', 'mcp_servers.turboism.enabled=false',
  '-c', 'mcp_servers.blender.enabled=false',
  '-c', 'mcp_servers.chatcut_desktop.enabled=false',
  '-c', 'mcp_servers.voice_loom.enabled=false',
  '--disable', 'computer_use',
  '--disable', 'browser_use',
  '--disable', 'apps',
];

function runCodex({ threadId, prompt, model, effort, profile, ephemeral = false, label, timeoutMs = CHAT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const exe = findCodexExe();
    const common = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
      '-m', model, '-c', `model_reasoning_effort="${effort}"`, ...LEAN_FLAGS];
    if (ephemeral) common.push('--ephemeral');
    const args = threadId
      ? ['exec', 'resume', threadId, ...common, '-']
      : ['exec', '-C', ROOT, ...common, '-'];
    if (profile) args.unshift('--profile', profile);
    const t0 = Date.now();
    const child = spawn(exe, args, { cwd: ROOT, env: codexEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const result = {
      threadId: threadId || '', usage: null, lastMessage: '', commands: [],
      ok: false, contentBlocked: false, replyAttempted: false, replyCompleted: false,
    };
    let buf = '';
    let lastEvent = '';
    let lastEventMs = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('{')) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        lastEvent = [ev.type, ev.item?.type].filter(Boolean).join('/');
        lastEventMs = Date.now() - t0;
        if (ev.type === 'thread.started' && ev.thread_id) result.threadId = ev.thread_id;
        else if (ev.type === 'turn.completed') { result.usage = ev.usage || null; result.ok = true; }
        else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') result.lastMessage = String(ev.item.text || '');
        else if (ev.item?.type === 'command_execution') {
          const cmd = String(ev.item.command || '');
          const replyScript = REPLY_SCRIPT.test(cmd);
          if (replyScript || REPLY_ROUTE.test(cmd)) result.replyAttempted = true;
          if (ev.type === 'item.completed') {
            if (replyScript && ev.item.exit_code === 0) result.replyCompleted = true;
            result.commands.push({ cmd: cmd.slice(0, 300), exit: ev.item.exit_code });
          }
        }
        else if ((ev.type === 'error' || ev.type === 'turn.failed') &&
          /\bPROHIBITED_CONTENT\b/.test(ev.error?.message ?? ev.message ?? '')) {
          result.contentBlocked = true;
        }
      }
    });
    let errTail = '';
    child.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-2000); });
    let timedOutReason = '';
    const abortTree = (reason) => {
      if (timedOutReason) return;
      timedOutReason = reason;
      result.timedOut = true;
      log(`[${label}] ${reason}`, lastEvent ? `last event ${lastEvent} at ${lastEventMs}ms` : 'no events');
      killPid(child.pid);
    };
    const killer = setTimeout(() => abortTree(`hard timeout after ${timeoutMs}ms`), timeoutMs);
    const idleLimitMs = ephemeral ? Math.min(timeoutMs, 180_000) : Math.min(timeoutMs, IDLE_STREAM_TIMEOUT_MS);
    let idleKiller = setTimeout(() => abortTree(`stream stalled (idle > ${idleLimitMs}ms)`), idleLimitMs);
    const resetIdleKiller = () => {
      clearTimeout(idleKiller);
      idleKiller = setTimeout(() => abortTree(`stream stalled (idle > ${idleLimitMs}ms)`), idleLimitMs);
    };
    child.stdout.on('data', resetIdleKiller);
    child.stderr.on('data', resetIdleKiller);
    child.on('close', (code) => {
      clearTimeout(killer);
      clearTimeout(idleKiller);
      result.code = code;
      result.ms = Date.now() - t0;
      if (!result.ok && errTail) result.err = errTail.trim().slice(-500);
      log(`[${label}] codex ${threadId ? 'resume' : 'new'} done code=${code} ${result.ms}ms thread=${result.threadId}`,
        result.usage ? `in=${result.usage.input_tokens} cached=${result.usage.cached_input_tokens} out=${result.usage.output_tokens}` : '',
        !result.ok && result.contentBlocked ? 'upstream=PROHIBITED_CONTENT' : '',
        result.commands.map((c) => `\n    $ ${c.cmd} -> ${c.exit}`).join(''),
        result.err ? `\n    stderr: ${result.err}` : '');
      resolve(result);
    });
    child.stdin.end(prompt, 'utf8');
  });
}

function runListener(args, label) {
  return new Promise((resolve) => {
    const child = spawn(NODE, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (d) => { const s = d.toString('utf8').trim(); if (s) log(`[${label}] stderr: ${s.slice(0, 300)}`); });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function buildWorkerPreamble() {
  const cfg = loadConfig();
  const botName = cfg?.persona?.botName || 'Bot';
  const rootPosix = ROOT.replace(/\\/g, '/');
  return `你是 QQ 机器人 ${botName} 的聊天主线程 w1，运行在 Codex 中，由本机驱动器 codex-driver.mjs 托管。
之后每条用户消息都是一次 QQ 唤醒事件（=== QQ 唤醒事件 ...）。驱动器已负责全部监听，你只负责处理并调用回信脚本。

## 每次唤醒的做法
1. 按唤醒文本里注入的角色卡、分舱记忆与表情短 ID 清单进入角色；只回 messages 里的新消息（recent 只作语境）；收到【主动冒泡】时主动发 1 条不带 --reply 的短句/表情/语音。
2. 确实需要联网核实时，只用一次 node "${rootPosix}/scripts/agy-web-search.mjs" '可公开的关键词'。结果为空、报错或超时时，下一步就调用回信命令，用现有信息如实回答。
   对方明确让看图时先跑 node "${rootPosix}/scripts/agy-get-image.mjs" --key "<Key>" --token "<Token>" --msg "<msgId>" 落盘再查看图片；私聊追忆早期事件可查分舱目录下的 event_book.md 或跑 node "${rootPosix}/scripts/agy-recall-group.mjs" '<关键词>'。
3. 只调用 1 次回信命令（环境变量 QQ_BRIDGE_FORCE_NO_WAIT=1 已设置，命令发完立即返回），然后只回复 OK 结束本轮：
   node "${rootPosix}/scripts/agy-reply-and-wait.mjs" --worker-id w1 --max-turns 0 --priority 10 --finish-turn "<Turn>" --key "<Key>" --token "<Token>" --seq <readThroughSeq> --reply "<msgId>" '回复短句' --sticker "<短id>"
   - 带语音条：同命令加单条完整 --tts '[演技基调] 口语台词'（发外语语音时同命令须附带对应中文文本）
   - 同批回多人时，将 JSON 经标准输入传给 --batch-stdin，保留所有引号：
     $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@'
[{"reply":"<msgId1>","messages":["回第一人"]},{"reply":"<msgId2>","messages":["回第二人"]}]
'@ | node "${rootPosix}/scripts/agy-reply-and-wait.mjs" --worker-id w1 --max-turns 0 --priority 10 --finish-turn "<Turn>" --key "<Key>" --token "<Token>" --seq <readThroughSeq> --batch-stdin
   - 路过无关：--no-reply
   - 场景/状态变化：加 --memo '一句话当前状况'；创作者让画图：加 --codex-draw '{"prompt":"画面描述","selfRef":true}'；收藏表情：加 --collect-sticker '<msgId>::<含义>::<标签>'。

## 命令书写规则（Windows PowerShell）
- 文本参数、--tts、--memo 用单引号 '...' 包裹，内部单引号写成两个 ''。批量回信优先使用 --batch-stdin，here-string 的 @' 和 '@ 须顶格。
- 每轮唤醒都必须执行一次 agy-reply-and-wait.mjs 完成回信或 --no-reply 标已读，切勿只输出纯文本不调命令；监听进程由驱动器管理。

本条是线程初始化说明，下面紧跟第一条唤醒事件。`;
}

function readCurrentRoleCard() {
  try {
    const rsPath = path.join(ROOT, 'state', 'current-role.json');
    if (!fs.existsSync(rsPath)) return null;
    const rs = JSON.parse(fs.readFileSync(rsPath, 'utf8')) || {};
    if (!rs.role || rs.mode === 'silent') return null;
    const cardPath = path.join(ROOT, 'roles', `${rs.role}.md`);
    if (!fs.existsSync(cardPath)) return null;
    const content = fs.readFileSync(cardPath, 'utf8').trim();
    return content ? { name: rs.role, content } : null;
  } catch {
    return null;
  }
}

function archivistPrompt(taskText) {
  let rules = '';
  try {
    rules = fs.readFileSync(ARCHIVIST_MD, 'utf8')
      .replace(/^---[\s\S]*?---\s*/, '')
      .replaceAll('<QQ_BRIDGE_DIR>', ROOT);
  } catch {}
  return `${rules}

## 在 Codex 中的执行方式
- 根据本批消息确定需要更新的文件。用一次命令读取要编辑的摘要档及事件簿、当日日记的末尾。只有触发额度预警时才按需检索事件簿较早条目，核对迁移内容。
- 将所有需要的 UTF-8 写入及核验合在一次操作，保持原结构，核对写入结果和字数上限。归档重试时核对已有条目，避免重复追加。
- 写入中文优先使用 apply_patch。若用 Windows PowerShell 管道把文本传给 Python 或 Node，在管道前运行 $OutputEncoding = [System.Text.UTF8Encoding]::new($false)，读取标准输入及读写文件时都明确使用 UTF-8。写完重新读取核对新增中文，发现连续问号或替换字符时先恢复原文件。
- 完成核验后立即结束，末行输出 ARCHIVE_DONE:<JobId>。本批无须写入时也输出完成标记。完成确认由驱动器提交。

## 本次任务
${taskText.replace(/^node .*agy-wait-archive\.mjs" --done-id "[^"\r\n]+"\s*$/m, '')}`;
}

function chatFailure(result) {
  if (!result.ok) return result.contentBlocked ? 'PROHIBITED_CONTENT' : 'codex_failed';
  if (result.replyCompleted) return '';
  if (result.replyAttempted) return 'reply_unconfirmed';
  if (SAFETY_REFUSAL_RE.test(result.lastMessage)) return 'safety_refusal';
  return result.lastMessage.trim() ? 'reply_not_sent' : 'empty_reply';
}

function parseWakeMeta(out) {
  const turn = (/^Turn\s*:\s*(\S+)/m.exec(out) || [])[1] || '';
  const key = (/^会话 Key\s*:\s*(\S+)/m.exec(out) || [])[1] || '';
  return { turn, key, hasRoleCard: out.includes('【角色卡已热更新') };
}

function buildFreshRetryWake(out, meta, trimRecent = false) {
  let body = softenWakeText(out);
  if (trimRecent) {
    const marker = '【本次消息快照】\n';
    const snapIdx = body.indexOf(marker);
    if (snapIdx >= 0) {
      const lineStart = snapIdx + marker.length;
      const lineEnd = body.indexOf('\n', lineStart);
      try {
        const snap = JSON.parse(lineEnd >= 0 ? body.slice(lineStart, lineEnd) : body.slice(lineStart));
        if (Array.isArray(snap?.recent) && snap.recent.length > 2) snap.recent = snap.recent.slice(-2);
        body = body.slice(0, lineStart) + JSON.stringify(snap) + (lineEnd >= 0 ? body.slice(lineEnd) : '');
      } catch {}
    }
  }
  if (!meta.hasRoleCard) {
    const card = readCurrentRoleCard();
    if (card) body = `【角色卡已热更新：${card.name}（重连补挂）】\n${card.content}\n\n${body}`;
  }
  return `${buildWorkerPreamble()}\n\n${body}`;
}

async function w1Loop(opts) {
  const st = readState();
  const chat = { model: opts.model, effort: opts.effort, profile: opts.profile, label: 'w1' };
  let threadId = st.threadId || '';
  let turns = Number(st.turns) || 0;
  let lastInput = Number(st.lastTurnInputTokens ?? st.lastUsage?.input_tokens) || 0;
  let prevTotalInput = Number(st.totalInputTokens ?? st.lastUsage?.input_tokens) || 0;
  let freshListener = !threadId;
  let finishTurn = '';
  while (true) {
    if (threadId && (turns >= opts.rotate || lastInput >= opts.maxInput)) {
      log(`[w1] rotate thread ${threadId} after ${turns} turns (last turn input ${lastInput})`);
      writeState({ previousThreadId: threadId });
      threadId = '';
      turns = 0;
      lastInput = 0;
      prevTotalInput = 0;
      freshListener = true;
    }
    const args = [path.join(SCRIPTS, 'agy-wait-wake.mjs'), '--worker-id', 'w1', '--priority', '10'];
    if (!freshListener) args.push('--no-finish');
    if (finishTurn) args.push('--finish-turn', finishTurn);
    const { code, out } = await runListener(args, 'w1-wait');
    if (code !== 0 || !out.includes('=== QQ 唤醒')) {
      await sleep(2000);
      continue;
    }
    finishTurn = '';
    const meta = parseWakeMeta(out);
    const { turn, key } = meta;
    log(`[w1] wake ${key} ${turn}`);
    writeState({ lastWakeAt: new Date().toISOString(), lastWakeKey: key });
    const deadline = Date.now() + CHAT_TIMEOUT_MS;
    const prompt = threadId ? out : `${buildWorkerPreamble()}\n\n${out}`;
    let r = await runCodex({ ...chat, threadId, prompt });
    let lastTurnFailure = chatFailure(r);
    const remainingMs = deadline - Date.now();
    // 原桥接回合仍有效且尚未尝试发送时，用干净新线程补试一次。
    if (lastTurnFailure && turn && !r.replyAttempted && remainingMs >= MIN_CHAT_RETRY_MS) {
      const isSafety = lastTurnFailure === 'PROHIBITED_CONTENT' || lastTurnFailure === 'safety_refusal';
      log(`[w1] retry wake (${lastTurnFailure}) in a fresh thread`);
      r = await runCodex({ ...chat, threadId: '', prompt: buildFreshRetryWake(out, meta, isSafety), timeoutMs: remainingMs });
      lastTurnFailure = chatFailure(r);
    }
    const priorThreadId = threadId;
    if (!lastTurnFailure) {
      if (r.threadId && r.threadId !== threadId) {
        threadId = r.threadId;
        turns = 0;
        lastInput = 0;
        prevTotalInput = 0;
      }
      turns += 1;
      const rawTotalIn = Number(r.usage?.input_tokens) || 0;
      const deltaIn = rawTotalIn > prevTotalInput ? (rawTotalIn - prevTotalInput) : rawTotalIn;
      if (rawTotalIn > 0) prevTotalInput = rawTotalIn;
      lastInput = deltaIn;
    } else {
      log(`[w1] turn failed (${lastTurnFailure}); next wake starts a fresh thread`);
      threadId = '';
      turns = 0;
      lastInput = 0;
      prevTotalInput = 0;
    }
    freshListener = !threadId;
    if (turn && !r.replyCompleted) finishTurn = turn;
    writeState({
      ...(lastTurnFailure && priorThreadId ? { previousThreadId: priorThreadId } : {}),
      threadId, turns, totalInputTokens: prevTotalInput, lastTurnInputTokens: lastInput,
      lastUsage: r.usage, lastReplyMs: r.ms, lastReplied: r.replyCompleted, lastTurnFailure,
      model: opts.model, effort: opts.effort,
    });
  }
}

function readArchiveFiles(comp) {
  const dir = path.resolve(ROOT, comp.dir);
  const diaryDir = path.join(dir, 'diary');
  const names = [comp.summaryFile || 'summary.md', comp.peopleFile || 'people.md',
    comp.intimateFile || 'ledger.md', comp.eventBookFile || 'event_book.md'];
  const files = names.map((name) => path.join(dir, name));
  try {
    for (const entry of fs.readdirSync(diaryDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(diaryDir, entry.name));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const contents = new Map();
  for (const file of files) {
    try { contents.set(file, fs.readFileSync(file)); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return contents;
}

function archiveEncodingDamage(bytes) {
  if (!bytes) return 0;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return (text.match(/\uFFFD|\?{8,}/g) || []).join('').length;
  } catch { return Infinity; }
}

function verifyArchiveFiles(jobId, comp, before) {
  let savedDir;
  for (const [file, bytes] of readArchiveFiles(comp)) {
    const original = before.get(file);
    if (original?.equals(bytes)) continue;
    const damage = archiveEncodingDamage(bytes);
    if (Number.isFinite(damage) && damage <= archiveEncodingDamage(original)) continue;

    savedDir ||= fs.mkdtempSync(path.join(ROOT, 'state', `${jobId}-damaged-`));
    fs.writeFileSync(path.join(savedDir, path.basename(file)), bytes, { flag: 'wx' });
    if (!fs.readFileSync(file).equals(bytes)) throw new Error('归档文件在恢复前已变更');
    if (original) {
      const temporary = path.join(savedDir, `${path.basename(file)}.restore`);
      fs.writeFileSync(temporary, original, { flag: 'wx' });
      fs.renameSync(temporary, file);
    } else {
      fs.unlinkSync(file);
    }
    log(`[archive] ${jobId} encoding damage reverted`, path.basename(file));
  }
  return !savedDir;
}

async function archiveLoop(opts) {
  let doneId = '';
  while (true) {
    const args = [path.join(SCRIPTS, 'agy-wait-archive.mjs')];
    if (doneId) args.push('--done-id', doneId);
    const { out } = await runListener(args, 'archive');
    doneId = '';
    const m = /JobId\s*:\s*(\S+)/.exec(out);
    if (!m) { await sleep(2000); continue; }
    const jobId = m[1];
    log(`[archive] job ${jobId}`);
    const key = /^会话 Key\s*:\s*(\S+)/m.exec(out)?.[1];
    let comp, before;
    try {
      comp = loadConfig().persona?.memoryCompartments?.[key];
      if (!comp?.dir) throw new Error('归档任务缺少记忆目录');
      before = readArchiveFiles(comp);
    } catch {
      log(`[archive] ${jobId} memory snapshot failed`);
      writeState({ lastArchive: { jobId, at: new Date().toISOString(), ok: false, ms: 0 } });
      continue;
    }
    const r = await runCodex({
      threadId: '', prompt: archivistPrompt(out), model: opts.model, effort: opts.archiveEffort,
      profile: opts.profile, ephemeral: true, label: `archive ${jobId}`, timeoutMs: ARCHIVE_TIMEOUT_MS,
    });
    let verified = false;
    try { verified = verifyArchiveFiles(jobId, comp, before); }
    catch { log(`[archive] ${jobId} memory verification failed`); }
    const confirmed = verified && r.ok && r.lastMessage.split(/\r?\n/).some((line) => line.trim() === `ARCHIVE_DONE:${jobId}`);
    log(`[archive] ${jobId} ${confirmed ? 'completed' : 'failed or missing completion marker'}`);
    writeState({ lastArchive: { jobId, at: new Date().toISOString(), ok: confirmed, ms: r.ms } });
    if (confirmed) doneId = jobId;
  }
}

function psJson(cmd) {
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (!raw.trim()) return [];
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [j];
  } catch { return []; }
}

function listNodeProcs() {
  return psJson("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress");
}

function killPid(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
}

function cleanupOthers(selfPid) {
  for (const p of listNodeProcs()) {
    const cmd = String(p.CommandLine || '');
    if (Number(p.ProcessId) === selfPid || Number(p.ParentProcessId) === selfPid) continue;
    if (/codex-driver\.mjs"?\s+run/.test(cmd) || /agy-wait-(wake|judge|archive)|agy-reply-and-wait/.test(cmd)) {
      log(`[cleanup] stop PID ${p.ProcessId}: ${cmd.slice(0, 120)}`);
      killPid(p.ProcessId);
    }
  }
}

function ensureDaemons() {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'ensure-daemons.ps1')],
      { stdio: 'pipe', windowsHide: true, timeout: 120000 });
    log('[start] ensure-daemons ok');
  } catch (e) {
    log(`[start] ensure-daemons warning: ${String(e?.message || e).slice(0, 200)}`);
  }
}

async function cmdRun(opts) {
  await verifyStudioModels(opts);
  const prev = readState();
  const changedModel = prev.model && prev.model !== opts.model;
  const changedProfile = (prev.profile || '') !== opts.profile;
  const reset = (changedModel || changedProfile || opts.resetThread) ? {
    previousThreadId: prev.threadId || prev.previousThreadId || '',
    threadId: '', turns: 0, totalInputTokens: 0, lastTurnInputTokens: 0,
    lastUsage: null, lastReplyMs: null, lastReplied: null, lastTurnFailure: '',
  } : {};
  writeState({
    ...reset, pid: process.pid, startedAt: new Date().toISOString(), model: opts.model,
    profile: opts.profile, judgeModel: opts.judgeModel, effort: opts.effort, rotate: opts.rotate,
    maxInput: opts.maxInput, archiveEffort: opts.archiveEffort, archiveTimeoutMs: ARCHIVE_TIMEOUT_MS,
  });
  log(`[run] driver PID ${process.pid} model=${opts.model} profile=${opts.profile || 'default'}`);
  cleanupOthers(process.pid);
  ensureDaemons();
  await Promise.all([w1Loop(opts), archiveLoop(opts)]);
}

function driverAlive() {
  const st = readState();
  if (!st.pid) return null;
  const hit = listNodeProcs().find((p) => Number(p.ProcessId) === Number(st.pid) && /codex-driver\.mjs/.test(String(p.CommandLine)));
  return hit ? st : null;
}

async function cmdStart(argv) {
  await verifyStudioModels(parseOpts(argv));
  const old = driverAlive();
  if (old) { log(`[start] stopping previous driver PID ${old.pid}`); killPid(old.pid); }
  const me = path.join(SCRIPTS, 'codex-driver.mjs');
  const extra = argv.map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ');
  const cmdLine = `"${NODE}" "${me}" run ${extra}`.trim();
  // WMI 创建的进程脱离调用终端（Codex 沙箱 / 窗口关闭都不影响）。
  const ps = `$si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly; ` +
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}'; CurrentDirectory = '${ROOT.replace(/'/g, "''")}'; ProcessStartupInformation = $si }; ` +
    `Write-Output $r.ProcessId`;
  const pid = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
  console.log(`Codex 守护驱动器已后台启动 PID ${pid}，日志 ${LOG_FILE.replace(/\\/g, '/')}`);
  await sleep(4000);
  cmdStatus();
}

function cmdStop() {
  const st = driverAlive();
  if (st) { killPid(st.pid); console.log(`已停止 Codex 守护驱动器 PID ${st.pid}`); }
  else console.log('Codex 守护驱动器未在运行');
  for (const p of listNodeProcs()) {
    if (/agy-wait-(wake|judge|archive)/.test(String(p.CommandLine || '')) && Number(p.ParentProcessId) === Number(st?.pid)) killPid(p.ProcessId);
  }
}

function cmdStatus() {
  const st = readState();
  const alive = driverAlive();
  console.log(`驱动器      : ${alive ? `RUNNING PID ${st.pid}` : 'STOPPED'}`);
  console.log(`回复与归档  : ${st.model || '-'} (聊天 effort ${st.effort || '-'})，满 ${st.rotate || '-'} 轮换新线程`);
  if (st.archiveEffort) console.log('归档强度    : ' + st.archiveEffort);
  if (st.maxInput) console.log('输入轮换阈值: ' + st.maxInput + ' token');
  console.log(`Codex 配置  : ${st.profile || '默认'}`);
  console.log('前置路由    : 由 qq-bridge 本地脚本层直接执行 (.env ROUTER_MODEL)');
  console.log(`w1 Codex 线程: ${st.threadId || '(首个唤醒时创建)'} | 已聊 ${st.turns ?? 0} 轮${st.lastTurnInputTokens ? ` | 上一轮输入 ${st.lastTurnInputTokens} token` : ''}`);
  if (st.lastUsage) console.log(`最近一轮    : ${st.lastReplyMs}ms | 线程累计 in ${st.lastUsage.input_tokens} (cached ${st.lastUsage.cached_input_tokens}) out ${st.lastUsage.output_tokens} | 已回信=${st.lastReplied}${st.lastTurnFailure ? ` (${st.lastTurnFailure})` : ''}`);
  if (st.lastArchive) console.log(`最近归档    : ${st.lastArchive.jobId} ok=${st.lastArchive.ok} ${st.lastArchive.at}`);
  if (st.archiveTimeoutMs) console.log(`归档时限    : ${st.archiveTimeoutMs / 1000} 秒`);
  if (st.threadId) {
    const profileArg = st.profile ? ` --profile ${st.profile}` : '';
    console.log(`在 Codex 中查看该线程：codex${profileArg} resume ${st.threadId}`);
  }
}

const [cmd = 'status', ...rest] = process.argv.slice(2);
if (cmd === 'run') cmdRun(parseOpts(rest)).catch((e) => { log(`[run] fatal ${e?.stack || e}`); process.exit(1); });
else if (cmd === 'start') cmdStart(rest).catch((e) => { console.error(e?.message || e); process.exit(1); });
else if (cmd === 'stop') cmdStop();
else cmdStatus();
