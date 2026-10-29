// ============================================
// Pages Functions 的错误信息（中文 / English）
// 按请求头 Accept-Language 选择语言：zh-Hant / zh-TW / zh-HK / zh-MO 用繁体，其他 zh 开头用简体，其余用英文。
// 后台前端会按界面语言发送 Accept-Language，所以错误信息跟界面语言一致。
// 每条响应同时带 code，方便调用方自行翻译。
// ============================================

const MESSAGES = {
    NOT_CONFIGURED: {
        zh: '服务端未配置：请在 Pages 环境变量里设置 CF_ACCOUNT_ID',
        'zh-Hant': '服務端未配置：請在 Pages 環境變數裡設定 CF_ACCOUNT_ID',
        en: 'Server not configured: set CF_ACCOUNT_ID in the Pages environment variables'
    },
    UNAUTHORIZED: {
        zh: '未授权访问：请先登录管理后台',
        'zh-Hant': '未授權訪問：請先登入管理後臺',
        en: 'Unauthorized: please sign in to the admin panel first'
    },
    FORBIDDEN_TOKEN: {
        zh: '未授权访问：Token 无效或没有本账号的权限',
        'zh-Hant': '未授權訪問：Token 無效或沒有本帳號的許可權',
        en: 'Forbidden: the token is invalid or has no permission on this account'
    },
    FORBIDDEN_ACCOUNT: {
        zh: '禁止访问：只能管理本面板配置的 Cloudflare 账号',
        'zh-Hant': '禁止訪問：只能管理本面板配置的 Cloudflare 帳號',
        en: 'Forbidden: only the Cloudflare account configured for this panel can be managed'
    },
    FORBIDDEN_PATH: {
        zh: '禁止访问：不允许代理这个接口路径',
        'zh-Hant': '禁止訪問：不允許代理這個介面路徑',
        en: 'Forbidden: this API path is not allowed through the proxy'
    },
    METHOD_NOT_ALLOWED: {
        zh: '不支持的请求方法',
        'zh-Hant': '不支援的請求方法',
        en: 'Method not allowed'
    },
    PROXY_ERROR: {
        zh: '代理请求失败：{msg}',
        'zh-Hant': '代理請求失敗：{msg}',
        en: 'Proxy error: {msg}'
    },
    S3_NOT_CONFIGURED: {
        zh: 'Pages 环境变量尚未生效或未配置 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY',
        'zh-Hant': 'Pages 環境變數尚未生效或未配置 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY',
        en: 'R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set in the Pages environment variables (or not active yet)'
    },
    TG_MISSING_FIELDS: {
        zh: '请先填写 Telegram Bot Token 和 Chat ID',
        'zh-Hant': '請先填寫 Telegram Bot Token 和 Chat ID',
        en: 'Please fill in the Telegram Bot Token and Chat ID first'
    },
    TG_SENT: {
        zh: 'Telegram 测试消息已发出，请查看 Telegram 客户端',
        'zh-Hant': 'Telegram 測試訊息已發出，請檢視 Telegram 客戶端',
        en: 'Telegram test message sent. Please check your Telegram client.'
    },
    TG_API_ERROR: {
        zh: 'Telegram 接口返回错误：{msg}',
        'zh-Hant': 'Telegram 介面返回錯誤：{msg}',
        en: 'Telegram API error: {msg}'
    },
    TG_TIP_TOKEN: {
        zh: '（请检查 Bot Token 是否正确，是否有空格）',
        'zh-Hant': '（請檢查 Bot Token 是否正確，是否有空格）',
        en: ' (check that the Bot Token is correct and has no spaces)'
    },
    TG_TIP_CHAT: {
        zh: '（请确认 Chat ID 正确，且已在 Telegram 里先向机器人发送过 /start）',
        'zh-Hant': '（請確認 Chat ID 正確，且已在 Telegram 裡先向機器人傳送過 /start）',
        en: ' (check the Chat ID, and make sure you have sent /start to the bot in Telegram)'
    },
    REQUEST_FAILED: {
        zh: '发送请求异常：{msg}',
        'zh-Hant': '傳送請求異常：{msg}',
        en: 'Request failed: {msg}'
    },
    MODELS_NO_BASE_URL: {
        zh: '请提供服务商 API Base URL',
        'zh-Hant': '請提供服務商 API Base URL',
        en: 'Please provide the provider API Base URL'
    },
    MODELS_BAD_BASE_URL: {
        zh: 'API Base URL 必须是 https 公网地址',
        'zh-Hant': 'API Base URL 必須是 https 公網地址',
        en: 'The API Base URL must be a public https address'
    },
    MODELS_NOT_JSON: {
        zh: '服务商返回了非 JSON 格式响应 (HTTP {status})：{body}',
        'zh-Hant': '服務商返回了非 JSON 格式響應 (HTTP {status})：{body}',
        en: 'The provider returned a non-JSON response (HTTP {status}): {body}'
    },
    MODELS_FETCH_FAILED: {
        zh: '拉取失败 ({status})：{msg}',
        'zh-Hant': '拉取失敗 ({status})：{msg}',
        en: 'Fetch failed ({status}): {msg}'
    },
    MODELS_NETWORK: {
        zh: '网络异常或无法访问该地址：{msg}',
        'zh-Hant': '網路異常或無法訪問該地址：{msg}',
        en: 'Network error or the address is unreachable: {msg}'
    }
};

/** 请求方想要的语言：'zh'、'zh-Hant' 或 'en' */
export function requestLang(request) {
    const al = (request?.headers?.get('Accept-Language') || '').trim().toLowerCase();
    if (/^zh-(hant|tw|hk|mo)/.test(al)) return 'zh-Hant';
    return al.startsWith('zh') ? 'zh' : 'en';
}

/** 取一条错误信息，{name} 用 params 替换 */
export function serverMsg(request, code, params = {}) {
    const entry = MESSAGES[code];
    if (!entry) return code;
    const text = entry[requestLang(request)] || entry.en;
    return text.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}
