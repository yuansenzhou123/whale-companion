'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {HarnessConversations}=require('../src/harnessConversations');const {DEFAULT_CONFIG}=require('../src/config');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-harness-test-')),config=structuredClone(DEFAULT_CONFIG);
 config.paths={root:dir,dataDir:dir};config.harness={enabled:true};config.persona.customPrompt='VERBATIM_PERSONA';
 const calls=[],persisted=new Set();let restoreFailed=false;
 const sdkFactory=async()=>({start:async()=>{},close:async()=>{},session:id=>({run:async input=>{calls.push({id,input});persisted.add(id);return {finalResponse:'测试回复'};}}),resumeSession:async id=>{if(restoreFailed||!persisted.has(id))throw Error('missing');return {run:async input=>{calls.push({id,input});return {finalResponse:'恢复后的回复'};}};}});
 const h=new HarnessConversations({config,sdkFactory});
 t.after(async()=>{await h.close();fs.rmSync(dir,{recursive:true,force:true});});
 const d=(chatId='wxid_a',chatType='private')=>({msg:{platform:'wechat',chatType,chatId,text:'当前消息',senderName:'测试对象'},system:'当前有效要求',turns:[{role:'user',content:'历史资料'},{role:'user',content:'当前消息'}]});
 return {h,config,calls,sdkFactory,d,failRestore(){restoreFailed=true;}};
}
test('相同联系人复用会话，不同联系人和群聊各自隔离，历史只在首次接入带入',async t=>{
 const f=fixture(t);await f.h.reply(f.d());await f.h.reply(f.d());await f.h.reply(f.d('wxid_b'));await f.h.reply(f.d('wxid_a','group'));
 assert.equal(f.calls[0].id,f.calls[1].id);assert.equal(new Set(f.calls.map(c=>c.id)).size,3);
 assert.match(f.calls[0].input,/历史资料/);assert.doesNotMatch(f.calls[1].input,/历史资料/);
 assert.match(f.calls[1].input,/当前有效要求/);assert.equal(fs.readFileSync(path.join(f.h.dir,'skills','whale-persona','SKILL.md'),'utf8').endsWith('VERBATIM_PERSONA'),true);
});
test('重启恢复原会话，不创建替代会话；恢复失败不生成假回复',async t=>{
 const f=fixture(t);await f.h.reply(f.d());await f.h.close();
 const h2=new HarnessConversations({config:f.config,sdkFactory:f.sdkFactory});t.after(()=>h2.close());
 await h2.reply(f.d());assert.equal(f.calls[0].id,f.calls[1].id);await h2.close();
 f.failRestore();const h3=new HarnessConversations({config:f.config,sdkFactory:f.sdkFactory});t.after(()=>h3.close());
 await assert.rejects(h3.reply(f.d()),/missing/);assert.equal(f.calls.length,2);
});
test('只有开启的微信普通会话进入新后端，技能与会话状态不写进凭据',async t=>{
 const f=fixture(t);assert.equal(f.h.enabled(f.d().msg),true);assert.equal(f.h.enabled({...f.d().msg,platform:'web'}),false);
 f.config.harness.enabled=false;assert.equal(f.h.enabled(f.d().msg),false);
 await f.h.close();assert.equal(f.h.enabled(f.d().msg),false);
});
test('微信普通聊天实际使用 Harness 结果并归档，不再经原模型生成或短句重写',async t=>{
 const f=fixture(t),{Store}=require('../src/memory'),{Bot}=require('../src/bot');
 const store=new Store({file:path.join(f.config.paths.dataDir,'store.json'),limits:f.config.memory});t.after(()=>store.close());
 f.config.persona.promptMode='full';const bot=new Bot({config:f.config,store,llm:{isMock:false,model:'fixture',complete(){throw Error('unexpected direct generation');}}});bot.harnessConversations=f.h;
 const result=await bot.handle({platform:'wechat',chatType:'private',chatId:'wxid_a',senderId:'wxid_a',senderName:'测试对象',text:'今天看到一只猫'});
 assert.equal(result.reason,'harness_session');assert.equal(f.calls.length,1);assert.ok(result.reply.includes('测试回复'));
 assert.equal(store.messages('wechat:u:wxid_a',10).filter(m=>m.role==='assistant').length,1);
});
