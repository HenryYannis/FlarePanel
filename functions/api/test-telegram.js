import { requireAdmin } from '../../lib/admin-auth.js';

export async function onRequest(context) {
    const { request, env } = context;

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

    // 只有登录了管理后台的管理员才能用，防止被当成公开的消息转发接口
    const denied = await requireAdmin(request, env, 'd1');
    if (denied) {
        denied.headers.set('Access-Control-Allow-Origin', '*');
        return denied;
    }

    try {
        const body = await request.json();
        const { botToken, chatId } = body;

        if (!botToken || !chatId) {
            return new Response(JSON.stringify({ 
                success: false, 
                error: '请先填写 Telegram Bot Token 和 Chat ID！' 
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }

        const now = new Date();
        const bjtString = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

        // 通知格式：标题 / 来源 / 字段 / 时间
        const messageText = [
            `✅ <b>Telegram 通知测试</b>`,
            ``,
            `<b>来源</b>：FlarePanel（${new URL(request.url).host}）`,
            `<b>状态</b>：通知通道正常`,
            `<b>说明</b>：AI 网关告警会推送到这里`,
            ``,
            `<b>时间</b>：${bjtString}（北京时间）`
        ].join('\n');

        const telegramUrl = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;

        const tgRes = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId.trim(),
                text: messageText,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        });

        const tgJson = await tgRes.json();

        if (tgRes.ok && tgJson.ok) {
            return new Response(JSON.stringify({
                success: true,
                message: 'Telegram 测试消息已成功发出！请检查您的 Telegram 客户端。'
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        } else {
            const errDesc = tgJson.description || `HTTP ${tgRes.status}`;
            let tip = '';
            if (tgRes.status === 401 || errDesc.includes('Unauthorized')) {
                tip = '（请检查 Bot Token 是否正确，是否有空格）';
            } else if (errDesc.includes('chat not found')) {
                tip = '（请确认 Chat ID 是否正确，且你已在 TG 中先向该机器人发送过 /start 消息）';
            }

            return new Response(JSON.stringify({
                success: false,
                error: `Telegram 接口返回错误: ${errDesc} ${tip}`
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
        }
    } catch (err) {
        return new Response(JSON.stringify({
            success: false,
            error: `发送请求异常: ${err.message}`
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
    }
}
