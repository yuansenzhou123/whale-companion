'use strict';

/**
 * 主人通过微信「魔咒」调整的人设/能力，持久化在 data/persona.json。
 * 启动时合并进 config，改完立即生效，重启也保留。
 */
const fs = require('node:fs');
const path = require('node:path');
const { normalizeOptions } = require('./proactive');

const FILE_NAME = 'persona.json';

function fileFor(config) {
  try {
    return path.join(config.paths.dataDir, FILE_NAME);
  } catch {
    return '';
  }
}

function load(config) {
  const file = fileFor(config);
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return {};
  }
}

function save(config, patch) {
  const file = fileFor(config);
  // 以当前生效值为底，避免“只改了一半”把别的设置冲掉（也兼容没有写文件权限的环境）
  const base = {
    preset: config.persona && config.persona.stylePreset,
    text: config.persona && config.persona.styleText,
    emoji: config.persona && config.persona.emojiLevel,
    privateMaxChars: config.chat && config.chat.privateMaxChars,
    groupMaxChars: config.chat && config.chat.groupMaxChars,
    links: config.links ? config.links.enabled !== false : undefined,
    freeChat: config.group ? Boolean(config.group.freeChat) : undefined,
    mutedGroups: config.group && Array.isArray(config.group.mutedGroups) ? config.group.mutedGroups : undefined,
    historyTurns: config.chat ? config.chat.historyTurns : undefined,
    groupHistoryTurns: config.chat ? config.chat.groupHistoryTurns : undefined,
    emotions: config.persona ? config.persona.emotions !== false : undefined,
    proactive: config.persona ? config.persona.proactive !== false : undefined,
    proactiveChat: config.proactiveChat && config.proactiveChat.enabled,
    proactiveIdleMinutes: config.proactiveChat && config.proactiveChat.idleMinutes,
    proactiveDailyLimit: config.proactiveChat && config.proactiveChat.dailyLimit,
    proactiveStartHour: config.proactiveChat && config.proactiveChat.startHour,
    proactiveEndHour: config.proactiveChat && config.proactiveChat.endHour,
    opinions: config.persona ? config.persona.opinions !== false : undefined,
    masterRoast: config.persona ? Boolean(config.persona.masterRoast) : undefined,
    name: config.persona ? config.persona.name : undefined,
    age: config.persona ? config.persona.age : undefined,
    job: config.persona ? config.persona.job : undefined,
    appearance: config.persona ? config.persona.appearance : undefined,
    personality: config.persona ? config.persona.personality : undefined,
    background: config.persona ? config.persona.background : undefined,
    customPrompt: config.persona ? config.persona.customPrompt : undefined,
    promptMode: config.persona && config.persona.promptMode || 'legacy',
    historyStyleChangedAt: config.persona && config.persona.historyStyleChangedAt,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  const previous = { ...base, ...load(config) };
  const next = { ...previous, ...patch };
  // 仅角色/语气实际改变时切换历史风格边界；重复保存、改模型或聊天频率不重置。
  const styleFields = ['promptMode', 'preset', 'text', 'emoji', 'name', 'age', 'job', 'appearance', 'personality', 'background', 'customPrompt', 'emotions', 'proactive', 'opinions', 'masterRoast'];
  if (styleFields.some((key) => String(previous[key] ?? '') !== String(next[key] ?? ''))) {
    next.historyStyleChangedAt = Date.now();
  }
  // 清掉空值，保持文件干净
  for (const [k, v] of Object.entries(next)) {
    if ((v === '' && k !== 'customPrompt') || v === null || v === undefined) delete next[k];
  }
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    } catch {
      /* 测试环境可能没有目录权限，忽略 */
    }
  }
  apply(config, next);
  return next;
}

const DEFAULTS = {
  promptMode: 'legacy',
  customPrompt: '',
  preset: '',
  text: '',
  emoji: '正常',
  privateMaxChars: 140,
  groupMaxChars: 70,
  historyTurns: 200,
  groupHistoryTurns: 150,
  links: true,
  freeChat: false,
  mutedGroups: [],
  emotions: true,
  proactive: true,
  proactiveChat: false,
  proactiveIdleMinutes: 60,
  proactiveDailyLimit: 3,
  proactiveStartHour: 9,
  proactiveEndHour: 22,
  opinions: true,
  name: '鲸鲸',
  age: 23,
  job: '自由职业',
  appearance: '深蓝色长卷发，头发上别着一枚鲸尾发夹，常穿深蓝色水手领裙子，怀里或包里总有一只软乎乎的蓝鲸玩偶（你叫它小蓝鲸）。',
  personality: '温柔但有点小倔，嘴硬心软，慢热；熟了话很多，会害羞、会怼人、会犯懒、偶尔 emo。',
  background: '因为头像和玩偶全是鲸鱼，朋友开玩笑叫你「鲸鱼娘」，你也就认了。',
};

function clear(config) {
  const file = fileFor(config);
  if (file) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  // 默认人设也需要持久化风格边界，重启后不重新模仿清除前的人设。
  save(config, { ...DEFAULTS, historyStyleChangedAt: Date.now() });
  return {};
}

/** 把存档合并进 config（提示词 / 长度 / 能力开关都从这里读） */
function apply(config, data) {
  data = data || {};
  if (!config.persona) config.persona = {};
  config.persona.stylePreset = data.preset || '';
  config.persona.promptMode = ['compact','full'].includes(data.promptMode) ? data.promptMode : 'legacy';
  config.persona.styleText = data.text || '';
  config.persona.historyStyleChangedAt = Math.max(0, Number(data.historyStyleChangedAt) || 0);
  config.persona.emojiLevel = data.emoji || '';

  if (!config.chat) config.chat = {};
  config.chat.privateMaxChars = Number(data.privateMaxChars) || 140;
  config.chat.groupMaxChars = Number(data.groupMaxChars) || 70;

  if (!config.links) config.links = {};
  config.links.enabled = data.links === undefined ? true : Boolean(data.links);

  if (!config.group) config.group = {};
  if (data.freeChat !== undefined) config.group.freeChat = Boolean(data.freeChat);
  config.group.mutedGroups = Array.isArray(data.mutedGroups) ? data.mutedGroups.slice() : [];
  const ht = Number(data.historyTurns);
  config.chat.historyTurns = ht > 0 ? Math.max(4, Math.min(400, ht)) : 200;
  const ght = Number(data.groupHistoryTurns);
  config.chat.groupHistoryTurns = ght > 0 ? Math.max(2, Math.min(300, ght)) : 150;
  // 保存条数必须覆盖模型窗口及本轮输入/回复，避免面板设了 100 实际只剩 40。
  if (!config.memory) config.memory = {};
  config.memory.maxMessages = Math.min(500, Math.max(Number(config.memory.maxMessages) || 160, config.chat.historyTurns + 2, config.chat.groupHistoryTurns + 2));
  config.persona.emotions = data.emotions !== false;
  // 主人被骂时她能不能还嘴（默认关；开了就允许毒舌互怼，但不许真脏字）
  if (data.masterRoast !== undefined) config.persona.masterRoast = Boolean(data.masterRoast);
  config.persona.proactive = data.proactive !== false;
  const proactive = config.proactiveChat || {};
  config.proactiveChat = normalizeOptions({
    enabled: data.proactiveChat === undefined ? proactive.enabled : Boolean(data.proactiveChat),
    idleMinutes: data.proactiveIdleMinutes ?? proactive.idleMinutes,
    dailyLimit: data.proactiveDailyLimit ?? proactive.dailyLimit,
    startHour: data.proactiveStartHour ?? proactive.startHour,
    endHour: data.proactiveEndHour ?? proactive.endHour,
  });
  config.persona.opinions = data.opinions !== false;
  for (const k of ['name', 'job', 'appearance', 'personality', 'background']) {
    if (data[k] !== undefined) config.persona[k] = String(data[k] || '');
  }
  if (data.age !== undefined) config.persona.age = Number(data.age) || 23;
  if (data.customPrompt !== undefined) config.persona.customPrompt = String(data.customPrompt || '');
  return config;
}

function summary(config) {
  return {
    preset: config.persona.stylePreset || '',
    text: config.persona.styleText || '',
    emoji: config.persona.emojiLevel || '正常',
    privateMaxChars: config.chat.privateMaxChars,
    groupMaxChars: config.chat.groupMaxChars,
    links: config.links.enabled !== false,
    freeChat: Boolean(config.group.freeChat),
    mutedGroups: Array.isArray(config.group.mutedGroups) ? config.group.mutedGroups.slice() : [],
    historyTurns: config.chat.historyTurns,
    groupHistoryTurns: config.chat.groupHistoryTurns,
    emotions: config.persona.emotions !== false,
    proactive: config.persona.proactive !== false,
    proactiveChat: Boolean(config.proactiveChat && config.proactiveChat.enabled),
    proactiveIdleMinutes: (config.proactiveChat && config.proactiveChat.idleMinutes) || 60,
    proactiveDailyLimit: (config.proactiveChat && config.proactiveChat.dailyLimit) || 3,
    proactiveStartHour: config.proactiveChat ? config.proactiveChat.startHour : 9,
    proactiveEndHour: config.proactiveChat ? config.proactiveChat.endHour : 22,
    opinions: config.persona.opinions !== false,
    masterRoast: Boolean(config.persona.masterRoast),
    name: config.persona.name,
    age: config.persona.age,
    job: config.persona.job,
    appearance: config.persona.appearance,
    personality: config.persona.personality,
    background: config.persona.background,
    customPrompt: config.persona.customPrompt || '',
    promptMode: config.persona.promptMode || 'legacy',
  };
}

module.exports = { load, save, clear, apply, summary };
