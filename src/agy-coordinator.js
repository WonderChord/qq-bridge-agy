import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const AGY_WORKER_TURNS_FILE = fileURLToPath(new URL('../state/agy-worker-turns.json', import.meta.url));

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

export class AgyApiClient {
  constructor(baseUrl = 'agy://local', turnsFile = AGY_WORKER_TURNS_FILE) {
    this.baseUrl = String(baseUrl);
    this._turnsFile = turnsFile;
    this.isAgyBackend = true;
    this._sessions = new Map();
    this._follows = new Set();
    this._muxInbox = [];
    this._muxWake = null;
    this._wakeQueue = [];
    this._wakeWaiters = new Set();
    this._activeTurns = new Map(); // turn -> { sessionId, turn, wakeId, workerId, startedAt }
    this._completedTurns = new Map(); // turn -> completedAtMs (防止同一 turn 被重复提交发送)
    this._snapshots = new WeakMap(); // 原始切片不进入 status（可能含私聊内容）
    this._workerHealth = new Map();
    this._sessionEventTurn = new Map();
    this._workerTurns = new Map(); // workerId -> deliveredTurns
    this._allowedWorkers = new Set(['primary', 'w1', 'w2']);
    this._loadWorkerTurns();
    this.onWorkerAvailable = null;
    this.onWorkerRotated = null;

    const ok = (value = {}) => ({ result: { ok: true, value } });

    this.settings = {
      describe: async () => ok({ namespaces: [] }),
      update: async () => ok({ updated: true }),
    };
    this.agentPresets = {
      list: async () => ok({
        presets: [
          { id: 'standard', isDefault: true },
          { id: 'qq-chat' },
          { id: 'qq-chat-v2' },
        ],
      }),
    };
    this.workspace = {
      create: async () => ok({ created: false, workspace: { workspaceId: 'agy-workspace' } }),
      rename: async () => ok({}),
      archiveSession: async ({ sessionId } = {}) => {
        if (sessionId) this._sessions.delete(sessionId);
        return ok({});
      },
    };
    this.sessions = {
      create: async (params = {}) => {
        const sessionId = `agy-${randomUUID()}`;
        this._sessions.set(sessionId, {
          sessionId,
          title: params?.title ?? '',
          agentPreset: params?.agentPreset ?? '',
          createdAt: new Date().toISOString(),
        });
        return ok({ sessionId });
      },
      list: async () => ok({ sessions: [...this._sessions.values()] }),
      selectModel: async () => ok({ selected: { provider: 'antigravity', model: 'gemini' } }),
      prompt: async ({ sessionId, content } = {}) => {
        const meta = this._sessions.get(sessionId);
        const turn = `agy-turn-${randomUUID()}`;
        // 黑话后台提取会话：自动返回空候选数组，避免阻塞或额外消耗会话轮次
        if (meta?.title && String(meta.title).includes('黑话')) {
          queueMicrotask(() => {
            this._emitSessionEvent(sessionId, { type: 'turn/start', data: { turn } });
            this._emitSessionEvent(sessionId, {
              type: 'assistant/message',
              data: { turn, message: { content: [{ type: 'text', text: '[]' }] } },
            });
            this._emitSessionEvent(sessionId, {
              type: 'turn/end',
              data: { turn, reason: { kind: 'completed' } },
            });
          });
          return ok({});
        }
        const hadActive = this.activeTurnCount(sessionId) > 0;
        const wakeId = randomUUID();
        const turnEntry = { sessionId, turn, wakeId, workerId: '', startedAt: Date.now() };
        this._activeTurns.set(turn, turnEntry);
        if (!hadActive) {
          this._sessionEventTurn.set(sessionId, turn);
          this._emitSessionEvent(sessionId, { type: 'turn/start', data: { turn } });
        }

        const text = blocksToText(content);
        const imageCount = (content ?? []).filter((b) => b?.type === 'image').length;
        const item = {
          wakeId,
          turn,
          sessionId,
          text,
          imageCount,
          createdAt: new Date().toISOString(),
        };
        this._snapshots.set(turnEntry, item);
        const bestWaiter = this._pickBestWaiter();
        if (bestWaiter) {
          this._assignWake(item, bestWaiter.workerId);
          bestWaiter.deliver(item);
        } else {
          this._wakeQueue.push(item);
        }
        return ok({ turn });
      },
    };
    this.events = {
      follow: (sessionId) => { if (sessionId) this._follows.add(sessionId); },
      forget: (sessionId) => { if (sessionId) this._follows.delete(sessionId); },
      mux: () => this._muxGenerator(),
    };
  }

  _emitMux(envelope) {
    this._muxInbox.push(envelope);
    const w = this._muxWake;
    this._muxWake = null;
    w?.();
  }

  _emitSessionEvent(sessionId, event) {
    this._emitMux({
      rpcId: randomUUID(),
      payload: { type: 'session/event', sessionId, event },
    });
  }

  _endSessionTurn(sessionId, turn, kind) {
    const eventTurn = this._sessionEventTurn.get(sessionId) || turn;
    this._sessionEventTurn.delete(sessionId);
    this._emitSessionEvent(sessionId, { type: 'turn/end', data: { turn: eventTurn, reason: { kind } } });
  }

  async *_muxGenerator() {
    while (true) {
      while (this._muxInbox.length > 0) {
        yield this._muxInbox.shift();
      }
      await new Promise((resolve) => { this._muxWake = resolve; });
    }
  }

  async callUnary(method) {
    if (String(method).includes('model')) {
      return {
        result: {
          ok: true,
          value: { models: [{ provider: 'antigravity', model: 'gemini', reasoningEfforts: ['high'] }] },
        },
      };
    }
    return { result: { ok: true, value: { accepted: true } } };
  }

  async respond() {
    return { result: { ok: true, value: {} } };
  }

  _pruneStaleTurns(maxAgeMs = 75000) {
    const now = Date.now();
    const expiredSids = new Map();
    for (const [t, info] of this._activeTurns.entries()) {
      // 离线积压仍可领取，执行租约从 worker 领到唤醒时开始。
      if (info.workerId && now - info.startedAt > maxAgeMs) {
        this._activeTurns.delete(t);
        this._completedTurns.set(t, now);
        expiredSids.set(info.sessionId, t);
      }
    }
    for (const [turn, at] of this._completedTurns) {
      if (now - at > 7_200_000) this._completedTurns.delete(turn);
    }
    for (const [sid, turn] of expiredSids) {
      if (![...this._activeTurns.values()].some((entry) => entry.sessionId === sid)) {
        this._endSessionTurn(sid, turn, 'aborted');
      }
    }
  }

  _assignWake(item, workerId) {
    const now = Date.now();
    const active = this._activeTurns.get(item.turn);
    active.workerId = workerId;
    active.startedAt = now;
    this._workerHealth.get(workerId).lastWakeAt = new Date(now).toISOString();
    item.workerTurnIndex = (this._workerTurns.get(workerId) || 0) + 1;
    this._workerTurns.set(workerId, item.workerTurnIndex);
    this._saveWorkerTurns();
  }

  _recoverSilentTurns(workerId, finish) {
    const retry = [];
    for (const old of [...this._activeTurns.values()]) {
      if (old.workerId !== workerId || finish?.all || finish?.turn === old.turn
          || (!finish?.turn && !finish?.workerId && finish?.sessionId === old.sessionId)) continue;
      const snapshot = this._snapshots.get(old);
      if (!snapshot) continue;
      const turn = 'agy-turn-' + randomUUID();
      // 同步检查发言记录并转移本切片的锁，旧请求不能趁重连再发送。
      const recovery = this.onRecoverTurn?.(old, turn);
      if (recovery === false) continue;
      if (recovery === 'acknowledged') {
        this.completeTurn({ turn: old.turn });
        continue;
      }
      const now = Date.now();
      const item = { ...snapshot, wakeId: randomUUID(), turn };
      const next = { turn, sessionId: old.sessionId, wakeId: item.wakeId, workerId: '', startedAt: now };
      this._completedTurns.set(old.turn, now);
      this._activeTurns.delete(old.turn);
      this._activeTurns.set(turn, next);
      this._snapshots.set(next, item);
      retry.push(item);
    }
    this._wakeQueue.unshift(...retry);
    return retry.length;
  }

  _pickBestWaiter() {
    let best = null;
    for (const w of this._wakeWaiters) {
      if (!best || (w.priority ?? 0) > (best.priority ?? 0)) {
        best = w;
      }
    }
    return best;
  }

  activeTurnCount(sessionId) {
    this._pruneStaleTurns();
    if (!sessionId) return this._activeTurns.size;
    let n = 0;
    for (const info of this._activeTurns.values()) {
      if (info.sessionId === sessionId) n += 1;
    }
    return n;
  }

  isTurnActive(turn, sessionId) {
    this._pruneStaleTurns();
    const active = this._activeTurns.get(String(turn));
    return !!active && (sessionId === undefined || sessionId === active.sessionId);
  }

  isTurnCompleted(turn) {
    if (!turn) return false;
    this._pruneStaleTurns();
    return this._completedTurns.has(String(turn));
  }

  waitingListenerCount() {
    return this._wakeWaiters.size;
  }

  claimTurn(turn, sessionId, workerId) {
    this._pruneStaleTurns();
    const active = this._activeTurns.get(turn);
    if (!active || active.sessionId !== sessionId || active.workerId !== workerId) return 'stale';
    if (active.claimed) return 'duplicate';
    active.claimed = true;
    return 'claimed';
  }

  async stopSessionWork(sessionId) {
    const before = this._wakeQueue.length;
    this._wakeQueue = this._wakeQueue.filter((w) => w.sessionId !== sessionId);
    const removed = before - this._wakeQueue.length;
    let lastTurn = null;
    for (const [t, info] of this._activeTurns.entries()) {
      if (info.sessionId === sessionId) {
        lastTurn = info.turn;
        this._completedTurns.set(t, Date.now());
        this._activeTurns.delete(t);
      }
    }
    if (lastTurn) {
      this._endSessionTurn(sessionId, lastTurn, 'aborted');
    }
    return { removed };
  }

  completeTurn({ sessionId, turn, workerId = '', replyText = '', all = false } = {}) {
    this._pruneStaleTurns();
    const targets = [];
    for (const [t, info] of this._activeTurns.entries()) {
      if (all) {
        targets.push([t, info]);
      } else if (turn && t === turn) {
        targets.push([t, info]);
      } else if (!turn && workerId && info.workerId === workerId) {
        targets.push([t, info]);
      } else if (!turn && !workerId && sessionId && info.sessionId === sessionId) {
        targets.push([t, info]);
      }
    }
    const finishedTurns = new Set(targets.map(([t]) => t));
    this._wakeQueue = this._wakeQueue.filter((item) => !finishedTurns.has(item.turn));
    const completed = [];
    const affectedSids = new Set();
    for (const [t, info] of targets) {
      this._completedTurns.set(String(t), Date.now());
      this._activeTurns.delete(t);
      affectedSids.add(info.sessionId);
      if (typeof replyText === 'string' && replyText.trim()) {
        this._emitSessionEvent(info.sessionId, {
          type: 'assistant/message',
          data: { turn: this._sessionEventTurn.get(info.sessionId) || info.turn, message: { content: [{ type: 'text', text: replyText }] } },
        });
      }
      if (this.activeTurnCount(info.sessionId) === 0) {
        this._endSessionTurn(info.sessionId, info.turn, 'completed');
      }
      completed.push({ sessionId: info.sessionId, turn: info.turn, workerId: info.workerId });
    }
    if (affectedSids.size > 0 && typeof this.onWorkerAvailable === 'function') {
      queueMicrotask(() => {
        for (const sid of affectedSids) this.onWorkerAvailable?.(sid);
      });
    }
    return completed;
  }

  _loadWorkerTurns() {
    try {
      if (!fs.existsSync(this._turnsFile)) return;
      const raw = fs.readFileSync(this._turnsFile, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          const n = Number(v);
          if (k && Number.isFinite(n) && n >= 0) this._workerTurns.set(k, Math.floor(n));
        }
      }
    } catch {}
  }

  _saveWorkerTurns() {
    try {
      fs.mkdirSync(path.dirname(this._turnsFile), { recursive: true });
      const tmp = this._turnsFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this._workerTurns), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this._turnsFile);
    } catch {}
  }

  setAllowedWorkers(list) {
    if (!Array.isArray(list) || list.length === 0) return;
    const next = new Set(['primary']);
    for (const item of list) {
      const s = String(item ?? '').trim();
      if (s) next.add(s);
    }
    this._allowedWorkers = next;
  }

  _isWorkerAllowed(wid) {
    if (!this._allowedWorkers || this._allowedWorkers.size === 0) return true;
    return this._allowedWorkers.has(String(wid || 'primary'));
  }

  waitNextWake({ timeoutMs = 55000, workerId = 'primary', priority = 10, maxTurns = 0, resetWorkerTurns = false, finish, onAbortRegistrar } = {}) {
    const wid = workerId || 'primary';
    const waitMs = Math.max(1000, Math.min(300000, Number(timeoutMs) || 55000));
    if (!this._isWorkerAllowed(wid)) {
      if (finish) this.completeTurn(finish);
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ timedOut: true, parked: true, wake: null });
        };
        const timer = setTimeout(finish, waitMs);
        if (typeof onAbortRegistrar === 'function') onAbortRegistrar(finish);
      });
    }
    const recovered = this._recoverSilentTurns(wid, finish);
    if (finish) this.completeTurn(finish);
    const health = this._workerHealth.get(wid);
    if (!health || recovered || resetWorkerTurns) {
      this._workerHealth.set(wid, { connectedAt: new Date().toISOString(), lastWakeAt: health?.lastWakeAt ?? null });
    }
    // 严格保证单 workerId 单监听进程：若同一 workerId 有残留旧监听连接，立即令其 superseded 退出，杜绝双进程同抢唤醒。
    for (const existing of [...this._wakeWaiters]) {
      if (existing.workerId === wid) {
        existing.supersede?.();
      }
    }
    if (resetWorkerTurns) {
      this._workerTurns.set(wid, 0);
      this._saveWorkerTurns();
    }
    const doneTurns = this._workerTurns.get(wid) || 0;
    if (maxTurns > 0 && doneTurns >= maxTurns) {
      this._workerTurns.set(wid, 0);
      this._saveWorkerTurns();
      this.onWorkerRotated?.(wid);
      return Promise.resolve({ timedOut: false, rotate: true, turnsCompleted: doneTurns, wake: null });
    }
    if (this._wakeQueue.length > 0) {
      const item = this._wakeQueue.shift();
      this._assignWake(item, wid);
      return Promise.resolve({ timedOut: false, wake: item });
    }
    return new Promise((resolve) => {
      let settled = false;
      const entry = {
        workerId: wid,
        priority: Number.isFinite(Number(priority)) ? Number(priority) : 10,
        deliver(item) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          self._wakeWaiters.delete(entry);
          resolve({ timedOut: false, wake: item });
        },
        supersede() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          self._wakeWaiters.delete(entry);
          resolve({ timedOut: false, superseded: true, wake: null });
        },
        cancel() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          self._wakeWaiters.delete(entry);
          resolve({ timedOut: true, wake: null, aborted: true });
        },
      };
      const self = this;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        self._wakeWaiters.delete(entry);
        resolve({ timedOut: true, wake: null });
      }, waitMs);
      this._wakeWaiters.add(entry);
      if (typeof onAbortRegistrar === 'function') onAbortRegistrar(() => entry.cancel());
      if (typeof this.onWorkerAvailable === 'function') {
        queueMicrotask(() => this.onWorkerAvailable?.(null));
      }
    });
  }

  agyStatus() {
    this._pruneStaleTurns();
    const waitingWorkers = [...this._wakeWaiters].map((w) => ({
      workerId: w.workerId, priority: w.priority, ...this._workerHealth.get(w.workerId),
    }));
    const busy = [...this._activeTurns.values()].map((t) => t.workerId).filter(Boolean);
    const online = new Set([...waitingWorkers.map((w) => w.workerId), ...busy]);
    return {
      queuedWakes: this._wakeQueue.length,
      waitingListeners: this._wakeWaiters.size,
      waitingWorkers,
      workers: [...online].map((workerId) => ({ workerId, ...this._workerHealth.get(workerId) })),
      allowedWorkers: [...(this._allowedWorkers || [])],
      workerTurns: Object.fromEntries(this._workerTurns),
      activeTurns: [...this._activeTurns.values()],
      sessions: this._sessions.size,
    };
  }
}


// 群聊预筛与主 Worker 分开排队，只在 Flash 通过时唤醒主线程。
export function createFlashJudge({
  api, log, scheduleWakeV2, getSocialV2State, isConversationBusyV2, acknowledgeMessagesV2,
  saveSocialV2State, isPaused, isCreator, personaCreatorLabel, localClockText, personaBotName,
}) {
  let ambiguousJudgeCounter = 0;
  const ambiguousJudgeQueue = [];
  const ambiguousJudgeInFlight = new Map();
  const ambiguousJudgeWaiters = new Set();
  const ambiguousJudgeCooldown = new Map();
  let lastJudgePollAt = 0;

  function isFlashJudgeOnlineV2() {
    return ambiguousJudgeWaiters.size > 0 || (lastJudgePollAt > 0 && Date.now() - lastJudgePollAt < 75000);
  }

  function cancelFlashReplyJudgeV2(key, st) {
    if (st?.pendingFlashJudgeTimer) {
      clearTimeout(st.pendingFlashJudgeTimer);
      st.pendingFlashJudgeTimer = null;
    }
    if (st) {
      st.pendingFlashJudgeReason = null;
      st.pendingFlashJudgeTargetText = '';
    }
    for (let i = ambiguousJudgeQueue.length - 1; i >= 0; i -= 1) {
      if (ambiguousJudgeQueue[i]?.key === key) ambiguousJudgeQueue.splice(i, 1);
    }
    for (const [id, item] of ambiguousJudgeInFlight.entries()) {
      if (item?.key === key) ambiguousJudgeInFlight.delete(id);
    }
  }

  function pruneAmbiguousJudge() {
    const now = Date.now();
    while (ambiguousJudgeQueue.length > 0 && now - ambiguousJudgeQueue[0].createdAtMs > 25000) {
      ambiguousJudgeQueue.shift();
    }
    for (const [id, item] of ambiguousJudgeInFlight.entries()) {
      if (now - item.createdAtMs > 45000) ambiguousJudgeInFlight.delete(id);
    }
  }

  function applyAmbiguousJudgeDecision(decideId, shouldWake) {
    if (!decideId) return null;
    const item = ambiguousJudgeInFlight.get(decideId);
    ambiguousJudgeInFlight.delete(decideId);
    if (!item) return { found: false };
    if (shouldWake && Date.now() - item.createdAtMs <= 45000) {
      log(`[reserved2] Flash 预筛通过 ${item.key} (${decideId}, reason=${item.reason || 'probability'}) -> 唤醒主力回复`);
      scheduleWakeV2(item.key, `${item.reason || 'probability'}:Flash预筛可回`, { immediate: true });
      return { found: true, woke: true, key: item.key };
    }
    try {
      const st = getSocialV2State(item.key);
      if (
        st
        && !st.pendingWakeTimer
        && !st.pendingFlashJudgeTimer
        && !isConversationBusyV2(item.key, st)
        && !(Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length > 0)
      ) {
        const safeSeq = Math.min(Number(item.seq) || 0, Number(st.lastUnreadSeq) || 0);
        if (safeSeq > (st.lastReadThroughSeq || 0)) {
          acknowledgeMessagesV2(st, safeSeq);
          saveSocialV2State();
        }
      }
    } catch {}
    log(`[reserved2] Flash 预筛拦截 ${item.key} (${decideId}, seq<=${item.seq || 0}) -> 静默标已读继续潜水`);
    return { found: true, woke: false, key: item.key };
  }

  function enqueueAmbiguousJudgeV2(key, st, plainContent, { reason = 'probability' } = {}) {
    if (!api.isAgyBackend) return;
    if (st.pendingWakeTimer || isConversationBusyV2(key, st)) return;
    pruneAmbiguousJudge();
    const now = Date.now();
    const baseReason = String(reason || 'probability').split(':')[0];
    const isCallMention = baseReason === 'nameMention' || baseReason === 'keyword' || baseReason === 'ambiguousCall';
    const lastAt = ambiguousJudgeCooldown.get(key) || 0;
    if (!isCallMention && now - lastAt < 2500) return;
    ambiguousJudgeCooldown.set(key, now);
    const recentSlice = (Array.isArray(st.recentMessages) ? st.recentMessages.slice(-14) : []).map((m) => {
      const uid = String(m.userId ?? '');
      const ownerTag = isCreator(uid) ? `[${personaCreatorLabel()}]` : '';
      const clock = m.time ? `[${localClockText(m.time)}] ` : '';
      return {
        sender: m.isSelf ? `${clock}${personaBotName()}(我)` : `${clock}${ownerTag}${String(m.sender || uid || '群友')}`,
        text: String(m.text || m.plain || '').slice(0, 150),
      };
    });
    const lastEntry = recentSlice[recentSlice.length - 1];
    const latestPlain = String(plainContent ?? lastEntry?.text ?? '').slice(0, 180);
    const ruleHint = isCallMention
      ? `[名字/关键词(${reason})预筛：结合最近14条上下文判断群友是否在叫${personaBotName()}搭话、讨论它或接它话茬(yes，若[${personaCreatorLabel()}]喊必判yes)；同名梗或与${personaBotName()}无关的闲聊判no]`
      : `[潜水概率抽样预筛：结合最近14条上下文判断是否有明确槽点/热梗/话题适合${personaBotName()}自然插一句(yes)；单字/纯表情包连刷/残句/严肃私事插不上嘴判no]`;
    const item = {
      id: `judge-${++ambiguousJudgeCounter}`,
      key,
      reason,
      isCallMention,
      seq: st.lastUnreadSeq || 0,
      sender: lastEntry ? lastEntry.sender : '群友',
      targetText: `${ruleHint} ${latestPlain}`,
      rawTargetText: latestPlain,
      recent: recentSlice,
      createdAt: new Date(now).toISOString(),
      createdAtMs: now,
    };
    for (const waiter of ambiguousJudgeWaiters) {
      ambiguousJudgeWaiters.delete(waiter);
      ambiguousJudgeInFlight.set(item.id, item);
      waiter({ timedOut: false, item });
      log(`[reserved2] 投递潜水回复预筛给 Flash ${key} (${item.id}, reason=${reason}, ctx=${recentSlice.length}, seq=${item.seq})`);
      return;
    }
    if (ambiguousJudgeQueue.length >= 10) ambiguousJudgeQueue.shift();
    ambiguousJudgeQueue.push(item);
    log(`[reserved2] 潜水回复预筛入队等待 Flash ${key} (${item.id}, reason=${reason}, ctx=${recentSlice.length}, seq=${item.seq})`);
  }

  function flashJudgePriorityV2(reason) {
    const base = String(reason || '').split(':')[0];
    if (base === 'nameMention') return 30;
    if (base === 'keyword') return 25;
    if (base === 'ambiguousCall') return 20;
    return 10;
  }

  function scheduleFlashReplyJudgeV2(key, st, reason = 'probability', triggerText = '') {
    if (!api?.isAgyBackend || !st) return;
    if (st.pendingWakeTimer || isConversationBusyV2(key, st)) return;
    if (st.pendingFlashJudgeTimer) {
      if (flashJudgePriorityV2(reason) > flashJudgePriorityV2(st.pendingFlashJudgeReason)) {
        st.pendingFlashJudgeReason = reason;
        if (triggerText) st.pendingFlashJudgeTargetText = String(triggerText);
      }
      return;
    }
    st.pendingFlashJudgeReason = reason;
    st.pendingFlashJudgeTargetText = triggerText ? String(triggerText) : '';
    const batchMs = Math.max(400, Number(st.wakeConfig?.batchWindowMs) || 2000);
    st.pendingFlashJudgeTimer = setTimeout(() => {
      st.pendingFlashJudgeTimer = null;
      const finalReason = st.pendingFlashJudgeReason || reason;
      const savedText = st.pendingFlashJudgeTargetText || '';
      st.pendingFlashJudgeReason = null;
      st.pendingFlashJudgeTargetText = '';
      if (isPaused() || st.pendingWakeTimer || isConversationBusyV2(key, st)) return;
      if (!isFlashJudgeOnlineV2()) {
        log(`[reserved2] Flash 预筛线程未在线，降级直通唤醒 ${key} (${finalReason})`);
        scheduleWakeV2(key, finalReason, { immediate: true });
        return;
      }
      const newestHuman = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
      enqueueAmbiguousJudgeV2(key, st, savedText || newestHuman?.plain || newestHuman?.text || '', { reason: finalReason });
    }, batchMs);
    st.pendingFlashJudgeTimer.unref?.();
    log(`[reserved2] 计划 Flash 潜水预筛 ${key} (${reason})，${(batchMs / 1000).toFixed(1)}s 合批后判定`);
  }

  function waitNextAmbiguousJudge({ timeoutMs = 55000, onAbortRegistrar } = {}) {
    pruneAmbiguousJudge();
    if (ambiguousJudgeQueue.length > 0) {
      const item = ambiguousJudgeQueue.shift();
      ambiguousJudgeInFlight.set(item.id, item);
      return Promise.resolve({ timedOut: false, item });
    }
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ambiguousJudgeWaiters.delete(waiter);
        resolve(outcome);
      };
      const timer = setTimeout(() => waiter({ timedOut: true, item: null }), Math.max(1000, Math.min(timeoutMs, 120000)));
      ambiguousJudgeWaiters.add(waiter);
      onAbortRegistrar?.(() => waiter({ timedOut: true, item: null }));
    });
  }

  return {
    cancelFlashReplyJudgeV2, scheduleFlashReplyJudgeV2, applyAmbiguousJudgeDecision,
    waitNextAmbiguousJudge,
    notePoll() { lastJudgePollAt = Date.now(); },
    status() {
      pruneAmbiguousJudge();
      return { waitingJudges: ambiguousJudgeWaiters.size, queuedJudges: ambiguousJudgeQueue.length };
    },
  };
}

export function createArchiveChannel(log) {
  const memoryArchiveQueue = [];
  const memoryArchiveWaiters = new Set();
  function enqueue(job) {
    const { key, triggerReason } = job;
    for (const waiter of memoryArchiveWaiters) {
      memoryArchiveWaiters.delete(waiter);
      waiter({ timedOut: false, job });
      log(`[reserved2] 投递长期记忆归纳批次 ${key} (${job.id}, reason=${triggerReason}, seq ${job.fromSeq}~${job.toSeq})`);
      return;
    }
    if (memoryArchiveQueue.length >= 10) memoryArchiveQueue.shift();
    memoryArchiveQueue.push(job);
    log(`[reserved2] 长期记忆归纳批次入队 ${key} (${job.id}, reason=${triggerReason}, seq ${job.fromSeq}~${job.toSeq})`);
  }

  function waitNextMemoryArchive({ timeoutMs = 55000, onAbortRegistrar } = {}) {
    if (memoryArchiveQueue.length > 0) {
      return Promise.resolve({ timedOut: false, job: memoryArchiveQueue.shift() });
    }
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        memoryArchiveWaiters.delete(waiter);
        resolve(outcome);
      };
      const timer = setTimeout(() => waiter({ timedOut: true, job: null }), Math.max(1000, Math.min(timeoutMs, 120000)));
      memoryArchiveWaiters.add(waiter);
      onAbortRegistrar?.(() => waiter({ timedOut: true, job: null }));
    });
  }
  return {
    enqueue, waitNextMemoryArchive,
    status: () => ({ waitingArchivists: memoryArchiveWaiters.size, queuedArchives: memoryArchiveQueue.length }),
  };
}
