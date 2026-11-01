// 极速拉取 QQ 消息中的图片并落盘到本地文件（供子代理直接用 read_file 查看）
// 用法：
//   node scripts/agy-get-image.mjs --key "group:123456789" --token "<token>" --msg "<messageId>"

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
  if (!opts.messageId) {
    console.error('用法: node scripts/agy-get-image.mjs --key "<Key>" --token "<Token>" --msg "<messageId>"');
    process.exit(1);
  }
  if (opts.key) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8')) || {};
      const conv = (s.conversations || s.sessions || s)[opts.key];
      if (conv?.agentToken) opts.token = conv.agentToken;
    } catch {}
  }
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const consoleToken = readConsoleToken();
  const q = new URLSearchParams({ key: opts.key, messageId: String(opts.messageId) });
  const headers = {};
  if (consoleToken) headers['x-console-token'] = consoleToken;
  if (opts.token) headers['x-agent-token'] = opts.token;

  const res = await fetch(`http://127.0.0.1:${port}/api/images/message?${q.toString()}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
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
