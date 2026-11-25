import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGroupMemoryIndex } from '../src/group-memory-index.js';
import { once } from 'node:events';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { synthesizeSpeech } from '../src/tts.js';

// 真实控制台路由，网关、合成商和推理后端全部使用夹具。
async function fixture(t, config = {}, globals = {}, files = {}) {
  const h = await bridgeHarness({ config, globals, files });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await once(server, 'listening');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  });
  h.port = server.address().port;
  h.responses = [];
  server.on('request', (req, res) => res.on('finish', () => h.responses.push([req.url, res.statusCode])));
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

const owner = 'private:123';
const groupA = 'group:456';
const groupB = 'group:789';
const agy = {
  dsh: { baseUrl: 'agy://local' }, allow: { private: ['123'], groups: ['456', '789'] },
  persona: { memoryCompartments: {
    [owner]: { dir: 'memory/owner', summaryFile: 'owner.md' },
    [groupA]: { dir: 'memory/groups/天文社', threshold: 5 },
    [groupB]: { dir: 'memory/groups/摄影社', includePrivate: false },
  } },
};
const ownerFile = 'memory/owner/owner.md';
const groupDir = 'memory/groups/天文社';
const memoryFiles = {
  [ownerFile]: '私聊专属约定',
  [groupDir + '/summary.md']: '# 常驻\n- **青柠彗星** 看月食',
  'memory/groups/摄影社/summary.md': '- 摄影社独有暗房',
};

function say(h, key, sender, text, id) {
  h.appendSocialV2Message(key, sender, text, text, false, key === owner, id, [], key === owner ? '123' : '234');
}

async function waitWake(h, workerId, query = '') {
  const res = await h.request('/api/agy/wait-wake?timeoutMs=1000&workerId=' + workerId + query);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.wake, JSON.stringify(res.data));
  return res.data.wake;
}

async function wake(h, key, workerId = 'w1') {
  const accepted = await h.deliverPrompt(key, '', { silent: true, wakeReason: 'nameMention' });
  assert.ok(accepted.ok && !accepted.skipped, JSON.stringify(accepted));
  return waitWake(h, workerId);
}

async function finish(h, turn) {
  const res = await h.request('/api/agy/finish-turn', { body: { turn } });
  assert.equal(res.data.completed[0]?.turn, turn);
}

test('群 A 挂本群及 owner，群 B 可关闭私聊挂载，归档仅投递本群的文件与发言', async (t) => {
  const h = await fixture(t, agy, {}, memoryFiles);
  say(h, groupA, '观测员', '群 A 第一条', 100);
  const first = await wake(h, groupA);
  assert.match(first.text, /青柠彗星/);
  assert.match(first.text, /单向挂载[\s\S]*私聊专属约定/);
  assert.doesNotMatch(first.text, /摄影社独有暗房/);
  await finish(h, first.turn);
  say(h, groupB, '摄影师', '群 B 第一条', 200);
  const second = await wake(h, groupB);
  assert.match(second.text, /摄影社独有暗房/);
  assert.doesNotMatch(second.text, /青柠彗星|私聊专属约定/);
  await finish(h, second.turn);
  const privatePath = path.join(h.temp, ownerFile);
  fs.writeFileSync(privatePath, '私聊更新约定');
  const tomorrow = new Date(Date.now() + 86400000);
  fs.utimesSync(privatePath, tomorrow, tomorrow);
  for (let i = 1; i <= 5; i++) say(h, groupA, '观测员', '补记 ' + i, 100 + i);
  const changed = await wake(h, groupA);
  assert.match(changed.text, /私聊更新约定/);
  const { data: { job } } = await h.request('/api/agy/archive-wait?timeoutMs=1000');
  assert.equal(job.key, groupA);
  assert.equal(path.resolve(job.summaryPath), path.resolve(h.temp, groupDir, 'summary.md'));
  assert.equal(path.resolve(job.diaryDir), path.resolve(h.temp, groupDir, 'diary'));
  assert.deepEqual(job.messages.map((m) => m.text), [1, 2, 3, 4, 5].map((i) => '补记 ' + i));
  fs.appendFileSync(job.summaryPath, '\n- 本群归档结果');
  assert.equal(fs.readFileSync(privatePath, 'utf8'), '私聊更新约定');
  assert.equal(fs.readFileSync(path.join(h.temp, 'memory/groups/摄影社/summary.md'), 'utf8'), '- 摄影社独有暗房');
});

test('私聊只在当前话题命中时注入，识别新实体与尾缀，按日期排序并标出每条来源', async (t) => {
  const h = await fixture(t, agy, {}, {
    ...memoryFiles,
    [groupDir + '/people/观测员.md']: '# `银河柚子`\n银河柚子负责校表',
    [groupDir + '/diary/2026-01-01.md']: '- 青柠彗星校准镜片（旧记录）',
    [groupDir + '/diary/2026-11-01.md']: '- 青柠彗星校准镜片（新记录）',
    'memory/groups/摄影社/summary.md': '- **青柠彗星**客串合影',
  });
  say(h, groupA, '蓝色极光', '星图画好了', 700);
  say(h, owner, 'Creator', '彗星呢，柚子呢，极光呢', 701);
  const first = await wake(h, owner);
  assert.match(first.text, /私聊专属约定/);
  assert.match(first.text, /私聊按需巡回的群聊记忆与近期动态/);
  assert.match(first.text, /天文社 group:456\/人物\/观测员.*银河柚子负责校表/);
  assert.match(first.text, /摄影社 group:789\/常驻.*客串合影/);
  assert.match(first.text, /天文社 group:456\/群近期.*蓝色极光: 星图画好了/);
  assert.ok(first.text.indexOf('新记录') >= 0 && first.text.indexOf('新记录') < first.text.indexOf('旧记录'));
  await h.request('/api/socialV2/mark-read', { token: first.agentToken, body: { key: owner, throughSeq: 1, turn: first.turn } });
  await finish(h, first.turn);
  for (const [i, word] of ['抱抱', '晚安'].entries()) {
    say(h, owner, 'Creator', word, 702 + i);
    const plain = await wake(h, owner);
    assert.doesNotMatch(plain.text, /私聊按需巡回|星图画好了|客串合影/);
    await finish(h, plain.turn);
  }
});

test('未变的记忆索引直接返回，外部修改、增加、删除 Markdown 后自动按 mtime 刷新', async (t) => {
  const h = await fixture(t, agy, {}, memoryFiles);
  const index = createGroupMemoryIndex();
  t.after(() => index.close());
  const dir = path.join(h.temp, groupDir);
  const comp = { summaryPath: path.join(dir, 'summary.md'), diaryDir: path.join(dir, 'diary') };
  const load = () => index.load(groupA, comp);
  const initial = load();
  for (const method of ['readFileSync', 'readdirSync', 'statSync', 'existsSync', 'watch']) {
    t.mock.method(fs, method, () => assert.fail('缓存命中时访问了 ' + method));
  }
  try { assert.equal(load(), initial); } finally { t.mock.restoreAll(); }
  const people = path.join(dir, 'people');
  fs.mkdirSync(people);
  const person = path.join(people, '今日成员.md');
  fs.writeFileSync(person, '**风铃尾巴** 刚刚入群');
  const summary = initial.files.get(comp.summaryPath);
  await eventually(() => load().entities.has('风铃尾巴'));
  assert.equal(load().files.get(comp.summaryPath), summary, '增添群友不会重读未变摘要');
  const replacement = path.join(dir, 'new-summary.tmp');
  fs.writeFileSync(replacement, '- **变化星云** 已更新');
  fs.renameSync(replacement, comp.summaryPath);
  fs.unlinkSync(person);
  await eventually(() => load().entities.has('变化星云') && !load().entities.has('风铃尾巴'));
});

async function eventually(check) {
  const end = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < end, '未在限时内观测到状态改变');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('seq 与字符串 messageId 分别命中 recentMessages 和 unread，不请求 get_msg', async (t) => {
  const h = await fixture(t, agy);
  h.bot.getMessage = t.mock.fn(() => { throw new Error('网关离线'); });
  const st = { recentMessages: [{ seq: 1, messageId: 'p-81', sender: '甲', text: '历史' }],
    unread: [{ seq: 2, messageId: 'p-82', sender: '乙', text: '未读' }] };
  for (const [ref, id, sender] of [['1', 'p-81', '甲'], ['p-81', 'p-81', '甲'], ['2', 'p-82', '乙'], ['p-82', 'p-82', '乙']]) {
    const resolved = await h.resolveReplyTargetV2(st, 'group', 456, ref);
    assert.equal(resolved.messageId, id);
    assert.equal(resolved.info.sender, sender);
  }
  assert.equal(h.bot.getMessage.mock.callCount(), 0);
  assert.equal(await h.resolveReplyTargetV2(st, 'group', 456, '9999'), null);
  assert.equal(h.bot.getMessage.mock.callCount(), 1);
});

// 在临时配置目录运行发布的脚本，让 stdout、退出码及重新长轮询也进入测试。
async function runWorker(h, args, stdin) {
  const folder = path.join(h.temp, 'scripts');
  fs.mkdirSync(folder, { recursive: true });
  for (const name of ['bridge-local.mjs', 'agy-reply-and-wait.mjs']) {
    fs.copyFileSync(new URL('./' + name, import.meta.url), path.join(folder, name));
  }
  fs.copyFileSync(new URL('../src/tts.js', import.meta.url), path.join(h.temp, 'src', 'tts.js'));
  const config = path.join(h.temp, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config)), consolePort: h.port }));
  const result = promisify(execFile)(process.execPath, [path.join(folder, 'agy-reply-and-wait.mjs'), '--worker-id', 'w1', ...args],
    { timeout: 10000, windowsHide: true, env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1', NODE_USE_ENV_PROXY: '0' } });
  result.child.stdin.end(stdin);
  return result;
}

test('真实 Worker 的单条与 batch 引用 400 都会降级，只发一次纯文本', async (t) => {
  const h = await fixture(t, agy);
  for (const [i, args] of [['--reply', '9999', '第一条正文'], ['--batch', JSON.stringify([{ reply: 'bad-id', text: '第二条正文' }])]].entries()) {
    say(h, groupA, '观测员', '触发 ' + i, 960 + i);
    const w = await wake(h, groupA);
    h.responses.length = 0;
    await runWorker(h, ['--key', groupA, '--token', w.agentToken, '--seq', String(i + 1), '--finish-turn', w.turn, '--no-wait', ...args]);
    assert.deepEqual(h.responses.filter(([url]) => url === '/api/socialV2/send-message').map(([, status]) => status), [400, 200]);
    const sent = h.calls.http.filter((call) => call.url.endsWith('/send_group_msg'));
    assert.equal(sent.length, i + 1);
    assert.deepEqual(sent.at(-1).body.message, [{ type: 'text', data: { text: ['第一条正文', '第二条正文'][i] } }]);
  }
});

test('Worker 批量标准输入保留中文和 JSON 引号，格式错误时保留原回合', async (t) => {
  const h = await fixture(t, agy);
  say(h, groupA, '观测员', '触发', 970);
  const w = await wake(h, groupA);
  const args = ['--key', groupA, '--token', w.agentToken, '--seq', '1', '--finish-turn', w.turn, '--no-wait', '--batch-stdin'];
  const sends = () => h.calls.http.filter(call => call.url.endsWith('/send_group_msg'));
  await assert.rejects(runWorker(h, args, '[{reply:970,messages:[测试]}]'), { code: 1 });
  assert.equal(h.api.activeTurnCount(), 1);
  assert.equal(sends().length, 0);

  const reply = '中文测试：他说 "好"，然后换行\n继续。';
  await runWorker(h, args, JSON.stringify([{ reply: '970', messages: [reply] }]));
  assert.equal(sends().length, 1);
  assert.ok(sends()[0].body.message.some(part => part.type === 'text' && part.data.text === reply));
  assert.equal(h.api.activeTurnCount(), 0);
});

test('同一 Worker 重挂取回原切片，拒绝旧 ID，保留其它 Worker 的切片及已发言回合', async (t) => {
  const h = await fixture(t, { ...agy, socialV2: { context: { wakeMessageLimit: 1 } } }, {}, memoryFiles);
  say(h, groupA, '甲', '原始切片', 801);
  const old = await wake(h, groupA);
  const claim = (w) => h.request('/api/agy/claim', { body: { key: groupA, token: w.agentToken, turn: w.turn, workerId: w.workerId } });
  assert.equal((await claim(old)).status, 200); // 领取成功还不等于发言。
  say(h, groupA, '乙', '第二个切片', 802);
  const other = await wake(h, groupA, 'w2');
  const replacement = await waitWake(h, 'w1', '&resetTurns=1&finishWorker=1');
  assert.notEqual(replacement.turn, old.turn);
  assert.match(replacement.text, /原始切片/);
  assert.doesNotMatch(replacement.text, /第二个切片/);
  assert.equal((await claim(old)).status, 409);
  assert.equal((await claim(other)).status, 200);
  assert.equal((await claim(replacement)).status, 200);
  assert.equal(h.api.activeTurnCount(), 2);
  const send = (w, id, messages) => h.request('/api/socialV2/send-message', { token: w.agentToken,
    body: { key: groupA, turn: w.turn, replyToMessageId: id, messages } });
  assert.ok((await send(other, '801', '不该抢答')).data.skippedDuplicate, '新 turn 必须仍然独占原消息');
  assert.equal((await send(replacement, '801', '本回合回复')).data.sent, 1);
  const status = (await h.request('/api/agy/status')).data;
  const health = status.workers.find((w) => w.workerId === 'w1');
  assert.ok(Date.parse(health.connectedAt) && Date.parse(health.lastWakeAt));
  assert.match(status.loadedSignatures.find((s) => s.workerId === 'w1' && s.key === groupA).memory, /^[\d.]+(?::[\d.]+){1,2}$/);
  assert.doesNotMatch(JSON.stringify(status), /原始切片|私聊专属约定/);
  const afterSpeech = await h.request('/api/agy/wait?workerId=w1&timeoutMs=1000');
  assert.ok(afterSpeech.data.timedOut, '已发言的回合不能重投');
  assert.ok(h.api.isTurnActive(replacement.turn));
  assert.ok(h.api.isTurnActive(other.turn));
  const retriedOther = await waitWake(h, 'w2');
  assert.notEqual(retriedOther.turn, other.turn, '被拒绝的跨切片发送不能算作已发言');
  assert.match(retriedOther.text, /第二个切片/);
  await finish(h, retriedOther.turn);
  await finish(h, replacement.turn);
});

test('陈旧 claim 回到监听，既不发送旧消息也不确认下一轮的未读', async (t) => {
  const h = await fixture(t, agy);
  say(h, groupA, '甲', '下一条', 880);
  await h.deliverPrompt(groupA, '', { silent: true, wakeReason: 'nameMention' });
  const token = h.getSocialV2State(groupA).agentToken;
  const cli = await runWorker(h, ['--key', groupA, '--token', token, '--finish-turn', 'stale', '--seq', '1', '过期正文']);
  assert.match(cli.stdout, /QQ 唤醒/);
  assert.deepEqual(h.responses.map(([url]) => url.split('?')[0]), ['/api/agy/claim', '/api/agy/wait', '/api/socialV2/recent']);
  assert.equal(h.calls.http.filter((call) => call.url.endsWith('/send_group_msg')).length, 0);
  assert.equal(h.getSocialV2State(groupA).unread.length, 1);
});

test('已明确确认本切片的无回复回合重连时只关闭，不重投', async (t) => {
  const h = await fixture(t, agy);
  say(h, groupA, '群友', '收到', 990);
  const w = await wake(h, groupA);
  const marked = await h.request('/api/socialV2/mark-read', { token: w.agentToken, body: { key: groupA, throughSeq: 1, turn: w.turn } });
  assert.equal(marked.status, 200);
  const next = await h.request('/api/agy/wait-wake?workerId=w1&timeoutMs=1000');
  assert.ok(next.data.timedOut);
  assert.equal(h.api.activeTurnCount(), 0);
  assert.ok(h.api.isTurnCompleted(w.turn));
});

test('兼容旧服务的 claim 404，跳过发送并重新进入 wait', async (t) => {
  const h = await fixture(t, agy);
  const requests = [];
  const legacy = http.createServer((req, res) => {
    const route = req.url.split('?')[0];
    requests.push(route);
    res.writeHead(route.endsWith('/claim') ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(route.endsWith('/claim') ? { error: '回合已结算' } : { ok: true, superseded: true }));
  });
  legacy.listen(0, '127.0.0.1');
  await once(legacy, 'listening');
  t.after(() => new Promise((resolve) => legacy.close(resolve)));
  await runWorker({ ...h, port: legacy.address().port }, ['--key', groupA, '--token', 'fixture-token', '--finish-turn', 'obsolete', '陈旧文本']);
  assert.deepEqual(requests, ['/api/agy/claim', '/api/agy/wait']);
});

test('同名本地表情替换时库存数量不变也重载，旧 MD5 不能由云端回流', async (t) => {
  const h = await fixture(t, agy, {}, { ...memoryFiles, 'stickers/test.png': 'old-image' });
  const md5 = (s) => createHash('md5').update(s).digest('hex').toUpperCase();
  const old = md5('old-image');
  const fresh = md5('new-image');
  let cloud = [];
  h.bot.request = async () => ({ status: 'ok', retcode: 0, data: cloud });
  await h.syncStickerLibrary(true);
  say(h, groupA, '群友', '第一条', 77);
  const before = await wake(h, groupA);
  assert.ok(before.text.includes('[id:' + old.slice(0, 8) + ']'));
  const signature = async () => (await h.request('/api/agy/status')).data.loadedSignatures.find((s) => s.key === groupA).stickers;
  const oldSig = await signature();
  assert.match(oldSig, /^[a-f\d]{16}$/);
  await finish(h, before.turn);
  fs.writeFileSync(path.join(h.temp, 'stickers/test.png'), 'new-image');
  cloud = [{ emoji_id: old, md5: old }];
  const updated = await h.syncStickerLibrary(true);
  assert.deepEqual(Array.from(updated.entries, (e) => e.md5), [fresh]);
  const after = await wake(h, groupA);
  assert.notEqual(await signature(), oldSig);
  assert.ok(after.text.includes('[id:' + fresh.slice(0, 8) + ']'));
  cloud = ['https://fixture.invalid/' + old];
  assert.deepEqual(Array.from((await h.syncStickerLibrary(true)).entries, (e) => e.md5), [fresh]);
});

test('前置路由：OWNER_QQ_IDS 私聊零外部请求直通，群聊 gpt-6-luna 无推理分流与超时 @自身 降级兜底', async (t) => {
  const routerCalls = [];
  let routerBehavior = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: 'gpt-6-luna',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"should_reply":false,"reason":"仅提及热梗"}' }] }],
    }),
  });

  const envContent = [
    'OPENAI_API_KEY=sk-test-router-key',
    'OPENAI_BASE_URL=https://router.example.invalid/v1',
    'ROUTER_MODEL=gpt-6-luna',
    'OWNER_QQ_IDS=123,8888',
    'ROUTER_TIMEOUT_MS=80',
  ].join('\n');

  const h = await fixture(
    t,
    {
      ...agy,
      napcat: { account: '10000' },
      persona: {
        ...agy.persona,
        nameKeywords: ['小鲸鱼', '鲸鱼'],
        ambiguousKeywords: ['大肥鱼'],
      },
      socialV2: { wake: { batchWindowMs: 250, maxWakePerMinute: 60, maxWakePerHour: 600 } },
    },
    {
      fetch: async (url, init = {}) => {
        const u = String(url);
        if (u.startsWith('https://router.example.invalid/')) {
          const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
          routerCalls.push({ url: u, body: parsedBody });
          return routerBehavior(u, parsedBody, init);
        }
        return jsonResponse({ ok: true });
      },
    },
    {
      '.env': envContent,
      'memory/owner/summary.md': '私聊专属约定',
      'memory/groups/a/summary.md': '**青柠彗星** 群常驻摘要',
      'roles/test-role.md': '绝密角色扮演人设正文不得外发',
    }
  );
  h.setSelfIdentity('小鲸鱼', '10000');
  const waitRouterWake = async (workerId = 'w1') => {
    const res = await h.request(`/api/agy/wait-wake?timeoutMs=3500&workerId=${workerId}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.wake, JSON.stringify(res.data));
    return res.data.wake;
  };

  // 1) 私聊 OWNER_QQ_IDS 白名单（含仅在 .env 配置的 8888）：零外部请求直通
  await h.handleIncoming('private', '8888', {
    message_type: 'private',
    self_id: 10000,
    user_id: 8888,
    message_id: 5001,
    message: [{ type: 'text', data: { text: '在吗鲸鱼' } }],
  }, h.cfg);
  const privWake = await waitRouterWake('w1');
  assert.equal(privWake.key, 'private:8888');
  assert.equal(routerCalls.length, 0, '白名单私聊绝不能向外部路由 API 发起任何请求');
  await finish(h, privWake.turn);

  // 2) 非白名单私聊：直接拦截，零外部请求且不唤醒
  await h.handleIncoming('private', '9999', {
    message_type: 'private',
    self_id: 10000,
    user_id: 9999,
    message_id: 5002,
    message: [{ type: 'text', data: { text: '陌生人私聊' } }],
  }, h.cfg);
  assert.equal(routerCalls.length, 0);
  assert.equal(h.api.agyStatus().queuedWakes, 0);

  // 3) 群聊命中模糊词但 should_reply=false：校验无推理参数、无隐私注入，并静默拦截
  await h.handleIncoming('group', '456', {
    message_type: 'group',
    group_id: 456,
    self_id: 10000,
    user_id: 234,
    message_id: 6001,
    sender: { nickname: '群友甲', card: '群友甲' },
    message: [{ type: 'text', data: { text: '今天这条大肥鱼真鲜啊' } }],
  }, h.cfg);
  await eventually(() => routerCalls.length === 1);
  assert.equal(routerCalls[0].url, 'https://router.example.invalid/v1/responses');
  assert.equal(routerCalls[0].body.model, 'gpt-6-luna');
  assert.deepEqual(routerCalls[0].body.reasoning, { effort: 'none' });
  assert.ok(routerCalls[0].body.max_output_tokens <= 64);
  const fullSentPayload = JSON.stringify(routerCalls[0].body);
  assert.doesNotMatch(fullSentPayload, /绝密角色扮演人设|私聊专属约定|青柠彗星/, '外部路由请求严禁包含人设或任何记忆文件内容');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.api.agyStatus().queuedWakes, 0, 'should_reply=false 必须在 qq-bridge 层静默忽略');

  // 4) 群聊 should_reply=true（同时验证 /responses 404 时兼容回退 /chat/completions reasoning_effort=none）
  routerBehavior = (u, body) => {
    if (u.endsWith('/responses')) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    assert.equal(body.reasoning_effort, 'none');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'gpt-6-luna',
        choices: [{ message: { content: '{"should_reply":true,"reason":"群友直接向助手提问"}' } }],
      }),
    };
  };
  await h.handleIncoming('group', '456', {
    message_type: 'group',
    group_id: 456,
    self_id: 10000,
    user_id: 234,
    message_id: 6002,
    sender: { nickname: '群友乙', card: '群友乙' },
    message: [{ type: 'text', data: { text: '小鲸鱼帮我算一下时间' } }],
  }, h.cfg);
  const groupWake = await waitRouterWake('w1');
  assert.equal(groupWake.key, 'group:456');
  await finish(h, groupWake.turn);

  // 5) 外部路由超时报错兜底：非 @自身QQ号 静默忽略，明确包含 @自身QQ号 降级放行
  routerBehavior = (_u, _body, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const callsBeforeTimeout = routerCalls.length;
  await h.handleIncoming('group', '456', {
    message_type: 'group',
    group_id: 456,
    self_id: 10000,
    user_id: 234,
    message_id: 6003,
    sender: { nickname: '群友丙', card: '群友丙' },
    message: [{ type: 'text', data: { text: '小鲸鱼在不在' } }],
  }, h.cfg);
  await eventually(() => routerCalls.length > callsBeforeTimeout);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.api.agyStatus().queuedWakes, 0, '路由超时且无明确 @自身QQ号 时应静默忽略');

  await h.handleIncoming('group', '456', {
    message_type: 'group',
    group_id: 456,
    self_id: 10000,
    user_id: 234,
    message_id: 6004,
    sender: { nickname: '群友丁', card: '群友丁' },
    message: [
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: ' 出来冒个泡' } },
    ],
  }, h.cfg);
  const fallbackWake = await waitRouterWake('w1');
  assert.equal(fallbackWake.key, 'group:456', '路由异常时明确包含 @自身QQ号 必须降级放行');
  await finish(h, fallbackWake.turn);
});

test('出站客服拒答套话硬拦截（HTTP 422）、requeue 回退队首与 PowerShell 去引号 batch 解析', async (t) => {
  const { parseUnquotedBatchItems } = await import('./agy-reply-and-wait.mjs');
  const recovered = parseUnquotedBatchItems('[{reply:101,messages:[第一条消息,第二条消息]},{reply:102,sticker:abcd1234}]');
  assert.deepEqual(recovered, [
    { reply: '101', messages: ['第一条消息', '第二条消息'] },
    { reply: '102', sticker: 'abcd1234' },
  ]);

  const h = await fixture(t, agy);
  say(h, owner, 'Creator', '讲个故事', 901);
  const w1 = await wake(h, owner);
  const tok = h.getSocialV2State(owner).agentToken;

  const blocked = await h.request('/api/socialV2/send-message', {
    token: tok,
    body: { key: owner, turn: w1.turn, messages: '抱歉，作为一个人工智能助手，我无法继续回应。' },
  });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.data.refusalBlocked, true);
  assert.equal(h.calls.http.filter((c) => c.url.endsWith('/send_private_msg')).length, 0);

  const reqRes = await h.request('/api/agy/requeue', {
    body: { turn: w1.turn, workerId: 'w1' },
  });
  assert.equal(reqRes.status, 200);
  assert.equal(reqRes.data.requeued, 1);

  const w2 = await h.request('/api/agy/wait-wake?timeoutMs=2000&workerId=w2');
  assert.equal(w2.status, 200);
  assert.equal(w2.data.wake.key, owner);
  assert.equal(w2.data.wake.requeuedCount, 1);
  await finish(h, w2.data.wake.turn);
});

test('协同助手多线程：auto 模式下 voice/search/draw 在线接管与离线降级，off/单项关闭时强制走单主线程直连', async (t) => {
  const synthInputs = [];
  const h = await fixture(
    t,
    {
      ...agy,
      ...voiceConfig,
      socialV2: {
        ...voiceConfig.socialV2,
        helpers: { mode: 'auto', voice: true, search: true, draw: true, voiceTimeoutMs: 5000, searchTimeoutMs: 5000, drawTimeoutMs: 5000 },
      },
    },
    {
      synthesizeSpeech: async (segText, _cfg, snap) => {
        synthInputs.push({ segText, ttsRef: snap?.ttsRef || '' });
        return { audio: Buffer.alloc(512), provider: 'fixture' };
      },
      inspectAudio: async () => ({ ok: true, size: 512, duration: 1, codec: 'mp3' }),
    }
  );
  const tok = h.getSocialV2State(owner).agentToken;

  // 1) search 助手未上线时，helper-submit 返回 offline=true（供 agy-ask-search 自动降级本地搜索）
  const offlineSearch = await h.request('/api/agy/helper-submit', {
    body: { role: 'search', requireOnline: true, waitResult: true, payload: { mode: 'sync', query: '测试离线降级' } },
  });
  assert.equal(offlineSearch.data.ok, false);
  assert.equal(offlineSearch.data.offline, true);

  // 2) search 助手挂起监听后，同步委托返回精炼摘要
  const searchWaitPromise = h.request('/api/agy/helper-wait?role=search&workerId=s1&timeoutMs=4000');
  await new Promise((r) => setTimeout(r, 40));
  const submitPromise = h.request('/api/agy/helper-submit', {
    body: { role: 'search', requireOnline: true, waitResult: true, payload: { mode: 'sync', query: '核实新版本特性' } },
  });
  const searchJobRes = await searchWaitPromise;
  assert.equal(searchJobRes.data.ok, true);
  assert.equal(searchJobRes.data.job.payload.query, '核实新版本特性');
  await h.request('/api/agy/helper-done', {
    body: { id: searchJobRes.data.job.id, result: { summary: '浓缩后的两百字查证结论' } },
  });
  const searchOut = await submitPromise;
  assert.equal(searchOut.data.ok, true);
  assert.equal(searchOut.data.completed, true);
  assert.equal(searchOut.data.result.summary, '浓缩后的两百字查证结论');

  // 3) voice 助手在线时，async send-tts 自动交由语音导演精修后再合成发往 QQ
  const voiceWaitPromise = h.request('/api/agy/helper-wait?role=voice&workerId=v1&timeoutMs=4000');
  await new Promise((r) => setTimeout(r, 40));
  const ttsQueued = await h.request('/api/socialV2/send-tts', {
    token: tok,
    body: { key: owner, text: '原始草稿台词', voiceBrief: true, async: true, verify: false },
  });
  assert.equal(ttsQueued.status, 200);
  assert.equal(ttsQueued.data.queued, true);
  const voiceJobRes = await voiceWaitPromise;
  assert.equal(voiceJobRes.data.job.payload.rawText, '原始草稿台词');
  assert.equal(voiceJobRes.data.job.payload.voiceBrief, true);
  await h.request('/api/agy/helper-done', {
    body: { id: voiceJobRes.data.job.id, result: { segments: ['[playful cute voice] 导演精修后的正式台本'], ttsRef: '02_tsukkomi' } },
  });
  await eventually(() => synthInputs.some((x) => x.segText.includes('导演精修后的正式台本') && x.ttsRef === '02_tsukkomi'));

  // 4) 通过配置将 helpers.mode 设为 off（或单项关闭）时，即使曾有监听也立即拒绝派单并标记 enabled=false
  h.cfg.socialV2.helpers.mode = 'off';
  const statusOff = (await h.request('/api/agy/status')).data;
  assert.equal(statusOff.helpersMode, 'off');
  assert.equal(statusOff.helpersEnabled, false);
  assert.equal(statusOff.helpers.search.enabled, false);
  assert.equal(statusOff.helpers.voice.online, false);

  const disabledSubmit = await h.request('/api/agy/helper-submit', {
    body: { role: 'search', requireOnline: true, waitResult: true, payload: { mode: 'sync', query: '已关闭多线程' } },
  });
  assert.equal(disabledSubmit.data.ok, false);
  assert.equal(disabledSubmit.data.disabled, true);
});
