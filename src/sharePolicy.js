'use strict';
function isChatId(id) {
  return typeof id==='string'&&id.length<=160&&/^[A-Za-z0-9_-]+(?:@chatroom)?$/.test(id)&&!['filehelper','weixin'].includes(id)&&!id.startsWith('gh_');
}
function normalizeWhitelist(value) {
  const rows=Array.isArray(value)?value:typeof value==='string'?value.split(/[\n,]/):null;
  if(!rows||rows.length>200)throw new Error('分享白名单最多填写200个微信或群聊ID');
  const ids=[...new Set(rows.map(id=>typeof id==='string'?id.trim():id).filter(id=>id!==''))];
  if(ids.some(id=>!isChatId(id)))throw new Error('请从已有会话中选择，或填写真实微信/群聊ID；不能填昵称、通配符或文件传输助手');
  return ids;
}
function shareAllowed(config,id) {
  try{return config.share?.enabled===true&&isChatId(id)&&normalizeWhitelist(config.share.allowedChats).includes(id);}catch{return false;}
}
module.exports={isChatId,normalizeWhitelist,shareAllowed};
