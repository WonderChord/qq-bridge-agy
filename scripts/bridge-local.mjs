import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
}

export function readStudioRelay() {
  const cfgAll = loadConfig(); const dir = String(process.env.STUDIO_RELAY_DIR || cfgAll.studioRelay?.dir || '').trim(); if (!dir) throw new Error('未配置 studioRelay.dir 或 STUDIO_RELAY_DIR');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const port = Number(config.port) || 8788;
  const key = fs.readFileSync(path.resolve(dir, config.localKeyFile || 'cloud-auth/relay.key'), 'utf8').trim();
  return { port, baseUrl: `http://127.0.0.1:${port}`, key };
}

export function readConsoleToken(config = loadConfig()) {
  const configured = String(config.consoleToken ?? '').trim();
  if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

// 老版命令省略 --token 时，从该会话的持久化状态恢复。显式传入的令牌由网桥校验。
export function sessionToken(key, supplied) {
  if (!/^(group|private):[1-9]\d*$/.test(key)) throw new Error('请提供有效的 --key');
  if (supplied && supplied !== '-') return supplied;
  const file = path.join(ROOT, 'state', 'social-v2.json');
  if (fs.existsSync(file)) {
    const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const token = (state.conversations ?? state.sessions ?? state)[key]?.agentToken;
    if (token) return token;
  }
  throw new Error('缺少该会话令牌，请传入本次唤醒的 --token');
}
