// Antigravity 旁路异步记忆归纳监听脚本（零轮询、零聊天阻塞、满 4 批自动换新防上下文滚雪球）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';

const TURN_STATE_FILE = path.join(ROOT, 'state', 'agy-archive-turns.json');
const DEFAULT_MAX_TURNS = process.env.QQ_BRIDGE_HOST === 'codex' ? 0 : 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function updateArchiveTurnCount(isFreshBoot) {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(TURN_STATE_FILE, 'utf8')) || {}; } catch {}
  const turns = isFreshBoot ? 0 : (Number(prev.turns) || 0) + 1;
  try {
    fs.mkdirSync(path.dirname(TURN_STATE_FILE), { recursive: true });
    fs.writeFileSync(TURN_STATE_FILE, JSON.stringify({ turns, updatedAt: Date.now() }, null, 2), 'utf8');
  } catch {}
  return turns;
}

async function main() {
  const args = process.argv.slice(2);
  const doneIdx = args.indexOf('--done-id');
  let doneId = doneIdx >= 0 && args[doneIdx + 1] ? String(args[doneIdx + 1]).trim() : '';
  const maxIdx = args.indexOf('--max-turns');
  const maxTurns = maxIdx >= 0 && Number.isFinite(Number(args[maxIdx + 1]))
    ? Math.max(0, Number(args[maxIdx + 1]))
    : DEFAULT_MAX_TURNS;

  const turnsCompleted = updateArchiveTurnCount(!doneId);
  if (doneId && maxTurns > 0 && turnsCompleted >= maxTurns) {
    updateArchiveTurnCount(true);
    console.log(`=== ARCHIVE_ROTATE_NEEDED 已满 ${turnsCompleted} 批 ===`);
    console.log(`本次归档 (${doneId}) 已落盘完成。为防止归档线程上下文累积烧额度，请不要再调用任何工具，直接输出一句 "[ROTATE:archive] 已满 ${turnsCompleted} 批，请销毁旧 qq-memory-archivist 并重新拉起新线程" 结束本子代理！`);
    process.exit(0);
  }

  while (true) {
    const cfg = loadConfig();
    const port = Number(cfg.consolePort) || 3100;
    const token = readConsoleToken(cfg);
    const qs = new URLSearchParams({ timeoutMs: '55000' });
    if (doneId) qs.set('doneId', doneId);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/archive-wait?${qs.toString()}`, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(65000),
      });
      if (!res.ok) {
        await sleep(3000);
        continue;
      }
      doneId = '';
      const data = await res.json();
      if (data?.ok && !data.timedOut && data.job) {
        const j = data.job;
        const isPriv = String(j.key || '').startsWith('private:');
        const eventBookFile = j.eventBookPath || j.summaryPath.replace(/[^/\\]+$/, 'event_book.md');
        const maxChars = j.maxChars || (isPriv ? 10000 : 7500);
        const warnChars = j.warnChars || (isPriv ? 8500 : 6500);
        const summaryLen = j.summaryLen ?? 0;
        console.log('=== 长期记忆分舱归纳任务 ===');
        console.log(`JobId       : ${j.id}`);
        console.log(`会话 Key    : ${j.key}`);
        console.log(`目标摘要文件: ${j.summaryPath} (当前 ${summaryLen}/${maxChars} 字 | 预警线 ${warnChars} 字)`);
        if (isPriv) console.log(`详细事件簿  : ${eventBookFile} (无损长效留档库，供按需检索)`);
        if (j.peoplePath && !isPriv) console.log(`群友百字档案: ${j.peoplePath}`);
        console.log(`目标日记目录: ${j.diaryDir}`);
        console.log(`消息范围    : seq ${j.fromSeq} ~ ${j.toSeq}（共 ${j.messages.length} 条）`);
        if (j.quotaWarning) {
          console.log('⚠️ 额度预警 : 已触发 85% 容量预警线！请执行「先沉淀进 event_book.md，再无损压缩常驻摘要」流程！');
        }
        console.log('-------------------');
        for (const m of j.messages) {
          console.log(`[${m.at || ''}] ${m.sender}(${m.userId}): ${m.text}`);
        }
        console.log('-------------------');
        if (isPriv) {
          console.log(`【私聊与 Creator 多层高保真归档指令（常驻摘要 + 详细事件簿 event_book.md + 按日日记 diary/）】
1) 甄别本批次信息：单次无特殊意义的随口流水账直接 SKIP，禁写客服/心理报告八股；
2) 常驻主档 ${j.summaryPath}（上限 ${maxChars} 字，预警线 ${warnChars} 字）：提炼 Creator 的作息与健康状态、情绪倾诉、相处偏好边界、个人项目企划及近期滚动时间线；若触发容量预警，先将较早期详细事件无损沉淀为 ${eventBookFile} 的 \`### [EVT-xx | 日期] 标题\` 条目，再将常驻摘要精炼回安全区间；
3) 详细事件簿 ${eventBookFile} 与按日日记 ${j.diaryDir}：凡有长期记忆点的独立事件追加结构化 `[EVT-编号]` 条目并同步写入单日文件 `diary/YYYY-MM-DD.md`。完成后执行：`);
        } else {
          const peopleFile = j.peoplePath || j.summaryPath.replace(/summary\.md$/i, 'people.md');
          console.log(`【群聊主模型双层归档与重要性过滤指令】
1) 严格区分「重要记忆」与「聊完即 SKIP 的话题」：单人独自吃喝、随手转的新闻或一次性水群直接 SKIP！多人约定/面基/联机、请客欠账 Flag、群友间交易/互助、持久硬件/座驾/乐器/相机装备与核心立场必须完整记录！
2) 维护日常全量常驻文件 ${j.summaryPath}（<= 7500 字：含群总纲、Creator 画像及每位常驻群友约 100 字的日常设定）；
3) 同步维护深度详档 ${peopleFile}（每位常驻群友 200~350 字，合入新事件时严禁删丢原有核心装备与设定！）；
4) 仅将有长期价值的事件写入 ${j.diaryDir}（单日文件 `diary/YYYY-MM-DD.md`）。完成后执行：`);
        }
        console.log(`node "${path.join(ROOT, 'scripts', 'agy-wait-archive.mjs').replace(/\\/g, '/')}" --done-id "${j.id}"`);
        process.exit(0);
      }
    } catch {
      await sleep(3000);
    }
  }
}

main();
