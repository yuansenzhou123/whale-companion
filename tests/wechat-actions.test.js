'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DEFAULT_CONFIG}=require('../src/config'),{Store}=require('../src/memory'),{WeChatActions}=require('../src/wechatActions'),{startServer}=require('../server');
function setup(t,{dryRun=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-v3-actions-')),config=structuredClone(DEFAULT_CONFIG);
 config.paths={...config.paths,dataDir:dir};config.actions={enabled:true,groupText:true,moments:true};config.persona.master={wxids:['wxid_owner'],names:['owner']};config.gateway.wechat.inboundToken='fixture-token';
 const store=new Store({file:path.join(dir,'store.json'),limits:config.memory});store.ensureSession('wechat:g:123@chatroom',{platform:'wechat',chatType:'group',chatId:'123@chatroom',title:'测试群'});
 let now=Date.now();const service=new WeChatActions({config,store,dryRun,now:()=>now});
 const msg=(text,extra={})=>({platform:'wechat',chatType:'private',chatId:'wxid_owner',senderId:'wxid_owner',senderName:'owner',text,msgId:'fixture-message',...extra});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,config,store,service,msg,advance(ms){now+=ms;}};
}

test('私聊明确群名与正文创建任务，保留原文，不调用模型改写',t=>{
 const f=setup(t),answer=f.service.handle(f.msg('帮我在「测试群」发一句：ACTION_BODY_42'));
 assert.match(answer.text,/排队/);assert.equal(f.service.state.jobs[0].text,'ACTION_BODY_42');assert.equal(f.service.state.jobs[0].target.id,'123@chatroom');
 assert.equal(f.service.parse('给测试群发消息：BODY').text,'BODY');assert.equal(f.service.parse('在「123@chatroom」说：BODY').target,'123@chatroom');
});
test('非主人、群内命令、网页和无认证token不能触发动作',t=>{
 const f=setup(t);for(const change of [{senderId:'wxid_other',chatId:'wxid_other',isMaster:true},{chatType:'group',chatId:'123@chatroom'},{platform:'web'}])assert.equal(f.service.handle(f.msg('在「测试群」发：BODY',change)),null);
 f.config.gateway.wechat.inboundToken='';assert.equal(f.service.handle(f.msg('在「测试群」发：BODY')),null);assert.equal(f.service.state.jobs.length,0);
});
test('转发、假设和能力问题不变成发送请求，同名群不猜',t=>{
 const f=setup(t);for(const text of ['如果我说在测试群发：BODY','别人说在「测试群」发：BODY','你在测试群发消息会不会成功？'])assert.equal(f.service.parse(text),null);
 f.store.ensureSession('wechat:g:456@chatroom',{platform:'wechat',chatType:'group',chatId:'456@chatroom',title:'测试群'});
 assert.match(f.service.handle(f.msg('在「测试群」发：BODY')).text,/多个同名群/);assert.equal(f.service.state.jobs.length,0);
 assert.match(f.service.handle(f.msg('在「不存在群」发：BODY')).text,/没找到/);
});
test('任务先持久化再租用，同一入站消息重复到达也不重复创建或派发',t=>{
 const f=setup(t);f.service.handle(f.msg('在测试群发：BODY'));f.service.handle(f.msg('在测试群发：BODY'));assert.equal(f.service.state.jobs.length,1);
 const lease=f.service.next().job;assert.ok(lease.lease);assert.equal(f.service.next().job,null);
 const restarted=new WeChatActions({config:f.config,store:f.store,now:()=>Date.now()});assert.equal(restarted.next().job,null);
 f.advance(121000);assert.equal(f.service.next().job,null);assert.equal(f.service.state.jobs[0].status,'unknown');
});
test('只有正确租用确认才记录真实代发，确认重试不重复写历史或通知',t=>{
 const f=setup(t);f.service.handle(f.msg('在测试群发：BODY'));const job=f.service.next().job;
 assert.equal(f.service.ack({id:job.id,lease:'wrong',outcome:'sent'}).ok,false);
 const result=f.service.ack({id:job.id,lease:job.lease,outcome:'sent'});assert.equal(result.notification.chatId,'wxid_owner');
 assert.equal(f.service.ack({id:job.id,lease:job.lease,outcome:'sent'}).duplicate,true);
 assert.equal(f.store.messages('wechat:g:123@chatroom',100).filter(m=>m.text==='BODY').length,1);
});
test('未确认或失败不记成已发送，预演永不写目标群的成功记录',t=>{
 for(const outcome of ['unknown','failed']){
  const f=setup(t);f.service.handle(f.msg('在测试群发：BODY'));const j=f.service.next().job;f.service.ack({id:j.id,lease:j.lease,outcome});assert.equal(f.store.messages('wechat:g:123@chatroom').length,0);
 }
 const f=setup(t,{dryRun:true});f.service.handle(f.msg('在测试群发：BODY'));const j=f.service.next().job;f.service.ack({id:j.id,lease:j.lease,outcome:'sent'});
 assert.equal(f.service.state.jobs[0].status,'simulated');assert.equal(f.store.messages('wechat:g:123@chatroom').length,0);
});
test('朋友圈草稿不派发，只有新的明确发表指令才创建发布任务',t=>{
 const f=setup(t);f.service.handle(f.msg('保存朋友圈草稿：MOMENT_BODY'));assert.equal(f.service.next().job,null);
 f.service.handle(f.msg('发布刚才那条朋友圈',{msgId:'publish'}));assert.equal(f.service.next().job.kind,'moment_text');
});
test('取消只影响未执行任务，暂停或过期任务不派发',t=>{
 const f=setup(t);f.service.handle(f.msg('在测试群发：BODY'));f.service.handle(f.msg('取消刚才的代发任务',{msgId:'cancel'}));assert.equal(f.service.next().job,null);
 f.service.handle(f.msg('在测试群发：NEXT',{msgId:'next'}));fs.writeFileSync(path.join(f.dir,'PAUSED'),'');assert.equal(f.service.next().job,null);fs.unlinkSync(path.join(f.dir,'PAUSED'));f.advance(601000);assert.equal(f.service.next().job,null);
});
test('真实HTTP路由要求桥接token，主人私聊才创建任务，网页没有通用执行接口',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-v3-action-wire-'));fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({actions:{enabled:true,groupText:true,moments:true},persona:{master:{wxids:['wxid_owner'],names:['owner']}},gateway:{wechat:{enabled:true,inboundToken:'fixture-token'}}}));
 const app=await startServer({root:dir,env:{},port:0,openBrowser:false});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 app.runtime.store.ensureSession('wechat:g:123@chatroom',{platform:'wechat',chatType:'group',chatId:'123@chatroom',title:'测试群'});
 const post=(endpoint,data,token='')=>fetch(app.url+endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Bot-Token':token}:{})},body:JSON.stringify(data)});
 const inbound={chat_id:'wxid_owner',chat_type:'private',sender_id:'wxid_owner',nickname:'owner',text:'在测试群发：BODY',msg_id:'request'};
 assert.equal((await post('/webhook/wechat',inbound)).status,403);
 const command=await post('/webhook/wechat',inbound,'fixture-token').then(r=>r.json());assert.equal(command.action,'reply');assert.match(command.reply,/排队/);
 assert.equal(app.runtime.actions.state.jobs.length,1);
 assert.equal((await post('/api/actions/next',{})).status,403);
 const next=await post('/api/actions/next',{},'fixture-token').then(r=>r.json());assert.equal(next.job.target.id,'123@chatroom');
 assert.equal((await post('/api/actions/create',{},'fixture-token')).status,404);
 const done=await post('/api/actions/ack',{id:next.job.id,lease:next.job.lease,outcome:'sent'},'fixture-token').then(r=>r.json());assert.equal(done.ok,true);
});

test('撤销分项权限会阻止已排队或已租用任务继续执行',t=>{
 const f=setup(t);f.service.handle(f.msg('在测试群发：BODY'));const job=f.service.next().job;
 f.config.actions.groupText=false;assert.equal(f.service.validate(job.id,job.lease).valid,false);
 f.service.handle(f.msg('发朋友圈：MOMENT',{msgId:'moment'}));f.config.actions.moments=false;
 assert.equal(f.service.next().job,null);assert.equal(f.service.state.jobs.at(-1).status,'cancelled');
});
test('预演服务恢复旧的实际任务时仍强制预演，且以后不补发',t=>{
 const f=setup(t);f.service.handle(f.msg('在测试群发：BODY'));
 const preview=new WeChatActions({config:f.config,store:f.store,dryRun:true});const job=preview.next().job;
 assert.equal(job.dryRun,true);preview.ack({id:job.id,lease:job.lease,outcome:'sent'});
 assert.equal(preview.state.jobs[0].status,'simulated');assert.equal(f.store.messages('wechat:g:123@chatroom').length,0);
 const normal=new WeChatActions({config:f.config,store:f.store});assert.equal(normal.next().job,null);
});


test('朋友圈失败通知带上具体前台原因，并说明草稿保存在项目中',t=>{
 const f=setup(t);f.service.handle(f.msg('发朋友圈：SYNTHETIC_BODY'));const job=f.service.next().job;
 const error='未能把微信恢复并切到前台，尚未检查发表入口';const done=f.service.ack({id:job.id,lease:job.lease,outcome:'draft',error});
 assert.ok(done.notification.text.includes(error));assert.match(done.notification.text,/本项目草稿/);assert.equal(f.service.state.jobs[0].status,'draft');assert.equal(f.service.next().job,null);
});
