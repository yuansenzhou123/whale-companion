'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {DEFAULT_CONFIG} = require('../src/config'), {Bot} = require('../src/bot');
const {startServer} = require('../server');
const {replyRhythm, needsShorter} = require('../src/replyRhythm');
const body = fs.readFileSync(path.join(__dirname, '../personas/whale-girlfriend-v8.md'), 'utf8');
function config() { const c = structuredClone(DEFAULT_CONFIG); Object.assign(c.persona, {promptMode:'full', customPrompt:body, historyStyleChangedAt:1000}); return c; }

test('full私聊明确标记历史和当前消息，保留事实、隔离旧AI示例及去重依据', () => {
  const c=config(), history=[{role:'user',text:'你好人机',ts:800},{role:'assistant',text:'旧AI长篇解释和追问',ts:900},{role:'user',text:'我不吃香菜',ts:950},{role:'assistant',text:'嗯，记着啦',ts:1100}];
  const before=structuredClone(history), bot=new Bot({config:c,store:{messages:()=>history},llm:{}});
  const turns=bot.buildTurns({chatType:'private',text:'还是不知道吃啥啊'},history);
  assert.match(turns[0].content,/历史发言/);assert.match(turns[0].content,/你好人机/);
  assert.match(turns.at(-1).content,/当前需要回应的唯一消息.*\n还是不知道吃啥啊/s);
  assert.match(JSON.stringify(turns),/不吃香菜/);assert.doesNotMatch(JSON.stringify(turns),/旧AI长篇/);
  assert.deepEqual(bot.recentOwn({key:'test'}),['嗯，记着啦']);assert.deepEqual(history,before);
});

test('短闲聊跟随当前长度，不把短技术、求助、详细说明或群聊限制成撒娇短句', () => {
  const c=config();assert.equal(replyRhythm(c,{chatType:'private',text:'hi'}).maxChars,12);
  assert.equal(replyRhythm(c,{chatType:'private',text:'还是不知道吃啥啊',discussion:true}).maxChars,22);
  for(const text of ['解释熵','帮我写代码','为什么天空是蓝的','我很难受','详细说明','翻译这句话','我想和他谈一谈','你能教我这道题吗','陪我分析一下']) assert.equal(replyRhythm(c,{chatType:'private',text}),null,text);
  assert.equal(replyRhythm(c,{chatType:'group',text:'hi'}),null);c.persona.promptMode='compact';assert.equal(replyRhythm(c,{chatType:'private',text:'hi'}),null);
});

async function appFor(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-short-private-'));
  fs.writeFileSync(path.join(dir,'config.json'),'{}');
  const app=await startServer({root:dir,env:{},port:0,openBrowser:false});
  Object.assign(app.runtime.config.persona,{promptMode:'full',customPrompt:body,stylePreset:'可爱',historyStyleChangedAt:1000});
  app.runtime.bot.companion=null;app.runtime.bot.relationship=null;
  Object.defineProperty(app.runtime.llm,'isMock',{value:false,configurable:true});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});return app;
}

test('微信短回复超长时只重写一次，原文提示词完整、存档和气泡只留下改写后的内容', async t => {
  const app=await appFor(t), calls=[];
  app.runtime.llm.complete=async req=>{calls.push(req);return calls.length===1?'人机……好吧，被你听出来了，刚才我确实有点在念菜谱。\n\n中午想吃什么？不说也行，反正我现在也没主线，就想听你多说两句～':'饭还没吃，鱼先馋了。';};
  const result=await app.runtime.bot.handle({platform:'wechat',chatType:'private',chatId:'fixture',senderId:'fixture',text:'还是不知道吃啥啊'});
  assert.equal(calls.length,2);assert.ok(calls.every(r=>r.system.startsWith(body)));assert.match(calls[0].system,/通常5～15字/);
  assert.equal(result.reply,'饭还没吃，鱼先馋了。');assert.equal(result.bubbles.length,1);
  assert.equal(app.runtime.store.messages('wechat:u:fixture',10).filter(m=>m.role==='assistant').length,1);
});

test('正常短句不额外调用模型，详细问答也不按闲聊改写', async t=>{
  const app=await appFor(t);let calls=0;
  app.runtime.llm.complete=async()=>{calls++;return '在呀～';};
  await app.runtime.bot.handle({platform:'wechat',chatType:'private',chatId:'one',senderId:'one',text:'hi'});assert.equal(calls,1);
  app.runtime.llm.complete=async()=>{calls++;return '这是需要完整说明的问题。'.repeat(6);};
  await app.runtime.bot.handle({platform:'wechat',chatType:'private',chatId:'two',senderId:'two',text:'解释熵'});assert.equal(calls,2);
});

test('网页短闲聊先核对完整草稿，不向前端流出将被替换的长篇',async t=>{
  const app=await appFor(t), bot=app.runtime.bot;let calls=0;
  app.runtime.llm.complete=async()=>++calls===1?'这是一段过长的招呼，还补充了很多根本没有必要的解释和问题。':'嗯？鱼在。';
  app.runtime.llm.stream=async function*(){throw new Error('short private reply must be checked first');};
  const output=[];for await(const chunk of bot.generate({action:'reply',system:body,turns:[{role:'user',content:'hi'}],msg:{chatType:'private',text:'hi'}}))output.push(chunk);
  assert.equal(output.join(''),'嗯？鱼在。');assert.equal(calls,2);
});

test('改写失败不裁断原文，不无限重试，也不在报错时追加第二条',async()=>{
  const c=config();let calls=0;const bot=new Bot({config:c,store:{},llm:{complete:async()=>{calls++;throw Error('offline');}}});
  const original='这是完整的一句话，即使改写失败也不能直接截断成半句话。';
  assert.equal(await bot.applyReplyRhythm({msg:{chatType:'private',text:'hi'},system:body,turns:[]},original),original);assert.equal(calls,1);assert.equal(needsShorter('在呀～',replyRhythm(c,{chatType:'private',text:'hi'})),false);
});
