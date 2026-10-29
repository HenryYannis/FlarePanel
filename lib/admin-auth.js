// ============================================
// Pages Functions 共用的管理员校验
// 用调用方的 Cloudflare API Token 去列一次本账号的资源：能列出来才算管理员
// 账号 ID 来自 Pages 环境变量 CF_ACCOUNT_ID（必填）
// 校验通过的结果按 Token 的 SHA-256 缓存约 1 分钟（同一个 isolate 内），避免每个请求都去问一次 Cloudflare。
// 吊销/轮换 Token 后，同一 isolate 内最多约 1 分钟仍可能放行；重新部署或冷启动会清空这份内存缓存。
// ============================================

import { serverMsg } from './server-i18n.js';

const CHECK_PATHS = {
    d1: 'd1/database?per_page=1',
    r2: 'r2/buckets?per_page=1'
};

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 200;
// key: `${accountId}:${scope}:${sha256(token)}` → 过期时间戳。只缓存「通过」的结果
const positiveCache = new Map();

export function jsonResponse(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...extraHeaders
        }
    });
}

/**
 * 错误响应：同时带 error（本接口的格式）和 errors[]（Cloudflare API 的格式），前端两种都能读
 */
export function errorResponse(request, status, code, params = {}, extraHeaders = {}) {
    const message = serverMsg(request, code, params);
    return jsonResponse({ success: false, code, error: message, errors: [{ code, message }] }, status, extraHeaders);
}

/** 本面板配置的账号 ID；没配置或格式不对时返回空字符串 */
export function configuredAccountId(env) {
    const accountId = (env?.CF_ACCOUNT_ID || '').trim();
    return /^[0-9a-f]{32}$/i.test(accountId) ? accountId.toLowerCase() : '';
}

/** 从 Authorization: Bearer xxx 里取 Token */
export function bearerToken(request) {
    const authHeader = request.headers.get('Authorization') || '';
    return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

async function sha256Hex(text) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 校验 Token 能否访问本账号的资源（结果缓存约 1 分钟）
 * @returns {Promise<boolean>}
 */
export async function isAdminToken(token, accountId, scope = 'd1') {
    if (!token || !accountId) return false;
    const path = CHECK_PATHS[scope] ? scope : 'd1';
    const cacheKey = `${accountId}:${path}:${await sha256Hex(token)}`;
    const now = Date.now();
    const expires = positiveCache.get(cacheKey);
    if (expires && expires > now) return true;
    if (expires) positiveCache.delete(cacheKey);

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${CHECK_PATHS[path]}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = res.ok ? await res.json() : null;
        if (data?.success === true) {
            if (positiveCache.size >= CACHE_MAX) {
                // 清掉过期的；还满就丢掉最早放进去的
                for (const [k, v] of positiveCache) if (v <= now) positiveCache.delete(k);
                if (positiveCache.size >= CACHE_MAX) positiveCache.delete(positiveCache.keys().next().value);
            }
            positiveCache.set(cacheKey, now + CACHE_TTL_MS);
            return true;
        }
    } catch (e) {
        // 网络异常按未通过处理
    }
    return false;
}

/**
 * 校验请求是否来自本账号管理员
 * @param {Request} request
 * @param {object} env
 * @param {'d1'|'r2'} scope 用哪类资源来验证 Token
 * @param {{ token?: string }} [options] 不传 token 时从 Authorization: Bearer 读取
 * @returns {Promise<Response|null>} 校验不通过时返回错误响应，通过时返回 null
 */
export async function requireAdmin(request, env, scope = 'd1', options = {}) {
    const accountId = configuredAccountId(env);
    if (!accountId) {
        return errorResponse(request, 500, 'NOT_CONFIGURED');
    }

    const token = options.token !== undefined ? String(options.token || '').trim() : bearerToken(request);
    if (!token) {
        return errorResponse(request, 401, 'UNAUTHORIZED');
    }

    if (await isAdminToken(token, accountId, scope)) return null;
    return errorResponse(request, 403, 'FORBIDDEN_TOKEN');
}
