'use strict';
// 提示词构建：策划阶段（大纲/提问/修订）与创作阶段（分章写作）

function plannerSystem(story) {
  return `你是一位经验丰富的同人小说（二次创作）策划编辑，笔名"慢慢"，正在协助一位作者策划新作品。

【创作设定】
- 原作：《${story.source}》
- 主角：${story.characters}
- 预期篇幅：${story.length}
- 作者特殊要求：${story.requirements || '无'}

【工作方式】
1. 如果关键信息不足（例如：故事发生在原作哪个时间段、与原作剧情的分歧点、人物关系走向、结局倾向、题材口味等），先向作者提出最多 5 个具体问题，不要贸然输出完整大纲。
2. 信息足够后，输出完整策划案，包含：作品名、一句话简介、世界观与主线冲突、主要人物及其弧光、分章大纲（每章一行："第N章 章节标题：2~3 句本章概要"），章节数量要贴合预期篇幅。
3. 作者会多轮提出修改意见或回答你的问题；每次修订后请输出修订后的完整大纲，而不是只描述改动点。
4. 忠于原作的设定与人物性格，除非作者明确要求改动。
5. 全程使用中文，语气专业而亲切。`;
}

function initialUserPrompt() {
  return '请根据以上创作设定开始工作：如有需要向我确认的问题请先提问；如果信息已经足够，请直接给出完整策划案与分章大纲。';
}

function finalizeInstruction() {
  return `我已确认大纲。请把最终版大纲整理成 JSON 输出，格式如下：
{"title":"作品名","summary":"整体简介（120字以内）","chapters":[{"num":1,"title":"章节标题","summary":"本章概要"}]}
要求：chapters 必须完整覆盖我们最终确认的所有章节，按顺序编号；只输出 JSON 本身，不要输出任何其他文字，也不要用代码块包裹。`;
}

function outlineText(outline) {
  const lines = outline.chapters.map((c) => `第${c.num}章 ${c.title} —— ${c.summary}`);
  return lines.join('\n');
}

function writerSystem(story) {
  const o = story.outline;
  return `你是一位文笔出色的同人小说作者，正在连载以下作品，请严格按既定大纲与前文连续创作。

【作品信息】
- 作品名：《${o.title}》
- 原作：《${story.source}》
- 主角：${story.characters}
- 整体简介：${o.summary}
- 作者特殊要求：${story.requirements || '无'}

【完整分章大纲】
${outlineText(o)}

【写作要求】
- 单章正文约 2000~4000 字（除非作者另有要求）
- 忠于原作的世界观、人物性格与语言风格
- 与前文情节、伏笔自然衔接，不要复述前文内容
- 只输出本章正文；不要输出章节标题、序号、任何解释说明或"本章完"之类的话`;
}

function chapterUser(story, num, instructions) {
  const o = story.outline;
  const target = o.chapters.find((c) => c.num === num);
  const parts = [];

  const prev = o.chapters.filter((c) => c.num < num);
  if (prev.length) {
    const recap = prev
      .map((c) => {
        const written = (story.chapters || []).find((w) => w.num === c.num && w.content);
        return `第${c.num}章 ${c.title}（${written ? '已发布' : '未写'}）：${c.summary}`;
      })
      .join('\n');
    parts.push(`【前文回顾】\n${recap}`);

    const last = (story.chapters || []).find((w) => w.num === num - 1 && w.content);
    if (last) {
      const tail = last.content.slice(-1500);
      parts.push(`【上一章《${last.title}》结尾原文片段，请自然衔接】\n"""\n${tail}\n"""`);
    }
  }

  parts.push(`现在请创作第 ${num} 章《${target.title}》。\n本章大纲：${target.summary}`);
  if (instructions) parts.push(`【作者对本章的补充要求】\n${instructions}`);
  parts.push('请直接输出本章正文。');
  return parts.join('\n\n');
}

// 从 LLM 回复中解析大纲 JSON（容忍代码块包裹 / 前后多余文字）
function parseOutline(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复中未找到 JSON 对象');
  const obj = JSON.parse(t.slice(start, end + 1));
  if (!obj.title || !Array.isArray(obj.chapters) || !obj.chapters.length) {
    throw new Error('JSON 缺少 title 或 chapters');
  }
  const chapters = obj.chapters.map((c, i) => ({
    num: i + 1,
    title: String(c.title || `第${i + 1}章`).trim(),
    summary: String(c.summary || '').trim(),
  }));
  return { title: String(obj.title).trim(), summary: String(obj.summary || '').trim(), chapters };
}

module.exports = { plannerSystem, initialUserPrompt, finalizeInstruction, writerSystem, chapterUser, parseOutline };
