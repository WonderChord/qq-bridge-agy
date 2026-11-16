// Antigravity 多线程零轮询阻塞唤醒脚本（支持多 Worker 并发监听池）。
//
// 可选参数：
//   --worker-id <id>   线程标识（默认 primary，优先级 10；并发副线程如 w2 / w3 默认优先级 5）
//   --priority <num>   显式指定监听优先级（数值越大越优先接单）
//   --no-finish        启动时不结清本 workerId 名下的残留回合

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ERPLAY_RE = /『[^』]+』|（[^）]{8,}）/;
const SITUATION_MEMO_FILE = path.join(ROOT, 'state', 'agy-situation-memo.json');
const SITUATION_MEMO_TTL_MS = 6 * 3600 * 1000;
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

function formatSituationMemoBanner(key, allRecent = []) {
  const mKey = normalizeMemoKey(key);
  if (!mKey) return '';
  const map = readSituationMemoMap();
  const entry = map[mKey];
  const now = Date.now();
  const hasSaved = entry && entry.updatedAtMs && (now - entry.updatedAtMs) < SITUATION_MEMO_TTL_MS;

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

async function enrichWakeTextWithHistory(port, consoleToken, w, isFirstTurnDefault = true) {
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
  const isIntimate = isPrivate && ERPLAY_RE.test(rawText);
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
      selectedRecent = sliceRecentKeepingTextAnchors(filteredRecent, switchedKey ? 4 : 2, switchedKey ? 6 : 4);
    } else {
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

async function main() {
  const args = process.argv.slice(2);
  let finishFirst = !args.includes('--no-finish');
  const finishIdx = args.indexOf('--finish-turn');
  let finishTurn = finishIdx >= 0 ? String(args[finishIdx + 1] || '').trim() : '';
  const widIdx = args.indexOf('--worker-id');
  const workerId = widIdx >= 0 && args[widIdx + 1] ? String(args[widIdx + 1]).trim() : 'primary';
  const priIdx = args.indexOf('--priority');
  const priority = priIdx >= 0 && args[priIdx + 1] !== undefined ? String(args[priIdx + 1]).trim() : '';
  const maxSecondsIdx = args.indexOf('--max-seconds');
  const maxSeconds = maxSecondsIdx >= 0 ? Number(args[maxSecondsIdx + 1]) || 0 : 0;
  const startedAt = Date.now();
  const remaining = () => maxSeconds > 0 ? Math.max(0, startedAt + maxSeconds * 1000 - Date.now()) : Infinity;

  while (true) {
    if (maxSeconds > 0 && (Date.now() - startedAt) >= maxSeconds * 1000) {
      console.log('[agy-wait-wake] 达到 --max-seconds 上限，正常退出（无新唤醒）');
      process.exit(0);
    }
    const cfg = loadConfig();
    const port = Number(cfg.consolePort) || 3100;
    const token = readConsoleToken(cfg);
    const waitMs = Math.max(1, Math.floor(Math.min(55000, remaining())));
    const qs = new URLSearchParams({ timeoutMs: String(waitMs), workerId });
    if (priority !== '') qs.set('priority', priority);
    if (finishTurn) qs.set('finishTurn', finishTurn);
    if (finishFirst) {
      qs.set('finishWorker', '1');
      qs.set('resetTurns', '1');
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/wait?${qs.toString()}`, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(waitMs + 10000, remaining())))),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[agy-wait-wake] HTTP ${res.status}: ${body.slice(0, 200)}`);
        await sleep(Math.min(2500, remaining()));
        continue;
      }
      finishFirst = false;
      const data = await res.json();
      if (data?.ok) finishTurn = '';
      if (data?.superseded) {
        console.log(`[agy-wait-wake] [${workerId}] 旧监听连接已被同线程新回合接管，安全退出。`);
        process.exit(0);
      }
      if (data?.ok && !data.timedOut && data.wake) {
        const w = data.wake;
        const tokMatch = /(?:【会话令牌】|会话令牌\s*[:：]\s*)([A-Za-z0-9_-]{16,64})/.exec(String(w.text || ''));
        const extractedToken = w.agentToken || (tokMatch ? tokMatch[1] : '');
        console.log(`=== QQ 唤醒事件 [Worker: ${workerId}] ===`);
        console.log(`会话 Key : ${w.key ?? '(未知)'}`);
        if (extractedToken) console.log(`会话令牌 : ${extractedToken}`);
        console.log(`运行模式 : ${w.mode}`);
        console.log(`SessionId: ${w.sessionId}`);
        console.log(`Turn     : ${w.turn}`);
        console.log(`WorkerId : ${workerId}`);
        console.log(`时间     : ${w.createdAt}`);
        if (w.imageCount > 0) {
          console.log(`附带媒体 : ${w.imageCount} 张图片/表情（仅当对方明确让你看图时，用 node "${path.join(ROOT, 'scripts', 'agy-get-image.mjs').replace(/\\/g, '/')}" --key "${w.key}" --token "<会话令牌>" --msg "<messageId>" 落盘后查看）`);
        }
        console.log(`-------------------`);
        const enrichedText = await enrichWakeTextWithHistory(port, token, w, true);
        console.log(softenWakeText(enrichedText));
        process.exit(0);
      }
    } catch {
      await sleep(Math.min(2000, remaining()));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
