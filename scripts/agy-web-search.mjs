import { ROOT } from './bridge-local.mjs';
import { webSearch } from '../src/web-search.js';

const query = process.argv.slice(2).join(' ')
  .replace(/\[CQ:[^\]]*\]/gi, ' ')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120);

if (!query) {
  console.error('请提供公开检索词。');
  process.exit(1);
}

// 给聊天回合留出处理结果和回信的时间。
const deadline = setTimeout(() => {
  console.error('搜索超时。');
  process.exit(1);
}, 20_000);

try {
  const { results } = await webSearch(query, { root: ROOT, config: { timeoutMs: 12_000, maxResults: 4 } });
  console.log(results.length ? JSON.stringify(results) : '没有找到搜索结果。');
} catch {
  console.error('搜索暂时不可用。');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
