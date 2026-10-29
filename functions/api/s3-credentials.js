import { requireAdmin } from '../../lib/admin-auth.js';

// ============================================
// 安全获取 Cloudflare Pages 环境变量中配置的 R2 S3 专线凭据
// 仅允许持有本账号 R2 权限的 Cloudflare API Token 调用（后台登录用的那个 Token）
// ============================================

export async function onRequest(context) {
    const { request, env } = context;

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-cf-account-id'
            }
        });
    }

    if (request.method !== 'GET') {
        return new Response(JSON.stringify({ success: false, error: 'Method Not Allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    // 安全鉴权：只有持有本账号 R2 权限的 Token 才能取到 S3 凭据
    const denied = await requireAdmin(request, env, 'r2');
    if (denied) {
        denied.headers.set('Access-Control-Allow-Origin', '*');
        return denied;
    }

    const accessKeyId = env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = env.R2_SECRET_ACCESS_KEY || '';

    if (!accessKeyId || !secretAccessKey) {
        return new Response(JSON.stringify({
            success: false,
            configured: false,
            error: 'Pages 环境变量尚未生效或未配置 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY'
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    return new Response(JSON.stringify({
        success: true,
        configured: true,
        accessKeyId,
        secretAccessKey
    }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store'
        }
    });
}
