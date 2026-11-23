import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildRouterInput, classifyGroupMessageWithRouter, DEFAULT_ROUTER_MODEL } from './message-router.js';

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
    this._pruneTimer = setInterval(() => {
      try { this._pruneStaleTurns(); } catch {}
    }, 30000);
    this._pruneTimer.unref?.();

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
          this._enqueueWake(item);
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

  _isPrivateWakeItem(item) {
    return /(?:^|\n)【唤醒】private:|private:\d+/.test(String(item?.text || ''));
  }

  _enqueueWake(item) {
    if (this._isPrivateWakeItem(item)) {
      let insertAt = 0;
      while (insertAt < this._wakeQueue.length && this._isPrivateWakeItem(this._wakeQueue[insertAt])) {
        insertAt += 1;
      }
      this._wakeQueue.splice(insertAt, 0, item);
      return;
    }
    this._wakeQueue.push(item);
  }

  touchSessionTurns(sessionId) {
    if (!sessionId) return;
    const now = Date.now();
    for (const info of this._activeTurns.values()) {
      if (info.sessionId === sessionId && info.workerId) {
        info.startedAt = now;
      }
    }
  }

  _pruneStaleTurns(maxAgeMs = 600000) {
    const now = Date.now();
    const expiredSids = new Map();
    const recoveredItems = [];
    for (const [t, info] of this._activeTurns.entries()) {
      // 离线积压仍可领取，执行租约从 worker 领到唤醒时开始（默认 10 分钟，工具调用自动续期；看图后上游卡死时自动回收重排）。
      if (info.workerId && now - info.startedAt > maxAgeMs) {
        const snapshot = this._snapshots.get(info);
        if (!info.claimed && snapshot && (Number(snapshot.requeuedCount) || 0) < 2) {
          const nextTurn = 'agy-turn-' + randomUUID();
          const recovery = this.onRecoverTurn?.(info, nextTurn);
          if (recovery && recovery !== 'acknowledged') {
            const item = {
              ...snapshot,
              wakeId: randomUUID(),
              turn: nextTurn,
              requeuedCount: (Number(snapshot.requeuedCount) || 0) + 1,
            };
            const next = { turn: nextTurn, sessionId: info.sessionId, wakeId: item.wakeId, workerId: '', startedAt: now };
            this._completedTurns.set(t, now);
            this._activeTurns.delete(t);
            this._activeTurns.set(nextTurn, next);
            this._snapshots.set(next, item);
            recoveredItems.push(item);
            continue;
          }
        }
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
    for (const item of recoveredItems) {
      const bestWaiter = this._pickBestWaiter();
      if (bestWaiter) {
        this._assignWake(item, bestWaiter.workerId);
        bestWaiter.deliver(item);
      } else {
        this._enqueueWake(item);
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
      const item = {
        ...snapshot,
        wakeId: randomUUID(),
        turn,
        requeuedCount: (Number(snapshot.requeuedCount) || 0) + 1,
      };
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

  requeueTurn({ turn, workerId = '' } = {}) {
    this._pruneStaleTurns();
    const targetTurn = String(turn || '').trim();
    const wid = String(workerId || '').trim();
    const candidates = [];
    for (const old of [...this._activeTurns.values()]) {
      if (targetTurn && old.turn === targetTurn) candidates.push(old);
      else if (!targetTurn && wid && old.workerId === wid) candidates.push(old);
    }
    const requeued = [];
    for (const old of candidates) {
      const snapshot = this._snapshots.get(old);
      if (!snapshot) continue;
      const nextTurn = 'agy-turn-' + randomUUID();
      const recovery = this.onRecoverTurn?.(old, nextTurn);
      if (recovery === false) continue;
      if (recovery === 'acknowledged') {
        this.completeTurn({ turn: old.turn });
        continue;
      }
      const now = Date.now();
      const item = {
        ...snapshot,
        wakeId: randomUUID(),
        turn: nextTurn,
        requeuedCount: (Number(snapshot.requeuedCount) || 0) + 1,
      };
      const next = { turn: nextTurn, sessionId: old.sessionId, wakeId: item.wakeId, workerId: '', startedAt: now };
      this._completedTurns.set(old.turn, now);
      this._activeTurns.delete(old.turn);
      this._activeTurns.set(nextTurn, next);
      this._snapshots.set(next, item);
      requeued.push(item);
    }
    if (wid) {
      this._workerTurns.set(wid, 0);
      this._saveWorkerTurns();
      this.onWorkerRotated?.(wid);
    }
    if (requeued.length > 0) {
      this._wakeQueue.unshift(...requeued);
      while (this._wakeQueue.length > 0) {
        let best = null;
        for (const w of this._wakeWaiters) {
          if (wid && w.workerId === wid) continue;
          if (!best || (w.priority ?? 0) > (best.priority ?? 0)) best = w;
        }
        if (!best) break;
        const item = this._wakeQueue.shift();
        this._assignWake(item, best.workerId);
        best.deliver(item);
      }
    }
    return { requeued: requeued.length, turns: requeued.map((x) => x.turn) };
  }

  forceRotateWorker(workerId = 'w1') {
    const wid = String(workerId || 'w1').trim() || 'w1';
    const prevTurns = this._workerTurns.get(wid) || 0;
    let wokeWaiter = false;
    for (const existing of [...this._wakeWaiters]) {
      if (existing.workerId === wid && typeof existing.rotateNow === 'function') {
        existing.rotateNow(prevTurns || 1);
        wokeWaiter = true;
      }
    }
    if (wokeWaiter) {
      this._workerTurns.set(wid, 0);
      this._saveWorkerTurns();
      this.onWorkerRotated?.(wid);
    } else {
      // 若当前线程不在挂起监听态（正在跑回合或重连间隙），置高计数使其下次连入 wait 时立即收到 rotate: true
      this._workerTurns.set(wid, 999);
      this._saveWorkerTurns();
    }
    return { workerId: wid, wokeWaiter, prevTurns };
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
    active.startedAt = Date.now();
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
        rotateNow(turnsCompleted = 1) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          self._wakeWaiters.delete(entry);
          resolve({ timedOut: false, rotate: true, turnsCompleted, wake: null });
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


// 群聊前置路由分类器（在 qq-bridge 本地脚本层直接调用 gpt-6-luna / ROUTER_MODEL 进行无推理轻量判定）。
export function createFlashJudge({
  api, log, scheduleWakeV2, getSocialV2State, isConversationBusyV2, acknowledgeMessagesV2,
  saveSocialV2State, isPaused, isCreator, localClockText,
  getRouterConfig, getAssistantAliases, getSelfQqId, fetchImpl,
}) {
  let inFlightRouters = 0;
  let totalRouted = 0;
  let lastDecision = null;
  let cancelGeneration = 0;
  const keyGenerations = new Map();

  function cancelFlashReplyJudgeV2(key, st) {
    if (st?.pendingFlashJudgeTimer) {
      clearTimeout(st.pendingFlashJudgeTimer);
      st.pendingFlashJudgeTimer = null;
    }
    if (st) {
      st.pendingFlashJudgeReason = null;
      st.pendingFlashJudgeTargetText = '';
      st.pendingRouterExplicitAtSelf = false;
      st.pendingRouterQuoteSelf = false;
      st.pendingRouterSenderIsAdmin = false;
      st.pendingRouterSenderLabel = '';
    }
    if (key) {
      keyGenerations.set(key, ++cancelGeneration);
    }
  }

  function flashJudgePriorityV2(reason) {
    const base = String(reason || '').split(':')[0];
    if (base === 'atMention') return 45;
    if (base === 'anyMessage') return 40;
    if (base === 'nameMention') return 35;
    if (base === 'keyword') return 30;
    if (base === 'question' || base === 'speaker' || base === 'followup') return 25;
    if (base === 'ambiguousCall') return 20;
    return 10;
  }

  async function evaluateGroupMessageDirect({
    key = '',
    triggerReason = 'groupMessage',
    senderLabel = '群成员',
    senderId = '',
    targetText = '',
    recentMessages = [],
    explicitAtSelf = false,
    quoteTargetIsSelf = false,
  } = {}) {
    const routerCfg = typeof getRouterConfig === 'function' ? getRouterConfig() : {};
    const aliases = typeof getAssistantAliases === 'function' ? getAssistantAliases() : [];
    const selfQqId = typeof getSelfQqId === 'function' ? String(getSelfQqId() || '') : '';
    const senderIsAdmin = Boolean(senderId && (routerCfg?.ownerIdSet?.has(String(senderId)) || isCreator?.(senderId)));

    const routerInput = buildRouterInput({
      groupKey: key,
      triggerReason,
      selfQqId,
      assistantAliases: aliases,
      explicitAtSelf,
      quoteTargetIsSelf,
      senderIsAdmin,
      senderLabel,
      targetText,
      recentMessages,
    });

    inFlightRouters += 1;
    try {
      const decision = await classifyGroupMessageWithRouter({
        routerCfg,
        routerInput,
        explicitAtSelf,
        quoteTargetIsSelf,
        fetchImpl,
      });
      totalRouted += 1;
      lastDecision = {
        at: new Date().toISOString(),
        key,
        trigger: triggerReason,
        should_reply: decision.should_reply,
        reason: decision.reason,
        model: decision.model,
        endpoint: decision.endpoint,
        degraded: decision.degraded,
        latencyMs: decision.latencyMs,
      };
      return decision;
    } finally {
      inFlightRouters = Math.max(0, inFlightRouters - 1);
    }
  }

  async function runScheduledGroupRouter(key, st, snapshot) {
    const {
      finalReason, savedText, explicitAtSelf, quoteTargetIsSelf,
      senderIsAdmin, senderLabel, judgedSeq, genAtStart,
    } = snapshot;

    if (isPaused?.() || st.pendingWakeTimer) return;

    const recentSlice = (Array.isArray(st.recentMessages) ? st.recentMessages.slice(-12) : []).map((m) => {
      const uid = String(m?.userId ?? '');
      const adminTag = !m?.isSelf && (isCreator?.(uid) || getRouterConfig?.()?.ownerIdSet?.has(uid)) ? '[管理员]' : '';
      const clock = m?.time ? `[${localClockText(m.time)}] ` : '';
      return {
        sender: m?.isSelf ? `${clock}[助手]` : `${clock}${adminTag}${String(m?.sender || uid || '群成员')}`,
        text: String(m?.text || m?.plain || '').slice(0, 160),
      };
    });

    const newestHuman = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const targetText = String(savedText || newestHuman?.plain || newestHuman?.text || '').slice(0, 220);
    const effectiveSender = senderLabel || String(newestHuman?.sender || newestHuman?.userId || '群成员');

    st.routerInFlightCount = (Number(st.routerInFlightCount) || 0) + 1;
    let decision;
    try {
      const routerCfg = typeof getRouterConfig === 'function' ? getRouterConfig() : {};
      const aliases = typeof getAssistantAliases === 'function' ? getAssistantAliases() : [];
      const selfQqId = typeof getSelfQqId === 'function' ? String(getSelfQqId() || '') : '';
      const routerInput = buildRouterInput({
        groupKey: key,
        triggerReason: finalReason,
        selfQqId,
        assistantAliases: aliases,
        explicitAtSelf,
        quoteTargetIsSelf,
        senderIsAdmin,
        senderLabel: effectiveSender,
        targetText,
        recentMessages: recentSlice,
      });

      inFlightRouters += 1;
      try {
        decision = await classifyGroupMessageWithRouter({
          routerCfg,
          routerInput,
          explicitAtSelf,
          quoteTargetIsSelf,
          fetchImpl,
        });
      } finally {
        inFlightRouters = Math.max(0, inFlightRouters - 1);
      }

      totalRouted += 1;
      lastDecision = {
        at: new Date().toISOString(),
        key,
        trigger: finalReason,
        should_reply: decision.should_reply,
        reason: decision.reason,
        model: decision.model,
        endpoint: decision.endpoint,
        degraded: decision.degraded,
        latencyMs: decision.latencyMs,
      };
    } finally {
      st.routerInFlightCount = Math.max(0, (Number(st.routerInFlightCount) || 1) - 1);
    }

    if ((keyGenerations.get(key) || 0) !== genAtStart) return;
    if (isPaused?.()) return;

    if (decision?.should_reply) {
      const suffix = decision.degraded ? `, fallback=${decision.endpoint}` : '';
      log(`[router] 群聊路由放行 ${key} (trigger=${finalReason}, model=${decision.model}, ${decision.latencyMs}ms${suffix}): ${decision.reason}`);
      scheduleWakeV2(key, finalReason, { immediate: true });
      return;
    }

    try {
      if (
        st
        && !st.pendingWakeTimer
        && !st.pendingFlashJudgeTimer
        && !(Number(st.routerInFlightCount) > 0)
        && !isConversationBusyV2(key, st)
        && !(Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length > 0)
      ) {
        const safeSeq = Math.min(Number(judgedSeq) || 0, Number(st.lastUnreadSeq) || 0);
        if (safeSeq > (st.lastReadThroughSeq || 0)) {
          acknowledgeMessagesV2(st, safeSeq);
          saveSocialV2State();
        }
      }
    } catch {}
    const errNote = decision?.degraded && decision?.error ? `, err=${decision.error}` : '';
    log(`[router] 群聊路由静默忽略 ${key} (trigger=${finalReason}, model=${decision?.model || DEFAULT_ROUTER_MODEL}, ${decision?.latencyMs ?? 0}ms${errNote}): ${decision?.reason || '无需回复'}`);
  }

  function scheduleFlashReplyJudgeV2(key, st, reason = 'probability', triggerText = '', meta = {}) {
    if (!st) return;
    const routerCfg = typeof getRouterConfig === 'function' ? getRouterConfig() : null;
    if (!api?.isAgyBackend && !routerCfg?.hasApiKey) return;

    const explicitAtSelf = Boolean(meta?.explicitAtSelf);
    const quoteTargetIsSelf = Boolean(meta?.quoteTargetIsSelf);
    const senderId = String(meta?.senderId ?? '').trim();
    const senderIsAdmin = Boolean(senderId && (routerCfg?.ownerIdSet?.has(senderId) || isCreator?.(senderId)));
    const senderLabel = String(meta?.senderLabel ?? '').trim();

    if (st.pendingWakeTimer) {
      if (explicitAtSelf || quoteTargetIsSelf || flashJudgePriorityV2(reason) >= 35) {
        scheduleWakeV2(key, reason);
      }
      return;
    }

    const fireTimer = () => {
      st.pendingFlashJudgeTimer = null;
      const snapshot = {
        finalReason: st.pendingFlashJudgeReason || reason,
        savedText: st.pendingFlashJudgeTargetText || '',
        explicitAtSelf: Boolean(st.pendingRouterExplicitAtSelf),
        quoteTargetIsSelf: Boolean(st.pendingRouterQuoteSelf),
        senderIsAdmin: Boolean(st.pendingRouterSenderIsAdmin),
        senderLabel: st.pendingRouterSenderLabel || '',
        judgedSeq: st.lastUnreadSeq || 0,
        genAtStart: keyGenerations.get(key) || 0,
      };
      st.pendingFlashJudgeReason = null;
      st.pendingFlashJudgeTargetText = '';
      st.pendingRouterExplicitAtSelf = false;
      st.pendingRouterQuoteSelf = false;
      st.pendingRouterSenderIsAdmin = false;
      st.pendingRouterSenderLabel = '';
      void runScheduledGroupRouter(key, st, snapshot).catch((err) => {
        log(`[router] 群聊路由未预期异常 ${key}: ${err?.message ?? err}`);
      });
    };

    if (st.pendingFlashJudgeTimer) {
      if (flashJudgePriorityV2(reason) >= flashJudgePriorityV2(st.pendingFlashJudgeReason)) {
        st.pendingFlashJudgeReason = reason;
        if (triggerText) st.pendingFlashJudgeTargetText = String(triggerText);
        if (senderLabel) st.pendingRouterSenderLabel = senderLabel;
      } else if (triggerText && !st.pendingFlashJudgeTargetText) {
        st.pendingFlashJudgeTargetText = String(triggerText);
      }
      st.pendingRouterExplicitAtSelf = Boolean(st.pendingRouterExplicitAtSelf || explicitAtSelf);
      st.pendingRouterQuoteSelf = Boolean(st.pendingRouterQuoteSelf || quoteTargetIsSelf);
      st.pendingRouterSenderIsAdmin = Boolean(st.pendingRouterSenderIsAdmin || senderIsAdmin);
      if (explicitAtSelf || quoteTargetIsSelf) {
        clearTimeout(st.pendingFlashJudgeTimer);
        st.pendingFlashJudgeTimer = setTimeout(fireTimer, 180);
        st.pendingFlashJudgeTimer.unref?.();
      }
      return;
    }

    st.pendingFlashJudgeReason = reason;
    st.pendingFlashJudgeTargetText = triggerText ? String(triggerText) : '';
    st.pendingRouterExplicitAtSelf = explicitAtSelf;
    st.pendingRouterQuoteSelf = quoteTargetIsSelf;
    st.pendingRouterSenderIsAdmin = senderIsAdmin;
    st.pendingRouterSenderLabel = senderLabel;

    const configuredBatch = Math.max(200, Number(st.wakeConfig?.batchWindowMs) || 1500);
    const batchMs = (explicitAtSelf || quoteTargetIsSelf) ? 180 : Math.min(2000, configuredBatch);
    st.pendingFlashJudgeTimer = setTimeout(fireTimer, batchMs);
    st.pendingFlashJudgeTimer.unref?.();
  }

  function applyAmbiguousJudgeDecision() {
    return { found: false, deprecated: true };
  }

  function waitNextAmbiguousJudge({ timeoutMs = 55000, onAbortRegistrar } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: true, item: null, deprecated: true });
      };
      const timer = setTimeout(done, Math.max(1000, Math.min(timeoutMs, 120000)));
      onAbortRegistrar?.(done);
    });
  }

  return {
    cancelFlashReplyJudgeV2,
    scheduleFlashReplyJudgeV2,
    evaluateGroupMessageDirect,
    applyAmbiguousJudgeDecision,
    waitNextAmbiguousJudge,
    notePoll() {},
    status() {
      const cfg = typeof getRouterConfig === 'function' ? getRouterConfig() : null;
      return {
        waitingJudges: 0,
        queuedJudges: 0,
        routerMode: 'local-openai',
        routerModel: cfg?.model || DEFAULT_ROUTER_MODEL,
        routerConfigured: Boolean(cfg?.hasApiKey),
        inFlightRouters,
        totalRouted,
        lastRouterDecision: lastDecision,
      };
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
