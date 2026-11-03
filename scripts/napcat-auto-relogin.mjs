#!/usr/bin/env node
/**
 * NapCat 免密快速登录辅助脚本（已永久移除明文 PasswordLogin 回退，防止触发腾讯滑块风控顶废票据）
 * 用法：
 *   node scripts/napcat-auto-relogin.mjs          # 检查状态，若离线仅尝试一次 SetQuickLogin；若票据失效则刷新二维码等待扫码
 *   node scripts/napcat-auto-relogin.mjs --force  # 无论当前状态，若未登录则立刻尝试 SetQuickLogin
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { napcatLoginConfig } from '../src/napcat-config.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function loadAuthConfig() {
  const file = path.join(root, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  return napcatLoginConfig(root, cfg.napcat);
}

async function getCredential(webuiUrl, token) {
  const hash = crypto.createHash('sha256').update(`${token}.napcat`).digest('hex');
  const res = await fetch(`${webuiUrl}/api/auth/login`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data?.Credential) {
    throw new Error(`NapCat WebUI 鉴权失败: ${json.message || JSON.stringify(json)}`);
  }
  return json.data.Credential;
}

async function napcatPost(webuiUrl, cred, endpoint, body = {}) {
  const res = await fetch(`${webuiUrl}${endpoint}`, {
    method: 'POST', redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cred}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return await res.json();
}

export async function checkAndReloginNapCat({ force = false, logger = console.log } = {}) {
  const auth = loadAuthConfig();
  const { uin, webuiUrl, webuiToken } = auth;
  const cred = await getCredential(webuiUrl, webuiToken);

  let statusRes = await napcatPost(webuiUrl, cred, '/api/QQLogin/CheckLoginStatus');
  let st = statusRes?.data || {};
  if (!force && st.isLogin && !st.isOffline) {
    return { ok: true, action: 'already_online', status: st };
  }

  // 给 NapCat 启动期的原生本地票据自动登录留足 8 秒窗口，避免抢调接口冲突
  logger(`[NapCatAutoLogin] 检测到 QQ(${uin}) 尚未就绪 (isLogin=${st.isLogin}, isOffline=${st.isOffline}, phase=${st.loginPhase || 'init'})，等待 8 秒确认原生自动登录结果...`);
  await new Promise((r) => setTimeout(r, 8000));
  statusRes = await napcatPost(webuiUrl, cred, '/api/QQLogin/CheckLoginStatus');
  st = statusRes?.data || {};
  if (st.isLogin && !st.isOffline) {
    logger(`[NapCatAutoLogin] ✅ 原生本地票据已自动上线: ${uin}`);
    return { ok: true, action: 'native_autologin_online', status: st };
  }

  // 仅尝试一次免密快速登录 (SetQuickLogin)，严禁回退明文 PasswordLogin
  try {
    const qRes = await napcatPost(webuiUrl, cred, '/api/QQLogin/SetQuickLogin', { uin });
    if (qRes.code === 0 || (typeof qRes.message === 'string' && qRes.message.includes('QQ Is Logined'))) {
      await new Promise((r) => setTimeout(r, 4000));
      const stAfter = (await napcatPost(webuiUrl, cred, '/api/QQLogin/CheckLoginStatus'))?.data || {};
      if (stAfter.isLogin && !stAfter.isOffline) {
        logger(`[NapCatAutoLogin] ✅ 快速登录 (QuickLogin) 成功: ${uin}`);
        return { ok: true, action: 'quick_login_success', detail: qRes };
      }
    }
    logger(`[NapCatAutoLogin] ⚠️ 快速登录票据不可用 (${qRes?.message || 'expired'})，已刷新二维码等待扫码（已禁用 PasswordLogin 防止风控）`);
  } catch (err) {
    logger(`[NapCatAutoLogin] ⚠️ 快速登录请求异常 (${err.message})，刷新二维码等待扫码`);
  }

  await napcatPost(webuiUrl, cred, '/api/QQLogin/RefreshQRcode').catch(() => null);
  await new Promise((r) => setTimeout(r, 1500));
  const qrRes = await napcatPost(webuiUrl, cred, '/api/QQLogin/GetQQLoginQrcode').catch(() => null);
  const qrcodeUrl = qrRes?.data?.qrcode || '';
  return { ok: false, action: 'need_qrcode', qrcodeUrl, webuiUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const force = process.argv.includes('--force');
  checkAndReloginNapCat({ force })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('[NapCatAutoLogin] Error:', err.message);
      process.exit(1);
    });
}
