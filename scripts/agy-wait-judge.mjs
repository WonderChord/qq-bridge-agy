// 模糊称呼与潜水抽样预筛。--auto-flash 直连本机反代，--model 指定订阅反代模型。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken, readStudioRelay } from './bridge-local.mjs';

const TURN_STATE_FILE = path.join(ROOT, 'state', 'agy-judge-turns.json');
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_MODEL = 'gemini-3.8-flash';
function getCreatorUins() {
  try {
    const cfg = loadConfig();
    return new Set([
      ...(Array.isArray(cfg.persona?.creatorUids) ? cfg.persona.creatorUids.map(String) : []),
      ...(cfg.ownerQQ ? [String(cfg.ownerQQ)] : []),
    ]);
  } catch { return new Set(); }
}

function parseArgs(argv) {
  let id = '';
  let wake = '';
  let maxTurns = DEFAULT_MAX_TURNS;
  let autoFlash = false;
  let testPrompt = '';
  let judgeModel = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id' && i + 1 < argv.length) id = argv[++i];
    else if (argv[i] === '--wake' && i + 1 < argv.length) wake = argv[++i];
    else if (argv[i] === '--auto-flash') autoFlash = true;
    else if (argv[i] === '--model' && i + 1 < argv.length) judgeModel = argv[++i];
    else if (argv[i] === '--self-test' && i + 1 < argv.length) testPrompt = argv[++i];
    else if (argv[i] === '--max-turns' && i + 1 < argv.length) {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v >= 0) maxTurns = v;
    }
  }
  return { id, wake, maxTurns, autoFlash, testPrompt, judgeModel };
}

function readJudgeState() {
  try {
    return JSON.parse(fs.readFileSync(TURN_STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeJudgeState(patch) {
  const prev = readJudgeState();
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  try {
    fs.mkdirSync(path.dirname(TURN_STATE_FILE), { recursive: true });
    fs.writeFileSync(TURN_STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch {}
  return next;
}

function updateJudgeTurnCount(isFreshBoot, mode = 'session-wake') {
  const prev = readJudgeState();
  const turns = isFreshBoot ? 0 : (Number(prev.turns) || 0) + 1;
  writeJudgeState({ turns, mode });
  return turns;
}

function loadRelayCandidates(judgeModel) {
  const list = [];
  // 没有指定模型时保留旧调用方的 Vertex 优先顺序。
  if (!judgeModel) {
    try {
      const key = fs.readFileSync(String(process.env.VERTEX_RELAY_KEY_FILE || ''), 'utf8').trim();
      if (key) {
        list.push({
          name: 'vertex-relay:8787',
          url: 'http://127.0.0.1:8787/v1/chat/completions',
          key,
          model: DEFAULT_MODEL,
        });
      }
    } catch {}
  }
  try {
    const { port, baseUrl, key } = readStudioRelay();
    if (key) {
      list.push({
        name: `studio-relay:${port}`,
        url: `${baseUrl}/v1/chat/completions`,
        key,
        model: judgeModel || DEFAULT_MODEL,
      });
    }
  } catch {}
  return list;
}

function buildJudgePrompt(j) {
  const lines = [];
  lines.push('你是 QQ 群机器人的极速前置门控分类器。只输出一个英文单词 yes 或 no，禁止解释。');
  lines.push(`当前会话：${j.key || ''} | 触发原因：${j.reason || 'probability'}`);
  lines.push('最近群聊上下文：');
  for (const [idx, m] of (j.recent || []).entries()) {
    lines.push(`[${idx + 1}] ${m.sender}: ${m.text}`);
  }
  const trig = j.rawTargetText || j.targetText || '';
  if (trig) {
    lines.push(`触发句（${j.sender || '群友'}）：${trig}`);
  }
  if (j.isCallMention) {
    lines.push('判定标准（名字/关键词提及）：如果创作者（Creator）提到必输出 yes；群友是在叫机器人 机器人 搭话、讨论她或接她刚才的话茬输出 yes；若只是与机器人无关则输出 no。');
  } else {
    lines.push('判定标准（0.12 潜水概率抽样）：如果有明确有趣的槽点/热梗/话题很适合机器人 自然插一句嘴或接她话茬输出 yes；若是日常普通闲聊、严肃长对话、单字/纯图/残句插不上嘴则输出 no。');
  }
  lines.push('请只输出 yes 或 no：');
  return lines.join('\n');
}

async function runDirectFlashJudge(j, judgeModel) {
  const senderStr = String(j.sender || '');
  const senderUin = String(j.senderUin || j.userId || '');
  if (j.isCallMention && (getCreatorUins().has(senderUin) || /\[Creator\]/i.test(senderStr))) {
    return { ok: true, wake: 'yes', model: 'rule:creator-direct', endpoint: 'local-rule', latencyMs: 0 };
  }

  const prompt = buildJudgePrompt(j);
  const candidates = loadRelayCandidates(judgeModel);
  for (const cand of candidates) {
    const t0 = Date.now();
    try {
      const res = await fetch(cand.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cand.key}`,
        },
        body: JSON.stringify({
          model: cand.model,
          messages: [{ role: 'user', content: prompt }],
          reasoning_effort: 'low',
          temperature: 0,
          // Hydrogen 的输出上限包含推理 token，给最终的 yes/no 留出余量。
          max_tokens: cand.model === 'gemini-4-hydrogen' ? 1024 : 128,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const rawText = String(data?.choices?.[0]?.message?.content || '').trim().toLowerCase();
      if (!rawText) continue;
      const wake = /\byes\b/.test(rawText) ? 'yes' : 'no';
      return {
        ok: true,
        wake,
        model: data?.model || cand.model,
        endpoint: cand.name,
        latencyMs: Date.now() - t0,
      };
    } catch {}
  }
  return { ok: false };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { id, wake, maxTurns, autoFlash, testPrompt, judgeModel } = parseArgs(process.argv.slice(2));
  let pendingDecideId = id;
  let pendingWake = wake;

  if (testPrompt) {
    const r = await runDirectFlashJudge({
      key: 'group:test',
      reason: 'self-test',
      isCallMention: true,
      sender: '测试群友',
      targetText: testPrompt,
      recent: [{ sender: '测试群友', text: testPrompt }],
    }, judgeModel);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  const modeLabel = autoFlash ? `auto-flash (${judgeModel || DEFAULT_MODEL})` : 'session-wake';
  let turnsCompleted = updateJudgeTurnCount(!pendingDecideId, modeLabel);

  if (!autoFlash && pendingDecideId && maxTurns > 0 && turnsCompleted >= maxTurns) {
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
    updateJudgeTurnCount(true, modeLabel);
    console.log(`=== JUDGE_ROTATE_NEEDED 已满 ${turnsCompleted} 轮 ===`);
    console.log(`本次预筛结果 (${pendingDecideId}=${pendingWake || 'no'}) 已提交。为防止上下文无限膨胀，请不要再调用任何工具，直接输出一句 "[ROTATE:judge] 已满 ${turnsCompleted} 轮，请销毁旧 qq-flash-judge 并重新拉起同名新线程" 结束本子代理！`);
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

        if (autoFlash) {
          const direct = await runDirectFlashJudge(j, judgeModel);
          if (direct.ok) {
            turnsCompleted += 1;
            const prev = readJudgeState();
            const history = Array.isArray(prev.recentDecisions) ? prev.recentDecisions.slice(-7) : [];
            const item = {
              at: new Date().toISOString(),
              id: j.id,
              reason: j.reason || 'probability',
              sender: j.sender || '',
              target: String(j.rawTargetText || j.targetText || '').slice(0, 60),
              wake: direct.wake,
              model: direct.model,
              endpoint: direct.endpoint,
              latencyMs: direct.latencyMs,
            };
            history.push(item);
            writeJudgeState({
              turns: turnsCompleted,
              mode: modeLabel,
              lastDecision: item,
              recentDecisions: history,
            });
            pendingDecideId = j.id;
            pendingWake = direct.wake;
            continue;
          }
        }

        console.log(`=== Flash 预筛 [${j.id} | Turn ${turnsCompleted + 1}/${maxTurns || '∞'} | ${j.key} | ${j.reason || 'probability'}] ===`);
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
        console.log(`执行：node "${path.join(ROOT, 'scripts', 'agy-wait-judge.mjs').replace(/\\/g, '/')}" --id "${j.id}" --wake <yes|no>`);
        process.exit(0);
      }
    } catch {
      await sleep(2500);
    }
  }
}

main();
