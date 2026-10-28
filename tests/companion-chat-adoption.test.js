'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {DEFAULT_CONFIG}=require('../src/config'),{Bot}=require('../src/bot'),{Store}=require('../src/memory');
const {StyleLearning}=require('../src/styleLearning');
const {replyRhythm}=require('../src/replyRhythm');
const {conversationFocus}=require('../src/conversationFocus');
const {startServer}=require('../server');

function fixture(t) {
  const config=structuredClone(DEFAULT_CONFIG);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-chat-adopt-'));
  config.paths={...config.paths,dataDir:dir};
  Object.assign(config.persona,{promptMode:'full',customPrompt:'UNCOMPRESSED_PERSONA_FIXTURE\n'+'PERSONA'.repeat(1000),historyStyleChangedAt:0,stylePreset:'可爱',master:{wxids:['wxid_owner'],names:[]}});
  Object.assign(config.chat,{historyTurns:100,privateMaxChars:140,maxBubbles:2,emojiChance:0});
  const store=new Store({file:path.join(dir,'store.json'),limits:config.memory});
  const calls=[],responses=[];
  const llm={isMock:false,model:'fixture',provider:'deepseek',complete:async req=>{calls.push(req);assert.ok(responses.length,'unexpected extra request');return responses.shift();}};
  const bot=new Bot({config,store,llm,rng:()=>0.99});
  const style=new StyleLearning({config,store,llm});bot.styleLearning=style;
  const msg=(text,extra={})=>({platform:'wechat',chatType:'private',chatId:'wxid_owner',senderId:'wxid_owner',text,...extra});
  const rules=[];style.state.profiles.wxid_owner={enabled:true,epoch:0,rules,seen:[]};
  const rule=(dimension,extra={})=>{const row={id:'rule-'+rules.length,dimension,scope:'all',status:'active',ts:rules.length+1,rule:'RULE_'+dimension,quote:'QUOTE_'+dimension,...extra};rules.push(row);return row;};
  const add=(role,text,key='wechat:u:wxid_owner',ts=Date.now())=>store.appendMessage(key,{role,text,uid:role==='user'?'wxid_owner':'',ts});
  t.after(()=>{style.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {config,store,bot,style,calls,responses,msg,rule,add};
}

test('普通私聊默认短句，不依赖固定闲聊触发词，主人简短偏好立即生效',t=>{
  const f=fixture(t);f.rule('length',{lengthMode:'brief'});
  for(const text of ['你感觉现在怎么样','大笨鱼','今天有点走神','那后来呢','窗外起风了']) {
    assert.equal(replyRhythm(f.config,f.msg(text)).maxChars,22,text);
    assert.equal(f.style.rhythm(f.msg(text),null).maxChars,16,text);
    assert.deepEqual(f.bot.chatGenerationOptions(f.msg(text)),{thinking:false,temperature:1});
  }
  assert.equal(f.bot.rhythmFor(f.msg('hi')).maxChars,12);
  assert.equal(f.bot.rhythmFor(f.msg('你感觉现在怎么样',{chatId:'wxid_other',senderId:'wxid_other'})).maxChars,22);
});

test('详细、严肃、长输入、任务和原文重发保留信息与原来的模型选项',t=>{
  const f=fixture(t);f.rule('length',{lengthMode:'brief'});
  for(const text of ['请详细说一下','解释熵','我很难受','帮我写代码','给我推荐几本书','明天面试该怎么准备','比较这两个方案','你再发一次原文','我想和他谈一谈','给我讲个故事','这些是我的完整问题：'+'内容'.repeat(40)]) {
    assert.equal(f.bot.rhythmFor(f.msg(text)),null,text);
    assert.deepEqual(f.bot.chatGenerationOptions(f.msg(text)),{},text);
  }
  assert.equal(f.bot.rhythmFor(f.msg('hi',{chatType:'group',chatId:'g'})),null);
  f.rule('length',{scope:'private',lengthMode:'detailed',ts:100});
  assert.equal(f.bot.rhythmFor(f.msg('今天有点走神')),null);
});

test('学习的旧批评和撤销项留在本地，不再作为上下文示范；认可原话保留',t=>{
  const f=fixture(t);
  f.rule('tone',{rule:'CURRENT_STYLE',rejected:'REJECTED_OLD_REPLY'});
  f.rule('tone',{status:'revoked',quote:'RETIRED_OLD_FEEDBACK'});
  f.rule('tone',{rule:'APPROVED_STYLE',approved:'APPROVED_REAL_REPLY'});
  const context=f.style.contextFor(f.msg('hi'));
  assert.match(context,/CURRENT_STYLE|APPROVED_REAL_REPLY/);
  assert.doesNotMatch(context,/REJECTED_OLD_REPLY|RETIRED_OLD_FEEDBACK/);
  assert.equal(f.style.state.profiles.wxid_owner.rules[0].rejected,'REJECTED_OLD_REPLY');
  assert.equal(f.style.state.profiles.wxid_owner.rules[1].status,'revoked');
  const other=f.msg('hi',{chatType:'group',chatId:'g',senderId:'wxid_other'});
  assert.doesNotMatch(f.style.contextFor(other),/APPROVED_REAL_REPLY/);
});

test('实际完整人设路径带近期承接和偏好顺序，原始正文逐字保留',async t=>{
  const f=fixture(t);f.rule('length',{lengthMode:'brief'});
  f.add('user','RECENT_TOPIC_A');f.add('assistant','RECENT_REPLY_B');
  f.responses.push('新反应');
  const result=await f.bot.handle(f.msg('那后来呢'));
  assert.equal(result.reply,'新反应');assert.equal(f.calls.length,1);
  const req=f.calls[0];assert.ok(req.system.startsWith(f.config.persona.customPrompt));
  assert.match(req.system,/近期话题锚点/);assert.match(req.system,/RECENT_TOPIC_A/);assert.match(req.system,/RECENT_REPLY_B/);
  assert.match(req.system,/本轮明确要求 → 当前场景有效且较新的表达偏好 → 固定人设/);
  assert.match(req.system,/不把纠正一律当成调情/);
  assert.equal(req.thinking,false);assert.equal(req.temperature,1);
  assert.ok(req.turns.some(m=>m.role==='assistant'&&m.content==='RECENT_REPLY_B'));
});

test('话题锚点只使用已筛选的当前会话，忘记和旧人设过滤继续生效',async t=>{
  const f=fixture(t);f.config.persona.historyStyleChangedAt=1000;
  f.add('user','FORGOTTEN_MARKER',undefined,800);
  f.add('assistant','OLD_PERSONA_REPLY',undefined,900);
  f.add('user','LOCAL_TOPIC',undefined,1100);f.add('assistant','LOCAL_REPLY',undefined,1200);
  f.add('user','OTHER_PRIVATE_MARKER','wechat:u:wxid_other');
  f.bot.sharedMemory={observe(){},contextFor(){return '';},forgotten(){return false;},
    filterHistory(msg,rows){return rows.filter(row=>!row.text.includes('FORGOTTEN_MARKER'));}};
  const d=await f.bot.decide(f.msg('那后来呢'));
  assert.match(d.system,/LOCAL_TOPIC|LOCAL_REPLY/);
  assert.doesNotMatch(d.system,/FORGOTTEN_MARKER|OLD_PERSONA_REPLY|OTHER_PRIVATE_MARKER/);
  assert.equal(conversationFocus({chatType:'group'},d.turns),'');
  assert.equal(conversationFocus({chatType:'private'},[{role:'user',content:'CURRENT_ONLY'}]),'');
});

test('超长闲聊只重写一次，正文、记忆和实际气泡一致，保留分条',async t=>{
  const f=fixture(t);f.rule('length',{lengthMode:'brief'});
  f.responses.push('LONG_REPLY_FIXTURE'.repeat(5),'甲段\n乙段');
  const result=await f.bot.handle(f.msg('你感觉现在怎么样'));
  assert.equal(f.calls.length,2);assert.deepEqual(result.bubbles,['甲段','乙段']);
  assert.equal(result.reply,'甲段\n乙段');
  assert.equal(f.store.messages('wechat:u:wxid_owner',20).at(-1).text,result.reply);
  for(const req of f.calls){assert.equal(req.thinking,false);assert.ok(req.system.startsWith(f.config.persona.customPrompt));}
});

test('模型HTTP模拟核对：闲聊关闭思考、temperature=1，认真问答不覆盖原选项',async t=>{
  const requests=[];
  const backend=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'已收到'}}]}));
  });});
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-adopt-wire-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({deepseek:{baseUrl:'http://127.0.0.1:'+backend.address().port,model:'fixture',temperature:1.15},persona:{promptMode:'full',customPrompt:'FULL_PERSONA_FIXTURE',stylePreset:'可爱'},agent:{enabled:false}}));
  const app=await startServer({root:dir,env:{},port:0,openBrowser:false});
  Object.assign(app.runtime.config.persona,{promptMode:'full',customPrompt:'FULL_PERSONA_FIXTURE',stylePreset:'可爱'});
  app.runtime.bot.companion=null;app.runtime.bot.relationship=null;
  t.after(async()=>{await app.close();await new Promise(r=>backend.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const msg=text=>({platform:'wechat',chatType:'private',chatId:'wxid_fixture',senderId:'wxid_fixture',text});
  await app.runtime.bot.handle(msg('你感觉现在怎么样'));
  await app.runtime.bot.handle(msg('请详细解释数学原理'));
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0].thinking,{type:'disabled'});assert.equal(requests[0].temperature,1);
  assert.equal(requests[1].thinking,undefined);assert.equal(requests[1].temperature,1.15);
  assert.ok(requests.every(req=>req.messages[0].content.startsWith('FULL_PERSONA_FIXTURE')));
});


test('短句继续承接详细或重发请求时，不误压成闲聊，普通话题仍保持短句',async t=>{
  for(const prior of ['请详细解释数学原理','把刚才那段原文重发一次']){
    const f=fixture(t);f.rule('length',{lengthMode:'brief'});
    f.add('user',prior);f.add('assistant','PRIOR_SUBSTANTIVE_REPLY');
    const text='CONTINUED_ORIGINAL_REPLY'.repeat(3);f.responses.push(text);
    const result=await f.bot.handle(f.msg('继续'));
    assert.equal(result.reply,text);assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].thinking,undefined);
    assert.doesNotMatch(f.calls[0].system,/【本轮私聊节奏】/);
  }
  const f=fixture(t);f.add('user','窗外起风了');f.add('assistant','LOCAL_CASUAL_REPLY');f.responses.push('新反应');
  await f.bot.handle(f.msg('然后呢'));assert.equal(f.calls[0].thinking,false);
});
