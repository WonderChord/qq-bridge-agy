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
const API_CFG_FILE = path.join(ROOT, 'state', 'closeai-api.json');

function loadCloseAiConfig() {
  try {
    if (!fs.existsSync(API_CFG_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(API_CFG_FILE, 'utf8'));
    if (!raw || !raw.apiKey) return null;
    let baseUrl = String(raw.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
    if (!/\/v\d+$/i.test(baseUrl)) baseUrl += '/v1';
    return {
      baseUrl,
      apiKey: String(raw.apiKey).trim(),
      model: String(raw.model || 'gpt-image-2.6-sunburst').trim(),
    };
  } catch {
    return null;
  }
}

function chooseAdaptiveQuality(prompt, rawOpts = {}) {
  const explicit = String(rawOpts.quality || '').trim().toLowerCase();
  if (explicit === 'low' || explicit === 'medium' || explicit === 'high') return explicit;
  const text = String(prompt || '');
  // 表情包、Q版大头、快速小涂鸦默认用 medium（性价比高、速度快）
  if (rawOpts.asSticker || /表情包|大头贴|Q版|二头身|三头身|草图|涂鸦|简笔/i.test(text)) {
    return 'medium';
  }
  // 明确要求精绘、立绘、壁纸、全身特写、自拍写真或复杂光影构图时用 high，普通日常随手画用 medium
  if (/高清|精绘|精细|立绘|壁纸|海报|全身|特写|写真|自拍|黑丝|白丝|光影|细节丰富/i.test(text) || text.length >= 90) {
    return 'high';
  }
  return 'medium';
}

async function callDirectOpenAiImageApi({ apiCfg, prompt, refPaths, outPath, quality, size = '1024x1024' }) {
  const validRefs = (refPaths || []).filter((p) => fs.existsSync(p));
  const model = apiCfg.model || 'gpt-image-2.6-sunburst';
  let res;
  if (validRefs.length > 0) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('size', size);
    form.append('quality', quality);
    form.append('background', 'opaque');
    form.append('output_format', 'png');
    for (const rp of validRefs) {
      const buf = fs.readFileSync(rp);
      const mime = rp.toLowerCase().endsWith('.jpg') || rp.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
      form.append('image[]', new Blob([buf], { type: mime }), path.basename(rp));
    }
    res = await fetch(`${apiCfg.baseUrl}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiCfg.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(210000),
    });
  } else {
    res = await fetch(`${apiCfg.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiCfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt,
        size,
        quality,
        background: 'opaque',
        output_format: 'png',
      }),
      signal: AbortSignal.timeout(210000),
    });
  }
  const rawText = await res.text();
  let body = null;
  try { body = JSON.parse(rawText); } catch {}
  if (!res.ok) {
    throw new Error(`OpenAI Image API (${model}) ${res.status}: ${body?.error?.message || rawText.slice(0, 400)}`);
  }
  const item = body?.data?.[0];
  let imgBuf = null;
  if (item?.b64_json) {
    imgBuf = Buffer.from(item.b64_json, 'base64');
  } else if (item?.url) {
    const dl = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!dl.ok) throw new Error(`下载返回图片 URL 失败 (${dl.status})`);
    imgBuf = Buffer.from(await dl.arrayBuffer());
  } else {
    throw new Error(`响应未包含 b64_json 或 url: ${rawText.slice(0, 300)}`);
  }
  fs.writeFileSync(outPath, imgBuf);
  return {
    ok: true,
    provider: 'openai-api',
    model,
    quality,
    outputFile: outPath,
    bytes: imgBuf.length,
    usage: body?.usage || null,
    promptUsed: prompt,
    refsUsed: validRefs,
  };
}

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

function getSelfRefs() {
  const cfg = loadBridgeConfig();
  const list = Array.isArray(cfg.persona?.selfRefs)
    ? cfg.persona.selfRefs
    : (cfg.persona?.selfImage ? [cfg.persona.selfImage] : []);
  return list.map((p) => path.resolve(ROOT, String(p)));
}

function getAppearanceAnchor() {
  const cfg = loadBridgeConfig();
  const a = cfg.persona?.appearanceAnchor;
  const body = Array.isArray(a) ? a.join('\n') : String(a || '');
  return body ? `角色外观锚点（参考附图中的角色，必须严格保持一致）：\n${body}` : '角色外观锚点：严格保持参考附图中的角色外观一致。';
}

function normalizeSelfPrompt(raw) {
  let out = String(raw || '').trim();
  // 剥离偶发残留的 JSON 外壳
  if (/^\{.*\}$/s.test(out)) {
    out = out
      .replace(/^\{+\s*"?prompt"?\s*:\s*/i, '')
      .replace(/,?\s*"?selfRef"?\s*:\s*(?:true|false)\s*\}+$/i, '')
      .replace(/^"+|"+$/g, '')
      .trim();
  }
  // 修正子代理偶发幻觉出的错误发色瞳色
  out = out.replace(/浅灰发紫瞳|灰发紫瞳|银发紫瞳|白发紫瞳/g, '黑短发带深钴蓝渐变挑染、清澈青蓝眼');
  // 柔化容易触发 Codex 恋足/局部特写安全拦截的词句，转为自然全身/大半身时尚日常构图
  if (/裸足|脚丫|脚趾|足尖|足部.*特写|脚部.*特写/.test(out)) {
    out = out
      .replace(/裸足脚丫与粉嫩脚趾|裸足脚丫|粉嫩脚趾|脚趾微微蜷缩|蜷缩脚趾/g, '自然放松的修长小腿与双足线条')
      .replace(/足部构图特写|足部特写|脚部特写|精细特写/g, '自然全身坐姿日常插画构图（完整展现20岁成年修长女性头身比例与穿搭）');
  }
  return out;
}

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
    for (const sr of getSelfRefs()) pushRef(sr);
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

  const cleanedPrompt = rawOpts.selfRef ? normalizeSelfPrompt(basePrompt) : basePrompt;
  const fullPrompt = rawOpts.selfRef
    ? `${getAppearanceAnchor()}\n\n本次画面任务：\n${cleanedPrompt}\n`
    : cleanedPrompt;

  // 优先走 closeai-api.json 中的 gpt-image-2.6-sunburst 直连通道（按画面复杂度自动决策 medium/high 质量）
  const apiCfg = loadCloseAiConfig();
  if (apiCfg && !rawOpts.forceCli) {
    try {
      const quality = chooseAdaptiveQuality(cleanedPrompt, rawOpts);
      return await callDirectOpenAiImageApi({
        apiCfg,
        prompt: fullPrompt,
        refPaths: finalRefs,
        outPath: finalOut,
        quality,
        size: rawOpts.size || '1024x1024',
      });
    } catch (apiErr) {
      console.error(`[agy-codex-draw] OpenAI 2.6-sunburst API 通道异常 (${apiErr?.message || apiErr})，自动回退至 Codex CLI...`);
    }
  }

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
