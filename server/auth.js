'use strict';
// 单账号登录（账号密码来自环境变量）+ HMAC 签名的会话 Cookie
const crypto = require('crypto');

const USERNAME = process.env.AUTH_USERNAME || 'admin';
const PASSWORD = process.env.AUTH_PASSWORD || 'manman123';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'manman_session';
const MAX_AGE = 30 * 24 * 3600; // 30 天

if (!process.env.AUTH_PASSWORD) {
  console.warn('[慢慢] 未设置 AUTH_PASSWORD，使用默认密码 manman123（请尽快在 .env 中修改）');
}

function hmac(s) {
  return crypto.createHmac('sha256', SECRET).update(s).digest('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function verifyLogin(username, password) {
  return safeEqual(username, USERNAME) && safeEqual(password, PASSWORD);
}

function issueCookie() {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = Buffer.from(USERNAME).toString('base64url') + '.' + exp;
  const token = payload + '.' + hmac(payload);
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// 返回用户名（已登录）或 null
function checkRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[0] + '.' + parts[1];
  const sig = parts[2];
  const expect = hmac(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (parseInt(parts[1], 10) < Math.floor(Date.now() / 1000)) return null;
  try {
    return Buffer.from(parts[0], 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// 简单登录失败限流：同一 IP 连续失败 5 次锁 60 秒
const fails = new Map();
function loginAllowed(ip) {
  const f = fails.get(ip);
  return !f || !f.until || Date.now() >= f.until;
}
function recordLogin(ip, ok) {
  if (ok) {
    fails.delete(ip);
    return;
  }
  const f = fails.get(ip) || { count: 0, until: 0 };
  if (f.until && Date.now() >= f.until) {
    f.count = 0;
    f.until = 0;
  }
  f.count += 1;
  if (f.count >= 5) {
    f.until = Date.now() + 60_000;
    f.count = 0;
  }
  fails.set(ip, f);
}

module.exports = { verifyLogin, issueCookie, clearCookie, checkRequest, loginAllowed, recordLogin, USERNAME };
