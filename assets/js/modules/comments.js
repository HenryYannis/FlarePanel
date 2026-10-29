// ====================================================
// 业务胶囊 1: 评论管理业务控制器 (Comments Module Controller)
// 负责各站点评论列表、URL筛选、快捷回复、审核与批量删除
// ====================================================

import { queryDatabase } from '../api.js';
import { showConfirm, showAlert } from '../dialog.js';
import { formatDateTime, escapeHtml } from '../utils.js';
import { getSiteUrl, PANEL } from '../sites.js';
import { t, formatNumber, localizedLabel } from '../i18n.js';

let ctx = null;
let currentDb = { id: '', name: '' };
let tableData = [];
let currentPage = 1;
const pageSize = 20;
let totalCount = 0;
let searchKeyword = '';
let selectedUrl = '';
let replyingToId = null;

export { formatDateTime };

export function renderCommentsTable(tbody, data, currentDbName) {
    if (!tbody) return;
    if (data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${t('common.noMatch')}</td></tr>`;
        return;
    }

    const domain = getSiteUrl(currentDbName);

    tbody.innerHTML = '';
    data.forEach(item => {
        const tr = document.createElement('tr');
        const isReply = item.parent_id ? '<span class="tag" style="background: rgba(16, 185, 129, 0.1); color: #10B981;">' + t('comments.reply') + '</span>' : '';

        let replyContext = '';
        if (item.parent_id) {
            const pNick = item.parent_nick || t('comments.unknownUser');
            const pComment = item.parent_comment || t('comments.parentMissing');
            const pCommentShort = pComment.length > 40 ? pComment.substring(0, 40) + '...' : pComment;
            replyContext = `
                <div class="reply-context">
                    <span style="font-weight: 600;">${escapeHtml(t('comments.replyTo', { nick: pNick }))}</span>: 
                    <span style="font-style: italic;">${escapeHtml(pCommentShort)}</span>
                </div>
            `;
        }

        let urlDisplay = escapeHtml(String(item.url));
        if (domain) {
            const fullUrl = domain + (item.url.startsWith('/') ? item.url : '/' + item.url);
            urlDisplay = `<a href="${escapeHtml(fullUrl)}" target="_blank" style="color: var(--primary-color); text-decoration: none;" title="${t('common.openNewTab')}">${urlDisplay}</a>`;
        }

        let ipDisplay = t('common.none');
        if (item.ip) {
            // IP 可能来自评论 Worker 原样写入的请求头，必须转义；仅合法 IPv4/IPv6 才生成查询链接
            const ipRaw = String(item.ip).trim();
            const ipText = escapeHtml(ipRaw);
            const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ipRaw);
            const isIpv6 = /^[0-9a-fA-F:]+$/.test(ipRaw) && ipRaw.includes(':');
            if (isIpv4 || isIpv6) {
                const lookupUrl = `https://ipinfo.io/${encodeURIComponent(ipRaw)}`;
                ipDisplay = `<a href="${escapeHtml(lookupUrl)}" target="_blank" rel="noopener noreferrer" class="cell-ip-link" title="${escapeHtml(t('common.ipLookup', { ip: ipRaw }))}">${ipText}</a>`;
            } else {
                ipDisplay = ipText;
            }
        }

        const formattedTime = formatDateTime(item.created_at);

        tr.innerHTML = `
            <td style="width: 40px;"><input type="checkbox" class="row-check" value="${item.id}"></td>
            <td style="min-width: 90px;"><strong>${escapeHtml(String(item.nick))}</strong></td>
            <td>
                <div class="text-ellipsis" style="white-space: normal;" title="${escapeHtml(String(item.comment))}">
                    ${replyContext}
                    ${isReply} ${escapeHtml(String(item.comment))}
                </div>
            </td>
            <td style="font-size:0.8rem; min-width: 110px;">${urlDisplay}</td>
            <td class="cell-time" title="${formattedTime}">${formattedTime}</td>
            <td class="cell-ip">${ipDisplay}</td>
            <td class="cell-likes"><span class="tag-likes">${t('comments.likes', { count: formatNumber(item.likes || 0) })}</span></td>
            <td style="text-align: right; white-space: nowrap; width: 130px;">
                <button class="btn btn-outline reply-btn" data-id="${item.id}" style="padding: 6px 12px; font-size: 12px; margin-right: 4px;">${t('comments.reply')}</button>
                <button class="btn btn-danger delete-btn" data-id="${item.id}" style="padding: 6px 12px; font-size: 12px;">${t('common.delete')}</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // 绑定事件
    tbody.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.getAttribute('data-id');
            deleteComment(id);
        });
    });

    tbody.querySelectorAll('.reply-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.getAttribute('data-id');
            openReplyModal(id);
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

export async function loadCommentsUrlFilter(dbId) {
    try {
        const urlsData = await queryDatabase(dbId, "SELECT DISTINCT url FROM comments ORDER BY url ASC");
        return urlsData.result[0].results.map(item => item.url);
    } catch (e) {
        console.error("Failed to load URL filter", e);
        return [];
    }
}

// 60秒内存快照缓存，实现切回胶囊时 0 毫秒秒开
const CACHE_TTL = 60 * 1000;
const memoryCache = new Map();

function getCacheKey() {
    return `${currentDb.id}_${currentPage}_${searchKeyword}_${selectedUrl}`;
}

export function clearCommentsCache() {
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
            renderCommentsTable(tbody, tableData, currentDb.name);
            if (ctx?.updatePagination) {
                ctx.updatePagination(currentPage, Math.ceil(totalCount / pageSize) || 1, totalCount);
            }
            return;
        }
    }

    // 局部优雅加载：杜绝全屏黑屏弹窗
    if (tableData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-state"><span class="loader-inline"></span> ${t('comments.loading')}</td></tr>`;
    } else {
        tbody.style.opacity = '0.55';
    }

    let whereClause = "WHERE 1=1";
    let params = [];

    if (selectedUrl) {
        whereClause += " AND c.url = ?";
        params.push(selectedUrl);
    }

    if (searchKeyword) {
        whereClause += " AND (c.nick LIKE ? OR c.comment LIKE ?)";
        params.push(`%${searchKeyword}%`, `%${searchKeyword}%`);
    }

    try {
        const offset = (currentPage - 1) * pageSize;
        const sql = `SELECT c.id, c.nick, c.comment, c.url, c.parent_id, c.ip, c.created_at, c.likes, p.nick as parent_nick, p.comment as parent_comment FROM comments c LEFT JOIN comments p ON c.parent_id = p.id ${whereClause} ORDER BY c.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
        // 总数和本页数据同时查询，少等一次网络往返
        const [countData, data] = await Promise.all([
            queryDatabase(currentDb.id, `SELECT COUNT(*) as total FROM comments c ${whereClause}`, params),
            queryDatabase(currentDb.id, sql, params)
        ]);
        totalCount = countData.result[0].results[0].total;
        tableData = data.result[0].results || [];

        // 写入内存快照
        memoryCache.set(cacheKey, { tableData, totalCount, time: Date.now() });

        renderCommentsTable(tbody, tableData, currentDb.name);

        if (ctx?.updatePagination) {
            ctx.updatePagination(currentPage, Math.ceil(totalCount / pageSize) || 1, totalCount);
        }
    } catch (err) {
        console.error("Comments load error:", err);
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--danger-color); padding: 2rem;">${escapeHtml(t('common.loadFailed', { msg: err.message }))}</td></tr>`;
    } finally {
        tbody.style.opacity = '1';
    }
}

async function deleteComment(id) {
    const targetId = parseInt(id);
    const ok = await showConfirm({
        title: t('comments.deleteTitle'),
        message: t('comments.deleteMessage', { id }),
        confirmText: t('common.confirmDelete'),
        danger: true
    });
    if (!ok) return;

    if (ctx?.showLoading) ctx.showLoading(t('comments.deleting'));
    try {
        await queryDatabase(currentDb.id, `DELETE FROM comments WHERE id = ?`, [targetId]);
        try {
            await queryDatabase(currentDb.id, `DELETE FROM comments WHERE parent_id = ?`, [targetId]);
        } catch (e) {}

        memoryCache.clear();
        if (ctx?.showToast) ctx.showToast(t('comments.deleted'));
        await loadData(true);
    } catch (err) {
        if (ctx?.showToast) ctx.showToast(t('common.deleteFailed', { msg: err.message }), true);
    } finally {
        if (ctx?.hideLoading) ctx.hideLoading();
    }
}

function openReplyModal(id) {
    const item = tableData.find(c => c.id === parseInt(id));
    if (!item) return;
    replyingToId = item.id;

    const modal = document.getElementById('reply-modal');
    const replyText = document.getElementById('reply-to-text');
    const replyInput = document.getElementById('reply-content');

    if (replyText) {
        const content = String(item.comment);
        replyText.textContent = t('comments.replyContext', { nick: item.nick, text: `${content.substring(0, 50)}${content.length > 50 ? '...' : ''}` });
    }
    if (replyInput) replyInput.value = '';
    if (modal) {
        modal.style.display = 'flex';
        replyInput?.focus();
    }
}

async function submitReply() {
    const replyInput = document.getElementById('reply-content');
    const modal = document.getElementById('reply-modal');
    const content = replyInput?.value.trim();
    if (!content) return showAlert({ title: t('dialog.alertTitle'), message: t('comments.replyEmpty') });

    const comment = tableData.find(c => c.id === replyingToId);
    if (!comment) return;

    if (ctx?.showLoading) ctx.showLoading(t('comments.replySending'));
    try {
        // 官方回复直接通过 Cloudflare D1 API 写入（与列表读取同一通道），
        // 不再依赖评论 Worker 按 Origin 请求头识别管理员（该请求头可被伪造，Worker 已改为只认 X-Admin-Token）
        await queryDatabase(
            currentDb.id,
            `INSERT INTO comments (nick, comment, url, parent_id, ip, is_author) VALUES (?, ?, ?, ?, '', 1)`,
            [localizedLabel(PANEL.adminName) || t('reply.defaultAdmin'), content, comment.url, replyingToId]
        );
        memoryCache.clear();

        if (ctx?.showToast) ctx.showToast(t('comments.replySuccess'));
        if (modal) modal.style.display = 'none';
        if (replyInput) replyInput.value = '';
        await loadData(true);
    } catch (error) {
        if (ctx?.showToast) ctx.showToast(t('comments.replyFailed', { msg: error.message }), true);
    } finally {
        if (ctx?.hideLoading) ctx.hideLoading();
    }
}

function initReplyModalEvents() {
    const submitBtn = document.getElementById('submit-reply-btn');
    const cancelBtn = document.getElementById('close-reply-btn');
    const modal = document.getElementById('reply-modal');

    if (submitBtn) submitBtn.onclick = submitReply;
    if (cancelBtn && modal) {
        cancelBtn.onclick = () => {
            modal.style.display = 'none';
        };
    }
}

export const CommentsModule = {
    init(context) {
        ctx = context;
        initReplyModalEvents();
    },

    setupHeaders() {
        const thead = document.getElementById('data-thead');
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th style="width: 40px;"><input type="checkbox" id="check-all"></th>
                    <th style="min-width: 90px; width: 110px;">${t('comments.colNick')}</th>
                    <th>${t('comments.colComment')}</th>
                    <th style="min-width: 110px; width: 140px;">${t('comments.colPage')}</th>
                    <th style="width: 155px; white-space: nowrap;">${t('common.time')}</th>
                    <th style="width: 140px; white-space: nowrap;">${t('comments.colIp')}</th>
                    <th style="width: 80px; text-align: center; white-space: nowrap;">${t('comments.colLikes')}</th>
                    <th style="width: 130px; text-align: right; white-space: nowrap;">${t('common.actions')}</th>
                </tr>
            `;
            const checkAll = document.getElementById('check-all');
            if (checkAll) {
                checkAll.checked = false;
                checkAll.onchange = (e) => {
                    document.querySelectorAll('.row-check').forEach(cb => cb.checked = e.target.checked);
                };
            }
        }
    },

    async mount(dbInfo) {
        currentDb = dbInfo || { id: '', name: '' };
        currentPage = 1;
        searchKeyword = '';
        selectedUrl = '';

        this.setupHeaders();

        // 呈现 URL 过滤器下拉框
        const urlSelect = document.getElementById('url-filter');
        if (urlSelect) {
            urlSelect.style.display = 'inline-block';
            urlSelect.innerHTML = `<option value="">${t('toolbar.allUrls')}</option>`;
            urlSelect.onchange = (e) => {
                selectedUrl = e.target.value;
                currentPage = 1;
                loadData();
            };

            // 异步加载此库中的所有文章 URL
            loadCommentsUrlFilter(currentDb.id).then(urls => {
                urls.forEach(url => {
                    const opt = document.createElement('option');
                    opt.value = url;
                    opt.textContent = url;
                    urlSelect.appendChild(opt);
                });
            });
        }

        await loadData();
    },

    unmount() {
        const urlSelect = document.getElementById('url-filter');
        if (urlSelect) urlSelect.style.display = 'none';

        const replyModal = document.getElementById('reply-modal');
        if (replyModal) replyModal.style.display = 'none';
    },

    async onSiteChange(dbInfo) {
        currentDb = dbInfo || { id: '', name: '' };
        currentPage = 1;
        selectedUrl = '';

        const urlSelect = document.getElementById('url-filter');
        if (urlSelect) {
            urlSelect.innerHTML = `<option value="">${t('toolbar.allUrls')}</option>`;
            loadCommentsUrlFilter(currentDb.id).then(urls => {
                urls.forEach(url => {
                    const opt = document.createElement('option');
                    opt.value = url;
                    opt.textContent = url;
                    urlSelect.appendChild(opt);
                });
            });
        }

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
            return ctx?.showToast ? ctx.showToast(t('comments.selectFirst'), true) : null;
        }

        const ids = Array.from(checkboxes).map(cb => parseInt(cb.value));
        const ok = await showConfirm({
            title: t('comments.batchTitle'),
            message: t('comments.batchMessage', { count: ids.length }),
            confirmText: t('common.batchDelete'),
            danger: true
        });
        if (!ok) return;

        if (ctx?.showLoading) ctx.showLoading(t('comments.batchDeleting', { count: ids.length }));
        try {
            const placeholders = ids.map(() => '?').join(',');
            await queryDatabase(currentDb.id, `DELETE FROM comments WHERE id IN (${placeholders})`, ids);
            try {
                await queryDatabase(currentDb.id, `DELETE FROM comments WHERE parent_id IN (${placeholders})`, ids);
            } catch (e) {}

            memoryCache.clear();
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
        const headers = ['ID', t('comments.colNick'), t('comments.colComment'), t('comments.colPage'), t('common.time'), 'IP', t('comments.csvLikes')];
        const rows = tableData.map(c => [
            c.id, `"${String(c.nick).replace(/"/g, '""')}"`, `"${String(c.comment).replace(/"/g, '""')}"`,
            c.url, c.created_at, c.ip || '', c.likes || 0
        ]);
        const csvContent = "\uFEFF" + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `comments_${currentDb.name}_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    }
};
