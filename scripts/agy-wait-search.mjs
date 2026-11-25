// 后台搜索查证监听脚本（支持「同步干净摘要返回给 w1」与「异步深查直接追评到 QQ」双模式，满 10 单换新）。
// 用法：
//   初始挂起：node scripts/agy-wait-search.mjs
//   完成同步委托：node scripts/agy-wait-search.mjs --done-id "<JobId>" --summary "精炼查证结论"
//   完成异步追评：node scripts/agy-wait-search.mjs --done-id "<JobId>" --send-key "<Key>" --send-token "<Token>" --reply "<msgId>" --followup "符合角色口吻的简短追评"

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';

const TURN_STATE_FILE = path.join(ROOT, 'state', 'agy-search-turns.json');
const DEFAULT_MAX_TURNS = process.env.QQ_BRIDGE_HOST === 'codex' ? 0 : 10;
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
  const o = { doneId: '', summary: '', sendKey: '', sendToken: '', reply: '', followup: '', maxTurns: DEFAULT_MAX_TURNS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--done-id' && argv[i + 1]) o.doneId = String(argv[++i]).trim();
    else if ((a === '--summary' || a === '--result') && argv[i + 1]) o.summary = String(argv[++i]).trim();
    else if (a === '--send-key' && argv[i + 1]) o.sendKey = String(argv[++i]).trim();
    else if (a === '--send-token' && argv[i + 1]) o.sendToken = String(argv[++i]).trim();
    else if (a === '--reply' && argv[i + 1]) o.reply = String(argv[++i]).trim();
    else if (a === '--followup' && argv[i + 1]) o.followup = String(argv[++i]).trim();
    else if (a === '--max-turns' && argv[i + 1]) o.maxTurns = Math.max(0, Number(argv[++i]) || 0);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const token = readConsoleToken(cfg);
  const selfPosix = path.join(ROOT, 'scripts', 'agy-wait-search.mjs').replace(/\\/g, '/');

  if (opts.doneId) {
    if (opts.followup && opts.sendKey && opts.sendToken) {
      const msgPayload = {
        key: opts.sendKey,
        messages: opts.followup,
        ...(opts.reply ? { replyToMessageId: opts.reply } : {}),
      };
      await fetch(`http://127.0.0.1:${port}/api/socialV2/send-message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-console-token': token } : {}),
          'x-agent-token': opts.sendToken,
        },
        body: JSON.stringify(msgPayload),
        signal: AbortSignal.timeout(15000),
      }).catch((err) => {
        console.error(`[agy-wait-search] 异步追评发送警告: ${err?.message || err}`);
      });
    }
    await fetch(`http://127.0.0.1:${port}/api/agy/helper-done`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-console-token': token } : {}),
      },
      body: JSON.stringify({ id: opts.doneId, result: { summary: opts.summary || opts.followup || '' } }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }

  const turnsCompleted = updateTurnCount(!opts.doneId);
  if (opts.doneId && opts.maxTurns > 0 && turnsCompleted >= opts.maxTurns) {
    updateTurnCount(true);
    console.log(`=== SEARCH_ROTATE_NEEDED 已满 ${turnsCompleted} 单 ===`);
    console.log(`本单搜索查证 (${opts.doneId}) 已完成。请勿再调工具，直接输出 "[ROTATE:search] 已满 ${turnsCompleted} 单，请求销毁换新 qq-search-worker" 结束本子代理！`);
    process.exit(0);
  }

  while (true) {
    try {
      const qs = new URLSearchParams({ role: 'search', workerId: 'search-1', timeoutMs: '55000' });
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/helper-wait?${qs.toString()}`, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(65000),
      });
      if (!res.ok) { await sleep(3000); continue; }
      const data = await res.json();
      if (data?.enabled === false) {
        console.log('[agy-wait-search] 当前配置已关闭 search 多线程助手（socialV2.helpers），监听安全退出。');
        process.exit(0);
      }
      if (data?.ok && !data.timedOut && data.job) {
        const j = data.job;
        const p = j.payload || {};
        console.log(`=== 后台搜索查证任务 ===`);
        console.log(`JobId       : ${j.id}`);
        console.log(`模式        : ${p.mode === 'followup' ? '异步深查并直接向 QQ 追评' : '同步速查（提炼纯干货返回给 w1，不刷屏）'}`);
        console.log(`检索问题    : ${p.query || ''}`);
        if (p.context) console.log(`对话背景    : ${p.context}`);
        if (p.mode === 'followup') {
          console.log(`会话 Key    : ${p.key || ''}`);
          console.log(`会话 Token  : ${p.token || ''}`);
          if (p.replyToMessageId) console.log(`引用 MsgId  : ${p.replyToMessageId}`);
          if (p.chineseReply) console.log(`w1 先行回复 : ${p.chineseReply}`);
          console.log(`-------------------`);
          console.log(`请用 search_web / read_url_content 查清事实后，写成 1~2 句符合当前角色人设的自然结论（群聊简短自然 <= 40 字，无客服八股），执行：`);
          console.log(`node "${selfPosix}" --done-id "${j.id}" --send-key "${p.key || ''}" --send-token "${p.token || ''}"${p.replyToMessageId ? ` --reply "${p.replyToMessageId}"` : ''} --followup '<角色口吻查证追评>'`);
        } else {
          console.log(`-------------------`);
          console.log(`请用 search_web / read_url_content 快速交叉核实，压缩为 <= 200 字客观准确要点（含时间/出处/梗含义），立即执行：`);
          console.log(`node "${selfPosix}" --done-id "${j.id}" --summary '<200字内查证干货>'`);
        }
        process.exit(0);
      }
    } catch {
      await sleep(3000);
    }
  }
}

main();
