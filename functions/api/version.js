// ============================================
// FlarePanel 版本比对接口 (Commit-based)
// 比对当前部署的 Commit 与上游主仓库的差异
// 具备 1 小时边缘缓存，防止频繁请求 GitHub API
// ============================================

const UPSTREAM_REPO = 'HenryYannis/FlarePanel';
const FALLBACK_COMMIT = 'a60c538'; // 当前发布版本的官方上游 Commit 锚点

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
        let queryCommit = currentCommit;
        let compareUrl = `https://api.github.com/repos/${UPSTREAM_REPO}/compare/${queryCommit}...main`;
        let ghRes = await fetch(compareUrl, {
            headers: {
                'User-Agent': 'FlarePanel-Version-Check/1.0',
                'Accept': 'application/vnd.github.v3+json'
            },
            cf: { cacheTtl: 3600, cacheEverything: true }
        });

        // 若 404（下游私有仓/合并提交在官方上游不存在），回退到当前版本对应的官方上游锚点对比
        if (!ghRes.ok && ghRes.status === 404 && queryCommit !== FALLBACK_COMMIT) {
            queryCommit = FALLBACK_COMMIT;
            compareUrl = `https://api.github.com/repos/${UPSTREAM_REPO}/compare/${queryCommit}...main`;
            ghRes = await fetch(compareUrl, {
                headers: {
                    'User-Agent': 'FlarePanel-Version-Check/1.0',
                    'Accept': 'application/vnd.github.v3+json'
                },
                cf: { cacheTtl: 3600, cacheEverything: true }
            });
        }

        if (!ghRes.ok) {
            return new Response(JSON.stringify({
                success: true,
                current: shortCurrent,
                status: 'latest',
                behindBy: 0,
                aheadBy: 0,
                compareUrl: `https://github.com/${UPSTREAM_REPO}/commits/main`
            }), {
                status: 200,
                headers: CACHE_HEADERS
            });
        }

        const data = await ghRes.json();
        let mappedStatus = 'latest';
        let behindCount = 0;
        let aheadCount = 0;

        if (data.status === 'identical') {
            mappedStatus = 'latest';
        } else if (data.status === 'ahead' || (data.ahead_by > 0 && !data.behind_by)) {
            if (data.ahead_by > 1) {
                mappedStatus = 'behind';
                behindCount = data.ahead_by;
            } else {
                mappedStatus = 'latest';
            }
        } else if (data.status === 'behind' || (data.behind_by > 0 && !data.ahead_by)) {
            mappedStatus = 'ahead';
            aheadCount = data.behind_by || 0;
        } else if (data.status === 'diverged') {
            if (data.ahead_by > 1) {
                mappedStatus = 'behind';
                behindCount = data.ahead_by;
            } else {
                mappedStatus = 'latest';
            }
        }

        return new Response(JSON.stringify({
            success: true,
            current: shortCurrent,
            status: mappedStatus,
            behindBy: behindCount,
            aheadBy: aheadCount,
            compareUrl: data.html_url || `https://github.com/${UPSTREAM_REPO}/compare/${shortCurrent}...main`
        }), {
            status: 200,
            headers: CACHE_HEADERS
        });
    } catch (err) {
        return new Response(JSON.stringify({
            success: true,
            current: shortCurrent,
            status: 'latest',
            behindBy: 0,
            aheadBy: 0,
            compareUrl: `https://github.com/${UPSTREAM_REPO}/commits/main`
        }), {
            status: 200,
            headers: CACHE_HEADERS
        });
    }
}
