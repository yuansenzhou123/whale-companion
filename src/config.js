'use strict';

/**
 * 配置加载：默认值 <- config.json <- 环境变量；用户面板设置保存在 data/settings.json。
 * 全部使用同步读取，启动时一次性完成，之后不再读盘。
 *
 * 模型服务是「可插拔」的：任何 OpenAI 兼容接口都能用（DeepSeek / 智谱 / 硅基流动 /
 * 通义千问 / 本地 Ollama / 你自己的服务）。配置见 PROVIDERS。
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 模型服务预设。needsKey 表示必须填 API Key；本地地址（localhost/内网）会自动免 Key。
 * 新增服务只要往这里加一项。
 */
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek 官方（效果最好，按量付费）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    needsKey: true,
    hint: '在 platform.deepseek.com 创建 Key，几块钱能用很久',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  zhipu: {
    label: '智谱 GLM-4-Flash（免费）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    needsKey: true,
    hint: '去 bigmodel.cn 注册拿 Key，GLM-4-Flash 免费，中文效果不错',
    models: ['glm-4-flash', 'glm-4-flash-250414', 'glm-4-air', 'glm-4-plus'],
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow（有免费额度）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    needsKey: true,
    hint: '注册送额度，Qwen 等开源模型都有；模型名里带斜杠',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-14B-Instruct', 'THUDM/glm-4-9b-chat', 'deepseek-ai/DeepSeek-V3'],
  },
  qwen: {
    label: '通义千问 DashScope（有免费额度）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-turbo',
    needsKey: true,
    hint: '阿里云百炼开通后拿 Key，qwen-turbo 有免费额度',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-plus-latest', 'qwen-max-latest', 'qwen3-max'],
  },
  tju: {
    label: '天津大学 智能体广场（仅校内网）',
    baseUrl: 'https://ai.tju.edu.cn/api/v3',
    model: 'tju-llm',
    needsKey: true,
    hint: '需要校园网 / 学校 VPN；Base URL 为 https://ai.tju.edu.cn/api/v3，模型名 tju-llm',
    models: ['tju-llm'],
  },
  ollama: {
    label: '本地 Ollama（完全免费、可离线）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    hint: '装 Ollama 后跑 ollama pull qwen2.5:7b；数据不出本机，不用 Key',
    models: ['qwen2.5:7b', 'qwen2.5:14b', 'qwen3:8b', 'deepseek-r1:7b', 'glm4:9b', 'llama3.1:8b'],
  },
  custom: {
    label: '自定义（任意 OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
    needsKey: true,
    hint: '填接口地址和模型名；本地/内网地址可以不填 Key',
    models: [],
  },
};

const DEFAULT_CONFIG = {
  provider: 'deepseek',
  server: { host: '127.0.0.1', port: 8787, openBrowser: true },
  actions:{enabled:false,groupText:true,moments:true,momentMedia:{source:'none'}},
  agent:{enabled:false,autonomousMoments:false,startHour:10,endHour:22,dailyLimit:1,decisionIntervalMinutes:20,idleMinutes:15},
  deepseek: {
    provider: 'deepseek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 1.15,
    frequencyPenalty: 0.35,
    presencePenalty: 0.25,
    maxTokens: 320,
    timeoutMs: 45000,
  },
  persona: {
    name: '鲸鲸',
    age: 23,
    job: '自由职业',
    appearance: '深蓝色长卷发，头发上别着一枚鲸尾发夹，常穿深蓝色水手领裙子，怀里或包里总有一只软乎乎的蓝鲸玩偶（你叫它小蓝鲸）。',
    personality: '温柔但有点小倔，嘴硬心软，慢热；熟了话很多，会害羞、会怼人、会犯懒、偶尔 emo。',
    background: '因为头像和玩偶全是鲸鱼，朋友开玩笑叫你「鲸鱼娘」，你也就认了。',
    aliases: ['鲸鲸', '小鲸娘', '鲸娘', '深鲸娘', '鲸鱼娘', '小鲸'],
    ownerName: '主人',
    // 主人名单：填你自己的昵称 / wxid，谁填谁就是主人（留空 = 没有主人）
    master: {
      names: [],
      wxids: [],
    },
    // 主人骂她时能不能还嘴（默认关：只许委屈不许骂回去）
    masterRoast: false,
  },
  chat: { privateMaxChars: 140, groupMaxChars: 70, historyTurns: 200, groupHistoryTurns: 150, maxBubbles: 2, discussionMaxChars: 600, emojiChance: 0 },
  // 别人发链接时，读一下标题/摘要/文章正文（视频只读得到文案）
  links: { enabled: true, timeoutMs: 6000, cacheMinutes: 60 },
  // 魔咒：主人私聊/群里输入这段数字后，获得一段时间的「管理员权限」
  admin: { spell: '', minutes: 30, allowAll: false },
  // 图片理解：默认智谱 GLM-4V-Flash（免费）
  vision: { apiKey: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v-flash', timeoutMs: 30000 },
  // 语音识别：默认阿里云百炼 qwen3-asr-flash，apiKey 留空则用 settings.json / deepseek.apiKey
  voice: {
    enabled: true,
    apiKey: '',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    model: 'qwen3-asr-flash',
    timeoutMs: 90000,
    maxSeconds: 120,
  },
  // 主动分享视频
  share: { enabled: true, everyMinutes: 120, sources: ['bilibili'], allowedChats: [] },
  // 微信桥接空闲轮询；只主动联系已有私聊记录、按 wxid 认证的主人。
  proactiveChat: { enabled: false, idleMinutes: 60, dailyLimit: 3, startHour: 9, endHour: 22 },
  group: {
    requireAt: true,
    freeChat: false,
    freeChatChance: 0.06,
    cooldownSec: 0,
    masterAlwaysReply: true,
    engagedMinutes: 6,
    silentMinutes: 10,
    maxRepliesPerHour: 1000,
    muteDefaultMinutes: 30,
  },
  memory: { maxSessions: 200, maxMessages: 400, maxNotesPerUser: 6 },
  gateway: {
    wechat: { enabled: false, inboundToken: 'change-me-wechat', outboundUrl: '', outboundHeaders: {} },
    douyin: { enabled: false, inboundToken: 'change-me-douyin', outboundUrl: '', outboundHeaders: {} },
  },
  log: { level: 'info' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(extra)) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (k.startsWith('_')) continue; // 以 _ 开头的是说明字段，忽略
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function projectRoot(from = __dirname) {
  return path.resolve(from, '..');
}

/** 本机或内网地址（这类服务通常不需要 API Key，比如 Ollama、LM Studio） */
function isLocalUrl(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!/^https?:\/\//.test(s)) return false;
  return /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(s) ||
    /\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:|\/|$)/.test(s);
}

/**
 * @param {{root?: string, env?: NodeJS.ProcessEnv}} options
 */
function loadConfig({ root = projectRoot(), env = process.env } = {}) {
  const configPath = path.join(root, 'config.json');
  const configExists = fs.existsSync(configPath);
  const fromFile = configExists ? readJson(configPath, {}) : {};
  const cfg = deepMerge(DEFAULT_CONFIG, fromFile);
  cfg.server.port = Number(env.PORT || cfg.server.port) || 8787;
  cfg.server.host = env.HOST || cfg.server.host;
  if (env.DEEPSEEK_MODEL) cfg.deepseek.model = env.DEEPSEEK_MODEL;
  if (env.DEEPSEEK_BASE_URL) cfg.deepseek.baseUrl = env.DEEPSEEK_BASE_URL;
  if (env.LLM_PROVIDER) cfg.provider = env.LLM_PROVIDER;
  return {
    ...cfg,
    root,
    paths: {
      root,
      dataDir: path.join(root, 'data'),
      configFile: configPath,
      settingsFile: path.join(root, 'data', 'settings.json'),
      storeFile: path.join(root, 'data', 'store.json'),
      logFile: path.join(root, 'data', 'whale.log'),
      webDir: path.join(root, 'web'),
    },
    env,
    configExists,
  };
}

/** 首次运行时生成 config.json，方便用户直接编辑 */
function ensureConfigFile(root = projectRoot()) {
  const target = path.join(root, 'config.json');
  if (fs.existsSync(target)) return target;
  const example = path.join(root, 'config.example.json');
  if (fs.existsSync(example)) fs.copyFileSync(example, target);
  return target;
}

function loadSettings(cfg) {
  return readJson(cfg.paths.settingsFile, {}) || {};
}

function saveSettings(cfg, patch) {
  const current = loadSettings(cfg);
  const next = { ...current, ...patch };
  // 每个服务商各存一把 Key，切换服务商时自动取对应那把，避免把智谱的 Key 拿去打 DeepSeek
  // patch 里显式带的 keys 也要合进来，否则一次 saveSettings 就把别的服务商的 Key 丢了，
  // 切换备用服务商时找不到能用的 Key
  const keys = { ...(current.keys || {}) };
  for (const [name, value] of Object.entries((patch && patch.keys) || {})) {
    if (name && value) keys[name] = String(value).trim();
  }
  const providerName = String(next.provider || current.provider || '').trim();
  if (patch && patch.apiKey) {
    next.apiKey = String(patch.apiKey).trim();
    if (providerName) keys[providerName] = next.apiKey;
  } else if (providerName && providerName !== String(current.provider || '').trim()) {
    next.apiKey = keys[providerName] || '';
  }
  if (Object.keys(keys).length) next.keys = keys;
  fs.mkdirSync(cfg.paths.dataDir, { recursive: true });
  fs.writeFileSync(cfg.paths.settingsFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 计算最终生效的运行参数：面板设置 > config.json > 环境变量 > 服务预设。
 */
function resolveRuntime(cfg) {
  const settings = loadSettings(cfg);
  const legacy = cfg.deepseek || {};
  const llmCfg = cfg.llm || {};
  const provider = String(settings.provider || cfg.provider || legacy.provider || 'deepseek');
  const preset = PROVIDERS[provider] || PROVIDERS.custom;
  const envKey = (cfg.env && cfg.env.DEEPSEEK_API_KEY) || '';
  const apiKey = (settings.apiKey || llmCfg.apiKey || legacy.apiKey || envKey || '').trim();
  // 只有 provider 确实是 deepseek 时，才沿用 deepseek 段里的地址/模型
  const legacyRelevant = provider === 'deepseek';
  const baseUrl = String(
    settings.baseUrl || llmCfg.baseUrl || (legacyRelevant ? legacy.baseUrl : '') || preset.baseUrl || ''
  ).trim();
  const model = String(
    settings.model || llmCfg.model || (legacyRelevant ? legacy.model : '') || preset.model || ''
  ).trim();
  const temperature =
    typeof settings.temperature === 'number'
      ? settings.temperature
      : typeof legacy.temperature === 'number'
        ? legacy.temperature
        : 1.2;
  const local = isLocalUrl(baseUrl);
  const needsKey = provider === 'ollama' ? false : preset.needsKey && !local;
  const explicitMock = typeof settings.mock === 'boolean' ? settings.mock : null;
  const mock = explicitMock === null ? !apiKey && needsKey : explicitMock;
  return {
    settings,
    provider,
    preset,
    providerLabel: preset.label,
    apiKey,
    baseUrl,
    model,
    temperature,
    mock,
    needsKey,
    isLocal: local,
  };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return key.slice(0, 2) + '****';
  return `${key.slice(0, 5)}****${key.slice(-4)}`;
}

module.exports = {
  DEFAULT_CONFIG,
  PROVIDERS,
  isLocalUrl,
  loadConfig,
  ensureConfigFile,
  loadSettings,
  saveSettings,
  resolveRuntime,
  maskKey,
  deepMerge,
  readJson,
  projectRoot,
};
