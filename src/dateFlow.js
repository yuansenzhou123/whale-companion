'use strict';
const {randomUUID} = require('node:crypto');
const MINUTE=60000, HOUR=60*MINUTE;
const accept=/^(?:好|好呀|好啊|好哦|好的|嗯|嗯嗯|可以|可以呀|可以啊|行|行呀|行啊|来吧|走起|没问题|当然|一起吧|陪我吧|那就开始吧|开始吧|答应你|接受邀请|好[呀啊的]?[，, ]*(?:一起看[吧呀]?|陪我[吧呀]?|开始[吧呀]?))[。！!～~]*$/i;
const decline=/^(?:不了|不了吧|不想|今天不想|今天不行|算了|算了吧|改天|改天吧|下次吧|先不了|不去了|拒绝邀请|现在(?:没空|不行|不想)|我(?:现在)?(?:有点忙|在忙|没空))[。！!～~]*$/;

/** Consent and a small date timeline. Delivery always uses the existing WeChat queue. */
class DateFlow {
  constructor(relationship) {this.r=relationship;}
  defaults(p) {
    if(p.autoInvites===undefined)p.autoInvites=true;
    if(p.dateFlowEnabled===undefined)p.dateFlowEnabled=true;
    if(p.invitation===undefined)p.invitation=null;
    if(p.lastInviteAt===undefined)p.lastInviteAt=0;
    return p;
  }
  latestUser(session) {return [...(session?.messages||[])].reverse().find(m=>m.role==='user'&&m.uid===session.chatId&&!m.error);}
  latestAssistant(session) {return [...(session?.messages||[])].reverse().find(m=>m.role==='assistant'&&!m.error);}
  bubble(p,text,phase='opening',emotion='happy') {
    p.dateBubble={text,phase,emotion,at:this.r.now(),expiresAt:this.r.now()+40000};
  }
  opening(active) {
    if(active.natural)return {watch:'来啦～你放，我在屏幕边边陪着看。',chat:'好呀，今天的小事慢慢丢给我听～',quiet:'嗯，我就在这儿。你忙你的，想说话了再戳我～'}[active.kind];
    const minutes=Math.round((active.endAt-active.startedAt)/MINUTE);
    const variant=Math.floor(active.startedAt/MINUTE)%2;
    return {
      watch:variant?`来啦～把 B站放起来，这 ${minutes} 分钟分我一半屏幕边边。`:`好耶，${minutes} 分钟的靠边座位归本鱼了～你放，我陪着看。`,
      chat:variant?`好呀，接下来 ${minutes} 分钟慢慢聊。先把今天最想吐槽的那一小件丢过来～`:`来，借我 ${minutes} 分钟～今天有什么想说的，零零碎碎也行。`,
      quiet:`嗯，${minutes} 分钟，我就在这儿。你忙你的，想说话了再戳我～`,
    }[active.kind];
  }
  started(id,active,source) {
    const p=this.r.profile(id);
    active.flowEnabled=p.dateFlowEnabled;
    active.source=source;
    active.events={opening:source==='wechat'?{status:'replied',at:this.r.now()}:null,middle:null,closing:null};
    if(p.invitation&&['claimed','delivered'].includes(p.invitation.status))p.invitation.status='accepted';
    if(active.flowEnabled)this.bubble(p,this.opening(active));
  }
  ended(id,date) {
    const p=this.r.profile(id);
    if(!date.flowEnabled||(date.reason==='elapsed'&&this.r.now()-date.endedAt>15*MINUTE))return;
    if(date.reason==='cancelled') {p.dateBubble=null;return;}
    const text=date.natural?(date.kind==='quiet'?'我还在这儿，想说话再叫我～':'刚才那一小段先收好啦～你忙你的，想聊再叫我。'):date.kind==='chat'&&!date.userMessages?'这一小会儿先陪到这里啦～想聊了再戳我。':date.kind==='watch'?'今天的靠边座位先收起来啦～这一小段，陪到你了。':date.kind==='quiet'?'时间到啦。刚才没吵你，陪着这件事有认真做哦～':'今天这会儿先收好啦～能听你零零碎碎地说说话，本鱼挺开心的。';
    this.bubble(p,text,'closing',date.kind==='quiet'?'sleepy':'happy');
  }
  tick() {
    let changed=false;
    for(const id of this.r.ownerIds()) {
      const p=this.r.profiles[id];if(!p)continue;this.defaults(p);
      if(p.invitation&&['claimed','delivered'].includes(p.invitation.status)&&this.r.now()>=p.invitation.expiresAt){p.invitation.status='expired';p.revision++;changed=true;}
    }
    if(changed)this.r.save();
  }
  pending(p) {return p.invitation?.status==='delivered'&&p.invitation.expiresAt>this.r.now();}
  invitationFor(session) {
    if(session.platform!=='wechat'||session.chatType!=='private'||!this.r.ownerIds().includes(session.chatId))return null;
    const p=this.r.profile(session.chatId),now=this.r.now();
    if(!p.enabled||!p.autoInvites||p.activeDate||now-p.lastInviteAt<(p.naturalDates&&!['declined','dismissed','expired'].includes(p.invitation?.status)?24:48)*HOUR)return null;
    if(p.invitation&&['claimed','delivered'].includes(p.invitation.status))return null;
    if(p.dates.some(d=>now-d.endedAt<12*HOUR))return null;
    const user=this.latestUser(session);
    if(!user||now-user.ts>48*HOUR||/忙|没空|别打扰|别找我|不想聊|晚安|睡了|睡觉|先到这里|结束约会|改天|下次吧/.test(user.text))return null;
    if(!user.text||user.text.length<6)return null;
    let kind=/累|疲惫|疲劳|想静静/.test(user.text)?'quiet':'chat';
    const actual=this.r.companion.memories.some(m=>m.ownerId===session.chatId&&now-m.lastAt<24*HOUR&&m.observations?.length);
    if(kind!=='quiet'&&this.r.companion.settings.ownerId===session.chatId&&(actual||/视频|B站|b站|番剧|动画/.test(user.text)))kind='watch';
    const minutes=kind==='chat'?15:20;
    const n=p.invitation?.text?.includes('想借你')||p.invitation?.text?.includes('想蹭你')?0:1;
    const text={
      chat:n?'想借你十五分钟，陪本鱼聊点零零碎碎的小事，好不好呀？':'本鱼想来占你十五分钟～一起聊一小会儿，要不要？',
      watch:n?'想蹭你屏幕边边二十分钟～一起看会儿 B站，好不好？':'本鱼申请一个靠边座位～陪你看二十分钟 B站，行不行呀？',
      quiet:'要不要让本鱼安静陪你二十分钟？不用找话题，我待在这儿就好～',
    }[kind];
    return {kind:'invitation',id:randomUUID(),ownerId:session.chatId,revision:p.revision,dateKind:kind,minutes,plainText:p.naturalDates?null:text,fallbackText:{chat:'想听你说说今天的小事，要不要一起聊会儿呀？',watch:'本鱼想蹭个靠边座位，一起看会儿 B站好不好？',quiet:'要不要本鱼安静陪你待会儿？不用找话题～'}[kind],naturalInvitation:p.naturalDates,text:p.naturalDates?'自然提出一次'+{watch:'一起看视频',chat:'聊会儿天',quiet:'安静陪伴'}[kind]+'的邀请，等对方答应。最多一句，不报分钟、时间段或结束时间，不列活动清单，不机械重复口癖。结合这些真实私聊小事选一个由头，不能编造已经共同做过的事：'+JSON.stringify(this.r.memory.recall(session.chatId,user.text)):'向用户提出一次可拒绝的线上约会邀请，只有明确答应后才能开始。'};
  }
  respond(id,decision,source='page') {
    this.r.tick();const p=this.r.profile(id);
    if(!p.enabled||!this.pending(p))throw new Error('这次邀请已经收起来啦，想陪伴时也可以直接开始。');
    if(!['accept','decline'].includes(decision))throw new Error('请选择接受或婉拒');
    if(decision==='decline') {p.invitation.status='declined';p.invitation.respondedAt=this.r.now();this.r.changed(p);return '好呀，那本鱼先不占你时间啦～';}
    const {dateKind,minutes}=p.invitation;
    this.r.startDate(id,dateKind,minutes,{source});
    p.invitation.status='accepted';p.invitation.respondedAt=this.r.now();this.r.changed(p);
    return this.opening(p.activeDate);
  }
  handle(msg,session) {
    const p=this.r.profile(msg.senderId),text=String(msg.cleanText||msg.text||'').trim();
    if(/^(?:别再邀请我|不要主动约我|别主动约我)[。！!～~]*$/.test(text)) {
      p.autoInvites=false;if(p.invitation&&['claimed','delivered'].includes(p.invitation.status))p.invitation.status='cancelled';this.r.changed(p);
      return '好，等你想一起待着的时候再叫我～';
    }
    if(/^(?:可以主动约我|恢复约会邀请)[。！!～~]*$/.test(text)){p.autoInvites=true;this.r.changed(p);return '嘿，那本鱼会挑你空闲的时候来问一声～';}
    if(p.activeDate?.natural){
      if(/^(?:我)?(?:先去忙了|去忙了|先睡了|去睡了|要睡了|先走了|去吃饭了|不聊了|先不看了|今天先到这里)[。！!～]*$/.test(text)){this.r.finishDate(msg.senderId);return '嗯，去吧～本鱼把刚才这会儿收好。';}
      if(text&&text.length>1){p.activeDate.endAt=Math.min(p.activeDate.startedAt+3*HOUR,Math.max(p.activeDate.endAt,this.r.now()+12*MINUTE));this.r.changed(p);}
    }
    if(!p.activeDate&&/^(?:今天(?:有点|好)累[，, ]*)?(?:陪我聊(?:会儿|一会儿|会天)|陪我待(?:会儿|一会儿)|想和你待(?:会儿|一会儿)|陪我看(?:会儿)?(?:视频|B站))[吧呀啊。！!～]*$/.test(text)){
      const kind=/看/.test(text)?'watch':/聊/.test(text)?'chat':'quiet';try{this.r.startDate(msg.senderId,kind,20,{source:'wechat',natural:true});return this.opening(p.activeDate);}catch(error){return error.message;}
    }
    if(p.activeDate?.flowEnabled&&!p.activeDate.events.opening) {
      // The ordinary reply will handle the opening if the user starts chatting first.
      p.activeDate.events.opening={status:'replied',at:this.r.now()};this.r.changed(p);
    }
    if(!this.pending(p))return null;
    // A bare yes only answers an invitation while it is still the latest assistant message.
    const last=this.latestAssistant(session);
    if(accept.test(text)&&last?.msgId===p.invitation.messageId) {
      try{return this.respond(msg.senderId,'accept','wechat');}catch(error){return error.message;}
    }
    if(decline.test(text))return this.respond(msg.senderId,'decline','wechat');
    // Any unrelated reply ends the question, rather than hijacking a later “好呀”.
    p.invitation.status='dismissed';this.r.changed(p);return null;
  }
  phase(active) {
    const now=this.r.now(),duration=active.endAt-active.startedAt;
    if(active.natural)return now-active.startedAt<2*MINUTE?'opening':'together';
    if(now-active.startedAt<Math.min(2*MINUTE,duration*.25))return 'opening';
    return active.endAt-now<=Math.min(2*MINUTE,duration*.25)?'windingDown':'together';
  }
  eventFor(session) {
    if(session.platform!=='wechat'||session.chatType!=='private'||!this.r.ownerIds().includes(session.chatId))return null;
    this.r.tick();const p=this.r.profile(session.chatId),now=this.r.now();
    if(!p.enabled||!p.dateFlowEnabled)return null;
    const user=this.latestUser(session);
    if(!user)return null;
    const active=p.activeDate;
    let date=active,phase;
    if(active?.flowEnabled) {
      if(!active.events.opening&&now-active.startedAt<5*MINUTE)phase='opening';
      else if(active.kind!=='quiet'&&!active.events.middle&&now>=active.startedAt+(active.natural?5*MINUTE:(active.endAt-active.startedAt)/2)&&now<active.endAt-MINUTE&&user.ts>active.startedAt)phase='middle';
    } else if(!active) {
      date=[...p.dates].reverse().find(d=>d.flowEnabled&&d.reason==='elapsed'&&!d.events?.closing&&now-d.endedAt<15*MINUTE);
      const lastEventAt=date?.events?.middle?.at||date?.events?.opening?.at||date?.startedAt;
      if(date&&user.ts>lastEventAt)phase='closing';
    }
    if(!phase||!date)return null;
    // Openings are expected after a page action. Other nudges wait for a lull.
    if(phase!=='opening'&&now-Number(session.lastActiveAt||0)<90*1000)return null;
    const videos=phase==='closing'?date.videos:this.r.companion.memories.filter(m=>m.ownerId===session.chatId&&m.lastAt>=date.startedAt).map(m=>({title:m.title,observed:m.observations.filter(o=>o.recordedAt>=date.startedAt).slice(-2).map(o=>o.text)}));
    if(phase==='middle'&&date.kind==='watch'&&!videos.some(v=>v.observed.length))return null;
    const recentUser=session.messages.filter(m=>m.role==='user'&&m.uid===session.chatId&&m.ts>=date.startedAt&&m.ts<=(date.endedAt||now)).slice(-3).map(m=>String(m.text).slice(0,130));
    const instruction=date.natural&&phase==='closing'?'这次陪伴已自然停下来，轻轻收尾，不说时间到，不汇报时长，不另发一次回访。':phase==='opening'?'你们刚开始约定的陪伴，轻轻开场，不再问要不要开始。':phase==='middle'?date.kind==='watch'?'一起看的过程中，接一个实际看到的小细节，只发表一小句反应，不问用户是否在看。':'接着这次聊天中用户确实提过的小事，分享一小句反应或一个轻松话题，不机械报时或盘问。':'这次约定的时段已结束，轻轻道别。只能提实际聊过或采样到的小细节，不做总结汇报，不再另发一次约会回访。';
    return {kind:'dateEvent',id:date.id,phase,ownerId:session.chatId,revision:p.revision,plainText:phase==='opening'?this.opening(date):null,text:instruction+' 事实资料：'+JSON.stringify({kind:date.kind,minutes:date.natural?undefined:Math.round(((date.endAt||date.endedAt)-date.startedAt)/MINUTE),videos:videos.slice(-2),recentUser}).slice(0,1300)};
  }
  valid(reason) {
    const p=this.r.profile(reason.ownerId);
    if(!p.enabled||p.revision!==reason.revision)return false;
    if(reason.kind==='invitation')return p.autoInvites&&!p.activeDate;
    if(reason.kind!=='dateEvent'||!p.dateFlowEnabled)return false;
    const date=p.activeDate?.id===reason.id?p.activeDate:p.dates.find(d=>d.id===reason.id);
    if(!date?.flowEnabled||date.events?.[reason.phase])return false;
    return reason.phase==='closing'?!p.activeDate&&date.reason==='elapsed'&&this.r.now()-date.endedAt<15*MINUTE:p.activeDate?.id===reason.id&&this.r.now()<date.endAt;
  }
  claim(reason,messageId) {
    const p=this.r.profile(reason.ownerId);
    if(reason.kind==='invitation') {
      p.invitation={id:reason.id,dateKind:reason.dateKind,minutes:reason.minutes,text:reason.generatedText||reason.plainText||reason.fallbackText,status:'claimed',createdAt:this.r.now(),expiresAt:this.r.now()+2*HOUR,messageId};p.lastInviteAt=this.r.now();
    } else if(reason.kind==='dateEvent') {
      const date=p.activeDate?.id===reason.id?p.activeDate:p.dates.find(d=>d.id===reason.id);
      date.events||={};date.events[reason.phase]={status:'claimed',messageId,at:this.r.now()};
      if(reason.phase==='closing')date.followupClaimed=true;
    }
    this.r.changed(p);
  }
  ack(messageId,sent,text) {
    for(const id of this.r.ownerIds()) {
      const p=this.r.profiles[id];if(!p)continue;let changed=false;
      if(p.invitation?.messageId===messageId&&p.invitation.status==='claimed') {p.invitation.status=sent?(p.invitation.expiresAt>this.r.now()?'delivered':'expired'):'failed';if(sent&&p.naturalDates&&text)this.bubble(p,text,'invitation','curious');changed=true;}
      for(const date of [...p.dates,...(p.activeDate?[p.activeDate]:[])])for(const [phase,event] of Object.entries(date.events||{})) {
        if(event?.messageId!==messageId||event.status!=='claimed')continue;
        event.status=sent?'delivered':'failed';changed=true;
        if(sent&&phase==='closing')date.followupClaimed=true;
        if(sent&&text&&date.reason!=='cancelled'&&(!p.activeDate||p.activeDate.id===date.id))this.bubble(p,text,phase,phase==='closing'?'happy':'curious');
      }
      if(changed)this.r.changed(p);
    }
  }
  context(id) {
    const p=this.r.profile(id),date=p.activeDate;
    if(!date?.flowEnabled)return '';
    if(date.natural)return '\n【自然陪伴中】当前是'+{watch:'一起看视频',chat:'聊会儿天',quiet:'安静陪着，用户发来一句可以接住，不主动催话题'}[date.kind]+'。这次是随聊天和实际播放自然进行的线上陪伴，不报倒计时，不说到点就结束；用户继续聊就接着聊，说要忙别的就温柔放行。只能聊实际发生的事。';
    const phase=this.phase(date),mins=Math.max(1,Math.ceil((date.endAt-this.r.now())/MINUTE));
    const instruction={opening:'刚开始，先接住用户的话，别反复宣布开始或列活动清单。',together:date.kind==='watch'?'正在一起看，只接实际画面和用户反应，不抢剧情。':date.kind==='quiet'?'安静待在一起，用户说一句就轻轻接一句，不主动开新话题。':'正在聊天，可顺着用户的话分享小反应、轻轻接梗，不连续抛问题。',windingDown:'快到约定的结束时间了，仍顺着用户聊，不突然关门；适合时轻轻收尾。'}[phase];
    return `\n【约会当前阶段】${phase}，约剩 ${mins} 分钟。${instruction}不声称有真实身体接触，不把拟人动作当成实际发生。`;
  }
  desktopState(id) {
    if(!id||!this.r.ownerIds().includes(id))return null;
    const p=this.r.profile(id);if(!p.enabled||!p.dateFlowEnabled||this.r.companion.paused())return null;
    const active=p.activeDate,bubble=p.dateBubble&&p.dateBubble.expiresAt>this.r.now()?p.dateBubble:null;
    if(!active&&!bubble)return null;
    return {natural:active?.natural===true,label:active?.label||'今天的小约会',kind:active?.kind||'',phase:active?this.phase(active):'closing',remainingMinutes:active?Math.max(0,Math.ceil((active.endAt-this.r.now())/MINUTE)):0,bubble};
  }
}
module.exports={DateFlow};
