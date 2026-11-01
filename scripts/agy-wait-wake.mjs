// Antigravity 多线程零轮询阻塞唤醒脚本（支持多 Worker 并发监听池）。
//
// 可选参数：
//   --worker-id <id>   线程标识（默认 primary，优先级 10；并发副线程如 w2 / w3 默认优先级 5）
//   --priority <num>   显式指定监听优先级（数值越大越优先接单）
//   --no-finish        启动时不结清本 workerId 名下的残留回合

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function readConsoleToken() {
  try {
    const c = loadConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 分舱长期记忆：config.json → persona.memoryCompartments（{ "<key>": { "dir": "memory/xxx" } }）
function compartmentSummaryPath(key) {
  const raw = loadConfig()?.persona?.memoryCompartments?.[key];
  if (!raw || !raw.dir) return '';
  return path.join(path.resolve(ROOT, String(raw.dir)), String(raw.summaryFile || 'summary.md'));
}

function injectWorkerSyncedMemory(workerId, key, wakeText) {
  const summaryPath = compartmentSummaryPath(key);
  if (!summaryPath || !fs.existsSync(summaryPath)) return '';
  if (String(wakeText || '').includes('【本会话分舱长期记忆精华')) return '';
  try {
    const mtime = String(Math.floor(fs.statSync(summaryPath).mtimeMs));
    const stateFile = path.join(ROOT, 'state', 'agy-worker-mem-sig.json');
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {}
    const sigKey = `${workerId}::${key}`;
    if (state[sigKey] === mtime) return '';
    const memText = fs.readFileSync(summaryPath, 'utf8').trim().slice(0, 1600);
    state[sigKey] = mtime;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    if (!memText) return '';
    return `\n【本会话分舱长期记忆精华（仅限 ${key} 使用，严禁跨群串台）】\n${memText}\n`;
  } catch {
    return '';
  }
}

async function main() {
  const args = process.argv.slice(2);
  let finishFirst = !args.includes('--no-finish');
  const widIdx = args.indexOf('--worker-id');
  const workerId = widIdx >= 0 && args[widIdx + 1] ? String(args[widIdx + 1]).trim() : 'primary';
  const priIdx = args.indexOf('--priority');
  const priority = priIdx >= 0 && args[priIdx + 1] !== undefined ? String(args[priIdx + 1]).trim() : '';
  const maxSecondsIdx = args.indexOf('--max-seconds');
  const maxSeconds = maxSecondsIdx >= 0 ? Number(args[maxSecondsIdx + 1]) || 0 : 0;
  const startedAt = Date.now();

  while (true) {
    if (maxSeconds > 0 && (Date.now() - startedAt) >= maxSeconds * 1000) {
      console.log('[agy-wait-wake] 达到 --max-seconds 上限，正常退出（无新唤醒）');
      process.exit(0);
    }
    const cfg = loadConfig();
    const port = Number(cfg.consolePort) || 3100;
    const token = readConsoleToken();
    const qs = new URLSearchParams({ timeoutMs: '55000', workerId });
    if (priority !== '') qs.set('priority', priority);
    if (finishFirst) {
      qs.set('finishWorker', '1');
      qs.set('resetTurns', '1');
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/wait?${qs.toString()}`, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(65000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[agy-wait-wake] HTTP ${res.status}: ${body.slice(0, 200)}`);
        await sleep(2500);
        continue;
      }
      finishFirst = false;
      const data = await res.json();
      if (data?.superseded) {
        console.log(`[agy-wait-wake] [${workerId}] 旧监听连接已被同线程新回合接管，安全退出。`);
        process.exit(0);
      }
      if (data?.ok && !data.timedOut && data.wake) {
        const w = data.wake;
        const tokMatch = /(?:【会话令牌】|会话令牌\s*[:：]\s*)([A-Za-z0-9_-]{16,64})/.exec(String(w.text || ''));
        const extractedToken = w.agentToken || (tokMatch ? tokMatch[1] : '');
        if (w.key && extractedToken) {
          try {
            const tf = path.join(ROOT, 'state', 'agy-agent-tokens.json');
            let map = {};
            try { map = JSON.parse(fs.readFileSync(tf, 'utf8')) || {}; } catch {}
            map[w.key] = extractedToken;
            fs.mkdirSync(path.dirname(tf), { recursive: true });
            fs.writeFileSync(tf, JSON.stringify(map, null, 2), 'utf8');
          } catch {}
        }
        console.log(`=== QQ 唤醒事件 [Worker: ${workerId}] ===`);
        console.log(`会话 Key : ${w.key ?? '(未知)'}`);
        if (extractedToken) console.log(`会话令牌 : ${extractedToken}`);
        console.log(`运行模式 : ${w.mode}`);
        console.log(`SessionId: ${w.sessionId}`);
        console.log(`Turn     : ${w.turn}`);
        console.log(`WorkerId : ${workerId}`);
        console.log(`时间     : ${w.createdAt}`);
        if (w.imageCount > 0) {
          console.log(`附带媒体 : ${w.imageCount} 张图片/表情（仅当对方明确让你看图时，用 node "${path.join(ROOT, 'scripts')}\\agy-get-image.mjs" --key "${w.key}" --token "<会话令牌>" --msg "<messageId>" 落盘后 read_file 查看）`);
        }
        console.log(`-------------------`);
        const extraMem = injectWorkerSyncedMemory(workerId, w.key, w.text);
        if (extraMem) console.log(extraMem);
        console.log(w.text);
        process.exit(0);
      }
    } catch {
      await sleep(2000);
    }
  }
}

main();
