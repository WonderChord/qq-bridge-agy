import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recoverNapcatLogin } from '../src/napcat-login.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-napcat-login-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const auth = { uin: '123', webuiUrl: 'http://127.0.0.1:6099', webuiToken: 'fixture' };
  const calls = [];
  const responses = {
    login: { code: 0, data: { Credential: 'test' } },
    CheckLoginStatus: { code: 0, data: { isLogin: false, loginPhase: 'waiting_qrcode', qrcodeurl: 'fixture-qr' } },
    GetQuickLoginListNew: { code: 0, data: [{ uin: '123', isQuickLogin: true }] },
    SetQuickLogin: { code: -1, message: '登录态已失效' },
  };
  const request = async (url, init) => {
    const name = new URL(url).pathname.split('/').pop();
    calls.push(name);
    assert.equal(init.method, 'POST');
    assert.ok(responses[name], '意外的网络操作 ' + name);
    return Response.json(responses[name]);
  };
  return { calls, responses, check: (options) => recoverNapcatLogin(root, auth, { request, delay: async () => {}, ...options }) };
}

test('同一离线期跨守护入口只试一次 QuickLogin，保留原二维码，成功上线后允许下一次恢复', async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.check(), f.check()]);
  assert.ok(results.every((r) => r.action === 'need_qrcode' && r.qrcodeUrl === 'fixture-qr'));
  await f.check();
  assert.equal(f.calls.filter((c) => c === 'SetQuickLogin').length, 1);
  assert.ok(!f.calls.includes('RefreshQRcode'));
  f.responses.CheckLoginStatus.data.isLogin = true;
  assert.equal((await f.check()).action, 'already_online');
  f.responses.CheckLoginStatus.data.isLogin = false;
  await f.check();
  assert.equal(f.calls.filter((c) => c === 'SetQuickLogin').length, 2);
});

test('没有目标票据、扫码已受理或状态读取失败时，不提交登录或刷新二维码', async (t) => {
  const f = fixture(t);
  f.responses.GetQuickLoginListNew.data = [{ uin: '456', isQuickLogin: true }];
  assert.equal((await f.check()).action, 'need_qrcode');
  Object.assign(f.responses.CheckLoginStatus.data, { qrLoginAccepted: true, loginPhase: 'initializing' });
  assert.equal((await f.check()).action, 'native_login_pending');
  f.responses.CheckLoginStatus = { code: 1 };
  await assert.rejects(f.check(), /状态暂不可读/);
  assert.ok(!f.calls.includes('SetQuickLogin') && !f.calls.includes('RefreshQRcode'));
});

test('QuickLogin 回包成功仍检查实际在线，状态查询模式只读', async (t) => {
  const f = fixture(t);
  f.responses.SetQuickLogin.code = 0;
  assert.equal((await f.check({ statusOnly: true })).action, 'need_qrcode');
  assert.deepEqual(f.calls, ['login', 'CheckLoginStatus']);
  assert.equal((await f.check()).action, 'need_qrcode');
  assert.equal(f.calls.at(-1), 'CheckLoginStatus');
});

test('ensure-daemons.ps1 保持纯 ASCII + CRLF，防止 Windows PowerShell 5.1 无 BOM 按 GBK 解析吞掉换行', () => {
  const psFile = path.resolve(import.meta.dirname, 'ensure-daemons.ps1');
  const raw = fs.readFileSync(psFile, 'utf8');
  assert.equal(/[^\x00-\x7F]/.test(raw), false, 'ensure-daemons.ps1 不得含非 ASCII 字符，避免无 BOM 时 GBK 尾字节吞掉下一行代码');
  assert.match(raw, /\r\n\$napProc = @\(Get-HeadlessNapCat\)\r\n/);
});
