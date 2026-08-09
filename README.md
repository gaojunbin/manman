# 慢慢 · 同人文创作与阅读

「慢慢」是一个自托管的同人文（二次创作）创作与阅读网站：你告诉 AI 想基于哪部作品、写哪些主角、写多长、有什么特殊要求，AI 编辑会与你多轮讨论打磨大纲，确认后逐章创作，写完即可在站内舒适地阅读。

## 快速开始

```bash
cp .env.example .env
# 编辑 .env：填入 LLM_BASE_URL / LLM_API_KEY，改掉默认账号密码
docker compose up -d --build
```

打开 http://localhost:8080 ，用 `.env` 中配置的账号密码登录。

## 配置项（.env）

| 变量 | 说明 |
| --- | --- |
| `LLM_BASE_URL` | OpenAI 兼容接口的 baseURL（需带版本路径，如 `https://api.openai.com/v1`） |
| `LLM_API_KEY` | 接口 API Key |
| `DEFAULT_MODEL` | 新建作品时默认选中的模型（可留空） |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | 网站登录账号密码 |
| `SESSION_SECRET` | 会话签名密钥；建议设为随机字符串，否则容器重启后需重新登录 |
| `PORT` | 宿主机端口，默认 8080 |

模型列表在运行时从 `{LLM_BASE_URL}/models` 实时获取，创作时可自由选择（每部作品可单独指定，中途也可切换）。

## 创作流程

1. **开新坑** —— 填写：基于什么作品二创（如「凡人修仙传」）、主角（如「韩立、玄骨」）、预期篇幅（如「大约 10 章」）、特殊要求，并选择模型。
2. **大纲策划（多轮）** —— AI 编辑会先给出大纲，或先向你提问澄清关键设定；你可以回答问题、反复提出修订意见，AI 每轮给出修订后的完整大纲。
3. **确认大纲** —— 点击「确认大纲，开始创作」，AI 将大纲整理成结构化章节列表。之后仍可回到策划页继续讨论并重新整理（已写章节按章节号保留）。
4. **逐章创作** —— 按顺序生成每一章（正文流式实时显示），支持对单章附加要求重写，也可勾选「连续生成直到完结」自动写完全书。生成是**服务端后台任务**：点击后关闭页面也会继续创作，重新打开自动接上实时进度；「停止」会丢弃写到一半的章节。注意：重启容器会终止进行中的生成任务（已写完的章节不受影响）。
5. **阅读** —— 站内阅读器支持章节导航与字号调节，也可一键导出整部作品为 Markdown。

## 数据

所有作品数据以 JSON 文件保存在 docker volume `manman-data`（容器内 `/data`）中，删除容器不会丢失数据；如需备份，备份该 volume 即可。

## 本地开发（不使用 Docker）

```bash
LLM_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=sk-xxx \
AUTH_USERNAME=admin AUTH_PASSWORD=test DATA_DIR=./data \
node server/server.js
```

纯 Node.js（≥18）实现，零 npm 依赖。
