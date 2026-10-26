'use strict';
const $=id=>document.getElementById(id);
let token='',ownerId='',state=null,fill=true,busy=false;
const labels={open:'等到合适的时候问起',claimed:'已安排回访',done:'已回访',resolved:'已结束',cancelled:'已取消',expired:'已经过去，不再追问'};
const feedbackLabels={casual:'说话更口语，少说套话',fewerQuestions:'少反问，多接话',noMaster:'不用“主人”称呼',liked:'喜欢这种说话方式'};
const time=n=>new Date(n).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
function toast(text){$('toast').textContent=text;$('toast').style.display='block';setTimeout(()=>$('toast').style.display='none',2600);}
async function api(route,body){
  if(!token){const pair=await(await fetch('/api/companion/bootstrap')).json();token=pair.token;}
  const response=await fetch('/api/companion/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify({...body,ownerId})})});
  const result=await response.json();if(!response.ok||!result.ok){if(response.status===403)token='';throw new Error(result.error||'暂时连接不上');}return result;
}
function line(parent,text,cls=''){const node=document.createElement('div');node.textContent=text;node.className=cls;parent.append(node);return node;}
function action(parent,text,callback){const button=document.createElement('button');button.className='secondary';button.textContent=text;button.onclick=callback;parent.append(button);}
async function mutate(route,body,message){if(busy)return;busy=true;try{const result=await api('relationship/'+route,body);if(route==='profile')fill=true;render(result);if(message)toast(message);return true;}catch(error){toast(error.message);return false;}finally{busy=false;}}
function render(data){
  state=data;const p=data.profile;
  if(!p){$('error').textContent='先在调试台配置真实的微信主人 ID，并用这个账号私聊鲸鲸一次。';return;}
  $('error').textContent='';
  if(fill){for(const field of ['enabled','proactiveWithReason','autoInvites','dateFlowEnabled','autoRemember','naturalDates'])$(field).checked=p[field];for(const field of ['mode','nickname','closeness','comfort'])$(field).value=p[field];fill=false;}
  const d=p.activeDate,invite=p.invitation;
  const pending=invite?.status==='delivered'&&invite.expiresAt>Date.now();
  $('invitationBox').hidden=!pending;
  if(pending){$('invitationText').textContent=invite.text||'要不要一起待一小会儿？';$('invitationStatus').textContent=p.naturalDates?'微信里直接答应或婉拒就好，暂时没空不必回应。':'微信里回复“好呀”也可以 · '+time(invite.expiresAt)+' 后收起';}
  const phaseLabels={opening:'刚刚开始',together:'一起待着',windingDown:'慢慢收尾',closing:'这次约会结束啦'};
  $('datePhase').hidden=!d||!data.dateScene;
  $('datePhase').textContent=data.dateScene?phaseLabels[data.dateScene.phase]||'':'';
  $('dateTitle').textContent=d?d.label+' · 正在陪你':'想一起待着的时候，叫她一声就好';
  $('dateStatus').textContent=d?.natural?'跟着聊天和实际播放自然继续；想忙别的时说一声就好。':d?'还剩约 '+Math.max(0,Math.ceil((d.endAt-Date.now())/60000))+' 分钟 · '+time(d.endAt)+' 结束':'选一种喜欢的方式，慢慢待一会儿。';
  for(const button of document.querySelectorAll('[data-date]'))button.disabled=Boolean(d)||!p.enabled;
  $('endDate').disabled=$('cancelDate').disabled=!d;
  $('memories').replaceChildren();if(!p.memories.length)line($('memories'),'还没有记下的小事','small muted');
  for(const row of [...p.memories].reverse()){const item=line($('memories'),'','entry');line(item,row.text);if(row.source==='conversation')line(item,'从你的聊天里记下 · '+time(row.sourceTs||row.createdAt),'small muted');action(item,'从相处记忆移除',()=>mutate('remove',{kind:'memories',id:row.id}));}
  $('concerns').replaceChildren();if(!p.concerns.length)line($('concerns'),'还没有等待回访的事情','small muted');
  for(const row of [...p.concerns].reverse()){const item=line($('concerns'),'','entry');line(item,row.text);line(item,(row.automatic?'她会在合适的时候问起':'你特别安排的回访')+' · '+(labels[row.status]||row.status),'small muted');if(row.status==='open')action(item,'这件事结束了',()=>mutate('resolve',{id:row.id}));action(item,'移除',()=>mutate('remove',{kind:'concerns',id:row.id}));}
  $('feedback').replaceChildren();if(!p.feedback.length)line($('feedback'),'可以把喜欢或不喜欢的表达方式告诉她。','small muted');
  for(const row of [...p.feedback].reverse()){const item=line($('feedback'),'','entry');line(item,feedbackLabels[row.kind]||row.kind);if(row.example)line(item,'“'+row.example+'”','small muted');action(item,'移除这条偏好',()=>mutate('remove',{kind:'feedback',id:row.id}));}
  const rules=data.proactiveRules;
  $('rules').textContent='私聊空闲约 '+rules.idleMinutes+' 分钟，每天最多 '+rules.dailyLimit+' 次；北京时间 '+String(rules.startHour).padStart(2,'0')+':00–'+String(rules.endHour).padStart(2,'0')+':00。';
  $('pauseHint').textContent=data.paused?'当前处于暂停或休息状态。':!rules.enabled?'微信主动聊天总开关尚未开启，可到人设页面开启。':d?'当前正在约会，只安排约定内的互动；安静陪伴不插话。':'已按现有主动聊天规则等待合适时机。';
  $('dates').replaceChildren();if(!p.dates.length)line($('dates'),'还没有留下相处片段','small muted');
  for(const row of [...p.dates].reverse()){const item=line($('dates'),'','entry');line(item,row.label+' · '+(row.reason==='cancelled'?'已取消':row.minutes+' 分钟'));line(item,time(row.startedAt),'small muted');for(const video of row.videos){line(item,video.title+' · 实际采样观看 '+Math.floor(video.seconds/60)+' 分钟','small');for(const text of video.observed)line(item,text,'small muted');}if(row.kind==='chat')line(item,'时段内收到你的消息 '+row.userMessages+' 条','small muted');action(item,'移除此记录',()=>mutate('remove',{kind:'dates',id:row.id}));}
}
async function refresh(){try{render(await api('relationship'+(ownerId?'?ownerId='+encodeURIComponent(ownerId):'')));}catch(error){$('error').textContent=error.message;}}
$('owner').onchange=()=>{ownerId=$('owner').value;fill=true;refresh();};
$('save').onclick=()=>{mutate('profile',{enabled:$('enabled').checked,proactiveWithReason:$('proactiveWithReason').checked,autoInvites:$('autoInvites').checked,dateFlowEnabled:$('dateFlowEnabled').checked,autoRemember:$('autoRemember').checked,naturalDates:$('naturalDates').checked,mode:$('mode').value,nickname:$('nickname').value,closeness:$('closeness').value,comfort:$('comfort').value},'相处偏好已保存，立即生效');};
$('addMemory').onclick=async()=>{const text=$('memoryText').value;if(!text.trim())return;if(await mutate('memory',{text},'记下来啦'))$('memoryText').value='';};
$('addConcern').onclick=async()=>{const text=$('concernText').value,dueAt=Date.parse($('dueAt').value+':00+08:00');if(!text.trim()||!Number.isFinite(dueAt))return toast('写下事情和回访时间呀');await mutate('concern',{text,dueAt},'回访事项已记下');};
for(const button of document.querySelectorAll('[data-date]'))button.onclick=()=>mutate('date/start',{kind:button.dataset.date,minutes:Number($('minutes').value),natural:!$('timedDate').checked&&$('naturalDates').checked},'开始这段陪伴啦');
$('acceptInvitation').onclick=()=>mutate('invitation/respond',{decision:'accept'},'好耶，开始这段陪伴啦');
$('declineInvitation').onclick=()=>mutate('invitation/respond',{decision:'decline'},'邀请已收起，不会催你');
$('endDate').onclick=()=>mutate('date/end',{},'这次相处已经记下来啦');
$('cancelDate').onclick=()=>mutate('date/end',{cancel:true},'这次约会已取消');
(async()=>{try{const watch=await api('state');const owners=watch.owners||[];$('owner').replaceChildren();for(const owner of owners){const option=document.createElement('option');option.value=owner.id;option.textContent=owner.name+(owner.hasConversation?'':'（需要先私聊一次）');$('owner').append(option);}ownerId=owners.some(o=>o.id===watch.settings.ownerId)?watch.settings.ownerId:owners[0]?.id||'';$('owner').value=ownerId;$('dueAt').value=new Date(Date.now()+86400000+8*3600000).toISOString().slice(0,10)+'T18:00';await refresh();}catch(error){$('error').textContent=error.message;}})();
setInterval(refresh,3000);
