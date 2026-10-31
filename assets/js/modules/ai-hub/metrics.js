// ====================================================
// 统一 AI 代理网关 - 监控大盘与用量分析模块 (Metrics Dashboard)
// 职责：拉取 D1 审计日志统计、走势图/分布图渲染、调用流水表格
// 规范：恪守 AGENTS.md（0 Emoji 铁律、D1 ai_logs 流水消费）
// ====================================================

import { getKvValue, fetchDatabases, queryDatabase } from '../../api.js';
import { formatTokens, escapeHtml } from '../../utils.js';
import { OFFICIAL_AI_GATEWAY_URL, AI_KV_NAMESPACE_ID, AI_LOGS_DB_NAME } from './presets.js';
import { getSiteByAiId, getSiteColorClass, sites } from '../../sites.js';
import { t, formatNumber } from '../../i18n.js';

let currentMetricsData = null;
let isMetricsLoading = false;

export function getCachedMetricsData() {
    return currentMetricsData;
}

export function isMetricsDataLoading() {
    return isMetricsLoading;
}

// 按 UTC+8 分天，和网关默认的 STATS_UTC_OFFSET_MINUTES = 480 一致
function buildDateList(days) {
    const now = Date.now();
    const list = [];
    for (let i = 0; i < days; i++) {
        list.push(new Date(now - i * 86400000 + 8 * 3600000).toISOString().split('T')[0]);
    }
    return list;
}

let cachedLogsDbId; // undefined = 还没找过；null = 没找到

// 找网关日志库：优先用 AI_HUB.logsDb 配置的库名；没配就在站点没用到的库里找有 ai_logs 表的那个
async function resolveLogsDbId() {
    if (cachedLogsDbId !== undefined) return cachedLogsDbId;
    const res = await fetchDatabases();
    const dbs = Array.isArray(res?.result) ? res.result : [];
    if (AI_LOGS_DB_NAME) {
        const found = dbs.find(db => db.name === AI_LOGS_DB_NAME);
        cachedLogsDbId = found ? found.uuid : null;
        return cachedLogsDbId;
    }
    const used = new Set();
    sites.forEach(site => { if (site.commentDb) used.add(site.commentDb); if (site.accountDb) used.add(site.accountDb); });
    cachedLogsDbId = null;
    for (const db of dbs.filter(d => !used.has(d.name))) {
        try {
            const r = await queryDatabase(db.uuid, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_logs'");
            if ((r.result?.[0]?.results || []).length) { cachedLogsDbId = db.uuid; break; }
        } catch (e) { /* 没权限或不是这个库，继续找 */ }
    }
    return cachedLogsDbId;
}

const rowsOf = (res) => res?.result?.[0]?.results || [];

// 字段和网关 GET /v1/stats 的 D1 分支一致
async function fetchMetricsFromD1(days) {
    const dbId = await resolveLogsDbId();
    if (!dbId) return null;
    const dateList = buildDateList(days);
    const minDate = dateList[dateList.length - 1];
    const [logsRes, dailyRes, provRes, siteRes] = await Promise.all([
        queryDatabase(dbId, `SELECT id, time, date, timestamp, site_name AS site, site_id AS siteId,
            client, COALESCE(user_name, user_id) AS user, provider_name AS provider, model, status,
            latency_ms AS latencyMs, tokens, prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
            fallback, error, page_path AS pagePath, tool_name AS toolName
          FROM ai_logs ORDER BY timestamp DESC LIMIT 50`),
        queryDatabase(dbId, `SELECT date, COUNT(*) AS total,
            SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS failed,
            SUM(fallback) AS fallbackCount, SUM(latency_ms) AS latencySumMs, SUM(tokens) AS totalTokens,
            SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens,
            SUM(CASE WHEN client = 'auth' THEN 1 ELSE 0 END) AS authRequests,
            SUM(CASE WHEN client = 'unauth' THEN 1 ELSE 0 END) AS unauthRequests
          FROM ai_logs WHERE date >= ? GROUP BY date`, [minDate]),
        queryDatabase(dbId, `SELECT provider_id, MAX(provider_name) AS provider_name, COUNT(*) AS requests,
            SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS failed, SUM(tokens) AS tokens
          FROM ai_logs WHERE date >= ? GROUP BY provider_id`, [minDate]),
        queryDatabase(dbId, `SELECT site_id, MAX(site_name) AS site_name, COUNT(*) AS requests,
            SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status < 200 OR status >= 300 THEN 1 ELSE 0 END) AS failed, SUM(tokens) AS tokens
          FROM ai_logs WHERE date >= ? GROUP BY site_id`, [minDate])
    ]);

    const providersTotal = {};
    rowsOf(provRes).forEach(r => {
        const pid = r.provider_id || 'unknown';
        providersTotal[pid] = { name: r.provider_name || pid, requests: r.requests || 0, success: r.success || 0, failed: r.failed || 0, tokens: r.tokens || 0 };
    });
    const sitesTotal = {};
    rowsOf(siteRes).forEach(r => {
        const sid = r.site_id || 'other';
        sitesTotal[sid] = { name: r.site_name || sid, requests: r.requests || 0, success: r.success || 0, failed: r.failed || 0, tokens: r.tokens || 0 };
    });
    const dailyMap = Object.fromEntries(rowsOf(dailyRes).map(r => [r.date, r]));
    const history = dateList.map(date => {
        const r = dailyMap[date] || {};
        const total = r.total || 0;
        return {
            date, total, success: r.success || 0, failed: r.failed || 0, fallbackCount: r.fallbackCount || 0,
            latencySumMs: r.latencySumMs || 0, totalTokens: r.totalTokens || 0,
            promptTokens: r.promptTokens || 0, completionTokens: r.completionTokens || 0,
            avgLatencyMs: total > 0 ? Math.round((r.latencySumMs || 0) / total) : 0,
            clientTypes: { master: total - (r.authRequests || 0) - (r.unauthRequests || 0), auth: r.authRequests || 0, unauth: r.unauthRequests || 0 }
        };
    });

    const sum = (k) => history.reduce((acc, d) => acc + (d[k] || 0), 0);
    const totalRequests = sum('total');
    const totalSuccess = sum('success');
    const today = history[0];
    return {
        status: 'success',
        source: 'd1',
        days,
        today,
        summary: {
            totalRequests,
            totalSuccess,
            totalFailed: sum('failed'),
            totalFallback: sum('fallbackCount'),
            totalTokens: sum('totalTokens'),
            todayTokens: today.totalTokens || 0,
            successRate: totalRequests > 0 ? ((totalSuccess / totalRequests) * 100).toFixed(1) : '100.0',
            avgLatencyMs: totalRequests > 0 ? Math.round(sum('latencySumMs') / totalRequests) : 0,
            providersBreakdown: providersTotal,
            sitesBreakdown: sitesTotal
        },
        history: history.reverse(),
        recentLogs: rowsOf(logsRes).map(r => ({ ...r, fallback: !!r.fallback }))
    };
}

/**
 * 获取网关度量监控统计（三通道：网关 /v1/stats 直出 → D1 ai_logs → Cloudflare KV 兜底）
 */
export async function fetchAiHubMetrics(days = 7, config = null) {
    isMetricsLoading = true;
    const endpoint = OFFICIAL_AI_GATEWAY_URL;
    const masterKey = config?.gateway?.masterKey;
    const statsUrl = endpoint.endsWith('/v1') ? `${endpoint}/stats?days=${days}` : `${endpoint}/v1/stats?days=${days}`;

    // 1. 优先尝试直连网关监控端点 (10秒超时，网关已启用 Promise.all 并发极速响应)
    try {
        const headers = {};
        if (masterKey) headers['Authorization'] = `Bearer ${masterKey}`;
        const res = await fetch(statsUrl, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
            const data = await res.json();
            if (data && data.status === 'success') {
                currentMetricsData = data;
                isMetricsLoading = false;
                return data;
            }
        }
    } catch (e) {
        console.warn('Gateway /v1/stats is unavailable; falling back to D1 / KV:', e.message);
    }

    // 2. 网关把日志写在 D1 的 ai_logs 时：用后台登录 Token 直接查 D1（不需要开发者密钥）
    try {
        const d1Data = await fetchMetricsFromD1(days);
        if (d1Data) {
            currentMetricsData = d1Data;
            isMetricsLoading = false;
            return d1Data;
        }
    } catch (e) {
        console.warn('Reading ai_logs from D1 failed; falling back to KV:', e.message);
    }

    // 3. 兜底方案：网关没绑 D1 时，直连 Cloudflare KV REST API (并发批量读取)
    try {
        const now = Date.now();
        const history = [];
        const providersTotal = {};
        const sitesTotal = {};
        let totalRequests = 0;
        let totalSuccess = 0;
        let totalFailed = 0;
        let totalFallback = 0;
        let totalLatencySum = 0;
        let totalTokens = 0;

        const dateList = [];
        for (let i = 0; i < days; i++) {
            const targetTs = now - i * 86400 * 1000;
            const d = new Date(targetTs + 8 * 3600 * 1000);
            const dateStr = d.toISOString().split('T')[0];
            dateList.push(dateStr);
        }

        const fetchedDailyList = await Promise.all(
            dateList.map(async (dateStr) => {
                try {
                    const rawJson = await getKvValue(AI_KV_NAMESPACE_ID, `STATS:DAILY:${dateStr}`);
                    return { dateStr, data: rawJson ? JSON.parse(rawJson) : null };
                } catch (err) {
                    return { dateStr, data: null };
                }
            })
        );

        for (const item of fetchedDailyList) {
            const dateStr = item.dateStr;
            let daily = item.data;
            if (!daily) {
                daily = {
                    date: dateStr,
                    total: 0,
                    success: 0,
                    failed: 0,
                    fallbackCount: 0,
                    latencySumMs: 0,
                    totalTokens: 0,
                    promptTokens: 0,
                    completionTokens: 0,
                    clientTypes: { master: 0, auth: 0, unauth: 0 },
                    providers: {},
                    models: {},
                    sites: {}
                };
            }

            totalRequests += daily.total || 0;
            totalSuccess += daily.success || 0;
            totalFailed += daily.failed || 0;
            totalFallback += daily.fallbackCount || 0;
            totalLatencySum += daily.latencySumMs || 0;
            totalTokens += daily.totalTokens || 0;

            if (daily.providers) {
                for (const [pid, pdata] of Object.entries(daily.providers)) {
                    if (!providersTotal[pid]) {
                        providersTotal[pid] = { name: pdata.name || pid, requests: 0, success: 0, failed: 0, tokens: 0 };
                    }
                    providersTotal[pid].requests += pdata.requests || 0;
                    providersTotal[pid].success += pdata.success || 0;
                    providersTotal[pid].failed += pdata.failed || 0;
                    providersTotal[pid].tokens = (providersTotal[pid].tokens || 0) + (pdata.tokens || 0);
                }
            }

            if (daily.sites) {
                for (const [sid, sdata] of Object.entries(daily.sites)) {
                    if (!sitesTotal[sid]) {
                        sitesTotal[sid] = { name: sdata.name || sid, requests: 0, success: 0, failed: 0, tokens: 0 };
                    }
                    sitesTotal[sid].requests += sdata.requests || 0;
                    sitesTotal[sid].success += sdata.success || 0;
                    sitesTotal[sid].failed += sdata.failed || 0;
                    sitesTotal[sid].tokens = (sitesTotal[sid].tokens || 0) + (sdata.tokens || 0);
                }
            }

            daily.avgLatencyMs = daily.total > 0 ? Math.round(daily.latencySumMs / daily.total) : 0;
            history.push(daily);
        }

        let recentLogs = [];
        try {
            const rawLogsJson = await getKvValue(AI_KV_NAMESPACE_ID, 'STATS:RECENT_LOGS');
            if (rawLogsJson) recentLogs = JSON.parse(rawLogsJson);
        } catch (err) {}

        const todayStats = history[0] || {};
        const avgLatencyOverall = totalRequests > 0 ? Math.round(totalLatencySum / totalRequests) : 0;
        const successRate = totalRequests > 0 ? ((totalSuccess / totalRequests) * 100).toFixed(1) : "100.0";

        currentMetricsData = {
            status: 'success',
            days,
            today: todayStats,
            summary: {
                totalRequests,
                totalSuccess,
                totalFailed,
                totalFallback,
                totalTokens,
                todayTokens: todayStats.totalTokens || 0,
                successRate,
                avgLatencyMs: avgLatencyOverall,
                providersBreakdown: providersTotal,
                sitesBreakdown: sitesTotal
            },
            history: history.reverse(),
            recentLogs
        };
        isMetricsLoading = false;
        return currentMetricsData;
    } catch (kvErr) {
        console.error('Failed to read monitoring stats from KV:', kvErr);
        isMetricsLoading = false;
        return null;
    }
}

/**
 * 通用纯 CSS 垂直竖立柱状图生成器
 */
export function renderVerticalBarChart({ items, maxVal, emptyText = t('metrics.noData'), isDense = false }) {
    if (!items || items.length === 0) {
        return `<div class="empty-state" style="padding: 45px 0; font-size: 12px; color: var(--text-secondary);">${escapeHtml(emptyText)}</div>`;
    }
    const max = Math.max(maxVal || 1, 1);
    return `
    <div class="ai-trend-chart-container ${isDense ? 'dense' : ''}">
        ${items.map(item => {
            const val = item.value || 0;
            const barHeightPct = Math.round((val / max) * 100);
            const displayHeight = val > 0 ? Math.max(barHeightPct, 6) : 2;
            // 标签、提示文字都可能来自外部请求（站点名、服务商名），一律转义后再拼进页面
            const safeLabel = escapeHtml(item.label || '');
            const tooltipLines = Array.isArray(item.tooltipLines) ? item.tooltipLines : [t('metrics.barTooltip', { label: item.fullLabel || item.label || '', count: formatNumber(val) })];
            const tooltipHtml = tooltipLines.map(line => escapeHtml(line)).join('<br>');
            const colorClass = item.colorClass || '';
            const plainTitle = escapeHtml(tooltipLines.join(' | '));
            return `
            <div class="ai-trend-col" title="${plainTitle}">
                <div class="ai-trend-tooltip">${tooltipHtml}</div>
                <div class="ai-trend-bar-wrap">
                    <div class="ai-trend-bar ${colorClass}" style="height: ${displayHeight}%;"></div>
                </div>
                <div class="ai-trend-date" title="${plainTitle}">${safeLabel}</div>
            </div>
            `;
        }).join('')}
    </div>
    `;
}

/**
 * 渲染「运行监控」子栏目内容
 */
export function renderMetricsTabHtml(data, currentMetricsDays = 7) {
    const today = data?.today || { total: 0, success: 0, failed: 0, fallbackCount: 0, totalTokens: 0 };
    const summary = data?.summary || {
        totalRequests: 0,
        totalSuccess: 0,
        totalFailed: 0,
        totalFallback: 0,
        totalTokens: 0,
        successRate: '100.0',
        avgLatencyMs: 0,
        providersBreakdown: {},
        sitesBreakdown: {}
    };
    const history = data?.history || [];
    const recentLogs = data?.recentLogs || [];

    // 统计当前周期（7天或30天）峰值
    let peakDay = '-';
    let peakCount = 0;
    history.forEach(h => {
        if ((h.total || 0) > peakCount) {
            peakCount = h.total || 0;
            peakDay = h.date ? h.date.slice(5) : '-';
        }
    });
    const peakText = peakCount > 0 ? escapeHtml(t('metrics.peak', { day: peakDay, count: formatNumber(peakCount) })) : '-';

    // 1. 调用走势图数据 (支持 7天 / 30天 密集柱状模式)
    const is30Days = currentMetricsDays === 30;
    const chartItems = history.map((h, idx) => {
        const hTotal = h.total || 0;
        const dateShort = h.date ? h.date.slice(5) : '';
        let label = dateShort;
        if (is30Days) {
            // 30天模式每隔4天显示一次日期刻度，其余空出防重叠
            label = (idx % 4 === 0 || idx === history.length - 1) ? dateShort : '';
        }
        return {
            value: hTotal,
            label,
            fullLabel: h.date || '',
            tooltipLines: [String(h.date || ''), t('metrics.totalRequests', { count: formatNumber(hTotal) }), t('metrics.successFailed', { success: formatNumber(h.success || 0), failed: formatNumber(h.failed || 0) }), t('metrics.avgLatency', { ms: h.avgLatencyMs || 0 })]
        };
    });
    const maxHistoryVal = Math.max(...history.map(h => h.total || 0), 10);
    const chartHtml = renderVerticalBarChart({
        items: chartItems,
        maxVal: maxHistoryVal,
        emptyText: t('metrics.noHistory'),
        isDense: is30Days
    });

    // 2. 来源站点调用分布 (统一垂直竖立柱状图)
    const sb = summary.sitesBreakdown || {};
    const siteEntries = Object.entries(sb).sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0));
    const totalRequestsAll = summary.totalRequests || 1;

    const sitesItems = siteEntries.slice(0, 6).map(([sid, sinfo]) => {
        const reqs = sinfo.requests || 0;
        const pct = Math.round((reqs / totalRequestsAll) * 100);
        let colorClass = '';
        const sidLower = String(sid).toLowerCase();
        const sNameLower = String(sinfo.name || '').toLowerCase();
        const matched = getSiteByAiId(sid);
        if (matched) {
            colorClass = getSiteColorClass(matched.index);
        } else if (sidLower.includes('admin') || sNameLower.includes('后台')) {
            colorClass = 'admin';
        } else if (sidLower.includes('dev') || sNameLower.includes('开发') || sidLower.startsWith('key_')) {
            colorClass = 'dev';
        }
        let shortName = sinfo.name || sid;
        if (shortName.length > 5) shortName = shortName.slice(0, 5) + '..';
        return {
            value: reqs,
            label: shortName,
            fullLabel: sinfo.name || sid,
            tooltipLines: [String(sinfo.name || sid), t('metrics.calls', { count: formatNumber(reqs) }), t('metrics.share', { pct })],
            colorClass
        };
    });
    const maxSiteVal = Math.max(...sitesItems.map(i => i.value), 10);
    const sitesDistHtml = renderVerticalBarChart({
        items: sitesItems,
        maxVal: maxSiteVal,
        emptyText: t('metrics.noSites')
    });

    // 3. 模型服务商分布 (统一垂直竖立柱状图)
    const pb = summary.providersBreakdown || {};
    const providerEntries = Object.entries(pb).sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0));

    const providersItems = providerEntries.slice(0, 6).map(([pid, pinfo]) => {
        const reqs = pinfo.requests || 0;
        const pct = Math.round((reqs / totalRequestsAll) * 100);
        let shortName = pinfo.name || pid;
        if (shortName.length > 5) shortName = shortName.slice(0, 5) + '..';
        return {
            value: reqs,
            label: shortName,
            fullLabel: pinfo.name || pid,
            tooltipLines: [String(pinfo.name || pid), t('metrics.providerCalls', { count: formatNumber(reqs) }), t('metrics.loadShare', { pct })],
            colorClass: 'provider'
        };
    });
    const maxProviderVal = Math.max(...providersItems.map(i => i.value), 10);
    const providersDistHtml = renderVerticalBarChart({
        items: providersItems,
        maxVal: maxProviderVal,
        emptyText: t('metrics.noProviders')
    });

    // 实时流水表格
    let logsRowsHtml = '';
    if (recentLogs.length === 0) {
        logsRowsHtml = `
        <tr>
            <td colspan="9" style="text-align: center; color: var(--text-secondary); padding: 36px 16px; font-size: 13px;">
                ${t('metrics.noLogs')}
            </td>
        </tr>
        `;
    } else {
        logsRowsHtml = recentLogs.map(log => {
            let siteBadge = `<span class="ai-site-badge other">${escapeHtml(log.site || t('metrics.siteOther'))}</span>`;
            let siteClass = 'other';
            let siteDomain = '';
            const sId = String(log.siteId || '').toLowerCase();
            const sName = String(log.site || '').toLowerCase();
            const matchedSite = getSiteByAiId(log.siteId);
            if (matchedSite) {
                siteClass = getSiteColorClass(matchedSite.index);
                siteBadge = `<span class="ai-site-badge ${siteClass}">${escapeHtml(matchedSite.site.name)}</span>`;
                siteDomain = (matchedSite.site.url || '').replace(/\/+$/, '');
            } else if (sId.includes('admin') || sName.includes('后台')) {
                siteBadge = `<span class="ai-site-badge admin">${t('metrics.siteAdmin')}</span>`;
                siteClass = 'admin';
                siteDomain = location.origin;
            } else if (sId.startsWith('key_') || sId.includes('dev') || sName.includes('开发') || sName.includes('master')) {
                siteBadge = `<span class="ai-site-badge dev">${escapeHtml(log.site || t('metrics.siteDev'))}</span>`;
                siteClass = 'dev';
            } else if (sId.includes('local') || sName.includes('本地')) {
                siteBadge = `<span class="ai-site-badge local">${t('metrics.siteLocal')}</span>`;
                siteClass = 'local';
            }

            // 调用页面路径（仿照评论区：显示路径文本，点击在新标签页打开目标页面）
            let rawPath = log.pagePath || '';
            let pageHtml = '<span style="color: var(--text-secondary);">-</span>';
            if (rawPath) {
                if (rawPath.startsWith('/')) {
                    const safePath = escapeHtml(rawPath);
                    if (siteDomain) {
                        // 页面路径由站点前端上报，可能被伪造，拼链接前必须转义
                        const safeUrl = escapeHtml(siteDomain + rawPath);
                        pageHtml = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color: var(--primary-color); text-decoration: none; font-family: var(--font-mono, monospace); font-size: 12px; font-weight: 500;" title="${escapeHtml(t('metrics.openNewTabUrl', { url: siteDomain + rawPath }))}">${safePath}</a>`;
                    } else {
                        pageHtml = `<code style="font-family: var(--font-mono, monospace); font-size: 12px;">${safePath}</code>`;
                    }
                } else {
                    pageHtml = `<span style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(rawPath)}</span>`;
                }
            }

            let clientBadge = `<span class="ai-client-badge unauth">${t('metrics.clientAnon')}</span>`;
            if (log.client === 'master') {
                clientBadge = `<span class="ai-client-badge master">${t('metrics.clientMaster')}</span>`;
            } else if (log.client === 'auth') {
                const userText = escapeHtml(log.user || t('metrics.clientAuthDefault'));
                clientBadge = `<span class="ai-client-badge auth site-${siteClass}" title="${escapeHtml(t('metrics.userTitle', { user: log.user || t('metrics.clientAuthDefault') }))}">${userText}</span>`;
            } else if (log.client && log.client !== 'unauth') {
                clientBadge = `<span class="ai-client-badge master" title="${escapeHtml(log.client)}">${escapeHtml(log.client)}</span>`;
            }

            let statusBadge = '';
            if (log.status >= 200 && log.status < 300) {
                if (log.fallback) {
                    const fbNote = log.error ? escapeHtml(log.error) : '';
                    statusBadge = `<span class="ai-status-badge fallback"${fbNote ? ` title="${fbNote}"` : ''}>${escapeHtml(t('metrics.statusFallback', { status: log.status }))}</span>`;
                    if (fbNote) {
                        statusBadge += `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px; max-width: 260px; white-space: normal; line-height: 1.4;">${fbNote}</div>`;
                    }
                } else {
                    statusBadge = `<span class="ai-status-badge success">${escapeHtml(t('metrics.statusOk', { status: log.status }))}</span>`;
                }
            } else {
                const safeErr = escapeHtml(log.error || '');
                statusBadge = `<span class="ai-status-badge error" title="${safeErr}">${escapeHtml(t('metrics.statusError', { status: log.status }))}</span>`;
                if (safeErr) {
                    statusBadge += `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px; max-width: 260px; white-space: normal; line-height: 1.4;">${safeErr}</div>`;
                }
            }

            const timeStr = escapeHtml(log.date ? `${String(log.date).slice(5)} ${log.time || ''}` : (log.time || '-'));
            const tokenCount = log.tokens || 0;
            const tokenTag = `<span class="ai-token-tag" title="${escapeHtml(t('metrics.tokenTitle', { prompt: Number(log.promptTokens) || 0, completion: Number(log.completionTokens) || 0 }))}">${escapeHtml(formatTokens(Number(tokenCount) || 0))}</span>`;

            return `
            <tr>
                <td style="font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary);">${timeStr}</td>
                <td>${siteBadge}</td>
                <td>${pageHtml}</td>
                <td>${clientBadge}</td>
                <td style="font-weight: 500;">${escapeHtml(log.provider || t('metrics.unknownProvider'))}</td>
                <td><code style="font-size: 12px; font-weight: 600;">${escapeHtml(log.model || '-')}</code></td>
                <td>${tokenTag}</td>
                <td style="font-family: var(--font-mono); font-size: 12px;">${Number(log.latencyMs) || 0} ms</td>
                <td>${statusBadge}</td>
            </tr>
            `;
        }).join('');
    }

    return `
    <div class="ai-metrics-cards-grid">
        <div class="ai-metric-card">
            <div class="ai-metric-label">${t('metrics.todayTokens')}</div>
            <div class="ai-metric-value" id="metric-today-tokens">${formatTokens(today.totalTokens || 0)}</div>
            <div class="ai-metric-sub">
                <span>${t('metrics.tokens7d', { count: formatTokens(summary.totalTokens || 0) })}</span>
            </div>
        </div>

        <div class="ai-metric-card">
            <div class="ai-metric-label">${t('metrics.successRate')}</div>
            <div class="ai-metric-value" id="metric-success-rate">${escapeHtml(summary.successRate)}%</div>
            <div class="ai-metric-sub">
                <span class="ai-metric-tag normal">${escapeHtml(t('metrics.todayCount', { count: formatNumber(today.total || 0) }))}</span>
                <span class="ai-metric-tag ${today.failed > 0 ? 'error' : 'normal'}">${today.failed > 0 ? escapeHtml(t('metrics.failedN', { count: formatNumber(today.failed) })) : escapeHtml(t('metrics.successN', { count: formatNumber(today.success || 0) }))}</span>
                <span style="font-size: 11px; color: var(--text-secondary);">${escapeHtml(t('metrics.requests7d', { count: formatNumber(summary.totalRequests || 0) }))}</span>
            </div>
        </div>

        <div class="ai-metric-card">
            <div class="ai-metric-label">${t('metrics.fallbackFreq')}</div>
            <div class="ai-metric-value" id="metric-fallback-count">${escapeHtml(today.fallbackCount || 0)}</div>
            <div class="ai-metric-sub">
                <span class="ai-metric-tag ${today.fallbackCount > 0 ? 'warning' : 'normal'}">${escapeHtml(t('metrics.fallback7d', { count: formatNumber(summary.totalFallback || 0) }))}</span>
            </div>
        </div>

        <div class="ai-metric-card">
            <div class="ai-metric-label">${t('metrics.avgLatencyTitle')}</div>
            <div class="ai-metric-value" id="metric-avg-latency">${escapeHtml(summary.avgLatencyMs)} ms</div>
            <div class="ai-metric-sub">
                <span>${t('metrics.avgLatencyDesc')}</span>
            </div>
        </div>
    </div>

    <div class="ai-grid-3" style="margin-top: 20px;">
        <div class="ai-card" style="display: flex; flex-direction: column; justify-content: space-between;">
            <div>
                <div class="ai-card-header-flex">
                    <h3 class="ai-card-title" style="margin: 0;">${t('metrics.trendTitle')}</h3>
                    <div class="ai-trend-switcher capsule-tabs capsule-tabs--sm" data-capsule-tabs="ai-trend-days">
                        <button type="button" class="ai-trend-switch-btn ${currentMetricsDays === 7 ? 'active' : ''}" data-days="7">${t('metrics.days', { days: 7 })}</button>
                        <button type="button" class="ai-trend-switch-btn ${currentMetricsDays === 30 ? 'active' : ''}" data-days="30">${t('metrics.days', { days: 30 })}</button>
                    </div>
                </div>
                ${chartHtml}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--border-color); font-size: 11.5px; color: var(--text-secondary);">
                <span>${t('metrics.daysTotal', { days: currentMetricsDays, count: escapeHtml(formatNumber(summary.totalRequests || 0)) })}</span>
                <span>${t('metrics.dayPeak', { peak: peakText })}</span>
            </div>
        </div>

        <div class="ai-card" style="display: flex; flex-direction: column; justify-content: space-between;">
            <div>
                <div class="ai-card-header-flex">
                    <h3 class="ai-card-title" style="margin: 0;">${t('metrics.sitesTitle')}</h3>
                    <span class="ai-card-sub-info">${t('metrics.sitesSub')}</span>
                </div>
                ${sitesDistHtml}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--border-color); font-size: 11.5px; color: var(--text-secondary);">
                <span>${t('metrics.channels', { count: siteEntries.length })}</span>
                <span>${t('metrics.topSite', { name: escapeHtml(siteEntries[0]?.[1]?.name || siteEntries[0]?.[0] || '-') })}</span>
            </div>
        </div>

        <div class="ai-card" style="display: flex; flex-direction: column; justify-content: space-between;">
            <div>
                <div class="ai-card-header-flex">
                    <h3 class="ai-card-title" style="margin: 0;">${t('metrics.providersTitle')}</h3>
                    <span class="ai-card-sub-info">${t('metrics.providersSub')}</span>
                </div>
                ${providersDistHtml}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--border-color); font-size: 11.5px; color: var(--text-secondary);">
                <span>${t('metrics.upstreams', { count: providerEntries.length })}</span>
                <span>${t('metrics.topProvider', { name: escapeHtml(providerEntries[0]?.[1]?.name || providerEntries[0]?.[0] || '-') })}</span>
            </div>
        </div>
    </div>

    <div class="ai-card" style="margin-top: 20px;">
        <div class="ai-card-header-flex">
            <div>
                <h3 class="ai-card-title" style="margin-bottom: 2px;">${t('metrics.logsTitle')}</h3>
                <p style="font-size: 12px; color: var(--text-secondary); margin: 0;">${t('metrics.logsDesc')}</p>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="btn btn-outline btn-sm" id="ai-refresh-metrics-btn">${t('metrics.refresh')}</button>
            </div>
        </div>

        <div class="table-responsive" style="margin-top: 14px; max-height: 400px; overflow-y: auto;">
            <table class="ai-table" id="ai-recent-logs-table">
                <thead>
                    <tr>
                        <th>${t('common.time')}</th>
                        <th>${t('metrics.colSite')}</th>
                        <th>${t('metrics.colPage')}</th>
                        <th>${t('metrics.colClient')}</th>
                        <th>${t('metrics.colProvider')}</th>
                        <th>${t('metrics.colModel')}</th>
                        <th>Tokens</th>
                        <th>${t('metrics.colLatency')}</th>
                        <th>${t('metrics.colStatus')}</th>
                    </tr>
                </thead>
                <tbody id="ai-recent-logs-tbody">
                    ${logsRowsHtml}
                </tbody>
            </table>
        </div>
    </div>
    `;
}
