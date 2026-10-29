// ====================================================
// FlarePanel - 界面多语言（简体中文 / 繁體中文 / English）
// 语言：localStorage 里的手动选择 → 浏览器语言（zh-TW / zh-HK / zh-MO / zh-Hant 用繁体，其他 zh 用简体）→ 其他用英文
// 用法：t('key', { name: 'x' })，词条里的 {name} 会被替换
// 静态 HTML 用 data-i18n / data-i18n-title / data-i18n-placeholder / data-i18n-aria-label，加载时由 applyI18n() 填充
// 切换语言会刷新页面，所有模块按新语言重新渲染
// ====================================================

import { zh } from './i18n/zh.js';
import { en } from './i18n/en.js';
import { zhHant } from './i18n/zh-Hant.js';

const STORAGE_KEY = 'fp_lang';
const DICTS = { zh, 'zh-Hant': zhHant, en };

/** 支持的语言，顺序即语言菜单里的顺序 */
export const LANGS = [
    { code: 'zh', label: '简体中文' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'en', label: 'English' }
];

function detectLang() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (Object.prototype.hasOwnProperty.call(DICTS, saved)) return saved;
    } catch (e) {}
    const nav = String((typeof navigator !== 'undefined' && (navigator.language || (navigator.languages || [])[0])) || '').toLowerCase();
    if (/^zh-(hant|tw|hk|mo)/.test(nav)) return 'zh-Hant';
    return nav.startsWith('zh') ? 'zh' : 'en';
}

let currentLang = detectLang();

/** 当前语言：'zh' | 'zh-Hant' | 'en' */
export function getLang() {
    return currentLang;
}

/** 当前语言的 BCP 47 标签，用于 Intl 格式化、<html lang>、Accept-Language */
export function getLocale() {
    if (currentLang === 'zh') return 'zh-CN';
    if (currentLang === 'zh-Hant') return 'zh-TW';
    return 'en-US';
}

/** 发给 Pages Functions 的语言头，服务端按它返回对应语言的错误信息 */
export function langHeaders() {
    const values = { zh: 'zh-CN,zh;q=0.9', 'zh-Hant': 'zh-TW,zh-Hant;q=0.9,zh;q=0.8', en: 'en-US,en;q=0.9' };
    return { 'Accept-Language': values[currentLang] || values.en };
}

/** 词条是否存在 */
export function hasKey(key) {
    return Object.prototype.hasOwnProperty.call(DICTS[currentLang], key) || Object.prototype.hasOwnProperty.call(zh, key);
}

/**
 * 取词条
 * @param {string} key
 * @param {Record<string, any>} [params]
 * @returns {string}
 */
export function t(key, params) {
    let text = DICTS[currentLang][key];
    if (text === undefined && currentLang === 'zh-Hant') text = zh[key];
    if (text === undefined) text = en[key];
    if (text === undefined) text = zh[key];
    if (text === undefined) {
        if (typeof console !== 'undefined') console.warn(`[i18n] missing key: ${key}`);
        return key;
    }
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
}

/** 切换语言并刷新页面 */
export function setLang(lang) {
    if (!Object.prototype.hasOwnProperty.call(DICTS, lang)) return;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
    currentLang = lang;
    location.reload();
}

/**
 * 配置里的显示文字：可以是普通字符串（原样显示），也可以是 { zh: '文章', 'zh-Hant': '文章', en: 'Posts' }（繁体缺省时用简体）
 * @param {string|Record<string,string>} label
 */
export function localizedLabel(label) {
    if (!label) return '';
    if (typeof label === 'string') return label;
    if (typeof label === 'object') {
        if (label[currentLang]) return label[currentLang];
        if (currentLang === 'zh-Hant' && label.zh) return label.zh;
        return label.en || label.zh || Object.values(label)[0] || '';
    }
    return String(label);
}

/** 数字按当前语言格式化 */
export function formatNumber(num, options) {
    const n = Number(num);
    if (!Number.isFinite(n)) return String(num ?? '');
    return n.toLocaleString(getLocale(), options);
}

/**
 * 把 data-i18n* 属性填进页面
 * data-i18n="key"             → textContent
 * data-i18n-html="key"        → innerHTML（只用于词典里自带的固定标记）
 * data-i18n-title="key"       → title
 * data-i18n-placeholder="key" → placeholder
 * data-i18n-aria-label="key"  → aria-label
 * data-i18n-content="key"     → content（<meta>）
 */
export function applyI18n(root = document) {
    if (root === document) {
        document.documentElement.setAttribute('lang', getLocale());
    }
    // 收尾时去掉 i18n-pending（英文界面加载期间隐藏页面用）
    const done = () => { if (root === document) document.documentElement.classList.remove('i18n-pending'); };
    root.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
    root.querySelectorAll('[data-i18n-html]').forEach(n => { n.innerHTML = t(n.dataset.i18nHtml); });
    root.querySelectorAll('[data-i18n-title]').forEach(n => { n.setAttribute('title', t(n.dataset.i18nTitle)); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(n => { n.setAttribute('placeholder', t(n.dataset.i18nPlaceholder)); });
    root.querySelectorAll('[data-i18n-aria-label]').forEach(n => { n.setAttribute('aria-label', t(n.dataset.i18nAriaLabel)); });
    root.querySelectorAll('[data-i18n-content]').forEach(n => { n.setAttribute('content', t(n.dataset.i18nContent)); });
    done();
}
