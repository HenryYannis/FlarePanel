import { requireAdmin, configuredAccountId, errorResponse } from '../../../lib/admin-auth.js';

// ============================================
// Cloudflare R2 S3 专线反向代理 (支持分片上传与突破 100MB 限制)
// 只转发到本面板账号（Pages 环境变量 CF_ACCOUNT_ID）的 R2：<CF_ACCOUNT_ID>.r2.cloudflarestorage.com
// Authorization 头里是 S3 SigV4 签名，所以后台登录用的 Cloudflare API Token 放在 x-cf-token 头里，
// 用和其他接口一样的管理员校验（r2 权限，结果缓存约 5 分钟）。x-cf-token 不会转发给 R2。
// ============================================

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept-Language, x-cf-token, x-cf-account-id, x-amz-date, x-amz-content-sha256, x-amz-security-token, x-amz-user-agent',
    'Access-Control-Expose-Headers': 'ETag, x-amz-request-id'
};

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // CORS 预检：直接回答，不转发给 R2
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '600' } });
    }

    const accountId = configuredAccountId(env);
    if (!accountId) {
        return errorResponse(request, 500, 'NOT_CONFIGURED', {}, CORS);
    }

    // 请求头 / 查询参数里的账号 ID 只用来核对，必须和本面板账号一致；真正转发的地址只用 CF_ACCOUNT_ID
    const claimedAccountId = (request.headers.get('x-cf-account-id') || url.searchParams.get('accountId') || '').trim().toLowerCase();
    if (claimedAccountId && claimedAccountId !== accountId) {
        return errorResponse(request, 403, 'FORBIDDEN_ACCOUNT', {}, CORS);
    }

    const denied = await requireAdmin(request, env, 'r2', { token: request.headers.get('x-cf-token') || '' });
    if (denied) {
        for (const [k, v] of Object.entries(CORS)) denied.headers.set(k, v);
        return denied;
    }

    // 路径映射：/api/s3/... -> https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com/...
    const s3Path = url.pathname.replace(/^\/api\/s3/, '');
    const cleanSearch = new URLSearchParams(url.search);
    cleanSearch.delete('accountId');
    const queryString = cleanSearch.toString() ? `?${cleanSearch.toString()}` : '';
    const targetUrl = `https://${accountId}.r2.cloudflarestorage.com${s3Path}${queryString}`;

    // 转发必要的 S3 请求头（x-cf-token、x-cf-account-id 不转发）
    const newHeaders = new Headers();
    const headersToForward = [
        'authorization',
        'x-amz-date',
        'x-amz-content-sha256',
        'x-amz-security-token',
        'content-type',
        'content-length'
    ];

    for (const [key, val] of request.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (headersToForward.includes(lowerKey) || lowerKey.startsWith('x-amz-')) {
            newHeaders.set(key, val);
        }
    }

    try {
        const isBodyAllowed = request.method !== 'GET' && request.method !== 'HEAD';
        const s3Response = await fetch(targetUrl, {
            method: request.method,
            headers: newHeaders,
            body: isBodyAllowed ? request.body : null,
            duplex: isBodyAllowed ? 'half' : undefined,
            redirect: 'manual'
        });

        // 构造响应
        const responseHeaders = new Headers();
        for (const [k, v] of s3Response.headers.entries()) {
            responseHeaders.set(k, v);
        }
        for (const [k, v] of Object.entries(CORS)) responseHeaders.set(k, v);

        return new Response(s3Response.body, {
            status: s3Response.status,
            statusText: s3Response.statusText,
            headers: responseHeaders
        });
    } catch (err) {
        return errorResponse(request, 500, 'PROXY_ERROR', { msg: err.message }, CORS);
    }
}
