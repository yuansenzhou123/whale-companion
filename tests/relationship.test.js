'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {DEFAULT_CONFIG}=require('../src/config');
const {Store}=require('../src/memory');
const {Bot}=require('../src/bot');
const {WatchCompanion}=require('../src/watchCompanion');
const {Relationship,suggestedFollowup}=require('../src/relationship');
const {ProactiveChat}=require('../src/proactive');
const {startServer}=require('../server');

function setup(t,{text='我最近在准备一个有点紧张的面试',complete}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-relationship-'));
  const config=structuredClone(DEFAULT_CONFIG);
  config.paths={root:dir,dataDir:dir,storeFile:path.join(dir,'store.json')};
  config.persona.master={names:['主人甲'],wxids:['wxid_owner']};config.persona.promptMode='compact';
  config.proactiveChat.enabled=true;config.gateway.wechat.enabled=true;config.links.enabled=false;
  let time=Date.parse('2026-10-25T10:00:00+08:00');const calls=[];
  const llm={isMock:false,model:'test',complete:complete||async function(request){calls.push(request);return request.system.includes('本轮输出格式')?' {"emotion":"happy","comment":"这猫也太会装了。"}':'刚才那场面试，后来怎么样啦？';}};
  const store=new Store({file:config.paths.storeFile,limits:config.memory});
  const companion=new WatchCompanion({config,store,llm,vision:{describe:async()=>''},now:()=>time});
  const service=new Relationship({config,store,companion,now:()=>time});
  service.update('wxid_owner',{enabled:true,autoInvites:false,dateFlowEnabled:false,autoRemember:false,naturalDates:false});
  const bot=new Bot({config,store,llm,logger:null,now:()=>new Date(time)});bot.relationship=service;bot.companion=companion;
  const key='wechat:u:wxid_owner';const session=store.ensureSession(key,{platform:'wechat',chatId:'wxid_owner',chatType:'private'});
  store.appendMessage(key,{role:'user',uid:'wxid_owner',name:'主人甲',text,ts:time-65*60000});
  const proactive=new ProactiveChat({config,store,bot,llm,companion,relationship:service,now:()=>new Date(time)});
  const msg={platform:'wechat',chatId:'wxid_owner',chatType:'private',senderId:'wxid_owner',senderName:'主人甲',isMaster:true};
  t.after(()=>{service.memory.close();companion.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,config,calls,llm,store,session,service,companion,proactive,bot,key,msg,now:()=>time,advance(seconds){time+=seconds*1000;}};
}

test('相处偏好只进入真实主人的微信私聊，群聊、同名用户和网页会话均不共享',t=>{
  const f=setup(t);f.service.update('wxid_owner',{nickname:'小蓝'});f.service.addMemory('wxid_owner','喜欢蓝色小鲸鱼');
  assert.match(f.service.contextFor(f.msg),/小蓝/);
  for(const change of [{chatType:'group'},{chatId:'wxid_other'},{senderId:'wxid_other'},{isMaster:false},{platform:'web'}]) {
    const msg={...f.msg,...change};assert.equal(f.service.contextFor(msg),'');
    assert.equal(f.service.handleInput({...msg,text:'以后叫我别人'},f.session),null);
  }
  assert.equal(f.service.profile('wxid_owner').nickname,'小蓝');
  assert.throws(()=>f.service.state('wxid_other'));
});

test('相处档案、明确记忆和表达反馈重启后保留，也可逐条删除',t=>{
  const f=setup(t);f.service.update('wxid_owner',{nickname:'小蓝',closeness:'sweet',comfort:'listen'});
  f.service.addMemory('wxid_owner','我不吃香菜');f.service.feedback('wxid_owner','casual');
  const restarted=new Relationship({config:f.config,store:f.store,companion:f.companion,now:f.now});
  assert.match(restarted.contextFor(f.msg),/我不吃香菜/);assert.match(restarted.contextFor(f.msg),/少用正式套话/);
  restarted.remove('wxid_owner','memories',restarted.profile('wxid_owner').memories[0].id);
  assert.doesNotMatch(restarted.contextFor(f.msg),/香菜/);
  restarted.update('wxid_owner',{enabled:false});assert.equal(restarted.contextFor(f.msg),'');
});

test('自动回访只读取明确的本人计划，并以北京时间计算日期',()=>{
  const now=Date.parse('2026-10-25T00:30:00+08:00');
  assert.equal(suggestedFollowup('我明天上午要面试',now).dueAt,Date.parse('2026-10-26T18:00:00+08:00'));
  assert.equal(suggestedFollowup('明天晚上我要考试',now).dueAt,Date.parse('2026-10-27T09:00:00+08:00'));
  for(const text of ['他明天要面试','如果我明天要面试','我明天可能有考试','你明天要面试吗','明天去考试？'])assert.equal(suggestedFollowup(text,now),null);
});

test('微信设置称呼与表达反馈实际进入聊天链路，不额外调用模型',async t=>{
  const f=setup(t);
  const response=await f.bot.decide({...f.msg,isMaster:undefined,text:'以后叫我小蓝'});
  assert.equal(response.reason,'relationship_command');assert.match(response.canned,/小蓝/);
  await f.bot.decide({...f.msg,text:'这句太官方了'});
  assert.match(f.service.contextFor(f.msg),/少用正式套话/);assert.equal(f.calls.length,0);
  f.service.update('wxid_owner',{autoRemember:true});
  f.service.handleInput({...f.msg,text:'我明天上午要面试'},f.session);
  assert.equal(f.service.profile('wxid_owner').concerns.length,1);
});

test('完成或不想再聊的事情不再回访，也不会从历史里重新拾起',t=>{
  const f=setup(t);
  f.service.addConcern('wxid_owner','我明天上午要面试',f.now());
  f.service.handleInput({...f.msg,text:'不想再聊面试'},f.session);
  assert.equal(f.service.reasonFor(f.session),null);
  f.service.addConcern('wxid_owner','我明天要考试',f.now());
  f.service.handleInput({...f.msg,text:'考试结束了'},f.session);
  assert.equal(f.service.profile('wxid_owner').concerns.at(-1).status,'resolved');
});

test('有具体回访事项才生成消息，发送成功确认前不伪造聊天记录，未回复不追问',async t=>{
  const f=setup(t);f.service.addConcern('wxid_owner','上午的面试',f.now());
  const {message}=await f.proactive.next();assert.ok(message);
  assert.match(f.calls.at(-1).system,/上午的面试/);assert.match(f.calls.at(-1).system,/具体由头/);
  assert.equal(f.session.messages.length,1);assert.equal(f.service.profile('wxid_owner').concerns[0].status,'claimed');
  assert.equal((await f.proactive.next()).message,null);
  f.proactive.ack(message.id,true);
  assert.equal(f.service.profile('wxid_owner').concerns[0].status,'done');assert.equal(f.session.messages.at(-1).proactive,true);
  f.advance(86400);assert.equal((await f.proactive.next()).message,null);
});

test('发送失败恢复回访事项，但仍遵守冷却，不立即重复发送',async t=>{
  const f=setup(t);f.service.addConcern('wxid_owner','上午的面试',f.now());
  const {message}=await f.proactive.next();f.proactive.ack(message.id,false);
  assert.equal(f.service.profile('wxid_owner').concerns[0].status,'open');
  assert.equal((await f.proactive.next()).message,null);
  f.advance(61*60);assert.ok((await f.proactive.next()).message);
});

test('没有具体话题时保持安静，关闭限定选项可恢复原主动聊天行为',async t=>{
  const f=setup(t,{text:'你好'});assert.equal((await f.proactive.next()).message,null);assert.equal(f.calls.length,0);
  f.service.update('wxid_owner',{proactiveWithReason:false});assert.ok((await f.proactive.next()).message);
});

test('生成期间关闭相处功能或删除回访事项，作废尚未返回的消息',async t=>{
  let release;const f=setup(t,{complete:()=>new Promise(resolve=>{release=resolve;})});
  f.service.addConcern('wxid_owner','上午的面试',f.now());
  const work=f.proactive.next();f.service.update('wxid_owner',{enabled:false});release('面试怎么样啦');
  assert.equal((await work).message,null);assert.equal(f.session.state.proactiveChat.pending,undefined);
});

test('日常约会会停止额外主动私信；到时结束后留有冷静间隔，才按原规则回访',async t=>{
  const f=setup(t,{text:'你好'});f.service.startDate('wxid_owner','quiet',5);
  assert.equal((await f.proactive.next()).message,null);
  f.advance(5*60);f.service.tick();assert.equal(f.service.profile('wxid_owner').activeDate,null);
  assert.equal((await f.proactive.next()).message,null);
  f.advance(181);assert.ok((await f.proactive.next()).message);
  assert.match(f.calls.at(-1).system,/安静陪一会儿/);
});

test('看视频约会只保存时段内真实采样的描述，开始前画面不写成这次回忆',async t=>{
  const f=setup(t);f.companion.updateSettings({enabled:true});
  const event=(position,caption)=>({source:'desktop',url:'desktop://bilibili/1234567890abcdef',clientId:'date-test',title:'猫猫片段',position,playing:true,visible:true,caption});
  f.companion.ingest(event(0,'开始以前的片段'));await f.companion.work;
  f.advance(1);f.service.startDate('wxid_owner','watch',5);
  for(let i=1;i<=7;i++){f.advance(10);f.companion.ingest(event(i*10,i===1?'一只猫举起爪子':''));await f.companion.work;}
  f.service.finishDate('wxid_owner');const date=f.service.profile('wxid_owner').dates.at(-1);
  assert.ok(date.videos[0].seconds>=60);assert.match(JSON.stringify(date.videos),/举起爪子/);
  assert.doesNotMatch(JSON.stringify(date.videos),/开始以前/);
});

test('取消和空白的约会不会制造共同经历或安排约会回访',t=>{
  const f=setup(t,{text:'你好'});f.service.startDate('wxid_owner','chat',5);f.advance(6*60);f.service.tick();
  f.advance(181);assert.equal(f.service.reasonFor(f.session),null);
  f.service.startDate('wxid_owner','quiet',5);f.service.finishDate('wxid_owner','cancelled');f.advance(181);
  assert.equal(f.service.reasonFor(f.session),null);
});

test('相处 API 复用本机配对与 Origin 校验，不能读取或修改未认证的用户',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-relation-api-'));
  fs.mkdirSync(path.join(dir,'web'));fs.writeFileSync(path.join(dir,'web/relationship.html'),'<html>慢慢熟悉你</html>');
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({persona:{master:{wxids:['wxid_owner'],names:['主人甲']}}}));
  const app=await startServer({root:dir,env:{},port:0,openBrowser:false});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  assert.equal((await fetch(app.url+'/api/companion/relationship')).status,403);
  const pair=await(await fetch(app.url+'/api/companion/bootstrap')).json();const headers={Authorization:'Bearer '+pair.token,'Content-Type':'application/json'};
  assert.equal((await fetch(app.url+'/api/companion/relationship?ownerId=wxid_other',{headers})).status,400);
  assert.equal((await fetch(app.url+'/api/companion/relationship',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
  const response=await fetch(app.url+'/api/companion/relationship/profile',{method:'POST',headers,body:JSON.stringify({ownerId:'wxid_owner',enabled:true,nickname:'小蓝'})});
  assert.equal(response.status,200);assert.equal((await response.json()).profile.nickname,'小蓝');
  assert.match(await(await fetch(app.url+'/relationship')).text(),/慢慢熟悉你/);
});

test('未来的回访事项不会绕过到期时间从历史里提前问起',t=>{
  const f=setup(t);f.service.addConcern('wxid_owner','我明天上午要面试',f.now()+86400000);
  assert.equal(f.service.reasonFor(f.session),null);
});

test('新的具体事项也不能绕过每天三次的上限',async t=>{
  const f=setup(t,{text:'你好'});
  f.llm.complete=async request=>{f.calls.push(request);return '来关心一下这件事 '+f.calls.length;};
  for(let i=0;i<3;i++){
    f.service.addConcern('wxid_owner','明确事情 '+i,f.now());
    const {message}=await f.proactive.next();assert.ok(message);f.proactive.ack(message.id,true);
    f.advance(1);f.store.appendMessage(f.key,{role:'user',uid:'wxid_owner',name:'主人甲',text:'好呀',ts:f.now()});f.advance(61*60);
  }
  f.service.addConcern('wxid_owner','第四件事',f.now());
  assert.equal((await f.proactive.next()).message,null);assert.equal(f.calls.length,3);
});
