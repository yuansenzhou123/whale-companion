'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const persona = require('./persona');
const { matchMaster } = require('./master');

function normalizeOptions(options = {}) {
  options = options && typeof options === 'object' ? options : {};
  const number = (value, min, max, fallback) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;
  return {
    enabled: options.enabled === true,
    idleMinutes: number(options.idleMinutes, 15, 1440, 60),
    dailyLimit: number(options.dailyLimit, 1, 10, 3),
    startHour: number(options.startHour, 0, 23, 9),
    endHour: number(options.endHour, 1, 24, 22),
  };
}

function beijingTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** 桥接空闲时领取一条消息，真实发送成功后才写入聊天记录。 */
class ProactiveChat {
  constructor({ config, store, bot, llm, companion = null, relationship = null, now = () => new Date() }) {
    Object.assign(this, { config, store, bot, llm, companion, relationship, now });
    this.busy = false;
  }

  available(now) {
    const options = normalizeOptions(this.config.proactiveChat);
    if (!options.enabled || this.config.persona.proactive === false || !this.config.gateway.wechat.enabled) return false;
    const { hour } = beijingTime(now);
    const inHours = options.startHour < options.endHour
      ? hour >= options.startHour && hour < options.endHour
      : options.startHour > options.endHour && (hour >= options.startHour || hour < options.endHour);
    if (!inHours) return false;
    const dir = this.config.paths && this.config.paths.dataDir;
    if (dir) {
      if (fs.existsSync(path.join(dir, 'PAUSED'))) return false;
      try {
        const away = JSON.parse(fs.readFileSync(path.join(dir, 'away.json'), 'utf8'));
        if (Number(away.until) > now.getTime()) return false;
      } catch { /* 没有休息标记时正常判断。 */ }
    }
    return true;
  }

  candidate(now) {
    if (!this.available(now)) return null;
    const options = normalizeOptions(this.config.proactiveChat);
    const time = now.getTime();
    const { day } = beijingTime(now);
    // 每个已认证主人每天的上限跨会话累计，不能靠换会话绕过。
    const counts = new Map();
    for (const session of this.store.sessions.values()) {
      const state = session.state.proactiveChat;
      if (state && state.day === day) counts.set(session.chatId, (counts.get(session.chatId) || 0) + (Number(state.count) || 0));
    }
    const candidates = [];
    for (const session of this.store.sessions.values()) {
      if (session.platform !== 'wechat' || session.chatType !== 'private' || session.chatId.endsWith('@chatroom')) continue;
      const user = [...session.messages].reverse().find((entry) => entry.role === 'user' && !entry.error);
      if (!user || user.uid !== session.chatId) continue;
      const identity = matchMaster(this.config, { platform: 'wechat', senderId: user.uid, senderName: user.name });
      if (identity.reason !== 'wxid') continue;
      if (this.relationship?.suppressed(session.chatId)) continue;
      const state = session.state.proactiveChat || {};
      if (Number(session.state.mutedUntil) > time || Number(session.state.silentUntil) > time) continue;
      if (state.awaiting && Number(user.ts) <= Number(state.userTs)) continue;
      if ((counts.get(session.chatId) || 0) >= options.dailyLimit) continue;
      const lastActivity = Math.max(Number(session.lastActiveAt) || 0, Number(state.lastAttemptAt) || 0);
      if (time - lastActivity < options.idleMinutes * 60000) continue;
      candidates.push({ session, user });
    }
    return candidates.sort((a, b) => b.session.lastActiveAt - a.session.lastActiveAt)[0] || null;
  }

  dateCandidate(now) {
    if(!this.relationship||!this.available(now))return null;
    const {day}=beijingTime(now),options=normalizeOptions(this.config.proactiveChat),time=now.getTime();
    for(const session of this.store.sessions.values()) {
      if(session.platform!=='wechat'||session.chatType!=='private'||!this.relationship.ownerIds().includes(session.chatId))continue;
      const user=[...session.messages].reverse().find(m=>m.role==='user'&&!m.error);
      if(!user||user.uid!==session.chatId||matchMaster(this.config,{platform:'wechat',senderId:user.uid,senderName:user.name}).reason!=='wxid')continue;
      const state=session.state.proactiveChat||{};
      const count=[...this.store.sessions.values()].filter(s=>s.chatId===session.chatId&&s.state.proactiveChat?.day===day).reduce((n,s)=>n+(Number(s.state.proactiveChat.count)||0),0);
      if(count>=options.dailyLimit||state.pending||(state.awaiting&&user.ts<=state.userTs)||session.state.mutedUntil>time||session.state.silentUntil>time)continue;
      const reason=this.relationship.flow.eventFor(session);
      if(reason)return {session,user,reason};
    }
    return null;
  }

  async next() {
    if (this.busy) return { ok: true, message: null };
    this.busy = true;
    try {
      const now = this.now();
      const candidate = this.dateCandidate(now) || this.candidate(now);
      if (!candidate) return { ok: true, message: null };
      const { session, user } = candidate;
      const watchFollowup = !candidate.reason && this.companion && this.companion.followUpFor(session);
      let relationshipReason = candidate.reason || (this.relationship && this.relationship.reasonFor(session));
      // A due concern or completed date takes precedence; otherwise prefer real viewing evidence.
      if (watchFollowup && relationshipReason?.kind === 'history') relationshipReason = null;
      if ((!relationshipReason && !watchFollowup) || relationshipReason?.kind==='history') {
        const invitation=this.relationship?.flow.invitationFor(session);
        if(invitation&&!watchFollowup)relationshipReason=invitation;
      }
      if (this.relationship?.onlyGrounded(session.chatId) && !relationshipReason && !watchFollowup) return {ok:true,message:null};
      const priorActivity = session.lastActiveAt;
      const previous = session.state.proactiveChat || {};
      session.state.proactiveChat = { ...previous, lastAttemptAt: now.getTime() };
      this.persist();
      const msg = {
        platform: 'wechat', chatId: session.chatId, chatType: 'private', senderId: user.uid,
        senderName: user.name, isMaster: true, text: '', model: this.llm.model,
      };
      const profile = session.profiles[user.uid];
      let system = persona.buildSystem({ config: this.config, msg, profile, notes: profile ? profile.notes : [], now })
        + '\n\n【现在由你主动找主人聊天】当前没有新的用户消息，不要假装主人刚刚问了问题。'
        + '\n- 根据最近的私聊和记得的小事，自然开启一个轻松话题，可以接着上次没聊完的事情，也可以分享一个不涉及外部事实的小想法。'
        + '\n- 一到两句，最多 80 字，最多问一个轻松的问题。不问在吗、不催回复、不抱怨主人不理你、不制造愧疚或紧急感。'
        + '\n- 不编造主人今天做过的事、约定、见闻或实时新闻。没有合适的上下文就轻轻问候，不强行装熟或硬塞鲸鱼口癖。'
        + '\n- 避开最近已经说过的开场和问题，不继续争吵，也不要逐字重复历史。只输出准备发送的正文。';
      if (this.relationship) system += this.relationship.contextFor(msg);
      if (this.bot.styleLearning) system += this.bot.styleLearning.contextFor(msg);
      if (this.bot.sharedMemory) system += this.bot.sharedMemory.contextFor({...msg,text:relationshipReason?.text||''});
      if (relationshipReason) system += '\n【本次主动开口的具体由头】'+relationshipReason.text;
      if (watchFollowup && !relationshipReason) system += watchFollowup.context + '\n这次优先从实际共同看过的一个细节自然开口，不做视频总结，不假装主人又发了新消息。';
      const forgotten=this.relationship?.profile(session.chatId).forgottenTopics||[];
      const history = session.messages.filter(m=>!forgotten.some(topic=>m.text?.includes(topic))).slice(-20);
      const turns = this.bot.buildTurns(msg, history);
      turns.push({ role: 'user', content: relationshipReason?.kind==='dateEvent'
        ? '【约会阶段事件】主人没有刚刚发来新消息。请按本阶段要求，只输出一小句'+(relationshipReason.phase==='closing'?'收尾道别。':'自然接话，不重新发出约会邀请。')
        : '【自动事件】主人没有发来新消息。现在请主动开启一段轻松的私聊，只输出你的开场。' });
      let text = relationshipReason?.plainText || (this.llm.isMock
        ? relationshipReason?.fallbackText || ['想来找你聊两句啦，今天有没有一件让你开心的小事呀', '忽然想听你分享一首最近喜欢的歌，给我推荐一首嘛', '路过来打个招呼，今天想聊点什么轻松的呀'][Number(previous.count || 0) % 3]
        : await this.llm.complete({ system, turns, maxTokens: 180 }));
      // 模型生成期间主人可能回来了、关了开关或进入休息时间。
      if (this.relationship && (!this.relationship.validReason(relationshipReason) || (relationshipReason?.kind!=='dateEvent'&&this.relationship.suppressed(session.chatId)))) return {ok:true,message:null};
      const latest = [...session.messages].reverse().find((entry) => entry.role === 'user');
      if (!this.available(this.now()) || latest !== user || session.lastActiveAt !== priorActivity
        || Number(session.state.mutedUntil) > this.now().getTime() || Number(session.state.silentUntil) > this.now().getTime()) {
        return { ok: true, message: null };
      }
      if(relationshipReason?.naturalInvitation){const kind=relationshipReason.dateKind,pattern={chat:/聊|说/,watch:/看|B站/,quiet:/陪|待/}[kind];if(!pattern.test(text)||/[一二三四五六七八九十百\d]+\s*(?:分钟|小时)/.test(text))text=relationshipReason.fallbackText;}
      text = String(text || '').trim().replace(/^(?:鲸鲸|鲸鱼娘)[：:]\s*/, '');
      if (persona.isCuteStyle(this.config)) text = persona.formatCuteText(text, this.config.persona.emojiLevel === '关');
      const bubbles = persona.splitBubbles(text, { maxChars: Math.min(80, this.config.chat.privateMaxChars || 80), maxBubbles: 1 });
      text = bubbles[0] || '';
      if (!text || (!relationshipReason?.plainText && history.filter((entry) => entry.role === 'assistant').some((entry) => entry.text === text))) return { ok: true, message: null };
      const claimedAt = this.now();
      const { day } = beijingTime(claimedAt);
      const id = randomUUID();
      // 先持久化领取：桥接崩溃或确认丢失时也不重复发；未回复就保持等待。
      session.state.proactiveChat = {
        day, count: (previous.day === day ? Number(previous.count) || 0 : 0) + 1,
        lastAttemptAt: claimedAt.getTime(), awaiting: true, userTs: user.ts,
        pending: { id, text, createdAt: claimedAt.getTime(), relationshipKind:relationshipReason?.kind },
      };
      this.persist();
      if (relationshipReason){relationshipReason.generatedText=text;this.relationship.claimReason(relationshipReason,id);}
      if (watchFollowup && !relationshipReason) this.companion.claimFollowUp(watchFollowup.id);
      return { ok: true, message: { id, chatId: session.chatId, chatType: 'private', text } };
    } finally {
      this.busy = false;
    }
  }

  ack(id, sent) {
    for (const session of this.store.sessions.values()) {
      const state = session.state.proactiveChat;
      if (state && state.lastAckId === id) {
        this.persist();
        return { ok: true, duplicate: true };
      }
      if (!state || !state.pending || state.pending.id !== id) continue;
      const deliveredText=state.pending.text;
      if (sent) this.store.appendMessage(session.key, {
        role: 'assistant', name: this.config.persona.name, text: state.pending.text,
        ts: this.now().getTime(), proactive: true, msgId:id,
      });
      state.lastAckId = id;
      state.pending = null;
      if (!sent) state.awaiting = false;
      this.persist();
      this.relationship?.ackReason(id,sent);
      this.relationship?.flow.ack(id,sent,deliveredText);
      return { ok: true };
    }
    return { ok: false, error: '消息已过期或不存在' };
  }

  persist() {
    this.store.markDirty();
    this.store.flush();
    if (this.store.dirty) throw new Error('主动聊天状态未能保存，这次先不发送');
  }
}

module.exports = { ProactiveChat, normalizeOptions, beijingTime };
