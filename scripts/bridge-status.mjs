// qq-bridge 实时线程、宿主终端与模型状态体检脚本
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { ROOT, loadConfig } from './bridge-local.mjs';

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

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getAllProcesses() {
  try {
    const psCmd = 'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine | ConvertTo-Json -Compress';
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [arr];
  } catch {
    return [];
  }
}

function detectHostOwner(proc, byPid) {
  let cur = proc;
  const chain = [];
  for (let depth = 0; depth < 10 && cur; depth += 1) {
    const name = String(cur.Name || '').toLowerCase();
    const cmd = String(cur.CommandLine || '');
    chain.push(`${cur.Name}(${cur.ProcessId})`);
    if (/codex-driver\.mjs/i.test(cmd)) {
      let model = '';
      try {
        const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'codex-driver.json'), 'utf8'));
        model = [st.model, st.effort, st.profile].filter(Boolean).join(' ');
      } catch {}
      return `Codex 驱动器 codex-driver (PID ${cur.ProcessId}${model ? `, ${model}` : ''})`;
    }
    if (name === 'claude.exe' || /claude-code/i.test(cmd)) {
      const m = cmd.match(/--model=([^\s"]+)/);
      const reqModel = m ? m[1] : 'claude-code';
      const mapped = /opus-5/i.test(reqModel) ? `${reqModel} -> gemini-4-carbon` : reqModel;
      return `Claude Desktop / Code [${mapped}]`;
    }
    if (name.includes('antigravity') || name.includes('language_server')) {
      return 'Antigravity (AGY 子代理面板)';
    }
    cur = byPid.get(Number(cur.ParentProcessId));
  }
  return `独立后台进程 (${chain.slice(0, 2).join(' <- ')})`;
}

function classifyListener(cmd) {
  if (/agy-wait-wake\.mjs|agy-reply-and-wait\.mjs/i.test(cmd)) {
    const wid = (cmd.match(/--worker-id\s+([^\s"]+)/) || [])[1] || 'primary';
    const isReply = /agy-reply-and-wait\.mjs/i.test(cmd);
    return {
      role: `w1 聊天线程 (${wid})`,
      key: `worker:${wid}`,
      detail: isReply ? '已回信并继续挂起监听' : '初始挂起监听',
    };
  }
  if (/agy-wait-judge\.mjs/i.test(cmd)) {
    const isAutoFlash = /--auto-flash/i.test(cmd);
    const model = cmd.match(/\s--model\s+"?([^\s"]+)/)?.[1];
    const route = model ? `${model}（订阅反代 :8788）` : 'gemini-3.8-flash（:8787 / :8788）';
    return {
      role: 'judge 预筛门控',
      key: 'judge',
      detail: isAutoFlash
        ? `--auto-flash 常驻直连 ${route}`
        : '会话唤醒模式（触发时唤醒父会话模型！）',
    };
  }
  if (/agy-wait-archive\.mjs/i.test(cmd)) {
    return {
      role: 'archivist 记忆归档监听',
      key: 'archivist',
      detail: '达到阈值后启动一次性归档任务',
    };
  }
  return null;
}

async function main() {
  const cfg = loadConfig();
  const [napcatOk, bridgeOk, ttsOk, relay8787Ok, relay8788Ok] = await Promise.all([
    checkPort(3000),
    checkPort(Number(cfg.consolePort) || 3100),
    checkPort(17864),
    checkPort(8787),
    checkPort(8788),
  ]);

  const procs = getAllProcesses();
  const byPid = new Map(procs.map((p) => [Number(p.ProcessId), p]));

  const listeners = [];
  for (const p of procs) {
    if (!/^node(\.exe)?$/i.test(String(p.Name || ''))) continue;
    const cmd = String(p.CommandLine || '');
    const info = classifyListener(cmd);
    if (!info) continue;
    listeners.push({
      pid: p.ProcessId,
      role: info.role,
      key: info.key,
      owner: detectHostOwner(p, byPid),
      detail: info.detail,
    });
  }

  const workerTurns = readJsonSafe(path.join(ROOT, 'state', 'agy-worker-turns.json')) || {};
  const judgeState = readJsonSafe(path.join(ROOT, 'state', 'agy-judge-turns.json')) || {};
  const archiveCursor = readJsonSafe(path.join(ROOT, 'state', 'agy-archive-cursor.json')) || {};

  console.log('=== qq-bridge 实时线程与模型状态 ===\n');
  console.log('[1] 底层常驻服务');
  console.log(`  - NapCat QQ (${cfg?.napcat?.account || '未配置账号'} :3000) : ${napcatOk ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`  - qq-bridge 主网桥 (:3100)            : ${bridgeOk ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`  - 本地 Drama3 语音 (:17864)          : ${ttsOk ? `ONLINE (${cfg?.socialV2?.tts?.fish_local?.model || 'drama3'})` : 'OFFLINE (回退云端 API)'}`);
  console.log(`  - Gemini 本地反代 (:8787 / :8788)     : ${relay8787Ok || relay8788Ok ? `ONLINE (8787=${relay8787Ok ? 'UP' : 'DOWN'}, 8788=${relay8788Ok ? 'UP' : 'DOWN'})` : 'OFFLINE'}`);

  console.log(`\n[2] 当前活跃监听线程（共 ${listeners.length} 个）`);
  if (listeners.length === 0) {
    console.log('  (当前没有任何挂起的监听线程！机器人不会回复消息)');
  } else {
    const counts = {};
    for (const l of listeners) {
      counts[l.key] = (counts[l.key] || 0) + 1;
      console.log(`  - [PID ${l.pid}] ${l.role}`);
      console.log(`      宿主终端 : ${l.owner}`);
      console.log(`      工作模式 : ${l.detail}`);
    }
    const dupes = Object.entries(counts).filter(([, c]) => c > 1);
    if (dupes.length > 0) {
      console.log(`\n  ⚠️ 警告：检测到重复监听线程 (${dupes.map(([k, c]) => `${k}x${c}`).join(', ')})，建议重新执行 qq-bot-operator 清场！`);
    }
  }

  console.log('\n[3] 累计轮次与最近模型核验');
  console.log(`  - w1 聊天累计轮次      : ${workerTurns.w1 ?? 0} 轮`);
  console.log(`  - 记忆归档最新批次     : #${archiveCursor.counter ?? 0}`);
  console.log(`  - judge 预筛模式/轮次  : ${judgeState.mode || '未知'} | 累计 ${judgeState.turns ?? 0} 次`);
  if (judgeState.lastDecision) {
    const d = judgeState.lastDecision;
    console.log(`  - 最近一次预筛实测     : 模型=${d.model} (${d.endpoint}, ${d.latencyMs}ms) | 结果=${d.wake} | 原因=${d.reason} | 触发="${d.target}"`);
  } else {
    console.log('  - 最近一次预筛实测     : 本次启动后暂未触发预筛事件');
  }
}

main();
