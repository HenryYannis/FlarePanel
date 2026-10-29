// ====================================================
// 业务胶囊 1: 评论管理业务控制器 (Comments Module Controller)
// 负责各站点评论列表、URL筛选、快捷回复、审核与批量删除
// ====================================================

import { queryDatabase } from '../api.js';
import { showConfirm, showAlert } from '../dialog.js';
import { formatDateTime, escapeHtml } from '../utils.js';
import { getSiteUrl, PANEL } from '../sites.js';

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
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">没有找到匹配数据。</td></tr>';
        return;
    }

    const domain = getSiteUrl(currentDbName);

    tbody.innerHTML = '';
    data.forEach(item => {
        const tr = document.createElement('tr');
        const isReply = item.parent_id ? '<span class="tag" style="background: rgba(16, 185, 129, 0.1); color: #10B981;">回复</span>' : '';

        let replyContext = '';
        if (item.parent_id) {
            const pNick = item.parent_nick || '未知用户';
            const pComment = item.parent_comment || '(原文不存在或已删除)';
            const pCommentShort = pComment.length > 40 ? pComment.substring(0, 40) + '...' : pComment;
            replyContext = `
                <div class="reply-context">
                    <span style="font-weight: 600;">回复 @${escapeHtml(pNick)}</span>: 
                    <span style="font-style: italic;">${escapeHtml(pCommentShort)}</span>
                </div>
            `;
        }

        let urlDisplay = escapeHtml(String(item.url));
        if (domain) {
            const fullUrl = domain + (item.url.startsWith('/') ? item.url : '/' + item.url);
            urlDisplay = `<a href="${escapeHtml(fullUrl)}" target="_blank" style="color: var(--primary-color); text-decoration: none;" title="在新标签页中打开">${urlDisplay}</a>`;
        }

        let ipDisplay = '无';
        if (item.ip) {
            ipDisplay = `<a href="https://ipinfo.io/${item.ip}" target="_blank" class="cell-ip-link" title="查询 IP 归属地: ${item.ip}">${item.ip}</a>`;
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
            <td class="cell-likes"><span class="tag-likes">赞 ${item.likes || 0}</span></td>
            <td style="text-align: right; white-space: nowrap; width: 130px;">
                <button class="btn btn-outline reply-btn" data-id="${item.id}" style="padding: 6px 12px; font-size: 12px; margin-right: 4px;">回复</button>
                <button class="btn btn-danger delete-btn" data-id="${item.id}" style="padding: 6px 12px; font-size: 12px;">删除</button>
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
        console.error("加载 URL 过滤器失败", e);
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
        tbody.innerHTML = `<tr><td colspan="8" class="empty-state"><span class="loader-inline"></span> 正在读取评论数据...</td></tr>`;
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
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--danger-color); padding: 2rem;">加载失败: ${err.message}</td></tr>`;
    } finally {
        tbody.style.opacity = '1';
    }
}

async function deleteComment(id) {
    const targetId = parseInt(id);
    const ok = await showConfirm({
        title: '删除评论确认',
        message: `确定要删除 ID 为 ${id} 的评论吗？\n（其关联的所有子回复也将被一并清理）`,
        confirmText: '确认删除',
        danger: true
    });
    if (!ok) return;

    if (ctx?.showLoading) ctx.showLoading('正在删除评论...');
    try {
        await queryDatabase(currentDb.id, `DELETE FROM comments WHERE id = ?`, [targetId]);
        try {
            await queryDatabase(currentDb.id, `DELETE FROM comments WHERE parent_id = ?`, [targetId]);
        } catch (e) {}

        memoryCache.clear();
        if (ctx?.showToast) ctx.showToast('评论删除成功！');
        await loadData(true);
    } catch (err) {
        if (ctx?.showToast) ctx.showToast(`删除失败: ${err.message}`, true);
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
        replyText.textContent = `回复 @${item.nick}: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`;
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
    if (!content) return showAlert({ title: '提示', message: '请输入回复内容' });

    const comment = tableData.find(c => c.id === replyingToId);
    if (!comment) return;

    if (ctx?.showLoading) ctx.showLoading('正在发送官方回复...');
    try {
        // 官方回复直接通过 Cloudflare D1 API 写入（与列表读取同一通道），
        // 不再依赖评论 Worker 按 Origin 请求头识别管理员（该请求头可被伪造，Worker 已改为只认 X-Admin-Token）
        await queryDatabase(
            currentDb.id,
            `INSERT INTO comments (nick, comment, url, parent_id, ip, is_author) VALUES (?, ?, ?, ?, '', 1)`,
            [PANEL.adminName || '站长', content, comment.url, replyingToId]
        );
        memoryCache.clear();

        if (ctx?.showToast) ctx.showToast('回复成功！');
        if (modal) modal.style.display = 'none';
        if (replyInput) replyInput.value = '';
        await loadData(true);
    } catch (error) {
        if (ctx?.showToast) ctx.showToast(`回复失败: ${error.message}`, true);
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
                    <th style="min-width: 90px; width: 110px;">昵称</th>
                    <th>评论内容</th>
                    <th style="min-width: 110px; width: 140px;">页面来源</th>
                    <th style="width: 155px; white-space: nowrap;">时间</th>
                    <th style="width: 140px; white-space: nowrap;">IP地址</th>
                    <th style="width: 80px; text-align: center; white-space: nowrap;">点赞</th>
                    <th style="width: 130px; text-align: right; white-space: nowrap;">操作</th>
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
            urlSelect.innerHTML = '<option value="">所有文章 URL</option>';
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
            urlSelect.innerHTML = '<option value="">所有文章 URL</option>';
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
            return ctx?.showToast ? ctx.showToast('请先勾选要删除的评论', true) : null;
        }

        const ids = Array.from(checkboxes).map(cb => parseInt(cb.value));
        const ok = await showConfirm({
            title: '批量删除评论确认',
            message: `确定要永久删除选中的 ${ids.length} 条评论吗？\n（若包含父级评论，其下属子回复也将被一并删除）`,
            confirmText: '批量删除',
            danger: true
        });
        if (!ok) return;

        if (ctx?.showLoading) ctx.showLoading(`正在批量删除 ${ids.length} 条评论...`);
        try {
            const placeholders = ids.map(() => '?').join(',');
            await queryDatabase(currentDb.id, `DELETE FROM comments WHERE id IN (${placeholders})`, ids);
            try {
                await queryDatabase(currentDb.id, `DELETE FROM comments WHERE parent_id IN (${placeholders})`, ids);
            } catch (e) {}

            memoryCache.clear();
            if (ctx?.showToast) ctx.showToast('批量删除成功！');
            await loadData(true);
        } catch (err) {
            if (ctx?.showToast) ctx.showToast(`批量删除失败: ${err.message}`, true);
        } finally {
            if (ctx?.hideLoading) ctx.hideLoading();
        }
    },

    exportCSV() {
        if (tableData.length === 0) {
            showAlert({ title: '导出提示', message: '当前没有可导出的数据' });
            return;
        }
        const headers = ['ID', '昵称', '评论内容', '页面来源', '时间', 'IP', '点赞数'];
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
