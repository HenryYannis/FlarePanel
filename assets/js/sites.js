// ====================================================
// 站点配置读取工具：所有栏目都通过这里找站点，不再各自写死域名
// ====================================================
import { PANEL, SITES, AI_HUB } from '../../sites.config.js';

export { PANEL, AI_HUB };

export const sites = Array.isArray(SITES) ? SITES.filter(Boolean) : [];

// 站点的三种资源名：评论库、账号库、存储桶
const RESOURCE_KEYS = ['commentDb', 'accountDb', 'bucket'];

function findSite(resourceName) {
    if (!resourceName) return null;
    return sites.find(s => RESOURCE_KEYS.some(k => s[k] && s[k] === resourceName)) || null;
}

/** 按 D1 库名或存储桶名找到站点 */
export function getSiteByResource(resourceName) {
    return findSite(resourceName);
}

/** 按 D1 库名或存储桶名取站点显示名，没配置的原样返回 */
export function getSiteDisplayName(resourceName) {
    return findSite(resourceName)?.name || resourceName || '';
}

/** 按配置里的先后顺序排序，没配置的排在最后 */
export function getSiteSortOrder(resourceName) {
    const site = findSite(resourceName);
    return site ? sites.indexOf(site) : 99;
}

/** 站点网址（去掉末尾斜杠） */
export function getSiteUrl(resourceName) {
    const url = findSite(resourceName)?.url || '';
    return url.replace(/\/+$/, '');
}

/** 某栏目要用的资源名列表：comments / stats 用 commentDb，accounts 用 accountDb，storage 用 bucket */
export function getResourceNames(key) {
    return sites.map(s => s[key]).filter(Boolean);
}

/** 存储桶的公开域名 */
export function getBucketDomain(bucketName) {
    const site = sites.find(s => s.bucket && s.bucket === bucketName);
    return (site?.filesDomain || '').replace(/\/+$/, '');
}

/** 存储桶对应的评论库名（下载次数存在这个库的 file_downloads 表） */
export function getBucketDbName(bucketName) {
    const site = sites.find(s => s.bucket && s.bucket === bucketName);
    return site?.commentDb || '';
}

/** 浏览量统计的页面分类 */
export function getViewTypes(resourceName) {
    const site = findSite(resourceName);
    const types = site?.viewTypes || PANEL.viewTypes || [];
    return types.filter(t => t && t.key && Array.isArray(t.prefixes) && t.prefixes.length);
}

/** 按 AI 网关日志里的 site_id 找站点，返回 { site, index } */
export function getSiteByAiId(siteId) {
    if (!siteId) return null;
    const index = sites.findIndex(s => s.aiSiteId && s.aiSiteId === siteId);
    return index === -1 ? null : { site: sites[index], index };
}

/** 站点颜色样式：按配置顺序轮流使用三种颜色 */
export function getSiteColorClass(index) {
    const palette = ['tech', 'astrology', 'games'];
    return index >= 0 ? palette[index % palette.length] : 'other';
}
