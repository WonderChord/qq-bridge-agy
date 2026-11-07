// 已投递的切片由 turn 独占，重连时把这份快照和锁一起移交。
export function createTurnClaims(api, getSessionId) {
  const agyClaimedSeq = new WeakMap();
  function getAgyClaimedSeq(key, st) {
    const sid = getSessionId(key);
    if (!sid || api.activeTurnCount(sid) === 0) agyClaimedSeq.delete(st);
    return Math.max(agyClaimedSeq.get(st) || 0, Number(st.lastReadThroughSeq) || 0);
  }

  const agyTurnDefaultReply = new Map();
  const slices = new Map();
  const agyClaimedMsgOwner = new Map();
  const agyRepliedTargetIds = new Map();
  const agyTurnActionClaims = new Map();
  const agyRecentOutboundByKey = new Map();

  function normalizeOutboundDedupTextV2(raw) {
    return String(raw ?? '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
  }

  function checkTurnActionV2(key, turnRaw, actionSig) {
    const turn = String(turnRaw ?? '').trim();
    if (!turn) return null;
    if (api.isAgyBackend && !api.isTurnActive(turn, getSessionId(key) || null)) {
      return `唤醒回合 ${turn} 已完结，拦截重复重放`;
    }
    const now = Date.now();
    for (const [k, at] of agyTurnActionClaims.entries()) {
      if (now - at > 1_800_000) agyTurnActionClaims.delete(k);
    }
    const claimKey = `${key}::${turn}::${actionSig}`;
    if (agyTurnActionClaims.has(claimKey)) {
      return `同一回合 ${turn} 相同内容已提交过`;
    }
    return null;
  }

  // 同一同步调用栈内先做防重/限频校验，再在实际投递前占位。请求进行中也不能重播。
  function recordTurnAction(key, turn, actionSig) {
    if (turn) agyTurnActionClaims.set([key, String(turn).trim(), actionSig].join('::'), Date.now());
  }

  function claimOutboundUniqueMessagesV2(key, st, messages) {
    const now = Date.now();
    let hist = agyRecentOutboundByKey.get(key);
    if (!hist) {
      hist = [];
      const seedList = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
      for (const m of seedList.slice(-40)) {
        if (!m || !m.isSelf || m.sticker) continue;
        const raw = String(m.plain || m.text || '').trim();
        if (!raw || raw.startsWith('[表情包:') || raw.startsWith('[图片:')) continue;
        const ts = Number(m.time) || 0;
        if (ts > 0 && now - ts < 600_000) {
          hist.push({ raw, norm: normalizeOutboundDedupTextV2(raw), at: ts });
        }
      }
      agyRecentOutboundByKey.set(key, hist);
    }
    for (let i = hist.length - 1; i >= 0; i -= 1) {
      if (now - hist[i].at > 600_000) hist.splice(i, 1);
    }
    const accepted = [];
    const addedEntries = [];
    for (const m of Array.isArray(messages) ? messages : []) {
      const raw = String(m ?? '').trim();
      if (!raw) continue;
      const norm = normalizeOutboundDedupTextV2(raw);
      const isDup = hist.some((h) => {
        if (h.raw === raw && now - h.at < 90_000) return true;
        if (norm.length >= 4 && h.norm === norm && now - h.at < 600_000) return true;
        return false;
      });
      if (isDup) continue;
      const entry = { raw, norm, at: now };
      hist.push(entry);
      addedEntries.push(entry);
      accepted.push(raw);
    }
    return {
      accepted,
      rollback() {
        for (const e of addedEntries) {
          const idx = hist.indexOf(e);
          if (idx >= 0) hist.splice(idx, 1);
        }
      },
    };
  }

  function registerClaimedSliceOwnersV2(key, assignedTurn, wakeSnapshot) {
    if (!assignedTurn || !wakeSnapshot || !Array.isArray(wakeSnapshot.messages)) return;
    const now = Date.now();
    for (const [k, v] of agyClaimedMsgOwner.entries()) {
      if (now - v.at > 180000) agyClaimedMsgOwner.delete(k);
    }
    if (wakeSnapshot.messages.length) {
      slices.set(assignedTurn, { throughSeq: wakeSnapshot.readThroughSeq, acknowledged: false, at: now });
    }
    for (const [turn, slice] of slices) if (now - slice.at > 180000 && !api.isTurnActive?.(turn)) slices.delete(turn);
    for (const m of wakeSnapshot.messages) {
      if (m && !m.isSelf && m.messageId) {
        agyClaimedMsgOwner.set(`${key}:${String(m.messageId)}`, { turn: String(assignedTurn), at: now });
      }
    }
  }

  function shouldBlockDuplicateGroupReplyV2(key, actualReplyToMessageId, turnRaw, actionKind = 'text') {
    if (!String(key ?? '').startsWith('group:')) return null;
    const mid = String(actualReplyToMessageId ?? '').trim();
    if (!mid) return null;
    const turn = String(turnRaw ?? '').trim();
    const now = Date.now();
    for (const [k, v] of agyRepliedTargetIds.entries()) {
      if (now - v.at > 600000) agyRepliedTargetIds.delete(k);
    }
    const dk = `${key}:${mid}`;
    const prevReplied = agyRepliedTargetIds.get(dk);
    if (prevReplied) {
      if (!turn || prevReplied.turn !== turn) {
        return `已被 ${prevReplied.turn || '前序回合'} 回复过`;
      }
      if (actionKind === 'text' && prevReplied.hasText) {
        return `同一回合 ${turn} 已对该消息发送过文本回复`;
      }
    }
    const owner = agyClaimedMsgOwner.get(dk);
    if (owner && turn && owner.turn !== turn && api?.isTurnActive?.(owner.turn)) {
      return `已分配给正在执行的并发回合 ${owner.turn}`;
    }
    agyRepliedTargetIds.set(dk, {
      turn,
      at: now,
      hasText: Boolean(prevReplied?.hasText || actionKind === 'text'),
    });
    return null;
  }

  function transferSilentSlice(key, oldTurn, nextTurn) {
    const prefix = [key, oldTurn, ''].join('::');
    for (const claim of agyTurnActionClaims.keys()) if (claim.startsWith(prefix)) return false;
    for (const [id, reservation] of agyRepliedTargetIds) {
      if (reservation.turn === oldTurn) agyRepliedTargetIds.delete(id);
    }
    const slice = slices.get(oldTurn);
    const reply = takeDefaultReply(oldTurn);
    slices.delete(oldTurn);
    for (const [id, owner] of agyClaimedMsgOwner) {
      if (owner.turn !== oldTurn) continue;
      if (slice?.acknowledged) agyClaimedMsgOwner.delete(id);
      else agyClaimedMsgOwner.set(id, { turn: nextTurn, at: Date.now() });
    }
    if (slice?.acknowledged) return 'acknowledged';
    if (slice) slices.set(nextTurn, { ...slice, at: Date.now() });
    if (reply) agyTurnDefaultReply.set(nextTurn, reply);
    // 新 turn 精确继承原快照，不回退会话公共水位，以免抢走其它 Worker 领取的后续页。
    return true;
  }

  function takeDefaultReply(turn) {
    const id = agyTurnDefaultReply.get(turn);
    agyTurnDefaultReply.delete(turn);
    return id;
  }

  return {
    getAgyClaimedSeq, registerClaimedSliceOwnersV2, checkTurnActionV2,
    claimOutboundUniqueMessagesV2, shouldBlockDuplicateGroupReplyV2, transferSilentSlice,
    takeDefaultReply, recordTurnAction,
    noteAcknowledged(turn, throughSeq) {
      const slice = slices.get(turn);
      if (slice && throughSeq >= slice.throughSeq) slice.acknowledged = true;
    },
    setClaimedSeq(st, seq) { agyClaimedSeq.set(st, seq); },
    setDefaultReply(turn, id) {
      agyTurnDefaultReply.set(turn, id);
      if (agyTurnDefaultReply.size > 200) agyTurnDefaultReply.delete(agyTurnDefaultReply.keys().next().value);
    },
  };
}
