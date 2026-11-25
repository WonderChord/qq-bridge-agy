// 语音导演与 Drama 3 声优演技精修监听脚本（零轮询长连接，满 12 单自动换新防上下文膨胀）。
// 用法：
//   初始挂起监听：node scripts/agy-wait-voice.mjs
//   提交精修并继续监听：
//     node scripts/agy-wait-voice.mjs --done-id "<JobId>" --ref "02_tsukkomi" --tts "[acting] 精修台词"
//     或传多段 JSON stdin：... | node scripts/agy-wait-voice.mjs --done-id "<JobId>" --stdin-json

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';

const TURN_STATE_FILE = path.join(ROOT, 'state', 'agy-voice-turns.json');
const DEFAULT_MAX_TURNS = process.env.QQ_BRIDGE_HOST === 'codex' ? 0 : 12;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function updateTurnCount(isFreshBoot) {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(TURN_STATE_FILE, 'utf8')) || {}; } catch {}
  const turns = isFreshBoot ? 0 : (Number(prev.turns) || 0) + 1;
  try {
    fs.mkdirSync(path.dirname(TURN_STATE_FILE), { recursive: true });
    fs.writeFileSync(TURN_STATE_FILE, JSON.stringify({ turns, updatedAt: Date.now() }, null, 2), 'utf8');
  } catch {}
  return turns;
}

function parseArgs(argv) {
  const o = { doneId: '', ttsList: [], ttsRef: '', stdinJson: false, maxTurns: DEFAULT_MAX_TURNS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--done-id' && argv[i + 1]) o.doneId = String(argv[++i]).trim();
    else if ((a === '--tts' || a === '--seg') && argv[i + 1]) o.ttsList.push(String(argv[++i]).trim());
    else if (a === '--ref' && argv[i + 1]) o.ttsRef = String(argv[++i]).trim();
    else if (a === '--stdin-json') o.stdinJson = true;
    else if (a === '--max-turns' && argv[i + 1]) o.maxTurns = Math.max(0, Number(argv[++i]) || 0);
  }
  return o;
}

async function postDone(port, token, doneId, result) {
  await fetch(`http://127.0.0.1:${port}/api/agy/helper-done`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-console-token': token } : {}),
    },
    body: JSON.stringify({ id: doneId, result }),
    signal: AbortSignal.timeout(10000),
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const token = readConsoleToken(cfg);
  const selfPosix = path.join(ROOT, 'scripts', 'agy-wait-voice.mjs').replace(/\\/g, '/');

  if (opts.doneId) {
    let result = { segments: opts.ttsList.filter(Boolean), ttsRef: opts.ttsRef || '' };
    if (opts.stdinJson) {
      const raw = fs.readFileSync(0, 'utf8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        result = {
          segments: Array.isArray(parsed.segments) ? parsed.segments : (parsed.text ? [String(parsed.text)] : result.segments),
          ttsRef: String(parsed.ttsRef || parsed.ref || opts.ttsRef || ''),
        };
      }
    }
    await postDone(port, token, opts.doneId, result).catch((err) => {
      console.error(`[agy-wait-voice] 提交完成结果警告: ${err?.message || err}`);
    });
  }

  const turnsCompleted = updateTurnCount(!opts.doneId);
  if (opts.doneId && opts.maxTurns > 0 && turnsCompleted >= opts.maxTurns) {
    updateTurnCount(true);
    console.log(`=== VOICE_ROTATE_NEEDED 已满 ${turnsCompleted} 单 ===`);
    console.log(`本单语音导演任务 (${opts.doneId}) 已移交合成。请勿再调工具，直接输出 "[ROTATE:voice] 已满 ${turnsCompleted} 单，请求销毁换新 qq-voice-worker" 结束本子代理！`);
    process.exit(0);
  }

  while (true) {
    try {
      const qs = new URLSearchParams({ role: 'voice', workerId: 'voice-1', timeoutMs: '55000' });
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/helper-wait?${qs.toString()}`, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(65000),
      });
      if (!res.ok) { await sleep(3000); continue; }
      const data = await res.json();
      if (data?.enabled === false) {
        console.log('[agy-wait-voice] 当前配置已关闭 voice 多线程助手（socialV2.helpers），监听安全退出。');
        process.exit(0);
      }
      if (data?.ok && !data.timedOut && data.job) {
        const j = data.job;
        const p = j.payload || {};
        console.log(`=== 语音导演精修任务 ===`);
        console.log(`JobId       : ${j.id}`);
        console.log(`会话 Key    : ${p.key || '-'}`);
        console.log(`模式        : ${p.voiceBrief ? '从说话意图原创口语台本' : '精修并增强现有草稿情绪张力'}`);
        if (p.situationMemo) console.log(`当前情境备忘: ${p.situationMemo}`);
        if (p.chineseContext) console.log(`本轮文本回复: ${p.chineseContext}`);
        console.log(`待处理台词  : ${p.rawText || ''}`);
        if (Array.isArray(p.recentContext) && p.recentContext.length > 0) {
          console.log(`近期上下文  :\n  ${p.recentContext.join('\n  ')}`);
        }
        console.log(`-------------------`);
        console.log(`请结合本轮情绪打磨为 1~2 段富有起伏、顿挫、气口的纯正口语台本（单段 <= 65 发音字符），选准最贴合的情绪参考底音（如 01_default / 02_tsukkomi / 03_nadenade / 04_shy_flustered / 05_happy_clingy / 06_smug_gamer），立即执行：`);
        console.log(`node "${selfPosix}" --done-id "${j.id}" --ref "<底音编号>" --tts '<[英文演技基调] 精修口语台本>'`);
        process.exit(0);
      }
    } catch {
      await sleep(3000);
    }
  }
}

main();
