// 修复 @snowluma 系列 npm 包的发布打包 bug：dist 内的相对导入缺少 .js 扩展名，
// 纯 Node ESM 无法解析（bundler 可以）。postinstall 时对每个包 dist 下所有 .js
// 文件做机械修补：仅当目标文件存在时才补扩展名，否则保持原样。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TARGETS = ['@snowluma/sdk', '@snowluma/mcp'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let total = 0;
for (const pkg of TARGETS) {
  const distRoot = path.join(ROOT, 'node_modules', pkg, 'dist');
  if (!fs.existsSync(distRoot)) {
    console.log(`[patch-snowluma] ${pkg}: dist 不存在，跳过`);
    continue;
  }
  let patched = 0;
  for (const file of walk(distRoot)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    const next = src.replace(/from\s+'(\.[^']+)'/g, (m, spec) => {
      if (spec.endsWith('.js') || spec.endsWith('.json')) return m;
      const target = path.resolve(path.dirname(file), spec);
      if (fs.existsSync(target + '.js')) return m.replace(spec, spec + '.js');
      if (fs.existsSync(target + '.json')) return m.replace(spec, spec + '.json');
      return m;
    });
    if (next !== src) {
      fs.writeFileSync(file, next);
      patched += 1;
    }
  }
  console.log(`[patch-snowluma] ${pkg}: 修补了 ${patched} 个文件`);
  total += patched;
}

// 修复 Node 22 原生 WebSocket (Undici) 握手建连失败（如对端尚未监听 3001）时
// 只触发 error 不触发 close，导致 connectPromise 永远挂起且不自动重连的问题。
const wsClientFile = path.join(ROOT, 'node_modules', '@snowluma/sdk', 'dist', 'client', 'websocket-client.js');
if (fs.existsSync(wsClientFile)) {
  const wsSrc = fs.readFileSync(wsClientFile, 'utf8');
  const norm = wsSrc.replace(/\r\n/g, '\n');
  const target = `                addSocketListener(socket, 'error', (error) => {\n                    this.emitter.emit('error', unwrapEventPayload(error));\n                }),`;
  const replacement = `                addSocketListener(socket, 'error', (error) => {\n                    this.emitter.emit('error', unwrapEventPayload(error));\n                    cleanup.forEach((off) => off());\n                    if (this.socket === socket) {\n                        this.connectPromise = null;\n                        this.socket = null;\n                        reject(new SnowLumaConnectionError('SnowLuma WebSocket error before opening'));\n                        this.handleClose([{ code: 1006, reason: 'handshake-error' }]);\n                    }\n                }),`;
  if (norm.includes(target)) {
    fs.writeFileSync(wsClientFile, norm.replace(target, replacement));
    console.log('[patch-snowluma] 已修补 websocket-client.js 握手失败重连挂死 bug');
    total += 1;
  }
}

console.log(`[patch-snowluma] 合计 ${total} 个文件`);
