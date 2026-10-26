'use strict';

/**
 * 图片理解：把图片交给视觉模型（默认智谱 GLM-4V-Flash，免费）。
 * 返回详细描述（截图会逐条转写文字），交给聊天模型接着聊。
 */
const https = require('node:https');
const DEFAULT_PROMPT = [
  '把这张图看清，用纯文本回答（不要 JSON、不要 markdown 代码块）：',
  '1. 如果是微信截图：只看气泡位置判断说话人——左边气泡一律写「对方：」，右边绿色气泡一律写「本人：」，不要根据内容猜谁是谁，也不要把气泡里的「主人」「鲸鲸」当成说话人标签。',
  '这些标签仅表示截图里的位置：“本人”指截图右侧账号，不保证是当前上传图片的人；截图可能来自机器人与其他人的聊天。能看到昵称时照原文转写，不能自行把发言归给当前用户。',
  '2. 逐条转写文字，顺序从上到下；顶部的群名、时间、未读数、电量也写出来。',
  '3. 如果是其他截图：把界面上的按钮、数字、标题按位置简单说清。照片或表情包：说清主体、场景、动作、画面里的字。',
  '最后一行用一句话总结这张图在说什么。',
  '看不清的字写「模糊」，绝对不要编造。总长度控制在 400 字以内。',
].join('\n');

function postJson(url, body, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function describe(config, { imageBase64, mime = 'image/jpeg', prompt = '' } = {}) {
  const v = (config && config.vision) || {};
  const baseUrl = String(v.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const apiKey = String(v.apiKey || '').trim();
  const model = String(v.model || 'glm-4v-flash').trim();
  if (!imageBase64) throw new Error('没有图片数据');
  if (!apiKey) throw new Error('未配置视觉模型 Key');

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
          { type: 'text', text: prompt || DEFAULT_PROMPT },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 800,
  };

  if (new URL(baseUrl).hostname === 'api.deepseek.com') body.thinking = {type: 'disabled'};
  const resp = await postJson(baseUrl + '/chat/completions', body, { Authorization: 'Bearer ' + apiKey }, Number(v.timeoutMs) || 30000);
  if (resp.status !== 200) {
    const msg = (resp.json && resp.json.error && (resp.json.error.message || resp.json.error.code)) || ('HTTP ' + resp.status);
    throw new Error('视觉模型返回：' + msg);
  }
  const text =
    resp.json &&
    resp.json.choices &&
    resp.json.choices[0] &&
    resp.json.choices[0].message &&
    resp.json.choices[0].message.content;
  const description = String(text || '').trim();
  if (!description) throw new Error('视觉模型返回空描述，图片尚未识别成功');
  return description;
}

module.exports = { describe };
