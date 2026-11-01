// Antigravity 旁路异步记忆归纳监听脚本（零轮询、零聊天阻塞）。
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

async function main() {
  const args = process.argv.slice(2);
  const doneIdx = args.indexOf('--done-id');
  let doneId = doneIdx >= 0 && args[doneIdx + 1] ? String(args[doneIdx + 1]).trim() : '';

  while (true) {
    const cfg = loadConfig();
    const port = Number(cfg.consolePort) || 3100;
    const token = readConsoleToken();
    const qs = new URLSearchParams({ timeoutMs: '55000' });
    if (doneId) qs.set('doneId', doneId);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/archive-wait?${qs.toString()}`, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(65000),
      });
      if (!res.ok) {
        await sleep(3000);
        continue;
      }
      doneId = '';
      const data = await res.json();
      if (data?.ok && !data.timedOut && data.job) {
        const j = data.job;
        console.log(`=== 长期记忆分舱归纳任务 ===`);
        console.log(`JobId       : ${j.id}`);
        console.log(`会话 Key    : ${j.key}`);
        console.log(`目标摘要文件: ${j.summaryPath}`);
        console.log(`目标日记目录: ${j.diaryDir}`);
        console.log(`消息范围    : seq ${j.fromSeq} ~ ${j.toSeq}（共 ${j.messages.length} 条）`);
        console.log(`-------------------`);
        for (const m of j.messages) {
          console.log(`[${m.at || ''}] ${m.sender}(${m.userId}): ${m.text}`);
        }
        console.log(`-------------------`);
        console.log(`请提炼本批次有价值的长期记忆（新梗、常驻群友性格/立场、未完话题；严禁记录起哄开盒外号或跨群信息），更新 ${j.summaryPath}（保持精炼 <= 1200 字，改写合并旧条目而非无限追加）并按需追加简明日记到 ${j.diaryDir}，完成后执行：`);
        console.log(`node "${path.join(ROOT, 'scripts')}\\agy-wait-archive.mjs" --done-id "${j.id}"`);
        process.exit(0);
      }
    } catch {
      await sleep(3000);
    }
  }
}

main();
