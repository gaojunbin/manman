'use strict';
/* 慢慢 —— 前端单页应用（无框架） */

const app = document.getElementById('app');
const $ = (sel, root = document) => root.querySelector(sel);

let me = null;            // 当前登录用户名
let modelsCache = null;   // {models:[], default:''}
let currentAC = null;     // 当前流式请求的 AbortController
let ws = null;            // 工作台状态 {story, tab, streaming, genNum, auto}

/* ---------- 基础工具 ---------- */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS_LABEL = { planning: '策划中', writing: '连载中', done: '已完结' };

/* 轻量 Markdown 渲染（用于策划对话气泡） */
function inlineMd(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function mdToHtml(src) {
  const out = [];
  let list = null, para = [], code = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>'); para = []; } };
  for (const line of String(src).split('\n')) {
    if (code !== null) {
      if (/^\s*```/.test(line)) { out.push('<pre>' + esc(code.join('\n')) + '</pre>'); code = null; }
      else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flushPara(); closeList(); code = []; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { flushPara(); closeList(); out.push('<h4>' + inlineMd(h[2]) + '</h4>'); continue; }
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.、)]\s+(.*)/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
      out.push('<li>' + inlineMd((ul || ol)[1]) + '</li>');
      continue;
    }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    para.push(line);
  }
  if (code !== null) out.push('<pre>' + esc(code.join('\n')) + '</pre>');
  flushPara(); closeList();
  return out.join('');
}

/* ---------- API ---------- */
async function api(method, url, body) {
  const resp = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (resp.status === 401) { renderLogin(); throw new Error('未登录'); }
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `请求失败（${resp.status}）`);
  return j;
}

/* 通用 SSE 流式请求：每个事件回调 onEvent */
async function streamSSE(url, { method = 'GET', body, signal, onEvent }) {
  const resp = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (resp.status === 401) { renderLogin(); throw new Error('未登录'); }
  const ctype = resp.headers.get('content-type') || '';
  if (!resp.ok || ctype.includes('application/json')) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.error || `请求失败（${resp.status}）`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let obj;
        try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
        await onEvent(obj);
      }
    }
  }
}

/* 策划对话用：POST 流式，onDelta 逐段回调，返回 done 事件对象 */
async function streamPost(url, body, onDelta) {
  const ac = new AbortController();
  currentAC = ac;
  try {
    let doneEvt = null;
    await streamSSE(url, {
      method: 'POST',
      body: body || {},
      signal: ac.signal,
      onEvent: (obj) => {
        if (obj.type === 'delta') onDelta(obj.text);
        else if (obj.type === 'done') doneEvt = obj;
        else if (obj.type === 'error') throw new Error(obj.message || 'LLM 调用失败');
      },
    });
    if (!doneEvt) throw new Error('连接中断，内容未保存，请重试');
    return doneEvt;
  } finally {
    if (currentAC === ac) currentAC = null;
  }
}

function abortStream() {
  if (currentAC) { currentAC.abort(); currentAC = null; }
}

async function loadModels() {
  if (modelsCache) return modelsCache;
  const j = await api('GET', '/api/models');
  modelsCache = j;
  return j;
}

/* ---------- 路由 ---------- */
window.addEventListener('hashchange', route);

async function route() {
  abortStream();
  if (ws && ws.genAC) ws.genAC.abort(); // 断开对生成任务的挂载（任务本身继续在服务端运行）
  ws = null;
  if (!me) return;
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\//, '').split('/');
  try {
    if (parts[0] === '' || parts[0] === undefined) return await renderHome();
    if (parts[0] === 'new') return await renderNew();
    if (parts[0] === 'story' && parts[1]) return await renderStory(parts[1]);
    if (parts[0] === 'read' && parts[1]) return await renderReader(parts[1], parseInt(parts[2] || '1', 10));
    location.hash = '#/';
  } catch (e) {
    if (e.message !== '未登录') {
      app.innerHTML = `<div class="container">${topbar()}<div class="error-banner">${esc(e.message)}</div>
        <a class="btn" href="#/">← 返回书架</a></div>`;
      bindTopbar();
    }
  }
}

function topbar() {
  return `<div class="topbar">
    <div class="brand" id="brandHome">
      <div class="seal">慢</div>
      <div><div class="name">慢慢</div><div class="tagline">同人文 · 慢慢写，慢慢读</div></div>
    </div>
    <div class="spacer"></div>
    <span class="user">${esc(me || '')}</span>
    <button class="btn small ghost" id="logoutBtn">退出</button>
  </div>`;
}
function bindTopbar() {
  const b = $('#brandHome');
  if (b) b.onclick = () => { location.hash = '#/'; if (location.hash === '#/') route(); };
  const l = $('#logoutBtn');
  if (l) l.onclick = async () => { await fetch('/api/logout', { method: 'POST' }); me = null; renderLogin(); };
}

/* ---------- 登录 ---------- */
function renderLogin(errMsg) {
  ws = null;
  app.innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="seal">慢</div>
    <h1>慢慢</h1>
    <div class="sub">同人文创作与阅读 · 慢慢写，慢慢读</div>
    ${errMsg ? `<div class="error-banner">${esc(errMsg)}</div>` : ''}
    <form id="loginForm">
      <input id="loginUser" placeholder="账号" autocomplete="username" required>
      <input id="loginPass" type="password" placeholder="密码" autocomplete="current-password" required>
      <button class="btn primary" type="submit">进 入</button>
    </form>
  </div></div>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const j = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#loginUser').value.trim(), password: $('#loginPass').value }),
      }).then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || '登录失败');
        return body;
      });
      me = j.username;
      location.hash = '#/';
      route();
    } catch (err) {
      renderLogin(err.message);
    }
  };
  $('#loginUser').focus();
}

/* ---------- 书架 ---------- */
async function renderHome() {
  const j = await api('GET', '/api/stories');
  const cards = j.stories.map((s) => {
    const progress = s.totalChapters ? `${s.writtenChapters}/${s.totalChapters} 章` : '大纲策划中';
    return `<div class="story-card" data-id="${s.id}">
      <div class="title">${esc(s.title)}</div>
      <div class="row">
        <span class="badge ${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
        <span class="progress-text">${progress}</span>
      </div>
      <div class="meta">原作《${esc(s.source)}》 · ${esc(s.characters)}</div>
      <div class="meta hint">${esc(s.model)} · 更新于 ${fmtTime(s.updatedAt)}</div>
      <div class="actions">
        <button class="btn small" data-act="open">进入工作台</button>
        ${s.writtenChapters ? `<button class="btn small" data-act="read">开始阅读</button>` : ''}
        <span style="flex:1"></span>
        <button class="btn small ghost danger" data-act="del">删除</button>
      </div>
    </div>`;
  }).join('');

  app.innerHTML = `<div class="container">${topbar()}
    <div class="shelf-head">
      <h2>我的书架</h2>
      <span class="hint">${j.stories.length ? `共 ${j.stories.length} 部作品` : ''}</span>
      <span style="flex:1"></span>
      <button class="btn primary" id="newBtn">＋ 开新坑</button>
    </div>
    ${j.stories.length ? `<div class="story-grid">${cards}</div>` : `
      <div class="empty"><div class="big">📖</div>书架还空着，点击「开新坑」开始你的第一部同人作品吧</div>`}
  </div>`;
  bindTopbar();
  $('#newBtn').onclick = () => { location.hash = '#/new'; };
  for (const card of app.querySelectorAll('.story-card')) {
    const id = card.dataset.id;
    card.onclick = () => { location.hash = '#/story/' + id; };
    for (const btn of card.querySelectorAll('[data-act]')) {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'open') location.hash = '#/story/' + id;
        else if (act === 'read') location.hash = '#/read/' + id + '/1';
        else if (act === 'del') {
          if (!confirm('确定删除这部作品吗？所有章节将一并删除，无法恢复。')) return;
          await api('DELETE', '/api/stories/' + id);
          renderHome();
        }
      };
    }
  }
}

/* ---------- 开新坑 ---------- */
async function renderNew() {
  app.innerHTML = `<div class="container">${topbar()}
    <div class="form-card">
      <h2>开新坑</h2>
      <div class="sub">告诉「慢慢」你想写什么，AI 编辑会与你一起打磨大纲，然后逐章创作。</div>
      <form id="newForm">
        <div class="field"><label><b>基于什么作品二创</b>（原作名）</label>
          <input id="fSource" placeholder="例如：凡人修仙传" required></div>
        <div class="field"><label><b>想写的主角</b>（可多位，用顿号分隔）</label>
          <input id="fChars" placeholder="例如：韩立、玄骨" required></div>
        <div class="field"><label><b>预期篇幅</b></label>
          <input id="fLength" placeholder="例如：大约 10 章" value="大约 10 章"></div>
        <div class="field"><label><b>特殊要求</b>（题材偏好、CP 走向、文风、结局倾向……可留空）</label>
          <textarea id="fReq" placeholder="例如：走原著修仙流风格，节奏明快，多写斗法场面，结局 HE"></textarea></div>
        <div class="field"><label><b>创作模型</b></label>
          <select id="fModel"><option value="">正在获取可用模型…</option></select>
          <input id="fModelCustom" style="display:none;margin-top:8px" placeholder="输入模型 ID，例如 gpt-4o">
          <div class="hint" id="modelHint" style="margin-top:6px"></div></div>
        <div id="newErr"></div>
        <div class="form-actions">
          <button class="btn primary" type="submit" id="createBtn">创建作品，开始策划 →</button>
          <a class="btn" href="#/">取消</a>
        </div>
      </form>
    </div></div>`;
  bindTopbar();

  const sel = $('#fModel'), custom = $('#fModelCustom');
  sel.onchange = () => { custom.style.display = sel.value === '__custom__' ? 'block' : 'none'; };
  try {
    const j = await loadModels();
    sel.innerHTML = j.models.map((m) => `<option value="${esc(m)}"${m === j.default ? ' selected' : ''}>${esc(m)}</option>`).join('') +
      '<option value="__custom__">其他（手动输入模型 ID）…</option>';
  } catch (e) {
    sel.innerHTML = '<option value="__custom__">手动输入模型 ID</option>';
    custom.style.display = 'block';
    $('#modelHint').innerHTML = `<span style="color:#8f3016">获取模型列表失败：${esc(e.message)}</span>`;
  }

  $('#newForm').onsubmit = async (e) => {
    e.preventDefault();
    const model = sel.value === '__custom__' ? custom.value.trim() : sel.value;
    $('#newErr').innerHTML = '';
    try {
      const j = await api('POST', '/api/stories', {
        source: $('#fSource').value.trim(),
        characters: $('#fChars').value.trim(),
        length: $('#fLength').value.trim(),
        requirements: $('#fReq').value.trim(),
        model,
      });
      location.hash = '#/story/' + j.story.id;
    } catch (err) {
      $('#newErr').innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
    }
  };
}

/* ---------- 工作台 ---------- */
async function renderStory(id) {
  const j = await api('GET', '/api/stories/' + id);
  ws = {
    story: j.story,
    tab: j.story.status === 'planning' ? 'plan' : 'chapters',
    streaming: false, // 策划对话进行中（前台流式）
    gen: j.job ? { num: j.job.num, title: j.job.title || '', buffer: '', auto: j.job.auto } : null, // 后台生成任务
    genAC: null,
    err: '',
  };
  drawWorkspace();
  if (ws.gen) attachGenStream();
  // 新作品自动开启第一轮策划；若上次回复被中断（最后一条是作者消息），也自动续上
  const s = ws.story;
  const msgs = s.messages;
  const needKick = s.status === 'planning' &&
    (!msgs.some((m) => m.role === 'assistant') || (msgs.length && msgs[msgs.length - 1].role === 'user'));
  if (needKick && !ws.streaming) startPlanStream(null);
}

function visibleMessages(story) {
  return story.messages.filter((m) => !(m.auto && m.role === 'user'));
}

function nextChapterNum(story) {
  if (!story.outline) return null;
  for (const c of story.outline.chapters) {
    if (!(story.chapters || []).some((w) => w.num === c.num && w.content)) return c.num;
  }
  return null;
}

function drawWorkspace() {
  if (!ws) return;
  const s = ws.story;
  const planBadgeCount = visibleMessages(s).length;
  const total = s.outline ? s.outline.chapters.length : 0;
  const written = (s.chapters || []).filter((c) => c.content).length;

  app.innerHTML = `<div class="container">${topbar()}
    <div class="ws-head">
      <a class="btn small ghost" href="#/">← 书架</a>
      <div class="title-row" style="margin-top:8px">
        <h2>${esc(s.title)}</h2>
        <span class="badge ${s.status}">${STATUS_LABEL[s.status]}</span>
      </div>
      <div class="ws-meta">
        <span class="chip">原作《${esc(s.source)}》</span>
        <span class="chip">主角：${esc(s.characters)}</span>
        <span class="chip">篇幅：${esc(s.length)}</span>
        <span>模型：<select id="wsModel"><option>${esc(s.model)}</option></select></span>
        ${written ? `<a class="btn small" href="/api/stories/${s.id}/export">⬇ 导出 Markdown</a>` : ''}
      </div>
    </div>
    <div class="tabs">
      <button class="tab ${ws.tab === 'plan' ? 'active' : ''}" data-tab="plan">① 大纲策划 <span class="hint">(${planBadgeCount})</span></button>
      <button class="tab ${ws.tab === 'chapters' ? 'active' : ''}" data-tab="chapters">② 章节创作 <span class="hint">(${written}/${total || '?'})</span></button>
    </div>
    <div id="wsErr">${ws.err ? `<div class="error-banner">${esc(ws.err)}</div>` : ''}</div>
    <div id="wsBody">${ws.tab === 'plan' ? planPaneHtml(s) : chaptersPaneHtml(s)}</div>
  </div>`;
  bindTopbar();

  for (const t of app.querySelectorAll('.tab')) {
    t.onclick = () => {
      if (ws.streaming) return;
      ws.tab = t.dataset.tab; ws.err = '';
      drawWorkspace();
    };
  }
  populateModelSelect();
  if (ws.tab === 'plan') bindPlanPane();
  else bindChaptersPane();
}

async function populateModelSelect() {
  const sel = $('#wsModel');
  if (!sel) return;
  try {
    const j = await loadModels();
    const cur = ws.story.model;
    const list = j.models.includes(cur) ? j.models : [cur, ...j.models];
    sel.innerHTML = list.map((m) => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('');
    sel.onchange = async () => {
      try {
        const r = await api('PATCH', '/api/stories/' + ws.story.id, { model: sel.value });
        ws.story = r.story;
      } catch (e) { setWsError('切换模型失败：' + e.message); }
    };
  } catch { /* 模型列表拉取失败时保留当前值 */ }
}

function setWsError(msg) {
  if (!ws) return;
  ws.err = msg || '';
  const box = $('#wsErr');
  if (box) box.innerHTML = msg ? `<div class="error-banner">${esc(msg)}</div>` : '';
}

/* ----- 策划面板 ----- */
function planPaneHtml(s) {
  const msgs = visibleMessages(s).map((m) => `
    <div class="msg ${m.role}">
      <div class="avatar">${m.role === 'assistant' ? '慢' : '我'}</div>
      <div class="bubble">${mdToHtml(m.content)}</div>
    </div>`).join('');
  const canFinalize = s.messages.some((m) => m.role === 'assistant');
  return `
    <div class="chat-box" id="chatBox">${msgs || '<div class="hint">正在为你联系 AI 编辑…</div>'}</div>
    <div class="chat-input">
      <textarea id="chatText" placeholder="回答 AI 的问题，或对大纲提出修改意见…（Ctrl+Enter 发送）"></textarea>
      <button class="btn primary" id="sendBtn">发送</button>
    </div>
    <div class="plan-actions">
      <button class="btn primary" id="finalizeBtn" ${canFinalize ? '' : 'disabled'}>✓ 确认大纲，开始创作</button>
      ${s.outline ? '<span class="hint">已确认过大纲；再次点击会按最新讨论重新整理，已写章节按章节号保留。</span>'
        : '<span class="hint">对大纲满意后点击确认，AI 会把大纲整理成章节列表。</span>'}
    </div>`;
}

function bindPlanPane() {
  const text = $('#chatText'), send = $('#sendBtn'), fin = $('#finalizeBtn');
  const doSend = () => {
    const v = text.value.trim();
    if (!v || ws.streaming) return;
    text.value = '';
    startPlanStream(v);
  };
  send.onclick = doSend;
  text.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSend(); } };
  fin.onclick = doFinalize;
  const box = $('#chatBox');
  if (box) box.scrollTop = box.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
}

async function startPlanStream(message) {
  if (!ws || ws.streaming) return;
  ws.streaming = true; ws.err = '';
  const storyId = ws.story.id;
  const box = $('#chatBox');
  if (message) {
    box.insertAdjacentHTML('beforeend',
      `<div class="msg user"><div class="avatar">我</div><div class="bubble">${mdToHtml(message)}</div></div>`);
  }
  box.insertAdjacentHTML('beforeend',
    `<div class="msg assistant" id="streamMsg"><div class="avatar">慢</div><div class="bubble"><span class="cursor"></span></div></div>`);
  const bubble = $('#streamMsg .bubble');
  const send = $('#sendBtn'), fin = $('#finalizeBtn');
  if (send) send.disabled = true;
  if (fin) fin.disabled = true;
  let buf = '';
  try {
    await streamPost(`/api/stories/${storyId}/chat`, message ? { message } : {}, (t) => {
      buf += t;
      bubble.innerHTML = mdToHtml(buf) + '<span class="cursor"></span>';
      window.scrollTo(0, document.body.scrollHeight);
    });
  } catch (e) {
    if (e.name === 'AbortError') return; // 已切换页面
    if (ws && ws.story.id === storyId) setWsError('AI 回复失败：' + e.message);
  }
  if (!ws || ws.story.id !== storyId) return;
  ws.streaming = false;
  try {
    const j = await api('GET', '/api/stories/' + storyId);
    ws.story = j.story;
  } catch {}
  if (ws.tab === 'plan') drawWorkspace();
}

async function doFinalize() {
  if (!ws || ws.streaming) return;
  const fin = $('#finalizeBtn');
  fin.disabled = true;
  fin.textContent = '正在整理结构化大纲…';
  setWsError('');
  try {
    const j = await api('POST', `/api/stories/${ws.story.id}/finalize`);
    ws.story = j.story;
    ws.tab = 'chapters';
    drawWorkspace();
  } catch (e) {
    drawWorkspace();
    setWsError(e.message);
  }
}

/* ----- 章节面板（生成在服务端后台运行，关闭页面不中断） ----- */
function chaptersPaneHtml(s) {
  if (!s.outline) {
    return `<div class="empty"><div class="big">🗂</div>还没有确认大纲<br><br>
      <button class="btn" id="gotoPlan">← 先去「大纲策划」和 AI 编辑讨论</button></div>`;
  }
  const next = nextChapterNum(s);
  const busy = !!ws.gen;
  const rows = s.outline.chapters.map((c) => {
    const w = (s.chapters || []).find((x) => x.num === c.num && x.content);
    const isGenerating = busy && ws.gen.num === c.num;
    return `<div class="chapter-row ${isGenerating ? 'writing-now' : ''}">
      <div class="num">第${c.num}章</div>
      <div class="body">
        <div class="ct"><span class="dot ${w ? 'done' : 'todo'}"></span>${esc(c.title)}</div>
        <div class="cs">${esc(c.summary)}</div>
        ${w ? `<div class="hint" style="margin-top:4px">${w.content.length} 字 · ${fmtTime(w.updatedAt)}</div>` : ''}
      </div>
      <div class="ops">
        ${w ? `<a class="btn small" href="#/read/${s.id}/${c.num}">阅读</a>
               <button class="btn small ghost" data-rewrite="${c.num}" ${busy ? 'disabled' : ''}>重写</button>`
            : (c.num === next
               ? `<button class="btn small primary" data-gen="${c.num}" ${busy ? 'disabled' : ''}>✍ 生成本章</button>`
               : '<span class="hint">待前文完成</span>')}
      </div>
    </div>`;
  }).join('');

  const genPanel = busy ? `
    <div class="gen-panel">
      <div class="gp-head">
        <b>正在创作 ${ws.gen.num ? `第${ws.gen.num}章` : ''}${ws.gen.title ? `《${esc(ws.gen.title)}》` : ''}</b>
        ${ws.gen.auto ? '<span class="badge writing">连续生成中</span>' : ''}
        <span class="hint">后台任务运行中，关闭页面也会继续创作</span>
        <span style="flex:1"></span>
        <button class="btn small" id="stopGenBtn">■ 停止</button>
      </div>
      <div class="gp-text" id="genText"></div>
    </div>` : '';

  const allDone = !next;
  return `
    <div class="chapter-toolbar">
      ${allDone
        ? `<span class="badge done">🎉 全部 ${s.outline.chapters.length} 章已完成</span>
           <a class="btn primary" href="#/read/${s.id}/1">从头开始阅读</a>`
        : (busy
          ? `<span class="hint">✍ 创作进行中…可随时关闭页面，回来接着看</span>`
          : `<button class="btn primary" id="genNextBtn">✍ 生成下一章（第${next}章）</button>
             <label class="checkbox-label"><input type="checkbox" id="autoChk"> 连续生成直到完结</label>`)}
      <span class="hint">《${esc(s.outline.title)}》：${esc(s.outline.summary)}</span>
    </div>
    ${genPanel}
    <div class="chapter-list">${rows}</div>`;
}

function bindChaptersPane() {
  const gp = $('#gotoPlan');
  if (gp) gp.onclick = () => { ws.tab = 'plan'; drawWorkspace(); };
  const genNext = $('#genNextBtn');
  if (genNext) genNext.onclick = () => {
    const auto = !!($('#autoChk') && $('#autoChk').checked);
    startGeneration({ auto });
  };
  for (const b of app.querySelectorAll('[data-gen]')) {
    b.onclick = () => startGeneration({ num: parseInt(b.dataset.gen, 10) });
  }
  for (const b of app.querySelectorAll('[data-rewrite]')) {
    b.onclick = () => {
      const num = parseInt(b.dataset.rewrite, 10);
      const fb = prompt(`重写第 ${num} 章。\n可以输入对本章的修改要求（留空则直接重写）：`, '');
      if (fb === null) return;
      startGeneration({ num, instructions: fb.trim() });
    };
  }
  const stop = $('#stopGenBtn');
  if (stop) stop.onclick = async () => {
    stop.disabled = true;
    try { await api('POST', `/api/stories/${ws.story.id}/generate/stop`); } catch {}
  };
  // 重绘后恢复已生成的实时文字
  const panel = $('#genText');
  if (panel && ws.gen) { panel.textContent = ws.gen.buffer; panel.scrollTop = panel.scrollHeight; }
}

async function refetchStory() {
  if (!ws) return;
  try {
    const j = await api('GET', '/api/stories/' + ws.story.id);
    ws.story = j.story;
  } catch {}
}

function drawIfChapters() {
  if (ws && ws.tab === 'chapters') drawWorkspace();
}

/* 启动后台生成任务并挂载实时进度 */
async function startGeneration(opts) {
  if (!ws || ws.gen) return;
  setWsError('');
  const storyId = ws.story.id;
  try {
    await api('POST', `/api/stories/${storyId}/generate`, opts);
  } catch (e) {
    setWsError(e.message);
    return;
  }
  if (!ws || ws.story.id !== storyId) return;
  ws.gen = { num: opts.num || null, title: '', buffer: '', auto: !!opts.auto };
  drawWorkspace();
  attachGenStream();
}

/* 挂载后台任务的 SSE 进度流（页面打开期间实时显示；断开不影响任务） */
async function attachGenStream() {
  if (!ws || ws.genAC) return;
  const storyId = ws.story.id;
  const ac = new AbortController();
  ws.genAC = ac;
  try {
    await streamSSE(`/api/stories/${storyId}/generate/stream`, {
      signal: ac.signal,
      onEvent: async (evt) => {
        if (!ws || ws.story.id !== storyId) return;
        if (evt.type === 'snapshot') {
          ws.gen = { num: evt.num, title: evt.title || '', buffer: evt.text || '', auto: evt.auto };
          drawIfChapters();
        } else if (evt.type === 'start') {
          ws.gen = { num: evt.num, title: evt.title || '', buffer: '', auto: evt.auto };
          await refetchStory();
          drawIfChapters();
        } else if (evt.type === 'delta') {
          if (!ws.gen) return;
          ws.gen.buffer += evt.text;
          const p = $('#genText');
          if (p) { p.textContent = ws.gen.buffer; p.scrollTop = p.scrollHeight; }
        } else if (evt.type === 'chapter_done') {
          await refetchStory();
          drawIfChapters();
        } else if (evt.type === 'job_done' || evt.type === 'stopped' || evt.type === 'idle') {
          ws.gen = null;
          await refetchStory();
          drawIfChapters();
        } else if (evt.type === 'error') {
          ws.gen = null;
          ws.err = '生成失败：' + evt.message;
          await refetchStory();
          drawIfChapters();
        }
      },
    });
  } catch (e) {
    // 挂载流断开（网络波动/切页）：任务仍在服务端运行
  }
  if (ws && ws.story.id === storyId && ws.genAC === ac) ws.genAC = null;
  // 任务看起来还在进行但连接断了 → 稍后自动重连（若任务已结束会收到 idle 自然停下）
  if (ws && ws.story.id === storyId && ws.gen && !ws.genAC) {
    setTimeout(() => {
      if (ws && ws.story.id === storyId && ws.gen && !ws.genAC) attachGenStream();
    }, 3000);
  }
}

/* ---------- 阅读器 ---------- */
async function renderReader(id, num) {
  const j = await api('GET', '/api/stories/' + id);
  const s = j.story;
  const written = (s.chapters || []).filter((c) => c.content);
  const ch = written.find((c) => c.num === num);
  if (!ch) {
    app.innerHTML = `<div class="container">${topbar()}
      <div class="empty"><div class="big">🖋</div>第 ${num} 章还没有写好<br><br>
      <a class="btn" href="#/story/${id}">去工作台创作</a></div></div>`;
    bindTopbar();
    return;
  }
  const hasPrev = written.some((c) => c.num === num - 1);
  const hasNext = written.some((c) => c.num === num + 1);
  const size = parseInt(localStorage.getItem('manman_reader_size') || '18', 10);
  document.documentElement.style.setProperty('--reader-size', size + 'px');

  const paras = ch.content.split(/\n+/).filter((p) => p.trim()).map((p) => `<p>${esc(p.trim())}</p>`).join('');
  app.innerHTML = `
    <div class="reader-bar">
      <a class="btn small ghost" href="#/story/${id}">← 工作台</a>
      <div class="rt">${esc(s.title)} · 第${ch.num}章 ${esc(ch.title)}</div>
      <button class="btn small" id="fontMinus">A−</button>
      <button class="btn small" id="fontPlus">A＋</button>
    </div>
    <div class="reader">
      <h1>第${ch.num}章 ${esc(ch.title)}</h1>
      <div class="r-meta">${esc(s.title)} · 原作《${esc(s.source)}》 · ${ch.content.length} 字</div>
      <div class="reader-content">${paras}</div>
      <div class="reader-nav">
        ${hasPrev ? `<a class="btn" href="#/read/${id}/${num - 1}">← 上一章</a>` : '<span></span>'}
        <a class="btn ghost" href="#/story/${id}">目录</a>
        ${hasNext ? `<a class="btn" href="#/read/${id}/${num + 1}">下一章 →</a>` : `<a class="btn" href="#/story/${id}">已是最新 · 返回</a>`}
      </div>
    </div>`;
  window.scrollTo(0, 0);
  const setSize = (d) => {
    const cur = parseInt(localStorage.getItem('manman_reader_size') || '18', 10);
    const next = Math.min(26, Math.max(14, cur + d));
    localStorage.setItem('manman_reader_size', String(next));
    document.documentElement.style.setProperty('--reader-size', next + 'px');
  };
  $('#fontMinus').onclick = () => setSize(-2);
  $('#fontPlus').onclick = () => setSize(2);
}

/* ---------- 启动 ---------- */
(async function boot() {
  try {
    const j = await fetch('/api/me').then((r) => r.json());
    if (j.authenticated) {
      me = j.username;
      route();
    } else {
      renderLogin();
    }
  } catch {
    renderLogin('无法连接服务器，请刷新重试');
  }
})();
