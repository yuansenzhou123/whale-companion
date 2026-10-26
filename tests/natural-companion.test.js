'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DEFAULT_CONFIG}=require('../src/config'),{Store}=require('../src/memory'),{WatchCompanion}=require('../src/watchCompanion'),{Relationship}=require('../src/relationship'),{Bot}=require('../src/bot'),{ProactiveChat}=require('../src/proactive');
const {dueFor}=require('../src/companionMemory');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-natural-')),config=structuredClone(DEFAULT_CONFIG);config.paths={root:dir,dataDir:dir,storeFile:path.join(dir,'store.json')};config.persona.master={wxids:['wxid_owner'],names:['主人']};config.proactiveChat.enabled=true;config.gateway.wechat.enabled=true;
 let now=Date.parse('2026-10-26T12:00:00+08:00');const calls=[];const llm={isMock:false,model:'test',complete:async req=>{calls.push(req);return req.system.includes('记忆整理器')?'{"items":[]}':'你说猫猫总爱趴在屏幕旁，要不要一起看会儿小猫呀？';}};
 const store=new Store({file:config.paths.storeFile,limits:config.memory}),companion=new WatchCompanion({config,store,llm,vision:{describe:async()=>''},now:()=>now}),r=new Relationship({config,store,companion,now:()=>now});companion.relationship=r;r.update('wxid_owner',{enabled:true});
 const bot=new Bot({config,store,llm,now:()=>new Date(now)});bot.relationship=r;const pro=new ProactiveChat({config,store,bot,llm,companion,relationship:r,now:()=>new Date(now)});
 const msg={platform:'wechat',chatType:'private',chatId:'wxid_owner',senderId:'wxid_owner',senderName:'主人',isMaster:true},key='wechat:u:wxid_owner',session=store.ensureSession(key,{platform:'wechat',chatType:'private',chatId:'wxid_owner'});
 const user=async text=>{now+=1000;return bot.decide({...msg,text});};
 t.after(()=>{r.memory.close();companion.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});return {r,config,companion,llm,calls,store,session,key,msg,user,pro,now:()=>now,advance(s){now+=s*1000;}};
}
test('不用记忆命令就记住明确偏好，继续正常回复；同主题的新说法更新旧偏好',async t=>{
 const f=fixture(t);const result=await f.user('我不吃香菜');assert.notEqual(result.reason,'relationship_command');
 assert.equal(f.r.profile('wxid_owner').memories.length,1);assert.match(f.r.contextFor(f.msg),/不吃香菜/);
 await f.user('我现在喜欢吃香菜了');assert.equal(f.r.profile('wxid_owner').memories.length,1);assert.match(f.r.contextFor(f.msg),/喜欢吃香菜/);assert.doesNotMatch(f.r.contextFor(f.msg),/不吃香菜/);
});
test('复杂计划从原话中整理并安排回访，伪造quote、低置信度和越界索引被丢弃',async t=>{
 const f=fixture(t);await f.user('我周五要去交作品，想到就紧张');
 f.llm.complete=async()=>JSON.stringify({items:[{index:0,kind:'event',quote:'我周五要去交作品',topic:'交作品',confidence:.98},{index:0,kind:'preference',quote:'我喜欢吃蛋糕',topic:'蛋糕',confidence:.99},{index:0,kind:'preference',quote:'我周五要去交作品',topic:'交作品',confidence:.2},{index:99,kind:'habit',quote:'我周五要去交作品',topic:'交作品',confidence:1}]});
 await f.r.memory.drain('wxid_owner');const p=f.r.profile('wxid_owner');assert.equal(p.concerns.length,1);assert.equal(p.memories.length,0);assert.equal(p.concerns[0].dueAt,Date.parse('2026-10-30T18:00:00+08:00'));
});
test('群聊、网页、其他用户、第三人转述、假设与凭据均不自动记忆',async t=>{
 const f=fixture(t);for(const change of [{platform:'web'},{chatType:'group'},{senderId:'wxid_other'}])f.r.handleInput({...f.msg,...change,text:'我喜欢吃香菜'},f.session);
 for(const text of ['如果我喜欢吃香菜会怎样','我朋友说他喜欢香菜','我喜欢香菜吗？','我的密码是abc123']){await f.user(text);}
 await f.r.memory.drain('wxid_owner');assert.equal(f.r.profile('wxid_owner').memories.length,0);assert.equal(f.calls.length,0);
});
test('忘掉或删除自动记忆后不会从后续整理中偷偷恢复',async t=>{
 const f=fixture(t);await f.user('我喜欢吃香菜');const p=f.r.profile('wxid_owner');f.r.remove('wxid_owner','memories',p.memories[0].id);await f.user('我喜欢吃香菜');assert.equal(p.memories.length,0);
 await f.user('我喜欢喝奶茶');await f.user('忘掉奶茶的事');assert.equal(p.memories.length,0);await f.user('我喜欢喝奶茶');assert.equal(p.memories.length,0);
});
test('关闭自动记忆会作废正在整理的结果，模型故障不阻塞普通聊天',async t=>{
 const f=fixture(t);await f.user('我每天晚上都喜欢听音乐');let release;f.llm.complete=()=>new Promise(resolve=>{release=resolve;});const work=f.r.memory.drain('wxid_owner');assert.ok(release);
 f.r.update('wxid_owner',{autoRemember:false});release(JSON.stringify({items:[{index:0,kind:'habit',quote:'我每天晚上都喜欢听音乐',topic:'听音乐',confidence:1}]}));await work;assert.equal(f.r.profile('wxid_owner').memories.length,0);
 f.r.update('wxid_owner',{autoRemember:true});f.llm.complete=async()=>{throw Error('offline');};await f.user('我每天下午都会喝咖啡');await f.r.memory.drain('wxid_owner');assert.equal(f.r.profile('wxid_owner').memories.length,0);
});
test('近期焦虑会被记成短期关心，过去的近况会过期，不当永久偏好',async t=>{
 const f=fixture(t);await f.user('我最近有点焦虑');const p=f.r.profile('wxid_owner');assert.equal(p.memories.length,0);assert.equal(p.concerns[0].dueAt,f.now()+3*3600000);
 f.advance(3*86400);f.r.tick();assert.equal(p.concerns[0].status,'expired');
});
test('自然邀约用真实记忆且不强制报分钟，成功后页面保存的正文等于实际发出的正文',async t=>{
 const f=fixture(t);await f.user('我喜欢看猫猫视频');f.advance(65*60);const {message}=await f.pro.next();assert.ok(message);assert.doesNotMatch(message.text,/分钟/);assert.match(f.calls.at(-1).system,/猫猫/);
 f.pro.ack(message.id,true);assert.equal(f.r.profile('wxid_owner').invitation.text,message.text);f.advance(1);const accepted=await f.user('好呀');assert.doesNotMatch(accepted.canned,/分钟/);assert.equal(f.r.profile('wxid_owner').activeDate.natural,true);
});
test('自然陪伴在新消息后继续，用户离开就自然收尾，不需要设置时长',async t=>{
 const f=fixture(t);const answer=await f.user('陪我聊会儿');assert.match(answer.canned,/慢慢/);const p=f.r.profile('wxid_owner'),initial=p.activeDate.endAt;
 f.advance(15*60);await f.user('刚才小猫又把门推开了');assert.ok(p.activeDate.endAt>initial);assert.doesNotMatch(f.r.flow.context('wxid_owner'),/约剩|还剩约/);
 await f.user('我先去忙了');assert.equal(p.activeDate,null);assert.doesNotMatch(p.dateBubble.text,/时间到/);
});
test('真实视频继续播放会延续自然陪看，但超过后台上限仍能结束',async t=>{
 const f=fixture(t);f.r.startDate('wxid_owner','watch',5);const p=f.r.profile('wxid_owner');f.advance(4*60);f.companion.current={playing:true,receivedAt:f.now()};f.r.tick();assert.ok(p.activeDate.endAt>p.activeDate.startedAt+5*60000);
 f.advance(3*3600);f.companion.current.receivedAt=f.now();f.r.tick();assert.equal(p.activeDate,null);
});
test('需要时仍可明确选择定时陪伴，旧档案升级不会凭空补写历史记忆',t=>{
 const f=fixture(t);assert.equal(f.r.profile('wxid_owner').memories.length,0);f.r.startDate('wxid_owner','quiet',5,{natural:false});assert.equal(f.r.profile('wxid_owner').activeDate.natural,false);assert.match(f.r.flow.opening(f.r.profile('wxid_owner').activeDate),/5/);
 assert.equal(dueFor('我明天下午要交作品',f.now()),Date.parse('2026-10-27T18:00:00+08:00'));
});

test('自动记忆关闭时连原有计划识别也停止；心情好转后不继续安排焦虑回访',async t=>{
 const f=fixture(t);f.r.update('wxid_owner',{autoRemember:false});await f.user('我明天上午要面试');assert.equal(f.r.profile('wxid_owner').concerns.length,0);
 f.r.update('wxid_owner',{autoRemember:true});await f.user('我最近有点焦虑');await f.user('我已经好多了');assert.equal(f.r.profile('wxid_owner').concerns[0].status,'resolved');
});
test('模型缺失置信度或索引类型错误时不写入记忆',async t=>{
 const f=fixture(t);await f.user('我每晚都会听音乐放松');f.llm.complete=async()=>JSON.stringify({items:[{index:0,kind:'habit',quote:'我每晚都会听音乐放松',topic:'听音乐'},{index:'0',kind:'habit',quote:'我每晚都会听音乐放松',topic:'听音乐',confidence:.99}]});await f.r.memory.drain('wxid_owner');assert.equal(f.r.profile('wxid_owner').memories.length,0);
});
