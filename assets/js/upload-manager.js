import { uploadR2ObjectWithProgress } from './api.js';
import { getFileExt, escapeHtml } from './utils.js';
import { R2S3Client } from './s3-signer.js';
import { showConfirm } from './dialog.js';
import { t, langHeaders } from './i18n.js';

// 默认内置的 R2 S3 专线凭证（清空明文硬编码，优先从 Pages 环境变量或本地缓存加载）
const DEFAULT_S3_CREDS = {
    accessKeyId: '',
    secretAccessKey: ''
};

export async function syncS3CredentialsFromServer(apiToken) {
    if (!apiToken) return null;
    try {
        const res = await fetch('/api/s3-credentials', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                ...langHeaders()
            }
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.success && data.accessKeyId && data.secretAccessKey) {
            saveS3Credentials({
                accessKeyId: data.accessKeyId,
                secretAccessKey: data.secretAccessKey
            });
            return {
                accessKeyId: data.accessKeyId,
                secretAccessKey: data.secretAccessKey
            };
        }
    } catch (e) {
        console.warn('Failed to load S3 credentials from Pages env:', e.message);
    }
    return null;
}

export function getS3Credentials() {
    try {
        const raw = localStorage.getItem('cf_s3_credentials');
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.accessKeyId && parsed.secretAccessKey) {
                return parsed;
            }
        }
    } catch (e) {}
    return DEFAULT_S3_CREDS;
}

export function saveS3Credentials(creds) {
    if (creds && creds.accessKeyId && creds.secretAccessKey) {
        localStorage.setItem('cf_s3_credentials', JSON.stringify(creds));
    } else {
        localStorage.removeItem('cf_s3_credentials');
    }
}

class UploadManager {
    constructor() {
        this.tasks = [];
        this.concurrency = 2;
        this.activeCount = 0;
        this.isMinimized = false;
        this.onCompleteCallback = null;
        if (typeof document !== 'undefined') {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.ensureUI());
            } else {
                this.ensureUI();
            }
        }
    }

    setOnComplete(cb) {
        this.onCompleteCallback = cb;
    }

    ensureUI() {
        if (document.getElementById('upload-manager-dock')) return true;
        if (!document.body) return false;

        const dock = document.createElement('div');
        dock.id = 'upload-manager-dock';
        dock.className = 'upload-dock';
        dock.style.display = 'none';

        dock.innerHTML = `
            <div class="upload-dock-header">
                <div class="upload-dock-title" id="upload-dock-title">
                    <span class="upload-dock-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg></span>
                    <span class="upload-dock-text" id="upload-dock-text">${t('upload.dockTitle', { done: 0, total: 0 })}</span>
                </div>
                <div class="upload-dock-actions">
                    <button class="upload-dock-btn" id="upload-dock-toggle" title="${t('upload.toggle')}" aria-label="${t('upload.toggle')}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                    </button>
                    <button class="upload-dock-btn" id="upload-dock-close" title="${t('upload.clearClose')}" aria-label="${t('upload.clearClose')}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
            </div>
            <div class="upload-dock-body" id="upload-dock-body">
                <div class="upload-task-list" id="upload-task-list"></div>
            </div>
            <div class="upload-dock-capsule" id="upload-dock-capsule" style="display: none;">
                <span class="capsule-spinner"></span>
                <span class="capsule-text" id="capsule-text">${t('upload.capsuleUploading', { percent: 0, current: 0, total: 0 })}</span>
            </div>
        `;

        document.body.appendChild(dock);

        // 事件绑定
        document.getElementById('upload-dock-toggle')?.addEventListener('click', () => this.toggleMinimize());
        document.getElementById('upload-dock-capsule')?.addEventListener('click', () => this.toggleMinimize(false));
        document.getElementById('upload-dock-close')?.addEventListener('click', () => this.clearOrClose());

        // 鼠标悬浮时暂停自动关闭，移出后如果全部已完成则再次启动倒计时
        dock.addEventListener('mouseenter', () => this.cancelAutoClose());
        dock.addEventListener('mouseleave', () => {
            const hasUploading = this.tasks.some(tk => tk.status === 'uploading' || tk.status === 'pending');
            if (!hasUploading && this.tasks.length > 0 && this.tasks.every(tk => tk.status === 'success')) {
                this.scheduleAutoClose();
            }
        });
        return true;
    }

    addFiles(files, bucketName, currentPrefix) {
        if (!files || files.length === 0) return;
        this.cancelAutoClose();
        this.ensureUI();
        const dock = document.getElementById('upload-manager-dock');
        if (dock) {
            dock.style.opacity = '1';
            dock.style.transform = 'translateY(0)';
        }

        const newTasks = Array.from(files).map((file, idx) => {
            const key = `${currentPrefix}${file.name}`;
            return {
                id: 'task_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 6),
                file: file,
                bucketName: bucketName,
                key: key,
                name: file.name,
                size: file.size,
                status: 'pending', // 'pending' | 'uploading' | 'success' | 'error' | 'aborted'
                progress: 0,
                speed: 0,
                loaded: 0,
                errorMsg: '',
                controller: new AbortController()
            };
        });

        this.tasks.push(...newTasks);
        this.render();
        this.processQueue();
    }

    processQueue() {
        if (this.activeCount >= this.concurrency) return;

        const nextTask = this.tasks.find(tk => tk.status === 'pending');
        if (!nextTask) {
            this.checkAllCompleted();
            return;
        }

        this.startTask(nextTask);
    }

    async startTask(task) {
        this.activeCount++;
        task.status = 'uploading';
        task.controller = new AbortController();
        task.startTime = Date.now();
        this.render();

        try {
            let s3Creds = getS3Credentials();
            if ((!s3Creds || !s3Creds.accessKeyId) && typeof localStorage !== 'undefined') {
                const token = localStorage.getItem('cf_api_token');
                if (token) {
                    const synced = await syncS3CredentialsFromServer(token);
                    if (synced) s3Creds = synced;
                }
            }
            const isLargeFile = task.size >= 50 * 1024 * 1024; // 50MB 以上

            // 如果是大文件且未配置 S3 凭据，且超过 95MB
            if (task.size > 95 * 1024 * 1024 && (!s3Creds || !s3Creds.accessKeyId)) {
                throw new Error(t('upload.tooLarge'));
            }

            // 优先判断是否启用 S3 分片上传（大文件或配置了 S3）
            if (s3Creds && s3Creds.accessKeyId && s3Creds.secretAccessKey && isLargeFile) {
                await this.uploadViaS3Multipart(task, s3Creds);
            } else {
                // 普通小文件或未配置 S3 时走标准极速直传
                await uploadR2ObjectWithProgress({
                    bucketName: task.bucketName,
                    key: task.key,
                    file: task.file,
                    signal: task.controller.signal,
                    onProgress: ({ loaded, total, percent, speed }) => {
                        task.loaded = loaded;
                        task.progress = percent;
                        task.speed = speed;
                        this.updateTaskUI(task);
                        this.updateCapsuleUI();
                    }
                });
            }

            task.status = 'success';
            task.progress = 100;
            task.speed = 0;

            // 单个任务上传成功后立即通知外部模块刷新
            if (typeof this.onTaskComplete === 'function') {
                try { this.onTaskComplete(task); } catch (e) { console.error(e); }
            }
        } catch (err) {
            if (err.name === 'AbortError' || task.status === 'aborted') {
                task.status = 'aborted';
                task.errorMsg = t('upload.cancelled');
            } else {
                task.status = 'error';
                task.errorMsg = err.message || t('upload.interrupted');
                console.error(`[Upload Error] ${task.name}:`, err);
            }
        } finally {
            this.activeCount--;
            this.render();
            this.processQueue();
        }
    }

    async uploadViaS3Multipart(task, s3Creds) {
        const accountId = localStorage.getItem('cf_account_id') || '';

        const s3Client = new R2S3Client({
            accountId: accountId,
            accessKeyId: s3Creds.accessKeyId,
            secretAccessKey: s3Creds.secretAccessKey,
            cfToken: localStorage.getItem('cf_api_token') || ''
        });

        // 10MB 分块
        const CHUNK_SIZE = 10 * 1024 * 1024;
        const totalParts = Math.ceil(task.size / CHUNK_SIZE);
        const parts = [];

        // 初始化
        const uploadId = await s3Client.createMultipartUpload(task.bucketName, task.key, task.file.type || 'application/octet-stream');

        try {
            let uploadedBytes = 0;
            let lastTime = Date.now();
            let lastLoaded = 0;

            for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
                if (task.controller.signal.aborted) {
                    throw new DOMException(t('api.uploadCancelled'), 'AbortError');
                }

                const start = (partNumber - 1) * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, task.size);
                const chunkBlob = task.file.slice(start, end);

                let partLoadedSoFar = 0;
                const partRes = await s3Client.uploadPart({
                    bucket: task.bucketName,
                    key: task.key,
                    uploadId: uploadId,
                    partNumber: partNumber,
                    chunkBlob: chunkBlob,
                    signal: task.controller.signal,
                    onProgress: (loadedInPart) => {
                        partLoadedSoFar = loadedInPart;
                        const currentTotalLoaded = uploadedBytes + partLoadedSoFar;
                        task.loaded = currentTotalLoaded;
                        task.progress = Math.min(99, Math.round((currentTotalLoaded / task.size) * 100));

                        const now = Date.now();
                        const timeDiff = (now - lastTime) / 1000;
                        if (timeDiff >= 0.3) {
                            task.speed = (currentTotalLoaded - lastLoaded) / timeDiff;
                            lastTime = now;
                            lastLoaded = currentTotalLoaded;
                        }
                        this.updateTaskUI(task, t('upload.part', { part: partNumber, total: totalParts }));
                        this.updateCapsuleUI();
                    }
                });

                parts.push(partRes);
                uploadedBytes += (end - start);
                task.loaded = uploadedBytes;
                task.progress = Math.min(99, Math.round((uploadedBytes / task.size) * 100));
                this.updateTaskUI(task, t('upload.part', { part: partNumber, total: totalParts }));
                this.updateCapsuleUI();
            }

            // 完成合并
            this.updateTaskUI(task, t('upload.merging'));
            await s3Client.completeMultipartUpload(task.bucketName, task.key, uploadId, parts);
        } catch (e) {
            await s3Client.abortMultipartUpload(task.bucketName, task.key, uploadId).catch(() => {});
            throw e;
        }
    }

    retryTask(taskId) {
        const task = this.tasks.find(tk => tk.id === taskId);
        if (task && (task.status === 'error' || task.status === 'aborted')) {
            task.status = 'pending';
            task.progress = 0;
            task.loaded = 0;
            task.errorMsg = '';
            this.render();
            this.processQueue();
        }
    }

    cancelTask(taskId) {
        const task = this.tasks.find(tk => tk.id === taskId);
        if (task) {
            if (task.status === 'uploading') {
                task.status = 'aborted';
                task.controller.abort();
            } else if (task.status === 'pending') {
                task.status = 'aborted';
                task.errorMsg = t('upload.cancelled');
                this.render();
            }
        }
    }

    checkAllCompleted() {
        const hasUploading = this.tasks.some(tk => tk.status === 'uploading' || tk.status === 'pending');
        if (!hasUploading && this.tasks.length > 0) {
            const successCount = this.tasks.filter(tk => tk.status === 'success').length;
            if (successCount > 0) {
                if (typeof this.onCompleteCallback === 'function') {
                    try { this.onCompleteCallback(); } catch (e) { console.error(e); }
                }
                if (typeof this.onTaskComplete === 'function') {
                    try { this.onTaskComplete(); } catch (e) { console.error(e); }
                }
            }

            // 若全部任务成功完成，3.5 秒后自动关闭收起浮窗
            if (successCount === this.tasks.length) {
                this.scheduleAutoClose();
            }
        }
    }

    scheduleAutoClose() {
        if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
        const dock = document.getElementById('upload-manager-dock');
        if (!dock) return;

        this.autoCloseTimer = setTimeout(() => {
            // 再次确认是否全部完成且未有新任务加入
            const hasActive = this.tasks.some(tk => tk.status === 'uploading' || tk.status === 'pending');
            if (!hasActive && this.tasks.length > 0) {
                dock.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                dock.style.opacity = '0';
                dock.style.transform = 'translateY(20px)';
                setTimeout(() => {
                    this.tasks = [];
                    this.render();
                    dock.style.opacity = '1';
                    dock.style.transform = 'translateY(0)';
                }, 400);
            }
        }, 3500);
    }

    cancelAutoClose() {
        if (this.autoCloseTimer) {
            clearTimeout(this.autoCloseTimer);
            this.autoCloseTimer = null;
        }
    }

    toggleMinimize(forceState) {
        this.isMinimized = forceState !== undefined ? forceState : !this.isMinimized;
        const dock = document.getElementById('upload-manager-dock');
        const body = document.getElementById('upload-dock-body');
        const capsule = document.getElementById('upload-dock-capsule');
        const header = document.querySelector('.upload-dock-header');

        if (this.isMinimized) {
            dock.classList.add('minimized');
            body.style.display = 'none';
            header.style.display = 'none';
            capsule.style.display = 'flex';
            this.updateCapsuleUI();
        } else {
            dock.classList.remove('minimized');
            body.style.display = 'block';
            header.style.display = 'flex';
            capsule.style.display = 'none';
        }
    }

    async clearOrClose() {
        this.cancelAutoClose();
        const hasUploading = this.tasks.some(tk => tk.status === 'uploading' || tk.status === 'pending');
        if (hasUploading) {
            const ok = await showConfirm({
                title: t('upload.clearTitle'),
                message: t('upload.clearMessage'),
                confirmText: t('upload.clearConfirm'),
                danger: true
            });
            if (!ok) return;
            this.tasks.forEach(tk => {
                if (tk.status === 'uploading' || tk.status === 'pending') {
                    tk.controller.abort();
                }
            });
        }
        this.tasks = [];
        this.render();
    }

    formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    formatSpeed(bytesPerSec) {
        if (!bytesPerSec || bytesPerSec <= 0) return '';
        return this.formatBytes(bytesPerSec) + '/s';
    }

    updateCapsuleUI() {
        const capsule = document.getElementById('upload-dock-capsule');
        const capsuleText = document.getElementById('capsule-text');
        const spinner = capsule ? capsule.querySelector('.capsule-spinner') : null;
        if (!capsuleText || !capsule) return;

        const totalTasks = this.tasks.length;
        const doneTasks = this.tasks.filter(tk => tk.status === 'success').length;
        const uploadingTask = this.tasks.find(tk => tk.status === 'uploading');

        if (uploadingTask) {
            if (spinner) spinner.style.display = 'inline-block';
            capsule.style.background = 'var(--primary-color)';
            capsuleText.textContent = t('upload.capsuleUploading', { percent: uploadingTask.progress, current: doneTasks + 1, total: totalTasks });
        } else if (doneTasks === totalTasks && totalTasks > 0) {
            // 全部完成状态：隐藏持续旋转的 spinner，换为完成状态
            if (spinner) spinner.style.display = 'none';
            capsule.style.background = 'var(--success-color)';
            capsuleText.textContent = t('upload.capsuleDone', { done: doneTasks, total: totalTasks });
        } else {
            if (spinner) spinner.style.display = 'none';
            capsule.style.background = 'var(--primary-color)';
            capsuleText.textContent = t('upload.dockTitle', { done: doneTasks, total: totalTasks });
        }
    }

    updateTaskUI(task, extraText = '') {
        const item = document.getElementById(`task-item-${task.id}`);
        if (!item) return;

        const progressBar = item.querySelector('.task-progress-fill');
        const statusText = item.querySelector('.task-status-text');

        if (progressBar) {
            progressBar.style.width = `${task.progress}%`;
        }

        if (statusText) {
            const speedStr = this.formatSpeed(task.speed);
            const loadedStr = this.formatBytes(task.loaded);
            const totalStr = this.formatBytes(task.size);
            const tagStr = extraText ? `[${extraText}] ` : '';
            statusText.textContent = `${tagStr}${loadedStr} / ${totalStr} (${task.progress}%) ${speedStr ? '· ' + speedStr : ''}`;
        }
    }

    render() {
        this.ensureUI();
        const dock = document.getElementById('upload-manager-dock');
        const list = document.getElementById('upload-task-list');
        const titleText = document.getElementById('upload-dock-text') || dock?.querySelector('.upload-dock-text');

        if (!dock || !list) return;

        if (this.tasks.length === 0) {
            dock.style.display = 'none';
            return;
        }

        dock.style.display = 'block';

        const total = this.tasks.length;
        const completed = this.tasks.filter(tk => tk.status === 'success').length;
        const hasError = this.tasks.some(tk => tk.status === 'error');

        if (titleText) {
            titleText.textContent = t('upload.dockTitle', { done: completed, total }) + (hasError ? t('upload.hasFailed') : '');
        }

        list.innerHTML = this.tasks.map(task => {
            const ext = getFileExt(task.name);
            let statusHtml = '';
            let actionBtn = '';
            let progressClass = '';

            if (task.status === 'uploading') {
                const speedStr = this.formatSpeed(task.speed);
                const loadedStr = this.formatBytes(task.loaded);
                const totalStr = this.formatBytes(task.size);
                statusHtml = `<span class="task-status-text">${loadedStr} / ${totalStr} (${task.progress}%) ${speedStr ? '· ' + speedStr : ''}</span>`;
                actionBtn = `<button class="task-action-btn cancel" data-id="${task.id}" title="${t('upload.cancel')}" aria-label="${t('upload.cancel')}" style="display: inline-flex; align-items: center; justify-content: center;"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`;
            } else if (task.status === 'pending') {
                statusHtml = `<span class="task-status-text text-muted">${t('upload.queued', { size: this.formatBytes(task.size) })}</span>`;
                actionBtn = `<button class="task-action-btn cancel" data-id="${task.id}" title="${t('upload.cancel')}" aria-label="${t('upload.cancel')}" style="display: inline-flex; align-items: center; justify-content: center;"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`;
            } else if (task.status === 'success') {
                statusHtml = `<span class="task-status-text text-success">${t('upload.success', { size: this.formatBytes(task.size) })}</span>`;
                progressClass = 'success';
            } else if (task.status === 'error') {
                statusHtml = `<span class="task-status-text text-danger" title="${escapeHtml(task.errorMsg)}">${escapeHtml(t('upload.failed', { msg: task.errorMsg }))}</span>`;
                actionBtn = `<button class="task-action-btn retry" data-id="${task.id}" title="${t('upload.retry')}">${t('upload.retry')}</button>`;
                progressClass = 'error';
            } else if (task.status === 'aborted') {
                statusHtml = `<span class="task-status-text text-muted">${t('upload.cancelled')}</span>`;
                actionBtn = `<button class="task-action-btn retry" data-id="${task.id}" title="${t('upload.reupload')}">${t('upload.retry')}</button>`;
                progressClass = 'aborted';
            }

            return `
                <div class="upload-task-item" id="task-item-${task.id}">
                    <div class="task-meta-row">
                        <span class="ext-tag">${ext}</span>
                        <span class="task-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</span>
                        ${actionBtn}
                    </div>
                    <div class="task-status-row">
                        ${statusHtml}
                    </div>
                    <div class="task-progress-track">
                        <div class="task-progress-fill ${progressClass}" style="width: ${task.progress}%;"></div>
                    </div>
                </div>
            `;
        }).join('');

        // 绑定单项操作按钮
        list.querySelectorAll('.task-action-btn.cancel').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.cancelTask(btn.dataset.id);
            });
        });

        list.querySelectorAll('.task-action-btn.retry').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.retryTask(btn.dataset.id);
            });
        });

        this.updateCapsuleUI();
    }
}

export const uploadManager = new UploadManager();

