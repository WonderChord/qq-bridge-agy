import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { synthesizeSpeech } from '../src/tts.js';

// 真实控制台路由，网关、合成商和推理后端全部使用夹具。
async function fixture(t, config = {}, globals = {}) {
  const h = await bridgeHarness({ config, globals });
  t.after(() => h.close());
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  h.request = async (route, { token, body } = {}) => {
    const res = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        ...(token ? { 'x-agent-token': token } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  return h;
}

test('示例配置的人设和 NapCat 字段进入运行时，形象图使用配置的文件', async (t) => {
  const persona = { selfImage: 'portrait.png', nameKeywords: ['丸子'] };
  const napcat = { account: '789', webuiConfigPath: 'example/webui.json' };
  const h = await fixture(t, { persona, napcat });
  assert.equal(h.cfg.napcat?.account, napcat.account);
  assert.equal(h.cfg.persona?.nameKeywords[0], '丸子');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(h.temp, persona.selfImage), png);
  const token = h.getSocialV2State('group:456').agentToken;
  const image = await h.request('/api/socialV2/self-image?key=group:456', { token });
  assert.equal(image.status, 200);
  assert.equal(image.data.image.data, png.toString('base64'));
  fs.writeFileSync(path.join(h.temp, persona.selfImage), 'this is a text file');
  assert.equal((await h.request('/api/socialV2/self-image?key=group:456', { token })).status, 400);
});

const voiceConfig = {
  allow: { groups: ['456', '789'], private: ['123'] },
  socialV2: { tools: { sendVoice: true }, voice: { enabled: true }, tts: { enabled: true, provider: 'google' } },
};
const tts = '/api/socialV2/send-tts';

test('合成前校验目标会话、开关、静默和正文，拒绝的请求不访问合成服务', async (t) => {
  const h = await fixture(t, voiceConfig);
  const key = 'group:456';
  const token = h.getSocialV2State(key).agentToken;
  const other = h.getSocialV2State('group:789').agentToken;
  const send = (changes, sessionToken = token) =>
    h.request(tts, { token: sessionToken, body: { key, text: '试音', ...changes } });
  assert.equal((await send({ key: 'group:789', token: '-' })).status, 403);
  assert.equal((await send({ key: 'group:789', token: other })).status, 403);
  assert.equal((await send({}, null)).status, 403);
  h.cfg.socialV2.tts.enabled = false;
  assert.equal((await send({})).status, 403);
  h.cfg.socialV2.tts.enabled = true;
  h.cfg.socialV2.tools.sendVoice = false;
  assert.equal((await send({})).status, 403);
  h.cfg.socialV2.tools.sendVoice = true;
  assert.equal((await send({ text: 'a'.repeat(501) })).status, 400);
  assert.equal((await send({ text: token })).status, 403);
  fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ mode: 'silent' }));
  assert.equal((await send({})).status, 403);
  assert.equal(h.calls.http.length, 0);
});

test('TTS 和语音库共用并发额度，撤销期间丢弃音频，失败释放额度', async (t) => {
  let release, started;
  const first = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const h = await fixture(t, voiceConfig, {
    async synthesizeSpeech() {
      if (++calls === 1) {
        started();
        await new Promise((resolve) => { release = resolve; });
      }
      return { audio: Buffer.alloc(512), provider: 'fixture' };
    },
    inspectAudio: async () => ({ ok: true, size: 512, duration: 1, codec: 'mp3' }),
  });
  const key = 'group:456';
  const token = h.getSocialV2State(key).agentToken;
  const speak = () => h.request(tts, { token, body: { key, text: '测试', verify: false } });
  h.cfg.socialV2.voice.maxPerMinute = 1;
  const inFlight = speak();
  await first;
  assert.equal((await speak()).status, 429);
  assert.equal(calls, 1);
  h.socialV2.paused = true;
  release();
  assert.equal((await inFlight).status, 403);
  assert.equal(h.calls.http.length, 0);
  h.socialV2.paused = false;
  const sent = await speak();
  assert.equal(sent.status, 200, sent.data.error);
  assert.equal(sent.data.messageId, 9001);
  assert.equal(h.calls.http.at(-1).body.message[0].type, 'record');
  assert.equal(h.voiceLibrary().length, 0, '合成台词不得留在跨会话共享的语音库中');
  assert.equal((await speak()).status, 429);
});

test('ElevenLabs 失败时尝试 Google，备用请求不带密钥，音频大小受限', async () => {
  const calls = [];
  async function request(url, init) {
    calls.push({ url, init });
    if (calls.length === 1) return new Response('unavailable', { status: 503 });
    return new Response(Buffer.alloc(512));
  }
  const config = { provider: 'elevenlabs', fallbackProvider: 'google', elevenlabs: { apiKey: 'fixture', voiceId: 'voice' } };
  const result = await synthesizeSpeech('备用音色', config, {}, 512, request);
  assert.equal(result.audio.length, 512);
  assert.match(result.provider, /google/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers['xi-api-key'], undefined);
  assert.equal(calls[1].url.searchParams.get('q'), '备用音色');
  await assert.rejects(synthesizeSpeech('测试', { provider: 'google' }, { provider: 'elevenlabs' }, 512, request), /未启用/);
  assert.equal(calls.length, 2);
  await assert.rejects(synthesizeSpeech('测试', { provider: 'google' }, {}, 256, request), /体积上限/);
});

test('控制台仅修改语音开关时保留密钥、模型和语音库，回包隐藏密钥', async (t) => {
  const h = await fixture(t, { socialV2: {
    voice: { dir: 'my-library', maxPerHour: 3 },
    tts: { elevenlabs: { apiKey: 'fixture-secret', modelId: 'fixture-model' } },
  } });
  const route = '/api/socialV2/config';
  const before = await h.request(route);
  assert.equal(before.data.config.tts.elevenlabs.apiKey, undefined);
  const saved = await h.request(route, { body: { voice: { enabled: true }, tts: {
    enabled: true, provider: 'elevenlabs', elevenlabs: { voiceId: 'new' },
  } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.config.tts.elevenlabs.apiKey, undefined);
  assert.equal(saved.data.config.voice.dir, 'my-library');
  const disk = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'))).socialV2;
  assert.equal(disk.voice.maxPerHour, 3);
  assert.deepEqual(disk.tts.elevenlabs, { modelId: 'fixture-model', apiKey: 'fixture-secret', voiceId: 'new' });
});

test('群聊生图要求明确引用创作者，最近有创作者发言不能借用其额度', async (t) => {
  const h = await fixture(t, { persona: { creatorUids: [] } });
  const key = 'group:456';
  h.appendSocialV2Message(key, 'Creator', '刚才的闲聊', '闲聊', false, true, 900, [], '123');
  h.appendSocialV2Message(key, '群友', '画一张', '画一张', false, false, 901, [], '789');
  const token = h.getSocialV2State(key).agentToken;
  const draw = (replyToMessageId) => h.request('/api/socialV2/codex-draw', { token, body: { key, prompt: '测试', replyToMessageId } });
  assert.equal((await draw()).status, 403);
  assert.equal((await draw(2)).status, 403);
  assert.equal((await draw(999)).status, 400);
});

test('Worker 分页不提前认领下一页，只有当前回合可以立即确认已展示水位', async (t) => {
  const key = 'group:456';
  const h = await fixture(t, { socialV2: { context: { wakeMessageLimit: 1 } } });
  const sid = await h.ensureSession(key);
  const st = h.getSocialV2State(key);
  const token = st.agentToken;
  h.api.isAgyBackend = true;
  h.api.activeTurnCount = () => 1;
  h.api.isTurnActive = (turn, session) => turn === 'current' && session === sid;
  h.appendSocialV2Message(key, '甲', '第一条', '第一条', false, false, 81, [], '123');
  h.appendSocialV2Message(key, '乙', '第二条', '第二条', false, false, 82, [], '124');
  const page = () => h.buildWakeSnapshotV2(key, { claimSlice: true });
  assert.equal(page().messages[0].seq, 1);
  assert.equal(page().messages[0].seq, 1, '未接受的投递允许重试');
  assert.ok(!page().recent.some((m) => m.seq === 2));
  const unread = await h.request('/api/socialV2/unread?key=group:456&count=1', { token });
  assert.equal(unread.status, 200);
  const ack = (turn) => h.request('/api/socialV2/mark-read', { token, body: { key, turn, throughSeq: 1 } });
  assert.equal((await ack('retired')).status, 409);
  assert.equal((await ack('current')).status, 200);
  assert.deepEqual([...st.unread].map((m) => m.seq), [2]);
});
