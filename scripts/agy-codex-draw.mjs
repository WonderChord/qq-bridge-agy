// Antigravity 子代理与桥接通用多后端生图/改图封装：
// 1. 可选主力通道：NovelAI V5 (state/nai-api.json + assets/nai-presets.json)，支持原生精准角色参考、
//    多画师串预设池、Gemini API / OpenAI Router / NovelAI GLM-4.6 自动扩写 Danbooru 分镜标签及 429 自动退避重试；
// 2. 改图/通用通道：OpenAI Image API (state/closeai-api.json) 或本机已登录 Codex CLI 会员通道。
//
// 用法示例：
//   1) 预检环境（0 消耗）：
//      node scripts/agy-codex-draw.mjs --dry-run --self-ref
//   2) 画机器人角色自身（自动挂载角色参考图与外观锚点）：
//      node scripts/agy-codex-draw.mjs --self-ref --preset pop_cel --prompt "坐在窗边喝奶茶的半身插画"
//   3) 带外部参考图改图：
//      node scripts/agy-codex-draw.mjs --provider codex --prompt "..." --ref "path/to/ref1.png"

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRouterConfig, extractRouterResponseText } from '../src/message-router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRAWN_DIR = path.join(ROOT, 'state', 'drawn');
const JOBS_DIR = path.join(DRAWN_DIR, 'jobs');
const API_CFG_FILE = path.join(ROOT, 'state', 'closeai-api.json');
const NAI_CFG_FILE = path.join(ROOT, 'state', 'nai-api.json');
const NAI_PRESETS_FILE = path.join(ROOT, 'assets', 'nai-presets.json');
const GEMINI_CFG_FILE = path.join(ROOT, 'state', 'gemini-api.json');

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

export function loadNaiConfig() {
  try {
    if (!fs.existsSync(NAI_CFG_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(NAI_CFG_FILE, 'utf8'));
    if (!raw || raw.enabled === false || !raw.apiKey) return null;
    const presetsPath = path.resolve(ROOT, String(raw.presetsFile || 'assets/nai-presets.json'));
    const presetsData = fs.existsSync(presetsPath)
      ? JSON.parse(fs.readFileSync(presetsPath, 'utf8'))
      : (fs.existsSync(NAI_PRESETS_FILE) ? JSON.parse(fs.readFileSync(NAI_PRESETS_FILE, 'utf8')) : null);
    if (!presetsData || !presetsData.presets) return null;
    return {
      baseUrl: String(raw.baseUrl || 'https://image.novelai.net').trim().replace(/\/+$/, ''),
      apiKey: String(raw.apiKey).trim(),
      model: String(raw.model || 'nai-diffusion-5-full').trim(),
      bank: presetsData,
    };
  } catch {
    return null;
  }
}

function extractFirstZipEntry(zipBuf) {
  let eocdOffset = -1;
  const minPos = Math.max(0, zipBuf.length - 65558);
  for (let i = zipBuf.length - 22; i >= minPos; i -= 1) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset >= 0) {
    const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
    if (cdOffset + 46 <= zipBuf.length && zipBuf.readUInt32LE(cdOffset) === 0x02014b50) {
      const method = zipBuf.readUInt16LE(cdOffset + 10);
      const compSize = zipBuf.readUInt32LE(cdOffset + 20);
      const localOffset = zipBuf.readUInt32LE(cdOffset + 42);
      const fnLen = zipBuf.readUInt16LE(localOffset + 26);
      const exLen = zipBuf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + fnLen + exLen;
      const slice = zipBuf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(slice);
      if (method === 8) return zlib.inflateRawSync(slice);
      throw new Error(`Unsupported ZIP compression method: ${method}`);
    }
  }
  if (zipBuf.length > 30 && zipBuf.readUInt32LE(0) === 0x04034b50) {
    const method = zipBuf.readUInt16LE(8);
    const compSize = zipBuf.readUInt16LE(18);
    const fnLen = zipBuf.readUInt16LE(26);
    const exLen = zipBuf.readUInt16LE(28);
    const dataStart = 30 + fnLen + exLen;
    const slice = compSize > 0 ? zipBuf.subarray(dataStart, dataStart + compSize) : zipBuf.subarray(dataStart);
    return method === 0 ? Buffer.from(slice) : zlib.inflateRawSync(slice);
  }
  throw new Error('NovelAI response is not a valid ZIP archive');
}

function readPngDims(pngBuf) {
  if (pngBuf.length >= 24 && pngBuf.readUInt32BE(0) === 0x89504e47) {
    return { width: pngBuf.readUInt32BE(16), height: pngBuf.readUInt32BE(20) };
  }
  return { width: 832, height: 1216 };
}

export function detectNsfwIntent(text, explicitFlag) {
  if (typeof explicitFlag === 'boolean') return explicitFlag;
  return /\b(nsfw|rating:explicit|topless|nude|naked|nipples|breasts\s+out|pussy|sex|fellatio|oral|paizuri|handjob|vaginal|straddling|skirt\s+lift|panties|undressing|ass\s+focus|lingerie|see-through)\b|涩图|色图|瑟图|涩涩|色色|R18|r18|半脱|全裸|赤裸|露胸|内裤|跨坐|骑乘|口交|深喉|乳交|足交|事后|脱衣|撩裙|掀起裙/i.test(String(text || ''));
}

const DIRECT_SCENE_TAGS = [
  [/自拍|举手机|对镜自拍|mirror\s*selfie/i, 'selfie, smartphone, looking at viewer'],
  [/俯视|从上往下|仰头看|抬眸仰视/i, 'from above, looking up, looking at viewer'],
  [/仰视|从下往上|居高临下|垂眸俯视/i, 'from below, looking down, looking at viewer'],
  [/背后|回眸|回头看|背影/i, 'from behind, looking back, over shoulder'],
  [/特写|近景|贴脸|凑近/i, 'close-up, upper body, depth of field'],
  [/全身|站姿/i, 'full body'],
  [/坐姿|坐在床沿|坐在沙发/i, 'sitting'],
  [/跪坐|W坐|鸭子坐/i, 'wariza, kneeling'],
  [/趴在床上|俯卧|趴着晃脚/i, 'on stomach, lying, legs up'],
  [/躺在床上|仰躺|躺卧|枕头/i, 'lying, on back, on bed, pillow, messy sheets'],
  [/跨坐|骑在.*腿上|坐在.*怀里/i, 'straddling, sitting on lap, pov'],
  [/卧室|床单|私房|房间/i, 'indoors, bedroom, bed, soft warm lighting'],
  [/沙发|客厅/i, 'indoors, couch, warm indoor lighting'],
  [/月光|月夜|夜晚|深夜|窗边夜色/i, 'night, moonlight, window, atmospheric lighting'],
  [/黄昏|夕阳|暮色|逆光|金辉/i, 'sunset, golden hour, backlighting, warm lighting'],
  [/海边|大海|海风|沙滩/i, 'ocean, beach, sea breeze, sunlight'],
  [/星空|星夜/i, 'starry sky, night sky, glowing particles'],
  [/阳台|天台|栏杆/i, 'balcony, railing, breeze'],
  [/摸头|揉脑袋|蹭手心/i, 'headpat, pov hands, faceless male, leaning into hand, happy blush'],
  [/捏脸|扯脸颊/i, 'cheek pinching, pov hands, faceless male, pouting, blush'],
  [/牵手|十指相扣/i, 'holding hands, interlocked fingers, pov hands, faceless male'],
  [/拥抱|抱在怀里|扑进怀里/i, 'hug, pov, faceless male, out-of-frame male'],
  [/害羞|脸红|耳根通红|羞赧/i, 'blush, embarrassed, shy, averted eyes'],
  [/微醺|迷离|水雾|动情|喘息/i, 'heavy blush, half-closed eyes, parted lips, heavy breathing, loving gaze'],
  [/得意|坏笑|挑眉|嚣张|叉腰/i, 'smug, grin, playful teasing expression, hands on hips'],
  [/委屈|眼眶微红|嘟嘴|鼓脸/i, 'pouting, puffed cheeks, teary eyes, cute'],
  [/睡裙|吊带裙|黑纱|居家睡衣/i, 'negligee, sheer fabric, thin straps'],
  [/撩起裙摆|掀裙|裙摆微掀/i, 'skirt lift, thighs'],
  [/半脱|衣衫半解|滑落肩头|宽大衬衫/i, 'off shoulder, clothes partially removed, collarbone'],
  [/全裸|一丝不挂|脱光/i, 'nude, completely nude, bare shoulders, nipples'],
  [/露胸|解开上衣|敞开领口/i, 'topless, breasts out, nipples'],
  [/事后|余韵|凌乱床单/i, 'afterglow, messy hair, messy sheets, heavy breathing'],
];

function enrichChineseScene(rawPrompt, { isNsfw, isChibi }) {
  const src = String(rawPrompt || '').trim();
  if (!src || !/[\u4e00-\u9fff]/.test(src)) return src;
  const matched = [];
  for (const [re, tags] of DIRECT_SCENE_TAGS) {
    if (re.test(src)) matched.push(tags);
  }
  const hasPartner = /双人|互动|摸头|捏脸|牵手|抱|怀里|腿上|跨坐|亲吻|喂|服侍/i.test(src);
  if (hasPartner && !matched.some((t) => /\bpov\b/.test(t))) {
    matched.push('pov, pov hands, faceless male, out-of-frame male');
  }
  if (isChibi && matched.length === 0) {
    matched.push('expressive face, cute pose, dynamic gesture');
  }
  if (isNsfw && matched.length === 0) {
    matched.push('loving gaze, heavy blush, half-closed eyes, parted lips, indoors, bedroom, soft diffused lighting');
  }
  if (matched.length > 0) {
    const engParts = src.match(/[a-zA-Z0-9_:()-]+(?:\s+[a-zA-Z0-9_:()-]+)*/g)
      ?.filter((w) => !/^(R18|r18|NSFW|nsfw)$/i.test(w.trim())) || [];
    return [...engParts, ...matched].join(', ');
  }
  return src;
}

function isSelfAllowedPreset(presetObj) {
  if (!presetObj || typeof presetObj !== 'object') return false;
  if (presetObj.for_self === false) return false;
  return true;
}

function chooseNaiPreset(bank, { explicitPreset, prompt, selfRef, asSticker }) {
  const presets = bank.presets || {};
  const keys = Object.keys(presets);
  const defSelf = bank.default_preset || keys.find((k) => isSelfAllowedPreset(presets[k])) || keys[0] || '';
  const defSticker = bank.default_preset_sticker || keys.find((k) => presets[k]?.is_chibi) || defSelf;
  const defGeneral = bank.default_preset_general || keys.find((k) => presets[k]?.for_self === false) || defSelf;

  if (explicitPreset && presets[explicitPreset]) {
    if (selfRef && !isSelfAllowedPreset(presets[explicitPreset])) return defSelf;
    return explicitPreset;
  }
  const s = String(prompt || '');
  if (asSticker || /\bchibi\b|表情包|大头贴|二头身|Q版|贴纸/i.test(s)) {
    return defSticker;
  }
  if (!selfRef) return defGeneral;
  return defSelf;
}

function parseInlineDirective(rawPrompt) {
  let text = String(rawPrompt || '').trim();
  let provider = '';
  let preset = '';
  let nsfw = null;
  const m = /^\[(NAI|CODEX)(?::([a-zA-Z0-9_-]+))?(?::(nsfw|sfw))?\]\s*/i.exec(text);
  if (m) {
    provider = m[1].toLowerCase();
    if (m[2]) preset = m[2];
    if (m[3]) nsfw = m[3].toLowerCase() === 'nsfw';
    text = text.slice(m[0].length).trim();
  }
  return { text, provider, preset, nsfw };
}

function parseSceneJson(rawText, { selfRef, bank }) {
  const txt = String(rawText || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const m = /\{[\s\S]*\}/.exec(txt);
  if (!m) return null;
  let parsed = null;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  let tags = String(parsed?.tags || '').trim();
  if (!tags || /[\u4e00-\u9fff]/.test(tags)) return null;
  tags = tags.replace(/,\s*,+/g, ', ').replace(/^,\s*|\s*,$/g, '');
  if (!tags) return null;
  const chosen = String(parsed?.preset || '').trim();
  const validPreset = (chosen && bank?.presets?.[chosen] && (!selfRef || isSelfAllowedPreset(bank.presets[chosen])))
    ? chosen
    : '';
  return {
    tags,
    preset: validPreset,
    privateRef: Boolean(parsed?.privateRef),
    expander: '',
  };
}

function loadGeminiDirectorCfg() {
  try {
    const envKey = String(process.env.GEMINI_API_KEY || '').trim();
    if (envKey) {
      return {
        apiKey: envKey,
        baseUrl: String(process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
        models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
      };
    }
    if (fs.existsSync(GEMINI_CFG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(GEMINI_CFG_FILE, 'utf8'));
      if (raw && raw.enabled !== false && raw.apiKey) {
        return {
          apiKey: String(raw.apiKey).trim(),
          baseUrl: String(raw.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
          models: Array.isArray(raw.models) && raw.models.length ? raw.models : ['gemini-2.5-pro', 'gemini-2.5-flash'],
        };
      }
    }
  } catch {}
  return null;
}

async function callGeminiDirector(sysPrompt, userMsg, { selfRef, bank }) {
  const gCfg = loadGeminiDirectorCfg();
  if (!gCfg?.apiKey) return null;
  const safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  ];
  for (const model of gCfg.models) {
    try {
      const res = await fetch(`${gCfg.baseUrl}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': gCfg.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sysPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userMsg }] }],
          safetySettings,
          generationConfig: {
            temperature: 0.6,
            maxOutputTokens: 450,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(16000),
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      const txt = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('') || '';
      const out = parseSceneJson(txt, { selfRef, bank });
      if (out?.tags) {
        out.expander = `gemini-api:${model}`;
        return out;
      }
    } catch {}
  }
  return null;
}

async function callNaiGlmDirector(naiCfg, sysPrompt, userMsg, { selfRef, bank }) {
  if (!naiCfg?.apiKey) return null;
  const res = await fetch('https://text.novelai.net/oa/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${naiCfg.apiKey}`,
    },
    body: JSON.stringify({
      model: 'glm-4-6',
      stream: true,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.5,
      max_tokens: 300,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const raw = await res.text();
  let joined = '';
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') break;
    try {
      const chunk = JSON.parse(payload);
      joined += chunk?.choices?.[0]?.delta?.content || chunk?.choices?.[0]?.text || '';
    } catch {}
  }
  const out = parseSceneJson(joined || raw, { selfRef, bank });
  if (out) out.expander = 'novelai-glm-4-6';
  return out;
}

async function callRouterDirector(sysPrompt, userMsg, { selfRef, bank }) {
  const routerCfg = resolveRouterConfig({ rootDir: ROOT, cfg: BRIDGE_CFG });
  if (!routerCfg?.apiKey) return null;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${routerCfg.apiKey}`,
  };
  const baseUrl = routerCfg.baseUrl;
  let res = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: routerCfg.model || 'gpt-5-nano',
      instructions: sysPrompt,
      input: userMsg,
      reasoning: { effort: 'none' },
      max_output_tokens: 260,
      store: false,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if ([404, 405, 501].includes(res.status)) {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: routerCfg.model || 'gpt-5-nano',
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 260,
      }),
      signal: AbortSignal.timeout(12000),
    });
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const out = parseSceneJson(extractRouterResponseText(data), { selfRef, bank });
  if (out) out.expander = routerCfg.model || 'openai-router';
  return out;
}

async function expandSceneViaLlm(rawPrompt, { naiCfg, isNsfw, isChibi, selfRef, bank }) {
  const src = String(rawPrompt || '').trim();
  if (!src || !/[\u4e00-\u9fff]/.test(src)) return null;
  const dynamicEntries = Object.entries(bank?.presets || {})
    .filter(([, v]) => (selfRef ? isSelfAllowedPreset(v) : v?.for_self === false));
  const presetList = dynamicEntries.length > 0
    ? dynamicEntries.map(([k, v]) => `${k} (${v?.label || k})`).join(', ')
    : Object.keys(bank?.presets || {}).join(', ');
  const sysPrompt = [
    'You are an anime illustration Danbooru tag director for NovelAI V5.',
    'Convert the Chinese scene brief into accurate English Danbooru composition, camera angle, pose, hand gesture, facial expression, attire state, and lighting tags (45-90 words).',
    'Rules:',
    '- Character appearance & artist tags are ALREADY injected separately; NEVER output franchise copyright character tags.',
    '- Choose the best-matching preset purely based on lighting, mood, and texture.',
    '- Whenever interacting with the viewer / partner whose appearance is unspecified, use first-person POV ("1girl, 1boy, hetero, pov, pov hands, faceless male, out-of-frame male") showing ONLY partial limbs at frame edge (hands or forearms as needed), and NEVER draw a male head, face, hair, chest, or full body.',
    '- Convey warm, genuine affection in expressions ("loving gaze, affectionate expression, gazing lovingly at viewer, happy blush, soft gentle eyes") unless pouting/teasing is explicitly requested.',
    isNsfw
      ? '- Intimate mode is enabled: prioritize soft-focus atmospheric lighting ("soft diffused lighting, atmospheric haze, depth of field") and affectionate expressions.'
      : '- Keep tags faithful to the requested mood.',
    `Output ONLY raw JSON without markdown: {"preset":"one preset key from [${presetList}]","privateRef":false,"tags":"comma-separated English Danbooru tags"}`,
  ].join('\n');
  const userMsg = `selfRef=${Boolean(selfRef)}, asSticker=${Boolean(isChibi)}, nsfw=${Boolean(isNsfw)}\nScene brief: ${src}`;

  const chain = [
    () => callGeminiDirector(sysPrompt, userMsg, { selfRef, bank }),
    () => callRouterDirector(sysPrompt, userMsg, { selfRef, bank }),
    () => callNaiGlmDirector(naiCfg, sysPrompt, userMsg, { selfRef, bank }),
  ];
  for (const fn of chain) {
    try {
      const got = await fn();
      if (got?.tags) return got;
    } catch {}
  }
  return null;
}

async function callDirectNovelAiV5({ naiCfg, prompt, selfRef, asSticker, explicitPreset, explicitNsfw, privateRef, outPath }) {
  const { bank } = naiCfg;
  const isNsfw = detectNsfwIntent(prompt, explicitNsfw);
  let isChibi = Boolean(asSticker || bank.presets?.[explicitPreset]?.is_chibi);
  const llmExpanded = await expandSceneViaLlm(prompt, { naiCfg, isNsfw, isChibi, selfRef, bank });
  const preferredPreset = explicitPreset || llmExpanded?.preset || '';
  const presetKey = chooseNaiPreset(bank, {
    explicitPreset: preferredPreset,
    prompt: `${prompt} ${llmExpanded?.tags || ''}`,
    selfRef,
    asSticker,
  });
  const preset = bank.presets[presetKey] || Object.values(bank.presets)[0] || {};
  isChibi = Boolean(asSticker || preset.is_chibi);
  const targetModel = String(preset.model || naiCfg.model || 'nai-diffusion-5-full').trim();
  const isV5Model = /diffusion-5/i.test(targetModel);

  const width = isChibi ? 1024 : 832;
  const height = isChibi ? 1024 : 1216;
  const seed = crypto.randomInt(100_000_000, 999_999_999);

  let scenePrompt = llmExpanded?.tags || enrichChineseScene(prompt, { isNsfw, isChibi });
  const hasPartner = /\b(1boy|hetero|heterosexual|fellatio|oral|irrumatio|paizuri|handjob|sex|vaginal|cowgirl|missionary|doggystyle|penetration|insertion|penis|pov\s+hands|faceless\s+male|sitting\s+on\s+lap|straddling)\b/i.test(scenePrompt);
  if (hasPartner) {
    scenePrompt = scenePrompt
      .replace(/\bsolo\s*,?\s*/gi, '')
      .replace(/\b(?:hands\s+on\s+)?male\s+(?:chest|torso|upper\s+body)\s*,?\s*/gi, '')
      .replace(/\bfull\s+body\s+male\s*,?\s*/gi, '');
    if (!/\b1boy\b/i.test(scenePrompt)) {
      scenePrompt = `1girl, 1boy, hetero, pov, faceless male, out-of-frame male, ${scenePrompt.replace(/^1girl\s*,\s*/i, '')}`;
    } else if (!/\bhetero\b/i.test(scenePrompt)) {
      scenePrompt = `hetero, pov, faceless male, out-of-frame male, ${scenePrompt}`;
    }
  } else if (!/1girl|1boy|solo|chibi|girl/i.test(scenePrompt)) {
    scenePrompt = `1girl, solo, ${isChibi ? 'chibi, sticker style, simple background' : 'cowboy shot, both hands visible, looking at viewer'}, ${scenePrompt}`;
  }
  if (isNsfw && !/\bnsfw\b/i.test(scenePrompt)) {
    scenePrompt = `nsfw, rating:explicit, ${scenePrompt}`;
  }
  const artistStr = preset.artist_string ? `${preset.artist_string}, ` : '';
  const basePrompt = `${artistStr}${scenePrompt}, best quality, amazing quality, very aesthetic, masterpiece, absurdres, no text`;
  const partnerFaceBlock = '1.4::male face, 1boy face, boy face, male head, male hair, male eyes, full body male, male chest, male upper body::, ';
  let rawNegBase = String((isNsfw ? bank.global_neg_nsfw : bank.global_neg_sfw) || 'lowres, bad anatomy, bad hands, worst quality, watermark, text');
  if (preset.allow_sweat) {
    rawNegBase = rawNegBase.replace(/\b(?:shiny\s+skin|glossy\s+skin|oily\s+skin|wet\s+skin|sweat)\s*,?\s*/gi, '');
  }
  const negPrompt = partnerFaceBlock + rawNegBase;

  const parameters = {
    params_version: isV5Model ? 4 : 3,
    width,
    height,
    scale: typeof preset.scale === 'number' ? preset.scale : 5.0,
    sampler: preset.sampler || 'k_euler_ancestral',
    steps: 28,
    n_samples: 1,
    ucPreset: 0,
    qualityToggle: true,
    autoSmea: false,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    controlnet_strength: 1.0,
    legacy: false,
    legacy_v3_extend: false,
    legacy_uc: false,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
    add_original_image: true,
    cfg_rescale: typeof preset.cfg_rescale === 'number' ? preset.cfg_rescale : 0.16,
    noise_schedule: 'karras',
    seed,
    use_coords: false,
    normalize_reference_strength_multiple: false,
    negative_prompt: negPrompt,
  };

  let refUsedPath = null;
  if (selfRef) {
    const usePriv = Boolean(privateRef) && !isChibi;
    const relRef = usePriv ? (bank.private_ref || bank.default_ref || '') : (bank.default_ref || '');
    const absRef = relRef ? path.resolve(ROOT, relRef) : '';
    if (absRef && fs.existsSync(absRef)) {
      refUsedPath = absRef;
      const refB64 = fs.readFileSync(absRef).toString('base64');
      const baseCharSfw = bank.char_sfw || '1girl';
      const baseCharPriv = bank.char_priv_sfw || baseCharSfw;
      const baseCharNsfw = bank.char_nsfw || baseCharSfw;
      let charP = isNsfw
        ? `${baseCharNsfw}, nsfw, heavy blush, ${hasPartner ? 'loving gaze, affectionate blissful expression' : 'alluring expression'}`
        : (usePriv ? baseCharPriv : baseCharSfw);
      if (isChibi) charP = `chibi, super deformed, ${baseCharSfw}`;
      let charN = String((isNsfw ? bank.char_neg_nsfw : bank.char_neg_sfw) || '');
      if (preset.allow_sweat) {
        charN = charN.replace(/\b(?:shiny\s+skin|glossy\s+skin|oily\s+skin|sweat)\s*,?\s*/gi, '');
      }
      const refStrength = isChibi
        ? (preset.ref_strength || 0.55)
        : (isNsfw
          ? (isV5Model ? (preset.nsfw_ref_strength || 0.70) : (preset.nsfw_ref_strength || 0.84))
          : (preset.ref_strength || 0.76));
      const refSecStrength = isV5Model
        ? 0.0
        : (typeof preset.ref_secondary_strength === 'number' ? preset.ref_secondary_strength : 0.35);

      const charCaptions = [{ char_caption: charP, centers: [{ x: 0.5, y: 0.5 }] }];
      const negCaptions = [{ char_caption: charN, centers: [{ x: 0.5, y: 0.5 }] }];
      const charPromptsArr = [{ prompt: charP, uc: charN, center: { x: 0.5, y: 0.5 }, enabled: true }];

      if (hasPartner) {
        const maleParts = ['1boy, faceless male, pov, out-of-frame male'];
        if (/\b(hand|hands|headpat|grabbing|holding|touching|caressing|stroking|hips|waist|thighs)\b/i.test(scenePrompt)) {
          maleParts.push('pov hands, male hand, masculine hand, unpainted nails');
        }
        if (/\b(penis|fellatio|oral|sucking|paizuri|handjob|sex|vaginal|cowgirl|missionary|doggystyle|penetration|insertion)\b/i.test(scenePrompt)) {
          maleParts.push('human penis, penis');
        }
        const maleP = maleParts.join(', ');
        const maleN = 'male face, face, head, hair, eyes, nail polish, feminine hand, full body male, male chest, male torso, disembodied limb, floating hands';
        charCaptions.push({ char_caption: maleP, centers: [{ x: 0.5, y: 0.5 }] });
        negCaptions.push({ char_caption: maleN, centers: [{ x: 0.5, y: 0.5 }] });
        charPromptsArr.push({ prompt: maleP, uc: maleN, center: { x: 0.5, y: 0.5 }, enabled: true });
      }

      parameters.v4_prompt = {
        caption: { base_caption: basePrompt, char_captions: charCaptions },
        use_coords: false,
        use_order: true,
      };
      parameters.v4_negative_prompt = {
        caption: { base_caption: negPrompt, char_captions: negCaptions },
        legacy_uc: false,
      };
      parameters.characterPrompts = charPromptsArr;
      parameters.director_reference_images = [refB64];
      parameters.director_reference_descriptions = [{ caption: { base_caption: 'character', char_captions: [] }, legacy_uc: false }];
      parameters.director_reference_information_extracted = [1.0];
      parameters.director_reference_strength_values = [Number(refStrength.toFixed(2))];
      parameters.director_reference_secondary_strength_values = [Number(refSecStrength.toFixed(2))];
    }
  }

  if (!parameters.v4_prompt) {
    parameters.v4_prompt = { caption: { base_caption: basePrompt, char_captions: [] }, use_coords: false, use_order: true };
    parameters.v4_negative_prompt = { caption: { base_caption: negPrompt, char_captions: [] }, legacy_uc: false };
    parameters.characterPrompts = [];
  }

  let res = null;
  let lastErrTxt = '';
  for (let attempt = 0; attempt < 12; attempt += 1) {
    res = await fetch(`${naiCfg.baseUrl}/ai/generate-image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${naiCfg.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        input: basePrompt,
        model: targetModel,
        action: 'generate',
        parameters,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (res.status !== 429) break;
    lastErrTxt = await res.text().catch(() => '');
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (!res || !res.ok) {
    const errTxt = res ? (lastErrTxt || await res.text().catch(() => '')) : 'no response';
    throw new Error(`NovelAI V5 HTTP ${res?.status || 0}: ${errTxt.slice(0, 300)}`);
  }

  const zipBuf = Buffer.from(await res.arrayBuffer());
  const pngBuf = extractFirstZipEntry(zipBuf);
  fs.writeFileSync(outPath, pngBuf);
  const dims = readPngDims(pngBuf);

  return {
    ok: true,
    provider: isV5Model ? 'novelai-v5' : 'novelai-v4.5',
    model: targetModel,
    preset: presetKey,
    nsfw: isNsfw,
    outputFile: outPath,
    width: dims.width,
    height: dims.height,
    bytes: pngBuf.length,
    seed,
    promptUsed: basePrompt,
    refsUsed: refUsedPath ? [refUsedPath] : [],
  };
}

function chooseAdaptiveQuality(prompt, rawOpts = {}) {
  const explicit = String(rawOpts.quality || '').trim().toLowerCase();
  if (explicit === 'low' || explicit === 'medium' || explicit === 'high') return explicit;
  const text = String(prompt || '');
  if (rawOpts.asSticker || /表情包|大头贴|Q版|二头身|三头身|草图|涂鸦|简笔/i.test(text)) {
    return 'medium';
  }
  if (/高清|精绘|精细|立绘|壁纸|海报|全身|特写|写真|自拍|光影|细节丰富/i.test(text) || text.length >= 90) {
    return 'high';
  }
  return 'medium';
}

async function callOpenAiImageApi({ apiCfg, prompt, refPaths, outPath, quality, size = '1024x1024' }) {
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
  if (/^\{.*\}$/s.test(out)) {
    out = out
      .replace(/^\{+\s*"?prompt"?\s*:\s*/i, '')
      .replace(/,?\s*"?selfRef"?\s*:\s*(?:true|false)\s*\}+$/i, '')
      .replace(/^"+|"+$/g, '')
      .trim();
  }
  if (/裸足|脚丫|脚趾|足尖|足部.*特写|脚部.*特写/.test(out)) {
    out = out
      .replace(/裸足脚丫与粉嫩脚趾|裸足脚丫|粉嫩脚趾|脚趾微微蜷缩|蜷缩脚趾/g, '自然放松的修长小腿与双足线条')
      .replace(/足部构图特写|足部特写|脚部特写|精细特写/g, '自然全身坐姿日常插画构图');
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
    asSticker: false,
    preset: '',
    nsfw: null,
    privateRef: false,
    provider: '',
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
    else if (a === '--sticker') opts.asSticker = true;
    else if (a === '--preset' && i + 1 < argv.length) opts.preset = String(argv[++i]).trim();
    else if (a === '--nsfw') opts.nsfw = true;
    else if (a === '--private-ref') opts.privateRef = true;
    else if (a === '--provider' && i + 1 < argv.length) opts.provider = String(argv[++i]).trim().toLowerCase();
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
  fs.mkdirSync(DRAWN_DIR, { recursive: true });
  fs.mkdirSync(JOBS_DIR, { recursive: true });

  const stamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  let finalOut = rawOpts.out ? path.resolve(rawOpts.out) : path.join(DRAWN_DIR, `codex_${stamp}.png`);
  if (path.extname(finalOut).toLowerCase() !== '.png') {
    finalOut = `${finalOut.replace(/\.[^.\\/]+$/, '')}.png`;
  }
  fs.mkdirSync(path.dirname(finalOut), { recursive: true });

  const externalRefs = [];
  for (const r of (rawOpts.refs || [])) {
    if (!r) continue;
    const abs = path.resolve(r);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) externalRefs.push(abs);
  }

  const naiCfg = loadNaiConfig();
  if (rawOpts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      naiEnabled: Boolean(naiCfg),
      naiPresets: naiCfg ? Object.keys(naiCfg.bank.presets || {}) : [],
      externalRefs,
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

  const inline = parseInlineDirective(basePrompt);
  const effectiveProvider = String(rawOpts.provider || inline.provider || '').toLowerCase();
  const effectivePreset = rawOpts.preset || inline.preset || '';
  const effectiveNsfw = typeof rawOpts.nsfw === 'boolean' ? rawOpts.nsfw : inline.nsfw;
  const promptBody = inline.text || basePrompt;

  // 1. 若已配置 NovelAI V5 则优先走 NAI V5（外部图片局部改图任务除外，除非显式指定 provider=nai）
  const shouldUseNai = Boolean(naiCfg)
    && effectiveProvider !== 'codex'
    && (effectiveProvider === 'nai' || externalRefs.length === 0);

  if (shouldUseNai) {
    try {
      return await callDirectNovelAiV5({
        naiCfg,
        prompt: promptBody,
        selfRef: Boolean(rawOpts.selfRef),
        asSticker: Boolean(rawOpts.asSticker),
        explicitPreset: effectivePreset,
        explicitNsfw: effectiveNsfw,
        privateRef: Boolean(rawOpts.privateRef),
        outPath: finalOut,
      });
    } catch (naiErr) {
      if (detectNsfwIntent(promptBody, effectiveNsfw)) {
        throw naiErr;
      }
      console.error(`[agy-codex-draw] NovelAI V5 通道异常 (${naiErr?.message || naiErr})，自动回退至 OpenAI/Codex...`);
    }
  }

  // 2. 外部实拍改图或未配置 NAI 时：走 OpenAI Image API -> Codex CLI
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
  for (const r of externalRefs) pushRef(r);
  if (rawOpts.selfRef) {
    for (const sr of getSelfRefs()) pushRef(sr);
  }

  const cleanedPrompt = rawOpts.selfRef ? normalizeSelfPrompt(promptBody) : promptBody;
  const fullPrompt = rawOpts.selfRef
    ? `${getAppearanceAnchor()}\n\n本次画面任务：\n${cleanedPrompt}\n`
    : cleanedPrompt;

  const apiCfg = loadCloseAiConfig();
  if (apiCfg && !rawOpts.forceCli) {
    try {
      const quality = chooseAdaptiveQuality(cleanedPrompt, rawOpts);
      return await callOpenAiImageApi({
        apiCfg,
        prompt: fullPrompt,
        refPaths: finalRefs,
        outPath: finalOut,
        quality,
        size: rawOpts.size || '1024x1024',
      });
    } catch (apiErr) {
      console.error(`[agy-codex-draw] OpenAI Image API 通道异常 (${apiErr?.message || apiErr})，自动回退至 Codex CLI...`);
    }
  }

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
  if (!fs.existsSync(authPath)) {
    throw new Error('未检测到 ~/.codex/auth.json ChatGPT 会员登录态');
  }

  pruneOldJobDirs();
  const jobId = `job_${stamp}`;
  const jobDir = path.join(JOBS_DIR, jobId);
  const promptInputPath = path.join(JOBS_DIR, `${jobId}_input.txt`);
  const tempTargetPng = path.join(DRAWN_DIR, `.tmp_${jobId}.png`);
  fs.writeFileSync(promptInputPath, fullPrompt, 'utf8');

  const psArgs = [
    '-NoLogo', '-NoProfile', '-File', ps1Path,
    '-PromptFile', promptInputPath,
    '-OutputFile', tempTargetPng,
    '-CodexPath', codexExe,
    '-JobDirectory', jobDir,
    '-Model', String(rawOpts.model || 'gpt-6.1-sol'),
    '-TimeoutSeconds', String(Math.max(45, Number(rawOpts.timeoutSec) || 240)),
  ];
  if (finalRefs.length > 0) {
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

  try { if (fs.existsSync(finalOut)) fs.unlinkSync(finalOut); } catch {}
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
