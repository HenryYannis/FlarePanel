export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    
    // 路径转发：将 /api/cf/... 映射到 Cloudflare API 的 /client/v4/...
    const cfPath = url.pathname.replace('/api/cf', '/client/v4');
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
        return new Response(JSON.stringify({ 
            success: false, 
            errors: [{ message: `Proxy Error: ${err.message}` }] 
        }), {
            status: 500,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
}
