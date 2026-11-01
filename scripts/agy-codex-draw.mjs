// Antigravity 子代理与桥接通用 Codex CLI (GPT Image 2.5) 生图/改图一键封装。
// 强制走本机已登录 ChatGPT 会员鉴权（forced_login_method="chatgpt"，剥离 API KEY，零 API 扣费，无弹窗）。
//
// 用法示例：
//   1) 预检环境（0 消耗）：
//      node scripts/agy-codex-draw.mjs --dry-run --self-ref
//   2) 画机器人自己（自动挂载 persona.selfRefs 参考图与 persona.appearanceAnchor 外观锚点）：
//      node scripts/agy-codex-draw.mjs --self-ref --prompt "坐在电脑前喝奶茶的半身插画" --out state/drawn/self_tea.png
//   3) 普通文生图或带参考图改图：
//      node scripts/agy-codex-draw.mjs --prompt "..." --ref "path/to/ref1.png"
//
// 配置（config.json）：
//   codexDraw.invokeScript  Invoke-CodexImage.ps1 路径（也可用环境变量 CODEX_IMAGE_PS1）
//   persona.selfRefs        画自己时挂载的参考图（相对仓库根目录）
//   persona.appearanceAnchor 画自己时前置的外观描述（字符串或字符串数组）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRAWN_DIR = path.join(ROOT, 'state', 'drawn');
const JOBS_DIR = path.join(DRAWN_DIR, 'jobs');

function loadBridgeConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}
const BRIDGE_CFG = loadBridgeConfig();
const DEFAULT_INVOKE_PS1 = path.resolve(ROOT, String(process.env.CODEX_IMAGE_PS1 || BRIDGE_CFG.codexDraw?.invokeScript || path.join('scripts', 'Invoke-CodexImage.ps1')));
const DEFAULT_PWSH = path.join(
  os.homedir(),
  '.cache',
  'codex-runtimes',
  'codex-primary-runtime',
  'dependencies',
  'native',
  'powershell',
  'pwsh.exe'
);

const SELF_REFS = (Array.isArray(BRIDGE_CFG.persona?.selfRefs) ? BRIDGE_CFG.persona.selfRefs : (BRIDGE_CFG.persona?.selfImage ? [BRIDGE_CFG.persona.selfImage] : []))
  .map((p) => path.resolve(ROOT, String(p)));

const APPEARANCE_ANCHOR = (() => {
  const a = BRIDGE_CFG.persona?.appearanceAnchor;
  const body = Array.isArray(a) ? a.join('\n') : String(a || '');
  return body ? `角色外观锚点（参考附图中的角色，必须严格保持一致）：\n${body}` : '角色外观锚点：严格保持参考附图中的角色外观一致。';
})();

function findLatestCodexExe() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (!fs.existsSync(binRoot)) return null;
  const candidates = [];
  for (const ent of fs.readdirSync(binRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const exe = path.join(binRoot, ent.name, 'codex.exe');
    if (fs.existsSync(exe)) {
      const st = fs.statSync(exe);
      candidates.push({ exe, mtimeMs: st.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.exe || null;
}

function findPwshExe() {
  if (fs.existsSync(DEFAULT_PWSH)) return DEFAULT_PWSH;
  const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const stdPwsh = path.join(progFiles, 'PowerShell', '7', 'pwsh.exe');
  if (fs.existsSync(stdPwsh)) return stdPwsh;
  return 'pwsh.exe';
}

function parseArgs(argv) {
  const opts = {
    prompt: '',
    promptFile: '',
    out: '',
    selfRef: false,
    refs: [],
    model: 'gpt-6.1-sol',
    timeoutSec: 240,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--prompt' && i + 1 < argv.length) opts.prompt = String(argv[++i]);
    else if (a === '--prompt-file' && i + 1 < argv.length) opts.promptFile = String(argv[++i]);
    else if (a === '--out' && i + 1 < argv.length) opts.out = String(argv[++i]);
    else if (a === '--self-ref') opts.selfRef = true;
    else if (a === '--ref' && i + 1 < argv.length) opts.refs.push(String(argv[++i]));
    else if (a === '--model' && i + 1 < argv.length) opts.model = String(argv[++i]).trim() || 'gpt-6.1-sol';
    else if (a === '--timeout' && i + 1 < argv.length) opts.timeoutSec = Math.max(45, Math.min(900, Number(argv[++i]) || 240));
    else if (a === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

function pruneOldJobDirs() {
  try {
    if (!fs.existsSync(JOBS_DIR)) return;
    const dirs = fs.readdirSync(JOBS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const full = path.join(JOBS_DIR, d.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of dirs.slice(15)) {
      try { fs.rmSync(old.full, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

export async function runCodexDraw(rawOpts = {}) {
  const codexExe = findLatestCodexExe();
  if (!codexExe) {
    throw new Error('未找到本机 Codex CLI (AppData/Local/OpenAI/Codex/bin/*/codex.exe)');
  }
  const pwshExe = findPwshExe();
  const ps1Path = path.resolve(DEFAULT_INVOKE_PS1);
  if (!fs.existsSync(ps1Path)) {
    throw new Error(`未找到生图封装脚本: ${ps1Path}`);
  }
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const authPath = path.join(codexHome, 'auth.json');
  const authExists = fs.existsSync(authPath);
  if (!authExists) {
    throw new Error('未检测到 ~/.codex/auth.json ChatGPT 会员登录态');
  }

  const finalRefs = [];
  const seenRef = new Set();
  const pushRef = (p) => {
    if (!p || finalRefs.length >= 5) return;
    const abs = path.resolve(p);
    const key = abs.toLowerCase();
    if (seenRef.has(key)) return;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    seenRef.add(key);
    finalRefs.push(abs);
  };

  for (const r of (rawOpts.refs || [])) pushRef(r);
  if (rawOpts.selfRef) {
    for (const sr of SELF_REFS) pushRef(sr);
  }

  fs.mkdirSync(DRAWN_DIR, { recursive: true });
  fs.mkdirSync(JOBS_DIR, { recursive: true });

  const stamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  let finalOut = rawOpts.out ? path.resolve(rawOpts.out) : path.join(DRAWN_DIR, `codex_${stamp}.png`);
  if (path.extname(finalOut).toLowerCase() !== '.png') {
    finalOut = `${finalOut.replace(/\.[^.\\/]+$/, '')}.png`;
  }
  fs.mkdirSync(path.dirname(finalOut), { recursive: true });

  if (rawOpts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      codexExe,
      pwshExe,
      ps1Path,
      authExists,
      refs: finalRefs,
      outPath: finalOut,
    };
  }

  let basePrompt = String(rawOpts.prompt || '').trim();
  if (!basePrompt && rawOpts.promptFile) {
    basePrompt = fs.readFileSync(path.resolve(rawOpts.promptFile), 'utf8').trim();
  }
  if (!basePrompt) {
    throw new Error('缺少生图提示词（请传 --prompt 或 --prompt-file）');
  }

  const fullPrompt = rawOpts.selfRef
    ? `${APPEARANCE_ANCHOR}\n\n本次画面任务：\n${basePrompt}\n`
    : basePrompt;

  pruneOldJobDirs();
  const jobId = `job_${stamp}`;
  const jobDir = path.join(JOBS_DIR, jobId);
  const promptInputPath = path.join(JOBS_DIR, `${jobId}_input.txt`);
  const tempTargetPng = path.join(DRAWN_DIR, `.tmp_${jobId}.png`);
  fs.writeFileSync(promptInputPath, fullPrompt, 'utf8');

  const psArgs = [
    '-NoLogo',
    '-NoProfile',
    '-File',
    ps1Path,
    '-PromptFile',
    promptInputPath,
    '-OutputFile',
    tempTargetPng,
    '-CodexPath',
    codexExe,
    '-JobDirectory',
    jobDir,
    '-Model',
    String(rawOpts.model || 'gpt-6.1-sol'),
    '-TimeoutSeconds',
    String(Math.max(45, Number(rawOpts.timeoutSec) || 240)),
  ];
  if (finalRefs.length > 0) {
    // PowerShell -File 模式下 string[] 参数接收逗号或单参，为避免路径含空格歧义改用 -Command 安全数组调用
    psArgs.length = 0;
    const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const refArrExpr = `@(${finalRefs.map(esc).join(',')})`;
    const cmdExpr = `& ${esc(ps1Path)} -PromptFile ${esc(promptInputPath)} -OutputFile ${esc(tempTargetPng)} -CodexPath ${esc(codexExe)} -JobDirectory ${esc(jobDir)} -Model ${esc(rawOpts.model || 'gpt-6.1-sol')} -TimeoutSeconds ${Math.max(45, Number(rawOpts.timeoutSec) || 240)} -ReferenceImages ${refArrExpr}`;
    psArgs.push('-NoLogo', '-NoProfile', '-Command', cmdExpr);
  }

  const childEnv = { ...process.env };
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.CODEX_API_KEY;
  delete childEnv.CODEX_ACCESS_TOKEN;

  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(pwshExe, psArgs, {
      cwd: DRAWN_DIR,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        code: exitCode ?? 1,
        stdout: Buffer.concat(outChunks).toString('utf8').trim(),
        stderr: Buffer.concat(errChunks).toString('utf8').trim(),
      });
    });
  });

  try { fs.unlinkSync(promptInputPath); } catch {}

  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const jsonMatch = stdout.match(/\{[\s\S]*\}$/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch {}
    }
  }

  if (code !== 0 || !fs.existsSync(tempTargetPng)) {
    try { if (fs.existsSync(tempTargetPng)) fs.unlinkSync(tempTargetPng); } catch {}
    const reason = parsed?.error || stderr || stdout || `exit code ${code}`;
    throw new Error(`Codex 生图失败: ${reason}`);
  }

  try {
    if (fs.existsSync(finalOut)) fs.unlinkSync(finalOut);
  } catch {}
  fs.renameSync(tempTargetPng, finalOut);

  return {
    ok: true,
    outputFile: finalOut,
    width: parsed?.width ?? null,
    height: parsed?.height ?? null,
    bytes: fs.statSync(finalOut).size,
    sha256: parsed?.sha256 ?? null,
    promptUsed: parsed?.prompt_used ?? null,
    refsUsed: finalRefs,
  };
}

const isDirectCli = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isDirectCli) {
  const opts = parseArgs(process.argv.slice(2));
  runCodexDraw(opts)
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
      process.exit(1);
    });
}
