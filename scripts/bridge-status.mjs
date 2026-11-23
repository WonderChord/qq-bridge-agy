// qq-bridge 实时线程、宿主终端与前置路由状态体检脚本
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';
import { resolveRouterConfig } from '../src/message-router.js';

function checkPort(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

function getAllProcesses() {
  try {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine | ConvertTo-Json -Depth 2 -Compress';
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function detectHostOwner(proc, byPid) {
  let cur = proc;
  const chain = [];
  for (let i = 0; i < 10 && cur; i += 1) {
    const name = String(cur.Name || '').toLowerCase();
    const cmd = String(cur.CommandLine || '');
    chain.push(`${cur.Name}(${cur.ProcessId})`);
    if (/codex-driver\.mjs/i.test(cmd)) {
      let model = '';
      try {
        const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'codex-driver.json'), 'utf8'));
        model = [st.model, st.effort, st.profile].filter(Boolean).join(' ');
      } catch {}
      return `Codex 守护驱动器 codex-driver (PID ${cur.ProcessId}${model ? `, ${model}` : ''})`;
    }
    if (name === 'claude.exe' || /claude-code/i.test(cmd)) {
      const m = cmd.match(/--model=([^\s"]+)/);
      return `Claude Code (PID ${cur.ProcessId}${m ? `, model=${m[1]}` : ''})`;
    }
    if (name === 'codex.exe') {
      return `Codex CLI (PID ${cur.ProcessId})`;
    }
    if (name.includes('antigravity') || cmd.includes('.gemini\\antigravity') || cmd.includes('antigravity')) {
      return `Antigravity IDE (PID ${cur.ProcessId})`;
    }
    cur = byPid.get(cur.ParentProcessId);
  }
  return `独立后台 / 终端已脱离 (${chain.join(' <- ')})`;
}

function classifyListener(cmd) {
  if (/agy-(wait-wake|reply-and-wait)\.mjs/i.test(cmd)) {
    const wid = (cmd.match(/--worker-id\s+([^\s"]+)/) || [])[1] || 'primary';
    const isReply = /agy-reply-and-wait\.mjs/i.test(cmd);
    return {
      role: `w1 主对话线程 (${wid})`,
      key: `worker:${wid}`,
      detail: isReply ? '已回信并继续挂起监听' : '初始挂起监听',
    };
  }
  if (/agy-wait-archive\.mjs/i.test(cmd)) {
    return {
      role: 'archivist 本地记忆归档监听',
      key: 'archivist',
      detail: '达到阈值后在本地触发分舱记忆归档',
    };
  }
  return null;
}

async function fetchAgyStatus(cfg) {
  const port = Number(cfg?.consolePort) || 3100;
  const token = readConsoleToken(cfg);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agy/status`, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  const cfg = loadConfig();
  const routerCfg = resolveRouterConfig({ rootDir: ROOT, env: process.env, cfg });
  const consolePort = Number(cfg.consolePort) || 3100;
  const [napcatOk, bridgeOk, ttsOk, agyStatus] = await Promise.all([
    checkPort(3000),
    checkPort(consolePort),
    checkPort(17864),
    fetchAgyStatus(cfg),
  ]);

  const procs = getAllProcesses();
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));

  const listeners = [];
  for (const p of procs) {
    if (String(p.Name || '').toLowerCase() !== 'node.exe') continue;
    const cmd = String(p.CommandLine || '');
    const info = classifyListener(cmd);
    if (!info) continue;
    listeners.push({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      ...info,
      host: detectHostOwner(p, byPid),
    });
  }

  const workerTurns = readJsonSafe(path.join(ROOT, 'state', 'agy-worker-turns.json')) || {};
  const archiveCursor = readJsonSafe(path.join(ROOT, 'state', 'agy-archive-cursor.json')) || {};

  console.log('=== qq-bridge 实时服务与工作线程状态 ===\n');
  console.log('[1] 底层常驻服务');
  console.log(`  - NapCat 消息网关 (${cfg?.napcat?.account || '未配置账号'} :3000) : ${napcatOk ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`  - qq-bridge 主网桥 (:${consolePort})             : ${bridgeOk ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`  - 本地 Drama3 语音 (:17864)              : ${ttsOk ? `ONLINE (${cfg?.socialV2?.tts?.fish_local?.model || 'drama3'})` : 'OFFLINE (回退云端 API)'}`);
  console.log(`  - 前置分流配置 (.env)                    : 群聊路由模型=${routerCfg.model} (Key=${routerCfg.hasApiKey ? '已配置' : '未配置'}) | 私聊白名单=${routerCfg.ownerIds.length} 个账号`);

  console.log(`\n[2] 当前活跃本地监听线程（共 ${listeners.length} 个）`);
  if (listeners.length === 0) {
    console.log('  (当前没有挂起的监听线程！机器人不会回复消息)');
  } else {
    const counts = {};
    for (const l of listeners) {
      counts[l.key] = (counts[l.key] || 0) + 1;
      console.log(`  - [PID ${String(l.pid).padEnd(6)}] ${l.role.padEnd(26)} | ${l.detail}`);
      console.log(`      所属宿主: ${l.host}`);
    }
    const dupes = Object.entries(counts).filter(([, c]) => c > 1);
    if (dupes.length > 0) {
      console.log(`\n  ⚠️ 警告：检测到重复监听线程 (${dupes.map(([k, c]) => `${k}x${c}`).join(', ')})，建议按 qq-bot-operator 规程清理旧线程！`);
    }
  }

  console.log('\n[3] 累计轮次与前置路由记录');
  console.log(`  - w1 主对话累计轮次    : ${workerTurns.w1 ?? 0} 轮`);
  console.log(`  - 本地记忆归档最新批次 : #${archiveCursor.counter ?? 0}`);
  if (agyStatus) {
    console.log(`  - 网桥群聊路由累计次数 : ${agyStatus.totalRouted ?? 0} 次 (在途 ${agyStatus.inFlightRouters ?? 0})`);
    if (agyStatus.lastRouterDecision) {
      const d = agyStatus.lastRouterDecision;
      console.log(`  - 最近一次群聊路由判定 : 模型=${d.model} (${d.endpoint}, ${d.latencyMs}ms) | should_reply=${d.should_reply} | 触发=${d.trigger} | 原因="${d.reason}"`);
    } else {
      console.log('  - 最近一次群聊路由判定 : 本次网桥启动后暂未触发群聊路由');
    }
  }
}

main().catch((e) => {
  console.error('体检脚本执行出错:', e);
  process.exit(1);
});
