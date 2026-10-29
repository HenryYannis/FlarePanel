// ====================================================
// FlarePanel - 通用工具库
// 职责：安全转义、时间与单位格式化、轻量内存缓存
// 站点名称与排序见 sites.js（读取 sites.config.js）
// ====================================================

/**
 * HTML 特殊字符安全转义 (防 XSS 攻击)
 * @param {any} str
 * @returns {string}
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * HTML 属性安全转义
 * @param {any} str
 * @returns {string}
 */
export function escapeAttr(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * D1 (SQLite) 的 CURRENT_TIMESTAMP 存的是不带时区的 UTC 字符串（YYYY-MM-DD HH:MM:SS），
 * 直接 new Date() 会被浏览器当成本地时间，显示比北京时间早 8 小时。这里统一按 UTC 解析。
 * @param {string|number|Date} dateStr
 * @returns {Date}
 */
function parseDbTime(dateStr) {
    if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(dateStr.trim())) {
        return new Date(dateStr.trim().replace(' ', 'T') + 'Z');
    }
    return new Date(dateStr);
}

/**
 * 标准日期时间格式化 (YYYY-MM-DD HH:mm:ss)
 * @param {string|number|Date} dateStr
 * @returns {string}
 */
export function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const d = parseDbTime(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 紧凑日期格式化 (YYYY-MM-DD)
 * @param {string|number|Date} dateStr
 * @returns {string}
 */
export function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 文件大小可读性转换 (B, KB, MB, GB, TB)
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Token 数量量级格式化 (如 1.2k, 3.5M)
 * @param {number} num
 * @returns {string}
 */
export function formatTokens(num = 0) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return Number(num).toLocaleString();
}

/**
 * 提取文件小写后缀扩展名
 * @param {string} filename
 * @returns {string}
 */
export function getFileExt(filename) {
    if (!filename || filename.indexOf('.') === -1) return '';
    return filename.split('.').pop().toLowerCase();
}

// 站点名称与排序改由 sites.config.js 决定
export { getSiteSortOrder, getSiteDisplayName } from './sites.js';

/**
 * 轻量通用内存缓存工厂 (带 TTL 过期自动失效)
 * @param {number} ttlMs 缓存有效期，默认 60 秒
 */
export function createMemoryCache(ttlMs = 60 * 1000) {
    const cache = new Map();
    return {
        get(key) {
            const item = cache.get(key);
            if (!item) return null;
            if (Date.now() - item.time > ttlMs) {
                cache.delete(key);
                return null;
            }
            return item.data;
        },
        set(key, data) {
            cache.set(key, { time: Date.now(), data });
        },
        delete(key) {
            cache.delete(key);
        },
        clear() {
            cache.clear();
        }
    };
}
