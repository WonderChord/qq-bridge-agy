// Antigravity 多线程极速合一脚本：一步完成「单发或批量多目标并发回信 + 发表情 + 标已读 + 释放当前线程并重回监听池」。
//
// 用法示例（run_command + WaitMsBeforeAsync: 1000，调用后立刻结束当前回合）：
//   1) 单目标快速回信（群聊默认带 --reply 防串行）：
//      node scripts/agy-reply-and-wait.mjs --worker-id w2 --finish-turn "agy-turn-12" --key "group:123456789" --token "<token>" --seq 240 --reply "101" "来啦"
//   2) 一轮同时回复多个群友（--batch JSON 数组，按顺序高速连发不同引用/点名）：
//      node scripts/agy-reply-and-wait.mjs --worker-id w2 --finish-turn "agy-turn-12" --key "group:123456789" --token "<token>" --seq 245 --batch "[{\"reply\":\"101\",\"messages\":[\"第一人回复\"]},{\"reply\":\"102\",\"messages\":[\"第二人回复\"]}]"

import path from 'node:path';
import { ROOT, loadConfig, readConsoleToken, sessionToken } from './bridge-local.mjs';


function parseArgs(argv) {
  const opts = {
    workerId: 'primary',
    priority: '',
    finishTurn: '',
    maxTurns: null,
    key: '',
    token: '',
    seq: null,
    reply: null,
    at: null,
    sticker: null,
    image: null,
    tts: null,
    ttsProvider: null,
    codexDraws: [],
    collectStickers: [],
    batch: null,
    mode: null,
    sleepMs: null,
    noWait: false,
    noReply: false,
    messages: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--worker-id' && i + 1 < argv.length) opts.workerId = String(argv[++i]).trim() || 'primary';
    else if (a === '--priority' && i + 1 < argv.length) opts.priority = String(argv[++i]).trim();
    else if (a === '--finish-turn' && i + 1 < argv.length) opts.finishTurn = String(argv[++i]).trim();
    else if (a === '--max-turns' && i + 1 < argv.length) opts.maxTurns = Number(argv[++i]);
    else if (a === '--key' && i + 1 < argv.length) opts.key = argv[++i];
    else if (a === '--token' && i + 1 < argv.length) opts.token = argv[++i];
    else if (a === '--seq' && i + 1 < argv.length) opts.seq = Number(argv[++i]);
    else if (a === '--reply' && i + 1 < argv.length) opts.reply = argv[++i];
    else if (a === '--at' && i + 1 < argv.length) opts.at = argv[++i];
    else if (a === '--sticker' && i + 1 < argv.length) opts.sticker = argv[++i];
    else if (a === '--image' && i + 1 < argv.length) opts.image = argv[++i];
    else if ((a === '--tts' || a === '--voice') && i + 1 < argv.length) opts.tts = String(argv[++i]).trim();
    else if (a === '--tts-provider' && i + 1 < argv.length) opts.ttsProvider = String(argv[++i]).trim();
    else if (a === '--codex-draw' && i + 1 < argv.length) opts.codexDraws.push(String(argv[++i]));
    else if (a === '--collect-sticker' && i + 1 < argv.length) opts.collectStickers.push(String(argv[++i]));
    else if (a === '--batch' && i + 1 < argv.length) opts.batch = argv[++i];
    else if (a === '--mode' && i + 1 < argv.length) opts.mode = argv[++i];
    else if (a === '--sleep-ms' && i + 1 < argv.length) opts.sleepMs = Number(argv[++i]);
    else if (a === '--no-wait') opts.noWait = true;
    else if (a === '--no-reply' || a === '--silent' || a === '--skip' || a === '--mark-read') opts.noReply = true;
    else if (/^--[a-z]/i.test(a)) {
      // 严禁把模型臆造的未知 CLI flag（如 --quiet 等）当作聊天文本发进 QQ 群！
      throw new Error('未知或缺值的参数：' + a);
    }
    else opts.messages.push(a);
  }
  if (opts.noReply) {
    opts.messages = [];
    opts.batch = null;
    opts.sticker = null;
    opts.image = null;
    opts.tts = null;
    opts.codexDraws = [];
    opts.collectStickers = [];
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postBridge(port, consoleToken, agentToken, route, body) {
  const headers = { 'content-type': 'application/json' };
  if (consoleToken) headers['x-console-token'] = consoleToken;
  if (agentToken) headers['x-agent-token'] = agentToken;
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(route === '/api/socialV2/send-tts' ? 150000 : 20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(`${route} failed (${res.status}): ${data?.error || JSON.stringify(data)}`);
  }
  return data;
}

async function waitNextWakeLoop(port, consoleToken, workerId, priority, finishTurn, maxTurns) {
  let finishFirst = true;
  const effectiveMaxTurns = Number.isFinite(maxTurns)
    ? maxTurns
    : (workerId !== 'primary' ? 25 : 0);
  while (true) {
    const qs = new URLSearchParams({ timeoutMs: '55000', workerId });
    if (priority !== '') qs.set('priority', priority);
    if (effectiveMaxTurns > 0) qs.set('maxTurns', String(effectiveMaxTurns));
    if (finishFirst) {
      if (finishTurn) qs.set('finishTurn', finishTurn);
      qs.set('finishWorker', '1');
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/agy/wait?${qs.toString()}`, {
        headers: consoleToken ? { 'x-console-token': consoleToken } : {},
        signal: AbortSignal.timeout(65000),
      });
      if (!res.ok) {
        await sleep(1500);
        continue;
      }
      finishFirst = false;
      const data = await res.json();
      if (data?.superseded) {
        console.log(`[agy-reply-and-wait] [${workerId}] 旧监听连接已被同线程新回合接管，安全退出。`);
        process.exit(0);
      }
      if (data?.ok && data.rotate) {
        console.log(`=== WORKER_ROTATE_NEEDED [${workerId}] 已满 ${data.turnsCompleted || effectiveMaxTurns} 轮 ===`);
        console.log(`本线程已完成 ${data.turnsCompleted || effectiveMaxTurns} 轮上限并安全下线。请不要再调用任何工具（也不要再启动监听），直接输出一句 "[ROTATE:${workerId}] 已满 ${data.turnsCompleted || effectiveMaxTurns} 轮，请销毁本旧子代理并重新拉起同名新线程 ${workerId}" 结束本子代理，父窗口会自动收到完成通知并为你换新！`);
        process.exit(0);
      }
      if (data?.ok && !data.timedOut && data.wake) {
        const w = data.wake;
        const tokMatch = /(?:【会话令牌】|会话令牌\s*[:：]\s*)([A-Za-z0-9_-]{16,64})/.exec(String(w.text || ''));
        const extractedToken = w.agentToken || (tokMatch ? tokMatch[1] : '');
        console.log(`=== QQ 唤醒 [${workerId}${w.workerTurnIndex ? ` | ${w.workerTurnIndex}/${effectiveMaxTurns || '∞'}` : ''}] Key=${w.key ?? '-'} Turn=${w.turn} Token=${extractedToken || '-'} ===`);
        if (w.imageCount > 0) {
          console.log(`媒体: ${w.imageCount}张（需看图时: node "${path.join(ROOT, 'scripts')}\\agy-get-image.mjs" --key "${w.key}" --token "${extractedToken || '<Token>'}" --msg "<msgId>"）`);
        }
        console.log(w.text);
        process.exit(0);
      }
    } catch {
      await sleep(1500);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.key) opts.token = sessionToken(opts.key, opts.token);
  const cfg = loadConfig();
  const port = Number(cfg.consolePort) || 3100;
  const consoleToken = readConsoleToken(cfg);
  if (opts.finishTurn && opts.key) {
    const claim = await postBridge(port, consoleToken, '', '/api/agy/claim', {
      key: opts.key, token: opts.token, workerId: opts.workerId, turn: opts.finishTurn,
    });
    if (claim.duplicate) {
      console.log('[agy-reply-and-wait] 此回合已有回复任务，重复调用已忽略。');
      return;
    }
  }
  let failed = false;

  if (opts.key && opts.token) {
    try {
    for (const rawSpec of opts.collectStickers) {
      const parts = String(rawSpec || '').split('::').map((s) => s.trim());
      const msgRef = parts[0] || '';
      const note = parts[1] || '';
      const tagsRaw = parts[2] || '';
      const usage = parts[3] || '';
      if (!msgRef) continue;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/collect-sticker', {
          key: opts.key,
          messageId: msgRef,
          remark: note.slice(0, 20),
          note,
          tags: tagsRaw ? tagsRaw.split(/[,，/\s]+/).filter(Boolean) : [],
          usage,
        });
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] 收藏表情未成功 (${msgRef}): ${err?.message ?? err}`);
      }
    }

    if (opts.batch) {
      let items = [];
      // PowerShell 传给原生程序时会吞掉/错位 \" 转义，导致 JSON 截断。依次尝试：原样 → 去反斜杠转义 → 拼回被拆散的位置参数 → 正则抢救。
      const candidates = [opts.batch, opts.batch.replace(/\\+"/g, '"')];
      if (opts.messages.length > 0) {
        const joined = [opts.batch, ...opts.messages].join(' ');
        candidates.push(joined, joined.replace(/\\+"/g, '"'));
      }
      let parsedOk = false;
      for (const c of candidates) {
        try { items = JSON.parse(c); parsedOk = true; break; } catch {}
      }
      if (parsedOk && opts.messages.length > 0) opts.messages = [];
      if (!parsedOk) {
        const raw = [opts.batch, ...opts.messages].join(' ').replace(/\\+"/g, '"');
        opts.messages = [];
        items = [];
        const objRe = /\{[^{}]*\}/g;
        let m;
        while ((m = objRe.exec(raw))) {
          const seg = m[0];
          const reply = /"reply"\s*:\s*"?(\d+)/.exec(seg)?.[1];
          const msgsPart = /"messages"\s*:\s*\[([^\]]*)/.exec(seg)?.[1] ?? /"text"\s*:\s*"([^"]*)/.exec(seg)?.[1] ?? '';
          const msgs = [...String(msgsPart).matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter(Boolean);
          if (!msgs.length && msgsPart && !msgsPart.includes('"')) msgs.push(msgsPart.trim());
          if (msgs.length) items.push({ reply, messages: msgs });
        }
        console.error(`[agy-reply-and-wait] --batch JSON 解析失败，已正则抢救 ${items.length} 组消息`);
      }
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item) continue;
          const msgs = Array.isArray(item.messages)
            ? item.messages
            : (item.text ? [String(item.text)] : []);
          if (msgs.length > 0) {
            const payload = {
              key: opts.key,
              messages: msgs.length === 1 ? msgs[0] : msgs,
            };
            if (opts.finishTurn) payload.turn = opts.finishTurn;
            if (item.reply) payload.replyToMessageId = String(item.reply);
            if (item.at) payload.atUserId = String(item.at);
            try {
              await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-message', payload);
            } catch (err) {
              failed = true;
              console.error(`[agy-reply-and-wait] 批量文本发送警告: ${err?.message ?? err}`);
            }
          }
          if (item.sticker) {
            const sp = { key: opts.key, stickerId: String(item.sticker) };
            if (opts.finishTurn) sp.turn = opts.finishTurn;
            if (msgs.length === 0 && item.reply) sp.replyToMessageId = String(item.reply);
            try {
              await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-sticker', sp);
            } catch (err) {
              failed = true;
              console.error(`[agy-reply-and-wait] 批量表情发送警告 (${item.sticker}): ${err?.message ?? err}`);
            }
          }
          if (item.image) {
            const ip = { key: opts.key, imagePath: String(item.image) };
            if (opts.finishTurn) ip.turn = opts.finishTurn;
            if (msgs.length === 0 && !item.sticker && item.reply) ip.replyToMessageId = String(item.reply);
            try {
              await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-image', ip);
            } catch (err) {
              failed = true;
              console.error(`[agy-reply-and-wait] 批量图片发送警告: ${err?.message ?? err}`);
            }
          }
          if (item.tts || item.voice) {
            const tp = { key: opts.key, text: String(item.tts || item.voice) };
            if (opts.finishTurn) tp.turn = opts.finishTurn;
            if (item.ttsProvider || opts.ttsProvider) tp.provider = String(item.ttsProvider || opts.ttsProvider);
            try {
              await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-tts', tp);
            } catch (err) {
              failed = true;
              console.error(`[agy-reply-and-wait] 批量语音发送警告: ${err?.message ?? err}`);
            }
          }
        }
      }
    }

    if (opts.messages.length > 0) {
      const payload = {
        key: opts.key,
        messages: opts.messages.length === 1 ? opts.messages[0] : opts.messages,
      };
      if (opts.finishTurn) payload.turn = opts.finishTurn;
      if (opts.reply) payload.replyToMessageId = opts.reply;
      if (opts.at) payload.atUserId = opts.at;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-message', payload);
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] 文本发送警告: ${err?.message ?? err}`);
      }
    }
    if (opts.sticker) {
      const sp = { key: opts.key, stickerId: String(opts.sticker) };
      if (opts.finishTurn) sp.turn = opts.finishTurn;
      if (opts.messages.length === 0 && opts.reply) sp.replyToMessageId = opts.reply;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-sticker', sp);
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] 表情发送未成功 (${opts.sticker}，已忽略并继续标已读): ${err?.message ?? err}`);
      }
    }
    if (opts.image) {
      const ip = { key: opts.key, imagePath: String(opts.image) };
      if (opts.finishTurn) ip.turn = opts.finishTurn;
      if (opts.messages.length === 0 && !opts.sticker && opts.reply) ip.replyToMessageId = opts.reply;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-image', ip);
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] 图片发送警告: ${err?.message ?? err}`);
      }
    }
    if (opts.tts) {
      const tp = { key: opts.key, text: String(opts.tts) };
      if (opts.ttsProvider) tp.provider = String(opts.ttsProvider);
      if (opts.finishTurn) tp.turn = opts.finishTurn;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/send-tts', tp);
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] TTS 语音发送警告: ${err?.message ?? err}`);
      }
    }
    for (const rawDraw of opts.codexDraws) {
      const trimmed = String(rawDraw || '').trim();
      if (!trimmed) continue;
      let spec = null;
      if (trimmed.startsWith('{')) {
        try { spec = JSON.parse(trimmed); } catch {}
      }
      if (!spec || typeof spec !== 'object') {
        spec = { prompt: trimmed };
      }
      const drawBody = {
        key: opts.key,
        turn: opts.finishTurn || undefined,
        prompt: String(spec.prompt || '').trim(),
        ...(typeof spec.selfRef === 'boolean' ? { selfRef: spec.selfRef } : {}),
        ...(spec.refMsgId != null ? { refMsgId: String(spec.refMsgId) } : {}),
        ...(spec.asSticker === true ? { asSticker: true } : {}),
        ...(spec.note ? { note: String(spec.note) } : {}),
        ...(spec.tags ? { tags: spec.tags } : {}),
        ...(spec.replyToMessageId || opts.reply ? { replyToMessageId: String(spec.replyToMessageId || opts.reply) } : {}),
      };
      if (!drawBody.prompt) continue;
      try {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/codex-draw', drawBody);
      } catch (err) {
        failed = true;
        console.error(`[agy-reply-and-wait] 外包生图提交未通过: ${err?.message ?? err}`);
      }
    }
    } catch (err) {
      failed = true;
      console.error(`[agy-reply-and-wait] 发送阶段异常 (继续执行标已读防二次提醒唤醒): ${err?.message ?? err}`);
    }

    // 独立保底执行 mark-read / wake-config：即便上面表情短 ID 填错（404）或 batch 异常，
    // 也必须推进已读水位并确认唤醒配置，彻底杜绝 bridge 触发「未设置唤醒条件，发送提醒 (1/2)」双倍空烧！
    try {
      const isGroup = opts.key.startsWith('group:');
      if (opts.mode && (!isGroup || opts.mode === 'diving')) {
        const wc = {
          mode: opts.mode,
          infinite: !(opts.sleepMs > 0),
          batchWindowMs: isGroup ? 2000 : 1000,
        };
        if (opts.sleepMs > 0) wc.sleepMs = opts.sleepMs;
        if (opts.mode === 'active') {
          wc.triggers = { anyMessage: true, atMention: true, nameMention: true, question: true, poke: true };
        } else {
          wc.triggers = {
            anyMessage: false,
            atMention: true,
            nameMention: true,
            keywords: (Array.isArray(cfg.persona?.nameKeywords) ? cfg.persona.nameKeywords : []).concat(Array.isArray(cfg.persona?.ambiguousKeywords) ? cfg.persona.ambiguousKeywords : []),
            question: false,
            poke: false,
            probability: 0.12,
          };
        }
        const body = { key: opts.key, config: wc };
        if (Number.isInteger(opts.seq) && opts.seq >= 0) body.throughSeq = opts.seq;
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/wake-config', body);
      } else if (Number.isInteger(opts.seq) && opts.seq >= 0) {
        await postBridge(port, consoleToken, opts.token, '/api/socialV2/mark-read', {
          key: opts.key,
          turn: opts.finishTurn || undefined,
          throughSeq: opts.seq,
        });
      }
    } catch (err) {
      failed = true;
      console.error(`[agy-reply-and-wait] mark-read 警告: ${err?.message ?? err}`);
    }
  }

  if (opts.noWait) {
    await postBridge(port, consoleToken, '', '/api/agy/complete', { workerId: opts.workerId, turn: opts.finishTurn });
    console.log('[agy-reply-and-wait] 回合已结束（--no-wait）');
    process.exitCode = failed ? 1 : 0;
    return;
  }

  await waitNextWakeLoop(port, consoleToken, opts.workerId, opts.priority, opts.finishTurn, opts.maxTurns);
}

main().catch((err) => {
  console.error('[agy-reply-and-wait] 错误:', err?.message || err);
  process.exit(1);
});
