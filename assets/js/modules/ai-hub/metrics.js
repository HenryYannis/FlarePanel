// ====================================================
// 统一 AI 代理网关 - 监控大盘与用量分析模块 (Metrics Dashboard)
// 职责：拉取 D1 审计日志统计、走势图/分布图渲染、调用流水表格
// 规范：恪守 AGENTS.md（0 Emoji 铁律、D1 ai_logs 流水消费）
// ====================================================

import { getKvValue } from '../../api.js';
import { formatTokens, escapeHtml } from '../../utils.js';
import { OFFICIAL_AI_GATEWAY_URL, AI_KV_NAMESPACE_ID } from './presets.js';
import { getSiteByAiId, getSiteColorClass } from '../../sites.js';

let currentMetricsData = null;
let isMetricsLoading = false;

export function getCachedMetricsData() {
    return currentMetricsData;
}

export function isMetricsDataLoading() {
    return isMetricsLoading;
}

/**
 * 获取网关度量监控统计（双通道：网关 /v1/stats 直出 + Cloudflare KV 兜底）
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
        console.warn('网关 /v1/stats 端点暂未就绪或受限，已自动无缝切换直读 Cloudflare KV 命名空间:', e.message);
    }

    // 2. 兜底方案：直连 Cloudflare KV REST API (并发批量读取)
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
        console.error('直读 KV 监控统计失败:', kvErr);
        isMetricsLoading = false;
        return null;
    }
}

/**
 * 通用纯 CSS 垂直竖立柱状图生成器
 */
export function renderVerticalBarChart({ items, maxVal, emptyText = '暂无统计数据', isDense = false }) {
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
            const tooltipLines = Array.isArray(item.tooltipLines) ? item.tooltipLines : [`${item.fullLabel || item.label || ''}: ${val} 次`];
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
    const peakText = peakCount > 0 ? escapeHtml(`${peakDay} (${peakCount}次)`) : '-';

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
            tooltipLines: [String(h.date || ''), `总请求: ${hTotal} 次`, `成功: ${h.success || 0} | 失败: ${h.failed || 0}`, `平均延迟: ${h.avgLatencyMs || 0} ms`]
        };
    });
    const maxHistoryVal = Math.max(...history.map(h => h.total || 0), 10);
    const chartHtml = renderVerticalBarChart({
        items: chartItems,
        maxVal: maxHistoryVal,
        emptyText: '暂无历史走势记录',
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
            tooltipLines: [String(sinfo.name || sid), `调用次数: ${reqs} 次`, `占比: ${pct}%`],
            colorClass
        };
    });
    const maxSiteVal = Math.max(...sitesItems.map(i => i.value), 10);
    const sitesDistHtml = renderVerticalBarChart({
        items: sitesItems,
        maxVal: maxSiteVal,
        emptyText: '暂无站点来源统计'
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
            tooltipLines: [String(pinfo.name || pid), `请求调用: ${reqs} 次`, `负载占比: ${pct}%`],
            colorClass: 'provider'
        };
    });
    const maxProviderVal = Math.max(...providersItems.map(i => i.value), 10);
    const providersDistHtml = renderVerticalBarChart({
        items: providersItems,
        maxVal: maxProviderVal,
        emptyText: '暂无服务商分布统计'
    });

    // 实时流水表格
    let logsRowsHtml = '';
    if (recentLogs.length === 0) {
        logsRowsHtml = `
        <tr>
            <td colspan="9" style="text-align: center; color: var(--text-secondary); padding: 36px 16px; font-size: 13px;">
                暂无调用日志。当外部开发工具（如 VS Code）或旗下站点发起 AI 请求后，此处将实时展示调用流水。
            </td>
        </tr>
        `;
    } else {
        logsRowsHtml = recentLogs.map(log => {
            let siteBadge = `<span class="ai-site-badge other">${escapeHtml(log.site || '外部/其他')}</span>`;
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
                siteBadge = `<span class="ai-site-badge admin">管理后台</span>`;
                siteClass = 'admin';
                siteDomain = location.origin;
            } else if (sId.startsWith('key_') || sId.includes('dev') || sName.includes('开发') || sName.includes('master')) {
                siteBadge = `<span class="ai-site-badge dev">${escapeHtml(log.site || '开发直通')}</span>`;
                siteClass = 'dev';
            } else if (sId.includes('local') || sName.includes('本地')) {
                siteBadge = `<span class="ai-site-badge local">本地调试</span>`;
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
                        pageHtml = `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color: var(--primary-color); text-decoration: none; font-family: var(--font-mono, monospace); font-size: 12px; font-weight: 500;" title="在新标签页中打开: ${safeUrl}">${safePath}</a>`;
                    } else {
                        pageHtml = `<code style="font-family: var(--font-mono, monospace); font-size: 12px;">${safePath}</code>`;
                    }
                } else {
                    pageHtml = `<span style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(rawPath)}</span>`;
                }
            }

            let clientBadge = `<span class="ai-client-badge unauth">匿名游客</span>`;
            if (log.client === 'master') {
                clientBadge = `<span class="ai-client-badge master">开发者直通</span>`;
            } else if (log.client === 'auth') {
                const userText = escapeHtml(log.user || '已登录');
                clientBadge = `<span class="ai-client-badge auth site-${siteClass}" title="用户: ${userText}">${userText}</span>`;
            } else if (log.client && log.client !== 'unauth') {
                clientBadge = `<span class="ai-client-badge master" title="${escapeHtml(log.client)}">${escapeHtml(log.client)}</span>`;
            }

            let statusBadge = '';
            if (log.status >= 200 && log.status < 300) {
                if (log.fallback) {
                    const fbNote = log.error ? escapeHtml(log.error) : '';
                    statusBadge = `<span class="ai-status-badge fallback"${fbNote ? ` title="${fbNote}"` : ''}>容灾降级 (${escapeHtml(log.status)})</span>`;
                    if (fbNote) {
                        statusBadge += `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px; max-width: 260px; white-space: normal; line-height: 1.4;">${fbNote}</div>`;
                    }
                } else {
                    statusBadge = `<span class="ai-status-badge success">正常直通 (${escapeHtml(log.status)})</span>`;
                }
            } else {
                const safeErr = escapeHtml(log.error || '');
                statusBadge = `<span class="ai-status-badge error" title="${safeErr}">调用失败 (${escapeHtml(log.status)})</span>`;
                if (safeErr) {
                    statusBadge += `<div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px; max-width: 260px; white-space: normal; line-height: 1.4;">${safeErr}</div>`;
                }
            }

            const timeStr = escapeHtml(log.date ? `${String(log.date).slice(5)} ${log.time || ''}` : (log.time || '-'));
            const tokenCount = log.tokens || 0;
            const tokenTag = `<span class="ai-token-tag" title="提示词: ${Number(log.promptTokens) || 0} / 生成: ${Number(log.completionTokens) || 0}">${escapeHtml(formatTokens(Number(tokenCount) || 0))}</span>`;

            return `
            <tr>
                <td style="font-family: monospace; font-size: 12px; color: var(--text-secondary);">${timeStr}</td>
                <td>${siteBadge}</td>
                <td>${pageHtml}</td>
                <td>${clientBadge}</td>
                <td style="font-weight: 500;">${escapeHtml(log.provider || '未知服务商')}</td>
                <td><code style="font-size: 12px; font-weight: 600;">${escapeHtml(log.model || 'Bao-Default')}</code></td>
                <td>${tokenTag}</td>
                <td style="font-family: monospace; font-size: 12px;">${Number(log.latencyMs) || 0} ms</td>
                <td>${statusBadge}</td>
            </tr>
            `;
        }).join('');
    }

    return `
    <div class="ai-metrics-cards-grid">
        <div class="ai-metric-card">
            <div class="ai-metric-label">今日 Token 消耗</div>
            <div class="ai-metric-value" id="metric-today-tokens">${formatTokens(today.totalTokens || 0)}</div>
            <div class="ai-metric-sub">
                <span>近 7 天累计 ${formatTokens(summary.totalTokens || 0)}</span>
            </div>
        </div>

        <div class="ai-metric-card">
            <div class="ai-metric-label">接口调用成功率</div>
            <div class="ai-metric-value" id="metric-success-rate">${escapeHtml(summary.successRate)}%</div>
            <div class="ai-metric-sub">
                <span class="ai-metric-tag normal">今日 ${escapeHtml(today.total || 0)} 次</span>
                <span class="ai-metric-tag ${today.failed > 0 ? 'error' : 'normal'}">${today.failed > 0 ? `失败 ${escapeHtml(today.failed)}` : `成功 ${escapeHtml(today.success || 0)}`}</span>
                <span style="font-size: 11px; color: var(--text-secondary);">(7天 ${escapeHtml(summary.totalRequests)}次)</span>
            </div>
        </div>

        <div class="ai-metric-card">
            <div class="ai-metric-label">容灾降级频次</div>
            <div class="ai-metric-value" id="metric-fallback-count">${escapeHtml(today.fallbackCount || 0)}</div>
            <div class="ai-metric-sub">
                <span class="ai-metric-tag ${today.fallbackCount > 0 ? 'warning' : 'normal'}">近 7 天共 ${escapeHtml(summary.totalFallback)} 次</span>
            </div>
        </div>

        <div class="ai-metric-card">
            <div class="ai-metric-label">平均响应延迟</div>
            <div class="ai-metric-value" id="metric-avg-latency">${escapeHtml(summary.avgLatencyMs)} ms</div>
            <div class="ai-metric-sub">
                <span>全网链路平均响应首包耗时</span>
            </div>
        </div>
    </div>

    <div class="ai-grid-3" style="margin-top: 20px;">
        <div class="ai-card" style="display: flex; flex-direction: column; justify-content: space-between;">
            <div>
                <div class="ai-card-header-flex">
                    <h3 class="ai-card-title" style="margin: 0;">调用走势图</h3>
                    <div class="ai-trend-switcher capsule-tabs capsule-tabs--sm" data-capsule-tabs="ai-trend-days">
                        <button type="button" class="ai-trend-switch-btn ${currentMetricsDays === 7 ? 'active' : ''}" data-days="7">7天</button>
                        <button type="button" class="ai-trend-switch-btn ${currentMetricsDays === 30 ? 'active' : ''}" data-days="30">30天</button>
                    </div>
                </div>
                ${chartHtml}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--border-color); font-size: 11.5px; color: var(--text-secondary);">
                <span>${currentMetricsDays}天累计: <strong style="color: var(--text-primary); font-family: var(--font-mono);">${escapeHtml(summary.totalRequests || 0)}</strong> 次</span>
                <span>单日最高: <strong style="color: var(--primary-color); font-family: var(--font-mono);">${peakText}</strong></span>
            </div>
        </div>

        <div class="ai-card" style="display: flex; flex-direction: column; justify-content: space-between;">
            <div>
                <div class="ai-card-header-flex">
                    <h3 class="ai-card-title" style="margin: 0;">来源站点分布</h3>
                    <span class="ai-card-sub-info">调用柱状占比</span>
                </div>
                ${sitesDistHtml}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--border-color); font-size: 11.5px; color: var(--text-secondary);">
                <span>覆盖渠道: <strong style="color: var(--text-primary); font-family: var(--font-mono);">${siteEntries.length}</strong> 个</span>
                <span>主要流量: <strong style="color: var(--primary-color);">${escapeHtml(siteEntries[0]?.[1]?.name || siteEntries[0]?.[0] || '-')}</strong></span>
            </div>
        </div>

        <div class="ai-card" style="display: flex; flex-direction: column; justify-content: space-between;">
            <div>
                <div class="ai-card-header-flex">
                    <h3 class="ai-card-title" style="margin: 0;">模型服务商分布</h3>
                    <span class="ai-card-sub-info">算力柱状占比</span>
                </div>
                ${providersDistHtml}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px; padding-top: 10px; border-top: 1px dashed var(--border-color); font-size: 11.5px; color: var(--text-secondary);">
                <span>活跃上游: <strong style="color: var(--text-primary); font-family: var(--font-mono);">${providerEntries.length}</strong> 家</span>
                <span>主力支撑: <strong style="color: var(--primary-color);">${escapeHtml(providerEntries[0]?.[1]?.name || providerEntries[0]?.[0] || '-')}</strong></span>
            </div>
        </div>
    </div>

    <div class="ai-card" style="margin-top: 20px;">
        <div class="ai-card-header-flex">
            <div>
                <h3 class="ai-card-title" style="margin-bottom: 2px;">实时请求流水 (最近 50 条)</h3>
                <p style="font-size: 12px; color: var(--text-secondary); margin: 0;">捕获通过统一网关进出的每一笔模型推理请求</p>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="btn btn-outline btn-sm" id="ai-refresh-metrics-btn">刷新数据</button>
            </div>
        </div>

        <div class="table-responsive" style="margin-top: 14px; max-height: 400px; overflow-y: auto;">
            <table class="ai-table" id="ai-recent-logs-table">
                <thead>
                    <tr>
                        <th>时间</th>
                        <th>来源站点</th>
                        <th>调用页面</th>
                        <th>调用身份</th>
                        <th>服务商</th>
                        <th>模型</th>
                        <th>Tokens</th>
                        <th>耗时</th>
                        <th>状态</th>
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
