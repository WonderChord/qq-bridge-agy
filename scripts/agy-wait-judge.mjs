// Antigravity Flash 模糊称呼（persona.ambiguousKeywords）零 Token 门控监听与回传脚本（内置 20 轮无状态换新防上下文膨胀）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';

const TURN_STATE_FILE = path.join(ROOT, 'state', 'agy-judge-turns.json');
const DEFAULT_MAX_TURNS = 30;

function parseArgs(argv) {
  let id = '';
  let wake = '';
  let maxTurns = DEFAULT_MAX_TURNS;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id' && i + 1 < argv.length) id = argv[++i];
    else if (argv[i] === '--wake' && i + 1 < argv.length) wake = argv[++i];
    else if (argv[i] === '--max-turns' && i + 1 < argv.length) maxTurns = Number(argv[++i]) || DEFAULT_MAX_TURNS;
  }
  return { id, wake, maxTurns };
}

function updateJudgeTurnCount(isFreshBoot) {
  let turns = 0;
  if (!isFreshBoot) {
    try {
      const saved = JSON.parse(fs.readFileSync(TURN_STATE_FILE, 'utf8'));
      turns = Number(saved?.turns) || 0;
    } catch {}
    turns += 1;
  }
  try {
    fs.mkdirSync(path.dirname(TURN_STATE_FILE), { recursive: true });
    fs.writeFileSync(TURN_STATE_FILE, JSON.stringify({ turns, updatedAt: Date.now() }), 'utf8');
  } catch {}
  return turns;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let { id: pendingDecideId, wake: pendingWake, maxTurns } = parseArgs(process.argv.slice(2));
  const turnsCompleted = updateJudgeTurnCount(!pendingDecideId);

  if (pendingDecideId && maxTurns > 0 && turnsCompleted >= maxTurns) {
    const cfg = loadConfig();
    const port = Number(cfg.consolePort) || 3100;
    const token = readConsoleToken(cfg);
    try {
      await fetch(`http://127.0.0.1:${port}/api/agy/judge-result`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-console-token': token } : {}),
        },
        body: JSON.stringify({ id: pendingDecideId, wake: pendingWake || 'no' }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {}
    updateJudgeTurnCount(true);
    console.log(`=== JUDGE_ROTATE_NEEDED 已满 ${turnsCompleted} 轮 ===`);
    console.log(`本次预筛结果 (${pendingDecideId}=${pendingWake || 'no'}) 已提交。为防止上下文无限膨胀，请不要再调用任何工具，直接输出一句 "[ROTATE:judge] 已满 ${turnsCompleted} 轮，请销毁旧 hakimi-flash-judge 并重新拉起同名新线程" 结束本子代理！`);
    process.exit(0);
  }

  while (true) {
    const cfg = loadConfig();
    const port = Number(cfg.consolePort) || 3100;
    const token = readConsoleToken(cfg);
    const qs = new URLSearchParams({ timeoutMs: '55000' });
    if (pendingDecideId) {
      qs.set('decideId', pendingDecideId);
      qs.set('wake', pendingWake || 'no');
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/judge-wait?${qs.toString()}`, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(65000),
      });
      if (!res.ok) {
        await sleep(2500);
        continue;
      }
      pendingDecideId = '';
      pendingWake = '';
      const data = await res.json();
      if (data?.ok && !data.timedOut && data.judge) {
        const j = data.judge;
        console.log(`=== Flash 预筛 [${j.id} | Turn ${turnsCompleted + 1}/${maxTurns} | ${j.key} | ${j.reason || 'probability'}] ===`);
        for (const [idx, m] of (j.recent || []).entries()) {
          console.log(`[${idx + 1}] ${m.sender}: ${m.text}`);
        }
        const trig = j.rawTargetText || j.targetText || '';
        if (trig) {
          console.log(`触发句（${j.sender || '群友'}）：${trig}`);
        }
        if (j.isCallMention) {
          console.log(`判定（名字/关键词 ${j.reason}）：在叫机器人搭话或接它话茬（创作者提到必 yes）-> yes；同名梗或与机器人无关的闲聊 -> no。极速秒判，勿写长推理！`);
        } else {
          console.log(`判定（潜水 0.12 抽样）：有明确槽点/热梗适合插嘴或接机器人话茬 -> yes；日常技术闲聊/单字/纯图/残句 -> no。极速秒判，勿写长推理！`);
        }
        console.log(`执行：node "${path.join(ROOT, 'scripts')}\\agy-wait-judge.mjs" --id "${j.id}" --wake <yes|no>`);
        process.exit(0);
      }
    } catch {
      await sleep(2500);
    }
  }
}

main();
