'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const digest=body=>crypto.createHash('sha256').update(body).digest('hex');
function mediaEnabled(config){return config.actions?.momentMedia?.source==='emotion';}
function allowedFile(config,relativePath){
 if(typeof relativePath!=='string'||!/^emotion\/[\w\W]+$/.test(relativePath)||relativePath.includes('\\')||relativePath.split('/').includes('..'))throw Error('朋友圈配图不在授权图库中');
 const root=fs.realpathSync(path.join(config.root,'emotion')),file=fs.realpathSync(path.resolve(config.root,relativePath));
 const relative=path.relative(root,file);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!/^\.(gif|png|jpe?g|webp)$/i.test(path.extname(file)))throw Error('朋友圈配图不在授权图库中');
 const stat=fs.statSync(file);if(!stat.isFile()||stat.size<1||stat.size>20*1024*1024)throw Error('朋友圈图片大小不可用');
 return {file,stat};
}
function selectMomentMedia(config,seed=''){
 if(!mediaEnabled(config))return null;
 let names;try{names=fs.readdirSync(path.join(config.root,'emotion')).filter(name=>/\.(gif|png|jpe?g|webp)$/i.test(name)).sort();}catch{throw Error('没有找到已授权的 emotion 配图目录');}
 const candidates=[];
 for(const name of names){const relativePath='emotion/'+name;try{allowedFile(config,relativePath);candidates.push(relativePath);}catch{}}
 if(!candidates.length)throw Error('授权的 emotion 目录里没有可用配图，文案暂不发表');
 const relativePath=candidates[parseInt(digest(seed).slice(0,8),16)%candidates.length],{file,stat}=allowedFile(config,relativePath);
 return {source:'emotion',relativePath,sha256:digest(fs.readFileSync(file)),bytes:stat.size};
}
function validateMomentMedia(config,media){
 try{if(!mediaEnabled(config)||media?.source!=='emotion'||!/^[a-f0-9]{64}$/.test(media.sha256))return false;
 const {file,stat}=allowedFile(config,media.relativePath);return stat.size===media.bytes&&digest(fs.readFileSync(file))===media.sha256;}catch{return false;}
}
function mediaProof(text,media){return digest(String(text)+'\0'+media.relativePath+'\0'+media.sha256);}
module.exports={mediaEnabled,selectMomentMedia,validateMomentMedia,mediaProof};
