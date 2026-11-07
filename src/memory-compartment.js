import { createGroupMemoryIndex } from './group-memory-index.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildStickerContext, buildCompactStickerHint } from './sticker-lib.js';

export function createMemoryCompartments({
  root, cfg, api, archive, localClockText, personaBotName, getSelfUserId, getGroupState,
  readRoleState, roleFilePath, getRoleLimit, currentRoleHintV2, getStickerEntries,
}) {
  const recallIndex = createGroupMemoryIndex();
  const personaCfg = () => cfg.persona ?? {};
  // ── 旁路异步分舱长期记忆归纳通道（零聊天阻塞、物理级防跨群串台） ────────
  // 分舱配置：config.json → persona.memoryCompartments
  //   { "private:10001": { "dir": "memory/owner", "threshold": 40 }, "group:20002": { "dir": "memory/groups/my_group", "threshold": 150 } }
  //   每个舱位 = <dir>/summary.md（长期摘要）+ <dir>/diary/（归纳日记）；多个会话可共用同一个 dir。
  const MEMORY_COMPARTMENTS = new Proxy({}, {
    get(_t, key) {
      const raw = personaCfg().memoryCompartments?.[String(key)];
      if (!raw || typeof raw !== 'object' || !raw.dir) return undefined;
      const dir = path.resolve(root, String(raw.dir));
      return {
        summaryPath: path.join(dir, String(raw.summaryFile || 'summary.md')),
        peoplePath: path.join(dir, String(raw.peopleFile || 'people.md')),
        diaryDir: path.join(dir, 'diary'),
        threshold: Math.max(5, Number(raw.threshold) || (String(key).startsWith('group:') ? 150 : 15)),
      };
    }
  });
  const ARCHIVE_CURSOR_FILE = path.join(root, 'state', 'agy-archive-cursor.json');
  let memoryArchiveCounter = 0;
  const lastArchivedSeqByKey = new Map();
  try {
    if (fs.existsSync(ARCHIVE_CURSOR_FILE)) {
      const saved = JSON.parse(fs.readFileSync(ARCHIVE_CURSOR_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if (Number.isFinite(Number(saved?.counter)) && Number(saved.counter) > 0) {
        memoryArchiveCounter = Math.floor(Number(saved.counter));
      }
      if (saved?.lastArchivedSeq && typeof saved.lastArchivedSeq === 'object') {
        for (const [k, v] of Object.entries(saved.lastArchivedSeq)) {
          if (Number.isFinite(Number(v)) && Number(v) >= 0) lastArchivedSeqByKey.set(k, Math.floor(Number(v)));
        }
      }
    }
  } catch {}

  function saveArchiveCursorState() {
    try {
      fs.mkdirSync(path.dirname(ARCHIVE_CURSOR_FILE), { recursive: true });
      fs.writeFileSync(ARCHIVE_CURSOR_FILE, JSON.stringify({
        counter: memoryArchiveCounter,
        lastArchivedSeq: Object.fromEntries(lastArchivedSeqByKey),
      }, null, 2), 'utf8');
    } catch {}
  }

  function maybeEnqueueMemoryArchiveV2(key, st, { force = false, minMessages = 10, triggerReason = 'periodic' } = {}) {
    const comp = MEMORY_COMPARTMENTS[key];
    if (!api.isAgyBackend || !comp || !st) return;
    const isGroupKey = String(key).startsWith('group:');
    const latestSeq = Number(st.lastUnreadSeq) || 0;
    if (!lastArchivedSeqByKey.has(key)) {
      lastArchivedSeqByKey.set(key, latestSeq);
      saveArchiveCursorState();
      return;
    }
    const prevSeq = lastArchivedSeqByKey.get(key) || 0;
    const delta = latestSeq - prevSeq;
    const defaultMin = isGroupKey ? 10 : 5;
    const requiredDelta = force ? Math.max(1, Number(minMessages) || defaultMin) : comp.threshold;
    if (delta < requiredDelta) return;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const firstNewHuman = recent.find((m) => m && Number.isSafeInteger(m.seq) && m.seq > prevSeq);
    const minSelfTime = firstNewHuman?.time ? Number(firstNewHuman.time) - 1000 : 0;
    const creatorSet = new Set([
      ...(Array.isArray(personaCfg().creatorUids) ? personaCfg().creatorUids.map(String) : []),
      ...(cfg.ownerQQ ? [String(cfg.ownerQQ)] : []),
    ]);
    const maxTextLen = isGroupKey ? 260 : 500;
    const batch = recent
      .filter((m) => {
        if (!m) return false;
        if (Number.isSafeInteger(m.seq)) return m.seq > prevSeq;
        return m.isSelf && minSelfTime > 0 && Number(m.time || 0) >= minSelfTime;
      })
      .slice(-100)
      .map((m) => {
        const uid = m.isSelf ? String(getSelfUserId() || '') : String(m.userId || '');
        const isCreator = !m.isSelf && creatorSet.has(uid);
        const baseSender = m.isSelf ? `${personaBotName()}(你)` : String(m.sender || m.userId || '群友');
        return {
          seq: m.seq ?? null,
          at: m.time ? localClockText(m.time) : '',
          sender: isCreator ? `[Creator/墨宝] ${baseSender}` : baseSender,
          userId: uid,
          text: String(m.text || m.plain || '').slice(0, maxTextLen),
        };
      });
    lastArchivedSeqByKey.set(key, latestSeq);
    saveArchiveCursorState();
    if (batch.length < Math.min(isGroupKey ? 6 : 4, requiredDelta)) return;
    const job = {
      id: `archive-${++memoryArchiveCounter}`,
      key,
      triggerReason,
      fromSeq: prevSeq + 1,
      toSeq: latestSeq,
      summaryPath: comp.summaryPath.replace(/\\/g, '/'),
      peoplePath: comp.peoplePath.replace(/\\/g, '/'),
      diaryDir: comp.diaryDir.replace(/\\/g, '/'),
      messages: batch,
      createdAt: new Date().toISOString(),
    };
    saveArchiveCursorState();
    archive.enqueue(job);
  }

  const loadedSlots = new Map();
  const agyLastRoleSig = new Map();
  const agyLastMemSig = new Map();
  const agyLastStickerSig = new Map();
  const agyMountedMembers = new Map();
  const peopleCache = new Map();

  function parsePeopleProfiles(peoplePath) {
    if (!peoplePath || !fs.existsSync(peoplePath)) return { mtimeMs: 0, profiles: [] };
    try {
      const stat = fs.statSync(peoplePath);
      const cached = peopleCache.get(peoplePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached;
      }
      const raw = fs.readFileSync(peoplePath, 'utf8');
      const profiles = [];
      for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith('- ')) continue;
        const m = /^-\s+`([^`]+)`\s*[（(]([^）)]+)[）)]\s*[：:]\s*(.+)$/.exec(line);
        if (!m) continue;
        const [, titleRaw, metaRaw, bodyRaw] = m;
        if (/^其他活跃群友/.test(titleRaw)) {
          // 拆解「其他活跃群友速查」子条目，使其同样支持按需巡回
          const subParts = bodyRaw.split(/[；;]\s*/).filter(Boolean);
          for (const sub of subParts) {
            const sm = /`([^`]+)`\s*[（(](\d{6,12})[，,\s]*(.+?)[）)]/.exec(sub);
            if (sm) {
              const sName = sm[1].trim();
              const sUid = sm[2].trim();
              profiles.push({
                id: sUid,
                uids: [sUid],
                names: [sName.toLowerCase()],
                keywords: [],
                text: `- \`${sName}\`（${sUid}）：${sm[3].trim()}`,
              });
            }
          }
          continue;
        }
        const uids = [...metaRaw.matchAll(/\b(\d{6,12})\b/g)].map((x) => x[1]);
        const names = new Set(
          titleRaw
            .split(/[\/|,，、]+/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        );
        const keywords = new Set();
        for (const seg of metaRaw.split('|').slice(1)) {
          const isKw = /关键词/.test(seg);
          const cleaned = seg.replace(/^[^:：]+[:：]/, '');
          for (const item of cleaned.split(/[,，、\/]+/)) {
            const w = item.trim().toLowerCase();
            if (!w) continue;
            if (isKw) keywords.add(w);
            else names.add(w);
          }
        }
        const id = uids[0] || [...names][0] || String(profiles.length);
        profiles.push({
          id,
          uids,
          names: [...names],
          keywords: [...keywords],
          text: line.replace(/^-\s+/, ''),
        });
      }
      const next = { mtimeMs: stat.mtimeMs, size: stat.size, profiles };
      peopleCache.set(peoplePath, next);
      return next;
    } catch {
      return { mtimeMs: 0, profiles: [] };
    }
  }

  function recallGroupMembersForGroupWakeV2(wid, key, comp) {
    if (!String(key).startsWith('group:') || !comp?.peoplePath) return '';
    const { mtimeMs, profiles } = parsePeopleProfiles(comp.peoplePath);
    if (!profiles.length) return '';
    const st = getGroupState?.(key);
    const unread = Array.isArray(st?.unread) ? st.unread.filter((m) => m && !m.isSelf) : [];
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages.filter((m) => m && !m.isSelf) : [];
    const recentTail = recent.slice(-8);
    const activeCorpus = [...unread, ...recent.slice(-4)]
      .map((m) => `${m.sender || ''} ${m.plain || m.text || ''}`)
      .join(' ')
      .toLowerCase();

    const unreadUids = new Set(unread.map((m) => String(m.userId || '')));
    const recentUids = new Set(recentTail.map((m) => String(m.userId || '')));

    const slotKey = `${wid}::${key}`;
    let tracker = agyMountedMembers.get(slotKey);
    if (!tracker || tracker.mtimeMs !== mtimeMs) {
      tracker = { mtimeMs, wakeSeq: 0, mountedAt: new Map(), cursor: 0 };
      agyMountedMembers.set(slotKey, tracker);
    }
    tracker.wakeSeq += 1;

    const scored = [];
    for (const p of profiles) {
      let score = 0;
      const isUnreadSpeaker = p.uids.some((u) => unreadUids.has(u));
      const isRecentSpeaker = p.uids.some((u) => recentUids.has(u));
      if (isUnreadSpeaker) score += 12;
      else if (isRecentSpeaker) score += 5;

      for (const nm of p.names) {
        if (!nm) continue;
        if (nm.length >= 2 && activeCorpus.includes(nm)) {
          score += 9;
          break;
        } else if (nm.length === 1 && (activeCorpus.includes(`@${nm}`) || activeCorpus.includes(`${nm}：`))) {
          score += 9;
          break;
        }
      }
      for (const kw of p.keywords) {
        if (kw && kw.length >= 2 && activeCorpus.includes(kw)) {
          score += 4;
        }
      }
      if (score > 0) {
        const prevWake = tracker.mountedAt.get(p.id);
        // 已在本线程挂载过的群友，除非间隔 >= 12 轮且再次直接发言，否则不重复注入以保护 KV 缓存与上下文
        if (prevWake != null && !(isUnreadSpeaker && tracker.wakeSeq - prevWake >= 12)) {
          continue;
        }
        scored.push({ profile: p, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, 4).map((x) => x.profile);

    // 若本轮刚换新或主动冒泡且尚无特定高分命中，按游标巡回补充 2 名常驻群友的深度详档
    if (selected.length < 2 && profiles.length > 0 && tracker.mountedAt.size < profiles.length) {
      for (let i = 0; i < profiles.length && selected.length < 2; i++) {
        const idx = (tracker.cursor + i) % profiles.length;
        const cand = profiles[idx];
        if (!tracker.mountedAt.has(cand.id) && !selected.includes(cand)) {
          selected.push(cand);
          tracker.cursor = (idx + 1) % profiles.length;
        }
      }
    }

    for (const p of selected) {
      tracker.mountedAt.set(p.id, tracker.wakeSeq);
    }

    // 同时按当前未读话题检索历史日记（diary/*.md）中的高相关往事（如过往约定、同游、名场面）
    const diaryHits = [];
    const unreadQuery = unread.map((m) => String(m.plain || m.text || '')).join(' ').trim().toLowerCase();
    if (unreadQuery.length >= 2) {
      try {
        const terms = recallTerms(unreadQuery);
        const index = recallIndex.load(key, comp);
        const matches = matchingEntities(unreadQuery, index.entities);
        for (const { tag, date, lines } of index.sources) {
          if (tag === '常驻' || tag === '百字档案') continue;
          const ageDays = date == null ? Infinity : Math.max(0, (Date.now() - date) / 86_400_000);
          const recency = 1 / (1 + ageDays / 14);
          for (const line of lines) {
            const sc = scoreRecall(line, terms, matches, false);
            if (sc >= 6) {
              diaryHits.push({ score: sc + recency, text: `[${tag}] ${line.slice(0, 180)}` });
            }
          }
        }
        diaryHits.sort((a, b) => b.score - a.score);
      } catch {}
    }
    const topDiary = [...new Set(diaryHits.map((h) => h.text))].slice(0, 3);

    if (!selected.length && !topDiary.length) return '';
    let out = `【本轮视情况巡回挂载的深度详档与历史记忆（比日常百字设定更详细，含具体装备/人际约定/名场面）】\n`;
    for (const p of selected) {
      out += `- ${p.text}\n`;
    }
    for (const d of topDiary) {
      out += `- [历史日记巡回] ${d}\n`;
    }
    return `${out}\n`;
  }

  function clearWorkerHotReloadSigsV2(workerId) {
    if (!workerId) {
      loadedSlots.clear();
      agyLastRoleSig.clear();
      agyLastMemSig.clear();
      agyLastStickerSig.clear();
      agyMountedMembers.clear();
      return;
    }
    const prefix = `${workerId}::`;
    for (const k of loadedSlots.keys()) if (k.startsWith(prefix)) loadedSlots.delete(k);
    for (const k of [...agyLastRoleSig.keys()]) {
      if (k.startsWith(prefix)) agyLastRoleSig.delete(k);
    }
    for (const k of [...agyLastMemSig.keys()]) {
      if (k.startsWith(prefix)) agyLastMemSig.delete(k);
    }
    for (const k of [...agyLastStickerSig.keys()]) {
      if (k.startsWith(prefix)) agyLastStickerSig.delete(k);
    }
    for (const k of [...agyMountedMembers.keys()]) {
      if (k.startsWith(prefix)) agyMountedMembers.delete(k);
    }
  }

  function buildWorkerHotReloadPrefixV2(workerId, key) {
    if (!key) return '';
    const wid = String(workerId || 'primary').trim() || 'primary';
    const slotKey = `${wid}::${key}`;
    loadedSlots.set(slotKey, { workerId: wid, key });
    let prefix = '';
    const roleState = readRoleState();
    if (roleState.role) {
      try {
        const rf = roleFilePath(roleState.role);
        const stat = fs.statSync(rf);
        const sig = [roleState.role, stat.mtimeMs, stat.size, getRoleLimit()].join(':');
        if (agyLastRoleSig.get(slotKey) !== sig) {
          const cardText = currentRoleHintV2();
          agyLastRoleSig.set(slotKey, sig);
          if (cardText) {
            prefix += `【角色卡已热更新：${roleState.role}（请立即以此最新人设为准，覆盖旧习惯）】\n${cardText}\n\n`;
          }
        }
      } catch {}
    } else if (agyLastRoleSig.delete(slotKey)) {
      prefix += '【角色卡已清除】从本轮起使用默认身份。\n\n';
    }
    const comp = MEMORY_COMPARTMENTS[key];
    const isGroupKey = String(key).startsWith('group:');
    const rawGroupCfg = personaCfg().memoryCompartments?.[String(key)];
    const privComp = isGroupKey && rawGroupCfg?.includePrivate !== false
      ? (MEMORY_COMPARTMENTS[`private:${cfg.ownerQQ}`]
        || (() => {
          const privKey = Object.keys(personaCfg().memoryCompartments || {}).find((k) => k.startsWith('private:'));
          return privKey ? MEMORY_COMPARTMENTS[privKey] : undefined;
        })())
      : undefined;
    const hasOwnMem = Boolean(comp && fs.existsSync(comp.summaryPath));
    const hasPrivMem = Boolean(privComp && privComp.summaryPath !== comp?.summaryPath && fs.existsSync(privComp.summaryPath));
    if (hasOwnMem || hasPrivMem) {
      try {
        const ownMtime = hasOwnMem ? String(fs.statSync(comp.summaryPath).mtimeMs) : '0';
        const privMtime = hasPrivMem ? String(fs.statSync(privComp.summaryPath).mtimeMs) : '0';
        const combinedMemSig = `${ownMtime}:${privMtime}`;
        if (agyLastMemSig.get(slotKey) !== combinedMemSig) {
          if (hasOwnMem) {
            const maxOwnChars = isGroupKey ? 7500 : 4800;
            const memText = fs.readFileSync(comp.summaryPath, 'utf8').trim().slice(0, maxOwnChars);
            if (memText) {
              const title = isGroupKey
                ? `【本群日常常驻记忆（含群总纲、Creator画像及全员百字设定，仅限 ${key} 使用）】`
                : `【本会话分舱长期记忆精华（Creator 私聊记忆）】`;
              prefix += `${title}\n${memText}\n\n`;
            }
          }
          if (hasPrivMem) {
            const privText = fs.readFileSync(privComp.summaryPath, 'utf8').trim().slice(0, 3400);
            if (privText) {
              prefix += `【单向挂载：Creator 私聊长期记忆（群内与 Creator 互动时共享默契背景，但私密细节勿向无关群友外泄）】\n${privText}\n\n`;
            }
          }
          agyLastMemSig.set(slotKey, combinedMemSig);
        }
      } catch {}
    } else {
      agyLastMemSig.delete(slotKey);
    }
    if (isGroupKey && comp) {
      prefix += recallGroupMembersForGroupWakeV2(wid, key, comp);
    }
    const stickerEntries = getStickerEntries();
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    if (stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false && stickerEntries.length > 0) {
      const stickerSlotKey = `${wid}::stickers`;
      const maxS = stickerCfg.promptMaxStickers ?? 48;
      const stickerSig = crypto.createHash('sha1').update(
        stickerEntries.slice(0, maxS).map((s) => `${s.md5 || s.id}:${s.localNote || s.desc || ''}`).join('|')
      ).digest('hex').slice(0, 16);
      if (agyLastStickerSig.get(stickerSlotKey) !== stickerSig) {
        const fullStickerCtx = buildStickerContext(stickerEntries, maxS);
        agyLastStickerSig.set(stickerSlotKey, stickerSig);
        if (fullStickerCtx) {
          prefix += `【本线程表情夹清单（旧历史短 ID 如 C76FD5B1 已作废，请严格只使用下方最新清单里的 8 位短 ID）】\n${buildCompactStickerHint()}\n${fullStickerCtx}\n\n`;
        }
      }
    }
    return prefix;
  }

  function recallGroupMemoryForPrivateV2(key, st) {
    if (!String(key).startsWith('private:') || !st) return '';
    const unread = (st.unread || []).filter((m) => m && !m.isSelf);
    const latest = unread.length ? unread : (st.recentMessages || []).filter((m) => m && !m.isSelf).slice(-1);
    // 只用本次来信决定是否巡回。上一轮聊过群友，不能让这一轮「晚安」也带出群内信息。
    let query = latest.map((m) => String(m.plain || m.text || '')).join(' ').trim().toLowerCase();
    const persona = personaCfg();
    const ownNames = [personaBotName(), ...(persona.nameKeywords || []), ...(persona.creatorNickKeywords || [])];
    for (const name of ownNames) {
      const word = String(name || '').trim().toLowerCase();
      if (word) query = query.replaceAll(word, ' ');
    }
    query = query.trim();
    if (!query || PRIVATE_RECALL_STOPWORDS.has(query)) return '';
    const terms = recallTerms(query);
    const explicit = /(?:群里|海沟|higo|群友|水群|那群人|那帮人|他们.*聊|都在聊|群.*聊|在群|群动态)/i.test(query);
    const groups = Object.entries(personaCfg().memoryCompartments || {}).filter(([key, comp]) => key.startsWith('group:') && comp?.dir);
    recallIndex.retain(groups.map(([key]) => key));
    const bullets = [];
    const live = [];
    for (const [gKey, raw] of groups) {
      const comp = MEMORY_COMPARTMENTS[gKey];
      const name = String(raw.groupName || raw.name || raw.label || path.basename(path.dirname(comp.diaryDir)));
      const source = name === gKey ? gKey : name + ' ' + gKey;
      const mentionsGroup = explicit || query.includes(gKey) || (name.length >= 2 && query.includes(name.toLowerCase()));
      const index = recallIndex.load(gKey, comp);
      const recent = getGroupState(gKey)?.recentMessages || [];
      const entities = new Set(index.entities);
      for (const m of recent) if (m && !m.isSelf && m.sender) entities.add(String(m.sender).trim().toLowerCase());
      const matches = matchingEntities(query, entities);
      const start = bullets.length;
      for (const { tag, date, lines } of index.sources) {
        // 小于一个关键词命中分，只用于打破相关度相近的日记之间的平局。
        const ageDays = date == null ? Infinity : Math.max(0, (Date.now() - date) / 86_400_000);
        const recency = 1 / (1 + ageDays / 14);
        for (const line of lines) {
          const score = scoreRecall(line, terms, matches, mentionsGroup);
          if (score >= 4) bullets.push({ score: score + recency, text: '[' + source + '/' + tag + '] ' + line.slice(0, 160) });
        }
      }
      if (mentionsGroup && bullets.length === start && index.newestDiary) {
        for (const line of index.newestDiary.lines.slice(-3)) {
          bullets.push({ score: 3, text: '[' + source + '/' + index.newestDiary.tag + '] ' + line.slice(0, 160) });
        }
      }
      for (const m of recent.slice(mentionsGroup ? -6 : -30)) {
        if (!m) continue;
        const txt = String(m.plain || m.text || '').replace(/\s+/g, ' ').trim();
        const sender = m.sender || m.userId || '群友';
        const score = scoreRecall(sender + ' ' + txt, terms, matches, mentionsGroup);
        if (txt && (mentionsGroup || score >= 4)) {
          live.push({ score, time: Number(m.time) || 0, text: '[' + source + '/群近期 ' + localClockText(m.time) + '] ' + sender + ': ' + txt.slice(0, 80) });
        }
      }
    }
    bullets.sort((a, b) => b.score - a.score);
    live.sort((a, b) => b.score - a.score || b.time - a.time);
    const top = (hits) => [...new Set(hits.map((hit) => hit.text))].slice(0, 5);
    const entries = [...top(bullets), ...top(live)];
    if (!entries.length) return '';
    const heading = '\n【私聊按需巡回的群聊记忆与近期动态（仅当 Creator 问及或话题相关时按需回应，平时不主动硬扯）】\n';
    return (heading + entries.map((line) => '- ' + line).join('\n')).slice(0, 800);
  }

  return {
    maybeEnqueueMemoryArchiveV2, buildWorkerHotReloadPrefixV2,
    clearWorkerHotReloadSigsV2, recallGroupMemoryForPrivateV2, close: recallIndex.close,
    loadedSignatures: () => [...loadedSlots].map(([slot, { workerId, key }]) => ({
      workerId, key, role: agyLastRoleSig.get(slot) ?? null, memory: agyLastMemSig.get(slot) ?? null,
      stickers: agyLastStickerSig.get(workerId + '::stickers') ?? null,
    })),
  };
}

const PRIVATE_RECALL_STOPWORDS = new Set([
  '什么', '怎么', '为什么', '今天', '昨天', '刚才', '最近', '现在', '那个', '这个',
  '一个', '一下', '不是', '没有', '可以', '就是', '还是', '觉得', '知道', '看到',
  '听到', '出来', '进去', '哈哈', '真的', '其实', '而且', '不过', '如果', '因为',
  '所以', '喜欢', '讨厌', '感觉', '自己', '我们', '你们', '他们', '主人',
  '表情', '语音', '私聊', '抱抱', '亲亲', '睡觉',
  '晚安', '早安', '干嘛', '在吗', '干活', '说话', '起来', '看看', '说说', '哪里',
  '哪个', '多少', '时候', '已经', '一直', '突然', '到底', '居然', '竟然', '简直',
]);

const ASCII_IGNORE = new Set(['creator', 'qq', 'ai', 'ok', 'bot', 'http', 'https', 'com', 'cn']);

function recallTerms(query) {
  const ascii = new Set((query.match(/[a-z0-9]{2,}/g) || []).filter((t) => !ASCII_IGNORE.has(t) && !/^\d{6,}$/.test(t)));
  const bigrams = new Set();
  const trigrams = new Set();
  for (const run of query.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (!PRIVATE_RECALL_STOPWORDS.has(bg) && !bg.includes('群')) bigrams.add(bg);
      const tg = run.slice(i, i + 3);
      if (tg.length === 3 && !PRIVATE_RECALL_STOPWORDS.has(tg)) trigrams.add(tg);
    }
  }
  return { ascii, bigrams, trigrams };
}

function matchingEntities(query, entities) {
  const matches = [];
  for (const name of entities) {
    if (name.length < 2 || PRIVATE_RECALL_STOPWORDS.has(name) || /^(?:creator$|group:|private:|\d+$)/i.test(name)) continue;
    const tail = name.slice(-2);
    if (query.includes(name)) matches.push({ name, weight: 6 });
    else if (name.length > 2 && /^[\u4e00-\u9fff]{2}$/.test(tail) && query.includes(tail)) matches.push({ name, weight: 5 });
  }
  return matches;
}

function scoreRecall(line, terms, matches, explicit) {
  const text = line.toLowerCase();
  let score = 0;
  for (const { name, weight } of matches) if (text.includes(name)) score += weight;
  for (const word of terms.ascii) if (text.includes(word)) score += 4;
  for (const word of terms.trigrams) if (text.includes(word)) score += 4;
  let pairs = 0;
  for (const word of terms.bigrams) if (text.includes(word)) pairs++;
  if (pairs >= 2) score += pairs * 3;
  else if (pairs && (explicit || terms.ascii.size)) score += 2;
  return score;
}
