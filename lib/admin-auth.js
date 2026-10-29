// ============================================
// Pages Functions 共用的管理员校验
// 用调用方的 Cloudflare API Token 去列一次本账号的资源：能列出来才算管理员
// 账号 ID 来自 Pages 环境变量 CF_ACCOUNT_ID（必填）
// ============================================

const CHECK_PATHS = {
    d1: 'd1/database?per_page=1',
    r2: 'r2/buckets?per_page=1'
};

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
 * 校验请求是否来自本账号管理员
 * @returns {Promise<Response|null>} 校验不通过时返回错误响应，通过时返回 null
 */
export async function requireAdmin(request, env, scope = 'd1') {
    const accountId = (env.CF_ACCOUNT_ID || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(accountId)) {
        return jsonResponse({ success: false, error: '服务端未配置：请在 Pages 环境变量里设置 CF_ACCOUNT_ID' }, 500);
    }

    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
        return jsonResponse({ success: false, error: '未授权访问：请先登录管理后台' }, 401);
    }

    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${CHECK_PATHS[scope] || CHECK_PATHS.d1}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = res.ok ? await res.json() : null;
        if (data?.success === true) return null;
    } catch (e) {
        // 网络异常按未通过处理
    }
    return jsonResponse({ success: false, error: '未授权访问：Token 无效或没有本账号的权限' }, 403);
}
