'use strict';
// 基于 JSON 文件的简单持久化。每部作品一个文件：{DATA_DIR}/stories/{id}.json
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORIES_DIR = path.join(DATA_DIR, 'stories');

fs.mkdirSync(STORIES_DIR, { recursive: true });

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function storyPath(id) {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  return path.join(STORIES_DIR, id + '.json');
}

function getStory(id) {
  const p = storyPath(id);
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('读取作品失败', id, e.message);
    return null;
  }
}

function saveStory(story) {
  story.updatedAt = Date.now();
  const p = storyPath(story.id);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(story, null, 2));
  fs.renameSync(tmp, p);
  return story;
}

function deleteStory(id) {
  const p = storyPath(id);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
}

function listStories() {
  const out = [];
  for (const f of fs.readdirSync(STORIES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const s = getStory(f.slice(0, -5));
    if (!s) continue;
    const total = s.outline ? s.outline.chapters.length : 0;
    const written = (s.chapters || []).filter((c) => c.content).length;
    out.push({
      id: s.id,
      title: s.title,
      source: s.source,
      characters: s.characters,
      length: s.length,
      model: s.model,
      status: s.status,
      totalChapters: total,
      writtenChapters: written,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function createStory({ source, characters, length, requirements, model }) {
  const now = Date.now();
  const story = {
    id: newId(),
    title: `《${source}》· ${characters}`,
    source,
    characters,
    length,
    requirements: requirements || '',
    model,
    status: 'planning', // planning -> writing -> done
    messages: [], // 策划阶段的多轮对话 [{role, content, ts, auto?}]
    outline: null, // {title, summary, chapters:[{num,title,summary}]}
    chapters: [], // [{num, title, content, updatedAt}]
    createdAt: now,
    updatedAt: now,
  };
  return saveStory(story);
}

module.exports = { getStory, saveStory, deleteStory, listStories, createStory, DATA_DIR };
