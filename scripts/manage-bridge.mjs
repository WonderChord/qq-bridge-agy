// 无窗口后台管理 qq-bridge 守护进程（start / stop / status）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(ROOT, 'state', 'bridge.lock');

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

async function queryStatus() {
  const port = Number(loadConfig().consolePort) || 3100;
  const token = readConsoleToken();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agy/status`, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const action = process.argv[2] || 'status';
  if (action === 'status') {
    const st = await queryStatus();
    console.log(st ? JSON.stringify({ running: true, ...st }, null, 2) : JSON.stringify({ running: false }, null, 2));
    return;
  }
  if (action === 'stop') {
    try {
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      if (pid > 0) process.kill(pid);
    } catch {}
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    console.log('已停止 qq-bridge');
    return;
  }
  if (action === 'start') {
    const existing = await queryStatus();
    if (existing) {
      console.log('qq-bridge 已在运行:', JSON.stringify(existing));
      return;
    }
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let i = 0; i < 15; i++) {
      await sleep(400);
      const st = await queryStatus();
      if (st) {
        console.log('qq-bridge 后台启动成功:', JSON.stringify(st));
        return;
      }
    }
    console.error('qq-bridge 启动超时，请检查 state/bridge.log');
    process.exit(1);
  }
}

main();
