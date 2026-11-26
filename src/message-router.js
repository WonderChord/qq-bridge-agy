import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_ROUTER_MODEL = 'gpt-6-luna';
export const DEFAULT_ROUTER_TIMEOUT_MS = 10_000;
export const DEFAULT_ROUTER_MAX_OUTPUT_TOKENS = 64;

/**
 * 纯中立的群聊消息路由分类器 System Prompt。
 * 仅包含判断是否被呼叫、是否适合接话的客观准则，严禁注入任何角色扮演设定或私人记忆内容。
 */
export const ROUTER_SYSTEM_PROMPT = [
  '你是一个纯中立的群聊消息路由分类器（Message Router）。你的唯一任务是根据群聊近期上下文与当前消息，客观判断群聊助手是否应当回复该消息。',
  '',
  '判定准则：',
  '1. 明确呼叫、引用回复助手或互动（必须判 should_reply = true）：',
  '   - 只要元信息显示「明确@助手=是」或「引用回复助手=是」（包含引用助手的文字、图片或表情包后发表评价、吐槽、陈述观点、追问或下达指令，即使没有问号或未再次直呼名字），一律视为直接对助手说话，必须判 should_reply = true（仅当明确写“不用回”时除外）；',
  '   - 直呼助手名称/别名向其提问、搭话、请求协助，或群内管理员提及助手名称/别名；',
  '   - 提及助手泛称并询问其是否在线/死机/卡住/不回消息（如“机器人怎么又卡了”、“助手还没上线吗”），属于在呼叫助手，必须判 should_reply = true；',
  '   - 发送者正在顺着助手刚刚参与的话茬继续追问或接话。',
  '2. 同名误触或无关提及（should_reply = false）：',
  '   - 未@助手且未引用助手，仅出现与助手别名同音/同形的网络热梗、背景音乐梗或讨论无关事物，并非在对助手说话；',
  '   - @全体成员 的群通知，或引用其他群成员的消息进行群友间对话。',
  '3. 无点名的群内上下文抽样（严格克制）：',
  '   - 仅当上下文存在明确的公共讨论焦点、趣味槽点或开放问题，且助手简短接话自然得体时，判 should_reply = true；',
  '   - 普通日常碎片闲聊、单字/复读/纯表情图片刷屏、未说完的残句、他人严肃私事或插不上话的长对话，一律判 should_reply = false。',
  '',
  '输出要求：',
  '禁止输出任何解释、思考过程或 Markdown 代码块，仅输出一行严格合法的精简 JSON：',
  '{"should_reply": boolean, "reason": "简短原因"}',
].join('\n');

const envCache = new Map(); // envPath -> { mtimeMs, values }

export function parseDotEnvText(raw) {
  const out = Object.create(null);
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = cleaned.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') {
        val = val.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    } else {
      const hashIdx = val.indexOf(' #');
      if (hashIdx >= 0) val = val.slice(0, hashIdx).trim();
    }
    out[key] = val;
  }
  return out;
}

export function loadDotEnvFile(envFilePath) {
  if (!envFilePath) return Object.create(null);
  try {
    const stat = fs.statSync(envFilePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      envCache.delete(envFilePath);
      return Object.create(null);
    }
    const cached = envCache.get(envFilePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.values;
    }
    const values = parseDotEnvText(fs.readFileSync(envFilePath, 'utf8'));
    envCache.set(envFilePath, { mtimeMs: stat.mtimeMs, values });
    return values;
  } catch {
    return Object.create(null);
  }
}

export function parseQqIdList(value) {
  const items = [];
  if (Array.isArray(value)) {
    for (const v of value) items.push(...String(v ?? '').split(/[,;\s]+/));
  } else if (value !== undefined && value !== null) {
    items.push(...String(value).split(/[,;\s]+/));
  }
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (/^[1-9]\d*$/.test(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

export function normalizeOpenAiBaseUrl(rawUrl) {
  let base = String(rawUrl ?? '').trim();
  if (!base) base = DEFAULT_OPENAI_BASE_URL;
  base = base.replace(/\/+$/, '');
  if (/^https?:\/\/api\.openai\.com$/i.test(base)) {
    base += '/v1';
  }
  return base;
}

export function resolveRouterConfig({ rootDir = '', env = process.env, cfg = {} } = {}) {
  const fileEnv = rootDir ? loadDotEnvFile(path.join(rootDir, '.env')) : Object.create(null);
  const pick = (key) => {
    const fromProc = env && typeof env[key] === 'string' ? env[key].trim() : '';
    if (fromProc) return fromProc;
    const fromFile = typeof fileEnv[key] === 'string' ? fileEnv[key].trim() : '';
    return fromFile;
  };

  const apiKey = pick('OPENAI_API_KEY') || String(cfg?.router?.apiKey ?? '').trim();
  const baseUrl = normalizeOpenAiBaseUrl(pick('OPENAI_BASE_URL') || cfg?.router?.baseUrl || DEFAULT_OPENAI_BASE_URL);
  const model = pick('ROUTER_MODEL') || String(cfg?.router?.model ?? '').trim() || DEFAULT_ROUTER_MODEL;

  const envOwnerIds = parseQqIdList(pick('OWNER_QQ_IDS'));
  const cfgExplicitOwnerIds = parseQqIdList(cfg?.ownerQQIds);
  const explicitOwnerIds = parseQqIdList([...envOwnerIds, ...cfgExplicitOwnerIds]);

  const fallbackIds = parseQqIdList([
    cfg?.ownerQQ,
    ...(Array.isArray(cfg?.persona?.creatorUids) ? cfg.persona.creatorUids : []),
  ]);
  const ownerIds = parseQqIdList([...explicitOwnerIds, ...fallbackIds]);

  const rawTimeout = Number(pick('ROUTER_TIMEOUT_MS') || cfg?.router?.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 50
    ? Math.min(30_000, Math.round(rawTimeout))
    : DEFAULT_ROUTER_TIMEOUT_MS;

  const rawMaxTokens = Number(pick('ROUTER_MAX_OUTPUT_TOKENS') || cfg?.router?.maxOutputTokens);
  const maxOutputTokens = Number.isFinite(rawMaxTokens) && rawMaxTokens >= 16
    ? Math.min(256, Math.round(rawMaxTokens))
    : DEFAULT_ROUTER_MAX_OUTPUT_TOKENS;

  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs,
    maxOutputTokens,
    explicitOwnerIds,
    ownerIds,
    ownerIdSet: new Set(ownerIds),
    hasExplicitOwnerIds: explicitOwnerIds.length > 0,
    hasApiKey: Boolean(apiKey),
  };
}

export function hasExplicitAtSelf(event, extraSelfIds = []) {
  const selfIds = new Set(
    parseQqIdList([event?.self_id, ...(Array.isArray(extraSelfIds) ? extraSelfIds : [extraSelfIds])])
  );
  if (selfIds.size === 0) return false;

  if (Array.isArray(event?.message)) {
    for (const seg of event.message) {
      if (seg?.type === 'at') {
        const qq = String(seg?.data?.qq ?? '').trim();
        if (qq && qq !== 'all' && selfIds.has(qq)) return true;
      }
    }
  }

  for (const rawField of [typeof event?.message === 'string' ? event.message : '', event?.raw_message ?? '']) {
    const raw = String(rawField || '');
    if (!raw) continue;
    for (const id of selfIds) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cqRe = new RegExp(`\\[CQ:at,qq=${escaped}(?:,[^\\]]*)?\\]`, 'i');
      const plainAtRe = new RegExp(`(?<!\\d)@${escaped}(?!\\d)`);
      if (cqRe.test(raw) || plainAtRe.test(raw)) return true;
    }
  }
  return false;
}

export function extractRouterResponseText(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      if (typeof item?.text === 'string') parts.push(item.text);
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string') parts.push(c.text);
        }
      }
    }
    const joined = parts.join('').trim();
    if (joined) return joined;
  }
  const chatContent = data?.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string' && chatContent.trim()) {
    return chatContent.trim();
  }
  if (Array.isArray(chatContent)) {
    const joined = chatContent.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('').trim();
    if (joined) return joined;
  }
  return '';
}

export function parseRouterJson(rawText) {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) throw new Error('empty router response text');
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = /\{[\s\S]*\}/.exec(cleaned);
    if (!match) throw new Error(`invalid router JSON: ${cleaned.slice(0, 120)}`);
    parsed = JSON.parse(match[0]);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.should_reply !== 'boolean') {
    throw new Error(`router JSON missing boolean should_reply: ${cleaned.slice(0, 120)}`);
  }
  const reason = String(parsed.reason ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120)
    || (parsed.should_reply ? '需要回复' : '无需回复');
  return { should_reply: parsed.should_reply, reason };
}

export function buildRouterInput({
  groupKey = '',
  triggerReason = '',
  selfQqId = '',
  assistantAliases = [],
  explicitAtSelf = false,
  quoteTargetIsSelf = false,
  senderIsAdmin = false,
  senderLabel = '群成员',
  targetText = '',
  recentMessages = [],
} = {}) {
  const aliases = [...new Set(
    (Array.isArray(assistantAliases) ? assistantAliases : [])
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
  )].slice(0, 12);

  const metaBits = [
    groupKey ? `会话=${groupKey}` : '',
    selfQqId ? `助手QQ=${selfQqId}` : '',
    aliases.length ? `助手名称与触发词=[${aliases.join(', ')}]` : '',
    triggerReason ? `触发类型=${triggerReason}` : '',
    `明确@助手=${explicitAtSelf ? '是' : '否'}`,
    `引用回复助手=${quoteTargetIsSelf ? '是' : '否'}`,
    `发送者为管理员=${senderIsAdmin ? '是' : '否'}`,
  ].filter(Boolean);

  const lines = [`[路由元信息] ${metaBits.join(' | ')}`];
  if (Array.isArray(recentMessages) && recentMessages.length > 0) {
    lines.push('[近期群聊上下文]');
    for (const [idx, m] of recentMessages.slice(-12).entries()) {
      const who = String(m?.sender || '群成员').replace(/[\r\n]+/g, ' ').slice(0, 40);
      const txt = String(m?.text || '').replace(/[\r\n]+/g, ' ').slice(0, 160);
      lines.push(`[${idx + 1}] ${who}: ${txt}`);
    }
  }
  if (targetText) {
    const cleanTarget = String(targetText).replace(/[\r\n]+/g, ' ').slice(0, 220);
    lines.push(`[当前待判定消息] ${senderLabel}: ${cleanTarget}`);
  }
  lines.push('请输出 JSON：{"should_reply": boolean, "reason": "简短原因"}');
  return lines.join('\n');
}

/**
 * 调用 OpenAI 官方 Responses API（404/405/501 时自动兼容回退 Chat Completions）进行轻量意图路由。
 * 发生超时、网络异常或未配置密钥时，严格执行容错兜底：仅明确包含 @自身QQ号 或引用自身消息时放行，其余静默忽略。
 */
export async function classifyGroupMessageWithRouter({
  routerCfg,
  routerInput,
  explicitAtSelf = false,
  quoteTargetIsSelf = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const t0 = Date.now();
  if ((explicitAtSelf || quoteTargetIsSelf) && !/\[当前待判定消息\][^\r\n]*(?:不用回|别回|勿回)/.test(String(routerInput || ''))) {
    return {
      ok: true,
      degraded: false,
      should_reply: true,
      reason: explicitAtSelf ? '明确@助手本地零延迟直通' : '引用助手消息本地零延迟直通',
      model: 'local-fastpath',
      endpoint: 'fastpath',
      latencyMs: 0,
    };
  }
  const model = routerCfg?.model || DEFAULT_ROUTER_MODEL;
  const baseUrl = normalizeOpenAiBaseUrl(routerCfg?.baseUrl || DEFAULT_OPENAI_BASE_URL);
  const timeoutMs = Number(routerCfg?.timeoutMs) || DEFAULT_ROUTER_TIMEOUT_MS;
  const maxOutputTokens = Number(routerCfg?.maxOutputTokens) || DEFAULT_ROUTER_MAX_OUTPUT_TOKENS;
  const apiKey = String(routerCfg?.apiKey ?? '').trim();

  const fallback = (errorMsg) => {
    const latencyMs = Date.now() - t0;
    if (explicitAtSelf || quoteTargetIsSelf) {
      return {
        ok: false,
        degraded: true,
        should_reply: true,
        reason: explicitAtSelf ? '路由异常，命中@自身QQ号降级放行' : '路由异常，命中引用自身消息降级放行',
        error: errorMsg,
        model,
        endpoint: explicitAtSelf ? 'fallback:at-self' : 'fallback:quote-self',
        latencyMs,
      };
    }
    return {
      ok: false,
      degraded: true,
      should_reply: false,
      reason: '路由异常，非明确@自身QQ号静默忽略',
      error: errorMsg,
      model,
      endpoint: 'fallback:silent-drop',
      latencyMs,
    };
  };

  if (!apiKey) {
    return fallback('OPENAI_API_KEY 未配置');
  }
  if (typeof fetchImpl !== 'function') {
    return fallback('fetch 不可用');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`router timeout after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();

  try {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    };

    let endpoint = 'responses';
    let res = await fetchImpl(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        instructions: ROUTER_SYSTEM_PROMPT,
        input: routerInput,
        reasoning: { effort: 'none' },
        max_output_tokens: maxOutputTokens,
        store: false,
      }),
      signal: controller.signal,
    });

    if (res.status === 404 || res.status === 405 || res.status === 501) {
      endpoint = 'chat.completions';
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: ROUTER_SYSTEM_PROMPT },
            { role: 'user', content: routerInput },
          ],
          reasoning_effort: 'none',
          max_completion_tokens: maxOutputTokens,
          temperature: 0,
        }),
        signal: controller.signal,
      });
    }

    if (!res.ok) {
      let detail = '';
      try {
        const errText = await res.text();
        detail = errText.replace(/[\r\n]+/g, ' ').slice(0, 160);
      } catch {}
      return fallback(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }

    const data = await res.json();
    const rawText = extractRouterResponseText(data);
    const decision = parseRouterJson(rawText);
    return {
      ok: true,
      degraded: false,
      should_reply: decision.should_reply,
      reason: decision.reason,
      model: String(data?.model || model),
      endpoint,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    const msg = controller.signal.aborted
      ? `timeout (${timeoutMs}ms)`
      : String(err?.message ?? err ?? 'unknown error').slice(0, 160);
    return fallback(msg);
  } finally {
    clearTimeout(timer);
  }
}
