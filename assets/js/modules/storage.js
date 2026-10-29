// ====================================================
// 业务胶囊 4: 文件分享业务控制器 (Storage Module Controller)
// 负责 R2 对象存储资产、虚拟目录穿梭、重命名、跨目录移动、D1下载量同步与上传
// ====================================================

import {
    queryDatabase,
    cfRequest,
    renameR2Object,
    moveR2Object,
    renameR2Folder,
    deleteR2Folder,
    deleteR2Object,
    putR2Object,
    listR2Objects
} from '../api.js';
import { uploadManager } from '../upload-manager.js';
import { showConfirm, showAlert, showPrompt } from '../dialog.js';
import { escapeHtml, escapeAttr } from '../utils.js';
import { getBucketDomain, getBucketDbName, getResourceNames } from '../sites.js';
import { t, formatNumber, getLocale } from '../i18n.js';

let ctx = null; // 上下文工具：{ showToast, showLoading, hideLoading }
let databasesList = []; // 全局 D1 数据库列表，用于匹配 matchedDbId

let currentBucket = getResourceNames('bucket')[0] || '';
let currentPrefix = ''; // 当前所在路径，如 "apps/android/"，根目录为空字符串 ""
let folders = [];
let files = [];
let searchKeyword = '';
let sortBy = 'name'; // 'name' | 'size' | 'downloads' | 'uploaded'
let sortOrder = 'ASC'; // 'ASC' | 'DESC'
let modalTarget = null; // { type: 'file' | 'folder', path: '', name: '' }
let isStorageActive = false;

export function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '-';
        return d.toLocaleString(getLocale(), {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });
    } catch (e) {
        return '-';
    }
}

export function getFileExt(filename) {
    if (!filename) return 'FILE';
    const parts = filename.split('.');
    if (parts.length > 1) {
        const ext = parts.pop().trim().toUpperCase();
        if (ext) return ext.slice(0, 6);
    }
    return 'FILE';
}

export function getMatchedDbId(bucketName, databases) {
    const dbName = getBucketDbName(bucketName);
    if (!dbName) return null;
    const found = databases.find(db => db.name === dbName);
    return found ? found.uuid : null;
}

// 批量查询当前目录下的 D1 历史下载量
async function fetchDownloadCounts(dbId, fileKeys) {
    if (!dbId || !fileKeys || fileKeys.length === 0) return {};
    try {
        // D1 单条语句最多绑定 100 个参数，文件多时分批并行查询
        const chunks = [];
        for (let i = 0; i < fileKeys.length; i += 90) chunks.push(fileKeys.slice(i, i + 90));
        const results = await Promise.all(chunks.map(keys => {
            const placeholders = keys.map(() => '?').join(',');
            const sql = `SELECT file_path, downloads FROM file_downloads WHERE file_path IN (${placeholders})`;
            return queryDatabase(dbId, sql, keys);
        }));
        const map = {};
        results.forEach(res => {
            (res.result?.[0]?.results || []).forEach(r => {
                map[r.file_path] = r.downloads;
            });
        });
        return map;
    } catch (err) {
        console.error("Failed to load download stats:", err);
        return {};
    }
}

// 渲染面包屑导航
function renderBreadcrumbUI() {
    const bar = document.getElementById('breadcrumb-bar');
    const content = document.getElementById('breadcrumb-content');
    if (!bar || !content) return;

    bar.style.display = 'flex';

    const segments = currentPrefix.split('/').filter(Boolean);
    let html = `<span class="breadcrumb-item" data-path="" style="cursor: pointer; color: var(--primary-color); font-weight: 600;">${t('storage.root')}</span>`;
    
    let accumulated = '';
    segments.forEach((seg, idx) => {
        accumulated += seg + '/';
        const isLast = idx === segments.length - 1;
        html += ` <span style="color: var(--text-secondary); margin: 0 6px;">/</span> `;
        if (isLast) {
            html += `<span class="breadcrumb-item active" style="font-weight: 600; color: var(--text-primary);">${escapeHtml(seg)}</span>`;
        } else {
            html += `<span class="breadcrumb-item" data-path="${escapeAttr(accumulated)}" style="cursor: pointer; color: var(--primary-color); font-weight: 500;">${escapeHtml(seg)}</span>`;
        }
    });

    content.innerHTML = html;

    content.querySelectorAll('.breadcrumb-item').forEach(item => {
        item.onclick = () => {
            const targetPath = item.dataset.path;
            if (targetPath !== undefined && targetPath !== currentPrefix) {
                currentPrefix = targetPath;
                searchKeyword = '';
                const searchInput = document.getElementById('keyword-search');
                if (searchInput) searchInput.value = '';
                loadStorageDirectoryData();
            }
        };
    });
}

// 渲染存储表格内容
function renderStorageTableHTML() {
    const tbody = document.getElementById('data-tbody');
    if (!tbody) return;

    const config = { domain: getBucketDomain(currentBucket) };
    
    const filteredFolders = searchKeyword
        ? folders.filter(f => f.name.toLowerCase().includes(searchKeyword.toLowerCase()))
        : [...folders];
    const filteredFiles = searchKeyword
        ? files.filter(f => f.name.toLowerCase().includes(searchKeyword.toLowerCase()))
        : [...files];

    // 文件夹始终置顶：在按名称排序时遵循升降序，其他维度排序时保持按名称自然升序
    filteredFolders.sort((a, b) => {
        const factor = (sortBy === 'name' && sortOrder === 'DESC') ? -1 : 1;
        return factor * a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });

    // 文件排序：支持名称(拼音/数字自然排序)、大小、累计下载量、修改时间
    filteredFiles.sort((a, b) => {
        let cmp = 0;
        if (sortBy === 'name') {
            cmp = a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
        } else if (sortBy === 'size') {
            cmp = (a.size || 0) - (b.size || 0);
        } else if (sortBy === 'downloads') {
            cmp = (a.downloads || 0) - (b.downloads || 0);
        } else if (sortBy === 'uploaded') {
            const timeA = a.uploaded ? new Date(a.uploaded).getTime() : 0;
            const timeB = b.uploaded ? new Date(b.uploaded).getTime() : 0;
            cmp = timeA - timeB;
        }
        return sortOrder === 'DESC' ? -cmp : cmp;
    });

    if (filteredFolders.length === 0 && filteredFiles.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${t('storage.emptyDir')}</td></tr>`;
        return;
    }

    let html = '';

    // 渲染文件夹行
    filteredFolders.forEach(folder => {
        const shareUrl = `${config.domain}/${folder.fullPath}`;
        html += `
            <tr class="storage-folder-row" data-path="${escapeAttr(folder.fullPath)}">
                <td style="width: 40px; text-align: center;">
                    <input type="checkbox" class="row-check" data-type="folder" data-path="${escapeAttr(folder.fullPath)}" data-name="${escapeAttr(folder.name)}">
                </td>
                <td style="width: 50px; text-align: center;">
                    <span class="ext-tag">DIR</span>
                </td>
                <td>
                    <a href="javascript:void(0)" class="folder-link" data-path="${escapeAttr(folder.fullPath)}" style="font-weight: 600; color: var(--primary-color); text-decoration: none;">
                        ${escapeHtml(folder.name)}/
                    </a>
                </td>
                <td style="color: var(--text-secondary); font-size: 13px;">-</td>
                <td style="color: var(--text-secondary); font-size: 13px;">-</td>
                <td style="color: var(--text-secondary); font-size: 13px;">-</td>
                <td style="text-align: right; white-space: nowrap;">
                    <button class="btn btn-outline btn-sm copy-link-btn" data-url="${escapeAttr(shareUrl)}" title="${t('storage.copyShareTitle')}">${t('storage.copyShare')}</button>
                    <button class="btn btn-outline btn-sm rename-folder-btn" data-name="${escapeAttr(folder.name)}" data-path="${escapeAttr(folder.fullPath)}">${t('storage.rename')}</button>
                    <button class="btn btn-danger btn-sm delete-folder-btn" data-name="${escapeAttr(folder.name)}" data-path="${escapeAttr(folder.fullPath)}">${t('common.delete')}</button>
                </td>
            </tr>
        `;
    });

    // 渲染文件行
    filteredFiles.forEach(file => {
        const directUrl = `${config.domain}/${file.fullPath}`;
        const downloadsText = file.downloads === null
            ? `<span style="color: var(--text-secondary);">…</span>`
            : file.downloads > 0
            ? `<span class="tag" style="background: rgba(16, 185, 129, 0.1); color: var(--success-color); font-weight: 600;">${t('storage.downloads', { count: formatNumber(file.downloads) })}</span>`
            : `<span style="color: var(--text-secondary);">${t('storage.downloads', { count: 0 })}</span>`;
        
        html += `
            <tr class="storage-file-row" data-path="${escapeAttr(file.fullPath)}">
                <td style="width: 40px; text-align: center;">
                    <input type="checkbox" class="row-check" data-type="file" data-path="${escapeAttr(file.fullPath)}" data-name="${escapeAttr(file.name)}">
                </td>
                <td style="width: 50px; text-align: center;">
                    <span class="ext-tag">${escapeHtml(getFileExt(file.name))}</span>
                </td>
                <td>
                    <span style="font-weight: 500; color: var(--text-primary);">${escapeHtml(file.name)}</span>
                </td>
                <td>${file.formattedSize}</td>
                <td>${downloadsText}</td>
                <td style="color: var(--text-secondary); font-size: 13px;">${file.formattedDate}</td>
                <td style="text-align: right; white-space: nowrap;">
                    <button class="btn btn-outline btn-sm copy-link-btn" data-url="${escapeAttr(directUrl)}" title="${t('storage.copyDirectTitle')}">${t('storage.copyDirect')}</button>
                    <button class="btn btn-outline btn-sm move-file-btn" data-name="${escapeAttr(file.name)}" data-path="${escapeAttr(file.fullPath)}">${t('storage.move')}</button>
                    <button class="btn btn-outline btn-sm rename-file-btn" data-name="${escapeAttr(file.name)}" data-path="${escapeAttr(file.fullPath)}">${t('storage.rename')}</button>
                    <button class="btn btn-danger btn-sm delete-file-btn" data-name="${escapeAttr(file.name)}" data-path="${escapeAttr(file.fullPath)}">${t('common.delete')}</button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
    bindStorageTableEvents();
}

function bindStorageTableEvents() {
    const tbody = document.getElementById('data-tbody');
    if (!tbody) return;

    // 进入子文件夹
    tbody.querySelectorAll('.folder-link').forEach(link => {
        link.onclick = (e) => {
            const targetPath = link.dataset.path;
            if (targetPath) {
                currentPrefix = targetPath;
                searchKeyword = '';
                const searchInput = document.getElementById('keyword-search');
                if (searchInput) searchInput.value = '';
                loadStorageDirectoryData();
            }
        };
    });

    // 复制链接
    tbody.querySelectorAll('.copy-link-btn').forEach(btn => {
        btn.onclick = async () => {
            const url = btn.dataset.url;
            if (url) {
                try {
                    await navigator.clipboard.writeText(url);
                    if (ctx?.showToast) ctx.showToast(t('storage.linkCopied'));
                } catch (err) {
                    await showPrompt({
                        title: t('storage.manualCopyTitle'),
                        message: t('storage.manualCopyMessage'),
                        defaultValue: url,
                        confirmText: t('common.confirm')
                    });
                }
            }
        };
    });

    // 重命名
    tbody.querySelectorAll('.rename-file-btn').forEach(btn => {
        btn.onclick = () => openRenameModal('file', btn.dataset.path, btn.dataset.name);
    });
    tbody.querySelectorAll('.rename-folder-btn').forEach(btn => {
        btn.onclick = () => openRenameModal('folder', btn.dataset.path, btn.dataset.name);
    });

    // 移动文件
    tbody.querySelectorAll('.move-file-btn').forEach(btn => {
        btn.onclick = () => openMoveModal(btn.dataset.path, btn.dataset.name);
    });

    // 单个删除文件
    tbody.querySelectorAll('.delete-file-btn').forEach(btn => {
        btn.onclick = async () => {
            const name = btn.dataset.name;
            const path = btn.dataset.path;
            const ok = await showConfirm({
                title: t('storage.deleteFileTitle'),
                message: t('storage.deleteFileMessage', { name }),
                confirmText: t('common.deleteForever'),
                danger: true
            });
            if (!ok) return;

            if (ctx?.showLoading) ctx.showLoading(t('storage.deletingFile'));
            try {
                await deleteR2Object(currentBucket, path);
                if (ctx?.showToast) ctx.showToast(t('storage.fileDeleted'));
                await loadStorageDirectoryData();
            } catch (err) {
                if (ctx?.showToast) ctx.showToast(t('common.deleteFailed', { msg: err.message }), true);
            } finally {
                if (ctx?.hideLoading) ctx.hideLoading();
            }
        };
    });

    // 单个删除文件夹
    tbody.querySelectorAll('.delete-folder-btn').forEach(btn => {
        btn.onclick = async () => {
            const name = btn.dataset.name;
            const path = btn.dataset.path;
            const ok = await showConfirm({
                title: t('storage.deleteFolderTitle'),
                message: t('storage.deleteFolderMessage', { name }),
                confirmText: t('storage.deleteFolderConfirm'),
                danger: true
            });
            if (!ok) return;

            if (ctx?.showLoading) ctx.showLoading(t('storage.deletingFolder'));
            try {
                await deleteR2Folder(currentBucket, path);
                if (ctx?.showToast) ctx.showToast(t('storage.folderDeleted'));
                await loadStorageDirectoryData();
            } catch (err) {
                if (ctx?.showToast) ctx.showToast(t('common.deleteFailed', { msg: err.message }), true);
            } finally {
                if (ctx?.hideLoading) ctx.hideLoading();
            }
        };
    });

    // 联动全选
    const checkAll = document.getElementById('check-all');
    tbody.querySelectorAll('.row-check').forEach(cb => {
        cb.onchange = () => {
            if (checkAll) {
                const allChecks = tbody.querySelectorAll('.row-check');
                const checkedChecks = tbody.querySelectorAll('.row-check:checked');
                checkAll.checked = allChecks.length > 0 && allChecks.length === checkedChecks.length;
            }
        };
    });
}

// 60秒内存快照缓存，实现切回胶囊时 0 毫秒秒开
const CACHE_TTL = 5 * 60 * 1000; // 后台自己的增删改都会强制刷新，这里可以放宽
const storageCache = new Map();

function getStorageCacheKey() {
    return `${currentBucket}_${currentPrefix}`;
}

export function clearStorageCache() {
    storageCache.clear();
}

// 读取某个目录（只列当前一层），下载次数另行补充
async function fetchDirectory(bucket, prefix) {
    const { objects, prefixes } = await listR2Objects(bucket, prefix, { delimiter: '/' });
    const dirFolders = prefixes
        .filter(p => p !== prefix && p.startsWith(prefix))
        .map(p => ({ name: p.slice(prefix.length).replace(/\/$/, ''), fullPath: p }));
    const dirFiles = objects
        .filter(o => o.key && o.key !== prefix && o.key.startsWith(prefix) && o.key.slice(prefix.length) !== '.keep')
        .map(o => {
            const fileDate = o.last_modified || o.uploaded || o.LastModified;
            return {
                name: o.key.slice(prefix.length),
                fullPath: o.key,
                size: o.size,
                formattedSize: formatBytes(o.size),
                uploaded: fileDate,
                formattedDate: formatDate(fileDate),
                downloads: null, // 下载次数稍后补上
                etag: o.etag
            };
        });
    return { folders: dirFolders, files: dirFiles };
}

async function fillDownloadCounts(bucket, dirFiles) {
    const matchedDbId = getMatchedDbId(bucket, databasesList);
    const countMap = await fetchDownloadCounts(matchedDbId, dirFiles.map(f => f.fullPath));
    dirFiles.forEach(f => { f.downloads = countMap[f.fullPath] || 0; });
}

// 后台预读（登录后空闲时调用），切到「文件分享」时直接用缓存
export async function prefetchStorageDirectory(bucket, prefix = '') {
    const key = `${bucket}_${prefix}`;
    if (storageCache.has(key)) return;
    try {
        const dir = await fetchDirectory(bucket, prefix);
        await fillDownloadCounts(bucket, dir.files);
        if (!storageCache.has(key)) storageCache.set(key, { ...dir, time: Date.now() });
    } catch (e) {
        console.warn('Storage prefetch failed (non-fatal):', e.message);
    }
}

let loadSeq = 0;

// 加载当前目录下的文件和文件夹
// 有缓存时先直接显示缓存；缓存过期则在后台刷新，刷新完再更新表格
export async function loadStorageDirectoryData(forceRefresh = false) {
    const tbody = document.getElementById('data-tbody');
    renderBreadcrumbUI();

    const seq = ++loadSeq;
    const bucket = currentBucket;
    const prefix = currentPrefix;
    const cacheKey = getStorageCacheKey();
    const cached = storageCache.get(cacheKey);
    const isCurrent = () => seq === loadSeq && isStorageActive && bucket === currentBucket && prefix === currentPrefix;

    if (!forceRefresh && cached) {
        folders = cached.folders;
        files = cached.files;
        renderStorageTableHTML();
        if (Date.now() - cached.time < CACHE_TTL) return;
    } else if (tbody) {
        if (forceRefresh && (folders.length || files.length)) {
            tbody.style.opacity = '0.55';
        } else {
            tbody.innerHTML = `<tr><td colspan="7" class="empty-state"><span class="loader-inline"></span> ${t('storage.loading')}</td></tr>`;
        }
    }

    try {
        const dir = await fetchDirectory(bucket, prefix);
        if (!isCurrent()) return;

        // 先显示文件列表，下载次数随后补上
        folders = dir.folders;
        files = dir.files;
        renderStorageTableHTML();
        if (tbody) tbody.style.opacity = '1';

        await fillDownloadCounts(bucket, dir.files);
        storageCache.set(`${bucket}_${prefix}`, { ...dir, time: Date.now() });
        if (isCurrent()) renderStorageTableHTML();
    } catch (err) {
        console.error("Storage load error:", err);
        if (tbody && isCurrent()) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--danger-color); padding: 2rem;">${escapeHtml(t('storage.loadFailed', { msg: err.message }))}</td></tr>`;
        }
    } finally {
        if (tbody) tbody.style.opacity = '1';
    }
}

// 模态框：重命名
function openRenameModal(type, path, name) {
    modalTarget = { type, path, name };
    const modal = document.getElementById('rename-modal');
    const title = document.getElementById('rename-modal-title');
    const oldInput = document.getElementById('rename-old-name');
    const input = document.getElementById('rename-new-name') || document.getElementById('rename-input');

    if (title) title.textContent = type === 'folder' ? t('storage.renameFolderTitle', { name }) : t('storage.renameFileTitle', { name });
    if (oldInput) oldInput.value = name;
    if (input) {
        input.value = name;
        modal.style.display = 'flex';
        input.focus();
    }
}

async function submitRename() {
    const input = document.getElementById('rename-new-name') || document.getElementById('rename-input');
    const modal = document.getElementById('rename-modal');
    const newName = input?.value.trim();
    if (!newName) return showAlert({ title: t('dialog.alertTitle'), message: t('storage.enterNewName') });
    if (newName.includes('/')) return showAlert({ title: t('dialog.alertTitle'), message: t('storage.noSlashName') });
    if (!modalTarget) return;

    if (newName === modalTarget.name) {
        if (modal) modal.style.display = 'none';
        return;
    }

    if (modal) modal.style.display = 'none';

    if (ctx?.showLoading) ctx.showLoading(t('storage.renaming'));
    try {
        const matchedDbId = getMatchedDbId(currentBucket, databasesList);
        if (modalTarget.type === 'folder') {
            const parent = modalTarget.path.slice(0, modalTarget.path.lastIndexOf(modalTarget.name + '/'));
            const newPrefix = `${parent}${newName}/`;
            await renameR2Folder(currentBucket, modalTarget.path, newPrefix, matchedDbId);
        } else {
            const parent = modalTarget.path.slice(0, modalTarget.path.lastIndexOf('/') + 1);
            const newKey = `${parent}${newName}`;
            await renameR2Object(currentBucket, modalTarget.path, newKey, matchedDbId);
        }

        clearStorageCache();
        if (ctx?.showToast) ctx.showToast(t('storage.renamed'));
        await loadStorageDirectoryData(true);
    } catch (err) {
        if (ctx?.showToast) ctx.showToast(t('storage.renameFailed', { msg: err.message }), true);
    } finally {
        if (ctx?.hideLoading) ctx.hideLoading();
    }
}

// 模态框：移动文件
function openMoveModal(path, name) {
    modalTarget = { type: 'file', path, name };
    const modal = document.getElementById('move-modal');
    const source = document.getElementById('move-source-path');
    const target = document.getElementById('move-target-dir');

    if (source) source.value = path;
    const currentParent = path.slice(0, path.lastIndexOf('/') + 1);
    if (target) {
        target.value = currentParent;
        modal.style.display = 'flex';
        target.focus();
    }
}

async function submitMove() {
    const target = document.getElementById('move-target-dir');
    const modal = document.getElementById('move-modal');
    const targetDir = target?.value.trim();
    if (!modalTarget) return;

    if (modal) modal.style.display = 'none';

    if (ctx?.showLoading) ctx.showLoading(t('storage.moving'));
    try {
        const matchedDbId = getMatchedDbId(currentBucket, databasesList);
        await moveR2Object(currentBucket, modalTarget.path, targetDir, matchedDbId);
        clearStorageCache();
        if (ctx?.showToast) ctx.showToast(t('storage.moved'));
        await loadStorageDirectoryData(true);
    } catch (err) {
        if (ctx?.showToast) ctx.showToast(t('storage.moveFailed', { msg: err.message }), true);
    } finally {
        if (ctx?.hideLoading) ctx.hideLoading();
    }
}

// 模态框：新建文件夹
function openNewFolderModal() {
    const modal = document.getElementById('new-folder-modal');
    const parentInput = document.getElementById('new-folder-parent');
    const nameInput = document.getElementById('new-folder-name');

    if (parentInput) parentInput.value = currentPrefix ? `/${currentPrefix}` : t('storage.rootLabel');
    if (nameInput) {
        nameInput.value = '';
        modal.style.display = 'flex';
        nameInput.focus();
    }
}

async function submitNewFolder() {
    const nameInput = document.getElementById('new-folder-name');
    const modal = document.getElementById('new-folder-modal');
    const folderName = nameInput?.value.trim();

    if (!folderName) return showAlert({ title: t('dialog.alertTitle'), message: t('storage.enterFolderName') });
    if (folderName.includes('/')) return showAlert({ title: t('dialog.alertTitle'), message: t('storage.noSlashFolder') });

    if (modal) modal.style.display = 'none';

    const folderPrefix = `${currentPrefix}${folderName}/`;
    const keepKey = `${folderPrefix}.keep`;

    if (ctx?.showLoading) ctx.showLoading(t('storage.creatingFolder'));
    try {
        const emptyBuffer = new ArrayBuffer(0);
        await putR2Object(currentBucket, keepKey, emptyBuffer, 'application/octet-stream');
        clearStorageCache();
        if (ctx?.showToast) ctx.showToast(t('storage.folderCreated', { name: folderName }));
        await loadStorageDirectoryData(true);
    } catch (err) {
        if (ctx?.showToast) ctx.showToast(t('storage.createFailed', { msg: err.message }), true);
    } finally {
        if (ctx?.hideLoading) ctx.hideLoading();
    }
}

// 文件上传处理
function handleFileUpload(e) {
    const filesList = Array.from(e.target.files || []);
    if (filesList.length === 0) return;

    if (!currentBucket) {
        if (ctx?.showToast) ctx.showToast(t('storage.selectBucket'), true);
        return;
    }

    uploadManager.addFiles(filesList, currentBucket, currentPrefix);
    if (ctx?.showToast) ctx.showToast(t('storage.queued', { count: filesList.length }), false);
    e.target.value = '';
}

// 拖拽上传支持 (Drag & Drop)
function initStorageDragAndDrop() {
    const dropZone = document.getElementById('table-container');
    if (!dropZone || dropZone._dragDropBound) return;
    dropZone._dragDropBound = true;

    let dragCounter = 0;

    dropZone.addEventListener('dragenter', (e) => {
        if (!isStorageActive || !currentBucket) return;
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        dropZone.style.outline = '2px dashed var(--primary-color)';
        dropZone.style.outlineOffset = '-4px';
        dropZone.style.transition = 'outline 0.15s ease';
    });

    dropZone.addEventListener('dragover', (e) => {
        if (!isStorageActive || !currentBucket) return;
        e.preventDefault();
        e.stopPropagation();
    });

    dropZone.addEventListener('dragleave', (e) => {
        if (!isStorageActive || !currentBucket) return;
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            dropZone.style.outline = '';
            dropZone.style.outlineOffset = '';
        }
    });

    dropZone.addEventListener('drop', (e) => {
        if (!isStorageActive || !currentBucket) return;
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        dropZone.style.outline = '';
        dropZone.style.outlineOffset = '';

        const dt = e.dataTransfer;
        const filesList = dt ? Array.from(dt.files) : [];
        if (filesList.length === 0) return;

        uploadManager.addFiles(filesList, currentBucket, currentPrefix);
        if (ctx?.showToast) ctx.showToast(t('storage.queuedDrop', { count: filesList.length }), false);
    });
}

// 初始化模态框与上传按钮绑定
function initStorageModalBindings() {
    // 重命名
    const submitRenameBtn = document.getElementById('submit-rename-btn');
    const cancelRenameBtn = document.getElementById('close-rename-btn');
    if (submitRenameBtn) submitRenameBtn.onclick = submitRename;
    if (cancelRenameBtn) {
        cancelRenameBtn.onclick = () => {
            const modal = document.getElementById('rename-modal');
            if (modal) modal.style.display = 'none';
        };
    }
    const renameNewInput = document.getElementById('rename-new-name');
    if (renameNewInput) {
        renameNewInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitRename();
        });
    }

    // 移动
    const submitMoveBtn = document.getElementById('submit-move-btn');
    const cancelMoveBtn = document.getElementById('close-move-btn');
    if (submitMoveBtn) submitMoveBtn.onclick = submitMove;
    if (cancelMoveBtn) {
        cancelMoveBtn.onclick = () => {
            const modal = document.getElementById('move-modal');
            if (modal) modal.style.display = 'none';
        };
    }
    const moveTargetInput = document.getElementById('move-target-dir');
    if (moveTargetInput) {
        moveTargetInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitMove();
        });
    }

    // 新建文件夹
    const newFolderBtn = document.getElementById('new-folder-btn');
    const submitFolderBtn = document.getElementById('submit-new-folder-btn');
    const cancelFolderBtn = document.getElementById('close-new-folder-btn');
    if (newFolderBtn) newFolderBtn.onclick = openNewFolderModal;
    if (submitFolderBtn) submitFolderBtn.onclick = submitNewFolder;
    if (cancelFolderBtn) {
        cancelFolderBtn.onclick = () => {
            const modal = document.getElementById('new-folder-modal');
            if (modal) modal.style.display = 'none';
        };
    }
    const newFolderInput = document.getElementById('new-folder-name');
    if (newFolderInput) {
        newFolderInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitNewFolder();
        });
    }

    // 上传文件
    const uploadInput = document.getElementById('file-upload-input');
    if (uploadInput) uploadInput.onchange = handleFileUpload;

    // 初始化拖拽上传
    initStorageDragAndDrop();

    // 上传完成后自动刷新当前列表（强制拉取最新数据，绕过快照缓存）
    uploadManager.onTaskComplete = () => {
        loadStorageDirectoryData(true);
    };
}

export const StorageModule = {
    init(context, dbs) {
        ctx = context;
        databasesList = dbs || [];
        initStorageModalBindings();
    },

    setDatabases(dbs) {
        databasesList = dbs || [];
    },

    setupHeaders() {
        const thead = document.getElementById('data-thead');
        if (!thead) return;

        const getSortClass = (field) => {
            if (sortBy !== field) return '';
            return sortOrder === 'DESC' ? 'sort-desc' : 'sort-asc';
        };

        thead.innerHTML = `
            <tr>
                <th style="width: 40px; text-align: center;"><input type="checkbox" id="check-all"></th>
                <th style="width: 50px; text-align: center;">${t('storage.colType')}</th>
                <th id="storage-sort-name" class="storage-sortable-header ${getSortClass('name')}" title="${escapeAttr(t('storage.sortBy', { label: t('storage.colName') }))}">${t('storage.colName')}</th>
                <th id="storage-sort-size" class="storage-sortable-header ${getSortClass('size')}" title="${escapeAttr(t('storage.sortBy', { label: t('storage.colSize') }))}">${t('storage.colSize')}</th>
                <th id="storage-sort-downloads" class="storage-sortable-header ${getSortClass('downloads')}" title="${escapeAttr(t('storage.sortBy', { label: t('storage.colDownloads') }))}">${t('storage.colDownloads')}</th>
                <th id="storage-sort-uploaded" class="storage-sortable-header ${getSortClass('uploaded')}" title="${escapeAttr(t('storage.sortBy', { label: t('storage.colModified') }))}">${t('storage.colModified')}</th>
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

        const sortHeaders = [
            { id: 'storage-sort-name', field: 'name', defaultOrder: 'ASC' },
            { id: 'storage-sort-size', field: 'size', defaultOrder: 'DESC' },
            { id: 'storage-sort-downloads', field: 'downloads', defaultOrder: 'DESC' },
            { id: 'storage-sort-uploaded', field: 'uploaded', defaultOrder: 'DESC' }
        ];

        sortHeaders.forEach(({ id, field, defaultOrder }) => {
            const th = document.getElementById(id);
            if (th) {
                th.onclick = () => {
                    if (sortBy === field) {
                        sortOrder = sortOrder === 'ASC' ? 'DESC' : 'ASC';
                    } else {
                        sortBy = field;
                        sortOrder = defaultOrder;
                    }
                    StorageModule.setupHeaders();
                    renderStorageTableHTML();
                };
            }
        });
    },

    async mount(bucketName) {
        isStorageActive = true;
        currentBucket = bucketName || getResourceNames('bucket')[0] || '';
        currentPrefix = '';
        searchKeyword = '';

        this.setupHeaders();

        // 呈现文件操作按钮
        const uploadBtn = document.getElementById('upload-file-btn');
        const newFolderBtn = document.getElementById('new-folder-btn');
        if (uploadBtn) uploadBtn.style.display = 'inline-block';
        if (newFolderBtn) newFolderBtn.style.display = 'inline-block';

        await loadStorageDirectoryData();
    },

    unmount() {
        isStorageActive = false;
        const bar = document.getElementById('breadcrumb-bar');
        if (bar) bar.style.display = 'none';

        const uploadBtn = document.getElementById('upload-file-btn');
        const newFolderBtn = document.getElementById('new-folder-btn');
        if (uploadBtn) uploadBtn.style.display = 'none';
        if (newFolderBtn) newFolderBtn.style.display = 'none';

        ['rename-modal', 'move-modal', 'new-folder-modal'].forEach(id => {
            const m = document.getElementById(id);
            if (m) m.style.display = 'none';
        });
    },

    async onSiteChange(bucketName) {
        currentBucket = bucketName || getResourceNames('bucket')[0] || '';
        currentPrefix = '';
        searchKeyword = '';
        await loadStorageDirectoryData();
    },

    async refresh() {
        const btn = document.getElementById('refresh-storage-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = t('storage.refreshing');
        }
        clearStorageCache();
        try {
            await loadStorageDirectoryData(true);
            if (ctx?.showToast) ctx.showToast(t('storage.refreshed'));
        } catch (err) {
            if (ctx?.showToast) ctx.showToast(t('storage.refreshFailed', { msg: err.message }), true);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = t('toolbar.refresh');
            }
        }
    },

    async search(kw) {
        searchKeyword = kw;
        renderStorageTableHTML();
    },

    async deleteSelected() {
        const checkboxes = document.querySelectorAll('.row-check:checked');
        if (checkboxes.length === 0) {
            return ctx?.showToast ? ctx.showToast(t('storage.selectFirst'), true) : null;
        }

        const items = Array.from(checkboxes).map(cb => ({
            type: cb.dataset.type,
            path: cb.dataset.path,
            name: cb.dataset.name
        }));

        const count = items.length;
        const ok = await showConfirm({
            title: t('storage.batchTitle'),
            message: t('storage.batchMessage', { count }),
            confirmText: t('common.batchDelete'),
            danger: true
        });
        if (!ok) return;

        if (ctx?.showLoading) ctx.showLoading(t('storage.batchDeleting', { count }));
        try {
            for (const item of items) {
                if (item.type === 'folder') {
                    await deleteR2Folder(currentBucket, item.path);
                } else {
                    await deleteR2Object(currentBucket, item.path);
                }
            }
            clearStorageCache();
            if (ctx?.showToast) ctx.showToast(t('common.batchDeleteSuccess'));
            await loadStorageDirectoryData(true);
        } catch (err) {
            if (ctx?.showToast) ctx.showToast(t('common.batchDeleteFailed', { msg: err.message }), true);
        } finally {
            if (ctx?.hideLoading) ctx.hideLoading();
        }
    }
};
