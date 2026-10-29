// ============================================
// Cloudflare R2 S3 专线反向代理 (支持分片上传与突破 100MB 限制)
// ============================================

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);

    // 获取账户 ID（从请求头或查询参数获取）
    const accountId = request.headers.get('x-cf-account-id') || url.searchParams.get('accountId');
    if (!accountId) {
        return new Response(JSON.stringify({ error: 'Missing x-cf-account-id header' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    // 账户 ID 只能是 32 位十六进制，防止拼出 https://evil.com#.r2... 这类地址把代理变成任意转发
    if (!/^[0-9a-f]{32}$/i.test(accountId)) {
        return new Response(JSON.stringify({ error: 'Invalid account id' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    // 路径映射：/api/s3/... -> https://<accountId>.r2.cloudflarestorage.com/...
    const s3Path = url.pathname.replace('/api/s3', '');
    const cleanSearch = new URLSearchParams(url.search);
    cleanSearch.delete('accountId');
    const queryString = cleanSearch.toString() ? `?${cleanSearch.toString()}` : '';
    const targetUrl = `https://${accountId}.r2.cloudflarestorage.com${s3Path}${queryString}`;

    // 转发必要的 S3 请求头
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
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, HEAD, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', '*');
        responseHeaders.set('Access-Control-Expose-Headers', 'ETag, x-amz-request-id');

        return new Response(s3Response.body, {
            status: s3Response.status,
            statusText: s3Response.statusText,
            headers: responseHeaders
        });
    } catch (err) {
        return new Response(JSON.stringify({ 
            error: `S3 Proxy Error: ${err.message}` 
        }), {
            status: 500,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
}
