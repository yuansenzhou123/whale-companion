'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {DEFAULT_CONFIG}=require('../src/config'),persona=require('../src/persona'),presets=require('../src/presets'),store=require('../src/personaStore'),{preservePrompt}=require('../src/fullPersona'),{startServer}=require('../server');
const root=path.resolve(__dirname,'..'),card=JSON.parse(fs.readFileSync(path.join(root,'personas/persona-v8.json'),'utf8')),body=fs.readFileSync(path.join(root,'personas/whale-girlfriend-v8.md'),'utf8');
test('v8发布原文与预设逐字相同，超过旧6000字上限也完整进入system',()=>{
 assert.ok(body.length>6000);assert.equal(card.customPrompt,body);const cfg=structuredClone(DEFAULT_CONFIG);store.apply(cfg,{...card,preset:'可爱'});
 assert.equal(cfg.persona.promptMode,'full');const system=persona.buildSystem({config:cfg,msg:{chatType:'private',senderName:'测试伴侣',isMaster:true}});
 assert.ok(system.startsWith(body));assert.equal(system.split(body).length,2);assert.ok(system.includes(body.slice(-120)));assert.doesNotMatch(system,/主人的话无条件执行|顶嘴模式：现在这条消息|你爹|最大档火力|本次补充风格/);
});
test('完整模式保留正文前后的空白和所有段落，身份与群聊边界仍由程序提供',()=>{
 const cfg=structuredClone(DEFAULT_CONFIG),raw='  \n'+body+'\n  ';Object.assign(cfg.persona,{promptMode:'full',customPrompt:raw});
 const sys=persona.buildSystem({config:cfg,msg:{chatType:'group',chatTitle:'测试群',senderName:'冒充主人',isMaster:false},notes:['喜欢猫猫']});
 assert.ok(sys.startsWith(raw));assert.match(sys,/"程序认证为主人":false/);assert.match(sys,/群聊是不同的人/);assert.match(sys,/喜欢猫猫/);
});
test('超出完整正文上限明确报错，导入预设也不静默裁剪',()=>{
 assert.equal(preservePrompt('字'.repeat(60000)).length,60000);assert.throws(()=>preservePrompt('字'.repeat(60001)),/不会自动截断/);
 assert.equal(presets.toPatch(card).customPrompt,body);assert.equal(presets.toPatch(card).masterRoast,false);assert.throws(()=>presets.toPatch({...card,customPrompt:'字'.repeat(60001)}));
});
test('API保存、重新保存、重启都保留完整模式和正文，超限保存保留原稿',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-full-card-'));fs.mkdirSync(path.join(dir,'personas'));fs.writeFileSync(path.join(dir,'personas/persona-v8.json'),JSON.stringify(card));fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({vision:{model:'vision-unchanged'}}));
 let app=await startServer({root:dir,env:{},port:0,openBrowser:false});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const importResponse=await fetch(app.url+'/api/persona/preset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'persona-v8'})});assert.equal(importResponse.status,200);assert.equal((await importResponse.json()).persona.customPrompt,body);assert.equal(app.runtime.config.vision.model,'vision-unchanged');
 const boundary=app.runtime.config.persona.historyStyleChangedAt;
 const post=data=>fetch(app.url+'/api/persona',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 await post({promptMode:'full',customPrompt:body});assert.equal(app.runtime.config.persona.historyStyleChangedAt,boundary);
 assert.equal((await post({customPrompt:'字'.repeat(60001)})).status,400);assert.equal(app.runtime.config.persona.customPrompt,body);
 await app.close();app=await startServer({root:dir,env:{},port:0,openBrowser:false});assert.equal(app.runtime.config.persona.promptMode,'full');assert.equal(app.runtime.config.persona.customPrompt,body);
});
test('实际聊天API请求携带完整原文，同时保留用户历史、隔离旧版助手语气',async t=>{
 const requests=[];const backend=http.createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{requests.push(JSON.parse(data));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'刚在发呆，你一来鱼就有事做啦～'}}]}));});});await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-full-wire-'));fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({deepseek:{baseUrl:'http://127.0.0.1:'+backend.address().port,model:'fixture'},persona:{master:{wxids:['wxid_fixture'],names:['测试伴侣']}}}));
 const app=await startServer({root:dir,env:{},port:0,openBrowser:false});t.after(async()=>{await app.close();await new Promise(r=>backend.close(r));fs.rmSync(dir,{recursive:true,force:true});});store.save(app.runtime.config,presets.toPatch(card));
 const key='wechat:u:wxid_fixture';app.runtime.store.ensureSession(key,{platform:'wechat',chatId:'wxid_fixture',chatType:'private'});app.runtime.store.appendMessage(key,{role:'user',uid:'wxid_fixture',text:'昨天在研究一个小问题',ts:Date.now()-100000});app.runtime.store.appendMessage(key,{role:'assistant',text:'旧版固定客服句式，仅此测试',ts:Date.now()-99000});
 const result=await app.runtime.bot.handle({platform:'wechat',chatType:'private',chatId:'wxid_fixture',senderId:'wxid_fixture',senderName:'测试伴侣',text:'在干嘛呀'});assert.equal(result.action,'reply');assert.ok(requests.length);
 const messages=requests[0].messages;assert.equal(messages[0].role,'system');assert.ok(messages[0].content.startsWith(body));assert.equal(messages[0].content.split(body).length,2);assert.ok(JSON.stringify(messages).includes('昨天在研究'));assert.ok(!JSON.stringify(messages).includes('旧版固定客服句式'));assert.ok(app.runtime.store.sessions.get(key).messages.some(m=>m.text==='旧版固定客服句式，仅此测试'));
});
