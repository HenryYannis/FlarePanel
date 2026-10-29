// ====================================================
// FlarePanel 账号 Worker（Cloudflare Workers + D1）
//
// 给静态网站提供会员账号：注册、登录（返回 JWT）、获取当前用户、改密码、改用户名、
// 恢复码（忘记密码时凭恢复码重置）、注销账号。数据写进 D1 的 users 表，由 FlarePanel「账号管理」管理。
//
// 站点相关的东西都在 wrangler 的 vars / secrets 里配置，代码里没有写死任何域名或账号。
// 部署说明见 account/README.md，表结构见 account/schema.sql。
//
// MIT License © 2026 程小宝
// ====================================================

// ---------- 默认值（都可以用 vars 覆盖） ----------
const DEFAULTS = {
  USERNAME_MIN_LENGTH: 2,
  USERNAME_MAX_LENGTH: 20,
  PASSWORD_MIN_LENGTH: 8,
  PASSWORD_MAX_LENGTH: 128,
  // PBKDF2 迭代数会写进每个哈希（pbkdf2$迭代数$哈希），以后调高不影响老账号：老账号下次登录时自动按新迭代数重算。
  // Workers 免费版每次请求 CPU 时间很紧，默认取 20000；付费版可以调到 100000（Workers 允许的上限）。
  PBKDF2_ITERATIONS: 20000,
  TOKEN_TTL_DAYS: 30,
  LOGIN_RATE_PER_MIN: 10,       // 同一 IP 每分钟最多几次「校验密码」（登录、改密、生成恢复码、注销）
  REGISTER_RATE_PER_DAY: 20,    // 同一 IP 每 24 小时最多注册几个账号
  RESET_RATE_PER_DAY: 10        // 同一 IP 每 24 小时最多尝试几次恢复码重置
};
const PBKDF2_MAX_ITERATIONS = 100000; // Cloudflare Workers 对 PBKDF2 迭代数的上限
const PBKDF2_PREFIX = 'pbkdf2$';
const MIN_JWT_SECRET_LENGTH = 32;
const MAX_BODY_BYTES = 8 * 1024;
// 恢复码字母表：去掉容易看混的 0 O 1 I L
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_LENGTH = 16;

// ---------- 错误信息（按 Accept-Language 返回中文或英文，并带 code） ----------
const MESSAGES = {
  bad_json: ['请求内容不是合法的 JSON', 'Invalid JSON body'],
  body_too_large: ['请求内容太大', 'Request body is too large'],
  missing_fields: ['缺少必填字段', 'Missing required fields'],
  invalid_username: ['用户名长度或格式不符合要求', 'Username length or format is not allowed'],
  reserved_username: ['这个用户名不能使用', 'This username is reserved'],
  username_taken: ['用户名已被占用', 'Username is already taken'],
  same_username: ['新用户名和当前用户名相同', 'New username is the same as the current one'],
  weak_password: ['密码长度不符合要求', 'Password length is not allowed'],
  password_mismatch: ['两次输入的密码不一致', 'Passwords do not match'],
  invalid_credentials: ['用户名或密码错误', 'Incorrect username or password'],
  wrong_password: ['密码错误', 'Incorrect password'],
  invalid_recovery: ['用户名或恢复码不正确', 'Incorrect username or recovery code'],
  unauthorized: ['未登录或登录已失效', 'Not signed in or session expired'],
  rate_limited: ['操作太频繁，请稍后再试', 'Too many requests, please slow down'],
  not_found: ['接口不存在', 'Not found'],
  method_not_allowed: ['请求方法不被允许', 'Method not allowed'],
  forbidden_origin: ['来源不被允许', 'Origin not allowed'],
  not_configured: ['服务端未配置', 'Server is not configured'],
  server_error: ['服务器内部错误，请稍后再试', 'Internal server error, please try again later']
};

// 路由表：路径 → { 方法: 处理函数 }
const ROUTES = {
  '/api/auth/register': { POST: register },
  '/api/auth/login': { POST: login },
  '/api/auth/me': { GET: me },
  '/api/auth/update_password': { POST: updatePassword },
  '/api/auth/update_username': { POST: updateUsername },
  '/api/auth/recovery_code': { POST: recoveryCode },
  '/api/auth/reset_password': { POST: resetPassword },
  '/api/auth/delete_account': { POST: deleteAccount, DELETE: deleteAccount }
};

class HttpError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = readConfig(env);
    const lang = pickLang(request);
    const origin = request.headers.get('Origin') || '';
    const originAllowed = isOriginAllowed(origin, cfg);
    const cors = {
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (originAllowed) cors['Access-Control-Allow-Origin'] = origin;

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors }
    });
    const fail = (code, status) => json({ success: false, code, error: msg(code, lang) }, status);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
    }

    // 浏览器发来的请求必须来自允许的域名。不带 Origin 的服务端请求不受影响（照样要 Token、照样限流）。
    // 登录凭证放在 Authorization 头里而不是 Cookie，别的网站无法借用访客的登录状态。
    if (origin && !originAllowed) return fail('forbidden_origin', 403);

    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' && request.method === 'GET') {
      return new Response('FlarePanel account API\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors } });
    }

    const route = ROUTES[path];
    if (!route) return fail('not_found', 404);
    const handler = route[request.method];
    if (!handler) return fail('method_not_allowed', 405);

    // 没有 D1 绑定或 JWT_SECRET（或太短）时整个服务拒绝工作，避免用空密钥签发凭证
    if (!env.DB || !cfg.jwtSecret) return fail('not_configured', 500);

    try {
      const ctx = { request, env, cfg, ip: request.headers.get('CF-Connecting-IP') || '' };
      const result = await handler(ctx);
      return json({ success: true, ...result.body }, result.status || 200);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.code, err.status);
      // 详细错误只写日志，不返回给访客
      console.error('account-worker error:', err);
      return fail('server_error', 500);
    }
  }
};

// ====================================================
// 接口
// ====================================================

// POST /api/auth/register  { username, password, confirmPassword? }
async function register({ request, env, cfg, ip }) {
  const data = await readJson(request);
  const username = checkUsername(data.username, cfg);
  const password = checkNewPassword(data.password, data.confirmPassword, cfg);

  await enforceRateLimit(env, 'register', ip, cfg.registerRatePerDay, 86400);

  if (await usernameExists(env, username)) throw new HttpError('username_taken', 409);

  const id = crypto.randomUUID();
  const salt = randomSalt();
  const passwordHash = await hashPassword(password, salt, cfg.iterations);
  const code = generateRecoveryCode();
  try {
    await env.DB.prepare(`
      INSERT INTO users (id, username, password_hash, salt, recovery_code_hash)
      VALUES (?, ?, ?, ?, ?)
    `).bind(id, username, passwordHash, salt, await hashRecoveryCode(id, code)).run();
  } catch (err) {
    // 两个请求同时注册同一个名字时，由 UNIQUE 约束兜底
    if (/UNIQUE/i.test(String(err && err.message))) throw new HttpError('username_taken', 409);
    throw err;
  }

  // 恢复码明文只在这里返回一次，库里只存哈希
  return { status: 201, body: { user: { id, username }, recoveryCode: code } };
}

// POST /api/auth/login  { username, password }
async function login({ request, env, cfg, ip }) {
  const data = await readJson(request);
  const username = typeof data.username === 'string' ? normalizeUsername(data.username) : '';
  const password = typeof data.password === 'string' ? data.password : '';
  if (!username || !password) throw new HttpError('missing_fields', 400);

  await enforceRateLimit(env, 'password', ip, cfg.loginRatePerMin, 60);
  if (password.length > cfg.passwordMax) throw new HttpError('invalid_credentials', 401);

  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  // 用户不存在时也算一次哈希，响应时间和「密码错误」差不多，不能据此判断用户名是否存在
  const ok = user
    ? await verifyPassword(password, user)
    : (await hashPassword(password, 'dummy-salt', cfg.iterations), false);
  if (!ok) throw new HttpError('invalid_credentials', 401);

  // 老哈希的迭代数低于当前配置时，顺手按新迭代数重算（失败不影响登录）
  if (storedIterations(user.password_hash) < cfg.iterations) {
    try {
      const salt = randomSalt();
      await env.DB.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
        .bind(await hashPassword(password, salt, cfg.iterations), salt, user.id).run();
    } catch (err) {
      console.error('password rehash failed:', err);
    }
  }

  const row = await env.DB.prepare(`
    UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?
    RETURNING id, username, created_at, last_login_at, token_version
  `).bind(user.id).first();
  const current = row || user;
  return { body: { token: await issueToken(current, cfg), user: publicUser(current) } };
}

// GET /api/auth/me  （Authorization: Bearer <token>）
async function me(ctx) {
  const user = await requireUser(ctx);
  return { body: { user: publicUser(user) } };
}

// POST /api/auth/update_password  { oldPassword, newPassword, confirmNewPassword? }
// 改密后其他设备上的旧凭证全部失效，当前设备拿到新凭证
async function updatePassword(ctx) {
  const { request, env, cfg, ip } = ctx;
  const user = await requireUser(ctx);
  const data = await readJson(request);
  if (typeof data.oldPassword !== 'string' || !data.oldPassword) throw new HttpError('missing_fields', 400);
  const newPassword = checkNewPassword(data.newPassword, data.confirmNewPassword, cfg);

  await enforceRateLimit(env, 'password', ip, cfg.loginRatePerMin, 60);
  if (!(await verifyPassword(data.oldPassword, user))) throw new HttpError('wrong_password', 403);

  const salt = randomSalt();
  const row = await env.DB.prepare(`
    UPDATE users SET password_hash = ?, salt = ?, token_version = COALESCE(token_version, 0) + 1
    WHERE id = ?
    RETURNING id, username, created_at, last_login_at, token_version
  `).bind(await hashPassword(newPassword, salt, cfg.iterations), salt, user.id).first();
  if (!row) throw new HttpError('unauthorized', 401);
  return { body: { token: await issueToken(row, cfg), user: publicUser(row) } };
}

// POST /api/auth/update_username  { newUsername }
async function updateUsername(ctx) {
  const { request, env, cfg } = ctx;
  const user = await requireUser(ctx);
  const data = await readJson(request);
  const newUsername = checkUsername(data.newUsername, cfg);
  if (newUsername === user.username) throw new HttpError('same_username', 400);

  // 只改大小写（Alice → alice）不算占用
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ? LIMIT 1')
    .bind(newUsername, user.id).first();
  if (existing) throw new HttpError('username_taken', 409);

  let row;
  try {
    row = await env.DB.prepare(`
      UPDATE users SET username = ? WHERE id = ?
      RETURNING id, username, created_at, last_login_at, token_version
    `).bind(newUsername, user.id).first();
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) throw new HttpError('username_taken', 409);
    throw err;
  }
  if (!row) throw new HttpError('unauthorized', 401);
  // 凭证里带用户名，换发一张新的
  return { body: { token: await issueToken(row, cfg), user: publicUser(row) } };
}

// POST /api/auth/recovery_code  { password }
// 登录状态下验证密码后生成新恢复码，旧恢复码作废
async function recoveryCode(ctx) {
  const { request, env, cfg, ip } = ctx;
  const user = await requireUser(ctx);
  const data = await readJson(request);
  if (typeof data.password !== 'string' || !data.password) throw new HttpError('missing_fields', 400);

  await enforceRateLimit(env, 'password', ip, cfg.loginRatePerMin, 60);
  if (!(await verifyPassword(data.password, user))) throw new HttpError('wrong_password', 403);

  const code = generateRecoveryCode();
  await env.DB.prepare('UPDATE users SET recovery_code_hash = ? WHERE id = ?')
    .bind(await hashRecoveryCode(user.id, code), user.id).run();
  return { body: { recoveryCode: code } };
}

// POST /api/auth/reset_password  { username, recoveryCode, newPassword, confirmNewPassword? }
// 忘记密码：凭恢复码重置。成功后旧恢复码作废并返回新恢复码，所有设备上的旧凭证失效
async function resetPassword({ request, env, cfg, ip }) {
  const data = await readJson(request);
  const username = typeof data.username === 'string' ? normalizeUsername(data.username) : '';
  const code = normalizeRecoveryCode(data.recoveryCode);
  if (!username || !code) throw new HttpError('missing_fields', 400);
  const newPassword = checkNewPassword(data.newPassword, data.confirmNewPassword, cfg);

  await enforceRateLimit(env, 'reset', ip, cfg.resetRatePerDay, 86400);

  const user = await env.DB.prepare('SELECT id, recovery_code_hash FROM users WHERE username = ?').bind(username).first();
  const expected = user && user.recovery_code_hash ? user.recovery_code_hash : '';
  const actual = await hashRecoveryCode(user ? user.id : 'none', code);
  if (!expected || code.length !== RECOVERY_LENGTH || !safeEqual(actual, expected)) {
    throw new HttpError('invalid_recovery', 401);
  }

  const salt = randomSalt();
  const newCode = generateRecoveryCode();
  const row = await env.DB.prepare(`
    UPDATE users SET password_hash = ?, salt = ?, recovery_code_hash = ?,
      token_version = COALESCE(token_version, 0) + 1
    WHERE id = ? AND recovery_code_hash = ?
    RETURNING id
  `).bind(await hashPassword(newPassword, salt, cfg.iterations), salt, await hashRecoveryCode(user.id, newCode), user.id, expected).first();
  // 恢复码在这期间被别的请求用掉了
  if (!row) throw new HttpError('invalid_recovery', 401);
  return { body: { recoveryCode: newCode } };
}

// POST 或 DELETE /api/auth/delete_account  { password }
async function deleteAccount(ctx) {
  const { request, env, cfg, ip } = ctx;
  const user = await requireUser(ctx);
  const data = await readJson(request);
  if (typeof data.password !== 'string' || !data.password) throw new HttpError('missing_fields', 400);

  await enforceRateLimit(env, 'password', ip, cfg.loginRatePerMin, 60);
  if (!(await verifyPassword(data.password, user))) throw new HttpError('wrong_password', 403);

  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  return { body: {} };
}

// ====================================================
// 配置
// ====================================================
function readConfig(env) {
  const int = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const list = (v) => String(v || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const bool = (v, d) => (v === undefined || v === null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

  let usernamePattern = null;
  if (env.USERNAME_PATTERN) {
    try {
      usernamePattern = new RegExp(String(env.USERNAME_PATTERN), 'u');
    } catch (err) {
      console.error('USERNAME_PATTERN is not a valid regular expression, ignored:', err);
    }
  }
  const secret = String(env.JWT_SECRET || '');
  const usernameMin = Math.max(1, int(env.USERNAME_MIN_LENGTH, DEFAULTS.USERNAME_MIN_LENGTH));
  const passwordMin = Math.max(1, int(env.PASSWORD_MIN_LENGTH, DEFAULTS.PASSWORD_MIN_LENGTH));
  return {
    jwtSecret: secret.length >= MIN_JWT_SECRET_LENGTH ? secret : '',
    allowedOrigins: list(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, '')),
    allowLocalhost: bool(env.ALLOW_LOCALHOST, false),
    usernameMin,
    usernameMax: Math.max(usernameMin, int(env.USERNAME_MAX_LENGTH, DEFAULTS.USERNAME_MAX_LENGTH)),
    usernamePattern,
    reservedUsernames: list(env.RESERVED_USERNAMES).map((n) => n.normalize('NFKC').toLowerCase()),
    passwordMin,
    passwordMax: Math.max(passwordMin, int(env.PASSWORD_MAX_LENGTH, DEFAULTS.PASSWORD_MAX_LENGTH)),
    iterations: Math.min(PBKDF2_MAX_ITERATIONS, Math.max(1000, int(env.PBKDF2_ITERATIONS, DEFAULTS.PBKDF2_ITERATIONS))),
    tokenTtl: Math.max(1, int(env.TOKEN_TTL_DAYS, DEFAULTS.TOKEN_TTL_DAYS)) * 86400,
    loginRatePerMin: int(env.LOGIN_RATE_PER_MIN, DEFAULTS.LOGIN_RATE_PER_MIN),
    registerRatePerDay: int(env.REGISTER_RATE_PER_DAY, DEFAULTS.REGISTER_RATE_PER_DAY),
    resetRatePerDay: int(env.RESET_RATE_PER_DAY, DEFAULTS.RESET_RATE_PER_DAY)
  };
}

function isOriginAllowed(origin, cfg) {
  if (!origin) return false;
  if (cfg.allowedOrigins.includes(origin)) return true;
  if (cfg.allowLocalhost && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function pickLang(request) {
  return /^zh/i.test(request.headers.get('Accept-Language') || '') ? 0 : 1;
}

function msg(code, lang) {
  return (MESSAGES[code] || MESSAGES.server_error)[lang];
}

// ====================================================
// 请求和校验
// ====================================================
async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new HttpError('body_too_large', 413);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError('bad_json', 400);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError('bad_json', 400);
  return data;
}

function normalizeUsername(name) {
  return String(name).normalize('NFC').trim();
}

// 用户名规则：长度（按字符）、不能有 < > " ' & 和不可见字符（零宽、方向控制等可用来冒充别人）、
// 可选的 USERNAME_PATTERN、不能包含 RESERVED_USERNAMES 里的词（不分大小写，全角折成半角、忽略空格）
function checkUsername(value, cfg) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError('missing_fields', 400);
  const name = normalizeUsername(value);
  const len = [...name].length;
  if (len < cfg.usernameMin || len > cfg.usernameMax) throw new HttpError('invalid_username', 400);
  if (/[<>"'&\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) throw new HttpError('invalid_username', 400);
  if (cfg.usernamePattern && !cfg.usernamePattern.test(name)) throw new HttpError('invalid_username', 400);
  const folded = name.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (cfg.reservedUsernames.some((w) => w && folded.includes(w.replace(/\s+/g, '')))) {
    throw new HttpError('reserved_username', 400);
  }
  return name;
}

function checkNewPassword(password, confirm, cfg) {
  if (typeof password !== 'string' || !password) throw new HttpError('missing_fields', 400);
  if (password.length < cfg.passwordMin || password.length > cfg.passwordMax) throw new HttpError('weak_password', 400);
  // 确认密码可选：传了就必须一致
  if (confirm !== undefined && confirm !== null && confirm !== password) throw new HttpError('password_mismatch', 400);
  return password;
}

// 注册和改名时按不分大小写查重，防止 Admin / admin 这类冒充
async function usernameExists(env, username) {
  const row = await env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1').bind(username).first();
  return !!row;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    created_at: user.created_at || null,
    last_login_at: user.last_login_at || null
  };
}

// ====================================================
// 频率限制：固定窗口，同一 IP 每个窗口最多 limit 次，IP 只存哈希。limit 为 0 表示不限。
// 请求里没有 CF-Connecting-IP 时不限制（线上的 Worker 总会有）。限流表读写失败时拒绝请求（账号接口宁可暂时不可用，也不放开暴力破解）。
// ====================================================
async function enforceRateLimit(env, bucket, ip, limit, windowSec) {
  if (!limit || !ip) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(nowSec / windowSec);
  const key = `acct-${bucket}:${(await sha256Hex('ip:' + ip)).slice(0, 32)}:${windowSec}:${windowStart}`;
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits (k, n, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(k) DO UPDATE SET n = n + 1
    RETURNING n
  `).bind(key, (windowStart + 2) * windowSec).first();
  // 偶尔清一次过期记录
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(nowSec).run().catch(() => {});
  }
  if (row && row.n > limit) throw new HttpError('rate_limited', 429);
}

// ====================================================
// 密码哈希：PBKDF2-SHA256，格式 pbkdf2$迭代数$十六进制哈希，盐单独存在 salt 列
// ====================================================
function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// 常量时间比较（长度不同直接返回 false，长度本身不是秘密）
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomSalt() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

async function hashPassword(password, salt, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations },
    key,
    256
  );
  return `${PBKDF2_PREFIX}${iterations}$${toHex(bits)}`;
}

function storedIterations(stored) {
  const m = /^pbkdf2\$(\d+)\$[0-9a-f]+$/.exec(String(stored || ''));
  return m ? parseInt(m[1], 10) : 0;
}

// 只认 pbkdf2$迭代数$哈希 格式；迭代数取自哈希本身，所以调整 PBKDF2_ITERATIONS 不影响老账号登录
async function verifyPassword(password, user) {
  const iterations = storedIterations(user && user.password_hash);
  if (!iterations || iterations > PBKDF2_MAX_ITERATIONS || typeof password !== 'string') return false;
  return safeEqual(await hashPassword(password, String(user.salt || ''), iterations), user.password_hash);
}

// ====================================================
// 恢复码：16 位随机字符（显示成 XXXX-XXXX-XXXX-XXXX），库里只存哈希，用一次就换新
// ====================================================
function generateRecoveryCode() {
  const out = [];
  // 拒绝采样，避免取模带来的分布偏差
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  while (out.length < RECOVERY_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && out.length < RECOVERY_LENGTH) out.push(RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
    }
  }
  return out.join('').match(/.{4}/g).join('-');
}

function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 64);
}

async function hashRecoveryCode(userId, code) {
  return sha256Hex(`recovery:${userId}:${normalizeRecoveryCode(code)}`);
}

// ====================================================
// JWT（HS256，Web Crypto 实现，无依赖）
// 载荷：sub = 用户 id、name = 用户名、ver = 凭证版本、iat / exp。
// 改密或凭恢复码重置时 token_version +1，之前签发的凭证全部失效；注销账号后凭证自然失效。
// ====================================================
function b64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlEncode(text) {
  return b64urlFromBytes(new TextEncoder().encode(text));
}

function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64urlFromBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

async function issueToken(user, cfg) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify({
    sub: user.id,
    name: user.username,
    ver: Number(user.token_version) || 0,
    iat: now,
    exp: now + cfg.tokenTtl
  }));
  return `${header}.${payload}.${await hmacSign(`${header}.${payload}`, cfg.jwtSecret)}`;
}

async function verifyToken(token, cfg) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!safeEqual(signature, await hmacSign(`${header}.${payload}`, cfg.jwtSecret))) return null;
  try {
    const h = JSON.parse(b64urlDecode(header));
    if (!h || h.alg !== 'HS256') return null;
    const p = JSON.parse(b64urlDecode(payload));
    if (!p || typeof p.sub !== 'string' || typeof p.exp !== 'number') return null;
    if (p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch {
    return null;
  }
}

// 读 Authorization: Bearer <token>，验签后再查库：账号已注销、凭证版本过期都算未登录
async function requireUser({ request, env, cfg }) {
  const auth = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) throw new HttpError('unauthorized', 401);
  const claims = await verifyToken(m[1], cfg);
  if (!claims) throw new HttpError('unauthorized', 401);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(claims.sub).first();
  if (!user || (Number(user.token_version) || 0) !== (Number(claims.ver) || 0)) throw new HttpError('unauthorized', 401);
  return user;
}
