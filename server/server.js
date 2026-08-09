'use strict';
// 慢慢 —— 同人文创作与阅读网站（零依赖 Node.js 服务）
const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const store = require('./store');
const llm = require('./llm');
const prompts = require('./prompts');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';

// ---------- 小工具 ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}
function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ---------- 路由表 ----------
const routes = [];
function route(method, pattern, handler, { needAuth = true } = {}) {
  const keys = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, regex, keys, handler, needAuth });
}

// ---------- 认证 ----------
route('POST', '/api/login', async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  if (!auth.loginAllowed(ip)) return sendJSON(res, 429, { error: '尝试次数过多，请 1 分钟后再试' });
  const body = await readBody(req);
  const ok = auth.verifyLogin(String(body.username || ''), String(body.password || ''));
  auth.recordLogin(ip, ok);
  if (!ok) return sendJSON(res, 401, { error: '账号或密码错误' });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': auth.issueCookie() });
  res.end(JSON.stringify({ ok: true, username: auth.USERNAME }));
}, { needAuth: false });

route('POST', '/api/logout', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': auth.clearCookie() });
  res.end(JSON.stringify({ ok: true }));
}, { needAuth: false });

route('GET', '/api/me', async (req, res) => {
  const user = auth.checkRequest(req);
  sendJSON(res, 200, { authenticated: !!user, username: user });
}, { needAuth: false });

// ---------- 模型 ----------
route('GET', '/api/models', async (req, res) => {
  try {
    const models = await llm.listModels();
    sendJSON(res, 200, { models, default: DEFAULT_MODEL && models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0] });
  } catch (e) {
    sendJSON(res, 502, { error: e.message });
  }
});

// ---------- 作品 CRUD ----------
route('GET', '/api/stories', async (req, res) => {
  sendJSON(res, 200, { stories: store.listStories() });
});

route('POST', '/api/stories', async (req, res) => {
  const b = await readBody(req);
  const source = String(b.source || '').trim();
  const characters = String(b.characters || '').trim();
  const length = String(b.length || '').trim();
  const model = String(b.model || '').trim();
  if (!source || !characters) return sendJSON(res, 400, { error: '请填写原作与主角' });
  if (!model) return sendJSON(res, 400, { error: '请选择模型' });
  const story = store.createStory({
    source,
    characters,
    length: length || '大约 10 章',
    requirements: String(b.requirements || '').trim(),
    model,
  });
  sendJSON(res, 200, { story });
});

route('GET', '/api/stories/:id', async (req, res, params) => {
  const story = store.getStory(params.id);
  if (!story) return sendJSON(res, 404, { error: '作品不存在' });
  sendJSON(res, 200, { story, job: jobPublic(genJobs.get(story.id)) });
});

route('PATCH', '/api/stories/:id', async (req, res, params) => {
  const story = store.getStory(params.id);
  if (!story) return sendJSON(res, 404, { error: '作品不存在' });
  const b = await readBody(req);
  if (typeof b.model === 'string' && b.model.trim()) story.model = b.model.trim();
  if (typeof b.title === 'string' && b.title.trim()) story.title = b.title.trim();
  store.saveStory(story);
  sendJSON(res, 200, { story });
});

route('DELETE', '/api/stories/:id', async (req, res, params) => {
  const job = genJobs.get(params.id);
  if (job) {
    job.stopRequested = true;
    if (job.ac) job.ac.abort();
  }
  store.deleteStory(params.id);
  sendJSON(res, 200, { ok: true });
});

// ---------- 策划阶段：多轮对话（SSE 流式） ----------
route('POST', '/api/stories/:id/chat', async (req, res, params) => {
  const story = store.getStory(params.id);
  if (!story) return sendJSON(res, 404, { error: '作品不存在' });
  const b = await readBody(req);

  const userText = String(b.message || '').trim();
  if (userText) {
    story.messages.push({ role: 'user', content: userText, ts: Date.now() });
    store.saveStory(story);
  } else if (story.messages.length === 0) {
    story.messages.push({ role: 'user', content: prompts.initialUserPrompt(), ts: Date.now(), auto: true });
    store.saveStory(story);
  } else if (story.messages[story.messages.length - 1].role !== 'user') {
    return sendJSON(res, 400, { error: '请输入内容' });
  }

  const llmMessages = [
    { role: 'system', content: prompts.plannerSystem(story) },
    ...story.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  sseStart(res);
  const ac = new AbortController();
  // 客户端提前断开时中止上游请求（注意：req 的 close 在请求体读完就会触发，必须监听 res）
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const full = await llm.streamChat({
      model: story.model,
      messages: llmMessages,
      signal: ac.signal,
      onDelta: (t) => sseSend(res, { type: 'delta', text: t }),
    });
    const msg = { role: 'assistant', content: full, ts: Date.now() };
    const fresh = store.getStory(story.id);
    if (fresh) {
      fresh.messages.push(msg);
      store.saveStory(fresh);
    }
    sseSend(res, { type: 'done', message: msg });
  } catch (e) {
    if (!ac.signal.aborted) sseSend(res, { type: 'error', message: e.message });
  }
  res.end();
});

// ---------- 确认大纲：让 LLM 输出结构化 JSON ----------
route('POST', '/api/stories/:id/finalize', async (req, res, params) => {
  const story = store.getStory(params.id);
  if (!story) return sendJSON(res, 404, { error: '作品不存在' });
  if (genJobs.has(story.id)) return sendJSON(res, 409, { error: '正在生成章节，请先停止生成再调整大纲' });
  if (!story.messages.some((m) => m.role === 'assistant')) {
    return sendJSON(res, 409, { error: '请先与 AI 讨论出大纲再确认' });
  }
  const llmMessages = [
    { role: 'system', content: prompts.plannerSystem(story) },
    ...story.messages.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: prompts.finalizeInstruction() },
  ];
  try {
    const text = await llm.chat({ model: story.model, messages: llmMessages, temperature: 0.2 });
    let outline;
    try {
      outline = prompts.parseOutline(text);
    } catch (e) {
      return sendJSON(res, 422, { error: `大纲整理失败（${e.message}），请重试或先让 AI 输出更规范的大纲`, raw: text.slice(0, 2000) });
    }
    // 重新整理大纲时，保留已写好的章节内容（按章节号对应）
    const oldChapters = story.chapters || [];
    story.outline = outline;
    story.title = outline.title || story.title;
    story.chapters = oldChapters.filter((c) => c.content && outline.chapters.some((o) => o.num === c.num))
      .map((c) => ({ ...c, title: outline.chapters.find((o) => o.num === c.num).title }));
    story.status = story.chapters.length >= outline.chapters.length ? 'done' : 'writing';
    story.messages.push({
      role: 'assistant',
      content: `【大纲已确认】《${outline.title}》共 ${outline.chapters.length} 章：\n` +
        outline.chapters.map((c) => `第${c.num}章 ${c.title}`).join('\n'),
      ts: Date.now(),
      auto: true,
    });
    store.saveStory(story);
    sendJSON(res, 200, { story });
  } catch (e) {
    sendJSON(res, 502, { error: e.message });
  }
});

// ---------- 分章创作：服务端后台任务 ----------
// 生成任务在服务器上运行，客户端断开不影响；页面重开后可通过 stream 接口挂载回看进度。
// 注意：任务只存在于内存中，服务重启会终止进行中的任务（已完成章节不受影响）。
const genJobs = new Map(); // storyId -> job

function jobPublic(job) {
  return job ? { num: job.currentNum, title: job.currentTitle, auto: job.auto, startedAt: job.startedAt } : null;
}

function jobEmit(job, obj) {
  for (const res of job.listeners) {
    try { sseSend(res, obj); } catch {}
  }
}

function jobEnd(job, finalEvt) {
  jobEmit(job, finalEvt);
  for (const res of job.listeners) {
    try { res.end(); } catch {}
  }
  job.listeners.clear();
  genJobs.delete(job.storyId);
}

function nextUngen(story) {
  for (const c of story.outline.chapters) {
    if (!(story.chapters || []).some((w) => w.num === c.num && w.content)) return c.num;
  }
  return null;
}

async function runGenJob(job, firstNum, instructions) {
  let num = firstNum;
  let inst = instructions;
  while (true) {
    const story = store.getStory(job.storyId);
    if (!story || !story.outline) return jobEnd(job, { type: 'error', message: '作品或大纲不存在' });
    if (num == null) {
      num = nextUngen(story);
      if (num == null) return jobEnd(job, { type: 'job_done', status: story.status });
    }
    if (job.stopRequested) return jobEnd(job, { type: 'stopped', num });
    const target = story.outline.chapters.find((c) => c.num === num);
    if (!target) return jobEnd(job, { type: 'error', message: `第${num}章不在大纲中` });
    job.currentNum = num;
    job.currentTitle = target.title;
    job.buffer = '';
    jobEmit(job, { type: 'start', num, title: target.title, auto: job.auto });
    const ac = new AbortController();
    job.ac = ac;
    try {
      const full = await llm.streamChat({
        model: story.model,
        messages: [
          { role: 'system', content: prompts.writerSystem(story) },
          { role: 'user', content: prompts.chapterUser(story, num, inst) },
        ],
        signal: ac.signal,
        onDelta: (t) => {
          job.buffer += t;
          jobEmit(job, { type: 'delta', num, text: t });
        },
      });
      if (!full.trim()) return jobEnd(job, { type: 'error', message: 'LLM 返回了空内容，请重试' });
      const fresh = store.getStory(job.storyId);
      if (!fresh || !fresh.outline) return jobEnd(job, { type: 'error', message: '作品已被删除' });
      const chapter = { num, title: target.title, content: full.trim(), updatedAt: Date.now() };
      fresh.chapters = (fresh.chapters || []).filter((c) => c.num !== num).concat(chapter);
      fresh.chapters.sort((a, b2) => a.num - b2.num);
      const doneCount = fresh.chapters.filter((c) => c.content).length;
      fresh.status = doneCount >= fresh.outline.chapters.length ? 'done' : 'writing';
      store.saveStory(fresh);
      jobEmit(job, { type: 'chapter_done', num, status: fresh.status });
    } catch (e) {
      if (ac.signal.aborted || job.stopRequested) return jobEnd(job, { type: 'stopped', num });
      return jobEnd(job, { type: 'error', message: e.message });
    }
    if (!job.auto) {
      const s2 = store.getStory(job.storyId);
      return jobEnd(job, { type: 'job_done', status: s2 ? s2.status : 'writing' });
    }
    num = null;
    inst = '';
  }
}

// 启动生成任务：{num?, auto?, instructions?}；num 缺省时从下一未写章节开始
route('POST', '/api/stories/:id/generate', async (req, res, params) => {
  const story = store.getStory(params.id);
  if (!story) return sendJSON(res, 404, { error: '作品不存在' });
  if (!story.outline) return sendJSON(res, 409, { error: '请先确认大纲' });
  if (genJobs.has(story.id)) return sendJSON(res, 409, { error: '本作品已有生成任务在进行中' });
  const b = await readBody(req);
  const auto = !!b.auto;
  let num = b.num != null ? parseInt(b.num, 10) : null;
  if (num != null && !story.outline.chapters.some((c) => c.num === num)) {
    return sendJSON(res, 404, { error: '该章节不在大纲中' });
  }
  if (num == null && nextUngen(story) == null) return sendJSON(res, 409, { error: '所有章节都已完成' });
  const job = {
    storyId: story.id,
    auto,
    currentNum: num,
    currentTitle: '',
    buffer: '',
    listeners: new Set(),
    ac: null,
    stopRequested: false,
    startedAt: Date.now(),
  };
  genJobs.set(story.id, job);
  runGenJob(job, num, String(b.instructions || '').trim()).catch((e) => {
    console.error('[慢慢] 生成任务异常：', e);
    jobEnd(job, { type: 'error', message: e.message || '生成任务异常' });
  });
  sendJSON(res, 200, { job: jobPublic(job) });
});

// 挂载进行中的任务（SSE）：先补发已生成内容快照，再实时推送
route('GET', '/api/stories/:id/generate/stream', async (req, res, params) => {
  sseStart(res);
  const job = genJobs.get(params.id);
  if (!job) {
    sseSend(res, { type: 'idle' });
    return res.end();
  }
  sseSend(res, { type: 'snapshot', num: job.currentNum, title: job.currentTitle, text: job.buffer, auto: job.auto });
  job.listeners.add(res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 15000);
  res.on('close', () => {
    clearInterval(ping);
    job.listeners.delete(res);
  });
});

// 停止任务（作者主动停止；进行中的半章不保存）
route('POST', '/api/stories/:id/generate/stop', async (req, res, params) => {
  const job = genJobs.get(params.id);
  if (job) {
    job.stopRequested = true;
    if (job.ac) job.ac.abort();
  }
  sendJSON(res, 200, { ok: true, stopped: !!job });
});

// ---------- 导出 Markdown ----------
route('GET', '/api/stories/:id/export', async (req, res, params) => {
  const story = store.getStory(params.id);
  if (!story) return sendJSON(res, 404, { error: '作品不存在' });
  const lines = [`# ${story.title}`, ''];
  lines.push(`> 原作：《${story.source}》 · 主角：${story.characters} · 由「慢慢」创作`);
  lines.push('');
  if (story.outline?.summary) {
    lines.push(story.outline.summary, '');
  }
  for (const c of (story.chapters || []).filter((c) => c.content)) {
    lines.push(`## 第${c.num}章 ${c.title}`, '', c.content, '');
  }
  const md = lines.join('\n');
  const fname = encodeURIComponent(`${story.title}.md`);
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${fname}`,
  });
  res.end(md);
});

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let p = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!p.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    p = path.join(PUBLIC_DIR, 'index.html'); // SPA 回退
  }
  const ext = path.extname(p).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}

// ---------- 主入口 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.regex);
      if (!m) continue;
      if (r.needAuth && !auth.checkRequest(req)) return sendJSON(res, 401, { error: '未登录' });
      const params = {};
      r.keys.forEach((k, i) => (params[k] = m[i + 1]));
      try {
        await r.handler(req, res, params);
      } catch (e) {
        console.error(`[慢慢] ${req.method} ${pathname} 出错：`, e);
        if (!res.headersSent) sendJSON(res, 500, { error: e.message || '服务器内部错误' });
        else res.end();
      }
      return;
    }
    return sendJSON(res, 404, { error: '接口不存在' });
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[慢慢] 服务已启动：http://localhost:${PORT}`);
  console.log(`[慢慢] 数据目录：${store.DATA_DIR}`);
  console.log(`[慢慢] LLM 接口：${process.env.LLM_BASE_URL || '（未配置）'}`);
});
