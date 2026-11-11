// ============================================
// FlarePanel 版本比对接口 (Commit-based)
// 比对当前部署的 Commit 与上游主仓库的差异
// 具备 1 小时边缘缓存，防止频繁请求 GitHub API
// ============================================

const UPSTREAM_REPO = 'HenryYannis/FlarePanel';
const FALLBACK_COMMIT = 'e946778'; // 本地开发或未注入环境变量时的兜底 Commit

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

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
        return new Response(JSON.stringify({ success: false, error: 'Method Not Allowed' }), {
            status: 405,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
        });
    }

    // Cloudflare Pages 部署时会自动注入 CF_PAGES_COMMIT_SHA
    const rawCommit = (env && env.CF_PAGES_COMMIT_SHA) ? env.CF_PAGES_COMMIT_SHA : FALLBACK_COMMIT;
    const currentCommit = String(rawCommit).trim();
    const shortCurrent = currentCommit.slice(0, 7);

    try {
        const compareUrl = `https://api.github.com/repos/${UPSTREAM_REPO}/compare/${currentCommit}...main`;
        const ghRes = await fetch(compareUrl, {
            headers: {
                'User-Agent': 'FlarePanel-Version-Check/1.0',
                'Accept': 'application/vnd.github.v3+json'
            },
            cf: { cacheTtl: 3600, cacheEverything: true }
        });

        if (!ghRes.ok) {
            // 若 404（本地自定义 commit 或分支不同）或 403（限流），优雅降级
            return new Response(JSON.stringify({
                success: true,
                current: shortCurrent,
                status: 'unknown',
                behindBy: 0,
                compareUrl: `https://github.com/${UPSTREAM_REPO}/commits/main`
            }), {
                status: 200,
                headers: CACHE_HEADERS
            });
        }

        const data = await ghRes.json();
        return new Response(JSON.stringify({
            success: true,
            current: shortCurrent,
            status: data.status, // "identical" | "behind" | "ahead" | "diverged"
            behindBy: data.behind_by || 0,
            aheadBy: data.ahead_by || 0,
            compareUrl: data.html_url || `https://github.com/${UPSTREAM_REPO}/compare/${shortCurrent}...main`
        }), {
            status: 200,
            headers: CACHE_HEADERS
        });
    } catch (err) {
        return new Response(JSON.stringify({
            success: true,
            current: shortCurrent,
            status: 'unknown',
            behindBy: 0,
            compareUrl: `https://github.com/${UPSTREAM_REPO}/commits/main`
        }), {
            status: 200,
            headers: CACHE_HEADERS
        });
    }
}
