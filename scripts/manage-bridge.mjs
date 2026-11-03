// 无窗口后台管理 qq-bridge 守护进程（start / stop / status）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';

const LOCK_FILE = path.join(ROOT, 'state', 'bridge.lock');

async function queryStatus() {
  const config = loadConfig();
  const port = Number(config.consolePort) || 3100;
  let res;
  try {
    res = await fetch('http://127.0.0.1:' + port + '/api/status', {
      headers: { 'x-console-token': readConsoleToken(config) }, signal: AbortSignal.timeout(2500),
    });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return null;
    throw error;
  }
  if (!res.ok) throw new Error('控制台状态查询失败，HTTP ' + res.status);
  const { pid, backend, dshReady, mode, workers } = await res.json();
  return { pid, backend, dshReady, mode, workers };
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
    const st = await queryStatus();
    if (!st) { console.log('qq-bridge 未运行'); return; }
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || st.pid !== pid) throw new Error('控制台实例与本目录的锁文件不匹配');
    const cfg = loadConfig();
    const res = await fetch('http://127.0.0.1:' + (Number(cfg.consolePort) || 3100) + '/api/stop', {
      method: 'POST', headers: { 'x-console-token': readConsoleToken(cfg), 'content-type': 'application/json' },
      body: JSON.stringify({ pid }), signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) throw new Error('请求停止失败，HTTP ' + res.status);
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      const current = await queryStatus();
      if (!current || current.pid !== pid) { console.log('已停止 qq-bridge'); return; }
    }
    throw new Error('停止请求已接受，等待实例退出超时');
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
  throw new Error('用法：node scripts/manage-bridge.mjs start|stop|status');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
