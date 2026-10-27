'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {selectMomentMedia,validateMomentMedia,mediaProof}=require('../src/momentMedia'),{WeChatActions}=require('../src/wechatActions');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-moment-images-'));fs.mkdirSync(path.join(root,'emotion'));const image=path.join(root,'emotion/鲸鲸.gif');fs.writeFileSync(image,Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'));
 const config={root,paths:{dataDir:root},actions:{enabled:true,moments:true,momentMedia:{source:'emotion'}},persona:{master:{wxids:['wxid_owner']}},gateway:{wechat:{inboundToken:'synthetic'}}};
 const actions=new WeChatActions({config,store:{}});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,image,config,actions,msg:{senderId:'wxid_owner',msgId:'synthetic'}};
}
test('选图限已授权目录，任务租用时携带固定图片及核对值',t=>{
 const f=fixture(t);const {job}=f.actions.enqueue(f.msg,{kind:'moment_text',text:'SYNTHETIC_CAPTION',origin:'agent'});assert.equal(job.media.source,'emotion');assert.ok(validateMomentMedia(f.config,job.media));const lease=f.actions.next().job;assert.deepEqual(lease.media,job.media);assert.equal(lease.mediaHash,mediaProof(lease.text,lease.media));
});
test('选中的原图发生变化会让已租用任务失效',t=>{
 const f=fixture(t);f.actions.enqueue(f.msg,{kind:'moment_text',text:'SYNTHETIC_CAPTION'});const job=f.actions.next().job;fs.writeFileSync(f.image,'changed');assert.equal(f.actions.validate(job.id,job.lease).valid,false);
});
test('越出图库或撤销图库授权时，不允许任务使用该图片',t=>{
 const f=fixture(t),media=selectMomentMedia(f.config,'synthetic');for(const relativePath of ['emotion/../outside.gif','C:/outside.gif','emotion\\outside.gif'])assert.equal(validateMomentMedia(f.config,{...media,relativePath}),false);f.config.actions.momentMedia.source='none';assert.equal(validateMomentMedia(f.config,media),false);
});
test('空图库不把无图任务当成可发表任务入队',t=>{
 const f=fixture(t);fs.unlinkSync(f.image);assert.throws(()=>f.actions.enqueue(f.msg,{kind:'moment_text',text:'SYNTHETIC_CAPTION'}),/没有可用配图/);assert.equal(f.actions.state.jobs.length,0);
});
test('图片绑定在重启后保留，预演不会变成真实派发',t=>{
 const f=fixture(t);const {job}=f.actions.enqueue(f.msg,{kind:'moment_text',text:'SYNTHETIC_CAPTION'});const restarted=new WeChatActions({config:f.config,store:{},dryRun:true});const lease=restarted.next().job;assert.deepEqual(lease.media,job.media);assert.equal(lease.dryRun,true);
});
