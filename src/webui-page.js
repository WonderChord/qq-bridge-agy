import fs from 'node:fs';
import path from 'node:path';

export const consoleLoginPage = '<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>';

export function readConsolePage(root) {
  try {
    return fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');
  } catch {
    return '控制台页面缺失：qq-bridge/public/console.html';
  }
}
