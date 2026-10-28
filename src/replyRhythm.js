'use strict';

// Default to a small response for ordinary private conversation. These exclusions
// only protect answer length; they do not interpret tasks or authorize actions.
function ordinaryPrivateChat(config, msg = {}) {
  if (config.persona?.promptMode !== 'full' || msg.chatType !== 'private' || msg.replyNeedsRoom === true) return false;
  const text = String(msg.cleanText || msg.text || '').trim();
  if (!text || Array.from(text.replace(/\s/g, '')).length > 60) return false;
  return !/解释|说明|分析|原理|区别|介绍|教程|步骤|详细|展开|为什么|为啥|如何|什么是|是什么|什么意思|该怎么|怎么(?:办|做|用|写|修|实现|解决|设置|安装)|帮我(?:写|改|查|算|分析|做|看看)|代码|报错|故障|生病|发烧|疼|痛|抑郁|焦虑|难受|难过|撑不住|救命|不想活|用药|剂量|合同|法律|投资|贷款|数学|证明|翻译|总结|列出|推荐|有哪些|该不该|利弊|辞职|分手|面试|考试|答辩|求职|备考|谈一谈|聊聊.{0,8}(?:事情|问题)|教我|题目|求助|怎么办|清单|计划|方案|攻略|对比|评估|帮忙|计算|预算|续写|文章|故事|论文|报告|写一|写个|写首|写段|编一|编个|作诗|食谱|安排|提醒|转告|转发|发朋友圈|发消息|重发|再发|复述|照着|原文|前面那段|刚才那段|多说|多讲|讲讲|说说|说清楚|认真|具体|几个|几种|几点|几条|多一点|长一点|长点|https?:\/\/|```/.test(text);
}

function replyRhythm(config, msg = {}) {
  if (!ordinaryPrivateChat(config, msg)) return null;
  const text = String(msg.cleanText || msg.text || '').trim();
  const greeting = /^(?:hi+|hey|hello|你好|嗨|在吗|在不在|嗯+|哦+|噢+|呃+|好|好的|好吧|哈哈+|啊这)[\s!！?？。～~…,.，]*$/i.test(text);
  return greeting ? {maxChars:12,target:'几个字，通常3～8字'}
    : {maxChars:22,target:'一个自然短反应，通常5～20字'};
}

function rhythmHint(rule) {
  return rule ? `\n【本轮私聊节奏】先接住最近正在聊的具体内容，${rule.target}，尽量不超过${rule.maxChars}字。默认一小句；需要两条时用换行分开。表达小情绪、偏好或回应即可，说完停下；不附自我检讨、陪伴保证和多余追问。不要为了凑可爱而讲尾巴或编造生活经历。当前明确要求详细、复述或办事时，以说清楚和实际执行结果为准；字数提示不覆盖这些要求。` : '';
}

function needsShorter(text, rule) {
  return Boolean(rule && Array.from(String(text).trim()).length > rule.maxChars);
}

module.exports = {ordinaryPrivateChat, replyRhythm, rhythmHint, needsShorter};
