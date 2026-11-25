// w1 委托后台搜索助手快查 CLI：
// 若配置启用且 qq-search-worker 在线，由独立子代理多源深查并只返回精炼干货，保持 w1 上下文干净；
// 若已关闭多线程分流或子代理离线，自动无损降级本机 webSearch。
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';
import { webSearch } from '../src/web-search.js';

const query = process.argv.slice(2).join(' ')
  .replace(/\[CQ:[^\]]*\]/gi, ' ')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 180);

if (!query) {
  console.error('请提供需要核实的公开检索问题或关键词。');
  process.exit(1);
}

const cfg = loadConfig();
const port = Number(cfg.consolePort) || 3100;
const token = readConsoleToken(cfg);
const searchTimeoutMs = Number(cfg?.socialV2?.helpers?.searchTimeoutMs) || 36000;

let delegatedOk = false;
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/agy/helper-submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-console-token': token } : {}),
    },
    body: JSON.stringify({
      role: 'search',
      requireOnline: true,
      waitResult: true,
      timeoutMs: searchTimeoutMs,
      payload: { mode: 'sync', query },
    }),
    signal: AbortSignal.timeout(searchTimeoutMs + 4000),
  });
  if (res.ok) {
    const data = await res.json();
    if (data?.ok && data.completed && data.result?.summary) {
      console.log(String(data.result.summary).trim());
      delegatedOk = true;
    }
  }
} catch {}

if (!delegatedOk) {
  try {
    const { results } = await webSearch(query, { root: ROOT, config: { timeoutMs: 14000, maxResults: 5 } });
    console.log(results.length ? JSON.stringify(results) : '没有找到搜索结果。');
  } catch {
    console.error('搜索暂时不可用。');
    process.exitCode = 1;
  }
}
