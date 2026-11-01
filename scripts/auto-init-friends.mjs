// 后台等待 NapCat 首次扫码登录完成，自动读取当前好友列表（主人的大号+小号），
// 热更新 qq-bridge 白名单、ownerQQ、跨号同人初始提示词、长期记忆档案与 napcat.quick.bat。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// napcat.quick.bat 位置：config.json → napcat.dir
const NAPCAT_QUICK_BAT = (() => {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const dir = JSON.parse(text)?.napcat?.dir;
    return dir ? path.join(dir, 'napcat.quick.bat') : '';
  } catch {
    return '';
  }
})();

function loadConfig() {
  let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function readConsoleToken() {
  const c = loadConfig();
  const configured = String(c.consoleToken ?? '').trim();
  if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function onebotCall(httpUrl, token, action, params = {}) {
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) throw new Error(`retcode=${body.retcode}`);
  return body.data;
}

async function bridgePost(port, consoleToken, apiPath, payload) {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-console-token': consoleToken,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`${apiPath} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  const cfg = loadConfig();
  const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const onebotToken = cfg.snowluma?.accessToken || '';
  const port = Number(cfg.consolePort) || 3100;
  const consoleToken = readConsoleToken();

  let login = null;
  while (!login) {
    try {
      const info = await onebotCall(httpUrl, onebotToken, 'get_login_info');
      if (info?.user_id) {
        login = info;
        break;
      }
    } catch {}
    await sleep(2000);
  }

  const selfId = String(login.user_id);
  const selfNick = String(login.nickname || '机器人');

  // 更新 napcat.quick.bat 实现后续免扫码快速登录
  try {
    if (fs.existsSync(NAPCAT_QUICK_BAT)) {
      const batContent = `@echo off\r\nchcp 65001\r\n.\\NapCatWinBootMain.exe ${selfId}\r\npause\r\n`;
      fs.writeFileSync(NAPCAT_QUICK_BAT, batContent, 'utf8');
    }
  } catch {}

  // 等待 3 秒让 NTQQ 同步完好友列表
  await sleep(3000);
  let rawFriends = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rawFriends = await onebotCall(httpUrl, onebotToken, 'get_friend_list');
      if (Array.isArray(rawFriends) && rawFriends.length > 0) break;
    } catch {}
    await sleep(2000);
  }

  const friends = (Array.isArray(rawFriends) ? rawFriends : [])
    .filter((f) => {
      const uid = Number(f?.user_id);
      return Number.isFinite(uid) && uid >= 100000 && String(uid) !== selfId;
    })
    .map((f) => ({
      qq: String(f.user_id),
      nickname: String(f.nickname || '').trim(),
      remark: String(f.remark || '').trim(),
    }));

  const friendIds = friends.map((f) => Number(f.qq));
  const ownerQQ = friendIds.length > 0 ? friendIds[0] : null;

  if (friendIds.length > 0) {
    await bridgePost(port, consoleToken, '/api/whitelist', {
      allow: { private: friendIds, groups: cfg.allow?.groups ?? [] },
      ownerQQ,
    });

    const accountsDesc = friends
      .map((f) => `QQ ${f.qq}（昵称：${f.nickname || '未命名'}${f.remark ? `，备注：${f.remark}` : ''}）`)
      .join(' 与 ');
    const identityPrompt = `【主人身份记忆（最高优先级）】当前账号列表中的 ${accountsDesc} 都是你的主人本人（她的大号和小号，是同一个人）。无论她用这两个号中的哪一个跟你聊天，都把对方当作同一个人对待，话题、称呼与记忆完全互通。`;

    for (const f of friends) {
      await bridgePost(port, consoleToken, '/api/socialV2/initial-prompt', {
        key: `private:${f.qq}`,
        text: identityPrompt,
      });
    }

    const ownerDoc = `# 主人档案（大号与小号同人绑定）

- **身份说明**：以下两个 QQ 账号均为主人本人（同一人，跨账号记忆与对话连续互通）：
${friends.map((f, i) => `  ${i + 1}. \`${f.qq}\` — 昵称：${f.nickname || '(无)'}${f.remark ? `（备注：${f.remark}）` : ''}`).join('\n')}
- **当前管理端 ownerQQ**：\`${ownerQQ}\`（如需互换主次可随时在控制台或配置中调整）
- **绑定时间**：${new Date().toISOString()}
`;
    fs.mkdirSync(path.join(ROOT, 'memory', 'people'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'memory', 'people', 'owner.md'), ownerDoc, 'utf8');

    const indexPath = path.join(ROOT, 'memory', 'INDEX.md');
    let idxText = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    const summaryBlock = `## 三、常驻群与熟人索引\n- **机器人账号**：\`${selfId}\`（${selfNick}）\n- **主人（双号同人）**：${accountsDesc} → 详见 [people/owner.md](people/owner.md)\n`;
    if (idxText.includes('## 三、常驻群与熟人索引')) {
      idxText = idxText.replace(/## 三、常驻群与熟人索引[\s\S]*$/, summaryBlock);
    } else {
      idxText += `\n${summaryBlock}`;
    }
    fs.writeFileSync(indexPath, idxText, 'utf8');
  }

  console.log(JSON.stringify({
    ok: true,
    bot: { qq: selfId, nickname: selfNick },
    ownerQQ,
    boundFriends: friends,
    note: friends.length === 0
      ? '机器人已登录，但好友列表暂为空（加好友后可再次运行本脚本自动绑定）'
      : `已自动将 ${friends.length} 个好友绑定为同一主人并写入白名单与长期记忆`,
  }, null, 2));
}

main().catch((err) => {
  console.error('[auto-init-friends] 异常:', err);
  process.exit(1);
});
