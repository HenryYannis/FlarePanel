import { requireAdmin, errorResponse, jsonResponse } from '../../lib/admin-auth.js';
import { serverMsg, requestLang } from '../../lib/server-i18n.js';

// ============================================
// 发送一条 Telegram 测试消息，验证 AI 网关告警的通知通道
// 只有登录了管理后台的管理员才能用，防止被当成公开的消息转发接口
// ============================================

const CORS = { 'Access-Control-Allow-Origin': '*' };

// 测试消息正文（按请求语言），不含任何站点名
const TEST_TEXT = {
    zh: {
        title: 'Telegram 通知测试',
        source: '来源',
        status: '状态',
        statusOk: '通知通道正常',
        note: '说明',
        noteText: 'AI 网关告警会推送到这里',
        time: '时间'
    },
    en: {
        title: 'Telegram notification test',
        source: 'Source',
        status: 'Status',
        statusOk: 'Notification channel is working',
        note: 'Note',
        noteText: 'AI gateway alerts will be sent here',
        time: 'Time'
    }
};

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                ...CORS,
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept-Language'
            }
        });
    }

    if (request.method !== 'POST') {
        return errorResponse(request, 405, 'METHOD_NOT_ALLOWED', {}, CORS);
    }

    const denied = await requireAdmin(request, env, 'd1');
    if (denied) {
        denied.headers.set('Access-Control-Allow-Origin', '*');
        return denied;
    }

    try {
        const body = await request.json();
        const botToken = String(body?.botToken || '').trim();
        const chatId = String(body?.chatId || '').trim();

        if (!botToken || !chatId) {
            return errorResponse(request, 400, 'TG_MISSING_FIELDS', {}, CORS);
        }

        const L = TEST_TEXT[requestLang(request)];
        const utcString = new Date().toISOString().replace('T', ' ').slice(0, 19);

        // 通知格式：标题 / 来源 / 字段 / 时间
        const messageText = [
            `✅ <b>${L.title}</b>`,
            ``,
            `<b>${L.source}</b>: FlarePanel`,
            `<b>${L.status}</b>: ${L.statusOk}`,
            `<b>${L.note}</b>: ${L.noteText}`,
            ``,
            `<b>${L.time}</b>: ${utcString} UTC`
        ].join('\n');

        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: messageText,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });

        const tgJson = await tgRes.json().catch(() => ({}));

        if (tgRes.ok && tgJson.ok) {
            return jsonResponse({ success: true, message: serverMsg(request, 'TG_SENT') }, 200, CORS);
        }

        const errDesc = tgJson.description || `HTTP ${tgRes.status}`;
        let tip = '';
        if (tgRes.status === 401 || errDesc.includes('Unauthorized')) {
            tip = serverMsg(request, 'TG_TIP_TOKEN');
        } else if (errDesc.includes('chat not found')) {
            tip = serverMsg(request, 'TG_TIP_CHAT');
        }
        return jsonResponse({
            success: false,
            code: 'TG_API_ERROR',
            error: serverMsg(request, 'TG_API_ERROR', { msg: errDesc }) + tip
        }, 200, CORS);
    } catch (err) {
        return errorResponse(request, 500, 'REQUEST_FAILED', { msg: err.message }, CORS);
    }
}
