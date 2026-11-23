// 轻量防卡死巡检脚本（供 Antigravity 30 分钟低频 schedule 定时器或人工排查调用）
// 若发现 w1 在途回合超过 450 秒（7.5 分钟）未完成，或无监听进程但有积压唤醒，自动将回合回退重排并输出 STUCK。
import { loadConfig, readConsoleToken } from './bridge-local.mjs';

const STUCK_MS = 450_000;

async function main() {
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const token = readConsoleToken(cfg);
  const headers = token ? { 'x-console-token': token, 'content-type': 'application/json' } : { 'content-type': 'application/json' };

  const res = await fetch(`http://127.0.0.1:${port}/api/agy/status`, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  const st = await res.json();
  const now = Date.now();
  const activeTurns = Array.isArray(st.activeTurns) ? st.activeTurns : [];
  const stuckTurn = activeTurns.find((t) => t.workerId === 'w1' && (now - Number(t.startedAt || 0) > STUCK_MS));

  if (stuckTurn) {
    await fetch(`http://127.0.0.1:${port}/api/agy/requeue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ turn: stuckTurn.turn, workerId: 'w1' }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
    console.log(`STUCK: w1 在回合 ${stuckTurn.turn} 已卡住 ${Math.round((now - Number(stuckTurn.startedAt)) / 1000)}s，已自动回退未读切片，请立即 kill 旧 w1 并重拉新 w1！`);
    return;
  }

  if (Number(st.waitingListeners) === 0 && activeTurns.every((t) => !t.workerId) && (Number(st.queuedWakes) > 0 || activeTurns.length > 0)) {
    console.log(`STUCK: 当前无活跃 w1 监听连接且有 ${st.queuedWakes || activeTurns.length} 条待处理唤醒，请立即 kill 挂死旧 w1 并重拉新 w1！`);
    return;
  }

  console.log(`OK: listeners=${st.waitingListeners || 0} active=${activeTurns.length} queued=${st.queuedWakes || 0}`);
}

main().catch((err) => {
  console.log(`WARN: ${err?.message || err}`);
});
