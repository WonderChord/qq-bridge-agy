// Antigravity 多线程零轮询阻塞唤醒脚本（支持多 Worker 并发监听池）。
//
// 可选参数：
//   --worker-id <id>   线程标识（默认 primary，优先级 10；并发副线程如 w2 / w3 默认优先级 5）
//   --priority <num>   显式指定监听优先级（数值越大越优先接单）
//   --no-finish        启动时不结清本 workerId 名下的残留回合

import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
          console.log(`附带媒体 : ${w.imageCount} 张图片/表情（仅当对方明确让你看图时，用 node "${path.join(ROOT, 'scripts')}\\agy-get-image.mjs" --key "${w.key}" --token "<会话令牌>" --msg "<messageId>" 落盘后 read_file 查看）`);
        }
        console.log(`-------------------`);
        console.log(w.text);
        process.exit(0);
      }
    } catch {
      await sleep(Math.min(2000, remaining()));
    }
  }
}

main();
