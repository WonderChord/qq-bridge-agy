const aliases = {
  '/api/agy/wait-wake': '/api/agy/wait',
  '/api/agy/finish-turn': '/api/agy/complete',
  '/api/agy/wait-judge': '/api/agy/judge-wait',
  '/api/agy/wait-archive': '/api/agy/archive-wait',
};

// 入口处已统一验证 Host、控制台令牌和智能体权限。这里保留各业务端点的会话校验。
export async function handleAgyRequest({
  req, res, url, sendJson, readBody, api, judge, archive, memory,
  getMode, dshReady, snowlumaHealth, agentTokenOk, v2SessionAllowed,
  socialV2, cfg, state, reverse, getSocialV2State, log,
}) {
  const pathname = aliases[url.pathname] || url.pathname;
  if (!api.isAgyBackend) {
    sendJson({ ok: false, error: '当前未启用 agy:// 后端（请将 config.json 的 dsh.baseUrl 设为 "agy://local"）' }, 400);
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/agy/status') {
    sendJson({
      ok: true,
      mode: getMode(),
      dshReady,
      snowluma: snowlumaHealth,
      ...judge.status(),
      ...archive.status(),
      ...api.agyStatus(),
      loadedSignatures: memory.loadedSignatures(),
    });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/agy/archive-done') {
    const body = await readBody();
    const id = String(body?.doneId || body?.id || '').trim();
    if (id) log('[reserved2] 长期记忆归纳完成确认: ' + id);
    sendJson({ ok: true });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/agy/archive-wait') {
    const doneId = String(url.searchParams.get('doneId') || '').trim();
    if (doneId) log(`[reserved2] 长期记忆归纳完成确认: ${doneId}`);
    const timeoutMs = Number(url.searchParams.get('timeoutMs')) || 55000;
    let abortWait = null;
    req.on('close', () => { abortWait?.(); });
    const outcome = await archive.waitNextMemoryArchive({
      timeoutMs,
      onAbortRegistrar: (fn) => { abortWait = fn; },
    });
    if (res.writableEnded || res.destroyed) return true;
    sendJson({
      ok: true,
      timedOut: !!outcome.timedOut,
      job: outcome.job ?? null,
    });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/agy/judge-result') {
    const body = await readBody();
    const decideId = String(body?.id ?? '').trim();
    const shouldWake = body?.wake === true || body?.wake === 1 || String(body?.wake ?? '').toLowerCase() === 'yes';
    const resObj = judge.applyAmbiguousJudgeDecision(decideId, shouldWake);
    sendJson({ ok: true, result: resObj });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/agy/judge-wait') {
    judge.notePoll();
    const decideId = String(url.searchParams.get('decideId') || '').trim();
    if (decideId) {
      const rawWake = String(url.searchParams.get('wake') || '').toLowerCase();
      const shouldWake = rawWake === '1' || rawWake === 'true' || rawWake === 'yes';
      judge.applyAmbiguousJudgeDecision(decideId, shouldWake);
    }
    const timeoutMs = Number(url.searchParams.get('timeoutMs')) || 55000;
    let abortWait = null;
    req.on('close', () => { abortWait?.(); });
    const outcome = await judge.waitNextAmbiguousJudge({
      timeoutMs,
      onAbortRegistrar: (fn) => { abortWait = fn; },
    });
    if (res.writableEnded || res.destroyed) return true;
    sendJson({
      ok: true,
      timedOut: !!outcome.timedOut,
      judge: outcome.item ?? null,
    });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/agy/claim') {
    const { key, token, turn, workerId } = await readBody();
    if (!agentTokenOk(key, token) || !v2SessionAllowed(key) || getMode() !== 'reserved2'
        || socialV2.paused || cfg.socialV2.enabled === false) {
      sendJson({ ok: false, error: '会话令牌无效或当前不接受回复' }, 403);
      return true;
    }
    const result = api.claimTurn(turn, state.sessions[key], workerId);
    if (result === 'stale') { sendJson({ ok: false, error: '该回合已过期或属于其他 Worker' }, 409); return true; }
    sendJson({ ok: true, duplicate: result === 'duplicate' });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/agy/complete') {
    const body = await readBody();
    let sessionId = body?.sessionId ? String(body.sessionId) : '';
    if (!sessionId && body?.key && state.sessions[body.key]) {
      sessionId = state.sessions[body.key];
    }
    const workerId = body?.workerId ? String(body.workerId) : '';
    const forceAll = body?.forceAll === true;
    const completed = api.completeTurn({
      sessionId,
      turn: body?.turn ? String(body.turn) : '',
      workerId: (!forceAll && body?.all === true && !body?.turn) ? (workerId || 'primary') : workerId,
      replyText: typeof body?.replyText === 'string' ? body.replyText : '',
      all: forceAll,
    });
    sendJson({ ok: true, completed });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/agy/wait') {
    const workerId = (url.searchParams.get('workerId') || 'primary').trim();
    const defaultPriority = workerId === 'primary' ? 10 : 5;
    const priorityParam = url.searchParams.get('priority');
    const priority = priorityParam !== null && priorityParam !== '' ? Number(priorityParam) : defaultPriority;
    const finishTurn = url.searchParams.get('finishTurn') || '';
    const finishSessionId = url.searchParams.get('finishSessionId') || '';
    const finishWorker = url.searchParams.get('finishWorker') === '1';
    const finishAll = url.searchParams.get('finishAll') === '1';
    const forceAll = url.searchParams.get('forceAll') === '1';
    const finish = (finishTurn || finishSessionId || finishWorker || finishAll) ? {
      sessionId: finishSessionId, turn: finishTurn,
      workerId: (finishWorker || (finishAll && !forceAll)) ? workerId : '', all: forceAll,
    } : null;
    const timeoutMs = Number(url.searchParams.get('timeoutMs')) || 55000;
    const maxTurns = Number(url.searchParams.get('maxTurns')) || 0;
    const resetWorkerTurns = url.searchParams.get('resetTurns') === '1';
    if (resetWorkerTurns) {
      memory.clearWorkerHotReloadSigsV2(workerId);
    }
    let abortWait = null;
    req.on('close', () => { abortWait?.(); });
    const outcome = await api.waitNextWake({
      timeoutMs,
      workerId,
      priority,
      maxTurns,
      resetWorkerTurns,
      finish,
      onAbortRegistrar: (fn) => { abortWait = fn; },
    });
    if (res.writableEnded || res.destroyed) return true;
    if (outcome.superseded) {
      sendJson({
        ok: true,
        timedOut: false,
        superseded: true,
        workerId,
        wake: null,
      });
    } else if (outcome.rotate) {
      sendJson({
        ok: true,
        timedOut: false,
        rotate: true,
        workerId,
        turnsCompleted: outcome.turnsCompleted || maxTurns,
        wake: null,
      });
    } else if (outcome.wake) {
      const key = reverse.get(outcome.wake.sessionId) ?? null;
      const agentToken = key ? (getSocialV2State(key)?.agentToken || '') : '';
      const hotPrefix = memory.buildWorkerHotReloadPrefixV2(workerId, key);
      const wakePayload = hotPrefix
        ? { ...outcome.wake, text: `${hotPrefix}${outcome.wake.text || ''}`, key, agentToken, mode: getMode(), workerId }
        : { ...outcome.wake, key, agentToken, mode: getMode(), workerId };
      sendJson({
        ok: true,
        timedOut: false,
        wake: wakePayload,
      });
    } else {
      sendJson({ ok: true, timedOut: true, wake: null });
    }
    return true;
  }
  return false;
}
