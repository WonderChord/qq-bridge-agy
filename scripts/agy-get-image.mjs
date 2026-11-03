// 极速拉取 QQ 消息中的图片并落盘到本地文件（供子代理直接用 read_file 查看）
// 用法：
//   node scripts/agy-get-image.mjs --key "group:123456789" --token "<token>" --msg "<messageId>"

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken, sessionToken } from './bridge-local.mjs';


function parseArgs(argv) {
  const opts = { key: '', token: '', messageId: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key' && i + 1 < argv.length) opts.key = argv[++i];
    else if (a === '--token' && i + 1 < argv.length) opts.token = argv[++i];
    else if ((a === '--msg' || a === '--message-id' || a === '--id') && i + 1 < argv.length) opts.messageId = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!/^-?[1-9]\d*$/.test(opts.messageId)) throw new Error('--msg 必须为非零整数消息 ID');
  opts.token = sessionToken(opts.key, opts.token);
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const consoleToken = readConsoleToken(cfg);
  const q = new URLSearchParams({ key: opts.key, messageId: String(opts.messageId) });
  const headers = {};
  if (consoleToken) headers['x-console-token'] = consoleToken;
  if (opts.token) headers['x-agent-token'] = opts.token;

  const res = await fetch(`http://127.0.0.1:${port}/api/images/message?${q.toString()}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status);
  const images = Array.isArray(data?.images) ? data.images : [];
  if (!images.length) {
    console.log(`消息 ${opts.messageId} 没有可返回的图片/表情：${data?.note || data?.error || '未找到'}`);
    process.exit(0);
  }

  const outDir = path.join(ROOT, 'state', 'media_view');
  fs.mkdirSync(outDir, { recursive: true });

  const savedPaths = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img?.data) continue;
    const ext = img.mimeType === 'image/gif' ? 'gif' : (img.mimeType === 'image/jpeg' ? 'jpg' : 'png');
    const filePath = path.join(outDir, `msg_${opts.messageId}_${i + 1}.${ext}`).replace(/\\/g, '/');
    fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
    savedPaths.push(filePath);
  }
  console.log(`已保存 ${savedPaths.length} 张图片，请直接用 read_file 查看以下路径：`);
  for (const p of savedPaths) {
    console.log(p);
  }
}

main().catch((err) => {
  console.error('[agy-get-image] 错误:', err?.message || err);
  process.exit(1);
});
