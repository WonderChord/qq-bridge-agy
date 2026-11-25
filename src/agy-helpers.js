// qq-bridge 三路专用协同助手队列（voice 语音导演 / search 后台搜索 / draw 绘图导演）
// 支持通过 config.json (socialV2.helpers) 或 .env (AGY_HELPERS_MODE / AGY_HELPER_*) 灵活开关是否启用多线程分流：
// - mode = "auto"（默认）：对应通道 enabled !== false 且子代理在线时自动接管，离线或超时无损回退单主线程直连；
// - mode = "off"（或 enabled = false）：强制走单主线程直连，即使有残留监听进程也不派单。

const VALID_ROLES = new Set(['voice', 'search', 'draw']);

function parseBoolFlag(val, fallback = true) {
  if (typeof val === 'boolean') return val;
  if (val === undefined || val === null || val === '') return fallback;
  const s = String(val).trim().toLowerCase();
  if (['0', 'false', 'off', 'no', 'disabled', 'single'].includes(s)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled', 'auto', 'multi'].includes(s)) return true;
  return fallback;
}

export function resolveHelperSettings(rawHelpers = {}, env = process.env) {
  const cfgObj = (rawHelpers && typeof rawHelpers === 'object' && !Array.isArray(rawHelpers))
    ? rawHelpers
    : (typeof rawHelpers === 'boolean' ? { enabled: rawHelpers, mode: rawHelpers ? 'auto' : 'off' } : {});

  const envMode = String(env?.AGY_HELPERS_MODE ?? '').trim().toLowerCase();
  const rawMode = envMode || String(cfgObj.mode ?? '').trim().toLowerCase() || (cfgObj.enabled === false ? 'off' : 'auto');
  const masterEnabled = !['off', 'false', '0', 'disabled', 'single', 'none'].includes(rawMode) && cfgObj.enabled !== false;
  const mode = masterEnabled ? (rawMode === 'on' || rawMode === 'multi' ? 'on' : 'auto') : 'off';

  const roleEnabled = (role) => {
    if (!masterEnabled) return false;
    const envKey = `AGY_HELPER_${role.toUpperCase()}`;
    if (env && env[envKey] !== undefined && String(env[envKey]).trim() !== '') {
      return parseBoolFlag(env[envKey], true);
    }
    return parseBoolFlag(cfgObj[role], true);
  };

  const clampMs = (v, def, min = 3000, max = 180000) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : def;
  };

  return {
    mode,
    enabled: masterEnabled,
    roles: {
      voice: roleEnabled('voice'),
      search: roleEnabled('search'),
      draw: roleEnabled('draw'),
    },
    timeouts: {
      voice: clampMs(env?.AGY_HELPER_VOICE_TIMEOUT_MS ?? cfgObj.voiceTimeoutMs, 45000),
      search: clampMs(env?.AGY_HELPER_SEARCH_TIMEOUT_MS ?? cfgObj.searchTimeoutMs, 36000),
      draw: clampMs(env?.AGY_HELPER_DRAW_TIMEOUT_MS ?? cfgObj.drawTimeoutMs, 75000),
    },
  };
}

export function createHelperHub(log = () => {}, { getConfig, env = process.env } = {}) {
  let seq = 0;
  const queues = { voice: [], search: [], draw: [] };
  const waiters = { voice: [], search: [], draw: [] };
  const inFlight = new Map();
  const resolvers = new Map();
  const meta = {
    voice: { lastPollAt: 0, lastCompletedAt: 0, completed: 0, timedOut: 0, lastWorkerId: '' },
    search: { lastPollAt: 0, lastCompletedAt: 0, completed: 0, timedOut: 0, lastWorkerId: '' },
    draw: { lastPollAt: 0, lastCompletedAt: 0, completed: 0, timedOut: 0, lastWorkerId: '' },
  };

  function assertRole(role) {
    const r = String(role || '').trim().toLowerCase();
    if (!VALID_ROLES.has(r)) {
      throw new Error(`未知助手角色: ${role}（仅支持 voice / search / draw）`);
    }
    return r;
  }

  function currentSettings() {
    const raw = typeof getConfig === 'function' ? getConfig() : {};
    return resolveHelperSettings(raw, env);
  }

  function isHelperEnabled(role) {
    const r = assertRole(role);
    return Boolean(currentSettings().roles[r]);
  }

  // 当存在挂起的长轮询监听者，或最近 22 秒内刚刚轮询过（处理完上一单正在重连的瞬间），视为该助手在线
  function isHelperOnline(role, maxIdleMs = 22000) {
    const r = assertRole(role);
    if (waiters[r].length > 0) return true;
    const last = meta[r].lastPollAt;
    return last > 0 && (Date.now() - last) <= maxIdleMs;
  }

  // 同时满足「配置允许启用该辅助线程」且「该辅助线程当前在线」时才派单，否则走主线程/网桥直连兜底
  function canDispatch(role, maxIdleMs = 22000) {
    const r = assertRole(role);
    return isHelperEnabled(r) && isHelperOnline(r, maxIdleMs);
  }

  function defaultTimeoutMs(role) {
    const r = assertRole(role);
    return currentSettings().timeouts[r] || 45000;
  }

  function dispatch(role) {
    const q = queues[role];
    const w = waiters[role];
    while (q.length > 0 && w.length > 0) {
      const job = q.shift();
      const waiter = w.shift();
      waiter.cleanup();
      inFlight.set(job.id, { job, workerId: waiter.workerId, claimedAt: Date.now() });
      waiter.resolve({ timedOut: false, job });
    }
  }

  function complete(id, result = null) {
    const jobId = String(id || '').trim();
    if (!jobId) return false;
    const active = inFlight.get(jobId);
    if (active) {
      inFlight.delete(jobId);
      const r = active.job.role;
      meta[r].completed += 1;
      meta[r].lastCompletedAt = Date.now();
    }
    const pending = resolvers.get(jobId);
    if (pending) {
      clearTimeout(pending.timer);
      resolvers.delete(jobId);
      pending.resolve({ ok: true, id: jobId, completed: true, result });
      return true;
    }
    return Boolean(active);
  }

  function enqueue(role, payload = {}, opts = {}) {
    const r = assertRole(role);
    const id = `${r}-${Date.now()}-${++seq}`;
    const job = {
      id,
      role: r,
      payload,
      createdAt: Date.now(),
    };
    const waitResult = opts.waitResult === true;
    const timeoutMs = Math.max(3000, Math.min(180000, Number(opts.timeoutMs) || defaultTimeoutMs(r)));

    let resultPromise = null;
    if (waitResult) {
      resultPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolvers.delete(id);
          const qIdx = queues[r].findIndex((item) => item.id === id);
          if (qIdx >= 0) queues[r].splice(qIdx, 1);
          inFlight.delete(id);
          meta[r].timedOut += 1;
          log(`[helper:${r}] 任务等待结果超时 (${timeoutMs}ms): ${id}`);
          resolve({ ok: false, id, completed: false, timedOut: true, result: null });
        }, timeoutMs);
        timer.unref?.();
        resolvers.set(id, { resolve, timer });
      });
    } else {
      // 异步不等待结果的任务保留 120s 防孤儿堆积保护
      const cleanupTimer = setTimeout(() => {
        const qIdx = queues[r].findIndex((item) => item.id === id);
        if (qIdx >= 0) queues[r].splice(qIdx, 1);
        if (inFlight.delete(id)) meta[r].timedOut += 1;
      }, Math.max(timeoutMs, 120000));
      cleanupTimer.unref?.();
    }

    queues[r].push(job);
    dispatch(r);

    if (resultPromise) return resultPromise;
    return Promise.resolve({ ok: true, id, queued: true });
  }

  function waitNext(role, { workerId = '', doneId = '', result = null, timeoutMs = 55000, onAbortRegistrar } = {}) {
    const r = assertRole(role);
    if (doneId) complete(doneId, result);
    meta[r].lastPollAt = Date.now();
    if (workerId) meta[r].lastWorkerId = String(workerId);

    if (isHelperEnabled(r) && queues[r].length > 0) {
      const job = queues[r].shift();
      inFlight.set(job.id, { job, workerId: String(workerId || r), claimedAt: Date.now() });
      return Promise.resolve({ timedOut: false, job });
    }

    const waitMs = Math.max(2000, Math.min(120000, Number(timeoutMs) || 55000));
    return new Promise((resolve) => {
      let settled = false;
      const entry = {
        workerId: String(workerId || r),
        resolve: (val) => {
          if (settled) return;
          settled = true;
          resolve(val);
        },
        cleanup: () => {
          clearTimeout(timer);
        },
      };
      const removeWaiter = () => {
        const idx = waiters[r].indexOf(entry);
        if (idx >= 0) waiters[r].splice(idx, 1);
      };
      const timer = setTimeout(() => {
        removeWaiter();
        meta[r].lastPollAt = Date.now();
        entry.resolve({ timedOut: true, job: null });
      }, waitMs);
      timer.unref?.();

      if (typeof onAbortRegistrar === 'function') {
        onAbortRegistrar(() => {
          clearTimeout(timer);
          removeWaiter();
          entry.resolve({ timedOut: true, aborted: true, job: null });
        });
      }
      if (isHelperEnabled(r)) {
        waiters[r].push(entry);
      }
    });
  }

  function status() {
    const settings = currentSettings();
    const out = {};
    for (const r of VALID_ROLES) {
      let activeCount = 0;
      for (const item of inFlight.values()) {
        if (item.job.role === r) activeCount += 1;
      }
      out[r] = {
        enabled: settings.roles[r],
        online: settings.roles[r] && isHelperOnline(r),
        listenerConnected: isHelperOnline(r),
        waiters: waiters[r].length,
        queued: queues[r].length,
        inFlight: activeCount,
        completed: meta[r].completed,
        timedOut: meta[r].timedOut,
        timeoutMs: settings.timeouts[r],
        lastWorkerId: meta[r].lastWorkerId,
        lastPollAt: meta[r].lastPollAt || null,
        lastCompletedAt: meta[r].lastCompletedAt || null,
      };
    }
    return {
      helpersMode: settings.mode,
      helpersEnabled: settings.enabled,
      helpers: out,
    };
  }

  return {
    isHelperEnabled,
    isHelperOnline,
    canDispatch,
    defaultTimeoutMs,
    enqueue,
    waitNext,
    complete,
    status,
  };
}
