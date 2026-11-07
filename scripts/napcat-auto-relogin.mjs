#!/usr/bin/env node
/**
 * NapCat 免密快速登录辅助脚本（已永久移除明文 PasswordLogin 回退，防止触发腾讯滑块风控顶废票据）
 * 用法：
 *   node scripts/napcat-auto-relogin.mjs          # 检查状态，若离线仅尝试一次 SetQuickLogin；若票据失效则刷新二维码等待扫码
 *   node scripts/napcat-auto-relogin.mjs --force  # 无论当前状态，若未登录则立刻尝试 SetQuickLogin
 */
import fs from 'node:fs';
import path from 'node:path';
import { recoverNapcatLogin } from '../src/napcat-login.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { napcatLoginConfig } from '../src/napcat-config.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function loadAuthConfig() {
  const file = path.join(root, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  return napcatLoginConfig(root, cfg.napcat);
}

export async function checkAndReloginNapCat({ force = false, logger = console.log, statusOnly = false } = {}) {
  const result = await recoverNapcatLogin(root, loadAuthConfig(), { force, statusOnly });
  if (!statusOnly && result.action === 'need_qrcode') logger('[NapCatAutoLogin] 请在本机 WebUI 扫码：' + result.webuiUrl);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const force = process.argv.includes('--force');
  checkAndReloginNapCat({ force, statusOnly: process.argv.includes('--status-only') })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error('[NapCatAutoLogin] Error:', err.message);
      process.exit(1);
    });
}
