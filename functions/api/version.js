// ============================================
// FlarePanel 版本比对接口 (Release-based)
// 比对当前版本与 GitHub Latest Release 的差异
// 具备 1 小时边缘缓存，防止频繁请求 GitHub API
// ============================================

const UPSTREAM_REPO = 'HenryYannis/FlarePanel';
const CURRENT_VERSION = 'v1.0.0';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

const CACHE_HEADERS = {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=1800, s-maxage=3600'
};

function parseSemver(v) {
    const m = String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.');
    return [parseInt(m[0], 10) || 0, parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0];
}

function compareSemver(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    for (let i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return 1;
        if (pa[i] < pb[i]) return -1;
    }
    return 0;
}

export async function onRequest(context) {
    const { request } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
        return new Response(JSON.stringify({ success: false, error: 'Method Not Allowed' }), {
            status: 405,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    const fallbackUrl = `https://github.com/${UPSTREAM_REPO}/releases`;

    try {
        const apiUrl = `https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`;
        const ghRes = await fetch(apiUrl, {
            headers: {
                'User-Agent': 'FlarePanel-Version-Check/1.0',
                'Accept': 'application/vnd.github.v3+json'
            },
            cf: { cacheTtl: 3600, cacheEverything: true }
        });

        if (!ghRes.ok) {
            // 仓库尚未发布任何 Release 时（404）或网络限流，默认当前为最新正式版
            return new Response(JSON.stringify({
                success: true,
                current: CURRENT_VERSION,
                latest: CURRENT_VERSION,
                status: 'latest',
                releaseUrl: fallbackUrl
            }), {
                status: 200,
                headers: CACHE_HEADERS
            });
        }

        const data = await ghRes.json();
        const latestTag = String(data.tag_name || '').trim() || CURRENT_VERSION;
        const hasUpdate = compareSemver(latestTag, CURRENT_VERSION) > 0;

        return new Response(JSON.stringify({
            success: true,
            current: CURRENT_VERSION,
            latest: latestTag,
            status: hasUpdate ? 'update' : 'latest',
            releaseUrl: data.html_url || fallbackUrl
        }), {
            status: 200,
            headers: CACHE_HEADERS
        });
    } catch (err) {
        return new Response(JSON.stringify({
            success: true,
            current: CURRENT_VERSION,
            latest: CURRENT_VERSION,
            status: 'latest',
            releaseUrl: fallbackUrl
        }), {
            status: 200,
            headers: CACHE_HEADERS
        });
    }
}
