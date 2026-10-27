'use strict';

/**
 * DeepSeek 客户端（兼容 OpenAI 的 /chat/completions 协议）。
 * 只用 Node 内置模块，支持流式与非流式，失败时抛带「鲸鱼娘口吻」提示的 LlmError。
 */
const http = require('node:http');
const https = require('node:https');
const {createHash} = require('node:crypto');
const { URL } = require('node:url');
const { resolveRuntime, maskKey } = require('./config');

const FRIENDLY = {
  nokey: '呜…人家还没拿到深海的钥匙（API Key），去右上角「设置」里填一下吧 (｡•́︿•̀｡)',
  401: '呜…人家的深海钥匙（API Key）好像不对，去设置里换一把吧 (´･_･`)',
  402: '深海算力余额用完啦…去 DeepSeek 充值一下下嘛',
  403: '这扇门人家推不开（403），可能是 Key 没权限哦',
  429: '问得太快啦，人家的泡泡还没吐完…慢一点点哦',
  network: '信号被洋流卷走了…再说一次好不好？',
  timeout: '人家潜得太深，回应慢了…等一下下再问我一次？',
  empty: '咕噜…这次只吐出了个空泡泡，再说一遍好不好？',
  default: '呜…深海线路打结了，等会儿再来找人家嘛 (｡•́︿•̀｡)',
};

class LlmError extends Error {
  constructor(userMessage, { code = 'unknown', status = 0, retryable = false, detail = '' } = {}) {
    super(detail || userMessage);
    this.name = 'LlmError';
    this.userMessage = userMessage || FRIENDLY.default;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function friendlyForStatus(status, detail = '') {
  if (status === 401) return FRIENDLY[401];
  if (status === 402) return FRIENDLY[402];
  if (status === 403) return FRIENDLY[403];
  if (status === 429) return FRIENDLY[429];
  if (status >= 500) return FRIENDLY.default;
  return FRIENDLY.default;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSseLines(bufferText) {
  const events = [];
  const chunks = bufferText.split(/\r?\n\r?\n/);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const dataLines = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    events.push(dataLines.join('\n'));
  }
  return events;
}

class DeepSeekClient {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.reload();
  }

  /** 设置面板保存后调用，立即生效，无需重启 */
  reload() {
    const rt = resolveRuntime(this.config);
    this.runtime = rt;
    this.provider = rt.provider;
    this.providerLabel = rt.providerLabel;
    this.apiKey = rt.apiKey;
    this.model = rt.model;
    this.baseUrl = rt.baseUrl;
    this.temperature = rt.temperature;
    this.mock = rt.mock;
    this.needsKey = rt.needsKey;
    const ds = this.config.deepseek || {};
    this.frequencyPenalty = Number(ds.frequencyPenalty) || 0;
    this.presencePenalty = Number(ds.presencePenalty) || 0;
    this.maxTokens = ds.maxTokens || 320;
    this.timeoutMs = ds.timeoutMs || 45000;
    return this;
  }

  get isMock() {
    // 本地模型（Ollama 等）不需要 Key；需要 Key 的服务没填 Key 就走演示模式
    return this.mock || (this.needsKey && !this.apiKey);
  }

  /**
   * Key 失效时自动切到另一个存过 Key 的服务商（比如智谱免费档），
   * 免得主人正在聊天时，她只会重复「钥匙不对」。
   */
  switchFallback() {
    try {
      const { loadSettings, saveSettings, PROVIDERS } = require('./config');
      const saved = loadSettings(this.config).keys || {};
      const current = String(this.provider || '');
      const order = ['zhipu', 'deepseek', 'qwen', 'siliconflow'];
      for (const name of order) {
        if (name === current) continue;
        const key = saved[name];
        if (!key) continue;
        const preset = PROVIDERS[name];
        if (!preset) continue;
        saveSettings(this.config, { provider: name, baseUrl: preset.baseUrl, model: preset.model, mock: false, apiKey: key });
        this.reload();
        this.logger && this.logger.warn(`[llm] ${current} 的 Key 失效，自动切到备用：${this.providerLabel}`);
        return { from: current, to: this.provider, label: this.providerLabel };
      }
    } catch (err) {
      this.logger && this.logger.warn('[llm] 切换备用服务商失败：' + err.message);
    }
    return null;
  }

  endpoint() {
    const base = String(this.baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
  }

  describe() {
    return {
      mock: this.isMock,
      provider: this.provider,
      providerLabel: this.providerLabel,
      needsKey: this.needsKey,
      model: this.model,
      baseUrl: this.baseUrl,
      keyMasked: maskKey(this.apiKey),
      temperature: this.temperature,
    };
  }

  buildPayload({ system, turns = [], stream = false, maxTokens, thinking, maxOutputTokens, temperature }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const t of turns) {
      if (!t || !t.content) continue;
      const role = t.role === 'assistant' ? 'assistant' : t.role === 'system' ? 'system' : 'user';
      messages.push({ role, content: t.content });
    }
    const payload = {
      model: this.model,
      messages,
      stream,
      temperature: (() => {
        const requested=temperature===undefined?Number(this.temperature):Number(temperature);
        let t = Math.max(0, Math.min(2, Number.isFinite(requested)?requested:1.2));
        // 智谱 GLM 的 temperature 只接受 0~1
        if (this.provider === 'zhipu') t = Math.min(t, 0.99);
        return t;
      })(),
      max_tokens: Number.isFinite(maxOutputTokens) ? Math.max(1,Math.min(1200,maxOutputTokens)) : Math.min(Number(maxTokens) || this.maxTokens, this.maxTokens),
    };
    if (thinking === false && this.provider === 'deepseek') payload.thinking = {type: 'disabled'};
    if (this.frequencyPenalty) payload.frequency_penalty = this.frequencyPenalty;
    if (this.presencePenalty) payload.presence_penalty = this.presencePenalty;
    return payload;
  }

  _open(payload, { signal, stream, purpose = 'chat' }) {
    if (this.isMock) throw new LlmError(FRIENDLY.nokey, { code: 'nokey' });
    let url;
    try {
      url = new URL(this.endpoint());
    } catch {
      throw new LlmError(FRIENDLY.default, { code: 'bad_url', detail: 'invalid baseUrl: ' + this.baseUrl });
    }
    const mod = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Accept: stream ? 'text/event-stream' : 'application/json',
    };
    // 本地模型（Ollama / LM Studio 等）通常不需要 Key，别带空的 Authorization
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: url.pathname + url.search,
          method: 'POST',
          headers,
        },
        (res) => resolve({ req, res })
      );
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new LlmError(FRIENDLY.timeout, { code: 'timeout', detail: 'request timeout' }));
      });
      req.on('error', (err) => {
        if (err instanceof LlmError) return reject(err);
        const localHint =
          this.runtime && this.runtime.isLocal
            ? '连不上本地模型…Ollama 启动了吗？（命令行运行 ollama serve）'
            : FRIENDLY.network;
        reject(
          new LlmError(localHint, {
            code: 'network',
            retryable: true,
            detail: `${err.code || ''} ${err.message}`.trim(),
          })
        );
      });
      if (signal) {
        if (signal.aborted) {
          req.destroy(new LlmError('aborted', { code: 'aborted' }));
        } else {
          signal.addEventListener('abort', () => req.destroy(new LlmError('aborted', { code: 'aborted' })), { once: true });
        }
      }
      // 核对实际发出的请求，不记录提示词、聊天原文、身份 ID 或 Key。
      if (this.logger && typeof this.logger.info === 'function') {
        const system = payload.messages.filter((message) => message.role === 'system').map((message) => String(message.content || '')).join('\n');
        const mode = this.config.persona && this.config.persona.promptMode || 'legacy';
        const metadata = {
          mode,
          purpose,
          learnedStyleRules: (system.match(/"表达要求":/g)||[]).length,
          systemChars: system.length,
          systemHash: createHash('sha256').update(system).digest('hex').slice(0, 12),
          historyMessages: payload.messages.filter((message) => message.role !== 'system').length,
          assistantMessages: payload.messages.filter((message) => message.role === 'assistant').length,
          styleBoundary: Number(this.config.persona && this.config.persona.historyStyleChangedAt) || 0,
        };
        try {
          const recall = system.match(/【共同记忆检索结果】(\{[^\n]+\})/);
          if (recall) {const details=JSON.parse(recall[1]);Object.assign(metadata,{memoryFragments:details.fragments,memorySources:details.sources,memoryOwnReplies:details.assistantStatements,memoryOtherSpeakers:details.otherSpeakers});}
        } catch {}
        req.once('finish', () => this.logger.info('模型请求提示词核对：' + JSON.stringify(metadata)));
      }
      req.end(body);
    });
  }

  async _readAll(res) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) > 1024 * 1024) {
          res.destroy();
          reject(new LlmError(FRIENDLY.default, { code: 'too_large', detail: 'response too large' }));
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', (err) =>
        reject(new LlmError(FRIENDLY.network, { code: 'network', detail: 'response error: ' + err.message, retryable: true }))
      );
    });
  }

  async _errorFrom(res) {
    let text = '';
    try {
      text = await this._readAll(res);
    } catch {
      /* ignore */
    }
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || text;
    } catch {
      /* ignore */
    }
    return new LlmError(friendlyForStatus(res.statusCode, detail), {
      code: 'http_' + res.statusCode,
      status: res.statusCode,
      detail: `HTTP ${res.statusCode}: ${String(detail).slice(0, 300)}`,
      retryable: res.statusCode === 429 || res.statusCode >= 500,
    });
  }

  /** 非流式，返回完整文本 */
  async complete({ system, turns, maxTokens, thinking, signal, maxOutputTokens, purpose, temperature }) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const payload = this.buildPayload({ system, turns, stream: false, maxTokens, thinking, maxOutputTokens, temperature });
        const { res } = await this._open(payload, { stream: false, signal, purpose });
        if (res.statusCode !== 200) throw await this._errorFrom(res);
        const raw = await this._readAll(res);
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new LlmError(FRIENDLY.empty, { code: 'bad_json', detail: 'invalid json: ' + raw.slice(0, 200) });
        }
        const text = json?.choices?.[0]?.message?.content;
        if (!text || !String(text).trim()) throw new LlmError(FRIENDLY.empty, { code: 'empty' });
        this.logger &&
          this.logger.debug(
            `DeepSeek 完成：${payload.messages.length} 条消息，输出 ${String(text).length} 字`
          );
        return String(text).trim();
      } catch (err) {
        lastErr = err;
        const llmErr = err instanceof LlmError ? err : new LlmError(FRIENDLY.default, { detail: String(err && err.message) });
        if (!llmErr.retryable || attempt === 1 || llmErr.code === 'aborted') throw llmErr;
        await sleep(700);
      }
    }
    throw lastErr;
  }

  /**
   * 测试当前配置能不能连上、模型能不能回话。给设置面板的「测试连接」用。
   * @returns {Promise<{ok: boolean, provider: string, model: string, ms: number, sample?: string, message?: string}>}
   */
  async probe() {
    const started = Date.now();
    const base = {
      provider: this.provider,
      providerLabel: this.providerLabel,
      model: this.model,
      baseUrl: this.baseUrl,
      ms: 0,
    };
    if (this.isMock) {
      return { ...base, ok: false, ms: Date.now() - started, message: FRIENDLY.nokey };
    }
    try {
      const sample = await this.complete({
        system: '你是连接测试助手。',
        turns: [{ role: 'user', content: '只回复两个字：咕噜' }],
        maxTokens: 32,
      });
      return { ...base, ok: true, ms: Date.now() - started, sample: String(sample).slice(0, 60) };
    } catch (err) {
      const message =
        err instanceof LlmError ? err.userMessage : '呜…连接测试失败：' + (err && err.message ? err.message : String(err));
      // 把原始错误也带出来，方便判断是额度、Key 还是网络
      const detail = (err && (err.detail || err.message)) || '';
      return { ...base, ok: false, ms: Date.now() - started, message, detail: String(detail).slice(0, 300) };
    }
  }

  /**
   * 流式，异步生成器，每次 yield 一段新增文本。
   */
  async *stream({ system, turns, signal }) {
    const payload = this.buildPayload({ system, turns, stream: true });
    const { req, res } = await this._open(payload, { signal, stream: true });
    if (res.statusCode !== 200) throw await this._errorFrom(res);
    res.setEncoding('utf8');
    let buffer = '';
    let sent = 0;
    try {
      for await (const chunk of res) {
        buffer += chunk;
        const events = parseSseLines(buffer);
        if (!events.length) continue;
        // 保留最后一个不完整片段
        const lastBreak = Math.max(buffer.lastIndexOf('\n\n'), buffer.lastIndexOf('\r\n\r\n'));
        buffer = lastBreak >= 0 ? buffer.slice(lastBreak).replace(/^\r?\n\r?\n/, '') : buffer;
        for (const data of events) {
          if (data === '[DONE]') {
            this.logger && this.logger.debug(`DeepSeek 流式结束：${sent} 字`);
            return;
          }
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          if (json?.error) {
            throw new LlmError(FRIENDLY.default, { code: 'stream_error', detail: String(json.error.message || '') });
          }
          const delta = json?.choices?.[0]?.delta;
          const piece = delta?.content;
          if (piece) {
            sent += piece.length;
            yield piece;
          }
        }
      }
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (signal && signal.aborted) return;
      throw new LlmError(FRIENDLY.network, { code: 'network', detail: 'stream error: ' + (err && err.message) });
    } finally {
      try { req.destroy(); } catch { /* ignore */ }
      try { res.destroy(); } catch { /* ignore */ }
    }
    if (!sent) throw new LlmError(FRIENDLY.empty, { code: 'empty' });
  }
}

module.exports = { DeepSeekClient, LlmError, FRIENDLY, parseSseLines, friendlyForStatus };
