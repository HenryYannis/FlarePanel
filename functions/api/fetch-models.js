import { requireAdmin, errorResponse, jsonResponse } from '../../lib/admin-auth.js';
import { isAllowedModelsBaseUrl } from '../../lib/allowed-models-url.js';
import { serverMsg } from '../../lib/server-i18n.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };

export async function onRequest(context) {
    const { request, env } = context;

    // 处理 OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept-Language'
            }
        });
    }

    if (request.method !== 'POST') {
        return errorResponse(request, 405, 'METHOD_NOT_ALLOWED', {}, CORS);
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
            return errorResponse(request, 400, 'MODELS_NO_BASE_URL', {}, CORS);
        }

        baseUrl = String(baseUrl).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
        if (!isAllowedModelsBaseUrl(baseUrl)) {
            return errorResponse(request, 400, 'MODELS_BAD_BASE_URL', {}, CORS);
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

        // 发起远端请求（不跟随重定向，避免跳进内网）
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
            return jsonResponse({
                success: false,
                code: 'MODELS_NOT_JSON',
                error: serverMsg(request, 'MODELS_NOT_JSON', { status: upstreamRes.status, body: rawText.slice(0, 150) })
            }, 200, CORS);
        }

        if (!upstreamRes.ok) {
            const msg = json?.error?.message || json?.message || json?.detail || `HTTP ${upstreamRes.status}`;
            return jsonResponse({
                success: false,
                status: upstreamRes.status,
                code: 'MODELS_FETCH_FAILED',
                error: serverMsg(request, 'MODELS_FETCH_FAILED', { status: upstreamRes.status, msg })
            }, 200, CORS);
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
        return jsonResponse({
            success: false,
            code: 'MODELS_NETWORK',
            error: serverMsg(request, 'MODELS_NETWORK', { msg: err.message })
        }, 200, CORS);
    }
}
