// Antigravity 旁路异步记忆归纳监听脚本（零轮询、零聊天阻塞）。
import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken } from './bridge-local.mjs';


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const doneIdx = args.indexOf('--done-id');
  let doneId = doneIdx >= 0 && args[doneIdx + 1] ? String(args[doneIdx + 1]).trim() : '';

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
        console.log(`=== 长期记忆分舱归纳任务 ===`);
        console.log(`JobId       : ${j.id}`);
        console.log(`会话 Key    : ${j.key}`);
        console.log(`目标摘要文件: ${j.summaryPath}`);
        if (j.peoplePath) console.log(`群友百字档案: ${j.peoplePath}`);
        console.log(`目标日记目录: ${j.diaryDir}`);
        console.log(`消息范围    : seq ${j.fromSeq} ~ ${j.toSeq}（共 ${j.messages.length} 条）`);
        console.log(`-------------------`);
        for (const m of j.messages) {
          console.log(`[${m.at || ''}] ${m.sender}(${m.userId}): ${m.text}`);
        }
        console.log(`-------------------`);
        const isPriv = String(j.key || '').startsWith('private:');
        if (isPriv) {
          console.log(`【私聊与 Creator 高保真详尽归档指令】请甄别本批次信息：单次无特殊意义的随口流水账直接 SKIP；凡涉及 Creator 的身心健康与作息状态、情绪倾诉、相处偏好与边界约定、个人项目企划及重要约定，请详尽提炼进 ${j.summaryPath}（<= 6500 字）并追加到 ${j.diaryDir}。完成后执行：`);
        } else {
          const peopleFile = j.peoplePath || j.summaryPath.replace(/summary\.md$/i, 'people.md');
          console.log(`【群聊主模型双层归档与重要性过滤指令】
1) 严格区分「重要记忆」与「聊完即 SKIP 的话题」：某人今天独自吃了什么饭/喝了什么饮料、随手转的新闻或一次性水群，聊完直接 SKIP，严禁写入长期设定！但「谁和谁约好一起吃什么/去哪玩」、「哪几个人一起去吃了什么/面基/联机」、「立下的请客欠账 Flag」、「群友间借号/交易/互助」以及「持久的硬件/座驾/乐器/相机装备与核心立场」必须完整记录！
2) 维护日常全量常驻文件 ${j.summaryPath}（<= 7500 字：含群总纲、Creator画像及每位常驻群友约 100 字的日常设定）；
3) 同步维护视情况巡回的深度详档 ${peopleFile}（每位常驻群友 200~350 字，含详细装备拓扑、人际交集约定与历史名场面，合入新重要事件时严禁删丢原有核心装备与设定！）；
4) 仅将有长期价值的事件写入 ${j.diaryDir}。完成后执行：`);
        }
        console.log(`node "${path.join(ROOT, 'scripts')}\\agy-wait-archive.mjs" --done-id "${j.id}"`);
        process.exit(0);
      }
    } catch {
      await sleep(3000);
    }
  }
}

main();
