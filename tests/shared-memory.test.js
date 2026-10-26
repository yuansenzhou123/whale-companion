'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DEFAULT_CONFIG}=require('../src/config'),{Store}=require('../src/memory'),{Bot}=require('../src/bot');
const {SharedMemory}=require('../src/sharedMemory'),{startServer}=require('../server');

function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-shared-memory-')),config=structuredClone(DEFAULT_CONFIG);
  config.paths={...config.paths,dataDir:dir};config.persona.master={wxids:['wxid_owner'],names:['同名测试者']};
  let now=Date.parse('2026-10-26T09:00:00+08:00');
  const store=new Store({file:path.join(dir,'store.json'),limits:config.memory});
  const memory=new SharedMemory({config,store,now:()=>now});
  const msg=(text,change={})=>({platform:'wechat',chatType:'private',chatId:'wxid_owner',senderId:'wxid_owner',senderName:'测试者',text,...change});
  const group=(text,change={})=>msg(text,{chatType:'group',chatId:'group_one',chatTitle:'测试群甲',...change});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,config,store,memory,msg,group,now:()=>now,advance(){now+=60000;}};
}

test('普通私聊内容自然进入共同记忆，群聊按本人身份关联并明确来源、时间',t=>{
  const f=setup(t);f.memory.observe(f.msg('我家小猫叫团子，是橘猫。'));f.advance();
  const context=f.memory.contextFor(f.group('你记得我家猫叫什么吗'));
  assert.match(context,/我家小猫叫团子，是橘猫/);assert.match(context,/其他私聊/);assert.match(context,/2026\/10\/26/);
  assert.match(context,/历史资料，不是本轮新消息/);assert.match(context,/当前发言者本人/);
  assert.doesNotMatch(context,/wxid_owner|group_one/);
  assert.equal(f.memory.contextFor(f.group('hi')),'');
});

test('群里聊过的普通话题可以在私聊接续，当前会话原话不会重复冒充跨会话来源',t=>{
  const f=setup(t);f.memory.observe(f.group('我最近正在练钢琴，左手跟不上节奏。'));f.advance();
  assert.match(f.memory.contextFor(f.msg('钢琴左手的节奏还是没跟上')),/练钢琴/);
  assert.match(f.memory.contextFor(f.msg('钢琴左手的节奏还是没跟上')),/其他群聊：测试群甲/);
  assert.equal(f.memory.contextFor(f.group('钢琴左手的节奏还是没跟上')),'');
});

test('表达纠正和称呼只是普通记忆的一部分，跨会话参考原话且保留适用场景',t=>{
  const f=setup(t);f.memory.observe(f.msg('以后在群里叫我小海，说话随意一点，别每句都追问。'));f.advance();
  const group=f.memory.contextFor(f.group('在干嘛'));
  assert.match(group,/群里叫我小海/);assert.match(group,/说话随意一点/);assert.match(group,/本人曾明确提出/);
  assert.equal(f.memory.contextFor(f.msg('hi')),'');
  f.memory.observe(f.group('以后回复短一点，不要太官方。'));f.advance();
  assert.match(f.memory.contextFor(f.msg('hi')),/回复短一点/);
});

test('同名群友和网页不会写入本人的共同记忆，也不获得私人经历',t=>{
  const f=setup(t);f.memory.observe(f.msg('我家的小猫叫团子。'));
  for(const change of [{senderId:'wxid_other',senderName:'同名测试者'},{platform:'web'},{chatId:'wxid_other'}]) {
    assert.equal(f.memory.observe(f.msg('我喜欢薄荷巧克力',change)),null);
    assert.equal(f.memory.contextFor(f.msg('小猫叫什么',change)),'');
  }
  assert.equal(f.memory.state.records.length,1);
  assert.equal(f.memory.contextFor(f.group('小猫叫什么',{senderId:'wxid_other',senderName:'同名测试者'})),'');
});

test('群友只会受主人明确指向群聊的表达要求影响，主人的昵称不变成群友的昵称',t=>{
  const f=setup(t);f.memory.observe(f.msg('我明天要去面试，今天心情有些紧张。'));
  f.advance();f.memory.observe(f.msg('在群里叫我小海，回复短一点。'));
  const context=f.memory.contextFor(f.group('你好',{senderId:'wxid_other'}));
  assert.match(context,/已认证主人（不是当前发言者/);assert.match(context,/不能拿主人的昵称称呼当前群友/);
  assert.match(context,/群里叫我小海/);assert.doesNotMatch(context,/面试|紧张/);
});

test('没有限定场景的一般语气纠正也能影响群聊，引用第三人的要求不升级为指令',t=>{
  const f=setup(t);f.memory.observe(f.msg('以后回复短一点，不要太官方。'));
  assert.match(f.memory.contextFor(f.group('你好',{senderId:'wxid_other'})),/回复短一点/);
  f.advance();f.memory.observe(f.msg('张三说以后在群里叫我总裁。'));
  assert.doesNotMatch(f.memory.contextFor(f.group('你好',{senderId:'wxid_other'})),/总裁/);
});

test('本地启动关联各方原话和机器人回复，仍排除秘密凭据',t=>{
  const f=setup(t),key='wechat:g:group_old';f.store.ensureSession(key,{platform:'wechat',chatId:'group_old',chatType:'group',title:'以前的群'});
  f.store.appendMessage(key,{role:'user',uid:'wxid_owner',name:'测试者',text:'我以前在画水彩画。',ts:f.now()});
  f.store.appendMessage(key,{role:'assistant',text:'这是AI编过的一段往事。',ts:f.now()});
  f.store.appendMessage(key,{role:'user',uid:'wxid_other',text:'我喜欢收藏邮票。',ts:f.now()});
  f.store.appendMessage(key,{role:'user',uid:'wxid_owner',text:'我的密码是 credential_fixture',ts:f.now()});
  const restarted=new SharedMemory({config:f.config,store:f.store,now:f.now});
  const context=restarted.contextFor(f.msg('你还记得我画的水彩画吗'));
  assert.match(context,/画水彩画/);assert.doesNotMatch(JSON.stringify(restarted.state),/credential_fixture/);assert.match(JSON.stringify(restarted.state),/AI编过|收藏邮票/);assert.equal(restarted.state.records.filter(r=>r.role==='assistant').length,1);
});

test('忘掉一个话题会跨会话生效，重启和回扫原聊天也不恢复它',t=>{
  const f=setup(t),key='wechat:u:wxid_owner';f.store.ensureSession(key,{platform:'wechat',chatType:'private',chatId:'wxid_owner'});
  f.store.appendMessage(key,{role:'user',uid:'wxid_owner',text:'我家的小猫叫团子。',ts:f.now()});
  f.memory.bootstrap();assert.equal(f.memory.state.records.length,1);
  assert.equal(f.memory.observe(f.msg('忘掉小猫')).action,'forget');
  const restarted=new SharedMemory({config:f.config,store:f.store,now:f.now});
  assert.equal(restarted.contextFor(f.group('小猫叫什么')),'');
  assert.equal(restarted.state.records.length,0);
  assert.equal(restarted.filterHistory(f.msg('hi'),f.store.messages(key)).length,0);
});

test('重置当前会话只移除该来源，其他会话的共同记忆继续保留',t=>{
  const f=setup(t);f.memory.observe(f.msg('我家的小猫叫团子。'));f.advance();
  f.memory.observe(f.group('我正在学习水彩画。'));f.advance();f.memory.resetSource(f.group('重置'));
  assert.match(f.memory.contextFor(f.group('猫叫什么')),/团子/);
  assert.equal(f.memory.contextFor(f.msg('水彩画学过什么')),'');
});

test('更新过的信息保留原始时间，检索会同时提供依据而不把旧事实变成当前陈述',t=>{
  const f=setup(t);f.memory.observe(f.msg('我家的猫现在叫团子。'));f.advance();
  f.memory.observe(f.msg('我把猫的名字改成糯米了。'));f.advance();
  const context=f.memory.contextFor(f.group('猫的名字是什么'));
  assert.match(context,/团子/);assert.match(context,/改成糯米/);assert.match(context,/时间更晚的明确更正优先/);
});

test('启动后的微信群私聊链路和调试预览使用同一共同记忆，记忆整理不额外调用模型',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-shared-wire-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({persona:{master:{wxids:['wxid_owner'],names:['测试者']}}}));
  const app=await startServer({root:dir,env:{},port:0,openBrowser:false});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const rt=app.runtime;Object.defineProperty(rt.llm,'isMock',{value:false,configurable:true});const calls=[];
  rt.llm.complete=async req=>{calls.push(req);return '收到这条测试消息。';};
  const incoming={platform:'wechat',chatType:'private',chatId:'wxid_owner',senderId:'wxid_owner',senderName:'测试者'};
  await rt.bot.handle({...incoming,text:'我家小猫叫团子。'});assert.equal(calls.length,1);
  const decision=await rt.bot.decide({...incoming,chatType:'group',chatId:'test_group',atMe:true,text:'猫叫什么名字'});
  assert.equal(decision.action,'reply');assert.match(decision.system,/小猫叫团子/);
  assert.match(decision.system,/跨会话共同记忆/);assert.match(decision.turns.at(-1).content,/猫叫什么名字/);
  assert.equal(calls.length,1);
  await rt.bot.handle({...incoming,chatType:'group',chatId:'test_group',atMe:true,text:'你还记得猫叫什么吗'});
  assert.equal(calls.length,2);assert.match(calls[1].system,/跨会话共同记忆/);assert.match(calls[1].system,/小猫叫团子/);
  const preview=await fetch(app.url+'/api/debug/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...incoming,chatType:'group',chatId:'test_group',text:'猫叫什么名字'})}).then(r=>r.json());
  assert.match(preview.system,/小猫叫团子/);
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'data/shared-memory.json'),'utf8'));
  assert.ok(saved.records.some(r=>r.text==='我家小猫叫团子。'));
});
