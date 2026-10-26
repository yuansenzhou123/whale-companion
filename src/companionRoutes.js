'use strict';
const path = require('node:path');
const {timingSafeEqual} = require('node:crypto');
function loopbackHost(host) {
  try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL('http://' + host).hostname); } catch {return false;}
}
function trustedOrigin(origin, host) {
  if (!origin) return true;
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  try {const u = new URL(origin); return u.protocol === 'http:' && u.host === host && loopbackHost(u.host);} catch {return false;}
}
async function companionRoute(runtime, req, res, url, {json, readBody}) {
  const service = runtime.companion;
  const ip = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) || !loopbackHost(req.headers.host) || !trustedOrigin(req.headers.origin, req.headers.host)) return json(res, 403, {ok: false, error: '陪看接口只允许本机和已安装的浏览器扩展访问'});
  if (req.headers.origin) {res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');}
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Private-Network': 'true'});
    return res.end();
  }
  const route = url.pathname.slice('/api/companion/'.length);
  if (route === 'bootstrap' && req.method === 'GET') return json(res, 200, {ok: true, token: service.token, extensionPath: path.join(runtime.config.root, 'companion', 'extension')});
  const value = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(value); const b = Buffer.from(service.token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json(res, 403, {ok: false, error: '请重新连接陪看服务'});
  runtime.relationship?.tick();
  if (req.method === 'GET' && route === 'relationship') {
    const ids=runtime.relationship.ownerIds();
    const ownerId=url.searchParams.get('ownerId') || (ids.length===1?ids[0]:'');
    if(!ownerId) return json(res,200,{ok:true,owners:service.ownerChoices(),profile:null});
    try { return json(res,200,runtime.relationship.state(ownerId)); } catch(error) { return json(res,400,{ok:false,error:error.message}); }
  }
  if (req.method === 'GET' && route === 'state') return json(res, 200, service.state());
  if (req.method === 'POST') {
    const body = await readBody(req);
    try {
      const relation=runtime.relationship;
      if (route.startsWith('relationship/')) {
        const id=relation.owner(body.ownerId);
        let result;
        if(route==='relationship/profile') result=relation.update(id,body);
        else if(route==='relationship/memory') result=relation.addMemory(id,body.text);
        else if(route==='relationship/concern') result=relation.addConcern(id,body.text,body.dueAt);
        else if(route==='relationship/resolve') result=relation.resolveConcern(id,body.id);
        else if(route==='relationship/remove') result=relation.remove(id,body.kind,body.id);
        else if(route==='relationship/invitation/respond') {relation.flow.respond(id,body.decision);result=relation.state(id);}
        else if(route==='relationship/date/start') result=relation.startDate(id,body.kind,body.minutes,{natural:body.natural});
        else if(route==='relationship/date/end') {relation.finishDate(id,body.cancel?'cancelled':'manual');result=relation.state(id);}
        else return json(res,404,{ok:false,error:'没有这个相处操作'});
        return json(res,200,result);
      }
      if (route === 'settings') return json(res, 200, service.updateSettings(body));
      if (route === 'event') return json(res, 200, service.ingest(body));
      if (route === 'comment') return json(res, 202, {ok: true, ...service.scheduleAnalysis(true)});
    } catch (error) { return json(res, 400, {ok: false, error: error.message}); }
  }
  return json(res, 404, {ok: false, error: '没有这个陪看操作'});
}
module.exports = {companionRoute, trustedOrigin};
