'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DEFAULT_CONFIG}=require('../src/config'),{Store}=require('../src/memory'),{SharedMemory}=require('../src/sharedMemory'),{CompanionAgent}=require('../src/agent');
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-understanding-')),config=structuredClone(DEFAULT_CONFIG);
 config.paths={root:dir,dataDir:dir,storeFile:path.join(dir,'store.json')};config.persona.master={wxids:['wxid_owner'],names:['测试主人']};config.agent={enabled:true,autonomousMoments:false};
 const store=new Store({file:config.paths.storeFile,limits:config.memory}),shared=new SharedMemory({config,store}),calls=[],outputs=[];
 store.onMessage=(s,m)=>shared.recordEntry(s,m);
 const llm={isMock:false,complete:async request=>{calls.push(request);const output=outputs.shift();if(output instanceof Error)throw output;return typeof output==='function'?output(request):JSON.stringify(output||{action:'none'});}};
 const agent=new CompanionAgent({config,store,llm,sharedMemory:shared,companion:{}});agent.updateContacts([{id:'wxid_peer',name:'甲'},{id:'wxid_other',name:'乙'}]);
 let serial=0;const msg=(text,extra={})=>({platform:'wechat',chatType:'private',chatId:'wxid_owner',senderId:'wxid_owner',senderName:'测试主人',text,msgId:'synthetic-'+(++serial),...extra});
 const compile=(text,extra={})=>({action:'remember',target:'甲',quote:text,confidence:.98,mode:'any',conditionQuote:'',exactReply:'',key:'response',replaces:[],...extra});
 const archive=(text)=>{store.ensureSession('wechat:u:wxid_owner',{platform:'wechat',chatType:'private',chatId:'wxid_owner'});store.appendMessage('wechat:u:wxid_owner',{role:'user',uid:'wxid_owner',name:'测试主人',text});return shared.state.records.find(r=>r.text===text);};
 t.after(()=>{agent.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {agent,store,shared,calls,outputs,msg,compile,archive};
}
test('没有条件句或关键词的主人要求仍由模型理解并影响目标的下一次回复',async t=>{
 const f=setup(t),text='甲那边别太热情，冷淡一点就行。';f.outputs.push(f.compile(text));await f.agent.handle(f.msg(text));assert.equal(f.calls.length,1);assert.equal(f.agent.active().length,1);
 f.outputs.push({match:true,reply:'嗯，这会儿不太想聊。'});assert.equal((await f.agent.handle(f.msg('在吗',{chatId:'wxid_peer',senderId:'wxid_peer'}))).text,'嗯，这会儿不太想聊。');
});
test('普通闲聊也做语义判断，但不保存任务、不改变已有要求或普通归档性质',async t=>{
 const f=setup(t),text='好困呀';const record=f.archive(text),kind=record.kind;f.outputs.push({action:'none'});assert.equal(await f.agent.handle(f.msg(text)),null);
 assert.equal(f.calls.length,1);assert.equal(f.agent.active().length,0);assert.equal(record.kind,kind);
});
test('不用额外发送历史聊天，当前输入和已确认要求足以承接修改与撤销',async t=>{
 const f=setup(t),first='甲那边别太热情，冷淡一点就行。';f.archive('PRIVATE_HISTORY_NOT_FOR_CLASSIFIER');f.outputs.push(f.compile(first));await f.agent.handle(f.msg(first));const old=f.agent.active()[0];
 const changed='那条改成温柔一点吧';f.outputs.push(f.compile(changed,{replaces:[old.id],key:'soft'}));await f.agent.handle(f.msg(changed));assert.equal(old.status,'superseded');assert.equal(f.agent.active().length,1);assert.equal(f.agent.active()[0].previousInstruction,first);
 const input=JSON.parse(f.calls.at(-1).turns[0].content);assert.equal(input.message,changed);assert.equal(input.existing[0].id,old.id);assert.ok(input.knownContacts.some(c=>c.id==='wxid_peer'));assert.doesNotMatch(JSON.stringify(input),/PRIVATE_HISTORY_NOT_FOR_CLASSIFIER|recentConversation|recentOwnerMessages/);
 const cancel='算了，他那边还是正常聊吧。';f.outputs.push(f.compile(cancel,{action:'revoke',replaces:[f.agent.active()[0].id]}));await f.agent.handle(f.msg(cancel));assert.equal(f.agent.active().length,0);
});
test('模型无法理解、输出无效或置信度不足时保留原状态，恢复普通记忆标记',async t=>{
 const f=setup(t);
 for(const result of [new Error('synthetic unavailable'),null,{action:'remember',confidence:.2,quote:'甲冷淡点',target:'甲'}]){
  const text='甲冷淡点',record=f.archive(text),kind=record.kind;f.outputs.push(result);await f.agent.handle(f.msg(text));assert.equal(f.agent.active().length,0);assert.equal(record.kind,kind);
 }
});
test('引用和假设由模型分辨，不靠词形跳过理解，也不自动变成当前要求',async t=>{
 const f=setup(t);
 for(const text of ['朋友说“甲来了就装忙”，听起来好奇怪','假如我让甲别聊了，你会觉得奇怪吗']){
  f.outputs.push({action:'none'});assert.equal(await f.agent.handle(f.msg(text)),null);
 }
 assert.equal(f.calls.length,2);assert.equal(f.agent.active().length,0);
});
test('模型不能以修订为由替换另一个联系人的要求，单条撤销不影响其他条件',async t=>{
 const f=setup(t),one='甲聊项目就说很忙',two='甲聊游戏就说没空';
 f.outputs.push(f.compile(one,{mode:'conditional',conditionQuote:'聊项目',key:'project'}));await f.agent.handle(f.msg(one));const row1=f.agent.active()[0];
 f.outputs.push(f.compile(two,{mode:'conditional',conditionQuote:'聊游戏',key:'game'}));await f.agent.handle(f.msg(two));const row2=f.agent.active().find(r=>r.id!==row1.id);
 const invalid='乙改成热情点';f.outputs.push(f.compile(invalid,{target:'乙',replaces:[row1.id]}));assert.match((await f.agent.handle(f.msg(invalid))).text,/没弄清/);assert.equal(f.agent.active().length,2);
 const cancel='项目那条算了';f.outputs.push(f.compile(cancel,{action:'revoke',replaces:[row1.id]}));await f.agent.handle(f.msg(cancel));assert.deepEqual(f.agent.active().map(r=>r.id),[row2.id]);
});
test('其他人的普通私聊、群消息和网页输入不会进入主人要求理解',async t=>{
 const f=setup(t);for(const extra of [{chatId:'wxid_peer',senderId:'wxid_peer',senderName:'测试主人'},{chatType:'group',chatId:'123@chatroom'},{platform:'web'}])await f.agent.handle(f.msg('甲冷淡点',extra));
 assert.equal(f.calls.length,0);assert.equal(f.agent.active().length,0);
});


test('单条语义修订不会覆盖同联系人的其他要求，未修改的条件和期限可继承',async t=>{
 const f=setup(t),first='甲问项目就说稍后再聊，今晚为止',second='甲聊游戏就说没空';
 f.outputs.push(f.compile(first,{mode:'conditional',conditionQuote:'问项目',key:'project',duration:'today'}));await f.agent.handle(f.msg(first));const original=f.agent.active()[0];
 f.outputs.push(f.compile(second,{mode:'conditional',conditionQuote:'聊游戏',key:'game'}));await f.agent.handle(f.msg(second));
 const update='项目那条换成温柔一点';f.outputs.push(f.compile(update,{mode:'conditional',conditionQuote:'问项目',key:'project-new',replaces:[original.id],duration:'keep'}));await f.agent.handle(f.msg(update));
 const changed=f.agent.active().find(r=>r.key==='project-new');assert.equal(changed.condition,'问项目');assert.equal(changed.expiresAt,original.expiresAt);assert.equal(f.agent.active().length,2);
 const changeMode='这条改成每次都这样';f.outputs.push(f.compile(changeMode,{mode:'any',replaces:[changed.id]}));await f.agent.handle(f.msg(changeMode));assert.equal(f.agent.active().length,2);assert.ok(f.agent.active().some(r=>r.key==='game'));
});
