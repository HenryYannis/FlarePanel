// ====================================================
// FlarePanel - 核心驱动 (Core Hub Controller)
// 职责：鉴权认证、五大胶囊路由装载、全站站点调度、全局状态机与设计系统
// ====================================================

import { connectD1, loadSavedCredentials, logout } from './auth.js';
import { cfRequest } from './api.js';
import { showConfirm, showAlert, showPrompt } from './dialog.js';
import { getSiteSortOrder, getSiteDisplayName } from './utils.js';
import { getResourceNames, AI_HUB, PANEL } from './sites.js';

// 挂载至 window 供可能需要的位置兜底
window.showConfirm = showConfirm;
window.showAlert = showAlert;
window.showPrompt = showPrompt;

// 导入五大胶囊业务专属控制器
import { CommentsModule } from './modules/comments.js';
import { AccountsModule } from './modules/accounts.js';
import { StatsModule } from './modules/stats.js';
import { StorageModule, prefetchStorageDirectory } from './modules/storage.js';
import { AiHubModule } from './modules/ai-hub.js';
import { syncS3CredentialsFromServer } from './upload-manager.js';

// 胶囊控制器字典
const CAPSULES = {
    comments: CommentsModule,
    accounts: AccountsModule,
    stats: StatsModule,
    storage: StorageModule,
    ai: AiHubModule
};

// 全局核心状态
const state = {
    activeCapsule: 'ai',       // 'ai' | 'storage' | 'comments' | 'stats' | 'accounts'
    databases: [],             // D1 数据库列表
    storageBuckets: [],        // R2 存储桶列表
    currentDb: { id: '', name: '' },
    currentBucket: getResourceNames('bucket')[0] || ''
};

// DOM 核心元素缓存
const el = {
    // 鉴权
    authSection: document.getElementById('auth-section'),
    mainSection: document.getElementById('main-section'),
    accountIdInput: document.getElementById('accountId'),
    apiTokenInput: document.getElementById('apiToken'),
    loginBtn: document.getElementById('login-btn'),
    logoutBtn: document.getElementById('logout-btn'),

    // 胶囊导航栏
    capsuleSwitch: document.getElementById('capsule-switch') || document.querySelector('.capsule-switch'),
    capsuleBtns: {
        ai: document.getElementById('tab-ai'),
        storage: document.getElementById('tab-storage'),
        comments: document.getElementById('tab-comments'),
        stats: document.getElementById('tab-stats'),
        accounts: document.getElementById('tab-accounts')
    },

    // 站点选择区
    dbSelectorWrapper: document.getElementById('db-selector-wrapper'),
    selectorLabel: document.getElementById('selector-label'),
    dbList: document.getElementById('db-list'),

    // 通用工具栏与表格区
    toolbar: document.getElementById('toolbar'),
    keywordSearch: document.getElementById('keyword-search'),
    exportBtn: document.getElementById('export-btn'),
    batchDelBtn: document.getElementById('batch-del-btn'),
    uploadFileBtn: document.getElementById('upload-file-btn'),
    fileUploadInput: document.getElementById('file-upload-input'),
    newFolderBtn: document.getElementById('new-folder-btn'),
    refreshStorageBtn: document.getElementById('refresh-storage-btn'),
    tableContainer: document.getElementById('table-container'),
    dataThead: document.getElementById('data-thead'),
    dataTbody: document.getElementById('data-tbody'),
    pagination: document.getElementById('pagination'),
    pageInfo: document.getElementById('page-info'),
    prevPageBtn: document.getElementById('prev-page'),
    nextPageBtn: document.getElementById('next-page'),

    // AI Hub 容器
    aiHubContainer: document.getElementById('ai-hub-container'),

    // 全局反馈浮层
    toast: document.getElementById('toast'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.getElementById('loading-text')
};

// ==================== 全局 Toast 与 Loading 工具 ====================
let toastTimer = null;
function showToast(message, isError = false) {
    if (toastTimer) clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.className = isError ? 'error show' : 'show';
    el.toast.style.cursor = 'pointer';
    el.toast.title = '点击即可关闭';
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), isError ? 8000 : 3500);
}

el.toast.addEventListener('click', () => {
    if (toastTimer) clearTimeout(toastTimer);
    el.toast.classList.remove('show');
});

function showLoading(text = '处理中...') {
    el.loadingText.textContent = text;
    el.loadingOverlay.style.display = 'flex';
}

function hideLoading() {
    el.loadingOverlay.style.display = 'none';
}

function updatePagination(currentPage, totalPages, totalCount) {
    el.pageInfo.textContent = `第 ${currentPage} / ${totalPages} 页 (共 ${totalCount} 条)`;
    el.prevPageBtn.disabled = currentPage <= 1;
    el.nextPageBtn.disabled = currentPage >= totalPages;
}

// 统一向子模块注入的工具上下文
const moduleContext = {
    showToast,
    showLoading,
    hideLoading,
    updatePagination,
    showConfirm,
    showAlert,
    showPrompt
};

// ==================== 站点 / 存储桶选择器渲染 ====================
// 站点按钮合并成一条胶囊，滑块由 assets/js/capsule-tabs.js 处理（同名，切换栏目重新渲染时会从上次位置滑过去）
function createSiteCapsule() {
    const bar = document.createElement('div');
    bar.className = 'capsule-tabs';
    bar.dataset.capsuleTabs = 'site-selector';
    return bar;
}

function renderDatabaseSelector() {
    el.dbList.innerHTML = '';
    // 只列 sites.config.js 里配置过的数据库
    const key = (state.activeCapsule === 'comments' || state.activeCapsule === 'stats') ? 'commentDb' : 'accountDb';
    const wanted = getResourceNames(key);
    const filteredDbs = state.databases.filter(db => wanted.includes(db.name));

    if (filteredDbs.length === 0) {
        el.dbList.innerHTML = '<span style="font-size: 14px; color: var(--text-secondary);">暂无匹配的数据库</span>';
        return;
    }

    filteredDbs.sort((a, b) => getSiteSortOrder(a.name) - getSiteSortOrder(b.name));

    // 如果之前已有选中的并且在列表中，保留；否则默认选中第一个站点
    const exists = filteredDbs.find(d => d.uuid === state.currentDb.id);
    const targetDb = exists || filteredDbs[0];

    const bar = createSiteCapsule();
    filteredDbs.forEach((db) => {
        const btn = document.createElement('button');
        btn.className = `db-btn ${db.uuid === targetDb.uuid ? 'active' : ''}`;
        btn.textContent = getSiteDisplayName(db.name);
        btn.dataset.uuid = db.uuid;
        btn.dataset.name = db.name;
        btn.addEventListener('click', () => selectDatabase(db.uuid, db.name, true));
        bar.appendChild(btn);
    });
    el.dbList.appendChild(bar);

    // 仅更新状态，不重复触发网络请求
    selectDatabase(targetDb.uuid, targetDb.name, false);
}

function selectDatabase(uuid, name, triggerChange = true) {
    document.querySelectorAll('.db-btn').forEach(btn => {
        if (btn.dataset.uuid === uuid) btn.classList.add('active');
        else btn.classList.remove('active');
    });

    state.currentDb = { id: uuid, name };
    if (triggerChange) {
        const curModule = CAPSULES[state.activeCapsule];
        if (curModule?.onSiteChange) {
            curModule.onSiteChange(state.currentDb);
        }
    }
}

// 存储桶列表只拉一次（登录后会在后台预读）
let bucketsPromise = null;
function ensureStorageBuckets() {
    if (state.storageBuckets && state.storageBuckets.length) return Promise.resolve(state.storageBuckets);
    if (!bucketsPromise) {
        bucketsPromise = (async () => {
            let buckets = [];
            try {
                const res = await cfRequest('/r2/buckets');
                buckets = res.result?.buckets || [];
            } catch (e) {
                buckets = getResourceNames('bucket').map(name => ({ name }));
            }
            // 只列 sites.config.js 里配置过的存储桶
            const wantedBuckets = getResourceNames('bucket');
            buckets = buckets.filter(b => wantedBuckets.includes(b.name));
            buckets.sort((a, b) => getSiteSortOrder(a.name) - getSiteSortOrder(b.name));
            state.storageBuckets = buckets;
            return buckets;
        })().finally(() => { bucketsPromise = null; });
    }
    return bucketsPromise;
}

// 登录后空闲时预读「文件分享」默认存储桶的根目录，切过去时不用再等网络
function prefetchStorage() {
    const run = async () => {
        const buckets = await ensureStorageBuckets();
        const first = state.currentBucket || buckets[0]?.name;
        if (first) await prefetchStorageDirectory(first, '');
    };
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    idle(() => { run().catch(() => {}); });
}

async function renderStorageSelector() {
    el.dbList.innerHTML = '<span style="font-size: 14px; color: var(--text-secondary);">正在加载存储桶...</span>';

    try {
        await ensureStorageBuckets();

        el.dbList.innerHTML = '';

        if (state.storageBuckets.length === 0) {
            el.dbList.innerHTML = '<span style="font-size: 14px; color: var(--text-secondary);">未找到 R2 存储桶</span>';
            return;
        }

        const targetBucket = state.currentBucket || state.storageBuckets[0].name;

        const bar = createSiteCapsule();
        state.storageBuckets.forEach((bucket) => {
            const btn = document.createElement('button');
            btn.className = `db-btn ${bucket.name === targetBucket ? 'active' : ''}`;
            btn.textContent = getSiteDisplayName(bucket.name);
            btn.dataset.name = bucket.name;
            btn.addEventListener('click', () => selectStorageBucket(bucket.name, true));
            bar.appendChild(btn);
        });
        el.dbList.appendChild(bar);

        selectStorageBucket(targetBucket, false);
    } catch (err) {
        el.dbList.innerHTML = `<span style="font-size: 14px; color: var(--danger-color);">加载存储桶失败: ${err.message}</span>`;
    }
}

function selectStorageBucket(bucketName, triggerChange = true) {
    document.querySelectorAll('.db-btn').forEach(btn => {
        if (btn.dataset.name === bucketName) btn.classList.add('active');
        else btn.classList.remove('active');
    });

    state.currentBucket = bucketName;
    if (triggerChange) {
        const curModule = CAPSULES[state.activeCapsule];
        if (curModule?.onSiteChange) {
            curModule.onSiteChange(state.currentBucket);
        }
    }
}

// ==================== 五大胶囊路由切换中枢 ====================
async function switchCapsule(targetCapsule) {
    if (!CAPSULES[targetCapsule]) return;

    // 1. 卸载上一业务胶囊
    const prevModule = CAPSULES[state.activeCapsule];
    if (prevModule?.unmount) {
        prevModule.unmount();
    }

    state.activeCapsule = targetCapsule;

    // 2. 更新胶囊 Tab 高亮（滑块动画由 assets/js/capsule-tabs.js 处理）
    Object.keys(el.capsuleBtns).forEach(key => {
        if (key === targetCapsule) {
            el.capsuleBtns[key].classList.add('active');
            // 移动端在胶囊横向滚动时自动平滑居中选中的 Tab
            if (typeof el.capsuleBtns[key].scrollIntoView === 'function') {
                el.capsuleBtns[key].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
        } else {
            el.capsuleBtns[key].classList.remove('active');
        }
    });

    // 3. 清空通用搜索输入框
    el.keywordSearch.value = '';

    // 4. 模式调度处理
    if (targetCapsule === 'ai') {
        // AI Hub 独立面板模式
        el.dbSelectorWrapper.style.display = 'none';
        el.toolbar.style.display = 'none';
        el.tableContainer.style.display = 'none';
        el.pagination.style.display = 'none';

        await CAPSULES.ai.mount();
        return;
    }

    // 常规业务面板通用结构激活
    el.aiHubContainer.style.display = 'none';
    el.dbSelectorWrapper.style.display = 'block';
    el.toolbar.style.display = 'flex';
    el.tableContainer.style.display = 'block';

    if (targetCapsule === 'storage') {
        el.selectorLabel.textContent = '选择目标存储桶:';
        el.pagination.style.display = 'none';
        el.exportBtn.style.display = 'none';
        el.batchDelBtn.style.display = 'inline-block';
        el.refreshStorageBtn.style.display = 'inline-block';

        await renderStorageSelector();
        await CAPSULES.storage.mount(state.currentBucket);
    } else {
        el.selectorLabel.textContent = '选择目标数据库:';
        el.pagination.style.display = 'flex';
        el.exportBtn.style.display = 'inline-block';
        el.batchDelBtn.style.display = 'inline-block';
        el.refreshStorageBtn.style.display = 'none';

        renderDatabaseSelector();
        const curDb = state.currentDb.id ? state.currentDb : null;
        if (curDb) {
            await CAPSULES[targetCapsule].mount(curDb);
        }
    }
}

// ==================== 认证登录与会话初始化 ====================
async function handleLogin() {
    const accId = el.accountIdInput.value.trim();
    const token = el.apiTokenInput.value.trim();
    if (!accId || !token) return showToast('请填写 Account ID 和 API Token', true);

    el.loginBtn.disabled = true;
    el.loginBtn.querySelector('.loader').style.display = 'block';
    el.loginBtn.querySelector('.btn-text').style.display = 'none';

    try {
        const dbs = await connectD1(accId, token);
        state.databases = dbs;
        StorageModule.setDatabases(dbs);
        enterMainSystem();
    } catch (err) {
        showToast(`连接失败: ${err.message}`, true);
    } finally {
        el.loginBtn.disabled = false;
        el.loginBtn.querySelector('.loader').style.display = 'none';
        el.loginBtn.querySelector('.btn-text').style.display = 'block';
    }
}

function enterMainSystem() {
    el.authSection.style.display = 'none';
    el.mainSection.style.display = 'block';
    if (el.logoutBtn) el.logoutBtn.style.display = 'block';
    showToast('安全连接成功！');

    // 静默从 Pages 环境变量同步 R2 S3 专线上传凭据
    const savedToken = localStorage.getItem('cf_api_token');
    if (savedToken) {
        syncS3CredentialsFromServer(savedToken).catch(() => {});
    }

    // 默认打开第一个栏目：开启 AI Hub 时是 AI Hub，否则是文件管理
    switchCapsule(state.activeCapsule);
    prefetchStorage();
}

// ==================== 全局通用交互事件绑定 ====================
function initGlobalEvents() {
    // 登录与登出
    el.loginBtn.addEventListener('click', handleLogin);
    if (el.logoutBtn) {
        el.logoutBtn.addEventListener('click', logout);
    }

    // 5 大胶囊切换按钮
    Object.keys(el.capsuleBtns).forEach(capsuleKey => {
        const btn = el.capsuleBtns[capsuleKey];
        if (btn) {
            btn.addEventListener('click', () => switchCapsule(capsuleKey));
        }
    });

    // 搜索过滤联动
    let searchDebounceTimer = null;
    el.keywordSearch.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            const cur = CAPSULES[state.activeCapsule];
            if (cur?.search) cur.search(e.target.value.trim());
        }, 300);
    });

    // 批量删除联动
    el.batchDelBtn.addEventListener('click', () => {
        const cur = CAPSULES[state.activeCapsule];
        if (cur?.deleteSelected) cur.deleteSelected();
    });

    // 导出 CSV 联动
    el.exportBtn.addEventListener('click', () => {
        const cur = CAPSULES[state.activeCapsule];
        if (cur?.exportCSV) cur.exportCSV();
    });

    // 分页联动
    el.prevPageBtn.addEventListener('click', () => {
        const cur = CAPSULES[state.activeCapsule];
        if (cur?.setPage) {
            const pageText = el.pageInfo.textContent.match(/第 (\d+) \//);
            const curP = pageText ? parseInt(pageText[1]) : 1;
            if (curP > 1) cur.setPage(curP - 1);
        }
    });

    el.nextPageBtn.addEventListener('click', () => {
        const cur = CAPSULES[state.activeCapsule];
        if (cur?.setPage) {
            const pageText = el.pageInfo.textContent.match(/第 (\d+) \/ (\d+) 页/);
            const curP = pageText ? parseInt(pageText[1]) : 1;
            const maxP = pageText ? parseInt(pageText[2]) : 1;
            if (curP < maxP) cur.setPage(curP + 1);
        }
    });

    // 文件上传唤起
    if (el.uploadFileBtn && el.fileUploadInput) {
        el.uploadFileBtn.addEventListener('click', () => {
            el.fileUploadInput.click();
        });
    }

    // 存储目录手动刷新
    if (el.refreshStorageBtn) {
        el.refreshStorageBtn.addEventListener('click', () => {
            if (state.activeCapsule === 'storage') {
                StorageModule.refresh();
            }
        });
    }

    // 全局 ESC 键关闭活动模态框 (阻断保护重要表单，零抖动安静稳定)
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-overlay').forEach(modal => {
                if (modal.style.display !== 'none' && window.getComputedStyle(modal).display !== 'none') {
                    // 如果带有 data-static="true"，阻断 ESC 关闭以保护已填写草稿，静默不晃动
                    if (modal.dataset.static === 'true') {
                        return;
                    }
                    modal.style.display = 'none';
                }
            });
        }
    });

    // 全局点击背景遮罩空白处关闭模态框 (普通弹窗空白处关闭；带 data-static="true" 弹窗阻断误触关闭，绝对静止零抖动)
    document.addEventListener('click', (e) => {
        if (e.target && e.target.classList && e.target.classList.contains('modal-overlay')) {
            const modal = e.target;
            // 如果带有 data-static="true"，阻断点击空白关闭以保护编辑草稿，静默不晃动
            if (modal.dataset.static === 'true') {
                return;
            }
            modal.style.display = 'none';
        }
    });

    // 阻止浏览器全局拖拽文件导致意外打开/跳转的默认行为
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
}

// ==================== 夜空与星空粒子动效 ====================
let starsContainer = null;

function createSkyStars() {
    if (!starsContainer) {
        starsContainer = document.createElement('div');
        starsContainer.className = 'stars-container';
        starsContainer.id = 'sky-stars-container';
        document.body.appendChild(starsContainer);
    }
    starsContainer.innerHTML = '';
    for (let i = 0; i < 35; i++) {
        const star = document.createElement('div');
        star.className = 'star';
        const size = (Math.random() * 1.5 + 1).toFixed(1);
        star.style.cssText = `
            width: ${size}px;
            height: ${size}px;
            top: ${(Math.random() * 100).toFixed(1)}%;
            left: ${(Math.random() * 100).toFixed(1)}%;
            animation-delay: ${(Math.random() * 3).toFixed(1)}s;
            animation-duration: ${(Math.random() * 5 + 4).toFixed(1)}s;
        `;
        starsContainer.appendChild(star);
    }
}

function clearSkyStars() {
    if (starsContainer) {
        starsContainer.remove();
        starsContainer = null;
    }
}

function applyTheme(isDark) {
    document.documentElement.classList.remove('day-theme', 'night-theme');
    document.documentElement.classList.add(isDark ? 'night-theme' : 'day-theme');
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

    if (isDark) createSkyStars();
    else clearSkyStars();
}

function initTheme() {
    const savedTheme = localStorage.getItem('fp_theme');
    const isDark = savedTheme ? (savedTheme === 'dark') : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    applyTheme(isDark);

    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            // 若用户未手动指定偏好，跟随系统设置动态切换
            if (!localStorage.getItem('fp_theme')) {
                applyTheme(e.matches);
            }
        });
    }
}

// ==================== 按 sites.config.js 调整界面 ====================
function applyPanelConfig() {
    const title = PANEL.title || 'FlarePanel';
    document.title = title;
    document.querySelectorAll('.navbar-title').forEach(n => { n.textContent = title; });
    const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (appleTitle) appleTitle.setAttribute('content', title);

    const replyLabel = document.querySelector('label[for="reply-content"]');
    if (replyLabel) replyLabel.textContent = `回复内容（将以「${PANEL.adminName || '站长'}」身份回复）`;

    // 没开 AI Hub 就隐藏这个栏目
    if (!AI_HUB.enabled && el.capsuleBtns.ai) {
        el.capsuleBtns.ai.remove();
        delete el.capsuleBtns.ai;
    }
    // 某类资源一个都没配置，就隐藏对应栏目
    const hideIfEmpty = { storage: 'bucket', comments: 'commentDb', stats: 'commentDb', accounts: 'accountDb' };
    Object.entries(hideIfEmpty).forEach(([capsule, key]) => {
        if (!getResourceNames(key).length && el.capsuleBtns[capsule]) {
            el.capsuleBtns[capsule].remove();
            delete el.capsuleBtns[capsule];
        }
    });
    if (AI_HUB.enabled) state.activeCapsule = 'ai';
    else state.activeCapsule = ['storage', 'comments', 'stats', 'accounts'].find(k => el.capsuleBtns[k]) || 'storage';
}

// ==================== 系统总装启动 ====================
async function initSystem() {
    applyPanelConfig();
    initTheme();
    initGlobalEvents();

    // 初始化五大业务控制器
    CommentsModule.init(moduleContext);
    AccountsModule.init(moduleContext);
    StatsModule.init(moduleContext);
    StorageModule.init(moduleContext, state.databases);
    AiHubModule.init(moduleContext);

    // 检查本地是否已保存 Cloudflare 凭据
    const saved = loadSavedCredentials();
    if (saved) {
        el.accountIdInput.value = saved.accountId;
        el.apiTokenInput.value = saved.apiToken;
        showLoading('正在自动验证已保存的凭证...');
        try {
            const dbs = await connectD1(saved.accountId, saved.apiToken);
            state.databases = dbs;
            StorageModule.setDatabases(dbs);
            enterMainSystem();
        } catch (err) {
            showToast(`自动登录失败: ${err.message}`, true);
        } finally {
            hideLoading();
        }
    }
}

// 启动管理系统
initSystem();
