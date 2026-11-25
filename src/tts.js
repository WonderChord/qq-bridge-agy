import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function readRegistryEnv(varName) {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCU\\Environment', '/v', varName], {
      timeout: 2000, windowsHide: true,
    });
    const re = new RegExp(`${varName}\\s+REG_\\w+\\s+([^\\r\\n]+)`, 'i');
    return re.exec(stdout)?.[1].trim() || '';
  } catch {
    return '';
  }
}

async function elevenLabsKey(config) {
  const key = String(config.apiKey || process.env.ELEVENLABS_API_KEY || '').trim();
  if (key) return key;
  return readRegistryEnv('ELEVENLABS_API_KEY');
}

async function fishAudioKey(config) {
  const envName = String(config.apiKeyEnv || 'FISH_API_KEY').trim() || 'FISH_API_KEY';
  const key = String(config.apiKey || process.env[envName] || process.env.FISH_API_KEY || '').trim();
  if (key) return key;
  return readRegistryEnv(envName);
}

// 零依赖 MessagePack 编码器（专供 Fish Audio /v1/tts Zero-Shot 挂载 48kHz 修复参考音频）
export function encodeMsgpack(val) {
  const parts = [];
  function pack(v) {
    if (v === null || v === undefined) {
      parts.push(Buffer.from([0xc0]));
    } else if (typeof v === 'boolean') {
      parts.push(Buffer.from([v ? 0xc3 : 0xc2]));
    } else if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        if (v >= 0 && v <= 0x7f) parts.push(Buffer.from([v]));
        else if (v >= -32 && v < 0) parts.push(Buffer.from([0x100 + v]));
        else if (v >= 0 && v <= 0xff) parts.push(Buffer.from([0xcc, v]));
        else if (v >= 0 && v <= 0xffff) {
          const b = Buffer.alloc(3);
          b[0] = 0xcd;
          b.writeUInt16BE(v, 1);
          parts.push(b);
        } else {
          const b = Buffer.alloc(5);
          b[0] = 0xd2;
          b.writeInt32BE(v, 1);
          parts.push(b);
        }
      } else {
        const b = Buffer.alloc(9);
        b[0] = 0xcb;
        b.writeDoubleBE(v, 1);
        parts.push(b);
      }
    } else if (typeof v === 'string') {
      const s = Buffer.from(v, 'utf8');
      const len = s.length;
      if (len <= 31) parts.push(Buffer.from([0xa0 | len]), s);
      else if (len <= 0xff) parts.push(Buffer.from([0xd9, len]), s);
      else if (len <= 0xffff) {
        const b = Buffer.alloc(3);
        b[0] = 0xda;
        b.writeUInt16BE(len, 1);
        parts.push(b, s);
      } else {
        const b = Buffer.alloc(5);
        b[0] = 0xdb;
        b.writeUInt32BE(len, 1);
        parts.push(b, s);
      }
    } else if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      const buf = Buffer.from(v);
      const len = buf.length;
      if (len <= 0xff) parts.push(Buffer.from([0xc4, len]), buf);
      else if (len <= 0xffff) {
        const b = Buffer.alloc(3);
        b[0] = 0xc5;
        b.writeUInt16BE(len, 1);
        parts.push(b, buf);
      } else {
        const b = Buffer.alloc(5);
        b[0] = 0xc6;
        b.writeUInt32BE(len, 1);
        parts.push(b, buf);
      }
    } else if (Array.isArray(v)) {
      const len = v.length;
      if (len <= 15) parts.push(Buffer.from([0x90 | len]));
      else {
        const b = Buffer.alloc(3);
        b[0] = 0xdc;
        b.writeUInt16BE(len, 1);
        parts.push(b);
      }
      for (const item of v) pack(item);
    } else if (typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      const len = keys.length;
      if (len <= 15) parts.push(Buffer.from([0x80 | len]));
      else {
        const b = Buffer.alloc(3);
        b[0] = 0xde;
        b.writeUInt16BE(len, 1);
        parts.push(b);
      }
      for (const k of keys) {
        pack(k);
        pack(v[k]);
      }
    }
  }
  pack(val);
  return Buffer.concat(parts);
}

const POINT_TAGS_ONLY_RE = /^\s*\[(?:laughs|laughing|small laugh|chuckling|giggle|giggles|sigh|sighs|sighing|shaky breath|breath|gasp|gasps|gasping|panting|yawn|yawning|groan|groaning|clears throat|clear throat|sob|sobbing|short pause|long pause|pause|break|long-break)\]/i;
const SINGLE_POINT_TAG_RE = /^\[(?:laughs|laughing|small laugh|chuckling|giggle|giggles|sigh|sighs|sighing|shaky breath|breath|gasp|gasps|gasping|panting|yawn|yawning|groan|groaning|clears throat|clear throat|sob|sobbing|short pause|long pause|pause|break|long-break)\]$/i;

const TTS_HASH_TAG_PAIRS = [
  [/#s_(?:pant|breath|shaky)#/gi, '[panting] '],
  [/#s_(?:sigh|moan)#/gi, '[sighs] '],
  [/#s_gasp#/gi, '[gasps] '],
  [/#s_(?:laugh|giggle|chuckle)#/gi, '[giggles] '],
  [/#[a-zA-Z0-9_\u4e00-\u9fa5]{1,16}#/g, ''],
];

// 单段语音「张弛有度」四档节奏判定器：
// 保留真实的省略号气口与分句停顿（不靠 silenceremove 吞停顿），仅对超长死寂做保底裁剪并保留 stop_silence 自然呼吸留白：
//   1) slow_afterglow      （慢·事后余韵/哄睡/耳语低喃/瘫软无力：语速 1.00，完整保留绵长吐息与停顿）
//   2) brisk_tease_fluster （快·小恶魔调侃/傲娇斥责/慌张抢白/元气直播：语速 1.04，灵动有弹性且保留句间换气）
//   3) dynamic_climax      （急促起伏·激烈动情/登顶喘息：语速 1.00，完整保留喘息中断与情绪张力）
//   4) modulated_sweet     （温存撒娇·日常情话：语速 1.00，不加速抢话，完整保留省略号与句号处的换气停顿）
export function classifySegmentPacing(text) {
  const s = String(text ?? '');
  const plainLen = Math.max(1, countSpokenChars(s));
  const whisperChars = [...s.matchAll(/<(?:whisper|soft|slow)>([\s\S]*?)<\/(?:whisper|soft|slow)>/gi)]
    .reduce((acc, m) => acc + countSpokenChars(m[1]), 0);
  const whisperRatio = whisperChars / plainLen;
  const isTrueSleepAfterglow = /おやすみ|眠|二度寝|余韻|事後|うとうと|寝ぼけ|力入らない|動かせない|気絶しちゃ|ぽかぽか|抱き枕|ゆっくり休/i.test(s);
  const isHighTension = /ひゃあっ|ひゃあぁ|きゃあっ|あぁっ|はぁあっ|んぁあっ|あんっ|気持ちよすぎ|壊れちゃ|おかしく|頭真っ白|火花|限界|(?:\[panting\][\s\S]*){2,}/i.test(s);

  // 1) 高张力起伏档（优先于 whisperRatio，防止高情绪起伏台词因局部 <whisper> 被误判成哄睡慢档）
  if (isHighTension && !isTrueSleepAfterglow) {
    const hasSmugTease = /くふふ|ふふっ|えへへ/i.test(s);
    return {
      mode: 'dynamic_climax',
      speed: 1.02,
      silenceStopSec: 0.95,
      silenceKeepSec: 0.42,
      defaultDir: '[breathless trembling emotion, expressive gasping voice]',
      preferredRef: hasSmugTease ? '06_smug_gamer' : '02_tsukkomi',
    };
  }

  // 2) 慢档（弛）：真正的哄睡、余韵放松，或非高张力场景下整句以 <whisper>/<soft> 耳语为主
  if (
    isTrueSleepAfterglow
    || whisperRatio >= 0.45
    || (/\bslow\b|\bmelting\b|\blingering\b/i.test(s) && !isHighTension)
  ) {
    return {
      mode: 'slow_afterglow',
      speed: 1.0,
      silenceStopSec: 1.35,
      silenceKeepSec: 0.70,
      defaultDir: '[breathless melting whisper, slow lingering intimate tone]',
      preferredRef: '03_nadenade',
    };
  }

  // 3) 快档（张）：促狭调侃、傲娇回嘴、害羞慌张抗议、或元气打招呼
  if (
    /<fast>|<stress>|<forceful>|くふふ|ふふっ|えへへ|バレバレ|恥知らず|無礼|不届き|生意気|ふん|むっ|もう！|バカ|だ、だめ|ま、待って|ちょ、ちょっと|ヤッホー|おはよ|リスナー|みんな/i.test(s)
  ) {
    const isTsundere = /<stress>|<forceful>|恥知らず|無礼|不届き|生意気|ふん|むっ|もう！|バカ|怒|だ、だめ|ま、待って|ちょ、ちょっと/i.test(s);
    return {
      mode: 'brisk_tease_fluster',
      speed: 1.04,
      silenceStopSec: 0.95,
      silenceKeepSec: 0.42,
      defaultDir: isTsundere
        ? '[flustered shy protest, cute expressive voice]'
        : '[playful impish teasing, cute expressive voice]',
      preferredRef: isTsundere ? '02_tsukkomi' : '05_happy_clingy',
    };
  }

  // 4) 默认温存档：原速 1.00，完整保留吐息、省略号欲言又止与句间自然换气
  const isQuietShyConfession = /胸がきゅっ|ドキドキ|恥ずかし|照れ/i.test(s);
  return {
    mode: 'modulated_sweet',
    speed: 1.0,
    silenceStopSec: 1.15,
    silenceKeepSec: 0.58,
    defaultDir: isQuietShyConfession
      ? '[shy fluttering confession, soft sweet voice]'
      : '[playful sweet affectionate voice, warm expressive tone]',
    preferredRef: isQuietShyConfession
      ? '04_shy_flustered'
      : (/ちゅっ|とろけ|甘え|ご主人様|クリエイター/i.test(s) ? '03_nadenade' : '01_default'),
  };
}

// 检测并净化 Drama 3 日语语音文本：
// 1) 清理任何残留的 #...# 暗号标签或句中非官方 [...] 括号，防止 TTS 直接把标签念出来；
// 2) 将容易误导 TTS 切换成英文/中文语调的 ASCII 称呼词（Creator）自动转为自然片假名（クリエイター）；
// 3) 校验除 [...] 演技指令后是否包含平假名/片假名，若整段为纯中文（无假名），直接阻断拒绝合成，杜绝中文串台。
export function ensureJapaneseTtsText(rawText) {
  let s = String(rawText ?? '').trim();
  if (!s) return { ok: false, text: '', reason: '语音文本为空' };

  // 拆分句首 [...] 演技指令与正文（避免把 [short pause] 等英文音效标签替换坏）
  const leadMatch = /^\s*(\[[^\]]+\])\s*([\s\S]*)$/.exec(s);
  const leadDir = leadMatch ? leadMatch[1] : '';
  let body = leadMatch ? leadMatch[2] : s;

  // 展开或剥离任何混入 --tts 的 #...# 暗号标签，严防 TTS 照读标签
  for (const [re, rep] of TTS_HASH_TAG_PAIRS) {
    body = body.replace(re, rep);
  }
  // 剥离正文中误写的非官方 [...] 标签（保留 [panting]/[sighs]/[breath]/[gasps]/[giggles]/[short pause]/[pause] 等真实气口与停顿，仅移除极端 [long-break]）
  body = body.replace(/\[[^\]]*\]/g, (tag) => {
    if (/^\[(?:long pause|long-break)\]$/i.test(tag.trim())) {
      return '[short pause]';
    }
    return SINGLE_POINT_TAG_RE.test(tag.trim()) ? tag : '';
  });

  // 保护 [...] 和 <...> 标签内部的英文关键字，只替换正文裸露的英文名与常见中式直译词
  body = body.replace(/(?:\[[^\]]*\]|<[^>]*>)|(\bCreator\b|白を黒と言う|本女神)/gi, (full, word) => {
    if (!word) return full;
    const lower = word.toLowerCase();
    if (lower === 'creator') return 'クリエイター';
    if (word === '白を黒と言う') return '見え透いた嘘をつく';
    if (word === '本女神') return 'あたし';
    return full;
  });

  const spokenOnly = body
    .replace(/\[[^\]]*\]/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\s。、，,；;：:！？!?….\-—～~♪♥♡☆「」『』（）()【】a-zA-Z0-9]+/g, '');
  const kanaCount = (spokenOnly.match(/[\u3040-\u309f\u30a0-\u30ffー]/g) || []).length;
  const totalChars = [...spokenOnly].length;

  // 若正文完全没有日文假名，或者假名占比低于 22%（说明模型把中文台词直接塞进了 --tts），拒绝合成！
  if (totalChars > 0 && (kanaCount === 0 || (totalChars >= 6 && kanaCount / totalChars < 0.22))) {
    return {
      ok: false,
      text: s,
      reason: `检测到非日语台词（假名占比 ${kanaCount}/${totalChars}），已拦截防中文串台`,
    };
  }

  return {
    ok: true,
    text: leadDir ? `${leadDir} ${body}` : body,
  };
}

// Drama 3 文本防呆与「句内张弛有度」归一化：
// - 保留短促叹息、猫叫、亲吻（んぅ…、んちゅ…、にゃあ…、はぁ…）及句尾的省略号 `…`，让气口与余韵慢下来（弛）；
// - 仅将长叙述分句（>= 9 字）末尾滥用的 `…` 转为 `。` 或 `、`，让台词主干自然流畅推进（张），实现一句之内有快有慢、有呼吸起伏。
export function normalizeDrama3Text(rawText) {
  const checked = ensureJapaneseTtsText(rawText);
  let s = String(checked.text ?? '').trim();
  if (!s) return s;
  // 纠正常见的误写标签名
  s = s
    .replace(/<\s*whispering\s*>/gi, '<whisper>')
    .replace(/<\s*\/\s*whispering\s*>/gi, '</whisper>')
    .replace(/<\s*softly\s*>/gi, '<soft>')
    .replace(/<\s*\/\s*softly\s*>/gi, '</soft>')
    .replace(/\[\s*whisper(?:ing)?\s*\]([\s\S]*?)\[\s*\/\s*whisper(?:ing)?\s*\]/gi, '<whisper>$1</whisper>')
    .replace(/\[\s*soft(?:ly)?\s*\]([\s\S]*?)\[\s*\/\s*soft(?:ly)?\s*\]/gi, '<soft>$1</soft>');

  // 检查 7 个官方成对尖括号标签是否闭合，未闭合则在句尾自动补齐
  const spanTags = ['whisper', 'soft', 'emphasis', 'stress', 'fast', 'slow', 'forceful'];
  for (const tag of spanTags) {
    const openRe = new RegExp(`<${tag}>`, 'gi');
    const closeRe = new RegExp(`</${tag}>`, 'gi');
    const opens = (s.match(openRe) || []).length;
    const closes = (s.match(closeRe) || []).length;
    if (opens > closes) {
      s += `</${tag}>`.repeat(opens - closes);
    }
  }

  const leadMatch = /^\s*(\[[^\]]+\])\s*([\s\S]*)$/.exec(s);
  let leadDir = leadMatch && !POINT_TAGS_ONLY_RE.test(leadMatch[1]) ? leadMatch[1].trim() : '';
  let body = leadDir ? leadMatch[2].trim() : s;

  // 1) 保留 <= 40 字的局部 <soft>/<whisper> 耳语层次；仅当模型把 > 40 字的超长整段全包在 <soft> 里时才解包
  body = body.replace(/<soft>([\s\S]*?)<\/soft>/gi, (full, inner) => {
    const plainLen = countSpokenChars(inner);
    return plainLen > 40 ? inner : full;
  });

  // 2) 完整保留并强化分句处的省略号 `…` / `……` 与句间呼吸空隙，防止多句连着抢读、断句太急
  body = body
    .replace(/\.{2,}/g, '……')
    .replace(/…{3,}/g, '……')
    // 当分句（>=5个日文字）末尾用单个 `…` 直接连下一句时，升格为 `…… ` 给足欲言又止的换气停顿
    .replace(/([\u3040-\u30ff\u4e00-\u9fa5ー]{5,}[♪♥♡☆]?)…(?=[\u3040-\u30ff\u4e00-\u9fa5<\[])/g, '$1…… ')
    // 在句末标点与双省略号后补齐半角空格，提示 Drama 3 自然中断换气
    .replace(/([。！？!?]|……)(?=[\u3040-\u30ff\u4e00-\u9fa5<\[])/g, '$1 ')
    .replace(/、{2,}/g, '、')
    .replace(/。+/g, '。')
    .replace(/\s+/g, ' ')
    .trim();

  // 3) 按本段情感与节奏分类，智能匹配或修正句首演技指令（防止高张力台词被误套 unhurried/slow 平缓模板）
  const pacing = classifySegmentPacing(body);
  if (!leadDir || (Buffer.byteLength(leadDir, 'utf8') > 85 && !/[a-zA-Z]{3}/.test(leadDir))) {
    leadDir = pacing.defaultDir;
  } else if (pacing.mode === 'dynamic_climax' && /unhurried|slow|lingering|calm|bedtime|sleepy/i.test(leadDir)) {
    leadDir = pacing.defaultDir;
  } else if (pacing.mode === 'slow_afterglow' && /間延びせず|早口|軽快|brisk|fast|bouncy/i.test(leadDir)) {
    leadDir = pacing.defaultDir;
  } else if (pacing.mode === 'brisk_tease_fluster' && /unhurried|slow|lingering/i.test(leadDir)) {
    leadDir = pacing.defaultDir;
  } else if (pacing.mode === 'brisk_tease_fluster' && !/テンポ|軽快|早口|慌てて|弾む|brisk|playful|flustered|lively|fast|bouncy|cute/i.test(leadDir)) {
    leadDir = leadDir.replace(/^\[/, '[playful cute voice, ');
  } else if (pacing.mode === 'modulated_sweet' && !/緩急|テンポ|pace|conversational|warm|modulated|gentle|slow|whisper|intimate|lingering|expressive|playful|sweet/i.test(leadDir)) {
    leadDir = leadDir.replace(/^\[/, '[warm sweet expressive voice, ');
  }

  return `${leadDir} ${body}`.trim();
}

export function countSpokenChars(text) {
  const plain = String(text ?? '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/<\/?[a-zA-Z]+>/g, '')
    .replace(/[\s。、，,；;：:！？!?….\-—～~♪♥♡☆「」『』（）()【】]/g, '');
  return [...plain].length;
}

function endsWithCommaOrIncomplete(text) {
  const stripped = String(text ?? '')
    .replace(/<\/?[a-zA-Z]+>/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
  return /[、，,；;：:]$/.test(stripped);
}

function splitPlainClauses(text, maxSpokenChars) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  if (countSpokenChars(s) <= maxSpokenChars) return [s];

  // 仅按完整句末标点（。！？♪♥♡☆）切分，绝不在逗号（、，）或省略号（…）处硬切，保证整句语气连贯不跳句
  const primary = [];
  let buf = '';
  let inBracket = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '[') inBracket += 1;
    else if (ch === ']' && inBracket > 0) inBracket -= 1;
    buf += ch;
    if (
      inBracket === 0 &&
      (/[。！？!?♪♥♡☆\n]/.test(ch) ||
        (ch === '…' &&
          countSpokenChars(buf) >= 22 &&
          /(?:だよぉ?|なのぉ?|もん|じゃん|からね|だよね|でしょ|わよ|なさいよ|てね|でね|よぉ|なぁ|かな|のに|からぁ|たよ|たの|ちゃった|あげる|いいよ|だめぇ?|やだぁ?|クリエイター|ご主人様|ごしゅじんさま)…+$/.test(buf)))
    ) {
      while (i + 1 < s.length && /[。！？!?♪♥♡☆…~～\s]/.test(s[i + 1])) {
        i += 1;
        buf += s[i];
      }
      if (buf.trim()) primary.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) primary.push(buf.trim());

  // 贪心打包：短句（< 18 发音字）或逗号未完句自动并入相邻句，不做硬性字数截断
  const packed = [];
  let cur = '';
  for (const clause of primary) {
    if (!cur) {
      cur = clause;
      continue;
    }
    const curLen = countSpokenChars(cur);
    const nextLen = countSpokenChars(clause);
    if (endsWithCommaOrIncomplete(cur) || curLen < 18 || curLen + nextLen <= maxSpokenChars) {
      cur = `${cur} ${clause}`.replace(/\s+/g, ' ').trim();
    } else {
      packed.push(cur);
      cur = clause;
    }
  }
  if (cur) {
    if (packed.length > 0 && (endsWithCommaOrIncomplete(packed[packed.length - 1]) || countSpokenChars(cur) < 18)) {
      packed[packed.length - 1] = `${packed[packed.length - 1]} ${cur}`.replace(/\s+/g, ' ').trim();
    } else {
      packed.push(cur);
    }
  }
  return packed;
}

// 软性长句切分：单条长情话默认整条连贯不断开（<= 150 发音字直接走单条），绝不在逗号/省略号处跳句；仅超长独白才在完整句末边界自然分段
export function splitDrama3TextForTts(rawText, maxSpokenChars = 150) {
  const normalized = normalizeDrama3Text(rawText);
  if (!normalized) return [];
  const leadMatch = /^\s*(\[[^\]]+\])\s*/.exec(normalized);
  const leadActingTag = leadMatch && !POINT_TAGS_ONLY_RE.test(leadMatch[1]) ? leadMatch[1] : '';
  const bodyText = leadActingTag ? normalized.slice(leadMatch[0].length).trim() : normalized;

  if (countSpokenChars(bodyText) <= maxSpokenChars) {
    return [normalized];
  }

  // 按成对尖括号标签 <soft>/<whisper> 等拆成顶层块
  const blocks = [];
  const tagRe = /<(whisper|soft|emphasis|stress|fast|slow|forceful)>([\s\S]*?)<\/\1>/gi;
  let lastIdx = 0;
  let m;
  while ((m = tagRe.exec(bodyText)) !== null) {
    if (m.index > lastIdx) {
      const plain = bodyText.slice(lastIdx, m.index).trim();
      if (plain) blocks.push({ tag: '', text: plain });
    }
    const inner = String(m[2] || '').trim();
    if (inner) blocks.push({ tag: m[1].toLowerCase(), text: inner });
    lastIdx = tagRe.lastIndex;
  }
  if (lastIdx < bodyText.length) {
    const tail = bodyText.slice(lastIdx).trim();
    if (tail) blocks.push({ tag: '', text: tail });
  }
  if (blocks.length === 0) {
    blocks.push({ tag: '', text: bodyText });
  }

  // 每个块内部仅按完整句末标点切分并重新包裹标签
  const rawSegments = [];
  let pendingPrefix = '';
  for (const blk of blocks) {
    if (countSpokenChars(blk.text) === 0) {
      pendingPrefix = pendingPrefix ? `${pendingPrefix} ${blk.text}` : blk.text;
      continue;
    }
    const clauses = splitPlainClauses(blk.text, maxSpokenChars);
    for (const c of clauses) {
      const wrapped = blk.tag ? `<${blk.tag}>${c}</${blk.tag}>` : c;
      const withPrefix = pendingPrefix ? `${pendingPrefix} ${wrapped}` : wrapped;
      pendingPrefix = '';
      rawSegments.push(withPrefix.trim());
    }
  }
  if (pendingPrefix && rawSegments.length > 0) {
    rawSegments[rawSegments.length - 1] += ` ${pendingPrefix}`;
  }

  // 跨块合并：逗号结尾未完句无条件合并，或者总长未超软上限（maxSpokenChars）时合并，避免语气切换
  const merged = [];
  for (const seg of rawSegments) {
    if (merged.length === 0) {
      merged.push(seg);
      continue;
    }
    const prev = merged[merged.length - 1];
    const prevLen = countSpokenChars(prev);
    const segLen = countSpokenChars(seg);
    if (
      endsWithCommaOrIncomplete(prev) ||
      prevLen + segLen <= maxSpokenChars ||
      prevLen < 18 ||
      segLen < 18
    ) {
      merged[merged.length - 1] = `${prev} ${seg}`.trim();
    } else {
      merged.push(seg);
    }
  }

  return merged.map((seg) => normalizeDrama3Text(seg));
}

const _arisRefCacheMap = new Map();

function loadArisReferences(fishCfg = {}) {
  const relDir = String(fishCfg.referenceDir || 'audio/references/restored_48k').trim();
  const refDir = path.isAbsolute(relDir) ? relDir : path.resolve(ROOT, relDir);
  const manifestPath = path.join(refDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return [];
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(manifestPath).mtimeMs;
  } catch {}
  const cached = _arisRefCacheMap.get(manifestPath);
  if (cached && mtimeMs > 0 && mtimeMs === cached.mtimeMs) return cached.items;
  try {
    const list = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const loaded = [];
    for (const item of list) {
      const wavFile = path.join(refDir, path.basename(String(item.wav_path || `${item.id}.wav`)));
      if (!fs.existsSync(wavFile)) continue;
      loaded.push({
        id: String(item.id || path.basename(wavFile, '.wav')),
        fileName: path.basename(wavFile),
        wavPath: wavFile,
        transcript: String(item.transcript || ''),
        audio: fs.readFileSync(wavFile),
      });
    }
    if (loaded.length > 0) {
      _arisRefCacheMap.set(manifestPath, { mtimeMs, items: loaded });
    }
    return loaded;
  } catch {
    return [];
  }
}

let _localServerLaunchPromise = null;

async function ensureLocalDrama3Server(localCfg = {}, request = fetch) {
  const baseUrl = String(localCfg.baseUrl || 'http://127.0.0.1:17864').replace(/\/+$/, '');
  try {
    const res = await request(`${baseUrl}/health`, { signal: AbortSignal.timeout(1200) });
    if (res.ok) return baseUrl;
  } catch {}

  if (localCfg.autoStart === false || request !== fetch) {
    throw new Error(`本地 Drama3 服务未就绪 (${baseUrl})`);
  }
  const lockPath = String(localCfg.stopLockPath || path.join(ROOT, 'state', 'drama3-manual-stop.lock'));
  if (fs.existsSync(lockPath)) {
    throw new Error(`本地 Drama3 已手动停止 (${lockPath})，跳过自动拉起`);
  }

  if (!_localServerLaunchPromise) {
    _localServerLaunchPromise = (async () => {
      const serverExe = String(
        localCfg.serverExe || ''
      );
      const serverConfig = String(localCfg.serverConfig || '');
      const cudaBin = String(localCfg.cudaBin || 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.0\\bin');
      if (!fs.existsSync(serverExe) || !fs.existsSync(serverConfig)) {
        throw new Error(`缺少本地 Drama3 可执行文件或配置 (${serverExe})`);
      }
      const env = {
        ...process.env,
        PATH: `${cudaBin};${process.env.PATH || ''}`,
      };
      const child = spawn(
        serverExe,
        [
          '--config', serverConfig,
          '--no-ui',
          '--log',
          '--log-file', String(localCfg.logFile || path.join(ROOT, 'state', 'drama3-local.log')),
        ],
        {
          cwd: path.dirname(path.dirname(path.dirname(path.dirname(serverExe)))),
          env,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }
      );
      child.unref();
      for (let i = 0; i < 24; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1200) });
          if (r.ok) return baseUrl;
        } catch {}
      }
      throw new Error(`启动本地 Drama3 服务超时 (${baseUrl})`);
    })().finally(() => {
      _localServerLaunchPromise = null;
    });
  }
  return _localServerLaunchPromise;
}

async function getOrEncodeLocalVqReference(baseUrl, model, chosenRef, localCfg = {}, request = fetch) {
  if (!chosenRef?.wavPath) return null;
  const refDir = path.dirname(chosenRef.wavPath);
  const cacheFile = path.join(refDir, 'vq_codes_cache.json');
  const cacheKey = `${model}::${chosenRef.id}`;
  let cacheObj = {};
  try {
    if (fs.existsSync(cacheFile)) {
      cacheObj = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
    }
  } catch {}
  if (cacheObj[cacheKey]?.vq_codes && cacheObj[cacheKey]?.text) {
    return cacheObj[cacheKey];
  }
  if (localCfg.useVqCache === false) return null;

  const res = await request(`${baseUrl}/v1/tasks/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(Number(localCfg.timeoutMs) || 120000),
    body: JSON.stringify({
      model,
      request: {
        text: 'Prepare the reference.',
        voice_ref: chosenRef.wavPath,
        options: {
          reference_text: chosenRef.transcript,
          encode_reference_only: true,
        },
      },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const artifacts = data?.artifacts || data?.output_artifacts || data?.result?.artifacts || [];
  const art = Array.isArray(artifacts)
    ? (artifacts.find((a) => a?.id === 'drama3_reference_0' && a?.payload) || artifacts.find((a) => a?.payload))
    : null;
  if (!art?.payload) return null;
  const parsed = JSON.parse(Buffer.from(String(art.payload), 'base64').toString('utf8'));
  if (!Array.isArray(parsed?.vq_codes)) return null;
  const entry = { text: chosenRef.transcript, vq_codes: parsed.vq_codes };
  try {
    cacheObj[cacheKey] = entry;
    fs.writeFileSync(cacheFile, JSON.stringify(cacheObj));
  } catch {}
  return entry;
}

// 根据 Drama 3 台词中的演技指令、局部尖括号标签或显式指定，智能匹配最贴合的 48kHz 情绪参考音频
export function selectArisReference(text, preferredRef, refs) {
  if (!Array.isArray(refs) || refs.length === 0) return null;
  const pref = String(preferredRef || '').trim().toLowerCase();
  if (pref) {
    const matched = refs.find((r) =>
      r.id.toLowerCase() === pref
      || r.fileName.toLowerCase() === pref
      || r.id.toLowerCase().includes(pref)
    );
    if (matched) return matched;
  }

  const t = String(text || '');
  const findById = (sub) => refs.find((r) => r.id.includes(sub));

  // 02/06: 高张力激动 / 急促喘息（避免落入平静的 04 号轻柔底音，优先走高低起伏大的 02 或灵动调侃的 06）
  if (/ひゃあっ|きゃあっ|あぁっ|はぁあっ|んぁあっ|気持ちよすぎ|壊れちゃ|もうダメ|限界/i.test(t)) {
    const r = /くふふ|ふふっ|えへへ/i.test(t)
      ? (findById('06_smug_gamer') || findById('02_tsukkomi'))
      : (findById('02_tsukkomi') || findById('03_nadenade'));
    if (r) return r;
  }
  // 02: 傲娇吐槽 / 回嘴抗议 / 气鼓鼓（语速干脆有张力）
  if (/<stress>|<forceful>|\[(?:indignant|disdainful|angry|annoyed|frustrated|sarcastic|flustered)\]|恥知らず|無礼|不届き|生意気|ふん|むっ|もう！|バカ|いじわる|怒|からかって|騙され|ま、待って|だ、だめ|吐槽|抗议|生气|嫌弃/i.test(t)) {
    const r = findById('02_tsukkomi');
    if (r) return r;
  }
  // 05/06: 灵动调侃 / 得意轻笑 / 元气打招呼（语速轻快富有弹性）
  if (/<fast>|\[(?:smug|guilty|panicked|nervous|playful|impish)\]|くふふ|ふふっ|えへへ|ヤッホー|おはよ|お疲れ|クール|低い声|ゲーセン/i.test(t)) {
    const r = /くふふ～|照れる表情|好きなん/i.test(t)
      ? (findById('06_smug_gamer') || findById('05_happy_clingy'))
      : (findById('05_happy_clingy') || findById('01_default'));
    if (r) return r;
  }
  // 04: 安静羞怯 / 小鹿乱撞表白（仅限轻柔害羞情话）
  if (/胸がきゅっ|ドキドキ|恥ずかし|照れ/i.test(t)) {
    const r = findById('04_shy_flustered') || findById('03_nadenade');
    if (r) return r;
  }
  // 03: 贴耳温存 / 哄睡 / 温柔安抚
  if (/<whisper>|おやすみ|眠|二度寝|とろけ|ちゅっ/i.test(t)) {
    const r = findById('03_nadenade') || findById('01_default');
    if (r) return r;
  }

  return findById('01_default') || refs[0];
}

async function readAudio(response, maxBytes, provider) {
  if (!response.ok) {
    let errBody = '';
    try {
      errBody = (await response.text()).slice(0, 240);
    } catch {
      await response.body?.cancel();
    }
    throw new Error(provider + ' HTTP ' + response.status + (errBody ? ': ' + errBody : ''));
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('TTS 音频超过语音体积上限');
    chunks.push(chunk);
  }
  if (bytes < 256) throw new Error(provider + ' 返回音频过小');
  return Buffer.concat(chunks, bytes);
}

// 支持 fish_local (本地 5090D v2 audio.cpp Drama 3)、fish (官方云端 Drama 3)、elevenlabs、google 四种提供商，统一返回 MP3。
export async function synthesizeSpeech(text, config, options = {}, maxBytes = 20 * 1024 * 1024, request = fetch) {
  const configured = String(config.provider || 'fish').toLowerCase();
  const rawFallback = String(config.fallbackProvider ?? 'none').toLowerCase();
  const fallback = rawFallback === 'none' ? '' : rawFallback;
  const primary = String(options.provider || configured).toLowerCase();
  const allowedProviders = ['fish_local', 'fish', 'elevenlabs', 'google'];
  if (!allowedProviders.includes(primary) || ![configured, fallback].includes(primary)) {
    throw Object.assign(new Error('请求的 TTS 提供商未启用'), { statusCode: 400 });
  }
  if (primary === 'google' && (!fallback || fallback === 'google') && [...text].length > 200) {
    throw Object.assign(new Error('Google TTS 单次支持 200 字以内'), { statusCode: 400 });
  }
  const errors = [];
  for (const provider of new Set([primary, fallback].filter(Boolean))) {
    try {
      if (provider === 'fish_local') {
        const localCfg = config.fish_local ?? {};
        const jpCheck = ensureJapaneseTtsText(text);
        if (!jpCheck.ok) {
          throw Object.assign(new Error(jpCheck.reason), { statusCode: 400 });
        }
        const model = String(options.localModel || localCfg.model || 'drama3-iq3').trim() || 'drama3-iq3';
        const normalizedText = normalizeDrama3Text(jpCheck.text);
        const refs = loadArisReferences({
          referenceDir: localCfg.referenceDir || 'audio/references/local_short_48k',
        });
        const chosenRef = selectArisReference(
          normalizedText,
          options.reference || options.ttsRef || localCfg.preferredReference || '',
          refs
        );
        if (!chosenRef?.wavPath) {
          throw new Error('本地 Drama3 未找到可用参考音频');
        }
        const baseUrl = await ensureLocalDrama3Server(localCfg, request);
        const vqEntry = await getOrEncodeLocalVqReference(baseUrl, model, chosenRef, localCfg, request).catch(() => null);
        const spokenCount = Math.max(12, countSpokenChars(normalizedText));
        // 日语平均约 4.5~6.5 假名/秒（含省略号停顿与 <whisper> 耳语余韵），21.5 frames/秒；给足呼吸留白同时防失控死循环
        const dynamicMaxTokens = Math.min(
          Number(localCfg.maxTokens) || 920,
          Math.max(280, Math.round(spokenCount * 7.8 + 220))
        );
        const isSmallModel = /iq3|small/i.test(model);
        const reqOptions = {
          text_chunk_size: Number(localCfg.textChunkSize) || 512,
          skip_empty_chunks: true,
          temperature: Number(localCfg.temperature ?? (isSmallModel ? 0.72 : 0.8)),
          top_p: Number(localCfg.topP ?? (isSmallModel ? 0.8 : 0.88)),
          top_k: Number(localCfg.topK ?? 4097),
        };
        const reqPayload = {
          text: normalizedText,
          max_tokens: dynamicMaxTokens,
          options: reqOptions,
        };
        if (options.seed !== undefined) reqPayload.seed = Number(options.seed);
        if (vqEntry) {
          reqOptions.references = JSON.stringify([{ text: vqEntry.text, vq_codes: vqEntry.vq_codes }]);
        } else {
          reqPayload.voice_ref = chosenRef.wavPath;
          reqOptions.reference_text = chosenRef.transcript;
        }

        const res = await request(`${baseUrl}/v1/tasks/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(Number(localCfg.timeoutMs) || 95000),
          body: JSON.stringify({ model, request: reqPayload }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(`FishLocal HTTP ${res.status}: ${data?.error?.message || data?.error || JSON.stringify(data).slice(0, 180)}`);
        }
        if (data?.custom_schema_output?.data?.reached_limit === true) {
          throw new Error(`FishLocal 生成触及帧上限 (${dynamicMaxTokens} frames)，自动切云端保底`);
        }
        const wavB64 = data?.audio || data?.result?.audio || '';
        const wavBuf = Buffer.from(String(wavB64), 'base64');
        if (wavBuf.length < 1024) {
          throw new Error('FishLocal 返回音频为空或过短');
        }
        if (wavBuf.length > maxBytes * 3) {
          throw new Error('FishLocal 返回 WAV 体积超限');
        }

        const saveDir = path.join(ROOT, 'audio', 'tts_saved');
        fs.mkdirSync(saveDir, { recursive: true });
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${String(now.getMilliseconds()).padStart(3, '0')}`;
        const refLabel = chosenRef.id;
        const tmpWav = path.join(saveDir, `${ts}_${refLabel}.local.wav`);
        const savedPath = path.join(saveDir, `${ts}_${refLabel}.mp3`);
        fs.writeFileSync(tmpWav, wavBuf);

        const pacing = classifySegmentPacing(normalizedText);
        const targetSpeed = Number(options.speed ?? pacing.speed ?? 1.0);
        const stopSec = Number(pacing.silenceStopSec ?? 1.15);
        const keepSec = Number(pacing.silenceKeepSec ?? 0.58);
        const ffmpegBin = String(localCfg.ffmpegPath || config.fish?.ffmpegPath || 'ffmpeg');
        const silenceFilter = `silenceremove=stop_periods=-1:stop_duration=${stopSec.toFixed(2)}:stop_silence=${keepSec.toFixed(2)}:stop_threshold=-52dB`;
        const afChain = Number.isFinite(targetSpeed) && Math.abs(targetSpeed - 1.0) >= 0.02
          ? `${silenceFilter},atempo=${targetSpeed.toFixed(2)}`
          : silenceFilter;
        try {
          await execFileAsync(ffmpegBin, [
            '-y', '-i', tmpWav,
            '-af', afChain,
            '-c:a', 'libmp3lame', '-b:a', '192k',
            savedPath,
          ], { timeout: 12000, windowsHide: true });
        } finally {
          try { if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav); } catch {}
        }
        const audioBuf = fs.readFileSync(savedPath);
        if (audioBuf.length < 256 || audioBuf.length > maxBytes) {
          throw new Error('FishLocal MP3 转码异常');
        }
        try {
          fs.appendFileSync(
            path.join(saveDir, 'history.jsonl'),
            JSON.stringify({ time: now.toISOString(), file: path.basename(savedPath), provider: `fish_local/${model}`, ref: refLabel, pacing: pacing.mode, speed: targetSpeed, text: normalizedText }) + '\n'
          );
        } catch {}
        return {
          audio: audioBuf,
          provider: `fish_local(${model}/${refLabel})`,
          savedPath,
        };
      }

      if (provider === 'fish') {
        const cfg = config.fish ?? {};
        const key = await fishAudioKey(cfg);
        if (!key) throw new Error('未配置 FISH_API_KEY');
        const jpCheck = ensureJapaneseTtsText(text);
        if (!jpCheck.ok) {
          throw Object.assign(new Error(jpCheck.reason), { statusCode: 400 });
        }
        const model = String(options.model || options.modelId || cfg.model || 'drama-3').trim() || 'drama-3';
        const normalizedText = normalizeDrama3Text(jpCheck.text);
        const refs = loadArisReferences(cfg);
        const chosenRef = selectArisReference(
          normalizedText,
          options.reference || options.ttsRef || cfg.preferredReference || '',
          refs
        );
        const explicitRefId = String(options.referenceId || options.voiceId || cfg.referenceId || '').trim();

        const payloadObj = {
          text: normalizedText,
          format: 'mp3',
          mp3_bitrate: Number(cfg.mp3Bitrate) || 192,
          normalize: cfg.normalize !== false,
          temperature: Number(cfg.temperature ?? 0.7),
          top_p: Number(cfg.topP ?? 0.7),
          latency: String(cfg.latency || 'normal'),
        };

        let bodyBuf;
        let contentType;
        let refLabel = 'default';
        if (explicitRefId) {
          payloadObj.reference_id = explicitRefId;
          bodyBuf = JSON.stringify(payloadObj);
          contentType = 'application/json';
          refLabel = explicitRefId;
        } else if (chosenRef) {
          payloadObj.references = [{ audio: chosenRef.audio, text: chosenRef.transcript }];
          bodyBuf = encodeMsgpack(payloadObj);
          contentType = 'application/msgpack';
          refLabel = chosenRef.id;
        } else {
          bodyBuf = JSON.stringify(payloadObj);
          contentType = 'application/json';
        }

        const maxAttempts = request === fetch ? 2 : 1;
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const res = await request('https://api.fish.audio/v1/tts', {
              method: 'POST',
              redirect: 'error',
              signal: AbortSignal.timeout(45000),
              headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': contentType,
                model,
              },
              body: bodyBuf,
            });
            let audioBuf = await readAudio(res, maxBytes, 'FishAudio');
            let savedPath = '';
            if (request === fetch) {
              try {
                const saveDir = path.join(ROOT, 'audio', 'tts_saved');
                fs.mkdirSync(saveDir, { recursive: true });
                const now = new Date();
                const pad = (n) => String(n).padStart(2, '0');
                const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${String(now.getMilliseconds()).padStart(3, '0')}`;
                const fileName = `${ts}_${refLabel}.mp3`;
                savedPath = path.join(saveDir, fileName);
                fs.writeFileSync(savedPath, audioBuf);

                // 按单段「张弛有度」四档节奏判定，完整保留句内省略号与换气停顿（stop_silence 保底留白，绝不切零静音）
                const pacing = classifySegmentPacing(normalizedText);
                const targetSpeed = Number(options.speed ?? pacing.speed ?? 1.0);
                const stopSec = Number(pacing.silenceStopSec ?? 1.15);
                const keepSec = Number(pacing.silenceKeepSec ?? 0.58);
                if (Number.isFinite(targetSpeed) && targetSpeed >= 0.92 && targetSpeed <= 1.45) {
                  const ffmpegBin = String(cfg.ffmpegPath || 'ffmpeg');
                  const fastPath = `${savedPath}.fast.mp3`;
                  const silenceFilter = `silenceremove=stop_periods=-1:stop_duration=${stopSec.toFixed(2)}:stop_silence=${keepSec.toFixed(2)}:stop_threshold=-52dB`;
                  const afChain = Math.abs(targetSpeed - 1.0) >= 0.02
                    ? `${silenceFilter},atempo=${targetSpeed.toFixed(2)}`
                    : silenceFilter;
                  try {
                    await execFileAsync(ffmpegBin, [
                      '-y', '-i', savedPath,
                      '-af', afChain,
                      '-c:a', 'libmp3lame', '-b:a', '192k',
                      fastPath,
                    ], { timeout: 8000, windowsHide: true });
                    if (fs.existsSync(fastPath) && fs.statSync(fastPath).size > 256) {
                      audioBuf = fs.readFileSync(fastPath);
                      fs.writeFileSync(savedPath, audioBuf);
                    }
                  } catch {} finally {
                    try { if (fs.existsSync(fastPath)) fs.unlinkSync(fastPath); } catch {}
                  }
                }

                fs.appendFileSync(
                  path.join(saveDir, 'history.jsonl'),
                  JSON.stringify({ time: now.toISOString(), file: fileName, ref: refLabel, pacing: pacing.mode, speed: targetSpeed, text: normalizedText }) + '\n'
                );
              } catch {}
            }
            return {
              audio: audioBuf,
              provider: `fish(${model}/${refLabel})`,
              savedPath,
            };
          } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 800));
          }
        }
        throw lastErr;
      }

      if (provider === 'elevenlabs') {
        const cfg = config.elevenlabs ?? {};
        const voiceId = String(options.voiceId || cfg.voiceId || '').trim();
        if (!voiceId) throw new Error('未配置 ElevenLabs voiceId');
        const key = await elevenLabsKey(cfg);
        if (!key) throw new Error('未配置 ELEVENLABS_API_KEY');
        const model = String(options.modelId || cfg.modelId || 'eleven_v3');
        const url = new URL('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId));
        url.searchParams.set('output_format', cfg.outputFormat || 'mp3_44100_128');
        const maxAttempts = request === fetch ? 2 : 1;
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            const res = await request(url, {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
              headers: { 'xi-api-key': key, 'content-type': 'application/json' },
              body: JSON.stringify({
                text, model_id: model,
                voice_settings: {
                  stability: Number(cfg.stability ?? 0.5), similarity_boost: Number(cfg.similarityBoost ?? 0.75),
                  style: Number(cfg.style ?? 0.35), use_speaker_boost: true,
                },
                ...(cfg.languageCode && !model.includes('v3') ? { language_code: cfg.languageCode } : {}),
              }),
            });
            return { audio: await readAudio(res, maxBytes, 'ElevenLabs'), provider: `elevenlabs(${voiceId}/${model})` };
          } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 600));
          }
        }
        throw lastErr;
      }
      if (provider !== 'google') throw new Error('不支持的 TTS 提供商');
      if ([...text].length > 200) throw new Error('Google TTS 单次支持 200 字以内');
      const lang = String(options.lang || config.google?.lang || 'zh-CN');
      const url = new URL('https://translate.googleapis.com/translate_tts');
      url.search = new URLSearchParams({ ie: 'UTF-8', client: 'gtx', tl: lang, q: text });
      const res = await request(url, {
        headers: { 'user-agent': 'Mozilla/5.0' }, redirect: 'error', signal: AbortSignal.timeout(12000),
      });
      return { audio: await readAudio(res, maxBytes, 'Google TTS'), provider: `google(${lang})` };
    } catch (error) {
      if (error?.statusCode === 400) throw error;
      errors.push(error.message);
    }
  }
  throw new Error(errors.join(' / '));
}
