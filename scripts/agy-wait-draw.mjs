// 绘图导演助手监听脚本（物理隔离美术设定词防止污染 w1 聊天文本，支持 NovelAI V5 预设池与多后端移交，满 8 单自动换新）。
// 用法：
//   初始挂起：node scripts/agy-wait-draw.mjs
//   提交精修提示词并继续挂起：
//     node scripts/agy-wait-draw.mjs --done-id "<Id>" --self-ref true --preset <预设名> --prompt "精修后的画面构图或 Danbooru 标签"
//   移交后端生图分镜管线直出并继续挂起：
//     node scripts/agy-wait-draw.mjs --done-id "<Id>" --skip

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';
import { loadNaiConfig } from './agy-codex-draw.mjs';

const TURN_STATE_FILE = path.join(ROOT, 'state', 'agy-draw-turns.json');
const DRAWN_DIR_NORM = path.join(ROOT, 'state', 'drawn').replace(/\\/g, '/').toLowerCase();
const DEFAULT_MAX_TURNS = process.env.QQ_BRIDGE_HOST === 'codex' ? 0 : 8;
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
  const o = {
    doneId: '',
    prompt: '',
    selfRef: null,
    preset: '',
    nsfw: null,
    privateRef: null,
    provider: '',
    skip: false,
    stdinPrompt: false,
    maxTurns: DEFAULT_MAX_TURNS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--done-id' && argv[i + 1]) o.doneId = String(argv[++i]).trim();
    else if (a === '--prompt' && argv[i + 1]) o.prompt = String(argv[++i]).trim();
    else if (a === '--self-ref' && argv[i + 1]) o.selfRef = /^(true|1|yes)$/i.test(String(argv[++i]).trim());
    else if (a === '--preset' && argv[i + 1]) o.preset = String(argv[++i]).trim();
    else if (a === '--nsfw' && argv[i + 1]) o.nsfw = /^(true|1|yes)$/i.test(String(argv[++i]).trim());
    else if (a === '--private-ref' && argv[i + 1]) o.privateRef = /^(true|1|yes)$/i.test(String(argv[++i]).trim());
    else if (a === '--provider' && argv[i + 1]) o.provider = String(argv[++i]).trim().toLowerCase();
    else if (a === '--skip' || a === '--fallback') o.skip = true;
    else if (a === '--stdin-prompt') o.stdinPrompt = true;
    else if (a === '--max-turns' && argv[i + 1]) o.maxTurns = Math.max(0, Number(argv[++i]) || 0);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const token = readConsoleToken(cfg);
  const selfPosix = path.join(ROOT, 'scripts', 'agy-wait-draw.mjs').replace(/\\/g, '/');

  if (opts.doneId) {
    let promptText = opts.prompt;
    if (opts.stdinPrompt) {
      promptText = fs.readFileSync(0, 'utf8').trim() || promptText;
    }
    const result = opts.skip
      ? { fallback: true }
      : {
          prompt: promptText,
          ...(typeof opts.selfRef === 'boolean' ? { selfRef: opts.selfRef } : {}),
          ...(opts.preset ? { preset: opts.preset } : {}),
          ...(typeof opts.nsfw === 'boolean' ? { nsfw: opts.nsfw } : {}),
          ...(typeof opts.privateRef === 'boolean' ? { privateRef: opts.privateRef } : {}),
          ...(opts.provider ? { provider: opts.provider } : {}),
        };
    await fetch(`http://127.0.0.1:${port}/api/agy/helper-done`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-console-token': token } : {}),
      },
      body: JSON.stringify({ id: opts.doneId, result }),
      signal: AbortSignal.timeout(10000),
    }).catch((err) => {
      console.error(`[agy-wait-draw] 提交精修提示词警告: ${err?.message || err}`);
    });
  }

  const turnsCompleted = updateTurnCount(!opts.doneId);
  if (opts.doneId && opts.maxTurns > 0 && turnsCompleted >= opts.maxTurns) {
    updateTurnCount(true);
    console.log(`=== DRAW_ROTATE_NEEDED 已满 ${turnsCompleted} 单 ===`);
    console.log(`本单绘图精修 (${opts.doneId}) 已移交生图引擎。请勿再调工具，直接输出 "[ROTATE:draw] 已满 ${turnsCompleted} 单，请求销毁换新 qq-draw-worker" 结束本子代理！`);
    process.exit(0);
  }

  while (true) {
    try {
      const qs = new URLSearchParams({ role: 'draw', workerId: 'draw-1', timeoutMs: '55000' });
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/helper-wait?${qs.toString()}`, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(65000),
      });
      if (!res.ok) { await sleep(3000); continue; }
      const data = await res.json();
      if (data?.enabled === false) {
        console.log('[agy-wait-draw] 当前配置已关闭 draw 多线程助手（socialV2.helpers），监听安全退出。');
        process.exit(0);
      }
      if (data?.ok && !data.timedOut && data.job) {
        const j = data.job;
        const p = j.payload || {};
        const safeRefs = Array.isArray(p.refFiles)
          ? p.refFiles
              .map((f) => String(f || '').replace(/\\/g, '/'))
              .filter((f) => f && !f.toLowerCase().startsWith(DRAWN_DIR_NORM))
          : [];
        const anchor = cfg?.persona?.appearanceAnchor;
        const anchorText = Array.isArray(anchor) ? anchor.join('；') : String(anchor || '');
        const naiCfg = loadNaiConfig();
        console.log(`=== 绘图助手分镜构图任务 ===`);
        console.log(`JobId       : ${j.id} (底层画单 ${p.jobId || '-'})`);
        console.log(`会话 Key    : ${p.key || '-'}`);
        console.log(`自画像锚点  : selfRef=${Boolean(p.selfRef)} | 表情包模式: asSticker=${Boolean(p.asSticker)} | 主力后端: ${naiCfg ? 'NovelAI V5' : 'OpenAI/Codex'}`);
        if (p.selfRef && !naiCfg && anchorText) console.log(`角色外观锚点: ${anchorText}`);
        console.log(`原始画面要求: ${p.prompt || ''}`);
        if (safeRefs.length > 0) {
          console.log(`外部参考原图: ${safeRefs.join(' , ')}`);
          console.log(`（仅可查看上述外部参考原图；若是对实拍图/外图做局部改图，提交时加 --provider codex。不回读 state/drawn/ 生成图！）`);
        }
        if (Array.isArray(p.recentContext) && p.recentContext.length > 0) {
          console.log(`近期对话语境:\n  ${p.recentContext.join('\n  ')}`);
        }
        console.log(`-------------------`);
        if (naiCfg?.bank?.presets) {
          const presetSummary = Object.entries(naiCfg.bank.presets)
            .map(([k, v]) => `${k}(${v?.label || k})`)
            .join(' | ');
          console.log(`可选画师串 --preset: ${presetSummary}`);
          console.log(`请结合语境输出英文 Danbooru 构图动作与光影标签（双人互动且对方形象未敲定时使用 1girl, 1boy, hetero, pov, pov hands, faceless male, out-of-frame male 仅露局部肢体；若不便扩写可传 --skip 移交后端管线直出），立即执行：`);
          console.log(`node "${selfPosix}" --done-id "${j.id}" --self-ref ${Boolean(p.selfRef)} --preset <预设名> --prompt '<英文 Danbooru 构图动作与场景标签>'`);
        } else {
          console.log(`请结合参考图与语境，扩写为构图光影与人物神态细节清晰的生图 Prompt（<= 800 字，asSticker=true 时强调 Q 版大头表情包、干净底色与鲜明神态），立即执行：`);
          console.log(`node "${selfPosix}" --done-id "${j.id}" --self-ref ${Boolean(p.selfRef)} --prompt '<精修后的完整画面描述>'`);
        }
        process.exit(0);
      }
    } catch {
      await sleep(3000);
    }
  }
}

main();
