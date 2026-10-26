'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {startServer}=require('../server'),{SharedMemory}=require('../src/sharedMemory');
const body=fs.readFileSync(path.join(__dirname,'../personas/whale-girlfriend-v8.md'),'utf8');

async function fixture(t,{backend}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-dialogue-v2-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({persona:{master:{wxids:['wxid_owner'],names:['主人测试者']}},
    ...(backend?{deepseek:{baseUrl:backend,apiKey:'fixture',model:'fixture'}}:{})}));
  const app=await startServer({root:dir,env:{},port:0,openBrowser:false});
  Object.assign(app.runtime.config.persona,{promptMode:'full',customPrompt:body,historyStyleChangedAt:Date.now()-60000});
  const rt=app.runtime;let time=Date.now()-3600000;
  const add=(id,role,text,{uid,name,group=false}={})=>{
    const key='wechat:'+(group?'g:':'u:')+id;
    rt.store.ensureSession(key,{platform:'wechat',chatId:id,chatType:group?'group':'private',title:group?'测试群':id==='wxid_friend'?'好友测试者':''});
    return rt.store.appendMessage(key,{role,uid:role==='assistant'?'':uid||id,name:name||(role==='assistant'?'鲸鲸':id==='wxid_friend'?'好友测试者':'主人测试者'),text,ts:++time});
  };
  const msg=(text,change={})=>({platform:'wechat',chatType:'private',chatId:'wxid_owner',senderId:'wxid_owner',senderName:'主人测试者',text,...change});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,app,rt,add,msg};
}

test('主人在私聊回忆与别人的对话时，取回对方发言及机器人自己的回复，人物角色准确',async t=>{
  const f=await fixture(t);f.add('wxid_friend','user','请检查ALPHA42的记录。');
  f.add('wxid_friend','assistant','ALPHA42历史回复确认标记。');
  const pack=f.rt.sharedMemory.pack(f.msg('你和好友测试者之前聊了什么？'));
  assert.ok(pack.rows.some(r=>r.发言角色==='assistant'&&r.原话.includes('ALPHA42历史回复')));
  assert.ok(pack.rows.some(r=>r.发言角色==='user'&&r.记忆归属.includes('好友测试者')));
  assert.ok(pack.rows.every(r=>r.来源.includes('其他私聊')));
  const context=f.rt.sharedMemory.contextFor(f.msg('你和好友测试者之前聊了什么？'));
  assert.match(context,/机器人历史回复是可核对的言语证据/);assert.match(context,/不得无依据否认/);
  assert.doesNotMatch(context,/wxid_friend|wxid_owner/);
});

test('本人确认过的多种称号关联检索到同一人，不改变微信身份认证',async t=>{
  const f=await fixture(t);
  f.add('wxid_owner','user','他们提到的云团，cloudcat，蓝团子都是在说我。');
  f.add('wxid_friend','user','cloudcat的那份任务记录在哪里？');
  f.add('wxid_friend','assistant','cloudcat任务记录确认标记。');
  assert.ok(f.rt.sharedMemory.aliases('wxid_owner').includes('cloudcat'));
  const context=f.rt.sharedMemory.contextFor(f.msg('你为什么又和别人说我坏话？'));
  assert.match(context,/cloudcat任务记录确认标记/);assert.match(context,/仅用于理解提及对象，不用于身份认证/);
  assert.equal(f.rt.sharedMemory.eligible(f.msg('hi',{senderId:'wxid_imposter',chatId:'wxid_imposter',senderName:'cloudcat'})),false);
  const identityPack=f.rt.sharedMemory.pack(f.msg('你还记得哪些称号都是指我吗？'));
  assert.ok(identityPack.rows.some(r=>r.原话.includes('都是在说我')));
  assert.ok(identityPack.rows.every(r=>!r.来源.includes('好友测试者')));
});

test('超出最近对话窗口乃至原存档保留数量的旧问答，仍可以从持续索引中找回',async t=>{
  const f=await fixture(t);f.rt.store.limits.maxMessages=6;f.rt.config.chat.historyTurns=4;
  f.add('wxid_owner','user','项目编号是AMBER42。');f.add('wxid_owner','assistant','旧回复确认AMBER42。');
  for(let i=0;i<12;i++){f.add('wxid_owner','user','无关记录'+i);f.add('wxid_owner','assistant','无关回复'+i);}
  assert.doesNotMatch(JSON.stringify(f.rt.store.messages('wechat:u:wxid_owner',100)),/AMBER42/);
  const decision=await f.rt.bot.decide(f.msg('我的项目编号是什么？'));
  assert.match(decision.system,/AMBER42/);assert.match(decision.system,/本会话的更早记录/);
  assert.ok(decision.system.startsWith(body));
});

test('其他好友、同名冒充者和群聊不能获得另外一个私聊的内容',async t=>{
  const f=await fixture(t);f.add('wxid_friend','user','PRIVATE_ONLY_COBALT99');f.add('wxid_friend','assistant','COBALT99助手回复标记');
  const queries=[f.msg('你和好友测试者聊过COBALT99吗',{senderId:'wxid_imposter',chatId:'wxid_imposter',senderName:'主人测试者'}),
    f.msg('COBALT99是什么',{chatType:'group',chatId:'group_one'}),
    f.msg('COBALT99是什么',{chatType:'group',chatId:'group_one',senderId:'wxid_other'})];
  for(const query of queries)assert.doesNotMatch(f.rt.sharedMemory.contextFor(query),/PRIVATE_ONLY_COBALT99|COBALT99助手回复/);
});

test('改过人设的旧回复作为历史证据而非当前语气示例，截图左右不误认当前用户',async t=>{
  const f=await fixture(t);f.add('wxid_friend','user','谈谈DELTA88。');f.add('wxid_friend','assistant','DELTA88旧口吻证据。');
  const pack=f.rt.sharedMemory.pack(f.msg('你和别人聊DELTA88时怎么说的？'));
  assert.ok(pack.rows.some(r=>r.发言角色==='assistant'&&r.旧人设措辞勿模仿));
  const context=f.rt.sharedMemory.contextFor(f.msg('你和别人聊DELTA88时怎么说的？'));
  assert.match(context,/截图里的.*本人\/对方.*只是截图左右位置/);
});

test('v1已有记忆和遗忘标记在迁移后保留，其他发言者新增资料不会复活被忘掉的主题',async t=>{
  const f=await fixture(t);f.add('wxid_owner','user','旧主题TOPAZ77。');f.rt.sharedMemory.forget('wxid_owner','TOPAZ77');
  f.add('wxid_friend','user','TOPAZ77的其他人发言。');
  const state=JSON.parse(fs.readFileSync(path.join(f.dir,'data/shared-memory.json'),'utf8'));state.version=1;
  for(const row of state.records)if(row.uid==='wxid_owner')delete row.role;
  fs.writeFileSync(path.join(f.dir,'data/shared-memory.json'),JSON.stringify(state));
  const migrated=new SharedMemory({config:f.rt.config,store:f.rt.store,relationship:f.rt.relationship});
  assert.equal(migrated.state.version,2);assert.doesNotMatch(migrated.contextFor(f.msg('你和别人聊过TOPAZ77吗')),/旧主题TOPAZ77|TOPAZ77的其他人发言/);
});

test('普通招呼不把别人的对话翻出来，当前消息不会回流成历史回忆',async t=>{
  const f=await fixture(t);f.add('wxid_friend','user','私聊话题NEON22。');f.add('wxid_friend','assistant','NEON22历史回复。');
  assert.equal(f.rt.sharedMemory.contextFor(f.msg('hi')),'');
  f.add('wxid_owner','user','你和别人聊过什么NEON22？');
  const context=f.rt.sharedMemory.contextFor(f.msg('你和别人聊过什么NEON22？'));
  assert.doesNotMatch(context,/"原话":"你和别人聊过什么NEON22/);
});

test('实际模型HTTP请求携带其他人的发言和自身旧回复，并记录记忆条数，不只检查文件存在',async t=>{
  const calls=[];const backend=http.createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{calls.push(JSON.parse(data));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'fixture_response'}}]}));});});
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>backend.close(r)));
  const f=await fixture(t,{backend:'http://127.0.0.1:'+backend.address().port});
  f.add('wxid_friend','user','请回顾测试项目MINT42。');f.add('wxid_friend','assistant','MINT42机器人旧回复证据。');
  const logs=[];f.rt.llm.logger={info:line=>logs.push(line),debug(){},warn(){},error(){}};
  const response=await f.rt.bot.handle(f.msg('你和好友测试者之前聊MINT42时说了什么？'));
  assert.equal(response.action,'reply');assert.notEqual(response.reason,'llm_error');assert.ok(!response.error);assert.ok(calls.length);
  const system=calls[0].messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
  assert.ok(system.startsWith(body));assert.match(system,/MINT42机器人旧回复证据/);assert.match(system,/请回顾测试项目MINT42/);
  assert.ok(logs.some(line=>/memoryOwnReplies/.test(line)&&/memoryOtherSpeakers/.test(line)));
  const status=await fetch(f.app.url+'/api/memory/status').then(r=>r.json());
  assert.equal(status.version,2);assert.ok(status.assistantStatements>=1);assert.doesNotMatch(JSON.stringify(status),/MINT42|wxid_|fixture_response/);
});
