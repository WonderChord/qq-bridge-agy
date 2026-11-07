import { execFile } from 'node:child_process';
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

// Drama 3 文本防呆归一化：确保耳语等局部标签统一为成对 <tag>...</tag> 并自动闭合遗漏标签
export function normalizeDrama3Text(rawText) {
  let s = String(rawText ?? '').trim();
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
  // 若台词开头未写句级演技指令 [...]，默认注入魅惑湿润气音 + 小恶魔般灵巧撩拨的少女口语指令
  if (!/^\s*\[/.test(s)) {
    s = '[色っぽく艶のある甘い吐息交じりの声で、小悪魔っぽくからかうように耳元で誘惑するトーンで] ' + s;
  }
  return s;
}

let _arisRefCache = null;
let _arisRefMtimeMs = 0;

function loadArisReferences(fishCfg = {}) {
  const relDir = String(fishCfg.referenceDir || 'audio/nya_aris_ref/restored_48k').trim();
  const refDir = path.isAbsolute(relDir) ? relDir : path.resolve(ROOT, relDir);
  const manifestPath = path.join(refDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return [];
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(manifestPath).mtimeMs;
  } catch {}
  if (_arisRefCache && mtimeMs > 0 && mtimeMs === _arisRefMtimeMs) return _arisRefCache;
  try {
    const list = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const loaded = [];
    for (const item of list) {
      const wavFile = path.join(refDir, path.basename(String(item.wav_path || `${item.id}.wav`)));
      if (!fs.existsSync(wavFile)) continue;
      loaded.push({
        id: String(item.id || path.basename(wavFile, '.wav')),
        fileName: path.basename(wavFile),
        transcript: String(item.transcript || ''),
        audio: fs.readFileSync(wavFile),
      });
    }
    if (loaded.length > 0) {
      _arisRefCache = loaded;
      _arisRefMtimeMs = mtimeMs;
    }
    return loaded;
  } catch {
    return [];
  }
}

// 根据 Drama 3 台词中的演技指令、局部尖括号标签或显式指定，智能匹配最贴合的 48kHz 爱丽丝参考音频
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

  // 03: 温柔甜糯 / 撒娇黏人 / 求摸头（高糖度贴耳参考）
  if (/<soft>|<whisper>|\[(?:gentle|warm|tender|caring|affectionate|sweet|shy|embarrassed)\]|ふわぁ|えへへ|ふふ|ナデナデ|撫で|甘え|大好き|摸头|撒娇|黏人|喜欢|抱/i.test(t)) {
    const r = findById('03_nadenade') || findById('01_default');
    if (r) return r;
  }
  // 04: 害羞破防 / 喘息
  if (/\[(?:panting|shaky breath|yawning)\]|恥ずかし|平常心|害羞|脸红|破防|喘/i.test(t)) {
    const r = findById('04_shy') || findById('03_nadenade');
    if (r) return r;
  }
  // 05: 撒娇黏人 / 吃醋 / 欢快讨宠
  if (/\[(?:jealous|envious|affectionate|sweet|pouting)\]|甘え|大好き|親愛度|すね|むー|撒娇|吃醋|偏心|黏人/i.test(t)) {
    const r = findById('05_happy_clingy');
    if (r) return r;
  }
  // 02: 傲娇吐槽 / 回嘴抗议 / 气鼓鼓
  if (/<stress>|<forceful>|\[(?:indignant|disdainful|angry|annoyed|frustrated|sarcastic)\]|食べません|乾電池|むっ|もう！|からかって|騙され|吐槽|抗议|生气|嫌弃/i.test(t)) {
    const r = findById('02_tsukkomi');
    if (r) return r;
  }
  // 06: 电玩耍宝 / 压低声音装酷 / 慌张心虚抢白
  if (/<fast>|\[(?:smug|guilty|panicked|nervous)\]|数千年|クール|低い声|ゲーセン|うそをつきません|ラグ|装酷|压低|心虚|慌张/i.test(t)) {
    const r = findById('06_smug_gamer');
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

// 支持 fish (Drama 3)、elevenlabs、google 三种提供商，统一返回 MP3。
export async function synthesizeSpeech(text, config, options = {}, maxBytes = 20 * 1024 * 1024, request = fetch) {
  const configured = String(config.provider || 'fish').toLowerCase();
  const rawFallback = String(config.fallbackProvider ?? 'none').toLowerCase();
  const fallback = rawFallback === 'none' ? '' : rawFallback;
  const primary = String(options.provider || configured).toLowerCase();
  const allowedProviders = ['fish', 'elevenlabs', 'google'];
  if (!allowedProviders.includes(primary) || ![configured, fallback].includes(primary)) {
    throw Object.assign(new Error('请求的 TTS 提供商未启用'), { statusCode: 400 });
  }
  if (primary === 'google' && (!fallback || fallback === 'google') && [...text].length > 200) {
    throw Object.assign(new Error('Google TTS 单次支持 200 字以内'), { statusCode: 400 });
  }
  const errors = [];
  for (const provider of new Set([primary, fallback].filter(Boolean))) {
    try {
      if (provider === 'fish') {
        const cfg = config.fish ?? {};
        const key = await fishAudioKey(cfg);
        if (!key) throw new Error('未配置 FISH_API_KEY');
        const model = String(options.model || options.modelId || cfg.model || 'drama-3').trim() || 'drama-3';
        const normalizedText = normalizeDrama3Text(text);
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
            const audioBuf = await readAudio(res, maxBytes, 'FishAudio');
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
                fs.appendFileSync(
                  path.join(saveDir, 'history.jsonl'),
                  JSON.stringify({ time: now.toISOString(), file: fileName, ref: refLabel, text: normalizedText }) + '\n'
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
      errors.push(error.message);
    }
  }
  throw new Error(errors.join(' / '));
}
