// ====================================================
// 全站统一现代化对话框服务 (Promise-based CSS Dialog)
// 彻底淘汰 window.alert, window.confirm, window.prompt
// ====================================================

import { escapeHtml, escapeAttr } from './utils.js';

const ICONS = {
    danger: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
    warning: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
    info: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
    success: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`
};

class DialogManager {
    constructor() {
        this.overlay = null;
        this.currentResolve = null;
    }

    ensureOverlay() {
        if (this.overlay && document.body.contains(this.overlay)) return;

        this.overlay = document.createElement('div');
        this.overlay.className = 'custom-dialog-overlay';
        this.overlay.id = 'custom-dialog-overlay';

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.close(null);
            }
        });

        window.addEventListener('keydown', (e) => {
            if (!this.overlay.classList.contains('active')) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                this.close(null);
            } else if (e.key === 'Enter') {
                const activeEl = document.activeElement;
                // 如果是 textarea 则允许回车换行，否则回车直接确认
                if (activeEl && activeEl.tagName === 'TEXTAREA') return;
                const confirmBtn = this.overlay.querySelector('.custom-dialog-btn-confirm');
                if (confirmBtn) {
                    e.preventDefault();
                    confirmBtn.click();
                }
            }
        });

        document.body.appendChild(this.overlay);
    }

    close(result) {
        if (!this.overlay) return;
        this.overlay.classList.remove('active');
        if (this.currentResolve) {
            const res = this.currentResolve;
            this.currentResolve = null;
            setTimeout(() => {
                res(result);
            }, 100);
        }
    }

    /**
     * 确认对话框 (替代 window.confirm)
     * @param {string|Object} options 
     * @returns {Promise<boolean>}
     */
    confirm(options) {
        this.ensureOverlay();
        if (this.currentResolve) {
            this.close(false);
        }
        const opts = typeof options === 'string' ? { message: options } : (options || {});
        const title = opts.title || '操作确认';
        const message = opts.message || '';
        const confirmText = opts.confirmText || '确认';
        const cancelText = opts.cancelText || '取消';
        const isDanger = opts.danger !== false; // 默认操作多数为永久删除，赋予醒目的 danger 红色
        const iconType = opts.icon || (isDanger ? 'danger' : 'warning');

        return new Promise((resolve) => {
            this.currentResolve = (val) => resolve(val === true);

            this.overlay.innerHTML = `
                <div class="custom-dialog-box" role="dialog" aria-modal="true">
                    <div class="custom-dialog-header">
                        <div class="custom-dialog-icon ${iconType}">
                            ${ICONS[iconType] || ICONS.warning}
                        </div>
                        <h3 class="custom-dialog-title">${escapeHtml(title)}</h3>
                    </div>
                    <div class="custom-dialog-message">${escapeHtml(message)}</div>
                    <div class="custom-dialog-actions">
                        <button type="button" class="custom-dialog-btn custom-dialog-btn-cancel">${escapeHtml(cancelText)}</button>
                        <button type="button" class="custom-dialog-btn custom-dialog-btn-confirm ${isDanger ? 'danger' : ''}">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            `;

            const cancelBtn = this.overlay.querySelector('.custom-dialog-btn-cancel');
            const confirmBtn = this.overlay.querySelector('.custom-dialog-btn-confirm');

            cancelBtn.onclick = () => this.close(false);
            confirmBtn.onclick = () => this.close(true);

            // 激活显示并自动将焦点置于确认按钮
            requestAnimationFrame(() => {
                this.overlay.classList.add('active');
                confirmBtn.focus();
            });
        });
    }

    /**
     * 警告/提示对话框 (替代 window.alert)
     * @param {string|Object} options 
     * @returns {Promise<void>}
     */
    alert(options) {
        this.ensureOverlay();
        if (this.currentResolve) {
            this.close(true);
        }
        const opts = typeof options === 'string' ? { message: options } : (options || {});
        const title = opts.title || '提示';
        const message = opts.message || '';
        const buttonText = opts.buttonText || '我知道了';
        const type = opts.type || 'info';

        return new Promise((resolve) => {
            this.currentResolve = () => resolve();

            this.overlay.innerHTML = `
                <div class="custom-dialog-box" role="dialog" aria-modal="true">
                    <div class="custom-dialog-header">
                        <div class="custom-dialog-icon ${type}">
                            ${ICONS[type] || ICONS.info}
                        </div>
                        <h3 class="custom-dialog-title">${escapeHtml(title)}</h3>
                    </div>
                    <div class="custom-dialog-message">${escapeHtml(message)}</div>
                    <div class="custom-dialog-actions">
                        <button type="button" class="custom-dialog-btn custom-dialog-btn-confirm">${escapeHtml(buttonText)}</button>
                    </div>
                </div>
            `;

            const confirmBtn = this.overlay.querySelector('.custom-dialog-btn-confirm');
            confirmBtn.onclick = () => this.close(true);

            requestAnimationFrame(() => {
                this.overlay.classList.add('active');
                confirmBtn.focus();
            });
        });
    }

    /**
     * 输入/复制对话框 (替代 window.prompt)
     * @param {string|Object} options 
     * @returns {Promise<string|null>}
     */
    prompt(options) {
        this.ensureOverlay();
        if (this.currentResolve) {
            this.close(null);
        }
        const opts = typeof options === 'string' ? { message: options } : (options || {});
        const title = opts.title || '请输入';
        const message = opts.message || '';
        const defaultValue = opts.defaultValue || '';
        const confirmText = opts.confirmText || '确认';
        const cancelText = opts.cancelText || '取消';

        return new Promise((resolve) => {
            this.currentResolve = (val) => resolve(val);

            this.overlay.innerHTML = `
                <div class="custom-dialog-box" role="dialog" aria-modal="true">
                    <div class="custom-dialog-header">
                        <div class="custom-dialog-icon info">
                            ${ICONS.info}
                        </div>
                        <h3 class="custom-dialog-title">${escapeHtml(title)}</h3>
                    </div>
                    ${message ? `<div class="custom-dialog-message">${escapeHtml(message)}</div>` : ''}
                    <div class="custom-dialog-prompt-wrap">
                        <input type="text" class="custom-dialog-input" value="${escapeAttr(defaultValue)}" />
                    </div>
                    <div class="custom-dialog-actions">
                        <button type="button" class="custom-dialog-btn custom-dialog-btn-cancel">${escapeHtml(cancelText)}</button>
                        <button type="button" class="custom-dialog-btn custom-dialog-btn-confirm">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            `;

            const input = this.overlay.querySelector('.custom-dialog-input');
            const cancelBtn = this.overlay.querySelector('.custom-dialog-btn-cancel');
            const confirmBtn = this.overlay.querySelector('.custom-dialog-btn-confirm');

            cancelBtn.onclick = () => this.close(null);
            confirmBtn.onclick = () => this.close(input.value);

            requestAnimationFrame(() => {
                this.overlay.classList.add('active');
                input.focus();
                input.select();
            });
        });
    }
}

const dialog = new DialogManager();

export const showConfirm = (opts) => dialog.confirm(opts);
export const showAlert = (opts) => dialog.alert(opts);
export const showPrompt = (opts) => dialog.prompt(opts);

