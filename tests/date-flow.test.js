'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DEFAULT_CONFIG}=require('../src/config');
const {Store}=require('../src/memory');
const {Bot}=require('../src/bot');
const {WatchCompanion}=require('../src/watchCompanion');
const {Relationship}=require('../src/relationship');
const {ProactiveChat}=require('../src/proactive');
const {startServer}=require('../server');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-date-flow-'));
  const config=structuredClone(DEFAULT_CONFIG);config.paths={root:dir,dataDir:dir,storeFile:path.join(dir,'store.json')};
  config.persona.master={wxids:['wxid_owner'],names:['主人']};config.gateway.wechat.enabled=true;config.proactiveChat.enabled=true;
  let now=Date.parse('2026-10-25T12:00:00+08:00');const calls=[];
  const llm={isMock:false,model:'test',complete:async req=>{calls.push(req);return req.system.includes('时段已结束')?'今天先收好啦，刚才那只猫本鱼还惦记着～':'刚才你说的小事，本鱼听进去啦～';}};
  const store=new Store({file:config.paths.storeFile,limits:config.memory});
  const companion=new WatchCompanion({config,store,llm,vision:{describe:async()=>''},now:()=>now});
  const relation=new Relationship({config,store,companion,now:()=>now});companion.relationship=relation;
  relation.update('wxid_owner',{enabled:true,autoRemember:false,naturalDates:false});
  const bot=new Bot({config,store,llm,now:()=>new Date(now)});bot.relationship=relation;
  const proactive=new ProactiveChat({config,store,bot,llm,companion,relationship:relation,now:()=>new Date(now)});
  const key='wechat:u:wxid_owner',msg={platform:'wechat',chatId:'wxid_owner',chatType:'private',senderId:'wxid_owner',senderName:'主人',isMaster:true};
  const session=store.ensureSession(key,{platform:'wechat',chatId:'wxid_owner',chatType:'private'});
  store.appendMessage(key,{role:'user',uid:'wxid_owner',name:'主人',text:'今天刚把养的小猫接回家啦',ts:now-65*60000});
  const user=(text='好呀')=>{now+=1000;store.appendMessage(key,{role:'user',uid:'wxid_owner',name:'主人',text,ts:now});};
  const assistant=(text='嗯嗯，接着说～')=>{now+=1000;store.appendMessage(key,{role:'assistant',text,ts:now});};
  t.after(()=>{companion.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,config,llm,calls,store,companion,relation,bot,proactive,key,msg,session,user,assistant,now:()=>now,advance(s){now+=s*1000;}};
}
async function invite(f) {const {message}=await f.proactive.next();assert.ok(message);f.proactive.ack(message.id,true);return message;}

test('主动邀请明确写明活动和时长，成功确认后才可接受，不直接开始约会',async t=>{
  const f=fixture(t),message=await invite(f),p=f.relation.profile('wxid_owner');
  assert.match(message.text,/十五分钟/);assert.match(message.text,/好不好|要不要/);
  assert.equal(f.calls.length,0);assert.equal(p.invitation.status,'delivered');assert.equal(p.activeDate,null);
  assert.equal(f.session.messages.at(-1).msgId,message.id);
  assert.equal((await f.proactive.next()).message,null);
  f.advance(1);const result=await f.bot.decide({...f.msg,text:'好呀'});
  assert.equal(result.reason,'relationship_command');assert.equal(p.activeDate.kind,'chat');assert.equal(p.invitation.status,'accepted');assert.match(result.canned,/15/);
  assert.equal(p.activeDate.events.opening.status,'replied');
});
test('婉拒后不再催问，48小时内不会再次邀请',async t=>{
  const f=fixture(t);await invite(f);f.user('改天吧');
  assert.match(f.relation.handleInput({...f.msg,text:'改天吧'},f.session),/先不占/);
  assert.equal(f.relation.profile('wxid_owner').invitation.status,'declined');
  f.advance(24*3600);f.user('今天我看了一只会开门的小猫');f.advance(61*60);
  assert.equal(f.relation.flow.invitationFor(f.session),null);
  f.advance(24*3600);f.user('今天我看了一只会开门的小猫');f.advance(61*60);
  assert.ok(f.relation.flow.invitationFor(f.session));
});
test('无回复、失去确认、发送失败和过期邀请均不会擅自开始或重发',async t=>{
  const f=fixture(t);const {message}=await f.proactive.next();
  assert.equal(f.relation.profile('wxid_owner').invitation.status,'claimed');
  assert.equal(f.relation.handleInput({...f.msg,text:'好呀'},f.session),null);
  f.proactive.ack(message.id,false);assert.equal(f.relation.profile('wxid_owner').invitation.status,'failed');
  assert.equal(f.relation.profile('wxid_owner').activeDate,null);
  f.advance(61*60);assert.equal(f.relation.flow.invitationFor(f.session),null);
  f.advance(49*3600);f.user('今天又想和你说一点小事情');f.advance(61*60);await invite(f);
  f.advance(2*3600+1);f.relation.tick();assert.equal(f.relation.profile('wxid_owner').invitation.status,'expired');
  assert.equal(f.relation.handleInput({...f.msg,text:'好呀'},f.session),null);
  assert.equal(f.relation.profile('wxid_owner').activeDate,null);
});
test('普通对话里的“好呀”和第三方身份不会被认成接受邀请',async t=>{
  const f=fixture(t);await invite(f);
  assert.equal(f.relation.handleInput({...f.msg,senderId:'wxid_other',text:'好呀'},f.session),null);
  assert.equal(f.relation.handleInput({...f.msg,platform:'web',text:'好呀'},f.session),null);
  f.user('小猫今天特别闹腾');assert.equal(f.relation.handleInput({...f.msg,text:'小猫今天特别闹腾'},f.session),null);
  assert.equal(f.relation.profile('wxid_owner').invitation.status,'dismissed');
  f.assistant('它喜欢新家吗');f.user('好呀');assert.equal(f.relation.handleInput({...f.msg,text:'好呀'},f.session),null);
  assert.equal(f.relation.profile('wxid_owner').activeDate,null);
});
test('否定或含糊的答复不会触发接受，并能单独关闭主动邀约',async t=>{
  const f=fixture(t);await invite(f);
  f.user('好呀，不过改天再说');assert.equal(f.relation.handleInput({...f.msg,text:'好呀，不过改天再说'},f.session),null);
  assert.equal(f.relation.profile('wxid_owner').activeDate,null);
  assert.match(f.relation.handleInput({...f.msg,text:'别主动约我'},f.session),/等你/);
  assert.equal(f.relation.profile('wxid_owner').autoInvites,false);
  f.relation.handleInput({...f.msg,text:'可以主动约我'},f.session);assert.equal(f.relation.profile('wxid_owner').autoInvites,true);
});
test('到期关心事项优先于邀约；忙碌和结束陪伴不触发新邀请',async t=>{
  const f=fixture(t);f.relation.addConcern('wxid_owner','下午的考试',f.now());await invite(f);
  assert.equal(f.relation.profile('wxid_owner').invitation,null);assert.equal(f.calls.length,1);
  for(const text of ['今天我很忙没空说话','今天就先到这里吧','我现在不想聊这些','晚安我要睡觉啦']) {
    f.user(text);assert.equal(f.relation.flow.invitationFor(f.session),null);
  }
});
test('邀请种类采用本人上下文，未经授权的陪看关联不提出视频约会',t=>{
  const f=fixture(t);f.user('今天看了一个特别好玩的B站视频');
  assert.equal(f.relation.flow.invitationFor(f.session).dateKind,'watch');
  f.companion.settings.ownerId='';assert.equal(f.relation.flow.invitationFor(f.session).dateKind,'chat');
  f.user('今天好累好疲惫，想静静');assert.equal(f.relation.flow.invitationFor(f.session).dateKind,'quiet');
});
test('页面开始约会有开场，聊天中段有一次接话，结束可道别且不会重复回访',async t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','chat',5);
  assert.match(f.companion.state().dateScene.bubble.text,/5/);
  let {message}=await f.proactive.next();assert.ok(message);f.proactive.ack(message.id,true);
  assert.equal(f.relation.profile('wxid_owner').activeDate.events.opening.status,'delivered');
  f.advance(1);f.user('刚才小猫把门打开了，笑死我了');f.assistant();f.advance(150);
  ({message}=await f.proactive.next());assert.ok(message);assert.match(f.calls.at(-1).system,/接着这次聊天/);f.proactive.ack(message.id,true);
  assert.equal(f.relation.profile('wxid_owner').activeDate.events.middle.status,'delivered');
  f.user('它还一脸无辜地看着我');f.assistant();f.advance(160);
  ({message}=await f.proactive.next());assert.ok(message);assert.match(f.calls.at(-1).system,/时段已结束/);assert.match(f.calls.at(-1).turns.at(-1).content,/收尾道别/);f.proactive.ack(message.id,true);
  const p=f.relation.profile('wxid_owner');assert.equal(p.activeDate,null);assert.equal(p.dates.at(-1).events.closing.status,'delivered');assert.equal(p.dates.at(-1).followupClaimed,true);
  assert.equal(f.session.state.proactiveChat.count,3);assert.equal((await f.proactive.next()).message,null);
});
test('没有回应开场时不插话不追问，仍有桌宠收尾；旧约会结束不会补发过期道别',async t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','chat',5);await invite(f);
  f.advance(301);f.relation.tick();assert.equal((await f.proactive.next()).message,null);
  assert.equal(f.companion.state().dateScene.phase,'closing');
  f.advance(16*60);f.user('刚才我去处理一点事情了');f.advance(91);
  assert.equal(f.relation.flow.eventFor(f.session),null);
});
test('安静陪伴跳过中段互动，取消后清掉气泡和在途事件',async t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','quiet',5,{source:'wechat'});
  f.user('嗯嗯我先写点东西');f.assistant();f.advance(160);
  assert.equal(f.relation.flow.eventFor(f.session),null);assert.equal(f.companion.state().dateScene.kind,'quiet');
  f.relation.finishDate('wxid_owner','cancelled');assert.equal(f.companion.state().dateScene,null);
  assert.equal(f.relation.flow.eventFor(f.session),null);
});
test('视频中段没有实际画面就保持安静，有片段才接话且不带约会前画面',t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','watch',5,{source:'wechat'});const started=f.now();
  f.user('这只小猫表情真的好好笑');f.assistant();f.advance(160);
  assert.equal(f.relation.flow.eventFor(f.session),null);
  f.companion.memories.push({id:'actual',ownerId:'wxid_owner',title:'猫猫片段',lastAt:f.now(),watchedSeconds:80,observations:[{recordedAt:started-1,text:'不属于本次的旧画面'},{recordedAt:f.now(),text:'小猫正在开门'}]});
  const event=f.relation.flow.eventFor(f.session);assert.equal(event.phase,'middle');assert.match(event.text,/小猫正在开门/);assert.doesNotMatch(event.text,/旧画面/);
});
test('约会事件仍受暂停、静音、夜间和每日三次限制',async t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','chat',5);
  f.session.state.mutedUntil=f.now()+60000;assert.equal((await f.proactive.next()).message,null);f.session.state.mutedUntil=0;
  fs.writeFileSync(path.join(f.dir,'PAUSED'),'');assert.equal((await f.proactive.next()).message,null);fs.unlinkSync(path.join(f.dir,'PAUSED'));
  f.session.state.proactiveChat={day:'2026-10-25',count:3};assert.equal((await f.proactive.next()).message,null);f.session.state.proactiveChat=null;
  f.config.proactiveChat.enabled=false;assert.equal((await f.proactive.next()).message,null);f.config.proactiveChat.enabled=true;
  f.advance(10*3600);assert.equal((await f.proactive.next()).message,null);
});
test('日期状态与待答邀请跨重启保留，发送确认重复到达不重复记账',async t=>{
  const f=fixture(t),message=await invite(f);f.proactive.ack(message.id,true);
  const other=new Relationship({config:f.config,store:f.store,companion:f.companion,now:f.now});
  assert.equal(other.profile('wxid_owner').invitation.status,'delivered');assert.equal(f.session.state.proactiveChat.count,1);
  f.user('好呀');assert.match(other.handleInput({...f.msg,text:'好呀'},f.session),/15/);
  const again=new Relationship({config:f.config,store:f.store,companion:f.companion,now:f.now});assert.equal(again.profile('wxid_owner').activeDate.kind,'chat');
});
test('中段生成期间用户结束约会，丢弃在途回复，不发送过期互动',async t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','chat',5,{source:'wechat'});f.user('小猫已经睡着了哈哈');f.assistant();f.advance(160);
  let release;f.llm.complete=()=>new Promise(resolve=>{release=resolve;});
  const work=f.proactive.next();assert.ok(release);f.relation.finishDate('wxid_owner','cancelled');release('还在看小猫呀');
  assert.equal((await work).message,null);assert.equal(f.session.state.proactiveChat.pending,undefined);
});
test('邀请响应 API 校验身份、决定和过期状态，页面接受也只开始一次',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-date-api-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({persona:{master:{wxids:['wxid_owner']}}}));
  const app=await startServer({root:dir,env:{},port:0,openBrowser:false});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const pair=await(await fetch(app.url+'/api/companion/bootstrap')).json(),headers={Authorization:'Bearer '+pair.token,'Content-Type':'application/json'};
  const r=app.runtime.relationship;r.update('wxid_owner',{enabled:true});
  const p=r.profile('wxid_owner');p.invitation={id:'test',dateKind:'chat',minutes:15,status:'delivered',expiresAt:Date.now()+60000};r.changed(p);
  const post=body=>fetch(app.url+'/api/companion/relationship/invitation/respond',{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post({ownerId:'wxid_other',decision:'accept'})).status,400);
  assert.equal((await post({ownerId:'wxid_owner',decision:'maybe'})).status,400);
  const accepted=await post({ownerId:'wxid_owner',decision:'accept'});assert.equal(accepted.status,200);assert.equal((await accepted.json()).profile.activeDate.kind,'chat');
  assert.equal((await post({ownerId:'wxid_owner',decision:'accept'})).status,400);
});

test('多轮婉拒后仍能在冷却到期重新邀请，固定措辞不会被永久去重',async t=>{
  const f=fixture(t);
  for(let i=0;i<3;i++) {
    const message=await invite(f);assert.match(message.text,/十五分钟/);
    f.user('改天吧');f.relation.handleInput({...f.msg,text:'改天吧'},f.session);
    if(i<2){f.advance(48*3600+1);f.user('今天有件和小猫有关的小事想说');f.advance(61*60);}
  }
  assert.equal(f.relation.profile('wxid_owner').invitation.status,'declined');
});
test('约会阶段发送失败不连续重试，延迟确认不能复活已经取消的气泡',async t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','chat',5);
  const {message}=await f.proactive.next();f.proactive.ack(message.id,false);
  assert.equal((await f.proactive.next()).message,null);
  f.user('这只猫居然会自己开门了');f.assistant();f.advance(160);
  const mid=(await f.proactive.next()).message;assert.ok(mid);
  f.relation.finishDate('wxid_owner','cancelled');f.proactive.ack(mid.id,true);
  assert.equal(f.companion.state().dateScene,null);
});
test('晚到的旧约会收尾确认不覆盖新约会的开场气泡',async t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','chat',5,{source:'wechat'});f.user('今天的事情真的好好笑');f.assistant();f.advance(301);
  const {message}=await f.proactive.next();assert.ok(message);
  f.relation.startDate('wxid_owner','quiet',10,{source:'wechat'});const text=f.relation.profile('wxid_owner').dateBubble.text;
  f.proactive.ack(message.id,true);assert.equal(f.relation.profile('wxid_owner').dateBubble.text,text);
  assert.equal(f.companion.state().dateScene.kind,'quiet');
});

test('过期约会跨重启结束时不冒出新鲜道别气泡，私聊身份检查适用于所有阶段',t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','quiet',5,{source:'wechat'});f.advance(3600);
  const restarted=new Relationship({config:f.config,store:f.store,companion:f.companion,now:f.now});
  assert.equal(restarted.profile('wxid_owner').activeDate,null);assert.equal(restarted.flow.desktopState('wxid_owner'),null);
  for(const change of [{platform:'web'},{chatType:'group'},{chatId:'wxid_other'}]) {
    assert.equal(restarted.flow.invitationFor({...f.session,...change}),null);
    assert.equal(restarted.flow.eventFor({...f.session,...change}),null);
  }
});
test('页面开始后用户先发消息时，普通回复接开场，不再额外重复宣布开始',async t=>{
  const f=fixture(t);f.relation.startDate('wxid_owner','chat',5);f.advance(1);
  await f.bot.decide({...f.msg,text:'今天小猫一直在家里跑来跑去'});
  assert.equal(f.relation.profile('wxid_owner').activeDate.events.opening.status,'replied');
  assert.equal(f.relation.flow.eventFor(f.session),null);
});
