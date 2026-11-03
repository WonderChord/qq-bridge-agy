import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgyApiClient } from '../src/dsh-client.js';
import { napcatLoginConfig } from '../src/napcat-config.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('离线唤醒从领取时计时，取消和结清的任务离开待领队列', async (t) => {
  const file = path.join(tempDir(t), 'turns.json');
  const client = new AgyApiClient('agy://local', file);
  const prompt = async (sessionId) => (await client.sessions.prompt({ sessionId, content: [] })).result.value.turn;
  const cancelled = await prompt('cancel');
  const waiting = await prompt('waiting');
  client.completeTurn({ turn: cancelled });
  client._activeTurns.get(waiting).startedAt -= 80_000;
  assert.equal(client.activeTurnCount('waiting'), 1);
  const { wake } = await client.waitNextWake({ workerId: 'w1' });
  assert.equal(wake.turn, waiting);
  assert.equal(client.claimTurn(waiting, 'waiting', 'w2'), 'stale');
  assert.equal(client.claimTurn(waiting, 'cancel', 'w1'), 'stale');
  assert.equal(client.claimTurn(waiting, 'waiting', 'w1'), 'claimed');
  assert.equal(client.claimTurn(waiting, 'waiting', 'w1'), 'duplicate');
  assert.ok(client.isTurnActive(waiting, 'waiting'));
  assert.equal(client.isTurnActive(waiting, 'cancel'), false);
  assert.equal(client.agyStatus().queuedWakes, 0);
  client._activeTurns.get(waiting).startedAt -= 80_000;
  assert.ok(client.isTurnCompleted(waiting));
  assert.equal(client.activeTurnCount(), 0);
  const stopped = await prompt('stop');
  assert.equal((await client.stopSessionWork('stop')).removed, 1);
  assert.ok(client.isTurnCompleted(stopped));
  const restarted = new AgyApiClient('agy://local', file);
  assert.equal(restarted.agyStatus().workerTurns.w1, 1);
  const fresh = (await restarted.sessions.prompt({ sessionId: 'cancel', content: [] })).result.value.turn;
  assert.notEqual(fresh, cancelled);
});

test('同名监听接管，优先级分配和轮满换新', async (t) => {
  const client = new AgyApiClient('agy://local', path.join(tempDir(t), 'turns.json'));
  const old = client.waitNextWake({ workerId: 'w1' });
  const high = client.waitNextWake({ workerId: 'w1', priority: 10 });
  assert.ok((await old).superseded);
  let cancel;
  const low = client.waitNextWake({ workerId: 'w2', priority: 2, onAbortRegistrar: (fn) => { cancel = fn; } });
  await client.sessions.prompt({ sessionId: 'a', content: [{ type: 'text', text: '第一条' }] });
  const { wake } = await high;
  assert.equal(wake.text, '第一条');
  client.completeTurn({ turn: wake.turn });
  assert.ok((await client.waitNextWake({ workerId: 'w1', maxTurns: 1 })).rotate);
  cancel();
  assert.ok((await low).aborted);
  assert.equal(client.waitingListenerCount(), 0);
});

test('NapCat 新安装从 WebUI 读配置，旧安装仍可使用已保存的账号', (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'webui.json'), '\uFEFF' + JSON.stringify({ host: '0.0.0.0', port: 6102, token: 'demo' }));
  assert.deepEqual(napcatLoginConfig(root, { account: 123, webuiConfigPath: 'webui.json' }), {
    uin: '123', webuiToken: 'demo', webuiUrl: 'http://127.0.0.1:6102',
  });
  const legacy = { uin: '456', webuiToken: 'old', webuiUrl: 'http://localhost:6099' };
  const file = path.join(root, 'state/napcat-auth.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.deepEqual(napcatLoginConfig(root), legacy);
  fs.writeFileSync(file, JSON.stringify({ ...legacy, webuiUrl: 'https://example.com' }));
  assert.throws(() => napcatLoginConfig(root), /回环/);
});
