import { requireAdmin, configuredAccountId, errorResponse } from '../../../lib/admin-auth.js';

// ============================================
// Cloudflare API 反向代理：/api/cf/... → https://api.cloudflare.com/client/v4/...
// 只放行本面板账号（Pages 环境变量 CF_ACCOUNT_ID）下的接口：/api/cf/accounts/<CF_ACCOUNT_ID>/...
// 并且调用方的 Token 必须能访问这个账号（requireAdmin，结果缓存约 1 分钟）。
// 前端登录时也是先请求 /api/cf/accounts/<id>/d1/database，所以登录本身就会走这道校验，不需要额外放行别的接口。
// ============================================

const CORS = { 'Access-Control-Allow-Origin': '*' };

function withCors(res) {
    res.headers.set('Access-Control-Allow-Origin', '*');
    return res;
}

/** 校验路径：必须是 /api/cf/accounts/<本账号>/...，不能带 . / .. 路径段 */
function checkPath(pathname, accountId) {
    const segs = pathname.split('/');
    // ['', 'api', 'cf', 'accounts', '<id>', ...]
    if (segs[1] !== 'api' || segs[2] !== 'cf' || segs[3] !== 'accounts' || !segs[4]) return 'FORBIDDEN_PATH';
    for (const seg of segs.slice(5)) {
        let decoded;
        try { decoded = decodeURIComponent(seg); } catch (e) { return 'FORBIDDEN_PATH'; }
        if (decoded === '.' || decoded === '..' || /(^|[\/\\])\.\.([\/\\]|$)/.test(decoded)) return 'FORBIDDEN_PATH';
    }
    if (segs[4].toLowerCase() !== accountId) return 'FORBIDDEN_ACCOUNT';
    return null;
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                ...CORS,
                'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept-Language'
            }
        });
    }

    const accountId = configuredAccountId(env);
    if (!accountId) {
        return errorResponse(request, 500, 'NOT_CONFIGURED', {}, CORS);
    }

    const pathError = checkPath(url.pathname, accountId);
    if (pathError) {
        return errorResponse(request, 403, pathError, {}, CORS);
    }

    const denied = await requireAdmin(request, env, 'd1');
    if (denied) return withCors(denied);

    // 路径转发：将 /api/cf/... 映射到 Cloudflare API 的 /client/v4/...
    const cfPath = url.pathname.replace(/^\/api\/cf/, '/client/v4');
    const targetUrl = `https://api.cloudflare.com${cfPath}${url.search}`;

    // 只复制必要的请求头，避免转发浏览器的 Host, Cookie, Accept-Encoding 等
    const newHeaders = new Headers();
    if (request.headers.has('Authorization')) {
        newHeaders.set('Authorization', request.headers.get('Authorization'));
    }
    if (request.headers.has('Content-Type')) {
        newHeaders.set('Content-Type', request.headers.get('Content-Type'));
    }

    try {
        // 转发请求：改用流式透传，避免内存中缓冲大文件导致 128MB OOM 崩溃
        const isBodyAllowed = request.method !== 'GET' && request.method !== 'HEAD';
        const cfResponse = await fetch(targetUrl, {
            method: request.method,
            headers: newHeaders,
            body: isBodyAllowed ? request.body : null,
            duplex: isBodyAllowed ? 'half' : undefined,
            redirect: 'manual'
        });

        // 构造新的响应头，避免 content-encoding/content-length 冲突
        const responseHeaders = new Headers();
        const cfContentType = cfResponse.headers.get('content-type');
        if (cfContentType) {
            responseHeaders.set('content-type', cfContentType);
        }
        responseHeaders.set('Access-Control-Allow-Origin', '*');

        return new Response(cfResponse.body, {
            status: cfResponse.status,
            statusText: cfResponse.statusText,
            headers: responseHeaders
        });
    } catch (err) {
        return errorResponse(request, 500, 'PROXY_ERROR', { msg: err.message }, CORS);
    }
}
