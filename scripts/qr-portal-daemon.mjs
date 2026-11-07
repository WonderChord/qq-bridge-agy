#!/usr/bin/env node
/**
 * NapCat 公网扫码与刷新门户守护进程（仅暴露带长随机 Token 的单页扫码路由 /qr/<token>，绝不暴露 WebUI :6099 或 OneBot :3000）
 *
 * 功能：
 * 1. 本机监听 127.0.0.1:3102（或 config.json -> napcat.qrPortalPort）
 * 2. 提供移动端友好页面 GET /qr/<token>：
 *    - 实时显示 QQ 机器人在Line状态 / 登录阶段（每 3 秒自动轮询）
 *    - 展示高清二维码（从 NapCat GetQQLoginQrcode / CheckLoginStatus 或 cache/qrcode.png 读取）
 *    - 「🔄 刷新二维码」按钮（POST /qr/<token>/refresh -> 调用 NapCat RefreshQRcode + GetQQLoginQrcode）
 *    - 「⚡ 尝试免密重登」按钮（POST /qr/<token>/quick-login -> 调用 NapCat SetQuickLogin）
 * 3. 自动拉起并守护 cloudflared Quick Tunnel（--protocol http2 --no-autoupdate --url http://127.0.0.1:3102）
 * 4. 将最新公网扫码地址写入 state/qr-portal.json 与 state/qr-portal-url.txt；
 *    当隧道地址生成/变更且 OneBot 在线时，或当检测到需要扫码（need_qrcode）时，通过私聊把公网扫码链接发给 Creator。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { napcatLoginConfig } from '../src/napcat-config.js';
import { loginAttemptFile } from '../src/napcat-login.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATE_DIR = path.join(ROOT, 'state');
const PORTAL_STATE_FILE = path.join(STATE_DIR, 'qr-portal.json');
const PORTAL_URL_TXT = path.join(STATE_DIR, 'qr-portal-url.txt');
const PORTAL_LOG_FILE = path.join(STATE_DIR, 'qr-portal.log');

fs.mkdirSync(STATE_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(PORTAL_LOG_FILE, line, 'utf8');
  } catch {}
  process.stdout.write(line);
}

function readJsonSafe(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadConfig() {
  return readJsonSafe(path.join(ROOT, 'config.json'), {});
}

const existingState = readJsonSafe(PORTAL_STATE_FILE, {});
const secretToken =
  typeof existingState.secretToken === 'string' && /^[a-f0-9]{24,64}$/i.test(existingState.secretToken)
    ? existingState.secretToken
    : crypto.randomBytes(16).toString('hex');

const cfg0 = loadConfig();
const PORT = Number(cfg0.napcat?.qrPortalPort || existingState.port || 3102);

let currentPublicBaseUrl = existingState.publicBaseUrl || '';
let lastNotifiedPortalUrl = existingState.lastNotifiedPortalUrl || '';
let lastNeedQrNotifiedAt = 0;

function getPortalUrl() {
  return currentPublicBaseUrl ? `${currentPublicBaseUrl}/qr/${secretToken}` : '';
}

function savePortalState(extra = {}) {
  const prev = readJsonSafe(PORTAL_STATE_FILE, {});
  const next = {
    ...prev,
    pid: process.pid,
    port: PORT,
    secretToken,
    localUrl: `http://127.0.0.1:${PORT}/qr/${secretToken}`,
    publicBaseUrl: currentPublicBaseUrl,
    portalUrl: getPortalUrl(),
    lastNotifiedPortalUrl,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  writeJsonAtomic(PORTAL_STATE_FILE, next);
  if (next.portalUrl) {
    try {
      fs.writeFileSync(PORTAL_URL_TXT, `${next.portalUrl}\n`, 'utf8');
    } catch {}
  }
  return next;
}

savePortalState();

// ── NapCat WebUI API 封装 ─────────────────────────────────────────────────────
async function createNapCatClient() {
  const cfg = loadConfig();
  const auth = napcatLoginConfig(ROOT, cfg.napcat);
  async function post(endpoint, body = {}, credential = '') {
    const res = await fetch(`${auth.webuiUrl}/api/${endpoint}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: {
        'content-type': 'application/json',
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`NapCat ${endpoint} HTTP ${res.status}`), { status: res.status });
    }
    return res.json();
  }
  const hash = crypto.createHash('sha256').update(`${auth.webuiToken}.napcat`).digest('hex');
  const login = await post('auth/login', { hash });
  if (login.code !== 0 || !login.data?.Credential) {
    throw new Error('NapCat WebUI 鉴权失败');
  }
  const cred = login.data.Credential;
  return {
    uin: auth.uin,
    webuiUrl: auth.webuiUrl,
    qq: (action, body = {}) => post(`QQLogin/${action}`, body, cred),
  };
}

function findQrCachePngPath() {
  const cfg = loadConfig();
  const webuiCfgPath = cfg.napcat?.webuiConfigPath;
  if (webuiCfgPath) {
    const absWebui = path.isAbsolute(webuiCfgPath) ? webuiCfgPath : path.join(ROOT, webuiCfgPath);
    const candidate = path.join(path.dirname(path.dirname(absWebui)), 'cache', 'qrcode.png');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

async function fetchLoginStatus({ ensureQrIfOffline = false } = {}) {
  const client = await createNapCatClient();
  const res = await client.qq('CheckLoginStatus');
  if (res.code !== 0 || typeof res.data?.isLogin !== 'boolean') {
    throw new Error('NapCat CheckLoginStatus 返回异常');
  }
  let st = res.data;
  const online = Boolean(st.isLogin && !st.isOffline);
  if (online) {
    try {
      fs.rmSync(loginAttemptFile(ROOT, client.uin), { force: true });
    } catch {}
  } else if (ensureQrIfOffline && !st.qrcodeurl) {
    const qr = await client.qq('GetQQLoginQrcode').catch(() => null);
    if (qr?.data?.qrcode) {
      st = { ...st, qrcodeurl: qr.data.qrcode };
    }
  }
  const pngPath = findQrCachePngPath();
  let pngMtimeMs = 0;
  try {
    if (pngPath) pngMtimeMs = fs.statSync(pngPath).mtimeMs;
  } catch {}
  return {
    ok: true,
    uin: client.uin,
    online,
    isLogin: Boolean(st.isLogin),
    isOffline: Boolean(st.isOffline),
    loginPhase: st.loginPhase || '',
    qrLoginAccepted: Boolean(st.qrLoginAccepted),
    coreReady: Boolean(st.coreReady),
    qrcodeUrl: st.qrcodeurl || '',
    loginError: st.loginError || '',
    hasQrPng: Boolean(pngPath),
    pngMtimeMs,
    updatedAt: new Date().toISOString(),
  };
}

async function refreshQrCode() {
  const client = await createNapCatClient();
  try {
    fs.rmSync(loginAttemptFile(ROOT, client.uin), { force: true });
  } catch {}
  log(`[QRPortal] Manual RefreshQRcode requested for ${client.uin}`);
  await client.qq('RefreshQRcode').catch((err) => log(`[QRPortal] RefreshQRcode warn: ${err.message}`));
  await new Promise((r) => setTimeout(r, 1500));
  await client.qq('GetQQLoginQrcode').catch(() => null);
  await new Promise((r) => setTimeout(r, 500));
  return fetchLoginStatus({ ensureQrIfOffline: true });
}

async function triggerQuickLogin() {
  const client = await createNapCatClient();
  try {
    fs.rmSync(loginAttemptFile(ROOT, client.uin), { force: true });
  } catch {}
  log(`[QRPortal] Manual SetQuickLogin requested for ${client.uin}`);
  const r = await client.qq('SetQuickLogin', { uin: client.uin }).catch((err) => ({ code: -1, message: err.message }));
  await new Promise((r) => setTimeout(r, 3500));
  const status = await fetchLoginStatus({ ensureQrIfOffline: true });
  return { ...status, quickLoginResult: r };
}

let restartingNapCat = false;
async function restartNapCat() {
  if (restartingNapCat) {
    throw new Error('NapCat 正在重启中，请稍候...');
  }
  restartingNapCat = true;
  try {
    const cfg = loadConfig();
    const auth = napcatLoginConfig(ROOT, cfg.napcat);
    try {
      fs.rmSync(loginAttemptFile(ROOT, auth.uin), { force: true });
    } catch {}
    const ensureScript = path.join(ROOT, 'scripts', 'ensure-daemons.ps1');
    log(`[QRPortal] Manual RestartNapCat requested for ${auth.uin} via ${ensureScript} -ForceRestartNapCat`);
    await new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ensureScript, '-ForceRestartNapCat'],
        {
          cwd: ROOT,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let out = '';
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        reject(new Error('重启脚本执行超时 (45s)'));
      }, 45000);
      child.stdout.on('data', (d) => (out += d.toString('utf8')));
      child.stderr.on('data', (d) => (out += d.toString('utf8')));
      child.on('exit', (code) => {
        clearTimeout(timer);
        log(`[QRPortal] ensure-daemons -ForceRestartNapCat exited code=${code}: ${out.trim().replace(/\r?\n/g, ' | ')}`);
        if (code === 0) resolve();
        else reject(new Error(`重启脚本退出码 ${code}`));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    let lastErr = null;
    for (let i = 0; i < 10; i++) {
      try {
        const st = await fetchLoginStatus({ ensureQrIfOffline: true });
        return { ...st, restarted: true };
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastErr || new Error('重启后连接 NapCat WebUI 超时');
  } finally {
    restartingNapCat = false;
  }
}

// ── 通过 OneBot 私聊通知主人最新公网扫码链接 ──────────────────────────────────
async function notifyOwnerViaOneBot(messageText) {
  const cfg = loadConfig();
  const ownerQQ = Number(cfg.ownerQQ || 0);
  const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.snowluma?.accessToken || '');
  if (!ownerQQ) return false;
  try {
    const stRes = await fetch(`${httpUrl}/get_status`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    const stBody = await stRes.json().catch(() => ({}));
    if (!stRes.ok || stBody.status !== 'ok' || !stBody.data?.online) return false;

    const sendRes = await fetch(`${httpUrl}/send_private_msg`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        user_id: ownerQQ,
        message: messageText,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const sendBody = await sendRes.json().catch(() => ({}));
    return Boolean(sendRes.ok && sendBody.status === 'ok');
  } catch {
    return false;
  }
}

// ── 移动端 HTML 页面 ──────────────────────────────────────────────────────────
function renderPortalHtml(basePath) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <title>NapCat 远程扫码登录</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f172a;
      --card: #1e293b;
      --text: #f8fafc;
      --sub: #94a3b8;
      --ok: #22c55e;
      --warn: #f59e0b;
      --primary: #3b82f6;
      --primary-active: #2563eb;
      --secondary: #475569;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .card {
      width: 100%;
      max-width: 400px;
      background: var(--card);
      border-radius: 18px;
      padding: 22px 20px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45);
      text-align: center;
      border: 1px solid rgba(255,255,255,0.08);
    }
    h1 {
      font-size: 19px;
      margin: 0 0 6px;
      font-weight: 700;
    }
    .sub {
      font-size: 13px;
      color: var(--sub);
      margin-bottom: 16px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 14px;
      background: rgba(255,255,255,0.07);
    }
    .badge.online {
      background: rgba(34, 197, 94, 0.18);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.35);
    }
    .badge.offline {
      background: rgba(245, 158, 11, 0.18);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.35);
    }
    .qr-box {
      width: 248px;
      height: 248px;
      margin: 0 auto 16px;
      background: #ffffff;
      border-radius: 14px;
      padding: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }
    .qr-box img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      image-rendering: pixelated;
    }
    .qr-overlay {
      position: absolute;
      inset: 0;
      background: rgba(15, 23, 42, 0.88);
      color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 16px;
      font-size: 14px;
      line-height: 1.5;
    }
    .qr-overlay.hidden { display: none; }
    .meta {
      font-size: 12px;
      color: var(--sub);
      margin-bottom: 16px;
      line-height: 1.6;
      word-break: break-all;
    }
    .btn-row {
      display: flex;
      gap: 10px;
      margin-bottom: 10px;
    }
    button {
      flex: 1;
      border: none;
      border-radius: 11px;
      padding: 12px 14px;
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
    }
    button:active { transform: scale(0.98); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn-primary { background: var(--primary); }
    .btn-primary:hover { background: var(--primary-active); }
    .btn-secondary { background: var(--secondary); }
    .btn-warn {
      background: rgba(245, 158, 11, 0.22);
      border: 1px solid rgba(245, 158, 11, 0.45);
      color: #fcd34d;
    }
    .btn-warn:hover {
      background: rgba(245, 158, 11, 0.35);
    }
    .toast {
      font-size: 12px;
      color: #93c5fd;
      min-height: 18px;
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>🐾 Nya (NapCat) 远程扫码</h1>
    <div class="sub" id="uinText">账号加载中...</div>
    <div class="badge offline" id="statusBadge">⏳ 正在检测状态...</div>

    <div class="qr-box">
      <img id="qrImg" alt="QQ Login QR Code" src="${basePath}/image.png?t=${Date.now()}" />
      <div class="qr-overlay hidden" id="qrOverlay"></div>
    </div>

    <div class="meta" id="metaText">每 3 秒自动同步状态</div>

    <div class="btn-row">
      <button class="btn-primary" id="btnRefresh" onclick="doRefreshQr()">🔄 刷新二维码</button>
      <button class="btn-secondary" id="btnQuick" onclick="doQuickLogin()">⚡ 免密重登</button>
    </div>
    <div class="btn-row">
      <button class="btn-warn" id="btnRestart" onclick="doRestartNapCat()">🔁 重启 NapCat 内核（二维码卡死时用）</button>
    </div>
    <div class="toast" id="toast"></div>
  </div>

  <script>
    const BASE = ${JSON.stringify(basePath)};
    let lastPngMtime = 0;
    let busy = false;

    function setToast(msg) {
      document.getElementById('toast').textContent = msg || '';
    }

    function reloadQrImage(forceTs) {
      const img = document.getElementById('qrImg');
      img.src = BASE + '/image.png?t=' + (forceTs || Date.now());
    }

    function renderStatus(st) {
      document.getElementById('uinText').textContent = 'Bot QQ: ' + (st.uin || '-');
      const badge = document.getElementById('statusBadge');
      const overlay = document.getElementById('qrOverlay');
      const meta = document.getElementById('metaText');

      if (st.online) {
        badge.className = 'badge online';
        badge.textContent = '🟢 已在线 (Ready)';
        overlay.className = 'qr-overlay';
        overlay.innerHTML = '<div style="font-size:34px;margin-bottom:8px">✅</div><div>当前 QQ 已在线，无需扫码</div>';
      } else if (st.qrLoginAccepted) {
        badge.className = 'badge offline';
        badge.textContent = '🟡 已扫码，请在手机 QQ 点确认';
        overlay.className = 'qr-overlay';
        overlay.innerHTML = '<div style="font-size:32px;margin-bottom:8px">📱</div><div>已扫描，请在手机端确认登录...</div>';
      } else {
        badge.className = 'badge offline';
        badge.textContent = '🟠 等待扫码 (' + (st.loginPhase || 'need_qrcode') + ')';
        overlay.className = 'qr-overlay hidden';
        if (st.pngMtimeMs && st.pngMtimeMs !== lastPngMtime) {
          lastPngMtime = st.pngMtimeMs;
          reloadQrImage(st.pngMtimeMs);
        }
      }

      const parts = [];
      parts.push('阶段: ' + (st.loginPhase || '-'));
      if (st.loginError) parts.push('提示: ' + st.loginError);
      parts.push('更新: ' + new Date().toLocaleTimeString());
      meta.textContent = parts.join(' | ');
    }

    async function pollStatus() {
      if (busy) return;
      try {
        const res = await fetch(BASE + '/status', { cache: 'no-store' });
        const data = await res.json();
        if (data && data.ok) renderStatus(data);
      } catch (e) {
        document.getElementById('metaText').textContent = '网络请求失败，稍后重试...';
      }
    }

    async function doRefreshQr() {
      if (busy) return;
      busy = true;
      const btn = document.getElementById('btnRefresh');
      btn.disabled = true;
      setToast('正在请求 NapCat 刷新二维码...');
      try {
        const res = await fetch(BASE + '/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (data && data.ok) {
          renderStatus(data);
          reloadQrImage(Date.now());
          setToast('✅ 二维码已刷新！请使用手机 QQ 扫码');
        } else {
          setToast('❌ 刷新失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        setToast('❌ 请求异常: ' + e.message);
      } finally {
        btn.disabled = false;
        busy = false;
      }
    }

    async function doQuickLogin() {
      if (busy) return;
      busy = true;
      const btn = document.getElementById('btnQuick');
      btn.disabled = true;
      setToast('正在尝试免密快速重登...');
      try {
        const res = await fetch(BASE + '/quick-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (data && data.ok) {
          renderStatus(data);
          if (data.online) {
            setToast('🎉 免密重登成功！');
          } else {
            reloadQrImage(Date.now());
            setToast('⚠️ 免密票据已失效，请点击刷新或直接扫码');
          }
        } else {
          setToast('❌ 操作失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        setToast('❌ 请求异常: ' + e.message);
      } finally {
        btn.disabled = false;
        busy = false;
      }
    }

    async function doRestartNapCat() {
      if (busy) return;
      busy = true;
      const btn = document.getElementById('btnRestart');
      const btnRefresh = document.getElementById('btnRefresh');
      const btnQuick = document.getElementById('btnQuick');
      btn.disabled = true;
      btnRefresh.disabled = true;
      btnQuick.disabled = true;
      setToast('⏳ 正在重启无头 NapCat 内核（约需 8~12 秒），请勿关闭页面...');
      try {
        const res = await fetch(BASE + '/restart-napcat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (data && data.ok) {
          renderStatus(data);
          if (data.online) {
            setToast('🎉 NapCat 重启并自动免密登录成功！');
          } else {
            reloadQrImage(Date.now());
            setToast('✅ NapCat 已重启并生成全新二维码，请扫码！');
          }
        } else {
          setToast('❌ 重启失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        setToast('❌ 请求异常: ' + e.message);
      } finally {
        btn.disabled = false;
        btnRefresh.disabled = false;
        btnQuick.disabled = false;
        busy = false;
      }
    }

    pollStatus();
    setInterval(pollStatus, 3000);
  </script>
</body>
</html>`;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const basePath = `/qr/${secretToken}`;

async function handlePortalRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const commonHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...commonHeaders });
    res.end(JSON.stringify({ ok: true, pid: process.pid, portalUrl: getPortalUrl() }));
    return;
  }

  if (!url.pathname.startsWith(basePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...commonHeaders });
    res.end('Not Found');
    return;
  }

  const subPath = url.pathname.slice(basePath.length) || '/';

  try {
    if (req.method === 'GET' && (subPath === '/' || subPath === '')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...commonHeaders });
      res.end(renderPortalHtml(basePath));
      return;
    }

    if (req.method === 'GET' && subPath === '/status') {
      const st = await fetchLoginStatus({ ensureQrIfOffline: true });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...commonHeaders });
      res.end(JSON.stringify(st));
      return;
    }

    if (req.method === 'GET' && subPath === '/image.png') {
      await fetchLoginStatus({ ensureQrIfOffline: true }).catch(() => null);
      const pngPath = findQrCachePngPath();
      if (!pngPath || !fs.existsSync(pngPath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...commonHeaders });
        res.end('QR image not found');
        return;
      }
      const buf = fs.readFileSync(pngPath);
      res.writeHead(200, { 'content-type': 'image/png', ...commonHeaders });
      res.end(buf);
      return;
    }

    if (req.method === 'POST' && subPath === '/refresh') {
      const st = await refreshQrCode();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...commonHeaders });
      res.end(JSON.stringify(st));
      return;
    }

    if (req.method === 'POST' && subPath === '/quick-login') {
      const st = await triggerQuickLogin();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...commonHeaders });
      res.end(JSON.stringify(st));
      return;
    }

    if (req.method === 'POST' && subPath === '/restart-napcat') {
      const st = await restartNapCat();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...commonHeaders });
      res.end(JSON.stringify(st));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...commonHeaders });
    res.end('Not Found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', ...commonHeaders });
    res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  }
}

const server = http.createServer(handlePortalRequest);
let fixedIngressServer = null;
let fixedIngressActive = false;

// ── Cloudflared 隧道守护（优先使用固定域名 Named Tunnel，仅暴露 /qr/<token>，其余 404） ──
let cfChild = null;
let stopping = false;
const CF_METRICS_PORT = Number(cfg0.napcat?.qrPortalMetricsPort || 20245);
const CF_LOG_FILE = path.join(STATE_DIR, 'cloudflared-qr.log');
const FIXED_INGRESS_PORT = Number(cfg0.napcat?.qrPortalFixedIngressPort || 18188);
const FIXED_PUBLIC_BASE_URL = String(
  cfg0.napcat?.qrPortalFixedPublicBaseUrl || ''
).replace(/\/+$/, '');

function resolveTunnelTokenFile() {
  const candidates = [
    cfg0.napcat?.qrPortalTunnelTokenFile,
    path.join(STATE_DIR, 'cf-tunnel-token.txt'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.readFileSync(c, 'utf8').trim().length > 20) {
        return c;
      }
    } catch {}
  }
  return '';
}

function tryListenFixedIngressPort() {
  return new Promise((resolve) => {
    const tokenFile = resolveTunnelTokenFile();
    if (!tokenFile || !FIXED_INGRESS_PORT || FIXED_INGRESS_PORT === PORT) {
      resolve(false);
      return;
    }
    const srv = http.createServer(handlePortalRequest);
    srv.once('error', (err) => {
      log(`[QRPortal] Fixed ingress port 127.0.0.1:${FIXED_INGRESS_PORT} unavailable (${err.message}), falling back to Quick Tunnel.`);
      resolve(false);
    });
    srv.listen(FIXED_INGRESS_PORT, '127.0.0.1', () => {
      fixedIngressServer = srv;
      fixedIngressActive = true;
      log(`[QRPortal] Fixed ingress listener bound on http://127.0.0.1:${FIXED_INGRESS_PORT}${basePath} (strictly 404 for all other paths)`);
      resolve(true);
    });
  });
}

function resolveCloudflaredExe() {
  const candidates = [
    cfg0.napcat?.cloudflaredPath,
    path.join(ROOT, 'bin', 'cloudflared.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'cloudflared.exe';
}

function startCloudflaredTunnel() {
  if (stopping) return;
  const exe = resolveCloudflaredExe();
  const tokenFile = resolveTunnelTokenFile();
  const useFixedNamedTunnel = Boolean(fixedIngressActive && tokenFile && FIXED_PUBLIC_BASE_URL);

  const args = useFixedNamedTunnel
    ? [
        'tunnel',
        '--no-autoupdate',
        '--protocol',
        'http2',
        '--edge-ip-version',
        '4',
        '--metrics',
        `127.0.0.1:${CF_METRICS_PORT}`,
        'run',
        '--token-file',
        tokenFile,
      ]
    : [
        'tunnel',
        '--no-autoupdate',
        '--protocol',
        'http2',
        '--edge-ip-version',
        '4',
        '--metrics',
        `127.0.0.1:${CF_METRICS_PORT}`,
        '--url',
        `http://127.0.0.1:${PORT}`,
      ];

  if (useFixedNamedTunnel && currentPublicBaseUrl !== FIXED_PUBLIC_BASE_URL) {
    currentPublicBaseUrl = FIXED_PUBLIC_BASE_URL;
    savePortalState({ tunnelMode: 'named_fixed' });
  }

  log(`[QRPortal] Spawning cloudflared (${useFixedNamedTunnel ? 'fixed:' + FIXED_PUBLIC_BASE_URL : 'quick'}): ${exe} ${args.join(' ')}`);
  const child = spawn(exe, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cfChild = child;

  const onChunk = (chunk) => {
    const text = chunk.toString('utf8');
    try {
      fs.appendFileSync(CF_LOG_FILE, text, 'utf8');
    } catch {}
    if (useFixedNamedTunnel) {
      if (/Registered tunnel connection/i.test(text)) {
        currentPublicBaseUrl = FIXED_PUBLIC_BASE_URL;
        const fullUrl = getPortalUrl();
        savePortalState({ tunnelMode: 'named_fixed' });
        log(`[QRPortal] Fixed Public QR Portal ready: ${fullUrl}`);
        void maybeNotifyPortalUrl();
      }
      return;
    }
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && match[0] !== currentPublicBaseUrl) {
      currentPublicBaseUrl = match[0];
      const fullUrl = getPortalUrl();
      savePortalState({ tunnelMode: 'quick' });
      log(`[QRPortal] Public QR Portal ready: ${fullUrl}`);
      void maybeNotifyPortalUrl();
    }
  };

  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  child.on('exit', (code, signal) => {
    log(`[QRPortal] cloudflared exited (code=${code}, signal=${signal})`);
    cfChild = null;
    if (!stopping) {
      setTimeout(startCloudflaredTunnel, 5000);
    }
  });
}

let tunnelFailCount = 0;
async function checkTunnelHealth() {
  if (stopping || !cfChild || !currentPublicBaseUrl) return;
  try {
    const mRes = await fetch(`http://127.0.0.1:${CF_METRICS_PORT}/ready`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!mRes.ok) throw new Error(`metrics /ready HTTP ${mRes.status}`);
    tunnelFailCount = 0;
  } catch (err) {
    tunnelFailCount += 1;
    log(`[QRPortal] Tunnel health check failed (${tunnelFailCount}/2): ${err.message}`);
    if (tunnelFailCount >= 2 && cfChild) {
      tunnelFailCount = 0;
      log(`[QRPortal] Restarting unresponsive cloudflared process...`);
      try {
        cfChild.kill();
      } catch {}
    }
  }
}

async function maybeNotifyPortalUrl() {
  const fullUrl = getPortalUrl();
  if (!fullUrl || fullUrl === lastNotifiedPortalUrl) return;
  const sent = await notifyOwnerViaOneBot(
    `[NapCat 远程扫码固定网址已就绪]\n手机端永久扫码/刷新二维码链接：\n${fullUrl}\n（收藏此固定网址即可；在外掉线需扫码时直接点开点击“刷新二维码”扫码）`
  );
  if (sent) {
    lastNotifiedPortalUrl = fullUrl;
    savePortalState({ lastNotifiedPortalUrl });
    log(`[QRPortal] Sent new portal URL to owner via QQ.`);
  }
}

setInterval(() => {
  void maybeNotifyPortalUrl();
  void checkTunnelHealth();
}, 45_000);

function shutdown() {
  stopping = true;
  if (cfChild) {
    try {
      cfChild.kill();
    } catch {}
  }
  if (fixedIngressServer) {
    try {
      fixedIngressServer.close();
    } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', async () => {
  log(`[QRPortal] Listening on http://127.0.0.1:${PORT}${basePath}`);
  await tryListenFixedIngressPort();
  savePortalState();
  startCloudflaredTunnel();
});
