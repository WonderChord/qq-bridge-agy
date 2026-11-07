import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function loginAttemptFile(root, uin) {
  if (!/^[1-9]\d*$/.test(uin)) throw new Error('napcat.account 无效');
  return path.join(root, 'state', 'napcat-login-' + uin + '.pending');
}

const nativePhases = new Set(['initializing', 'reconnecting', 'generating_qrcode']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 桥接和 ensure-daemons 可能同时观测到掉线。发请求前独占创建标记，即使桥接重启也只尝试一次。
export async function recoverNapcatLogin(root, { uin, webuiUrl, webuiToken }, {
  force = false, statusOnly = false, request = fetch, delay = sleep,
} = {}) {
  async function post(endpoint, body, credential) {
    const res = await request(webuiUrl + '/api/' + endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { 'content-type': 'application/json', ...(credential ? { authorization: 'Bearer ' + credential } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error('NapCat ' + endpoint + ' HTTP ' + res.status), { status: res.status });
    return res.json();
  }
  const hash = crypto.createHash('sha256').update(webuiToken + '.napcat').digest('hex');
  const login = await post('auth/login', { hash });
  if (login.code !== 0 || !login.data?.Credential) throw new Error('NapCat WebUI 鉴权失败，请检查本机 token');
  const qq = (action, body = {}) => post('QQLogin/' + action, body, login.data.Credential);
  const marker = loginAttemptFile(root, uin);
  async function status() {
    const res = await qq('CheckLoginStatus');
    if (res.code !== 0 || typeof res.data?.isLogin !== 'boolean') throw new Error('NapCat 登录状态暂不可读');
    return res.data;
  }
  function observe(st, success) {
    if (st.isLogin && !st.isOffline) {
      if (!statusOnly) fs.rmSync(marker, { force: true });
      return { ok: true, action: success, status: st };
    }
    if (st.qrLoginAccepted || nativePhases.has(st.loginPhase)) {
      return { ok: false, action: 'native_login_pending', webuiUrl };
    }
    return null;
  }
  function scan(st) {
    return { ok: false, action: 'need_qrcode', qrcodeUrl: st.qrcodeurl || '', webuiUrl };
  }
  let st = await status();
  let outcome = observe(st, 'already_online');
  if (outcome || statusOnly) return outcome || scan(st);
  const attempt = fs.statSync(marker, { throwIfNoEntry: false });
  if (attempt && (!force || Date.now() - attempt.mtimeMs < 60_000)) return scan(st);
  await delay(8000);
  st = await status();
  outcome = observe(st, 'native_autologin_online');
  if (outcome) return outcome;

  // 旧版没有票据列表接口，保留一次原有 QuickLogin 尝试。
  let canQuickLogin = !/登录(?:态)?.{0,8}失效|请重新扫码|需要扫码/.test(st.loginError || '');
  if (canQuickLogin) {
    const list = await qq('GetQuickLoginListNew').catch((err) => {
      if (err.status !== 404) throw err;
    });
    if (list?.code === 0 && Array.isArray(list.data)) {
      canQuickLogin = list.data.some((user) => String(user.uin) === uin && user.isQuickLogin !== false);
    }
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  if (attempt && force) fs.rmSync(marker, { force: true });
  try { fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 }); }
  catch (err) { if (err.code === 'EEXIST') return scan(st); throw err; }
  if (canQuickLogin) {
    const result = await qq('SetQuickLogin', { uin });
    if (result.code === 0 || /QQ Is Logined/i.test(result.message || '')) await delay(4000);
    st = await status();
    outcome = observe(st, 'quick_login_success');
    if (outcome) return outcome;
  }
  // 保留已经显示的二维码。仅首次且没有可用二维码时才请求生成。
  if (!st.qrcodeurl) {
    const qr = await qq('GetQQLoginQrcode');
    if (qr.data?.qrcode) return scan({ ...st, qrcodeurl: qr.data.qrcode });
    if (qr.code !== 0 && !/QQ Is Logined/i.test(qr.message || '')) {
      await qq('RefreshQRcode');
      await delay(1500);
      st = await status();
      return observe(st, 'native_autologin_online') || scan(st);
    }
  }
  return scan(st);
}
