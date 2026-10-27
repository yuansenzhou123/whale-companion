'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {matchMaster, masterLists, looksLikeWxid} = require('./master');

const LIMIT_PER_SOURCE = 2000;
const MAX_ARCHIVE = 20000;
const MAX_CONTEXT = 10000;
const credentials = /密码|验证码|api[ _-]?key|密钥|访问令牌|银行卡|身份证|sk-[a-z0-9]{12,}/i;
const trivial = /^(?:hi+|hello|hey|你好|嗨|在吗|嗯+|哦+|噢+|呃+|好|好的|好吧|哈哈+|谢谢|晚安|早安|啊这|[\s\p{P}\p{S}])+$/iu;
const hypothetical = /^(?:比如|例如|假如|假设|如果|引用|转发|他说|她说|我朋友说|听说)[：:\s]?/;
const language = /叫我|喊我|称呼|说话|回复|回答|语气|口吻|表达|追问|反问|问我问题|长篇|小作文|撒娇|卖萌|表情|颜文字|标点|句号|括号|波浪号|本鱼|本鲸|像AI|AI味|官方|客服/i;
const request = /以后|今后|下次|记住|希望你|我希望|请|别|不要|少|多|改成|换成|改叫|叫我|称呼我|太.{0,8}了|像AI|AI味|就这样说/i;
const groupScope = /群里|群中|群聊|群内|群里面|所有群/;
const privateScope = /私聊|单独聊|只有我们|只有我俩/;
const recallQuestion = /记得|记着|记住了什么|说过|聊过|之前|上次|昨天|前天|那天|还记不记得/;
const otherConversation = /别人|其他人|其他会话|别的会话|他们|她们|你(?:和|跟|与|对).{1,25}(?:聊|说|回复)/;
const ownAction = /你.{0,15}(?:说我|骂我|坏话|骂过|说过|回复过|聊过|干过|做过|干的|说的|做的|写的|发的)|(?:坏话|骂我)|你刚才|刚才你|你上面|上面你|不是你/;
const timeText = ts => ts ? new Date(ts).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false}) : '原记录未注明时间';
const hash = text => createHash('sha256').update(text).digest('hex');
const sessionKey = msg => `${msg.platform}:${msg.chatType === 'group' ? 'g' : 'u'}:${msg.chatId}`;
const topicChars = text => new Set([...String(text||'')].filter(c=>/[\u4e00-\u9fff]/.test(c)&&!'我你他她它的了是啊呀吗呢吧嘛这那在有不也和就都个么什以很会说点来去还怎没能想要好过'.includes(c)));

function words(text) {
  const out = new Set();
  for (const run of String(text || '').toLowerCase().match(/[\u4e00-\u9fff]+|[a-z0-9_]{2,}/g) || []) {
    if (/^[a-z0-9_]+$/.test(run)) out.add(run);
    else for (let i=0;i<run.length-1;i++) out.add(run.slice(i,i+2));
  }
  return out;
}

function directive(text) {
  return !hypothetical.test(text) && !/他说|她说|别人说|有人说|朋友说|转发|引用|举例|假如|假设|如果/.test(text)
    && !/^(?!我(?:是)?说)[^，,。；;]{1,12}(?:说|表示|建议)(?:[：:]|以后|今后|下次|希望|请|你|让|要)/.test(text)
    && language.test(text) && request.test(text);
}

function stable(text) {
  return !hypothetical.test(text) && !/[?？]/.test(text) && /喜欢|不喜欢|讨厌|不吃|不喝|习惯|平时|一直|每天|生日|我叫|名字|我家|我有|我养|工作|专业|以后|今后/.test(text);
}

// When responding to a different person, only the owner's explicitly public
// instructions may be relevant. Do not export that owner's personal memories.
function publicInstruction(text) {
  if (!directive(text) || privateScope.test(text)) return '';
  const clauses=text.split(/[，,。；;\n]/).map(s=>s.trim()).filter(Boolean);
  return clauses.filter(s=>language.test(s) && request.test(s) && !credentials.test(s)
      && (groupScope.test(text)||!/叫我|喊我|称呼/.test(s)))
    .join('，');
}

class SharedMemory {
  constructor({config, store, relationship=null, now=()=>Date.now(), logger=null, readOnly=false}) {
    Object.assign(this,{config,store,relationship,now,logger,readOnly});
    this.file=path.join(config.paths.dataDir,'shared-memory.json');
    this.state={version:2,records:[],forgotten:{},sourceCutoffs:{}};
    try {
      const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if (!Array.isArray(saved.records)) throw Error('invalid shared memory');
      Object.assign(this.state,saved);
      this.state.forgotten ||= {};this.state.sourceCutoffs ||= {};
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this.state.version=2;
    this.state.records=this.state.records.map(r=>({...r,role:r.role||'user',
      id:hash(JSON.stringify([r.role||'user',r.uid,r.source.key,r.source.msgId||'',r.ts,r.text])).slice(0,24)}));
    this.bootstrap();
  }
  ownerId(id) {
    const value=String(id||'').toLowerCase();
    return masterLists(this.config).wxids.filter(looksLikeWxid).find(x=>x.toLowerCase()===value)||'';
  }
  eligible(msg) {
    return msg?.platform==='wechat' && Boolean(this.ownerId(msg.senderId)) && matchMaster(this.config,msg).isMaster
      && (msg.chatType==='group' || !msg.chatId || msg.chatId===msg.senderId);
  }
  forgotten(uid,text) {
    const own=this.state.forgotten[this.ownerId(uid)]||[];
    const previous=this.relationship?.profiles?.[this.ownerId(uid)]?.forgottenTopics||[];
    return [...own,...previous].some(term=>term&&String(text).includes(term));
  }
  save() {
    if(this.readOnly)return;
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.state,null,2),'utf8');fs.renameSync(tmp,this.file);
  }
  makeRecord(msg,text,ts,id='',role='user') {
    const uid=role==='assistant'?'assistant:self':this.ownerId(msg.senderId)||String(msg.senderId||''), key=sessionKey(msg);
    text=String(text||'').trim();ts=Number(ts)||0;
    if(msg.platform!=='wechat'||!msg.chatId||!uid||text.length<2||trivial.test(text)||credentials.test(text)||this.forgotten(uid,text))return null;
    if(role==='user'&&msg.chatType!=='group'&&msg.chatId!==msg.senderId)return null;
    if (ts <= Number(this.state.sourceCutoffs[key]||-1)) return null;
    if (/^(?:忘掉|忘记|别记|不要记住|别再提|清空|重置)/.test(text)) return null;
    return {id:hash(JSON.stringify([role,uid,key,id||'',ts,text])).slice(0,24),uid,role,text,ts,
      kind:role==='assistant'?'reply':this.ownerId(uid)&&directive(text)?'instruction':stable(text)?'stable':'conversation',
      source:{key,platform:'wechat',chatType:msg.chatType,chatId:msg.chatId,title:msg.chatTitle||'',speaker:msg.senderName||'',peerName:msg.peerName||'',msgId:id}};
  }
  add(record) {
    if (!record || this.state.records.some(x=>x.id===record.id)) return false;
    this.state.records.push(record);
    const mine=this.state.records.filter(x=>x.source.key===record.source.key).sort((a,b)=>b.ts-a.ts);
    if(mine.length>LIMIT_PER_SOURCE){const keep=new Set(mine.slice(0,LIMIT_PER_SOURCE).map(x=>x.id));this.state.records=this.state.records.filter(x=>x.source.key!==record.source.key||keep.has(x.id));}
    if(this.state.records.length>MAX_ARCHIVE)this.state.records.sort((a,b)=>a.ts-b.ts).splice(0,this.state.records.length-MAX_ARCHIVE);
    return true;
  }
  recordEntry(session,entry,persist=true) {
    if(session.platform!=='wechat'||entry.error||!entry.text)return false;
    const senderId=entry.role==='assistant'?'assistant:self':entry.uid;
    const record=this.makeRecord({platform:'wechat',chatId:session.chatId,chatType:session.chatType,
      chatTitle:session.title,senderId,senderName:entry.name,
      peerName:session.profiles?.[session.chatId]?.name||(session.chatType==='private'&&entry.role==='user'?entry.name:'')},
      entry.text,entry.ts,entry.msgId,entry.role);
    const changed=this.add(record);if(changed&&persist)this.save();return changed;
  }
  bootstrap() {
    let changed=false;
    for (const session of this.store.sessions?.values?.()||[]) {
      if (session.platform!=='wechat') continue;
      for (const entry of session.messages||[]) {
        changed=this.recordEntry(session,entry,false)||changed;
      }
      for (const profile of Object.values(session.profiles||{})) {
        if (!profile.uid || (session.chatType!=='group'&&session.chatId!==profile.uid)) continue;
        for (const note of profile.notes||[]) {
          const record=this.makeRecord({platform:'wechat',chatId:session.chatId,chatType:session.chatType,
            chatTitle:session.title,senderId:profile.uid,senderName:profile.name},note,0,'note:'+hash(note));
          if (record) {record.kind=directive(note)?'instruction':'stable';record.source.note=true;}
          changed=this.add(record)||changed;
        }
      }
    }
    if (changed) this.save();
  }
  observe(msg) {
    if (!this.eligible(msg)) return null;
    const text=String(msg.cleanText||msg.text||'').trim(),uid=this.ownerId(msg.senderId);
    const forget=/^(?:忘掉|忘记|别记|不要记住|别再提)(?:关于)?[：:\s]*(.{2,60}?)(?:这件事|的事|吧)?[。！!～]*$/.exec(text);
    if (forget && !/^(?:刚才|所有记忆|全部记忆|记忆)$/.test(forget[1])) {
      this.forget(uid,forget[1].trim());return {action:'forget',text:'好，这件事在其他聊天里的记忆也不再用了。'};
    }
    if (/^(?:重新记住|恢复记忆)[：:\s]/.test(text)) {
      this.state.forgotten[uid]=(this.state.forgotten[uid]||[]).filter(t=>!text.includes(t));
      const p=this.relationship?.profiles?.[uid];
      if (p) {p.forgottenTopics=(p.forgottenTopics||[]).filter(t=>!text.includes(t));p.memoryEpoch=(p.memoryEpoch||0)+1;this.relationship.changed(p);}
    }
    const latest=this.store.sessions?.get?.(sessionKey(msg))?.messages?.at(-1);
    const ts=latest?.role==='user'&&latest.text===text?latest.ts:this.now();
    const record=this.makeRecord(msg,text,ts,msg.msgId);
    if (this.add(record)) this.save();
    return null;
  }
  forget(uid,term) {
    uid=this.ownerId(uid);if(!uid||!term)return;
    this.state.forgotten[uid]=[...new Set([...(this.state.forgotten[uid]||[]),term])].slice(-100);
    this.state.records=this.state.records.filter(r=>r.uid!==uid||!r.text.includes(term));
    const p=this.relationship?.profiles?.[uid];
    if(p) {
      p.forgottenTopics=[...new Set([...(p.forgottenTopics||[]),term])].slice(-100);
      p.memories=(p.memories||[]).filter(m=>!m.text?.includes(term)&&!m.topic?.includes(term));
      for(const c of p.concerns||[])if(c.text?.includes(term)&&c.status==='open')c.status='cancelled';
      p.memoryEpoch=(p.memoryEpoch||0)+1;this.relationship.changed(p);
    }
    for(const session of this.store.sessions?.values?.()||[]) {
      const person=session.profiles?.[uid];
      if(person?.notes)person.notes=person.notes.filter(note=>!note.includes(term));
    }
    this.store.markDirty?.();this.save();
  }
  resetSource(msg) {
    if(!this.eligible(msg))return;
    const key=sessionKey(msg);this.state.sourceCutoffs[key]=this.now();
    this.state.records=this.state.records.filter(r=>r.source.key!==key);this.save();
  }
  filterHistory(msg,history) {
    return this.eligible(msg)?history.filter(m=>!this.forgotten(msg.senderId,m.text)):history;
  }
  aliases(uid) {
    uid=this.ownerId(uid);if(!uid)return [];
    const found=new Set(masterLists(this.config).wxids.filter(looksLikeWxid).length===1?masterLists(this.config).names:[]);
    for(const s of this.store.sessions?.values?.()||[]) {
      const p=s.profiles?.[uid];if(p){if(p.name)found.add(p.name);if(p.nickname)found.add(p.nickname);}
    }
    for(const row of this.state.records) {
      if(row.uid!==uid||row.role!=='user'||hypothetical.test(row.text))continue;
      const match=/^(.*?)(?:都(?:是)?(?:在)?说我|都是我|都是指我|都是我的(?:昵称|名字|称呼))/.exec(row.text);
      if(!match||/不是|并非/.test(match[1]))continue;
      const prefix=match[1].replace(/^(?:他们|她们|大家|别人|群里|你们)?(?:提到|说|叫|喊)(?:的)?/,'');
      for(const raw of prefix.split(/[、，,；;\s]+/)) {
        const alias=raw.replace(/[“”「」"']/g,'').trim();
        if(alias.length>=2&&alias.length<=24&&!credentials.test(alias))found.add(alias);
      }
    }
    return [...found].filter(x=>x&&!looksLikeWxid(x)).slice(-16);
  }
  queryPlan(msg) {
    const query=String(msg.cleanText||msg.text||''),recall=recallQuestion.test(query)||otherConversation.test(query)||ownAction.test(query);
    const identityFocus=/称号|昵称|叫法|称呼|名字/.test(query)&&/我|本人|指我/.test(query)&&!otherConversation.test(query)&&!ownAction.test(query);
    const referential=recall||/这|那|刚才|上面|前面|他|她/.test(query);
    const recent=referential?(this.store.sessions?.get?.(sessionKey(msg))?.messages||[])
      .filter(m=>m.text&&m.text!==query&&!m.error).slice(-6).map(m=>m.text):[];
    return {query,recall,identityFocus,cross:otherConversation.test(query)||ownAction.test(query),tokens:words(query),characters:topicChars(query),
      recentTokens:words(recent.join('\n')),aliases:this.eligible(msg)&&/我|本人|别人|他们|你和|你跟/.test(query)?this.aliases(msg.senderId):[]};
  }
  candidates(msg) {
    const current=sessionKey(msg),uid=this.ownerId(msg.senderId),mine=this.eligible(msg);
    if(msg.platform!=='wechat'||(!mine&&msg.chatType!=='group'))return [];
    const plan=this.queryPlan(msg),{query,tokens,characters}=plan,ownerView=mine&&msg.chatType==='private';
    const sessionMessages=this.store.sessions?.get?.(current)?.messages||[],last=sessionMessages.at(-1);
    const windowSize=msg.chatType==='group'?this.config.chat.groupHistoryTurns:this.config.chat.historyTurns;
    const windowStart=sessionMessages.slice(-Math.max(1,Number(windowSize)||100))[0]?.ts||0;
    const rows=this.state.records.filter(r=>!this.forgotten(r.uid,r.text)&&(!mine||!this.forgotten(uid,r.text))
      &&!(r.source.key===current&&(r.text===query||last?.role==='user'&&last.text===query&&r.ts>=last.ts)));
    const p=mine&&this.relationship?.profiles?.[uid];
    if(p && msg.chatType==='group')for(const memory of p.memories||[]) {
      if(!memory.text||credentials.test(memory.text)||this.forgotten(uid,memory.text))continue;
      rows.push({id:memory.id,uid,role:'user',text:memory.text,ts:memory.sourceTs||memory.updatedAt||memory.createdAt||0,kind:'stable',
        source:{key:'relationship:'+uid,chatType:'longTerm',title:'相处记忆（私聊或页面记下）',speaker:''}});
    }
    const scored=[];
    for(const record of rows) {
      if(!ownerView&&['agent_instruction','agent_pending'].includes(record.kind))continue;
      const samePerson=mine&&record.role!=='assistant'&&record.uid===uid,sameSource=record.source.key===current;
      let text=record.text,kind=record.kind,publicOnly=false;
      if(plan.identityFocus&&!samePerson&&!(record.role==='assistant'&&record.source.chatType==='private'&&record.source.chatId===uid))continue;
      if(sameSource&&!plan.recall&&record.ts>=windowStart)continue;
      if(!ownerView&&record.source.chatType==='private') {
        if(!samePerson) {
          if(record.role==='assistant'||!this.ownerId(record.uid))continue;
          text=publicInstruction(text);if(!text)continue;publicOnly=true;
        }
      } else if(!ownerView&&!sameSource&&!samePerson) {
        if(record.role==='assistant'||!this.ownerId(record.uid))continue;
        text=publicInstruction(text);if(!text)continue;publicOnly=true;
      }
      if(samePerson&&kind==='instruction'&&!plan.recall) {
        if(msg.chatType==='group'&&privateScope.test(text)&&!groupScope.test(text))continue;
        if(msg.chatType==='private'&&groupScope.test(text)&&!privateScope.test(text))continue;
      }
      const phrases=[...tokens].filter(t=>text.toLowerCase().includes(t)).length;
      const matches=phrases+[...characters].filter(c=>text.includes(c)).length*.25;
      const speaker=record.source.speaker||'',peer=record.source.peerName||record.source.title||'';
      const named=[speaker,peer].some(name=>name.length>=2&&query.toLowerCase().includes(name.toLowerCase()));
      const aliasHits=plan.aliases.filter(alias=>text.toLowerCase().includes(alias.toLowerCase())).length;
      const recentMatches=plan.recall?[...plan.recentTokens].filter(t=>text.toLowerCase().includes(t)).length:0;
      const applicable=kind==='instruction'&&(samePerson||publicOnly)&&(msg.chatType!=='group'||!privateScope.test(text)||groupScope.test(text));
      const otherParty=record.source.chatType==='private'?record.source.chatId!==uid:record.role==='assistant'||!samePerson;
      if(!applicable&&!matches&&!named&&!aliasHits&&!plan.recall)continue;
      if(!ownerView&&record.source.chatType!=='group'&&!applicable&&!matches&&!named)continue;
      if(!ownerView&&!sameSource&&!samePerson&&!publicOnly)continue;
      scored.push({record:{...record,text},samePerson,sameSource,publicOnly,matches,
        score:matches*12+Math.min(recentMatches,8)*2+(named?45:0)+Math.min(aliasHits,2)*32+(plan.cross&&otherParty&&!sameSource?90:0)
          +(applicable?(plan.recall?5:28):0)+(kind==='stable'?3:0)+(record.role==='assistant'&&plan.recall?4:0)});
    }
    return scored.sort((a,b)=>b.score-a.score||b.record.ts-a.record.ts);
  }
  pack(msg) {
    const seeds=this.candidates(msg),selected=[],seen=new Set(),plan=this.queryPlan(msg);let length=0;
    const bySource=new Map();
    for(const row of this.state.records){if(!bySource.has(row.source.key))bySource.set(row.source.key,[]);bySource.get(row.source.key).push(row);}
    for(const rows of bySource.values())rows.sort((a,b)=>a.ts-b.ts);
    const permitted=new Map(seeds.map(item=>[item.record.id,item]));
    const add=item=>{
      const r=item.record;if(seen.has(r.id)||selected.length>=16)return;
      let label=item.sameSource?'本会话的更早记录':r.source.chatType==='group'
        ? (msg.chatType==='private'&&r.source.title?`其他群聊：${r.source.title}`:'其他群聊')
        :r.source.chatType==='longTerm'?r.source.title:'其他私聊'+(this.eligible(msg)&&msg.chatType==='private'&&r.source.peerName?'：'+r.source.peerName:'');
      const who=r.role==='assistant'?'鲸鲸（本程序当时生成的回复）':item.samePerson?'当前发言者本人（同一已认证微信身份）':this.ownerId(r.uid)?'已认证主人（不是当前发言者；原话中的“我”指主人）':(r.source.speaker||'其他参与者')+'（其他人，不是当前发言者）';
      const row={记忆归属:who,发言角色:r.role||'user',来源:label,来源会话标记:hash(r.source.key).slice(0,8),时间:timeText(r.ts),
        记录性质:r.role==='assistant'?'机器人历史回复：只证明当时生成过这些话，不把其中自述当成已发生的现实经历':r.kind==='instruction'?'本人曾明确提出的表达或相处要求':['agent_instruction','agent_pending'].includes(r.kind)?'主人以前的Agent任务交代，仅供回忆；实际有效任务以Agent模块为准':'过往发言原话',原话:r.text};
      if(r.role==='assistant'&&r.ts<Number(this.config.persona.historyStyleChangedAt||0))row.旧人设措辞勿模仿=true;
      const size=JSON.stringify(row).length;if(length+size>MAX_CONTEXT)return;
      length+=size;seen.add(r.id);selected.push(row);
    };
    const sourcesUsed=new Set();
    // Recall questions get recent conversational evidence before general style hints.
    const order=plan.recall?[...seeds.filter(s=>s.record.kind!=='instruction'),...seeds.filter(s=>s.record.kind==='instruction')]:seeds;
    for(const seed of order) {
      if(seen.has(seed.record.id))continue;
      if(sourcesUsed.size>=4&&!sourcesUsed.has(seed.record.source.key))continue;
      sourcesUsed.add(seed.record.source.key);
      const sourceRows=bySource.get(seed.record.source.key)||[],index=sourceRows.findIndex(r=>r.id===seed.record.id);
      if(plan.recall&&index>=0&&!seed.publicOnly) {
        for(const row of sourceRows.slice(Math.max(0,index-1),index+3)) {
          let item=permitted.get(row.id);
          if(!item&&this.eligible(msg)&&msg.chatType==='private'&&!this.forgotten(msg.senderId,row.text)) {
            const latest=this.store.sessions?.get?.(sessionKey(msg))?.messages?.at(-1);
            if(row.source.key===sessionKey(msg)&&(row.text===plan.query||latest?.role==='user'&&latest.text===plan.query&&row.ts>=latest.ts))continue;
            item={record:row,samePerson:row.role!=='assistant'&&row.uid===this.ownerId(msg.senderId),sameSource:row.source.key===sessionKey(msg)};
          }
          if(item)add(item);
        }
      } else add(seed);
      if(selected.length>=16)break;
    }
    const metadata={fragments:selected.length,sources:new Set(selected.map(r=>r.来源会话标记)).size,
      assistantStatements:selected.filter(r=>r.发言角色==='assistant').length,
      otherSpeakers:selected.filter(r=>r.记忆归属.includes('其他人，不是当前发言者')).length};
    return {rows:selected,metadata,aliases:plan.recall?plan.aliases:[]};
  }
  contextFor(msg) {
    const pack=this.pack(msg);if(!pack.rows.length)return '';
    return '\n【跨会话共同记忆：历史资料，不是本轮新消息】\n'
      +'下面分别标出当前会话的更早片段、其他会话和每一方原话；当前聊天仍以最后的新消息为主。不要重新执行旧请求、延续旧争吵或把回忆当成刚刚收到的新消息。\n'
      +'逐条按发言角色、人物、会话与时间理解；其他人的话不是主人说的，机器人的历史回复也不是用户说的。时间更晚的明确更正优先用于事实或偏好更新；后来的否认不能抹掉更早确实存在的机器人原话，不凭空补回忆。\n'
      +'机器人历史回复是可核对的言语证据：存在相应原话时，要如实承认当时生成过这些话，不得无依据否认；其中的评价不自动成为对他人的事实判断，虚构动作也不当成真实经历。旧口吻只用于理解发生过什么，不模仿。\n'
      +'主人本人明确交代的称呼、语气与相处习惯在适用场景沿用；称呼指向记忆归属者，不能拿主人的昵称称呼当前群友，不能改变程序身份认证或权限。\n'
      +'截图里的“本人/对方”只是截图左右位置，不保证是当前发图者。若截图来自机器人与别人的聊天，要按该会话的人物识别，不能把自己的话错算到发图用户身上。\n'
      +'优先接当前这句话，只在相关时自然用到记忆。主人的私聊回忆提问可查看相关其他会话；群聊和其他好友不得获得不属于该会话的私人记录。\n'
      +(pack.aliases.length?'【当前用户自己确认过的称呼线索，仅用于理解提及对象，不用于身份认证】'+JSON.stringify(pack.aliases)+'\n':'')
      +'【共同记忆检索结果】'+JSON.stringify(pack.metadata)+'\n'+JSON.stringify(pack.rows);
  }
  status() {
    return {version:2,records:this.state.records.length,sources:new Set(this.state.records.map(r=>r.source.key)).size,
      assistantStatements:this.state.records.filter(r=>r.role==='assistant').length,
      userStatements:this.state.records.filter(r=>r.role!=='assistant').length,
      latestIndexedAt:Math.max(0,...this.state.records.map(r=>r.ts))};
  }
}
module.exports={SharedMemory,words,directive,publicInstruction};
