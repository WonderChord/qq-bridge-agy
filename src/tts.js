import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function elevenLabsKey(config) {
  const key = String(config.apiKey || process.env.ELEVENLABS_API_KEY || '').trim();
  if (key || process.platform !== 'win32') return key;
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'ELEVENLABS_API_KEY'], {
      timeout: 2000, windowsHide: true,
    });
    return /ELEVENLABS_API_KEY\s+REG_\w+\s+([^\r\n]+)/i.exec(stdout)?.[1].trim() || '';
  } catch {
    return '';
  }
}

async function readAudio(response, maxBytes, provider) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(provider + ' HTTP ' + response.status);
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

// 两种提供商都返回 MP3。只在管理员配置的备用提供商上重试一次。
export async function synthesizeSpeech(text, config, options, maxBytes, request = fetch) {
  const configured = String(config.provider || 'elevenlabs').toLowerCase();
  const rawFallback = String(config.fallbackProvider ?? 'google').toLowerCase();
  const fallback = rawFallback === 'none' ? '' : rawFallback;
  const primary = String(options.provider || configured).toLowerCase();
  if (!['google', 'elevenlabs'].includes(primary) || ![configured, fallback].includes(primary)) {
    throw Object.assign(new Error('请求的 TTS 提供商未启用'), { statusCode: 400 });
  }
  if (primary === 'google' && (!fallback || fallback === 'google') && [...text].length > 200) {
    throw Object.assign(new Error('Google TTS 单次支持 200 字以内'), { statusCode: 400 });
  }
  const errors = [];
  for (const provider of new Set([primary, fallback].filter(Boolean))) {
    try {
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
