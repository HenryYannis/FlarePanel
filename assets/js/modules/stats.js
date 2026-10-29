// ====================================================
// 业务胶囊 3: 浏览数量业务控制器 (Stats Module Controller)
// 负责各站点文章访问量排查、升降序排序与热度分析
// ====================================================

import { queryDatabase } from '../api.js';
import { showConfirm, showAlert } from '../dialog.js';
import { formatDateTime, escapeHtml } from '../utils.js';
import { getSiteUrl, getViewTypes, PANEL } from '../sites.js';
import { t, formatNumber, localizedLabel } from '../i18n.js';

let ctx = null;
let currentDb = { id: '', name: '' };
let tableData = [];
let currentPage = 1;
const pageSize = 20;
let totalCount = 0;
let searchKeyword = '';
let sortBy = 'views';
let sortOrder = 'DESC'; // 'DESC' | 'ASC'
let typeFilter = ''; // '' 全部 | 分类 key（见 sites.config.js 的 viewTypes）| 'other' 其他

// 分类选项：全部 + 配置的分类 + 其他页面
function getTypeOptions(dbName) {
    const opts = [['', t('stats.allTypes')]];
    getViewTypes(dbName).forEach(type => opts.push([type.key, localizedLabel(type.label) || type.key]));
    opts.push(['other', t('stats.otherPages')]);
    return opts;
}

// 把分类换成 SQL 条件（前缀用参数传入，不拼进 SQL）
function buildTypeCondition(dbName, key) {
    const types = getViewTypes(dbName);
    const likeAny = (prefixes, params) => {
        prefixes.forEach(p => params.push(`${p}%`));
        return '(' + prefixes.map(() => 'url LIKE ?').join(' OR ') + ')';
    };
    const params = [];
    if (key === 'other') {
        const all = types.flatMap(item => item.prefixes);
        if (!all.length) return null;
        return { sql: `NOT ${likeAny(all, params)}`, params };
    }
    const type = types.find(item => item.key === key);
    if (!type) return null;
    return { sql: likeAny(type.prefixes, params), params };
}

function renderTypeFilter() {
    const select = document.getElementById('url-filter');
    if (!select) return;
    select.style.display = 'inline-block';
    select.innerHTML = '';
    getTypeOptions(currentDb.name).forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
    });
    select.value = typeFilter;
    select.onchange = (e) => {
        typeFilter = e.target.value;
        currentPage = 1;
        loadData();
    };
}

export function renderStatsTable(tbody, data, currentDbName) {
    if (!tbody) return;
    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${t('stats.noMatch')}</td></tr>`;
        return;
    }

    const domain = getSiteUrl(currentDbName);

    tbody.innerHTML = '';
    data.forEach(item => {
        const tr = document.createElement('tr');
        
        let urlDisplay = escapeHtml(String(item.url));
        if (domain) {
            const fullUrl = domain + (item.url.startsWith('/') ? item.url : '/' + item.url);
            urlDisplay = `<a href="${escapeHtml(fullUrl)}" target="_blank" style="color: var(--primary-color); text-decoration: none;" title="${t('common.openNewTab')}">${urlDisplay}</a>`;
        }

        // 没有更新时间的记录显示 -，不要拿当前时间冒充
        const formattedTime = formatDateTime(item.updated_at);

        tr.innerHTML = `
            <td style="width: 40px;"><input type="checkbox" class="row-check" value="${item.id}"></td>
            <td><strong>${item.id}</strong></td>
            <td><div class="text-ellipsis" title="${escapeHtml(String(item.url))}">${urlDisplay}</div></td>
            <td><span class="stats-views-badge">${formatNumber(item.views || 0)}</span></td>
            <td class="cell-time" title="${formattedTime}">${formattedTime}</td>
            <td style="text-align: right; white-space: nowrap;">
                <button class="btn btn-danger delete-btn" data-id="${item.id}" style="padding: 6px 12px; font-size: 12px;">${t('common.delete')}</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // 绑定单条删除
    tbody.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.getAttribute('data-id');
            deleteStatsRecord(id);
        });
    });

    // 联动全选
    const checkAll = document.getElementById('check-all');
    tbody.querySelectorAll('.row-check').forEach(cb => {
        cb.addEventListener('change', () => {
            if (checkAll) {
                const allChecks = tbody.querySelectorAll('.row-check');
                const checkedChecks = tbody.querySelectorAll('.row-check:checked');
                checkAll.checked = allChecks.length > 0 && allChecks.length === checkedChecks.length;
            }
        });
    });
}

// 60秒内存快照缓存，实现切回胶囊时 0 毫秒秒开
const CACHE_TTL = 60 * 1000;
const memoryCache = new Map();

function getCacheKey() {
    return `${currentDb.id}_${currentPage}_${searchKeyword}_${typeFilter}_${sortBy}_${sortOrder}`;
}

export function clearStatsCache() {
    memoryCache.clear();
}

async function loadData(forceRefresh = false) {
    if (!currentDb.id) return;
    const tbody = document.getElementById('data-tbody');
    if (!tbody) return;

    const cacheKey = getCacheKey();
    if (!forceRefresh && memoryCache.has(cacheKey)) {
        const cached = memoryCache.get(cacheKey);
        if (Date.now() - cached.time < CACHE_TTL) {
            tableData = cached.tableData;
            totalCount = cached.totalCount;
            renderStatsTable(tbody, tableData, currentDb.name);
            if (ctx?.updatePagination) {
                ctx.updatePagination(currentPage, Math.ceil(totalCount / pageSize) || 1, totalCount);
            }
            return;
        }
    }

    if (tableData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><span class="loader-inline"></span> ${t('stats.loading')}</td></tr>`;
    } else {
        tbody.style.opacity = '0.55';
    }

    let whereClause = "WHERE url != '/'";
    let params = [];

    // 不显示的页面：网址里含这些关键词就跳过（sites.config.js 的 PANEL.viewExcludes）
    (PANEL.viewExcludes || []).forEach(kw => {
        whereClause += ' AND url NOT LIKE ?';
        params.push(`%${kw}%`);
    });

    const typeCond = typeFilter ? buildTypeCondition(currentDb.name, typeFilter) : null;
    if (typeCond) {
        whereClause += ` AND ${typeCond.sql}`;
        params.push(...typeCond.params);
    }

    if (searchKeyword) {
        whereClause += " AND (url LIKE ?)";
        params.push(`%${searchKeyword}%`);
    }

    try {
        const offset = (currentPage - 1) * pageSize;
        const sql = `SELECT * FROM article_views ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT ${pageSize} OFFSET ${offset}`;
        // 总数和本页数据同时查询，少等一次网络往返
        const [countData, data] = await Promise.all([
            queryDatabase(currentDb.id, `SELECT COUNT(*) as total FROM article_views ${whereClause}`, params),
            queryDatabase(currentDb.id, sql, params)
        ]);
        totalCount = countData.result[0].results[0].total;
        tableData = data.result[0].results || [];

        memoryCache.set(cacheKey, { tableData, totalCount, time: Date.now() });
        renderStatsTable(tbody, tableData, currentDb.name);

        if (ctx?.updatePagination) {
            ctx.updatePagination(currentPage, Math.ceil(totalCount / pageSize) || 1, totalCount);
        }
    } catch (err) {
        console.error("Stats load error:", err);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger-color); padding: 2rem;">${escapeHtml(t('common.loadFailed', { msg: err.message }))}</td></tr>`;
    } finally {
        tbody.style.opacity = '1';
    }
}

async function deleteStatsRecord(id) {
    const ok = await showConfirm({
        title: t('stats.deleteTitle'),
        message: t('stats.deleteMessage', { id }),
        confirmText: t('common.confirmDelete'),
        danger: true
    });
    if (!ok) return;

    if (ctx?.showLoading) ctx.showLoading(t('common.deleting'));
    try {
        await queryDatabase(currentDb.id, `DELETE FROM article_views WHERE id = ?`, [parseInt(id)]);
        clearStatsCache();
        if (ctx?.showToast) ctx.showToast(t('stats.deleted'));
        await loadData(true);
    } catch (err) {
        if (ctx?.showToast) ctx.showToast(t('common.deleteFailed', { msg: err.message }), true);
    } finally {
        if (ctx?.hideLoading) ctx.hideLoading();
    }
}

export const StatsModule = {
    init(context) {
        ctx = context;
    },

    setupHeaders() {
        const thead = document.getElementById('data-thead');
        if (!thead) return;

        const viewsSortClass = sortBy === 'views' ? (sortOrder === 'DESC' ? 'sort-desc' : 'sort-asc') : '';
        const updatedSortClass = sortBy === 'updated_at' ? (sortOrder === 'DESC' ? 'sort-desc' : 'sort-asc') : '';
        thead.innerHTML = `
            <tr>
                <th style="width: 40px;"><input type="checkbox" id="check-all"></th>
                <th>ID</th>
                <th>${t('stats.colUrl')}</th>
                <th id="sort-views-th" class="stats-sortable-header ${viewsSortClass}" title="${escapeHtml(t('common.sortToggle', { label: t('stats.colViews') }))}">${t('stats.colViews')}</th>
                <th id="sort-updated-th" class="stats-sortable-header ${updatedSortClass}" title="${escapeHtml(t('common.sortToggle', { label: t('stats.colUpdated') }))}">${t('stats.colUpdated')}</th>
                <th style="text-align: right;">${t('common.actions')}</th>
            </tr>
        `;

        const checkAll = document.getElementById('check-all');
        if (checkAll) {
            checkAll.checked = false;
            checkAll.onchange = (e) => {
                document.querySelectorAll('.row-check').forEach(cb => cb.checked = e.target.checked);
            };
        }

        const sortViewsTh = document.getElementById('sort-views-th');
        if (sortViewsTh) {
            sortViewsTh.onclick = () => {
                if (sortBy === 'views') {
                    sortOrder = sortOrder === 'DESC' ? 'ASC' : 'DESC';
                } else {
                    sortBy = 'views';
                    sortOrder = 'DESC';
                }
                currentPage = 1;
                this.setupHeaders();
                loadData(true);
            };
        }

        const sortUpdatedTh = document.getElementById('sort-updated-th');
        if (sortUpdatedTh) {
            sortUpdatedTh.onclick = () => {
                if (sortBy === 'updated_at') {
                    sortOrder = sortOrder === 'DESC' ? 'ASC' : 'DESC';
                } else {
                    sortBy = 'updated_at';
                    sortOrder = 'DESC';
                }
                currentPage = 1;
                this.setupHeaders();
                loadData(true);
            };
        }
    },

    async mount(dbInfo) {
        currentDb = dbInfo || { id: '', name: '' };
        currentPage = 1;
        searchKeyword = '';
        typeFilter = '';

        this.setupHeaders();
        renderTypeFilter();
        await loadData();
    },

    unmount() {
        // 保留数据快照；类型下拉框和评论管理共用，离开时收起
        const select = document.getElementById('url-filter');
        if (select) {
            select.style.display = 'none';
            select.onchange = null;
        }
    },

    async onSiteChange(dbInfo) {
        currentDb = dbInfo || { id: '', name: '' };
        currentPage = 1;
        searchKeyword = '';
        typeFilter = '';
        renderTypeFilter();
        await loadData();
    },

    async setPage(page) {
        currentPage = page;
        await loadData();
    },

    async search(kw) {
        searchKeyword = kw;
        currentPage = 1;
        await loadData();
    },

    async deleteSelected() {
        const checkboxes = document.querySelectorAll('.row-check:checked');
        if (checkboxes.length === 0) {
            return ctx?.showToast ? ctx.showToast(t('stats.selectFirst'), true) : null;
        }

        const ids = Array.from(checkboxes).map(cb => parseInt(cb.value));
        const ok = await showConfirm({
            title: t('stats.batchTitle'),
            message: t('stats.batchMessage', { count: ids.length }),
            confirmText: t('common.batchDelete'),
            danger: true
        });
        if (!ok) return;

        if (ctx?.showLoading) ctx.showLoading(t('stats.batchDeleting', { count: ids.length }));
        try {
            const placeholders = ids.map(() => '?').join(',');
            await queryDatabase(currentDb.id, `DELETE FROM article_views WHERE id IN (${placeholders})`, ids);
            clearStatsCache();
            if (ctx?.showToast) ctx.showToast(t('common.batchDeleteSuccess'));
            await loadData(true);
        } catch (err) {
            if (ctx?.showToast) ctx.showToast(t('common.batchDeleteFailed', { msg: err.message }), true);
        } finally {
            if (ctx?.hideLoading) ctx.hideLoading();
        }
    },

    exportCSV() {
        if (tableData.length === 0) {
            showAlert({ title: t('common.exportTitle'), message: t('common.nothingToExport') });
            return;
        }
        const headers = ['ID', t('stats.colUrl'), t('stats.colViews'), t('stats.colUpdated')];
        const rows = tableData.map(c => [c.id, `"${String(c.url).replace(/"/g, '""')}"`, c.views || 0, c.updated_at || t('common.unknown')]);
        const csvContent = "\uFEFF" + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `stats_${currentDb.name}_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    }
};
