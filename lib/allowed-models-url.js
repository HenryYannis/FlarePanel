/**
 * /api/fetch-models 用的上游 URL 白名单规则。
 * 只允许 https 公网 DNS 主机名，降低已登录管理员被利用做 SSRF 的面。
 */
export function isAllowedModelsBaseUrl(raw) {
    let parsed;
    try {
        parsed = new URL(String(raw).trim());
    } catch (e) {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== '443') return false;

    const host = parsed.hostname || '';
    if (!host || host.length > 253) return false;

    // URL 解析后的 IPv6 不带方括号，但仍含冒号；IPv4 / 十进制整型 IP 一律拒绝
    if (host.includes(':')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    if (/^\d+$/.test(host)) return false;
    // 0x7f000001 一类十六进制主机名
    if (/^0x[0-9a-f]+$/i.test(host)) return false;

    // 至少两段的 DNS 主机名（api.example.com）；拒绝单标签如 localhost
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) {
        return false;
    }

    const lower = host.toLowerCase();
    if (
        lower === 'localhost' ||
        lower.endsWith('.localhost') ||
        lower.endsWith('.local') ||
        lower.endsWith('.internal') ||
        lower.endsWith('.lan') ||
        lower.endsWith('.home') ||
        lower.endsWith('.corp') ||
        lower === 'metadata.google.internal' ||
        lower.endsWith('.metadata.google.internal')
    ) {
        return false;
    }

    return true;
}
