import { requireAdmin } from '../../lib/admin-auth.js';

export async function onRequest(context) {
    const { request, env } = context;

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            }
        });
    }

    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ success: false, error: 'Method Not Allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }

    // 安全鉴权：只有登录了管理后台的管理员才能使用，防止被当成公开跳板
    const denied = await requireAdmin(request, env, 'd1');
    if (denied) {
        denied.headers.set('Access-Control-Allow-Origin', '*');
        return denied;
    }

    try {
        const body = await request.json();
        let { baseUrl, apiKey } = body;

        if (!baseUrl) {
            return new Response(JSON.stringify({ success: false, error: '请提供服务商 API Base URL！' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        baseUrl = String(baseUrl).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        // 只允许 https 公网地址
        let parsed;
        try { parsed = new URL(baseUrl); } catch (e) { parsed = null; }
        const host = parsed?.hostname || '';
        const isPrivate = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
        if (!parsed || parsed.protocol !== 'https:' || isPrivate) {
            return new Response(JSON.stringify({ success: false, error: 'API Base URL 必须是 https 公网地址' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
        let modelsUrl = baseUrl;
        if (!modelsUrl.endsWith('/models')) {
            modelsUrl = `${modelsUrl}/models`;
        }

        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'FlarePanel/1.0'
        };
        if (apiKey && apiKey.trim()) {
            headers['Authorization'] = `Bearer ${apiKey.trim()}`;
        }

        // 发起远端请求
        const upstreamRes = await fetch(modelsUrl, {
            method: 'GET',
            headers,
            redirect: 'manual'
        });

        const rawText = await upstreamRes.text();
        let json;
        try {
            json = JSON.parse(rawText);
        } catch (e) {
            return new Response(JSON.stringify({
                success: false,
                error: `服务商返回了非 JSON 格式响应 (HTTP ${upstreamRes.status}): ${rawText.slice(0, 150)}`
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        if (!upstreamRes.ok) {
            const msg = json?.error?.message || json?.message || json?.detail || `HTTP 状态码: ${upstreamRes.status}`;
            return new Response(JSON.stringify({
                success: false,
                status: upstreamRes.status,
                error: `拉取失败 (${upstreamRes.status}): ${msg}`
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        // 解析各服务商的模型列表
        let modelList = [];
        if (Array.isArray(json.data)) {
            modelList = json.data.map(item => typeof item === 'string' ? item : item.id).filter(Boolean);
        } else if (Array.isArray(json.models)) {
            modelList = json.models.map(item => typeof item === 'string' ? item : (item.id || item.name)).filter(Boolean);
        } else if (Array.isArray(json)) {
            modelList = json.map(item => typeof item === 'string' ? item : item.id).filter(Boolean);
        } else if (json.result && Array.isArray(json.result)) {
            modelList = json.result.map(item => typeof item === 'string' ? item : item.id).filter(Boolean);
        }

        return new Response(JSON.stringify({
            success: true,
            count: modelList.length,
            models: modelList
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            }
        });

    } catch (err) {
        return new Response(JSON.stringify({
            success: false,
            error: `网络异常或无法访问该地址: ${err.message}`
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
}
