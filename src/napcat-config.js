import fs from 'node:fs';
import path from 'node:path';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function napcatLoginConfig(root, napcat = {}) {
  const legacyFile = path.join(root, 'state', 'napcat-auth.json');
  const legacy = fs.existsSync(legacyFile) ? readJson(legacyFile) : {};
  const webui = napcat.webuiConfigPath ? readJson(path.resolve(root, napcat.webuiConfigPath)) : {};
  const uin = String(napcat.account || legacy.uin || '').trim();
  const webuiToken = String(webui.token || legacy.webuiToken || '').trim();
  if (!/^[1-9]\d*$/.test(uin)) throw new Error('请在 config.json 填写 napcat.account');
  if (!webuiToken) throw new Error('请配置 napcat.webuiConfigPath，并检查 WebUI token');
  const url = new URL(webui.port ? 'http://127.0.0.1:' + webui.port : (legacy.webuiUrl || 'http://127.0.0.1:6099'));
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('NapCat WebUI 需要本机回环地址');
  }
  return { uin, webuiToken, webuiUrl: url.origin };
}
