// Antigravity 多线程极速合一脚本：一步完成「单发或批量多目标并发回信 + 发表情 + 标已读 + 释放当前线程并重回监听池」。
//
// 用法示例（run_command + WaitMsBeforeAsync: 1000，调用后立刻结束当前回合）：
//   1) 单目标快速回信（群聊默认带 --reply 防串行）：
//      node scripts/agy-reply-and-wait.mjs --worker-id w2 --finish-turn "agy-turn-12" --key "group:123456789" --token "<token>" --seq 240 --reply "101" "来啦"
//   2) 一轮同时回复多个群友（--batch JSON 数组，按顺序高速连发不同引用/点名）：
//      node scripts/agy-reply-and-wait.mjs --worker-id w2 --finish-turn "agy-turn-12" --key "group:123456789" --token "<token>" --seq 245 --batch "[{\"reply\":\"101\",\"messages\":[\"第一人回复\"]},{\"reply\":\"102\",\"messages\":[\"第二人回复\"]}]"

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken, sessionToken } from './bridge-local.mjs';
import { splitDrama3TextForTts, ensureJapaneseTtsText } from '../src/tts.js';


function parseArgs(argv) {
  const opts = {
    workerId: 'primary',
    priority: '',
    finishTurn: '',
    maxTurns: null,
    key: '',
    token: '',
    seq: null,
    reply: null,
    at: null,
    sticker: null,
    image: null,
    tts: null,
    ttsList: [],
    ttsProvider: null,
    ttsRef: null,
    codexDraws: [],
    collectStickers: [],
    batch: null,
    mode: null,
    sleepMs: null,
    noWait: false,
    noReply: false,
    memo: null,
    messages: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--worker-id' && i + 1 < argv.length) opts.workerId = String(argv[++i]).trim() || 'primary';
    else if (a === '--priority' && i + 1 < argv.length) opts.priority = String(argv[++i]).trim();
    else if (a === '--finish-turn' && i + 1 < argv.length) opts.finishTurn = String(argv[++i]).trim();
    else if (a === '--max-turns' && i + 1 < argv.length) opts.maxTurns = Number(argv[++i]);
    else if (a === '--key' && i + 1 < argv.length) opts.key = argv[++i];
    else if (a === '--token' && i + 1 < argv.length) opts.token = argv[++i];
    else if (a === '--seq' && i + 1 < argv.length) opts.seq = Number(argv[++i]);
    else if (a === '--reply' && i + 1 < argv.length) opts.reply = argv[++i];
    else if (a === '--at' && i + 1 < argv.length) opts.at = argv[++i];
    else if (a === '--sticker' && i + 1 < argv.length) opts.sticker = argv[++i];
    else if (a === '--image' && i + 1 < argv.length) opts.image = argv[++i];
    else if ((a === '--tts' || a === '--voice') && i + 1 < argv.length) {
      const tVal = String(argv[++i]).trim();
      if (tVal) {
        opts.tts = tVal;
        opts.ttsList.push(tVal);
      }
    }
    else if (a === '--tts-provider' && i + 1 < argv.length) opts.ttsProvider = String(argv[++i]).trim();
    else if (a === '--tts-ref' && i + 1 < argv.length) opts.ttsRef = String(argv[++i]).trim();
    else if ((a === '--memo' || a === '--state' || a === '--sitrep') && i + 1 < argv.length) {
      let memoArg = String(argv[++i]).trim();
      while (i + 1 < argv.length && !/^--[a-z]/i.test(argv[i + 1]) && opts.messages.length > 0) {
        memoArg += ' ' + String(argv[++i]).trim();
      }
      opts.memo = memoArg;
    }
    else if (a === '--codex-draw' && i + 1 < argv.length) {
      let drawArg = String(argv[++i]);
      if (drawArg.trim().startsWith('{') && !drawArg.trim().endsWith('}')) {
        while (i + 1 < argv.length && !/^--[a-z]/i.test(argv[i + 1])) {
          const piece = String(argv[++i]);
          drawArg += ' ' + piece;
          if (piece.trim().endsWith('}')) break;
        }
      }
      opts.codexDraws.push(drawArg);
    }
    else if (a === '--collect-sticker' && i + 1 < argv.length) opts.collectStickers.push(String(argv[++i]));
    else if (a === '--batch' && i + 1 < argv.length) opts.batch = argv[++i];
    else if (a === '--batch-stdin') opts.batchStdin = true;
    else if (a === '--mode' && i + 1 < argv.length) opts.mode = argv[++i];
    else if (a === '--sleep-ms' && i + 1 < argv.length) opts.sleepMs = Number(argv[++i]);
    else if (a === '--no-wait') opts.noWait = true;
    else if (a === '--no-reply' || a === '--silent' || a === '--skip' || a === '--mark-read') opts.noReply = true;
    else if (/^--[a-z]/i.test(a)) {
      // 严禁把模型臆造的未知 CLI flag（如 --quiet 等）当作聊天文本发进 QQ 群！
      throw new Error('未知或缺值的参数：' + a);
    }
    else opts.messages.push(a);
  }
  // 外部后台驱动器托管时由驱动器负责监听，回信后立即返回。
  if (process.env.QQ_BRIDGE_FORCE_NO_WAIT === '1') opts.noWait = true;
  if (opts.noReply) {
    opts.messages = [];
    opts.batch = null;
    opts.batchStdin = false;
    opts.sticker = null;
    opts.image = null;
    opts.tts = null;
    opts.ttsList = [];
    opts.codexDraws = [];
    opts.collectStickers = [];
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postBridge(port, consoleToken, agentToken, route, body) {
  const headers = { 'content-type': 'application/json' };
  if (consoleToken) headers['x-console-token'] = consoleToken;
  if (agentToken) headers['x-agent-token'] = agentToken;
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(route === '/api/socialV2/send-tts' ? 150000 : 20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw Object.assign(new Error(`${route} failed (${res.status}): ${data?.error || JSON.stringify(data)}`), { status: res.status });
  }
  return data;
}

async function sendWorkerText(port, consoleToken, token, payload) {
  const send = (body) => postBridge(port, consoleToken, token, '/api/socialV2/send-message', body);
  try {
    return await send(payload);
  } catch (err) {
    if (!payload.replyToMessageId || err.status !== 400 || !/无法解析被引用消息|replyToMessageId 必须是非零整数/.test(err.message)) throw err;
    const { replyToMessageId, ...plain } = payload;
    return send(plain);
  }
}

const POINT_TAGS_RE = /^\[(?:laughs|laughing|small laugh|chuckling|giggle|giggles|sigh|sighs|sighing|shaky breath|breath|gasp|gasps|gasping|panting|yawn|yawning|groan|groaning|clears throat|clear throat|sob|sobbing|short pause|long pause|pause|break|long-break)\]$/i;

function countSpokenChars(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\s。、，,；;：:！？!?….\-—～~♪♥♡☆「」『』（）()【】]+/g, '')
    .length;
}

function endsWithComma(text) {
  const s = String(text || '')
    .replace(/<\/?[a-zA-Z]+>/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
  return /[、，,；;：:]$/.test(s);
}

function extractLeadingActingDir(text) {
  const m = /^\s*(\[[^\]]+\])\s*([\s\S]*)$/.exec(String(text || '').trim());
  if (m && !POINT_TAGS_RE.test(m[1].trim())) {
    return { dir: m[1].trim(), rest: m[2].trim() };
  }
  return { dir: '', rest: String(text || '').trim() };
}

export function splitLongDrama3Text(rawText, maxSpokenChars = 150) {
  return splitDrama3TextForTts(rawText, maxSpokenChars);
}

function expandTtsSegments(rawInput) {
  const rawList = (Array.isArray(rawInput) ? rawInput : (rawInput ? [rawInput] : []))
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (rawList.length === 0) return [];

  // 默认把同一轮的多句情话无缝合成单条连贯语音（总发音字数 <= 140 时自动合并，省去重复演技前缀字节并保持情绪不断气）
  const coalesced = [];
  for (const item of rawList) {
    const jpCheck = ensureJapaneseTtsText(item);
    if (!jpCheck.ok) {
      console.error(`[agy-reply-and-wait] 已拦截非日语 --tts 段 (${jpCheck.reason}): ${String(item).slice(0, 60)}`);
      continue;
    }
    const { dir, rest } = extractLeadingActingDir(jpCheck.text);
    if (coalesced.length === 0) {
      coalesced.push(dir ? `${dir} ${rest}` : rest);
      continue;
    }
    const prev = coalesced[coalesced.length - 1];
    const prevLen = countSpokenChars(prev);
    const curLen = countSpokenChars(rest);
    if (endsWithComma(prev) || prevLen + curLen <= 140 || prevLen < 20 || curLen < 20) {
      coalesced[coalesced.length - 1] = `${prev} ${rest}`.replace(/\s+/g, ' ').trim();
    } else {
      coalesced.push(dir ? `${dir} ${rest}` : rest);
    }
  }

  // 单条长情话保持整条不断开（仅超过 150 发音字的超长独白才按完整句末自然切分）
  const out = [];
  for (const item of coalesced) {
    for (const seg of splitLongDrama3Text(item, 150)) {
      if (!seg) continue;
      out.push(seg.trim());
    }
  }
  return out;
}

function inferUnifiedTtsRef(segments, explicitRef, key) {
  if (explicitRef) return String(explicitRef).trim();
  const joined = (Array.isArray(segments) ? segments : []).join(' ');
  if (/<stress>|<forceful>|\[(?:indignant|disdainful|angry|annoyed|frustrated|sarcastic)\]|恥知らず|無礼|不届き|生意気|ふん|むっ|もう！|バカ|いじわる|怒|からかって/i.test(joined)) {
    return '02_tsukkomi';
  }
  if (/ひゃあっ|きゃあっ|あぁっ|イく|イっちゃ|気持ちよすぎ|壊れちゃ|もうダメ|限界/i.test(joined)) {
    return '04_shy_flustered';
  }
  if (/<fast>|\[(?:smug|guilty|panicked|nervous)\]|くふふ|ふふっ|えへへ|ヤッホー|おはよ|お疲れ|クール|低い声/i.test(joined)) {
    return '05_happy_clingy';
  }
  if (/<whisper>|おやすみ|眠|二度寝|とろけ|んちゅ|ちゅっ|にゃあ/i.test(joined)) {
    return '03_nadenade';
  }
  return '01_default';
}

const ERPLAY_RE = /『[^』]+』|（[^）]{8,}）/;
const ERPLAY_STATE_FILE = path.join(ROOT, 'state', 'agy-worker-erplay.json');
const ERPLAY_TTL_MS = 45 * 60 * 1000;
const SITUATION_MEMO_FILE = path.join(ROOT, 'state', 'agy-situation-memo.json');
const SITUATION_MEMO_TTL_MS = 6 * 3600 * 1000; // 6小时内有效，跨换新线程无缝交接当前状况
const WORKER_CURSOR_FILE = path.join(ROOT, 'state', 'agy-worker-cursor.json');

function readWorkerCursor(workerId, reset = false) {
  const wid = String(workerId || 'w1');
  if (reset) return { wid, all: {}, cur: { lastKey: '', seenSeq: {} } };
  try {
    if (fs.existsSync(WORKER_CURSOR_FILE)) {
      const all = JSON.parse(fs.readFileSync(WORKER_CURSOR_FILE, 'utf8')) || {};
      const cur = all[wid] || { lastKey: '', seenSeq: {} };
      return { wid, all, cur: { lastKey: cur.lastKey || '', seenSeq: { ...(cur.seenSeq || {}) } } };
    }
  } catch {}
  return { wid, all: {}, cur: { lastKey: '', seenSeq: {} } };
}

function saveWorkerCursor(wid, all, cur) {
  try {
    all[wid] = { ...cur, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(WORKER_CURSOR_FILE), { recursive: true });
    fs.writeFileSync(WORKER_CURSOR_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch {}
}

function sliceRecentKeepingTextAnchors(items, minTextAnchors, maxTotal) {
  if (items.length <= minTextAnchors) return items;
  let textCount = 0;
  let startIdx = items.length;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    startIdx = i;
    const txt = String(items[i]?.text || items[i]?.plain || '').trim();
    if (!/^\[(?:语音|图片|动画表情)/.test(txt)) textCount += 1;
    if (textCount >= minTextAnchors || (items.length - startIdx) >= maxTotal) break;
  }
  return items.slice(startIdx);
}

function normalizeMemoKey(key) {
  const k = String(key || '').trim();
  if (!k.startsWith('private:')) return k;
  try {
    const cfg = loadConfig();
    const uids = new Set([
      ...(Array.isArray(cfg.persona?.creatorUids) ? cfg.persona.creatorUids.map(String) : []),
      ...(cfg.ownerQQ ? [String(cfg.ownerQQ)] : []),
    ]);
    if (uids.has(k.slice(8))) return 'private:creator';
  } catch {}
  return k;
}

function readSituationMemoMap() {
  try {
    if (fs.existsSync(SITUATION_MEMO_FILE)) {
      return JSON.parse(fs.readFileSync(SITUATION_MEMO_FILE, 'utf8')) || {};
    }
  } catch {}
  return {};
}

function writeSituationMemoMap(map) {
  try {
    fs.mkdirSync(path.dirname(SITUATION_MEMO_FILE), { recursive: true });
    fs.writeFileSync(SITUATION_MEMO_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch {}
}

function deriveAutoSituationFromText(text) {
  const s = softenWakeText(String(text || '').trim());
  if (!s) return null;
  let posture = '';
  let mood = '';
  if (/被窝|回床|床上|躺/.test(s)) posture = '休息/卧谈中';
  else if (/电脑桌|电脑椅|陪工/.test(s)) posture = '书桌前陪伴中';
  if (/晚安|入睡|睡觉/.test(s)) mood = '准备休息';
  else if (ERPLAY_RE.test(s)) mood = '沉浸角色扮演互动中';
  const actionMatch = /（([^）]{4,48})）/.exec(s);
  const briefAction = actionMatch ? actionMatch[1].replace(/\s+/g, ' ').trim() : '';
  return { posture, clothing: '', mood, briefAction };
}

function updateSituationMemo(opts) {
  const mKey = normalizeMemoKey(opts.key);
  if (!mKey) return;
  const map = readSituationMemoMap();
  const prev = map[mKey] || {};
  const now = Date.now();
  const isFresh = prev.updatedAtMs && (now - prev.updatedAtMs) < SITUATION_MEMO_TTL_MS;
  const base = isFresh ? { ...prev } : { key: mKey };

  const rawReply = [
    ...(opts.messages || []),
    ...(opts.batch ? [String(opts.batch)] : []),
  ].join(' ').trim();

  if (opts.memo) {
    base.manualMemo = softenWakeText(String(opts.memo).trim()).slice(0, 220);
  }
  if (rawReply) {
    const auto = deriveAutoSituationFromText(rawReply);
    if (auto) {
      if (auto.posture) base.posture = auto.posture;
      if (auto.clothing) base.clothing = auto.clothing;
      if (auto.mood) base.mood = auto.mood;
      if (auto.briefAction) base.lastAction = auto.briefAction;
    }
    const cleanReply = softenWakeText(rawReply)
      .replace(/（[^）]{25,}）/g, (m) => `${m.slice(0, 24)}…）`)
      .slice(0, 110);
    const recentTurns = Array.isArray(base.recentTurns) ? base.recentTurns.slice(-2) : [];
    recentTurns.push({
      at: new Date(now).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      reply: cleanReply,
      hasTts: Boolean(opts.tts || (opts.ttsList && opts.ttsList.length > 0)),
    });
    base.recentTurns = recentTurns;
  }
  base.updatedAtMs = now;
  base.updatedAt = new Date(now).toLocaleString('zh-CN', { hour12: false });
  base.workerId = opts.workerId || 'w1';
  map[mKey] = base;
  writeSituationMemoMap(map);
}

function formatSituationMemoBanner(key, allRecent = []) {
  const mKey = normalizeMemoKey(key);
  if (!mKey) return '';
  const map = readSituationMemoMap();
  const entry = map[mKey];
  const now = Date.now();
  const hasSaved = entry && entry.updatedAtMs && (now - entry.updatedAtMs) < SITUATION_MEMO_TTL_MS;

  // 若还没有存盘摘要或刚重启，自动从最近 6 条消息实时提炼一份当前状况！
  let posture = hasSaved ? (entry.posture || '') : '';
  let clothing = hasSaved ? (entry.clothing || '') : '';
  let mood = hasSaved ? (entry.mood || '') : '';
  let lastAction = hasSaved ? (entry.lastAction || '') : '';
  const manualMemo = hasSaved ? (entry.manualMemo || '') : '';

  if ((!posture || !mood) && Array.isArray(allRecent) && allRecent.length > 0) {
    for (const m of allRecent.slice(-6)) {
      const auto = deriveAutoSituationFromText(m?.text || m?.plain || '');
      if (!auto) continue;
      if (auto.posture) posture = auto.posture;
      if (auto.clothing) clothing = auto.clothing;
      if (auto.mood) mood = auto.mood;
      if (auto.briefAction && m?.isSelf) lastAction = auto.briefAction;
    }
  }

  const lines = [];
  if (manualMemo) lines.push(`- 交接备忘：${manualMemo}`);
  const stateParts = [
    posture ? `场景/体位：${posture}` : '',
    clothing ? `穿搭：${clothing}` : '',
    mood ? `当前状态与节奏：${mood}` : '',
    lastAction ? `上一拍动作：${lastAction}` : '',
  ].filter(Boolean);
  if (stateParts.length > 0) {
    lines.push(`- 现场态势：${stateParts.join(' ｜ ')}`);
  }
  if (hasSaved && Array.isArray(entry.recentTurns) && entry.recentTurns.length > 0) {
    const trail = entry.recentTurns
      .map((t) => `[${t.at}${t.hasTts ? '+语音' : ''}] ${t.reply}`)
      .join(' → ');
    lines.push(`- 刚刚连贯轨迹：${trail}`);
  }
  if (lines.length === 0) return '';
  return `【短期情境交接卡（跨线程换新无缝衔接当前状况，请顺着此现场态势自然接话，可用 --memo "一句话新状况" 更新）】\n${lines.join('\n')}\n`;
}

// 兼容清理：剥离旧记忆或历史习惯残留的 #...# 标签外壳，不再将标签强制替换为固定死板的套话词组。
const LEGACY_TEXT_TAG_CLEANUP = [
  [/#s_[a-z_]+#/gi, ''],
  [/#([a-zA-Z0-9_\u4e00-\u9fa5]{1,12})#/g, '$1'],
];

const LEGACY_TTS_TAG_CLEANUP = [
  [/#s_[a-z_]+#/gi, ''],
  [/#[a-zA-Z0-9_\u4e00-\u9fa5]{1,16}#/g, ''],
];

function decodeOutboundText(raw) {
  let out = String(raw || '');
  for (const [re, rep] of LEGACY_TEXT_TAG_CLEANUP) out = out.replace(re, rep);
  return out;
}

function decodeOutboundTts(raw) {
  let out = String(raw || '');
  for (const [re, rep] of LEGACY_TTS_TAG_CLEANUP) out = out.replace(re, rep);
  return out;
}

// 默认原样透传消息文本（仅清理残留的 #s_...# 音效占位标签）。
function softenWakeText(raw) {
  return String(raw || '').replace(/#s_[a-z_]+#/gi, '');
}

function compactRecentMessageText(raw, isSelf, isIntimateMode) {
  const s = softenWakeText(String(raw || '').trim());
  if (!isIntimateMode) return s.slice(0, 260);
  // 完整保留近期回合的（）双向动作细节与『』直白/纯爱台词，不断档不阉割语感
  return s.slice(0, isSelf ? 380 : 300);
}

async function enrichWakeTextWithHistory(port, consoleToken, w, isFirstTurnDefault = false, isErplay = false) {
  const rawText = String(w?.text || '');
  const key = String(w?.key || '');
  if (!key || !rawText.includes('【本次消息快照】')) return rawText;
  const wid = String(w?.workerId || 'w1');
  const isFirstTurn = isFirstTurnDefault || Number(w?.workerTurnIndex) <= 1;
  const { all: cursorAll, cur: cursor } = readWorkerCursor(wid, isFirstTurn);
  const prevSeenSeq = Number(cursor.seenSeq?.[key]) || 0;
  const switchedKey = Boolean(cursor.lastKey && cursor.lastKey !== key);
  const isSessionFirstLoad = isFirstTurn || !prevSeenSeq || /【角色卡已热更新|【本群日常常驻记忆|【本会话分舱长期记忆/.test(rawText);
  const isPrivate = key.startsWith('private:');
  const isIntimate = isPrivate && (isErplay || ERPLAY_RE.test(rawText));
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=70`,
      {
        headers: consoleToken ? { 'x-console-token': consoleToken } : {},
        signal: AbortSignal.timeout(4000),
      }
    );
    if (!res.ok) return rawText;
    const data = await res.json();
    const allRecent = Array.isArray(data?.messages) ? data.messages : [];
    const marker = '【本次消息快照】\n';
    const snapIdx = rawText.indexOf(marker);
    if (snapIdx < 0) return rawText;
    const jsonStart = snapIdx + marker.length;
    const jsonEnd = rawText.indexOf('\n', jsonStart);
    const jsonLine = jsonEnd >= 0 ? rawText.slice(jsonStart, jsonEnd) : rawText.slice(jsonStart);
    const packet = JSON.parse(jsonLine);
    const recentHasErplay = isIntimate || allRecent.slice(-8).some((m) => ERPLAY_RE.test(String(m?.text || m?.plain || '')));
    if (Array.isArray(packet.messages)) {
      packet.messages = packet.messages.map((m) => ({
        ...m,
        ...(m?.text ? { text: softenWakeText(m.text) } : {}),
      }));
    }
    const unreadSeqs = new Set((packet.messages || []).map((m) => m?.seq).filter(Number.isSafeInteger));
    const filteredRecent = allRecent.filter(
      (m) => m && (!Number.isSafeInteger(m.seq) || !unreadSeqs.has(m.seq)) && !(m.isSelf && /^\[语音/.test(String(m.text || m.plain || '')))
    );
    let selectedRecent;
    if (isSessionFirstLoad) {
      selectedRecent = filteredRecent.slice(-(isIntimate ? 10 : (isPrivate ? 14 : 12)));
    } else if (isPrivate) {
      // 连续私聊：排除纯[语音]/[图片]占位影响，保底留 2 条真实文字锚点（防双气泡或语音顶掉）；从群聊切回私聊时留 4 条 + 态势卡防断片
      selectedRecent = sliceRecentKeepingTextAnchors(filteredRecent, switchedKey ? 4 : 2, switchedKey ? 6 : 4);
    } else {
      // 群聊潜水期间可能有未唤醒的新消息：按 prevSeenSeq 增量补齐潜水期漏看的上下文（最多 12 条），连发抢答时则只带 2~4 条，绝不丢群聊上文也不重复灌水
      const unseenDelta = filteredRecent.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > prevSeenSeq).length;
      const groupKeep = Math.min(12, Math.max(switchedKey ? 4 : 2, unseenDelta));
      selectedRecent = sliceRecentKeepingTextAnchors(filteredRecent, groupKeep, 12);
    }
    packet.recent = selectedRecent.map((m) => ({
      ...(m.seq != null ? { seq: m.seq } : {}),
      ...(m.messageId ? { messageId: String(m.messageId) } : {}),
      sender: m.isSelf ? '我' : String(m.sender || ''),
      ...(m.userId && !m.isSelf ? { userId: String(m.userId) } : {}),
      text: compactRecentMessageText(m.text || m.plain || '', Boolean(m.isSelf), recentHasErplay),
      ...(m.isSelf ? { isSelf: true } : {}),
    }));
    let maxSeq = Math.max(prevSeenSeq, Number(packet.readThroughSeq) || 0);
    for (const m of allRecent) if (Number.isSafeInteger(m?.seq) && m.seq > maxSeq) maxSeq = m.seq;
    cursor.lastKey = key;
    cursor.seenSeq[key] = maxSeq;
    saveWorkerCursor(wid, cursorAll, cursor);

    const memoBanner = (isSessionFirstLoad || (isPrivate && switchedKey)) ? formatSituationMemoBanner(key, allRecent) : '';
    const prefixText = rawText.slice(0, snapIdx);
    return prefixText + memoBanner + marker + JSON.stringify(packet) + (jsonEnd >= 0 ? rawText.slice(jsonEnd) : '');
  } catch {
    return rawText;
  }
}

function resolveErplayActive(workerId, opts) {
  const chunks = [...(opts.messages || [])];
  if (opts.batch) chunks.push(String(opts.batch));
  if (opts.tts) chunks.push(String(opts.tts));
  const hitNow = ERPLAY_RE.test(chunks.join('\n'));
  const now = Date.now();
  let state = {};
  try {
    if (fs.existsSync(ERPLAY_STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(ERPLAY_STATE_FILE, 'utf8')) || {};
    }
  } catch {}
  if (hitNow) {
    state[workerId] = now;
    try {
      fs.mkdirSync(path.dirname(ERPLAY_STATE_FILE), { recursive: true });
      fs.writeFileSync(ERPLAY_STATE_FILE, JSON.stringify(state, null, 2));
    } catch {}
    return true;
  }
  const lastAt = Number(state[workerId]) || 0;
  return lastAt > 0 && (now - lastAt) < ERPLAY_TTL_MS;
}

async function waitNextWakeLoop(port, consoleToken, workerId, priority, finishTurn, maxTurns, finishFirst = true, isErplay = false) {
  let effectiveMaxTurns = Number.isFinite(maxTurns)
    ? maxTurns
    : (workerId !== 'primary' ? 30 : 0);
  if (isErplay && effectiveMaxTurns > 20) {
    effectiveMaxTurns = 20;
  }
  while (true) {
    const qs = new URLSearchParams({ timeoutMs: '55000', workerId });
    if (priority !== '') qs.set('priority', priority);
    if (effectiveMaxTurns > 0) qs.set('maxTurns', String(effectiveMaxTurns));
    if (finishFirst) {
      if (finishTurn) qs.set('finishTurn', finishTurn);
      qs.set('finishWorker', '1');
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/wait?${qs.toString()}`, {
        headers: consoleToken ? { 'x-console-token': consoleToken } : {},
        signal: AbortSignal.timeout(65000),
      });
      if (!res.ok) {
        await sleep(1500);
        continue;
      }
      finishFirst = false;
      const data = await res.json();
      if (data?.superseded) {
        console.log(`[agy-reply-and-wait] [${workerId}] 旧监听连接已被同线程新回合接管，安全退出。`);
        process.exit(0);
      }
      if (data?.ok && data.rotate) {
        console.log(`=== WORKER_ROTATE_NEEDED [${workerId}] 已满 ${data.turnsCompleted || effectiveMaxTurns} 轮 ===`);
        console.log(`本线程已完成 ${data.turnsCompleted || effectiveMaxTurns} 轮上限并安全下线。请不要再调用任何工具（也不要再启动监听），直接输出一句 "[ROTATE:${workerId}] 已满 ${data.turnsCompleted || effectiveMaxTurns} 轮，请销毁本旧子代理并重新拉起同名新线程 ${workerId}" 结束本子代理，父窗口会自动收到完成通知并为你换新！`);
        process.exit(0);
      }
      if (data?.ok && !data.timedOut && data.wake) {
        const w = data.wake;
        const tokMatch = /(?:【会话令牌】|会话令牌\s*[:：]\s*)([A-Za-z0-9_-]{16,64})/.exec(String(w.text || ''));
        const extractedToken = w.agentToken || (tokMatch ? tokMatch[1] : '');
        console.log(`=== QQ 唤醒 [${workerId}${w.workerTurnIndex ? ` | ${w.workerTurnIndex}/${effectiveMaxTurns || '∞'}` : ''}] Key=${w.key ?? '-'} Turn=${w.turn} Token=${extractedToken || '-'} ===`);
        if (w.imageCount > 0) {
          console.log(`媒体: ${w.imageCount}张（需看图时: node "${path.join(ROOT, 'scripts', 'agy-get-image.mjs').replace(/\\/g, '/')}" --key "${w.key}" --token "${extractedToken || '<Token>'}" --msg "<msgId>"）`);
        }
        const enrichedText = await enrichWakeTextWithHistory(port, consoleToken, w, false, isErplay);
        console.log(softenWakeText(enrichedText));
        process.exit(0);
      }
    } catch {
      await sleep(1500);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let batchFromStdin = null;
  if (opts.batchStdin) {
    if (opts.batch !== null || opts.messages.length) throw new Error('--batch-stdin 需单独提供批量消息');
    batchFromStdin = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(batchFromStdin) || !batchFromStdin.length || batchFromStdin.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('--batch-stdin 需要非空的 JSON 对象数组');
    }
    opts.batch = JSON.stringify(batchFromStdin);
  }
  const isErplay = resolveErplayActive(opts.workerId, opts);
  if (opts.key) opts.token = sessionToken(opts.key, opts.token);
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const consoleToken = readConsoleToken(cfg);
  const finishTurnForWait = opts.finishTurn;
  if (opts.finishTurn && opts.key) {
    try {
      const claim = await postBridge(port, consoleToken, '', '/api/agy/claim', {
        key: opts.key, token: opts.token, workerId: opts.workerId, turn: opts.finishTurn,
      });
      if (claim.duplicate) {
        console.log('[agy-reply-and-wait] 此回合已有回复任务，重复调用已忽略。');
        if (!opts.noWait) {
          await waitNextWakeLoop(port, consoleToken, opts.workerId, opts.priority, '', opts.maxTurns, false, isErplay);
        }
        return;
      }
    } catch (err) {
      // 旧 turn 或未确认的 claim 绝不能降级为不带 turn 的 QQ 发送。
      console.error('[agy-reply-and-wait] 未取得回合，跳过发送：' + err.message);
      if (!opts.noWait) await waitNextWakeLoop(port, consoleToken, opts.workerId, opts.priority, '', opts.maxTurns, false, isErplay);
      else if (err.status !== 404 && err.status !== 409) process.exitCode = 1;
      return;
    }
  }
  let failed = false;

  if (opts.key && opts.token) {
    try {
    for (const rawSpec of opts.collectStickers) {
      const parts = String(rawSpec || '').split('::').map((s) => s.trim());
      const msgRef = parts[0] || '';
      const note = parts[1] || '';
      const tagsRaw = parts[2] || '';
      const usage = parts[3] || '';
      if (!msgRef) continue;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/collect-sticker', {
          key: opts.key,
          messageId: msgRef,
          remark: note.slice(0, 20),
          note,
          tags: tagsRaw ? tagsRaw.split(/[,，/\s]+/).filter(Boolean) : [],
          usage,
        });
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] 收藏表情未成功 (${msgRef}): ${err?.message ?? err}`);
      }
    }

    let batchReply = null;
    if (opts.batch) {
      let items = [];
      // PowerShell 传给原生程序时会吞掉/错位 \" 转义，导致 JSON 截断。依次尝试：原样 → 去反斜杠转义 → 拼回被拆散的位置参数 → 正则抢救。
      const candidates = [opts.batch, opts.batch.replace(/\\+"/g, '"')];
      if (opts.messages.length > 0) {
        const joined = [opts.batch, ...opts.messages].join(' ');
        candidates.push(joined, joined.replace(/\\+"/g, '"'));
      }
      let parsedOk = batchFromStdin !== null;
      if (parsedOk) items = batchFromStdin;
      else for (const c of candidates) {
        try { items = JSON.parse(c); parsedOk = true; break; } catch {}
      }
      if (parsedOk && opts.messages.length > 0) opts.messages = [];
      if (!parsedOk) {
        const raw = [opts.batch, ...opts.messages].join(' ').replace(/\\+"/g, '"');
        opts.messages = [];
        items = [];
        const objRe = /\{[^{}]*\}/g;
        let m;
        while ((m = objRe.exec(raw))) {
          const seg = m[0];
          const reply = /"reply"\s*:\s*"?(\d+)/.exec(seg)?.[1];
          const msgsPart = /"messages"\s*:\s*\[([^\]]*)/.exec(seg)?.[1] ?? /"text"\s*:\s*"([^"]*)/.exec(seg)?.[1] ?? '';
          const msgs = [...String(msgsPart).matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter(Boolean);
          if (!msgs.length && msgsPart && !msgsPart.includes('"')) msgs.push(msgsPart.trim());
          if (msgs.length) items.push({ reply, messages: msgs });
        }
        console.error(`[agy-reply-and-wait] --batch JSON 解析失败，已正则抢救 ${items.length} 组消息`);
      }
      if (!Array.isArray(items) || !items.length) failed = true;
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item) continue;
          if (!batchReply && item.reply) batchReply = String(item.reply);
          const msgs = (Array.isArray(item.messages)
            ? item.messages
            : (item.text ? [String(item.text)] : [])).map((m) => decodeOutboundText(m));
          if (msgs.length > 0) {
            const payload = {
              key: opts.key,
              messages: msgs.length === 1 ? msgs[0] : msgs,
            };
            if (opts.finishTurn) payload.turn = opts.finishTurn;
            if (item.reply) payload.replyToMessageId = String(item.reply);
            if (item.at) payload.atUserId = String(item.at);
            try {
              await sendWorkerText(port, consoleToken, opts.token, payload);
            } catch (err) {
              failed = true;
              console.error('[agy-reply-and-wait] 批量文本发送警告: ' + err.message);
            }
          }
          if (item.sticker) {
            const sp = { key: opts.key, stickerId: String(item.sticker) };
            if (opts.finishTurn) sp.turn = opts.finishTurn;
            if (msgs.length === 0 && item.reply) sp.replyToMessageId = String(item.reply);
            try {
              await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-sticker', sp);
            } catch (err) {
              failed = true;
              console.error(`[agy-reply-and-wait] 批量表情发送警告 (${item.sticker}): ${err?.message ?? err}`);
            }
          }
          if (item.image) {
            const ip = { key: opts.key, imagePath: String(item.image) };
            if (opts.finishTurn) ip.turn = opts.finishTurn;
            if (msgs.length === 0 && !item.sticker && item.reply) ip.replyToMessageId = String(item.reply);
            try {
              await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-image', ip);
            } catch (err) {
              failed = true;
              console.error(`[agy-reply-and-wait] 批量图片发送警告: ${err?.message ?? err}`);
            }
          }
          if (item.tts || item.voice) {
            const rawTtsVal = item.tts || item.voice;
            const decodedTtsVal = Array.isArray(rawTtsVal) ? rawTtsVal.map((x) => decodeOutboundTts(x)) : decodeOutboundTts(rawTtsVal);
            const ttsSegments = expandTtsSegments(decodedTtsVal);
            const lockedRef = inferUnifiedTtsRef(ttsSegments, item.ttsRef || opts.ttsRef, opts.key);
            for (let segIdx = 0; segIdx < ttsSegments.length; segIdx += 1) {
              const segText = ttsSegments[segIdx];
              const tp = { key: opts.key, text: String(segText), split: false, ttsRef: lockedRef };
              if (opts.finishTurn && segIdx === 0) tp.turn = opts.finishTurn;
              if (item.ttsProvider || opts.ttsProvider) tp.provider = String(item.ttsProvider || opts.ttsProvider);
              try {
                await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-tts', tp);
              } catch (err) {
                failed = true;
                console.error(`[agy-reply-and-wait] 批量语音发送警告: ${err?.message ?? err}`);
              }
            }
          }
        }
      }
    }

    if (opts.messages.length > 0) {
      const decodedMsgs = opts.messages.map((m) => decodeOutboundText(m));
      const payload = {
        key: opts.key,
        messages: decodedMsgs.length === 1 ? decodedMsgs[0] : decodedMsgs,
      };
      if (opts.finishTurn) payload.turn = opts.finishTurn;
      if (opts.reply) payload.replyToMessageId = opts.reply;
      if (opts.at) payload.atUserId = opts.at;
      try {
        await sendWorkerText(port, consoleToken, opts.token, payload);
      } catch (err) {
        failed = true;
        console.error('[agy-reply-and-wait] 文本发送警告: ' + err.message);
      }
    }
    if (opts.sticker) {
      const sp = { key: opts.key, stickerId: String(opts.sticker) };
      if (opts.finishTurn) sp.turn = opts.finishTurn;
      if (opts.messages.length === 0 && opts.reply) sp.replyToMessageId = opts.reply;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-sticker', sp);
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] 表情发送未成功 (${opts.sticker}，已忽略并继续标已读): ${err?.message ?? err}`);
      }
    }
    if (opts.image) {
      const ip = { key: opts.key, imagePath: String(opts.image) };
      if (opts.finishTurn) ip.turn = opts.finishTurn;
      if (opts.messages.length === 0 && !opts.sticker && opts.reply) ip.replyToMessageId = String(opts.reply);
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-image', ip);
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] 图片发送警告: ${err?.message ?? err}`);
      }
    }
    const rawTtsList = opts.ttsList.length > 0 ? opts.ttsList.map((x) => decodeOutboundTts(x)) : (opts.tts ? decodeOutboundTts(opts.tts) : []);
    const allTtsSegments = expandTtsSegments(rawTtsList);
    const lockedRef = inferUnifiedTtsRef(allTtsSegments, opts.ttsRef, opts.key);
    for (let segIdx = 0; segIdx < allTtsSegments.length; segIdx += 1) {
      const segText = allTtsSegments[segIdx];
      const tp = { key: opts.key, text: String(segText), split: false, ttsRef: lockedRef };
      if (opts.ttsProvider) tp.provider = String(opts.ttsProvider);
      if (opts.finishTurn && segIdx === 0) tp.turn = opts.finishTurn;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-tts', tp);
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] TTS 语音发送警告: ${err?.message ?? err}`);
      }
    }
    for (const rawDraw of opts.codexDraws) {
      const trimmed = String(rawDraw || '').trim();
      if (!trimmed) continue;
      let spec = null;
      if (trimmed.startsWith('{')) {
        for (const cand of [trimmed, trimmed.replace(/\\+"/g, '"')]) {
          try { spec = JSON.parse(cand); break; } catch {}
        }
        if (!spec || typeof spec !== 'object') {
          // PowerShell 吞掉双引号时的正则无损解包（如 {prompt:...,selfRef:true}）
          const unescaped = trimmed.replace(/\\+"/g, '"').replace(/^\{+|\}+$/g, '').trim();
          const selfRefMatch = /,?\s*"?selfRef"?\s*:\s*(true|false)\b/i.exec(unescaped);
          const refMsgMatch = /,?\s*"?refMsgId"?\s*:\s*"?(\d+)"?/i.exec(unescaped);
          const asStickerMatch = /,?\s*"?asSticker"?\s*:\s*(true|false)\b/i.exec(unescaped);
          let cleanPrompt = unescaped
            .replace(/^"?prompt"?\s*:\s*/i, '')
            .replace(/,?\s*"?selfRef"?\s*:\s*(?:true|false)\b/ig, '')
            .replace(/,?\s*"?refMsgId"?\s*:\s*"?\d+"?/ig, '')
            .replace(/,?\s*"?asSticker"?\s*:\s*(?:true|false)\b/ig, '')
            .replace(/^"+|"+$/g, '')
            .trim();
          spec = {
            prompt: cleanPrompt,
            selfRef: selfRefMatch ? selfRefMatch[1].toLowerCase() === 'true' : true,
            ...(refMsgMatch ? { refMsgId: refMsgMatch[1] } : {}),
            ...(asStickerMatch ? { asSticker: asStickerMatch[1].toLowerCase() === 'true' } : {}),
          };
        }
      }
      if (!spec || typeof spec !== 'object') {
        spec = { prompt: trimmed, selfRef: true };
      }
      const drawBody = {
        key: opts.key,
        turn: opts.finishTurn || undefined,
        prompt: String(spec.prompt || '').trim(),
        selfRef: typeof spec.selfRef === 'boolean' ? spec.selfRef : true,
        ...(spec.refMsgId != null ? { refMsgId: String(spec.refMsgId) } : {}),
        ...(spec.asSticker === true ? { asSticker: true } : {}),
        ...(spec.note ? { note: String(spec.note) } : {}),
        ...(spec.tags ? { tags: spec.tags } : {}),
        ...(spec.replyToMessageId || opts.reply || batchReply ? { replyToMessageId: String(spec.replyToMessageId || opts.reply || batchReply) } : {}),
      };
      if (!drawBody.prompt || drawBody.prompt === '{\\') continue;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/codex-draw', drawBody);
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] 外包生图提交未通过: ${err?.message ?? err}`);
      }
    }
    } catch (err) {
      failed = true;
      console.error(`[agy-reply-and-wait] 发送阶段异常 (继续执行标已读防二次提醒唤醒): ${err?.message ?? err}`);
    }

    // 独立保底执行 mark-read / wake-config：即便上面表情短 ID 填错（404）或 batch 异常，
    // 也必须推进已读水位并确认唤醒配置，彻底杜绝 bridge 触发「未设置唤醒条件，发送提醒 (1/2)」双倍空烧！
    try {
      const isGroup = opts.key.startsWith('group:');
      if (opts.mode && (!isGroup || opts.mode === 'diving')) {
        const wc = {
          mode: opts.mode,
          infinite: !(opts.sleepMs > 0),
          batchWindowMs: isGroup ? 2000 : 1000,
        };
        if (opts.sleepMs > 0) wc.sleepMs = opts.sleepMs;
        if (opts.mode === 'active') {
          wc.triggers = { anyMessage: true, atMention: true, nameMention: true, question: true, poke: true };
        } else {
          wc.triggers = {
            anyMessage: false,
            atMention: true,
            nameMention: true,
            keywords: (Array.isArray(cfg.persona?.nameKeywords) ? cfg.persona.nameKeywords : []).concat(Array.isArray(cfg.persona?.ambiguousKeywords) ? cfg.persona.ambiguousKeywords : []),
            question: false,
            poke: false,
            probability: 0.12,
          };
        }
        const body = { key: opts.key, config: wc };
        if (Number.isInteger(opts.seq) && opts.seq >= 0) body.throughSeq = opts.seq;
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/wake-config', body);
      } else if (Number.isInteger(opts.seq) && opts.seq >= 0) {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/mark-read', {
          key: opts.key,
          turn: opts.finishTurn || undefined,
          throughSeq: opts.seq,
        });
      }
    } catch (err) {
      failed = true;
      console.error(`[agy-reply-and-wait] mark-read 警告: ${err?.message ?? err}`);
    }

    if (!opts.noReply && (opts.messages.length > 0 || opts.batch || opts.memo)) {
      try {
        updateSituationMemo(opts);
      } catch {}
    }
  }

  if (opts.noWait) {
    if (finishTurnForWait) {
      await postBridge(port, consoleToken, '', '/api/agy/complete', { workerId: opts.workerId, turn: finishTurnForWait }).catch(() => {});
    }
    console.log('[agy-reply-and-wait] 回合已结束（--no-wait）');
    process.exitCode = failed ? 1 : 0;
    return;
  }

  await waitNextWakeLoop(port, consoleToken, opts.workerId, opts.priority, finishTurnForWait, opts.maxTurns, true, isErplay);
}

main().catch((err) => {
  console.error('[agy-reply-and-wait] 错误:', err?.message || err);
  process.exit(1);
});
