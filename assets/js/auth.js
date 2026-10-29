import { setCredentials, fetchDatabases } from './api.js';
import { t } from './i18n.js';

export async function connectD1(accountId, apiToken) {
    if (!accountId || !apiToken) {
        throw new Error(t('auth.missingFields'));
    }

    setCredentials(accountId, apiToken);

    // 尝试获取数据库列表以验证凭证
    const data = await fetchDatabases();
    
    // 验证成功，保存至本地存储
    localStorage.setItem('cf_account_id', accountId);
    localStorage.setItem('cf_api_token', apiToken);

    return data.result;
}

export function loadSavedCredentials() {
    const savedAccountId = localStorage.getItem('cf_account_id');
    const savedApiToken = localStorage.getItem('cf_api_token');
    if (savedAccountId && savedApiToken) {
        return { accountId: savedAccountId, apiToken: savedApiToken };
    }
    return null;
}

export function logout() {
    localStorage.removeItem('cf_account_id');
    localStorage.removeItem('cf_api_token');
    // 大文件上传用的 R2 S3 密钥也只该在登录会话里；退出时一并清掉
    localStorage.removeItem('cf_s3_credentials');
    location.reload();
}
