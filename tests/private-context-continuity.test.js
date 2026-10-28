'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {Bot} = require('../src/bot');
const {Store} = require('../src/memory');
const {DEFAULT_CONFIG} = require('../src/config');
const persona = require('../src/persona');
const {replyRhythm, needsShorter} = require('../src/replyRhythm');

function setup(t) {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.persona, {promptMode:'full', customPrompt:'PERSONA_FIXTURE_VERBATIM', stylePreset:'可爱', historyStyleChangedAt:0});
  Object.assign(config.chat, {maxBubbles:2, privateMaxChars:140, emojiChance:0});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-continuity-'));
  const store = new Store({file:path.join(dir, 'store.json'), limits:config.memory});
  const calls = [], outputs = [];
  const bot = new Bot({config, store, rng:()=>0.99, llm:{isMock:false, model:'fixture',
    async complete(req) { calls.push(req); assert.ok(outputs.length, 'unexpected extra rewrite'); return outputs.shift(); }
  }});
  t.after(()=>{store.close(); fs.rmSync(dir, {recursive:true, force:true});});
  const msg = text=>({platform:'wechat', chatType:'private', chatId:'fixture', senderId:'fixture', text});
  return {config, store, calls, outputs, bot, msg, key:bot.sessionKey(msg(''))};
}

test('私聊按上文重发自己的原文，不被复读重写或兜底替换', async t=>{
  const {store,calls,outputs,bot,msg,key}=setup(t);
  store.appendMessage(key,{role:'user',text:'USER_CONTEXT_A'});
  store.appendMessage(key,{role:'assistant',text:'ASSISTANT_CONTEXT_B'});
  outputs.push('ASSISTANT_CONTEXT_B');
  const result=await bot.handle(msg('你再发一次试试'));
  assert.equal(calls.length,1);
  assert.equal(result.reply,'ASSISTANT_CONTEXT_B');
  assert.ok(calls[0].system.startsWith('PERSONA_FIXTURE_VERBATIM'));
  assert.ok(calls[0].turns.some(m=>m.role==='user'&&m.content.includes('USER_CONTEXT_A')));
  assert.ok(calls[0].turns.some(m=>m.role==='assistant'&&m.content==='ASSISTANT_CONTEXT_B'));
  assert.match(calls[0].turns.at(-1).content,/本轮消息.*\n你再发一次试试/s);
  assert.doesNotMatch(JSON.stringify(calls[0].turns),/已结束的请求/);
});

test('私聊引用较早用户原文不被当前输入防复读误伤', async t=>{
  const {store,calls,outputs,bot,msg,key}=setup(t);
  store.appendMessage(key,{role:'user',text:'EARLIER_USER_TEXT'});
  store.appendMessage(key,{role:'assistant',text:'ACK_FIXTURE'});
  outputs.push('EARLIER_USER_TEXT');
  const result=await bot.handle(msg('把我刚才说的重发一下'));
  assert.equal(calls.length,1);
  assert.equal(result.reply,'EARLIER_USER_TEXT');
});

test('沿用上文并明确分段的短回复发送成两条，同时只保存完整的一次回复', async t=>{
  const {store,calls,outputs,bot,msg,key}=setup(t);
  const text='PART_A\n\nPART_B';
  store.appendMessage(key,{role:'assistant',text});
  outputs.push(text);
  const result=await bot.handle(msg('你还是在同一条里啊'));
  assert.equal(calls.length,1);
  assert.deepEqual(result.bubbles,['PART_A','PART_B']);
  assert.equal(result.reply,text);
  const saved=store.messages(key,20).filter(m=>m.role==='assistant');
  assert.equal(saved.length,2);
  assert.equal(saved.at(-1).text,text);
});

test('短回复的空行不触发缩短或丢失两条消息边界', async t=>{
  const {calls,outputs,bot,msg}=setup(t);
  const text='甲段\n\n乙段';
  assert.equal(needsShorter(text,replyRhythm(bot.config,msg('hi'))),false);
  outputs.push(text);
  const result=await bot.handle(msg('hi'));
  assert.equal(calls.length,1);
  assert.deepEqual(result.bubbles,['甲段','乙段']);
});

test('多段短回复遵守条数限制，溢出段落合并且不丢字', t=>{
  const {bot,msg,key}=setup(t);
  const text='PART_A\n\nPART_B\n\nPART_C';
  assert.deepEqual(bot.finalize({key,action:'reply',msg:msg('分条')},text),['PART_A','PART_B\n\nPART_C']);
});

test('单气泡设置、代码块及长正文仍使用原有分段上限', t=>{
  const {config,bot,msg,key}=setup(t);
  const decision=()=>({key,action:'reply',msg:msg('详细解释')});
  config.chat.maxBubbles=1;
  assert.deepEqual(bot.finalize(decision(),'PART_A\n\nPART_B'),['PART_A\n\nPART_B']);
  config.chat.maxBubbles=2;
  const code='```\nPART_A\n\nPART_B\n```';
  assert.deepEqual(bot.finalize(decision(),code),[code]);
  config.chat.privateMaxChars=30;
  const long='甲'.repeat(80)+'\n\n'+'乙'.repeat(80);
  assert.deepEqual(bot.finalize(decision(),long),persona.splitBubbles(long,{maxChars:30,maxBubbles:2}));
});

test('私聊仍拦截直接照抄本轮输入，群聊仍使用近期去重依据', async t=>{
  const {calls,outputs,bot,msg,key}=setup(t);
  outputs.push('在吗','在的');
  const result=await bot.handle(msg('在吗'));
  assert.equal(calls.length,2);
  assert.equal(result.reply,'在的');
  const heard=['GROUP_HEARD'],own=['GROUP_OWN'];
  assert.deepEqual(bot.echoReferences({key,msg:{chatType:'group'},heardList:heard,ownList:own}),{heard,own});
});


for (const separator of ['\n', '\r\n', '\r', '\n\n']) {
  test(`普通私聊分行真正生成两个气泡：${JSON.stringify(separator)}`, async t=>{
    const {calls,outputs,bot,msg}=setup(t);
    const text='LINE_A'+separator+'LINE_B';
    outputs.push(text);
    const result=await bot.handle(msg('请分两条发'));
    assert.equal(calls.length,1);
    assert.deepEqual(result.bubbles,['LINE_A','LINE_B']);
  });
}

test('群聊、单行文字和代码块不受普通私聊换行拆分影响', t=>{
  const {bot,msg,key}=setup(t);
  const finalize=(text,extra={})=>bot.finalize({key,action:'reply',msg:{...msg('请详细解释'),...extra}},text);
  assert.deepEqual(finalize('LINE_A\nLINE_B',{chatType:'group'}),['LINE_A\nLINE_B']);
  assert.deepEqual(finalize('LINE_A，LINE_B'),['LINE_A，LINE_B']);
  assert.deepEqual(finalize('```\nLINE_A\nLINE_B\n```'),['```\nLINE_A\nLINE_B\n```']);
});

test('微信HTTP回包保留单换行拆出的两个气泡，桥接可以逐条消费', async t=>{
  const {startServer}=require('../server');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-bubble-wire-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({
    persona:{promptMode:'full',customPrompt:'PERSONA_FIXTURE_VERBATIM',stylePreset:'可爱'},
    chat:{maxBubbles:2,privateMaxChars:140},agent:{enabled:false},
    gateway:{wechat:{enabled:true,inboundToken:'fixture-bubble-token'}}
  }));
  const app=await startServer({root:dir,env:{},port:0,openBrowser:false});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  app.runtime.bot.companion=null;app.runtime.bot.relationship=null;
  Object.defineProperty(app.runtime.llm,'isMock',{value:false,configurable:true});
  app.runtime.llm.complete=async()=> 'LINE_A\nLINE_B';
  const response=await fetch(app.url+'/webhook/wechat',{method:'POST',
    headers:{'Content-Type':'application/json','X-Bot-Token':'fixture-bubble-token'},
    body:JSON.stringify({chat_id:'wxid_fixture',sender_id:'wxid_fixture',chat_type:'private',text:'请分两条发',msg_id:'fixture-newline'})
  });
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.action,'reply');
  assert.deepEqual(result.bubbles,['LINE_A','LINE_B']);
  assert.equal(result.reply,'LINE_A\nLINE_B');
});
