'use strict';
// OpenAI 兼容接口客户端：列出模型 + 流式/非流式对话
const BASE = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.LLM_API_KEY || '';

function ensureConfigured() {
  if (!BASE) throw new Error('未配置 LLM_BASE_URL，请在 .env 中设置（例如 https://api.openai.com/v1）');
}

function headers() {
  return { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
}

let modelCache = { at: 0, ids: null };

async function listModels() {
  ensureConfigured();
  if (modelCache.ids && Date.now() - modelCache.at < 30_000) return modelCache.ids;
  const r = await fetch(`${BASE}/models`, { headers: headers() });
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).slice(0, 300);
    throw new Error(`上游 /models 返回 ${r.status}：${text}`);
  }
  const j = await r.json();
  const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  const ids = [...new Set(list.map((m) => m.id || m.name).filter(Boolean))].sort();
  if (!ids.length) throw new Error('上游 /models 返回了空模型列表');
  modelCache = { at: Date.now(), ids };
  return ids;
}

async function upstreamError(r) {
  const text = (await r.text().catch(() => '')).slice(0, 500);
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.message || text;
  } catch {}
  return new Error(`LLM 接口返回 ${r.status}：${msg}`);
}

// 非流式：返回完整回复文本
async function chat({ model, messages, temperature = 0.8 }) {
  ensureConfigured();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model, messages, temperature, stream: false }),
  });
  if (!r.ok) throw await upstreamError(r);
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LLM 返回格式异常：缺少 choices[0].message.content');
  return content;
}

// 流式：onDelta(text) 逐段回调，返回完整文本；signal 用于中断
async function streamChat({ model, messages, temperature = 0.8, signal, onDelta }) {
  ensureConfigured();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model, messages, temperature, stream: true }),
    signal,
  });
  if (!r.ok) throw await upstreamError(r);

  let full = '';
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.text;
      if (typeof delta === 'string' && delta) {
        full += delta;
        if (onDelta) onDelta(delta);
      }
    }
  }
  return full;
}

module.exports = { listModels, chat, streamChat };
