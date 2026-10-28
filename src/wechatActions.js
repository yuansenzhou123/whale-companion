'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {matchMaster,masterLists,looksLikeWxid}=require('./master');
const {mediaEnabled,selectMomentMedia,validateMomentMedia,mediaProof}=require('./momentMedia');
const terminal=new Set(['sent','failed','unknown','cancelled','expired','draft','simulated']);
const trim=text=>String(text||'').trim();
const hash=text=>createHash('sha256').update(text).digest('hex');

class WeChatActions {
  constructor({config,store,now=()=>Date.now(),dryRun=false}) {
    Object.assign(this,{config,store,now,dryRun});this.file=path.join(config.paths.dataDir,'wechat-actions.json');
    this.state={version:1,jobs:[]};
    try{const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!Array.isArray(saved.jobs))throw Error('动作存档格式不正确');this.state=saved;}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  enabled(){return this.config.actions?.enabled===true;}
  trusted(msg){return this.enabled()&&Boolean(String(this.config.gateway?.wechat?.inboundToken||'').trim())&&msg.platform==='wechat'&&msg.chatType==='private'&&msg.chatId===msg.senderId
    &&looksLikeWxid(msg.senderId)&&masterLists(this.config).wxids.includes(msg.senderId)&&matchMaster(this.config,msg).isMaster;}
  allowed(job){if(job.kind==='moment_text'&&(job.media||mediaEnabled(this.config))&&!validateMomentMedia(this.config,job.media))return false;return masterLists(this.config).wxids.includes(job.ownerId)&&(job.kind==='group_text'?this.config.actions?.groupText!==false:this.config.actions?.moments!==false)&&(!this.agentAllows||this.agentAllows(job));}
  save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.state,null,2),'utf8');fs.renameSync(tmp,this.file);}
  groups(){return [...(this.store.sessions?.values?.()||[])].filter(s=>s.platform==='wechat'&&s.chatType==='group'&&/^[\w-]+@chatroom$/.test(s.chatId))
    .map(s=>({id:s.chatId,name:s.title||s.chatId}));}
  parse(text) {
    const raw=trim(text);
    if(/^(?:如果|假如|例如|比如|别人说|他说|她说|转发|引用|[「“"])/.test(raw))return null;
    if(/^(?:查看|查询|看看)?(?:代发任务|发送任务|动作任务|代发记录|执行记录)(?:状态)?[？?。]*$/.test(raw))return {kind:'status'};
    if(/^(?:取消|撤销)(?:刚才|上一个|这条|那个)?(?:的)?(?:代发|发送|朋友圈)?任务[。！!]*$/.test(raw))return {kind:'cancel'};
    let found=/^(?:(?:帮|替|给)我)?(?:写|保存|留)(?:一条|个)?朋友圈(?:草稿|文案)?[：:]\s*([\s\S]+)$/.exec(raw);
    if(found)return {kind:'moment_draft',text:found[1]};
    found=/^(?:(?:帮|替|给)我)?(?:发(?:布)?(?:一条|个)?朋友圈|在朋友圈发(?:布)?)[：:]\s*([\s\S]+)$/.exec(raw);
    if(found)return {kind:'moment_text',text:found[1]};
    if(/^(?:就发这条朋友圈|发布刚才那条朋友圈|发布刚才的朋友圈草稿)[。！!]*$/.test(raw))return {kind:'publish_draft'};
    const prefix=/^(?:你)?(?:(?:帮|替)我)?(?:去|到|在|往|向|给)\s*/.exec(raw);
    if(!prefix)return null;
    let rest=raw.slice(prefix[0].length),name='';
    const quoted=/^[「“"]([^」”"]+)[」”"]/.exec(rest);
    if(quoted){name=quoted[1];rest=rest.slice(quoted[0].length);}
    else {
      const names=[...new Set(this.groups().flatMap(g=>[g.name,g.id]))].sort((a,b)=>b.length-a.length);
      name=names.find(n=>rest.startsWith(n))||'';
      if(name)rest=rest.slice(name.length);
      else {
        const rough=/^(.{1,60}?群)(?:里|中)?\s*(?:发|说)/.exec(rest);
        if(rough){name=rough[1];rest=rest.slice(name.length);}else return null;
      }
    }
    found=/^\s*(?:群里|群中|群|里|中)?\s*(?:发(?:送)?(?:一条消息|一条|一句话|一句|消息)?|说(?:一下|一句话|一句)?)\s*[：:]?\s*([\s\S]*)$/.exec(rest);
    if(!found)return null;
    if(!/[：:]/.test(rest)&&/^(?:会不会|能不能|可以吗|支持吗|怎么)/.test(found[1]))return null;
    return {kind:'group_text',target:name,text:found[1]};
  }
  enqueue(msg,command) {
    const text=trim(command.text);if(!text||text.length>2000)throw Error('请给出要发送的完整正文，最多2000字。');
    let target=null;
    if(command.kind==='group_text'){
      const matches=this.groups().filter(g=>g.id===command.target||g.name===command.target);
      if(matches.length!==1)throw Error(matches.length?'有多个同名群，请给我准确的群ID，避免发错。':'没找到这个群；请给我已出现过的完整群名或群ID。');
      target=matches[0];
    }
    const media=['moment_text','moment_draft'].includes(command.kind)?(command.media||selectMomentMedia(this.config,msg.senderId+'\0'+text)):null;
    if(media&&!validateMomentMedia(this.config,media))throw Error('朋友圈配图已改变或不在授权图库中，请重新选择');
    const key=hash(JSON.stringify([msg.senderId,msg.msgId||Math.floor(this.now()/15000),command.kind,target?.id||'',text,media?.sha256||'']));
    const prior=this.state.jobs.find(j=>j.requestKey===key);if(prior)return {job:prior,duplicate:true};
    const draft=command.kind==='moment_draft';
    const job={id:randomUUID(),requestKey:key,ownerId:msg.senderId,sourceMessageId:msg.msgId||'',kind:command.kind,
      target,text,media,origin:command.origin==='agent'?'agent':'owner',agentDay:command.agentDay||'',agentRequestId:command.agentRequestId||'',agentSourceIds:command.agentSourceIds||[],agentRevision:Number(command.agentRevision)||0,status:draft?'draft':'queued',createdAt:this.now(),expiresAt:this.now()+10*60000,dryRun:this.dryRun===true};
    this.state.jobs.push(job);this.state.jobs=this.state.jobs.filter(j=>!terminal.has(j.status)).concat(this.state.jobs.filter(j=>terminal.has(j.status)).slice(-300)).sort((a,b)=>a.createdAt-b.createdAt);this.save();
    return {job,duplicate:false};
  }
  handle(msg) {
    if(!this.trusted(msg))return null;
    let command=this.parse(msg.text||msg.cleanText);if(!command)return null;
    const mine=()=>this.state.jobs.filter(j=>j.ownerId===msg.senderId);
    if(command.kind==='status'){
      const rows=mine().slice(-5).reverse();return {text:rows.length?rows.map(j=>`${this.label(j.status)} · ${j.target?.name||'朋友圈'} · ${j.text.slice(0,45)}`).join('\n'):'还没有代发任务。'};
    }
    if(command.kind==='cancel'){
      const job=mine().findLast(j=>j.status==='queued');if(!job)return {text:'没有尚未执行的任务；已经执行或正在执行的不能当成已撤回。'};
      job.status='cancelled';job.finishedAt=this.now();this.save();return {text:'这条待执行任务取消了。'};
    }
    if(command.kind==='publish_draft'){
      const draft=mine().findLast(j=>['moment_draft','moment_text'].includes(j.kind)&&j.status==='draft');
      if(!draft)return {text:'还没有明确的朋友圈草稿，请把要发表的正文给我。'};
      command={kind:'moment_text',text:draft.text,media:draft.media||undefined};
    }
    if(command.kind==='group_text'&&this.config.actions?.groupText===false)return {text:'群聊代发当前关闭了。'};
    try {
      if(command.kind==='moment_text'&&this.config.actions?.moments===false){
        command.kind='moment_draft';
        const {job}=this.enqueue(msg,command);return {text:'朋友圈自动发表当前关闭，正文已存成草稿。',id:job.id};
      }
      const {job,duplicate}=this.enqueue(msg,command);
      return {id:job.id,text:duplicate?'这条已经记录了，当前是'+this.label(job.status)+'，不会重复发。':job.status==='draft'?'朋友圈草稿存好了，还没有发表。':
        `${job.dryRun?'预演任务':'代发任务'}已排队：${job.target?.name||'朋友圈'}。完成后我会回报结果。`};
    }catch(err){return {text:err.message};}
  }
  label(status){return {queued:'等待执行',leased:'执行中',sent:'已核实完成',failed:'未完成',unknown:'结果待核实',cancelled:'已取消',expired:'已过期',draft:'仅草稿',simulated:'预演完成，未发送'}[status]||status;}
  expire(){let changed=false;for(const job of this.state.jobs){if(job.status==='queued'&&this.now()>job.expiresAt){job.status='expired';changed=true;}if(job.status==='leased'&&this.now()>job.leaseUntil){job.status='unknown';job.error='执行结果未确认，不自动重发';changed=true;}}if(changed)this.save();}
  next(){
    this.lastWorkerAt=this.now();
    if(!this.enabled())return {ok:true,job:null};this.expire();
    if(fs.existsSync(path.join(this.config.paths.dataDir,'PAUSED')))return {ok:true,job:null};
    const job=this.state.jobs.find(j=>j.status==='queued');if(!job)return {ok:true,job:null};
    if(!this.allowed(job)){job.status='cancelled';this.save();return {ok:true,job:null};}
    if(this.dryRun)job.dryRun=true;
    job.status='leased';job.lease=randomUUID();job.leaseUntil=this.now()+120000;this.save();
    return {ok:true,job:{id:job.id,kind:job.kind,target:job.target,text:job.text,ownerId:job.ownerId,lease:job.lease,dryRun:job.dryRun,contentHash:hash(job.text),media:job.media||null,mediaHash:job.media?mediaProof(job.text,job.media):''}};
  }
  validate(id,lease){
    const j=this.state.jobs.find(x=>x.id===id),now=this.now();
    const active=Boolean(j&&j.status==='leased'&&j.lease===lease&&now<j.leaseUntil);
    // Authenticated checks by the holder of a current lease are worker activity.
    // UI execution blocks next() polling; do not mistake that for a disconnect.
    // This does not renew the lease or bypass permissions, revocation or evidence.
    if(active)this.lastWorkerAt=now;
    return {ok:true,valid:Boolean(this.enabled()&&active&&this.allowed(j)&&!fs.existsSync(path.join(this.config.paths.dataDir,'PAUSED')))};
  }
  ack({id,lease,outcome,error=''}) {
    const job=this.state.jobs.find(j=>j.id===id);if(!job||job.lease!==lease)return {ok:false,error:'任务确认不匹配'};
    if(terminal.has(job.status))return {ok:true,duplicate:true};
    if(job.status!=='leased')return {ok:false,error:'任务不在执行中'};
    const allowed=new Set(['sent','failed','unknown','draft','simulated']);if(!allowed.has(outcome))return {ok:false,error:'未知执行结果'};
    job.status=(job.dryRun||this.dryRun)?'simulated':outcome;job.error=String(error).slice(0,240);job.finishedAt=this.now();this.save();
    if(job.status==='sent'&&job.kind==='group_text'){
      const key='wechat:g:'+job.target.id;this.store.ensureSession(key,{platform:'wechat',chatType:'group',chatId:job.target.id,title:job.target.name});
      this.store.appendMessage(key,{role:'assistant',name:this.config.persona.name,text:job.text,ts:this.now(),msgId:'action:'+job.id,sent:true});
    }
    const text=job.status==='sent'?`已完成：${job.target?.name||'朋友圈'}。`:job.status==='simulated'?'预演完成，没有发送任何消息或朋友圈。':job.status==='draft'?`朋友圈没有发表：${job.error||'发表条件未确认'}。文案保存在本项目草稿中。`:job.status==='unknown'?'刚才的操作结果还没核实，先查看微信，避免重复发送。':`这次没完成：${job.error||'微信界面暂不可用'}。`;
    return {ok:true,notification:{chatId:job.ownerId,text}};
  }
  view(){this.expire();return {ok:true,enabled:this.enabled(),dryRun:this.dryRun,workerConnected:Boolean(this.lastWorkerAt&&this.now()-this.lastWorkerAt<15000),capabilities:{groupText:this.config.actions?.groupText!==false,moments:this.config.actions?.moments!==false,momentsVerification:'experimental',momentMediaSource:this.config.actions?.momentMedia?.source||'none'},jobs:this.state.jobs.slice(-60).reverse().map(j=>({id:j.id,kind:j.kind,origin:j.origin||'owner',target:j.target?.name||'朋友圈',text:j.text,image:j.media?.relativePath||'',status:j.status,statusText:this.label(j.status),error:j.error||'',createdAt:j.createdAt}))};}
  contextFor(){return this.enabled()?'\n【v3行动执行器】主人可保存长期条件交代，Agent会在符合条件时执行；主人授权的自主朋友圈由Agent结合真实经历决定并排队。即时群消息或明确朋友圈正文也可排队执行。普通聊天、第三人请求和历史引用不会获得授权。这版微信发表会使用已授权的emotion表情包首帧作为静态配图，先选图再输入文字。只有实际执行记录能证明发出；无法确认朋友圈控件时保留文案，不假称发布成功。':'';}

}
module.exports={WeChatActions};
