'use strict';

// Only ordinary short private chat gets a small reply budget. Detailed requests
// and potentially serious topics keep their normal generation path.
function replyRhythm(config, msg = {}) {
  if (config.persona?.promptMode !== 'full' || msg.chatType !== 'private') return null;
  const text = String(msg.cleanText || msg.text || '').trim();
  const size = Array.from(text.replace(/\s/g, '')).length;
  if (!size || size > 30 || /解释|说明|分析|原理|区别|介绍|教程|步骤|详细|展开|为什么|为啥|如何|什么是|是什么|什么意思|怎么(?:办|做|用|写|修|实现|解决|设置|安装)|帮我(?:写|改|查|算|分析|做|看看)|代码|报错|故障|生病|发烧|疼|痛|抑郁|焦虑|难受|难过|撑不住|救命|不想活|用药|剂量|合同|法律|投资|贷款|数学|证明|翻译|总结|列出|推荐几|有哪些|该不该|利弊|辞职|分手/.test(text)) return null;
  const greeting = /^(?:hi+|hey|hello|你好|嗨|在吗|在不在|嗯+|哦+|噢+|呃+|好|好的|好吧|哈哈+|啊这)[\s!！?？。～~…,.，]*$/i.test(text);
  const casual = /吃(?:啥|什么)|吃饭|午饭|晚饭|饿了|在干嘛|干嘛呢|干什么呢|想你|喜欢你|爱你|抱抱|亲亲|陪我|可爱|摸鱼|无聊|好困|累了|困了|想睡|回来了|回来啦|去忙|睡觉了|晚安|早安|早上好|中午好|下午好|晚上好|好耶|笨蛋|大肥鱼|人机|像ai|话太多|话好多|短一点|说短点|别问|别催|嗯哼|嘿嘿/i.test(text);
  if (!greeting && !casual) return null;
  return greeting ? {maxChars: 12, target: '几个字，通常3～8字'}
    : size <= 12 ? {maxChars: 22, target: '通常5～15字'}
    : {maxChars: 32, target: '通常10～25字'};
}

function rhythmHint(rule) {
  return rule ? `\n【本轮私聊节奏】最后一条才是现在要回应的话；较早发言只作背景，已经聊过的问题不用重新回答。对方这次说得很短，你也只接一个短句，${rule.target}，尽量不超过${rule.maxChars}字。一条消息、一小反应，说完停下；不补自我检讨、陪伴保证、建议或追问，不翻出较早的评价。字数没有下限，不凑字。不把简单招呼当成要求继续上一个话题。` : '';
}

function needsShorter(text, rule) {
  return Boolean(rule && (Array.from(String(text).trim()).length > rule.maxChars || /\n/.test(String(text).trim())));
}

module.exports = {replyRhythm, rhythmHint, needsShorter};
