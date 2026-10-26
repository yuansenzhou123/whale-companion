'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {normalizeWhitelist,shareAllowed}=require('../src/sharePolicy');
const {startServer}=require('../server');
const bili=require('../src/bilibili');
test('分享名单只接受明确ID，去重并拒绝模糊匹配、系统会话与过长名单',()=>{
  assert.deepEqual(normalizeWhitelist([' wxid_one ','123@chatroom','wxid_one']),['wxid_one','123@chatroom']);
  for(const value of [['*'],['群聊名'],['filehelper'],['gh_service'],[null],Array(201).fill('wxid_one')])assert.throws(()=>normalizeWhitelist(value));
  assert.equal(shareAllowed({share:{enabled:true,allowedChats:['wxid_one']}},'wxid_one'),true);
  for(const cfg of [{},{share:{enabled:true}},{share:{enabled:true,allowedChats:[]}},{share:{enabled:false,allowedChats:['wxid_one']}}])assert.equal(shareAllowed(cfg,'wxid_one'),false);
});
test('服务端在挑视频前拦住名单外收件人，保存后立即应用新名单',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-share-api-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({share:{enabled:true}}));
  const app=await startServer({root:dir,env:{},port:0,openBrowser:false});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const pick=t.mock.method(bili,'pickVideo',async()=>({bvid:'BVtest',title:'猫猫',url:'https://www.bilibili.com/video/BVtest'}));
  t.mock.method(bili,'fetchComments',async()=>[]);app.runtime.llm.complete=async()=> '这只猫好会装乖～';
  for(const id of ['', 'wxid_other','123@chatroom']){
    const result=await(await fetch(app.url+'/api/share?chat='+id)).json();assert.equal(result.video,null);assert.equal(result.reason,'not_in_share_whitelist');
  }
  assert.equal(pick.mock.calls.length,0);
  const save=patch=>fetch(app.url+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patch})});
  const configured=await save({'share.allowedChats':['wxid_one','123@chatroom']});assert.equal(configured.status,200);
  assert.deepEqual((await configured.json()).config.share.allowedChats,['wxid_one','123@chatroom']);
  assert.equal((await(await fetch(app.url+'/api/share?chat=wxid_one')).json()).video.bvid,'BVtest');
  assert.equal((await(await fetch(app.url+'/api/share?chat=123@chatroom')).json()).video.bvid,'BVtest');
  assert.equal((await save({'share.allowedChats':['*']})).status,400);
  assert.deepEqual(app.runtime.config.share.allowedChats,['wxid_one','123@chatroom']);
  await save({'share.allowedChats':[]});assert.equal((await(await fetch(app.url+'/api/share?chat=wxid_one')).json()).video,null);
});
test('调试会话返回真实chatId供名单点选，网页和同名会话不自动加入',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-share-targets-'));
  const app=await startServer({root:dir,env:{},port:0,openBrowser:false});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  app.runtime.store.ensureSession('wechat:u:wxid_one',{platform:'wechat',chatType:'private',chatId:'wxid_one',title:'同名'});
  const data=await(await fetch(app.url+'/api/debug/sessions')).json();assert.equal(data.sessions[0].chatId,'wxid_one');
  assert.deepEqual(app.runtime.config.share.allowedChats,[]);
});
