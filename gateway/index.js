// ====================================================
// FlarePanel AI 网关 Worker（OpenAI 兼容，Cloudflare Workers + KV，可选 D1 / Workers AI）
//
// 把多个 OpenAI 兼容服务商合成一个入口：服务商、模型、降级链存在 KV（由 FlarePanel「代理网关」栏目编辑），
// 网关读取后按降级链转发请求，失败自动换下一个模型 / 服务商，并记录用量统计供后台查看。
//
// 接口：GET /v1/models、POST /v1/chat/completions（流式 / 非流式）、GET /v1/stats、POST /v1/reload，
//       以及仅限开发者密钥的 POST /v1/images/generations、/v1/images/edits、/v1/audio/transcriptions。
//
// 所有站点相关的东西都在 wrangler 的 vars / secrets 里配置，代码里没有写死任何域名、账号或密钥。
// 部署说明见 gateway/README.md，统计表结构见 gateway/schema.sql。
//
// MIT License © 2026 程小宝
// ====================================================

import { WorkerEntrypoint } from 'cloudflare:workers';

const GATEWAY_VERSION = '1.0.0';

// ---------- 默认值（都可以用 vars 覆盖） ----------
const DEFAULTS = {
  CONFIG_KEY: 'AI_GATEWAY_CONFIG',   // KV 里的配置键名，和 sites.config.js 的 AI_HUB.configKey 一致
  CONFIG_CACHE_SECONDS: 300,         // 配置在内存里缓存多久；后台保存时会调 /v1/reload 立即刷新
  UPSTREAM_TIMEOUT_MS: 45000,        // 单次上游请求超时（等到响应头为止），服务商可用 timeoutMs 单独覆盖
  MEDIA_TIMEOUT_MS: 120000,          // 图片 / 语音接口的超时
  UNAUTH_DAILY_LIMIT: 20,            // 公开访问时游客每天次数（后台 sitePolicy 里的值优先），0 = 不限
  AUTH_DAILY_LIMIT: 100,             // 公开访问时登录用户每天次数（同上）
  STATS_UTC_OFFSET_MINUTES: 480,     // 统计按哪个时区分天；FlarePanel 后台的 KV 兜底读取按 UTC+8 分天，改了两边要一致
  LOG_RETENTION_DAYS: 60,            // D1 调用流水保留天数，0 = 不清理
  MAX_BODY_BYTES: 2 * 1024 * 1024,   // chat 请求体上限
  MAX_MEDIA_BYTES: 25 * 1024 * 1024, // 图片 / 语音请求体上限
  ALERT_COOLDOWN_SECONDS: 600        // 同一条 Telegram 告警的最短间隔（按 isolate 计）
};

const DEFAULT_MODEL_ALIASES = ['', 'auto', 'default'];
const MODERATION_ALIAS = 'moderation';
const WORKERS_AI_BASE = 'cloudflare-workers-ai';

// 可透传给上游的 chat 参数（白名单，其余字段丢弃）
const PASS_NUMBER = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'n', 'top_logprobs'];
const PASS_ANY = ['tools', 'tool_choice', 'response_format', 'stop', 'seed', 'logit_bias', 'modalities', 'audio', 'prediction'];
const PASS_STRING = ['reasoning_effort', 'service_tier'];
const PASS_BOOL = ['parallel_tool_calls', 'logprobs'];

// 多模态转发：路径 -> 统计里的工具名、是否 multipart 表单
const MEDIA_ENDPOINTS = {
  'images/generations': { tool: 'images/generations', multipart: false },
  'images/edits': { tool: 'images/edits', multipart: true },
  'audio/transcriptions': { tool: 'audio/transcriptions', multipart: true }
};

// ---------- 文案（只用于统计里的失败原因和 Telegram 告警，不影响 API 返回） ----------
const TEXT = {
  zh: {
    e429: '额度已用完或请求过于频繁', e401: '密钥无效或没有权限', e404: '模型或接口不存在',
    e400: '请求参数不被服务商接受', e503: '服务商繁忙或暂时不可用', e504: '连接超时或网络不可达',
    e500: '服务商内部错误', eOther: '请求失败',
    tried: '先试', allFailed: '全部失败',
    rateUnauth: '游客每日次数已达上限', rateAuth: '用户每日次数已达上限', rateProvider: '频次限制',
    alertSwitch: 'AI 网关已切换服务商', alertDown: 'AI 网关全部服务商不可用',
    source: '来源', page: '页面', provider: '故障服务商', reason: '原因', switchedTo: '已切换至', time: '时间'
  },
  en: {
    e429: 'quota exhausted or rate limited', e401: 'invalid key or no permission', e404: 'model or endpoint not found',
    e400: 'request rejected by provider', e503: 'provider busy or unavailable', e504: 'timeout or network unreachable',
    e500: 'provider internal error', eOther: 'request failed',
    tried: 'tried', allFailed: 'all failed',
    rateUnauth: 'anonymous daily limit reached', rateAuth: 'user daily limit reached', rateProvider: 'rate limit',
    alertSwitch: 'AI gateway switched provider', alertDown: 'AI gateway: all providers unavailable',
    source: 'Source', page: 'Page', provider: 'Failed provider', reason: 'Reason', switchedTo: 'Switched to', time: 'Time'
  }
};

// ---------- 运行时设置 ----------
function readSettings(env) {
  const int = (v, d) => {
    if (v === undefined || v === null || v === '') return d;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const signedInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : d;
  };
  const list = (v) => String(v || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const bool = (v, d) => (v === undefined || v === null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
  const siteIds = list(env.SITE_IDS).map((pair) => {
    const i = pair.indexOf('=');
    if (i <= 0) return null;
    return { host: pair.slice(0, i).trim().toLowerCase().replace(/^\*\./, ''), id: pair.slice(i + 1).trim() };
  }).filter((x) => x && x.host && x.id).sort((a, b) => b.host.length - a.host.length);

  return {
    configKey: String(env.CONFIG_KEY || DEFAULTS.CONFIG_KEY),
    cacheMs: int(env.CONFIG_CACHE_SECONDS, DEFAULTS.CONFIG_CACHE_SECONDS) * 1000,
    allowedOrigins: list(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, '')),
    allowLocalhost: bool(env.ALLOW_LOCALHOST, false),
    publicAccess: bool(env.PUBLIC_ACCESS, false),
    rateLimitExempt: list(env.RATE_LIMIT_EXEMPT_ORIGINS).map((o) => o.replace(/\/+$/, '')),
    unauthLimit: int(env.UNAUTH_DAILY_LIMIT, DEFAULTS.UNAUTH_DAILY_LIMIT),
    authLimit: int(env.AUTH_DAILY_LIMIT, DEFAULTS.AUTH_DAILY_LIMIT),
    siteIds,
    upstreamTimeout: int(env.UPSTREAM_TIMEOUT_MS, DEFAULTS.UPSTREAM_TIMEOUT_MS) || DEFAULTS.UPSTREAM_TIMEOUT_MS,
    mediaTimeout: int(env.MEDIA_TIMEOUT_MS, DEFAULTS.MEDIA_TIMEOUT_MS) || DEFAULTS.MEDIA_TIMEOUT_MS,
    tzOffset: signedInt(env.STATS_UTC_OFFSET_MINUTES, DEFAULTS.STATS_UTC_OFFSET_MINUTES),
    retentionDays: int(env.LOG_RETENTION_DAYS, DEFAULTS.LOG_RETENTION_DAYS),
    maxBody: int(env.MAX_BODY_BYTES, DEFAULTS.MAX_BODY_BYTES) || DEFAULTS.MAX_BODY_BYTES,
    maxMedia: int(env.MAX_MEDIA_BYTES, DEFAULTS.MAX_MEDIA_BYTES) || DEFAULTS.MAX_MEDIA_BYTES,
    alertCooldownMs: int(env.ALERT_COOLDOWN_SECONDS, DEFAULTS.ALERT_COOLDOWN_SECONDS) * 1000,
    hideUpstreamModel: bool(env.HIDE_UPSTREAM_MODEL, true),
    text: TEXT[String(env.LOG_LANG || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh']
  };
}

// KV 绑定：CONFIG_KV（兼容旧名 AI_RATE_LIMITS）
const kvOf = (env) => env.CONFIG_KV || env.AI_RATE_LIMITS || null;

// ---------- 配置读取（KV + 内存缓存） ----------
let memoryConfig = null;
let memoryConfigTime = 0;

const EMPTY_CONFIG = {
  version: 1,
  gateway: { masterKey: '', keys: [] },
  sitePolicy: { fallbackChain: [] },
  telegram: { enabled: false, botToken: '', chatId: '' },
  providers: []
};

async function getConfig(env, settings, force = false) {
  const now = Date.now();
  if (!force && memoryConfig && now - memoryConfigTime < settings.cacheMs) return memoryConfig;

  let config = null;
  const kv = kvOf(env);
  if (kv) {
    try {
      const raw = await kv.get(settings.configKey, { type: 'json' });
      if (raw && typeof raw === 'object') config = raw;
    } catch (e) {
      console.warn('Failed to read gateway config from KV:', e && e.name);
    }
  }
  if (!config) config = JSON.parse(JSON.stringify(EMPTY_CONFIG));
  if (!config.gateway || typeof config.gateway !== 'object') config.gateway = {};
  if (!config.sitePolicy || typeof config.sitePolicy !== 'object') config.sitePolicy = {};
  if (!Array.isArray(config.providers)) config.providers = [];
  if (!config.telegram || typeof config.telegram !== 'object') config.telegram = {};

  memoryConfig = config;
  memoryConfigTime = now;
  return config;
}

// 服务商的 API Key：可以直接写在 KV，也可以写成 "env:PROVIDER_KEY_XXX"，从同名 Secret 读取
function providerApiKey(provider, env) {
  const raw = String(provider?.apiKey || '').trim();
  const m = /^env:(PROVIDER_KEY_[A-Z0-9_]{1,64})$/.exec(raw);
  if (m) return String(env[m[1]] || '');
  return raw;
}

function isWorkersAi(provider) {
  return provider && (provider.baseUrl === WORKERS_AI_BASE || provider.id === 'provider_cf_ai');
}

// ---------- 工具函数 ----------
const encoder = new TextEncoder();

async function sha256Bytes(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(text))));
}

async function sha256Hex(text) {
  return Array.from(await sha256Bytes(text), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 常量时间比较：先各自做 SHA-256 得到等长摘要，再逐字节异或，耗时与内容、长度无关
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function localDateTime(ts, offsetMinutes) {
  const iso = new Date(ts + offsetMinutes * 60000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; }
}

function randomId(len = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

// 从错误文字里抹掉可能的密钥，防止上游把 Key 回显给客户端或写进统计
function redact(text, secrets = []) {
  let s = String(text || '');
  for (const sec of secrets) {
    if (sec && sec.length >= 6) s = s.split(sec).join('***');
  }
  return s
    .replace(/\b(sk|pk|rk|ak|key|nvapi|gsk|xai|csk)[-_][A-Za-z0-9_\-.]{8,}/gi, '$1-***')
    .replace(/Bearer\s+[A-Za-z0-9_\-.=]{8,}/gi, 'Bearer ***')
    .replace(/\bAIza[0-9A-Za-z_\-]{20,}/g, 'AIza***');
}

function estimateTokens(text = '') {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  const cjk = (str.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.ceil(cjk * 0.9 + (str.length - cjk) * 0.3) || 1;
}

function estimateMessagesTokens(messages = []) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, m) => sum + (m ? estimateTokens(m.content || '') + 4 : 0), 0);
}

function describeUpstreamError(status, T) {
  if (status === 429) return T.e429;
  if (status === 401 || status === 403) return T.e401;
  if (status === 404) return T.e404;
  if (status === 400 || status === 422) return T.e400;
  if (status === 502 || status === 503) return T.e503;
  if (status === 504 || status === 408) return T.e504;
  if (status >= 500) return T.e500;
  return T.eOther;
}

function splitList(v) {
  if (Array.isArray(v)) return v.map((m) => String(m).trim()).filter(Boolean);
  return String(v || '').split(',').map((m) => m.trim()).filter(Boolean);
}

// ---------- CORS ----------
function isOriginAllowed(origin, settings) {
  if (!origin) return false;
  if (settings.allowedOrigins.includes(origin)) return true;
  if (settings.allowLocalhost && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function corsHeadersFor(origin, settings) {
  if (!origin || !isOriginAllowed(origin, settings)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, x-api-key, api-key, X-Source-Page, X-Page-Path',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, status, cors, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors, ...extra }
  });
}

function apiError(status, message, type, cors, code) {
  return json({ error: { message, type, ...(code ? { code } : {}) } }, status, cors);
}

// ---------- 鉴权 ----------
function extractToken(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = /^bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  if (auth && !auth.includes(' ')) return auth.trim();
  return (request.headers.get('x-api-key') || request.headers.get('api-key') || '').trim();
}

// 开发者密钥：KV 里的 gateway.keys（后台「开发者密钥」）、旧版 gateway.masterKey、Secret MASTER_KEY
async function matchMasterKey(config, token, env) {
  if (!token) return null;
  const candidates = [];
  const keys = Array.isArray(config.gateway?.keys) ? config.gateway.keys : [];
  keys.forEach((k, i) => {
    if (k && k.enabled !== false && k.key && String(k.key).trim()) {
      candidates.push({ id: k.id || `key_${i + 1}`, name: k.name || `key_${i + 1}`, key: String(k.key).trim() });
    }
  });
  if (config.gateway?.masterKey) candidates.push({ id: 'key_master', name: 'Master Key', key: String(config.gateway.masterKey).trim() });
  if (env.MASTER_KEY) candidates.push({ id: 'key_master', name: 'Master Key', key: String(env.MASTER_KEY).trim() });

  // 逐个常量时间比较，并且不提前退出，避免从耗时推出命中位置
  let found = null;
  for (const c of candidates) {
    if ((await safeEqual(c.key, token)) && !found) found = c;
  }
  return found ? { id: found.id, name: found.name } : null;
}

function b64urlDecode(s) {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const bin = atob(b);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// 可选：站点登录用户（HS256 JWT，密钥为 Secret JWT_SECRET）。没设 JWT_SECRET 就不识别登录用户
async function verifyJwt(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    if (!header || header.alg !== 'HS256') return null;
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (!payload || typeof payload !== 'object') return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && nowSec > payload.exp) return null;
    if (typeof payload.nbf === 'number' && nowSec < payload.nbf) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// 识别调用方：master（开发者密钥 / 内部服务）、auth（站点登录用户）、unauth（公开访问的游客）
async function identifyClient(request, env, config, settings, internal) {
  if (internal) return { kind: 'master', id: internal.id || 'internal', name: internal.name || 'internal' };
  const token = extractToken(request);
  const master = await matchMasterKey(config, token, env);
  if (master) return { kind: 'master', ...master };

  const origin = request.headers.get('Origin') || '';
  // 公开访问只给白名单网站的浏览器请求（注意：脚本可以伪造 Origin，所以公开访问一定要配次数限制）
  if (!settings.publicAccess || !isOriginAllowed(origin, settings)) return null;
  if (token && env.JWT_SECRET) {
    const payload = await verifyJwt(token, env.JWT_SECRET);
    const uid = payload && (payload.sub || payload.id || payload.userId);
    if (uid) return { kind: 'auth', userId: String(uid).slice(0, 64), userName: payload.username ? String(payload.username).slice(0, 64) : null };
  }
  return { kind: 'unauth' };
}

// 来源站点：按 SITE_IDS（host=site_id）匹配 Origin / Referer 的主机名，对应 FlarePanel sites.config.js 的 aiSiteId
function detectSite(request, client, settings) {
  if (client.kind === 'master') return { id: client.id, name: client.name };
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  const hosts = [hostOf(origin), hostOf(referer)].filter(Boolean);
  for (const h of hosts) {
    for (const s of settings.siteIds) {
      if (h === s.host || h.endsWith('.' + s.host)) return { id: s.id, name: h };
    }
  }
  if (hosts.some((h) => h === 'localhost' || h === '127.0.0.1')) return { id: 'site_local', name: 'localhost' };
  return { id: 'other', name: hosts[0] || 'other' };
}

// 调用页面：X-Source-Page / X-Page-Path 头，或 Referer 的路径；只存路径，不存查询串
function detectPagePath(request, client) {
  let p = request.headers.get('x-source-page') || request.headers.get('x-page-path') || '';
  if (!p) {
    const referer = request.headers.get('Referer') || '';
    if (referer) { try { p = new URL(referer).pathname; } catch (e) { p = ''; } }
  }
  if (!p && client.kind === 'master') p = client.name;
  p = String(p || '/').split(/[?#]/)[0];
  return p.slice(0, 200) || '/';
}

// ---------- 次数限制（只对公开访问生效） ----------
async function checkRateLimit(env, request, client, site, config, settings) {
  if (client.kind === 'master') return null;
  const kv = kvOf(env);
  if (!kv) return null;
  const origin = request.headers.get('Origin') || '';
  if (origin && settings.rateLimitExempt.includes(origin)) return null;

  const policy = config.sitePolicy || {};
  const pick = (kvVal, envVal) => {
    const n = parseInt(kvVal, 10);
    return Number.isFinite(n) && n >= 0 ? n : envVal;
  };
  const isAuth = client.kind === 'auth';
  const limit = isAuth ? pick(policy.authDailyLimit, settings.authLimit) : pick(policy.unauthDailyLimit, settings.unauthLimit);
  if (!limit) return null;

  const { date } = localDateTime(Date.now(), settings.tzOffset);
  let key;
  if (isAuth) {
    key = `RL:AUTH:${(await sha256Hex(client.userId)).slice(0, 32)}:${date}`;
  } else {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    key = `RL:UNAUTH:${site.id}:${(await sha256Hex(ip)).slice(0, 32)}:${date}`;
  }
  // KV 不是原子计数，并发时可能多放过几次；够用来防刷，不适合计费
  const count = parseInt((await kv.get(key)) || '0', 10) || 0;
  if (count >= limit) return { limit, isAuth };
  await kv.put(key, String(count + 1), { expirationTtl: 86400 * 2 });
  return null;
}

// ---------- 用量统计（D1 优先，没有 D1 时写 KV） ----------
async function recordMetric(env, settings, m) {
  const ts = m.timestamp || Date.now();
  const { date, time } = localDateTime(ts, settings.tzOffset);
  const row = {
    id: randomId(),
    date, time, timestamp: ts,
    siteId: m.siteId || 'other',
    siteName: m.siteName || 'other',
    client: m.client || 'unauth',
    userId: m.userId || null,
    userName: m.userName || null,
    providerId: m.providerId || 'unknown',
    providerName: m.providerName || m.providerId || 'unknown',
    model: m.model || 'auto',
    status: m.status || 200,
    latencyMs: m.latencyMs || 0,
    tokens: Number(m.tokens) || 0,
    promptTokens: Number(m.promptTokens) || 0,
    completionTokens: Number(m.completionTokens) || 0,
    fallback: m.fallback ? 1 : 0,
    error: m.error ? String(m.error).slice(0, 150) : null,
    pagePath: m.pagePath || null,
    toolName: m.toolName || null
  };

  if (env.DB) {
    try {
      await env.DB.prepare(`INSERT INTO ai_logs (
          id, date, time, timestamp, site_id, site_name, client, user_id, user_name,
          provider_id, provider_name, model, status, latency_ms, tokens,
          prompt_tokens, completion_tokens, fallback, error, page_path, tool_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        row.id, row.date, row.time, row.timestamp, row.siteId, row.siteName, row.client, row.userId, row.userName,
        row.providerId, row.providerName, row.model, row.status, row.latencyMs, row.tokens,
        row.promptTokens, row.completionTokens, row.fallback, row.error, row.pagePath, row.toolName
      ).run();
      if (settings.retentionDays > 0 && Math.random() < 0.01) {
        const cutoff = Date.now() - settings.retentionDays * 86400000;
        await env.DB.prepare('DELETE FROM ai_logs WHERE timestamp < ?').bind(cutoff).run().catch(() => {});
      }
      return;
    } catch (e) {
      console.error('Failed to write ai_logs to D1, falling back to KV:', e && e.message);
    }
  }

  const kv = kvOf(env);
  if (!kv) return;
  try {
    const dailyKey = `STATS:DAILY:${date}`;
    let daily = await kv.get(dailyKey, { type: 'json' });
    if (!daily || typeof daily !== 'object') daily = emptyDaily(date);
    const ok = row.status >= 200 && row.status < 300;
    daily.total = (daily.total || 0) + 1;
    if (ok) daily.success = (daily.success || 0) + 1; else daily.failed = (daily.failed || 0) + 1;
    if (row.fallback) daily.fallbackCount = (daily.fallbackCount || 0) + 1;
    daily.latencySumMs = (daily.latencySumMs || 0) + row.latencyMs;
    daily.totalTokens = (daily.totalTokens || 0) + row.tokens;
    daily.promptTokens = (daily.promptTokens || 0) + row.promptTokens;
    daily.completionTokens = (daily.completionTokens || 0) + row.completionTokens;
    if (!daily.clientTypes) daily.clientTypes = { master: 0, auth: 0, unauth: 0 };
    const ct = ['auth', 'unauth'].includes(row.client) ? row.client : 'master';
    daily.clientTypes[ct] = (daily.clientTypes[ct] || 0) + 1;
    const bump = (bucket, id, name) => {
      if (!daily[bucket]) daily[bucket] = {};
      const b = daily[bucket][id] || { name, requests: 0, success: 0, failed: 0, tokens: 0 };
      b.requests += 1;
      b.tokens = (b.tokens || 0) + row.tokens;
      if (ok) b.success += 1; else b.failed += 1;
      daily[bucket][id] = b;
    };
    bump('providers', row.providerId, row.providerName);
    bump('sites', row.siteId, row.siteName);
    if (!daily.models) daily.models = {};
    daily.models[row.model] = (daily.models[row.model] || 0) + 1;
    daily.lastUpdated = Date.now();
    await kv.put(dailyKey, JSON.stringify(daily), { expirationTtl: 86400 * 31 });

    let logs = await kv.get('STATS:RECENT_LOGS', { type: 'json' });
    if (!Array.isArray(logs)) logs = [];
    logs.unshift(toLogEntry(row));
    await kv.put('STATS:RECENT_LOGS', JSON.stringify(logs.slice(0, 50)), { expirationTtl: 86400 * 7 });
  } catch (e) {
    console.error('Failed to write stats to KV (non-fatal):', e && e.message);
  }
}

function emptyDaily(date) {
  return {
    date, total: 0, success: 0, failed: 0, fallbackCount: 0, latencySumMs: 0,
    totalTokens: 0, promptTokens: 0, completionTokens: 0,
    clientTypes: { master: 0, auth: 0, unauth: 0 }, providers: {}, models: {}, sites: {}
  };
}

function toLogEntry(row) {
  return {
    id: row.id, time: row.time, date: row.date, timestamp: row.timestamp,
    site: row.siteName, siteId: row.siteId, pagePath: row.pagePath, toolName: row.toolName,
    client: row.client, user: row.userName || row.userId || null,
    provider: row.providerName, model: row.model, status: row.status, latencyMs: row.latencyMs,
    tokens: row.tokens, promptTokens: row.promptTokens, completionTokens: row.completionTokens,
    fallback: !!row.fallback, error: row.error
  };
}

// GET /v1/stats?days=7：字段和 FlarePanel 后台 assets/js/modules/ai-hub/metrics.js 一致
async function buildStats(env, settings, days) {
  const now = Date.now();
  const dateList = [];
  for (let i = 0; i < days; i++) dateList.push(localDateTime(now - i * 86400000, settings.tzOffset).date);
  const minDate = dateList[dateList.length - 1];

  const history = [];
  const providersTotal = {};
  const sitesTotal = {};
  let recentLogs = [];
  let source = 'none';

  if (env.DB) {
    try {
      const [logsRes, dailyRes, provRes, siteRes] = await Promise.all([
        env.DB.prepare(`SELECT id, time, date, timestamp, site_name AS site, site_id AS siteId,
            client, COALESCE(user_name, user_id) AS user, provider_name AS provider, model, status,
            latency_ms AS latencyMs, tokens, prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
            fallback, error, page_path AS pagePath, tool_name AS toolName
          FROM ai_logs ORDER BY timestamp DESC LIMIT 50`).all(),
        env.DB.prepare(`SELECT date, COUNT(*) AS total,
            SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS failed,
            SUM(fallback) AS fallbackCount, SUM(latency_ms) AS latencySumMs, SUM(tokens) AS totalTokens,
            SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens,
            SUM(CASE WHEN client = 'auth' THEN 1 ELSE 0 END) AS authRequests,
            SUM(CASE WHEN client = 'unauth' THEN 1 ELSE 0 END) AS unauthRequests
          FROM ai_logs WHERE date >= ? GROUP BY date`).bind(minDate).all(),
        env.DB.prepare(`SELECT provider_id, MAX(provider_name) AS provider_name, COUNT(*) AS requests,
            SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS failed, SUM(tokens) AS tokens
          FROM ai_logs WHERE date >= ? GROUP BY provider_id`).bind(minDate).all(),
        env.DB.prepare(`SELECT site_id, MAX(site_name) AS site_name, COUNT(*) AS requests,
            SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS failed, SUM(tokens) AS tokens
          FROM ai_logs WHERE date >= ? GROUP BY site_id`).bind(minDate).all()
      ]);
      recentLogs = (logsRes.results || []).map((r) => ({ ...r, fallback: !!r.fallback }));
      const dailyMap = Object.fromEntries((dailyRes.results || []).map((r) => [r.date, r]));
      for (const r of provRes.results || []) {
        const pid = r.provider_id || 'unknown';
        providersTotal[pid] = { name: r.provider_name || pid, requests: r.requests || 0, success: r.success || 0, failed: r.failed || 0, tokens: r.tokens || 0 };
      }
      for (const r of siteRes.results || []) {
        const sid = r.site_id || 'other';
        sitesTotal[sid] = { name: r.site_name || sid, requests: r.requests || 0, success: r.success || 0, failed: r.failed || 0, tokens: r.tokens || 0 };
      }
      for (const date of dateList) {
        const r = dailyMap[date] || {};
        const total = r.total || 0;
        history.push({
          date, total, success: r.success || 0, failed: r.failed || 0, fallbackCount: r.fallbackCount || 0,
          latencySumMs: r.latencySumMs || 0, totalTokens: r.totalTokens || 0,
          promptTokens: r.promptTokens || 0, completionTokens: r.completionTokens || 0,
          clientTypes: { master: total - (r.authRequests || 0) - (r.unauthRequests || 0), auth: r.authRequests || 0, unauth: r.unauthRequests || 0 }
        });
      }
      source = 'd1';
    } catch (e) {
      console.error('D1 stats query failed, falling back to KV:', e && e.message);
      history.length = 0;
      recentLogs = [];
      for (const k of Object.keys(providersTotal)) delete providersTotal[k];
      for (const k of Object.keys(sitesTotal)) delete sitesTotal[k];
    }
  }

  if (source !== 'd1') {
    const kv = kvOf(env);
    const dailies = await Promise.all(dateList.map(async (date) => {
      if (!kv) return emptyDaily(date);
      try { return (await kv.get(`STATS:DAILY:${date}`, { type: 'json' })) || emptyDaily(date); } catch (e) { return emptyDaily(date); }
    }));
    for (const d of dailies) {
      for (const [bucket, target] of [['providers', providersTotal], ['sites', sitesTotal]]) {
        for (const [id, v] of Object.entries(d[bucket] || {})) {
          const t = target[id] || (target[id] = { name: v.name || id, requests: 0, success: 0, failed: 0, tokens: 0 });
          t.requests += v.requests || 0; t.success += v.success || 0; t.failed += v.failed || 0; t.tokens += v.tokens || 0;
        }
      }
      history.push(d);
    }
    if (kv) { try { recentLogs = (await kv.get('STATS:RECENT_LOGS', { type: 'json' })) || []; } catch (e) { recentLogs = []; } }
    source = kv ? 'kv' : 'none';
  }

  const sum = (k) => history.reduce((s, d) => s + (d[k] || 0), 0);
  for (const d of history) d.avgLatencyMs = d.total > 0 ? Math.round((d.latencySumMs || 0) / d.total) : 0;
  const totalRequests = sum('total');
  const totalSuccess = sum('success');
  const today = history[0] || emptyDaily(dateList[0]);

  return {
    status: 'success',
    source,
    days,
    today,
    summary: {
      totalRequests,
      totalSuccess,
      totalFailed: sum('failed'),
      totalFallback: sum('fallbackCount'),
      totalTokens: sum('totalTokens'),
      totalPromptTokens: sum('promptTokens'),
      totalCompletionTokens: sum('completionTokens'),
      todayTokens: today.totalTokens || 0,
      successRate: totalRequests > 0 ? ((totalSuccess / totalRequests) * 100).toFixed(1) : '100.0',
      avgLatencyMs: totalRequests > 0 ? Math.round(sum('latencySumMs') / totalRequests) : 0,
      providersBreakdown: providersTotal,
      sitesBreakdown: sitesTotal
    },
    history: history.slice().reverse(),
    recentLogs
  };
}

// ---------- Telegram 告警（可选） ----------
const lastAlertAt = new Map();

async function sendAlert(env, config, settings, key, title, fields) {
  const tg = config.telegram || {};
  const botToken = tg.botToken || env.TELEGRAM_BOT_TOKEN;
  const chatId = tg.chatId || env.TELEGRAM_CHAT_ID;
  if (tg.enabled === false || !botToken || !chatId) return;
  const now = Date.now();
  if (now - (lastAlertAt.get(key) || 0) < settings.alertCooldownMs) return;
  lastAlertAt.set(key, now);

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const T = settings.text;
  const lines = [`<b>${esc(title)}</b>`, ''];
  for (const [label, value] of fields) if (value) lines.push(`<b>${esc(label)}</b>: ${esc(value)}`);
  lines.push('', `<b>${esc(T.time)}</b>: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML' })
    });
    if (!res.ok) console.warn('Telegram alert failed with HTTP', res.status);
  } catch (e) {
    console.warn('Telegram alert failed:', e && e.name);
  }
}

// ---------- 路由：模型 -> 候选服务商 ----------
function usableProviders(config, env) {
  return (config.providers || []).filter((p) => p && p.enabled && p.id && (isWorkersAi(p) ? !!env.AI : (p.baseUrl && providerApiKey(p, env))));
}

// 请求的 model 可以是：空 / auto / default（走降级链）、服务商 ID（只用这家）、"服务商ID/模型"、或某家登记过的模型名
function resolveCandidates(requestedModel, providers, config) {
  const req = String(requestedModel || '').trim();
  const lower = req.toLowerCase();
  const aliases = DEFAULT_MODEL_ALIASES.concat(config.sitePolicy?.defaultModelAlias ? [String(config.sitePolicy.defaultModelAlias).toLowerCase()] : []);

  if (!aliases.includes(lower)) {
    for (const p of providers) {
      const id = String(p.id);
      const shortId = id.replace(/^provider_/, '');
      const name = String(p.name || '');
      if (lower === id.toLowerCase() || lower === shortId.toLowerCase()) return { list: [p], model: '' };
      for (const pre of [id, shortId, name].filter(Boolean)) {
        if (lower.startsWith(pre.toLowerCase() + '/')) return { list: [p], model: req.slice(pre.length + 1) };
      }
    }
    const matched = providers.filter((p) => {
      const all = splitList(p.models).concat(splitList(p.pollModels), p.defaultModel ? [p.defaultModel] : []);
      return all.some((m) => m.toLowerCase() === lower);
    });
    if (matched.length) return { list: matched, model: req };
  }

  // 降级链顺序在前，其余启用的服务商兜底
  const list = [];
  for (const id of config.sitePolicy?.fallbackChain || []) {
    const p = providers.find((x) => x.id === id);
    if (p && !list.includes(p)) list.push(p);
  }
  for (const p of providers) if (!list.includes(p)) list.push(p);
  return { list, model: '' };
}

// 单个服务商要依次尝试的模型：后台勾选的 pollModels（没勾就只用默认模型），指定了模型时它排第一
function modelsForProvider(provider, wanted) {
  const listed = splitList(provider.models);
  let pool = splitList(provider.pollModels);
  if (pool.length && listed.length) {
    const inList = pool.filter((m) => listed.includes(m));
    if (inList.length) pool = inList;
  }
  if (!pool.length) pool = [provider.defaultModel || listed[0] || 'default'];
  const order = [];
  if (wanted) {
    const hit = pool.find((m) => m.toLowerCase() === wanted.toLowerCase());
    order.push(hit || wanted);
  }
  for (const m of pool) if (!order.includes(m)) order.push(m);
  return order;
}

function buildUpstreamPayload(data, model) {
  const out = { model, messages: data.messages, stream: data.stream === true };
  for (const k of PASS_NUMBER) if (typeof data[k] === 'number') out[k] = data[k];
  for (const k of PASS_STRING) if (typeof data[k] === 'string') out[k] = data[k];
  for (const k of PASS_BOOL) if (typeof data[k] === 'boolean') out[k] = data[k];
  for (const k of PASS_ANY) if (data[k] !== undefined && data[k] !== null) out[k] = data[k];
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

function upstreamUrl(provider, path) {
  const base = String(provider.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return `${base}/${path}`;
}

// ---------- 流式转发：逐行处理 SSE，记录用量，非开发者请求隐藏上游模型名 ----------
function relayStream(upstreamBody, { rewriteModel, onDone, convertWorkersAi = false, aiModel = '' }) {
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let outputChars = '';
  let firstChunkAt = 0;
  const id = 'chatcmpl-' + randomId(16);
  const created = Math.floor(Date.now() / 1000);

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return line;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return line;
    let obj;
    try { obj = JSON.parse(payload); } catch (e) { return line; }
    if (convertWorkersAi) {
      if (obj.usage) usage = obj.usage;
      const piece = typeof obj.response === 'string' ? obj.response : '';
      if (piece) outputChars += piece;
      if (!piece && !obj.usage) return null;
      obj = {
        id, object: 'chat.completion.chunk', created, model: rewriteModel || aiModel,
        choices: piece ? [{ index: 0, delta: { content: piece }, finish_reason: null }] : [],
        ...(obj.usage ? { usage: obj.usage } : {})
      };
      return 'data: ' + JSON.stringify(obj);
    }
    if (obj.usage && typeof obj.usage.total_tokens === 'number') usage = obj.usage;
    const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
    if (delta) outputChars += (delta.content || '') + (delta.reasoning_content || '');
    if (rewriteModel && 'model' in obj) {
      obj.model = rewriteModel;
      return 'data: ' + JSON.stringify(obj);
    }
    return line;
  };

  const out = new TransformStream({
    transform(chunk, controller) {
      if (!firstChunkAt) firstChunkAt = Date.now();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      const emitted = [];
      for (const l of lines) {
        const r = handleLine(l);
        if (r !== null) emitted.push(r);
      }
      if (emitted.length) controller.enqueue(encoder.encode(emitted.join('\n') + '\n'));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) {
        const r = handleLine(buffer);
        if (r !== null) controller.enqueue(encoder.encode(r + '\n'));
      }
      if (convertWorkersAi) controller.enqueue(encoder.encode('\ndata: [DONE]\n\n'));
    }
  });

  const done = upstreamBody.pipeTo(out.writable).catch(() => {}).finally(() => {
    onDone({ usage, outputChars, firstChunkAt });
  });
  return { readable: out.readable, done };
}

// ---------- POST /v1/chat/completions ----------
async function handleChat(request, env, ctx, settings, config, client, site, pagePath, cors) {
  const started = Date.now();
  const T = settings.text;
  const isMaster = client.kind === 'master';
  const record = (m) => {
    const p = recordMetric(env, settings, {
      timestamp: started, client: isMaster ? client.name : client.kind,
      userId: client.userId || null, userName: client.userName || null,
      siteId: site.id, siteName: site.name, pagePath, ...m
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(() => {});
  };

  const len = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (len > settings.maxBody) return apiError(413, 'Request body too large', 'invalid_request_error', cors);
  let data;
  try {
    const text = await request.text();
    if (text.length > settings.maxBody) return apiError(413, 'Request body too large', 'invalid_request_error', cors);
    data = JSON.parse(text);
  } catch (e) {
    return apiError(400, 'Invalid JSON body', 'invalid_request_error', cors);
  }
  if (!data || typeof data !== 'object') return apiError(400, 'Invalid JSON body', 'invalid_request_error', cors);

  if ((!Array.isArray(data.messages) || !data.messages.length) && typeof data.prompt === 'string' && data.prompt.trim()) {
    data.messages = [{ role: 'user', content: data.prompt.trim() }];
  }
  if (!Array.isArray(data.messages) || !data.messages.length) {
    return apiError(400, 'messages must be a non-empty array', 'invalid_request_error', cors, 'missing_messages');
  }
  // 部分服务商不接受 content: null（带 tool_calls 的 assistant 消息），统一成空字符串
  data.messages = data.messages.map((m) => {
    if (!m || typeof m !== 'object') return { role: 'user', content: String(m || '') };
    return m.content === null || m.content === undefined ? { ...m, content: '' } : m;
  });

  // 次数限制（放在解析之后：空请求不扣次数）
  const limited = await checkRateLimit(env, request, client, site, config, settings);
  if (limited) {
    record({ providerId: 'rate_limit', providerName: T.rateProvider, model: 'none', status: 429, error: limited.isAuth ? T.rateAuth : T.rateUnauth });
    return apiError(429, `Daily request limit reached (${limited.limit})`, 'rate_limit_error', cors, 'daily_limit');
  }

  if (data.model === MODERATION_ALIAS) data.model = config.sitePolicy?.moderationModel || '';
  const requestedModel = typeof data.model === 'string' ? data.model : '';
  const providers = usableProviders(config, env);
  if (!providers.length) return apiError(503, 'No provider is enabled with an API key', 'service_unavailable', cors, 'no_provider');

  const { list: candidates, model: wantedModel } = resolveCandidates(requestedModel, providers, config);
  const publicModel = (m) => (isMaster || !settings.hideUpstreamModel ? m : (requestedModel || 'auto'));

  const failTrail = [];
  let lastStatus = 502;
  let lastDetail = '';
  const fallbackNote = () => (failTrail.length ? `${T.tried} ${failTrail.join('; ')}` : null);

  for (let i = 0; i < candidates.length; i++) {
    const provider = candidates[i];
    const models = modelsForProvider(provider, wantedModel);
    const apiKey = providerApiKey(provider, env);

    for (let j = 0; j < models.length; j++) {
      const model = models[j];
      const isFallback = i > 0 || j > 0;
      const base = { providerId: provider.id, providerName: provider.name || provider.id, model, fallback: isFallback };

      // Cloudflare Workers AI（需要 ai 绑定）
      if (isWorkersAi(provider)) {
        try {
          const out = await env.AI.run(model, { messages: data.messages, stream: data.stream === true, ...(typeof data.max_tokens === 'number' ? { max_tokens: data.max_tokens } : {}) });
          const promptTokens = estimateMessagesTokens(data.messages);
          if (data.stream) {
            const { readable, done } = relayStream(out, {
              rewriteModel: isMaster ? '' : publicModel(model), convertWorkersAi: true, aiModel: model,
              onDone: ({ usage, outputChars, firstChunkAt }) => {
                const pt = usage?.prompt_tokens || promptTokens;
                const cpt = usage?.completion_tokens || estimateTokens(outputChars);
                record({ ...base, status: 200, latencyMs: (firstChunkAt || Date.now()) - started, tokens: pt + cpt, promptTokens: pt, completionTokens: cpt, error: isFallback ? fallbackNote() : null });
              }
            });
            if (ctx && ctx.waitUntil) ctx.waitUntil(done);
            return new Response(readable, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...cors } });
          }
          const answer = typeof out?.response === 'string' ? out.response : (typeof out === 'string' ? out : JSON.stringify(out));
          const cpt = out?.usage?.completion_tokens || estimateTokens(answer);
          const pt = out?.usage?.prompt_tokens || promptTokens;
          record({ ...base, status: 200, latencyMs: Date.now() - started, tokens: pt + cpt, promptTokens: pt, completionTokens: cpt, error: isFallback ? fallbackNote() : null });
          return json({
            id: 'chatcmpl-' + randomId(16), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
            model: requestedModel && isMaster ? requestedModel : publicModel(model),
            choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
            usage: { prompt_tokens: pt, completion_tokens: cpt, total_tokens: pt + cpt }
          }, 200, cors);
        } catch (e) {
          lastStatus = 500;
          lastDetail = `Workers AI error: ${e && e.message ? e.message : 'unknown'}`;
          failTrail.push(`${base.providerName} / ${model}: ${T.e500}`);
          continue;
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), provider.timeoutMs || settings.upstreamTimeout);
      let res;
      try {
        res = await fetch(upstreamUrl(provider, 'chat/completions'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Accept': data.stream ? 'text/event-stream' : 'application/json' },
          body: JSON.stringify(buildUpstreamPayload(data, model)),
          signal: controller.signal
        });
      } catch (e) {
        clearTimeout(timer);
        lastStatus = 504;
        lastDetail = e && e.name === 'AbortError' ? 'Upstream timeout' : 'Upstream connection failed';
        failTrail.push(`${base.providerName} / ${model}: ${T.e504}`);
        continue;
      }
      clearTimeout(timer);

      if (!res.ok) {
        lastStatus = res.status;
        lastDetail = redact((await res.text().catch(() => '')).slice(0, 500), [apiKey]);
        failTrail.push(`${base.providerName} / ${model}: ${describeUpstreamError(res.status, T)}`);
        continue;
      }

      if (data.stream) {
        if (!res.body) { lastStatus = 502; lastDetail = 'Empty upstream stream'; failTrail.push(`${base.providerName} / ${model}: ${T.eOther}`); continue; }
        const { readable, done } = relayStream(res.body, {
          rewriteModel: isMaster ? '' : publicModel(model),
          onDone: ({ usage, outputChars, firstChunkAt }) => {
            let pt = usage?.prompt_tokens; let cpt = usage?.completion_tokens; let tt = usage?.total_tokens;
            if (typeof tt !== 'number') { pt = estimateMessagesTokens(data.messages); cpt = estimateTokens(outputChars); tt = pt + cpt; }
            record({ ...base, status: 200, latencyMs: Math.max(1, (firstChunkAt || Date.now()) - started), tokens: tt, promptTokens: pt || 0, completionTokens: cpt || 0, error: isFallback ? fallbackNote() : null });
          }
        });
        if (ctx && ctx.waitUntil) ctx.waitUntil(done);
        if (isFallback) maybeAlertSwitch(env, ctx, config, settings, client, site, pagePath, failTrail, provider);
        return new Response(readable, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...cors } });
      }

      let body;
      try { body = await res.json(); } catch (e) {
        lastStatus = 502; lastDetail = 'Upstream returned invalid JSON';
        failTrail.push(`${base.providerName} / ${model}: ${T.eOther}`);
        continue;
      }
      body.model = requestedModel && isMaster ? requestedModel : publicModel(body.model || model);
      let pt = body.usage?.prompt_tokens; let cpt = body.usage?.completion_tokens; let tt = body.usage?.total_tokens;
      if (typeof tt !== 'number') {
        pt = estimateMessagesTokens(data.messages);
        cpt = estimateTokens(body.choices?.[0]?.message?.content || '');
        tt = pt + cpt;
      }
      record({ ...base, status: 200, latencyMs: Date.now() - started, tokens: tt, promptTokens: pt || 0, completionTokens: cpt || 0, error: isFallback ? fallbackNote() : null });
      if (isFallback) maybeAlertSwitch(env, ctx, config, settings, client, site, pagePath, failTrail, provider);
      return json(body, 200, cors);
    }
  }

  // 全部失败
  const last = candidates[candidates.length - 1];
  record({
    providerId: last?.id || 'unknown', providerName: last?.name || last?.id || 'unknown',
    model: requestedModel || 'auto', status: lastStatus || 502, fallback: candidates.length > 1 || failTrail.length > 1,
    latencyMs: Date.now() - started,
    error: failTrail.length ? `${T.allFailed}: ${failTrail.join('; ')}` : describeUpstreamError(lastStatus, T)
  });
  if (client.kind !== 'master') {
    const p = sendAlert(env, config, settings, 'all-down', T.alertDown, [[T.source, site.name], [T.page, pagePath], [T.reason, failTrail.slice(-3).join('; ')]]);
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
  }
  // 上游原始报错（已去掉密钥）只给开发者密钥看，访客只看到通用说明
  return json({
    error: {
      message: 'All upstream providers failed. Please try again later.',
      type: 'upstream_error',
      code: 'all_providers_failed',
      ...(isMaster ? { details: lastDetail, attempts: failTrail } : {})
    }
  }, lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, cors);
}

function maybeAlertSwitch(env, ctx, config, settings, client, site, pagePath, failTrail, provider) {
  if (client.kind === 'master' || !failTrail.length) return;
  const T = settings.text;
  const p = sendAlert(env, config, settings, `switch:${provider.id}`, T.alertSwitch, [
    [T.source, site.name], [T.page, pagePath], [T.reason, failTrail.slice(-3).join('; ')], [T.switchedTo, provider.name || provider.id]
  ]);
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

// ---------- 图片 / 语音透传（仅开发者密钥） ----------
function findProvidersForModel(providers, requestedModel) {
  const lower = String(requestedModel || '').toLowerCase();
  if (!lower) return [];
  for (const p of providers) {
    for (const pre of [p.id, String(p.id || '').replace(/^provider_/, ''), p.name].filter(Boolean)) {
      if (lower.startsWith(String(pre).toLowerCase() + '/')) return [{ provider: p, model: requestedModel.slice(String(pre).length + 1) }];
    }
  }
  return providers.filter((p) => {
    const all = splitList(p.models).concat(splitList(p.pollModels), p.defaultModel ? [p.defaultModel] : []);
    return all.some((m) => m.toLowerCase() === lower);
  }).map((p) => ({ provider: p, model: requestedModel }));
}

// 在 multipart 原始字节里替换某个文本字段的值（按 latin1 逐字节映射，二进制内容不受影响）
function replaceMultipartField(bytes, name, value) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const utf8 = Array.from(encoder.encode(value), (b) => String.fromCharCode(b)).join('');
  const safeName = name.replace(/[^a-z0-9_]/gi, '');
  const re = new RegExp(`(Content-Disposition:\\s*form-data;\\s*name="${safeName}"[^\\r\\n]*\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n)[^\\r\\n]*`, 'i');
  bin = bin.replace(re, (m, head) => head + utf8);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function handleMedia(request, env, ctx, settings, config, client, site, mediaPath, cors) {
  const started = Date.now();
  const T = settings.text;
  const spec = MEDIA_ENDPOINTS[mediaPath];
  if (client.kind !== 'master') return apiError(403, `/v1/${mediaPath} requires a developer key`, 'permission_error', cors);

  const len = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (len > settings.maxMedia) return apiError(413, 'Request body too large', 'invalid_request_error', cors);
  const contentType = request.headers.get('Content-Type') || '';
  const isMultipart = contentType.toLowerCase().includes('multipart/form-data');
  let jsonBody = null;
  let rawBytes = null;
  let requestedModel = '';
  try {
    if (isMultipart) {
      rawBytes = new Uint8Array(await request.arrayBuffer());
      if (rawBytes.length > settings.maxMedia) return apiError(413, 'Request body too large', 'invalid_request_error', cors);
      const form = await new Response(rawBytes, { headers: { 'Content-Type': contentType } }).formData();
      requestedModel = String(form.get('model') || '').trim();
    } else {
      jsonBody = await request.json();
      requestedModel = String(jsonBody?.model || '').trim();
    }
  } catch (e) {
    return apiError(400, spec.multipart ? 'Body must be multipart/form-data' : 'Invalid JSON body', 'invalid_request_error', cors);
  }
  if (!requestedModel) return apiError(400, 'Missing model', 'invalid_request_error', cors);

  const providers = usableProviders(config, env).filter((p) => !isWorkersAi(p));
  const candidates = findProvidersForModel(providers, requestedModel);
  if (!candidates.length) return apiError(404, `No provider lists model ${requestedModel}`, 'invalid_request_error', cors, 'model_not_found');

  const record = (m) => {
    const p = recordMetric(env, settings, {
      timestamp: started, latencyMs: Date.now() - started, client: client.name,
      siteId: site.id, siteName: site.name, pagePath: `/v1/${mediaPath}`, toolName: spec.tool, ...m
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else p.catch(() => {});
  };

  const failTrail = [];
  let lastStatus = 502;
  let lastDetail = '';
  for (let i = 0; i < candidates.length; i++) {
    const { provider, model } = candidates[i];
    const apiKey = providerApiKey(provider, env);
    const headers = { 'Authorization': `Bearer ${apiKey}` };
    let body;
    if (rawBytes) {
      body = model === requestedModel ? rawBytes : replaceMultipartField(rawBytes, 'model', model);
      headers['Content-Type'] = contentType;
    } else {
      body = JSON.stringify({ ...jsonBody, model });
      headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(provider.timeoutMs || 0, settings.mediaTimeout));
    let res;
    try {
      res = await fetch(upstreamUrl(provider, mediaPath), { method: 'POST', headers, body, signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      lastStatus = 504; lastDetail = 'Upstream timeout or connection failed';
      failTrail.push(`${provider.name || provider.id} / ${model}: ${T.e504}`);
      continue;
    }
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      lastStatus = res.status; lastDetail = redact(text.slice(0, 500), [apiKey]);
      failTrail.push(`${provider.name || provider.id} / ${model}: ${describeUpstreamError(res.status, T)}`);
      continue;
    }
    let usage = null;
    try { usage = JSON.parse(text).usage || null; } catch (e) { usage = null; }
    const pt = usage?.prompt_tokens || usage?.input_tokens || 0;
    const cpt = usage?.completion_tokens || usage?.output_tokens || 0;
    record({ providerId: provider.id, providerName: provider.name || provider.id, model, status: 200, fallback: i > 0, tokens: usage?.total_tokens || pt + cpt, promptTokens: pt, completionTokens: cpt, error: failTrail.length ? `${T.tried} ${failTrail.join('; ')}` : null });
    return new Response(text, { status: 200, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store', ...cors } });
  }

  const last = candidates[candidates.length - 1].provider;
  record({ providerId: last.id, providerName: last.name || last.id, model: requestedModel, status: lastStatus, fallback: candidates.length > 1, error: failTrail.join('; ') });
  return json({ error: { message: `/v1/${mediaPath} failed on all providers`, type: 'upstream_error', details: lastDetail, attempts: failTrail } }, lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, cors);
}

// ---------- 入口 ----------
async function handleRequest(request, env, ctx, internal = null) {
  const settings = readSettings(env);
  const origin = internal ? '' : (request.headers.get('Origin') || '');
  const cors = corsHeadersFor(origin, settings);

  // 严格 CORS：带了 Origin 但不在白名单里的浏览器请求一律拒绝（包括预检）
  if (origin && !isOriginAllowed(origin, settings)) {
    return json({ error: { message: 'Origin not allowed', type: 'permission_error', code: 'origin_not_allowed' } }, 403, {});
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

  if (request.method === 'GET' && (path === '/' || path === '/v1')) {
    return json({ status: 'online', name: 'FlarePanel AI Gateway', version: GATEWAY_VERSION }, 200, cors);
  }

  const config = await getConfig(env, settings);

  // 只认开发者密钥的管理接口
  if ((path === '/v1/stats' || path === '/stats') || (path === '/v1/reload' || path === '/reload')) {
    const master = internal ? { id: 'internal' } : await matchMasterKey(config, extractToken(request), env);
    if (!master) return apiError(401, 'Master Key required', 'authentication_error', cors, 'invalid_api_key');

    if (path.endsWith('/stats')) {
      if (request.method !== 'GET') return apiError(405, 'Method not allowed', 'invalid_request_error', cors);
      const d = parseInt(url.searchParams.get('days') || '7', 10);
      const days = Math.min(Math.max(Number.isFinite(d) ? d : 7, 1), 30);
      return json(await buildStats(env, settings, days), 200, cors);
    }
    if (request.method !== 'POST') return apiError(405, 'Method not allowed', 'invalid_request_error', cors);
    const fresh = await getConfig(env, settings, true);
    return json({ status: 'success', version: fresh.version || 1, providers: (fresh.providers || []).filter((p) => p && p.enabled).length, time: new Date().toISOString() }, 200, cors);
  }

  const client = await identifyClient(request, env, config, settings, internal);
  if (!client) return apiError(401, 'Invalid or missing API key', 'authentication_error', cors, 'invalid_api_key');

  if (request.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    const created = Math.floor(Date.now() / 1000);
    const data = [];
    for (const p of config.providers || []) {
      if (!p || !p.enabled || !p.id) continue;
      for (const m of splitList(p.models)) {
        const id = `${p.id}/${m}`;
        data.push({ id, object: 'model', created, owned_by: p.id });
      }
    }
    return json({ object: 'list', data }, 200, cors);
  }

  if (request.method !== 'POST') return apiError(405, 'Method not allowed', 'invalid_request_error', cors);

  const site = detectSite(request, client, settings);
  const sub = path.replace(/^\/v1\//, '').replace(/^\//, '');
  if (MEDIA_ENDPOINTS[sub]) return handleMedia(request, env, ctx, settings, config, client, site, sub, cors);
  if (sub === 'chat/completions') {
    try {
      return await handleChat(request, env, ctx, settings, config, client, site, detectPagePath(request, client), cors);
    } catch (e) {
      console.error('Gateway error:', e && e.name, e && e.message);
      return apiError(500, 'Gateway internal error', 'server_error', cors);
    }
  }
  return apiError(404, 'Not found', 'invalid_request_error', cors);
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx, null);
  }
};

/**
 * 可选：给同账号下的其他 Worker 用 Service Binding 调用，不需要密钥，外网访问不到。
 * 调用方 wrangler 配置："services": [{ "binding": "AI_GATEWAY", "service": "<网关 Worker 名>", "entrypoint": "GatewayRPC" }]
 */
export class GatewayRPC extends WorkerEntrypoint {
  // body 是标准 chat/completions 请求体（不支持 stream），返回上游 JSON
  async chat(body = {}, caller = 'internal') {
    const req = new Request('https://gateway.internal/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: false })
    });
    const name = String(caller || 'internal').slice(0, 60);
    const res = await handleRequest(req, this.env, this.ctx, { id: 'internal', name });
    const data = await res.json();
    if (!res.ok) throw new Error(`Gateway returned HTTP ${res.status}`);
    return data;
  }

  // 内容审核：用后台「备用审核模型」（sitePolicy.moderationModel），没设就走默认降级链；返回去掉 <think> 段后的文字
  async moderate({ messages, site } = {}) {
    const data = await this.chat({ model: MODERATION_ALIAS, max_tokens: 1024, messages: Array.isArray(messages) ? messages : [] }, `moderation${site ? ` (${site})` : ''}`);
    const msg = data.choices?.[0]?.message || {};
    return String(msg.content || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
  }
}
