// ====================================================
// 业务胶囊 2: 账号管理业务控制器 (Accounts Module Controller)
// 负责各站点注册用户、UUID 与账号凭据排查
// ====================================================

import { queryDatabase } from '../api.js';
import { showConfirm, showAlert } from '../dialog.js';
import { formatDateTime, escapeHtml } from '../utils.js';

let ctx = null; // 上下文工具：{ showToast, showLoading, hideLoading, updatePagination }
let currentDb = { id: '', name: '' };
let tableData = [];
let currentPage = 1;
const pageSize = 20;
let totalCount = 0;
let searchKeyword = '';
// 表头点击排序（白名单字段，防止拼接任意 SQL）
const SORTABLE_FIELDS = {
    username: { label: '用户名', defaultOrder: 'ASC' },
    created_at: { label: '创建时间', defaultOrder: 'DESC' },
    last_login_at: { label: '最后登录', defaultOrder: 'DESC' }
};
let sortBy = 'created_at';
let sortOrder = 'DESC'; // 'DESC' | 'ASC'
let hasLastLogin = true; // 当前账号库是否有 last_login_at 列

export function renderAccountsTable(tbody, data) {
    if (!tbody) return;
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">没有找到匹配的账号数据。</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    data.forEach(item => {
        const tr = document.createElement('tr');
        const formattedTime = item.created_at ? formatDateTime(item.created_at) : '未知';
        // last_login_at 是可选列；账号库没有这一列时显示 —
        const lastLogin = item.last_login_at ? formatDateTime(item.last_login_at) : (('last_login_at' in item) ? '暂无记录' : '—');
        tr.innerHTML = `
            <td style="width: 40px;"><input type="checkbox" class="row-check" value="${item.id}"></td>
            <td style="font-size:0.8rem; font-family:monospace;"><span class="account-id-badge">${item.id}</span></td>
            <td><strong class="account-username">${escapeHtml(String(item.username))}</strong></td>
            <td class="cell-time" title="${formattedTime}">${formattedTime}</td>
            <td class="cell-time" title="${lastLogin}">${lastLogin}</td>
            <td style="text-align: right; white-space: nowrap;">
                <button class="btn btn-danger delete-btn" data-id="${item.id}" style="padding: 6px 12px; font-size: 12px;">删除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // 绑定单条删除
    tbody.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.target.getAttribute('data-id');
            deleteAccount(id);
        });
    });

    // 联动全选按钮状态
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
    return `${currentDb.id}_${currentPage}_${searchKeyword}_${sortBy}_${sortOrder}`;
}

export function clearAccountsCache() {
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
            renderAccountsTable(tbody, tableData);
            if (ctx?.updatePagination) {
                ctx.updatePagination(currentPage, Math.ceil(totalCount / pageSize) || 1, totalCount);
            }
            return;
        }
    }

    if (tableData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><span class="loader-inline"></span> 正在读取账号数据...</td></tr>`;
    } else {
        tbody.style.opacity = '0.55';
    }

    let whereClause = "WHERE 1=1";
    let params = [];

    if (searchKeyword) {
        whereClause += " AND (username LIKE ? OR id LIKE ?)";
        params.push(`%${searchKeyword}%`, `%${searchKeyword}%`);
    }

    try {
        const offset = (currentPage - 1) * pageSize;
        const field = SORTABLE_FIELDS[sortBy] ? sortBy : 'created_at';
        const order = sortOrder === 'ASC' ? 'ASC' : 'DESC';
        // 空值（如老账号没有最后登录时间）始终排在最后
        const orderClause = field === 'created_at'
            ? `ORDER BY created_at ${order}`
            : `ORDER BY ${field} IS NULL, ${field} ${order}, created_at DESC`;
        const sql = `SELECT * FROM users ${whereClause} ${orderClause} LIMIT ${pageSize} OFFSET ${offset}`;
        // 总数和本页数据同时查询，少等一次网络往返
        const [countData, data] = await Promise.all([
            queryDatabase(currentDb.id, `SELECT COUNT(*) as total FROM users ${whereClause}`, params),
            queryDatabase(currentDb.id, sql, params)
        ]);
        totalCount = countData.result[0].results[0].total;
        tableData = data.result[0].results || [];

        // 根据实际数据判断有没有 last_login_at 列，没有就不让这一列可点
        if (tableData.length > 0) {
            const has = 'last_login_at' in tableData[0];
            if (has !== hasLastLogin) {
                hasLastLogin = has;
                AccountsModule.setupHeaders();
            }
        }

        memoryCache.set(cacheKey, { tableData, totalCount, time: Date.now() });
        renderAccountsTable(tbody, tableData);

        if (ctx?.updatePagination) {
            ctx.updatePagination(currentPage, Math.ceil(totalCount / pageSize) || 1, totalCount);
        }
    } catch (err) {
        // 切到没有 last_login_at 列的站点时，自动退回按创建时间排序
        if (sortBy === 'last_login_at' && /no such column/i.test(err.message || '')) {
            hasLastLogin = false;
            sortBy = 'created_at';
            sortOrder = 'DESC';
            AccountsModule.setupHeaders();
            return loadData(true);
        }
        console.error("Accounts load error:", err);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger-color); padding: 2rem;">加载失败: ${err.message}</td></tr>`;
    } finally {
        tbody.style.opacity = '1';
    }
}

async function deleteAccount(id) {
    const ok = await showConfirm({
        title: '删除用户确认',
        message: `确定要永久删除用户 "${id}" 吗？此操作不可逆。`,
        confirmText: '永久删除',
        danger: true
    });
    if (!ok) return;

    if (ctx?.showLoading) ctx.showLoading('正在删除用户...');
    try {
        await queryDatabase(currentDb.id, `DELETE FROM users WHERE id = ?`, [id]);
        clearAccountsCache();
        if (ctx?.showToast) ctx.showToast('用户删除成功！');
        await loadData(true);
    } catch (err) {
        if (ctx?.showToast) ctx.showToast(`删除失败: ${err.message}`, true);
    } finally {
        if (ctx?.hideLoading) ctx.hideLoading();
    }
}

export const AccountsModule = {
    init(context) {
        ctx = context;
    },

    setupHeaders() {
        const thead = document.getElementById('data-thead');
        if (thead) {
            const sortTh = (field) => {
                const { label } = SORTABLE_FIELDS[field];
                if (field === 'last_login_at' && !hasLastLogin) return `<th>${label}</th>`;
                const cls = sortBy === field ? (sortOrder === 'DESC' ? 'sort-desc' : 'sort-asc') : '';
                return `<th class="accounts-sortable-header ${cls}" data-sort="${field}" title="点击切换${label}升序/降序">${label}</th>`;
            };
            thead.innerHTML = `
                <tr>
                    <th style="width: 40px;"><input type="checkbox" id="check-all"></th>
                    <th>ID (UUID)</th>
                    ${sortTh('username')}
                    ${sortTh('created_at')}
                    ${sortTh('last_login_at')}
                    <th style="text-align: right;">操作</th>
                </tr>
            `;
            thead.querySelectorAll('.accounts-sortable-header').forEach(th => {
                th.onclick = () => {
                    const field = th.dataset.sort;
                    if (sortBy === field) {
                        sortOrder = sortOrder === 'DESC' ? 'ASC' : 'DESC';
                    } else {
                        sortBy = field;
                        sortOrder = SORTABLE_FIELDS[field].defaultOrder;
                    }
                    currentPage = 1;
                    this.setupHeaders();
                    loadData(true);
                };
            });
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

        this.setupHeaders();
        await loadData();
    },

    unmount() {
        // 保留内存快照，避免切回时闪白屏
    },

    async onSiteChange(dbInfo) {
        currentDb = dbInfo || { id: '', name: '' };
        currentPage = 1;
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
            return ctx?.showToast ? ctx.showToast('请先勾选要删除的用户', true) : null;
        }

        const ids = Array.from(checkboxes).map(cb => cb.value);
        const ok = await showConfirm({
            title: '批量删除用户确认',
            message: `确定要永久删除选中的 ${ids.length} 个用户吗？此操作不可逆。`,
            confirmText: '批量删除',
            danger: true
        });
        if (!ok) return;

        if (ctx?.showLoading) ctx.showLoading(`正在批量删除 ${ids.length} 个用户...`);
        try {
            const placeholders = ids.map(() => '?').join(',');
            await queryDatabase(currentDb.id, `DELETE FROM users WHERE id IN (${placeholders})`, ids);
            clearAccountsCache();
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
        const headers = ['ID', '用户名', '创建时间', '最后登录'];
        const rows = tableData.map(c => [c.id, `"${String(c.username).replace(/"/g, '""')}"`, c.created_at || '未知', c.last_login_at || '']);
        const csvContent = "\uFEFF" + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `users_${currentDb.name}_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
    }
};
