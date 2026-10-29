// Cloudflare D1 / R2 / KV API 封装
import { getBucketDomain } from './sites.js';

let credentials = { accountId: '', apiToken: '' };

export function setCredentials(accountId, apiToken) {
    credentials.accountId = accountId;
    credentials.apiToken = apiToken;
}

export function getCredentials() {
    return credentials;
}

export async function cfRequest(path, method = 'GET', body = null) {
    // 代理请求以绕过 CORS 限制，路由到 Cloudflare Pages Functions
    const url = `/api/cf/accounts/${credentials.accountId}${path}`;
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${credentials.apiToken}`,
            'Content-Type': 'application/json'
        }
    };
    if (body) options.body = JSON.stringify(body);

    try {
        const res = await fetch(url, options);
        const text = await res.text(); // 先读取为文本
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseErr) {
            console.error("响应解析失败, 原始响应:", text);
            throw new Error('API 返回了无效的数据');
        }
        
        if (!res.ok || !data.success) {
            throw new Error(data.errors?.[0]?.message || '请求失败');
        }
        return data;
    } catch (err) {
        console.error("API Error:", err);
        throw err;
    }
}

export async function fetchDatabases() {
    return await cfRequest('/d1/database');
}

export async function queryDatabase(dbId, sql, params = []) {
    return await cfRequest(`/d1/database/${dbId}/query`, 'POST', { sql, params });
}

// ============================================
// Cloudflare R2 对象存储 API 封装
// ============================================

function pickObjects(res) {
    if (Array.isArray(res?.result)) return res.result;
    if (Array.isArray(res?.result?.objects)) return res.result.objects;
    return [];
}

/**
 * 列出前缀下的对象（自动翻页，单页最多 1000 个）
 * delimiter 传 '/' 时只列当前一层：objects 为文件，prefixes 为子目录
 */
export async function listR2Objects(bucketName, prefix = '', { delimiter = '' } = {}) {
    const objects = [];
    const prefixes = new Set();
    let cursor = '';
    for (let page = 0; page < 100; page++) {
        const params = new URLSearchParams({ prefix, per_page: '1000' });
        if (delimiter) params.set('delimiter', delimiter);
        if (cursor) params.set('cursor', cursor);
        const res = await cfRequest(`/r2/buckets/${bucketName}/objects?${params.toString()}`);
        objects.push(...pickObjects(res));
        (res.result_info?.delimited || []).forEach(p => prefixes.add(p));
        cursor = res.result_info?.cursor || '';
        if (!res.result_info?.is_truncated || !cursor) break;
    }
    return { objects, prefixes: Array.from(prefixes) };
}

export async function fetchBuckets() {
    return await cfRequest('/r2/buckets');
}

export async function putR2Object(bucketName, key, arrayBuffer, contentType = 'application/octet-stream') {
    const url = `/api/cf/accounts/${credentials.accountId}/r2/buckets/${bucketName}/objects/${encodeURIComponent(key)}`;
    const options = {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${credentials.apiToken}`,
            'Content-Type': contentType
        },
        body: arrayBuffer
    };

    const res = await fetch(url, options);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`上传失败 (${res.status}): ${text}`);
    }
    return true;
}

/**
 * 流式直传 R2 对象并带精确进度反馈（基于 XMLHttpRequest）
 * 零 JS 内存占用，直接将 File 对象交给底层网络栈
 */
export function uploadR2ObjectWithProgress({ bucketName, key, file, onProgress, signal }) {
    return new Promise((resolve, reject) => {
        const url = `/api/cf/accounts/${credentials.accountId}/r2/buckets/${bucketName}/objects/${encodeURIComponent(key)}`;
        const xhr = new XMLHttpRequest();

        xhr.open('PUT', url, true);
        xhr.setRequestHeader('Authorization', `Bearer ${credentials.apiToken}`);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

        let lastTime = Date.now();
        let lastLoaded = 0;
        let currentSpeed = 0;

        if (xhr.upload && onProgress) {
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    const now = Date.now();
                    const timeDiff = (now - lastTime) / 1000;
                    if (timeDiff >= 0.3) {
                        currentSpeed = (event.loaded - lastLoaded) / timeDiff;
                        lastTime = now;
                        lastLoaded = event.loaded;
                    }
                    onProgress({
                        loaded: event.loaded,
                        total: event.total,
                        percent: Math.min(100, Math.round((event.loaded / event.total) * 100)),
                        speed: currentSpeed
                    });
                }
            };
        }

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve({ success: true, key });
            } else {
                let errMsg = `HTTP ${xhr.status}`;
                try {
                    const json = JSON.parse(xhr.responseText);
                    if (json.errors && json.errors.length) {
                        errMsg = json.errors.map(e => e.message).join('; ');
                    }
                } catch (e) {
                    if (xhr.responseText) {
                        errMsg += `: ${xhr.responseText.slice(0, 150)}`;
                    }
                }
                reject(new Error(errMsg));
            }
        };

        xhr.onerror = () => {
            reject(new Error('网络传输异常或跨域中断'));
        };

        xhr.onabort = () => {
            reject(new DOMException('用户已取消上传', 'AbortError'));
        };

        if (signal) {
            signal.addEventListener('abort', () => {
                xhr.abort();
            });
        }

        xhr.send(file);
    });
}

export async function deleteR2Object(bucketName, key) {
    const url = `/api/cf/accounts/${credentials.accountId}/r2/buckets/${bucketName}/objects/${encodeURIComponent(key)}`;
    const options = {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${credentials.apiToken}`
        }
    };
    const res = await fetch(url, options);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`删除失败: ${text}`);
    }
    return true;
}


// 读取对象内容，同时带回 Content-Type（重命名/移动时原样写回，避免图片、网页变成下载文件）
export async function getR2ObjectArrayBuffer(bucketName, key) {
    const domain = getBucketDomain(bucketName);
    const pick = async (res) => ({
        buffer: await res.arrayBuffer(),
        contentType: res.headers.get('content-type') || 'application/octet-stream'
    });
    // 优先通过高速 CDN 直连读取（速度极快，毫秒级流式响应，无代理内存限制）
    if (domain) {
        try {
            // 按路径段编码：文件名里的 # ? 空格 中文不会被当成网址的一部分而读到别的文件
            const encodedPath = key.split('/').map(encodeURIComponent).join('/');
            const cdnRes = await fetch(`${domain}/${encodedPath}`, { cache: 'no-store' });
            if (cdnRes.ok) {
                return await pick(cdnRes);
            }
        } catch (e) {
            console.warn("CDN 读取失败，回退至 API 代理:", e);
        }
    }

    const url = `/api/cf/accounts/${credentials.accountId}/r2/buckets/${bucketName}/objects/${encodeURIComponent(key)}`;
    const options = {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.apiToken}`
        }
    };
    const res = await fetch(url, options);
    if (!res.ok) {
        throw new Error(`读取文件失败 (${res.status})`);
    }
    return await pick(res);
}

// 判断存储桶里是否已经有这个文件（精确匹配 Key）
async function r2ObjectExists(bucketName, key) {
    // 带 delimiter 只列同一层，避免前缀下文件很多时翻很多页
    const { objects } = await listR2Objects(bucketName, key, { delimiter: '/' });
    return objects.some(obj => obj.key === key);
}

// 重命名文件 (Copy + Delete + D1 历史下载数迁移)
// 目标位置已有同名文件时直接报错，避免把别的文件覆盖掉
export async function renameR2Object(bucketName, oldKey, newKey, dbId = null, { skipExistCheck = false } = {}) {
    if (oldKey === newKey) return true;

    if (!skipExistCheck && await r2ObjectExists(bucketName, newKey)) {
        throw new Error(`目标位置已存在同名文件：${newKey}`);
    }
    
    // 1. 读取原文件内容
    const { buffer, contentType } = await getR2ObjectArrayBuffer(bucketName, oldKey);

    // 2. 写入新文件（保留原 Content-Type）
    await putR2Object(bucketName, newKey, buffer, contentType);

    // 3. 删除旧文件
    await deleteR2Object(bucketName, oldKey);

    // 4. 同步更新 D1 下载统计表路径（确保下载量不丢失）
    if (dbId) {
        try {
            await queryDatabase(dbId, `
                UPDATE file_downloads 
                SET file_path = ? 
                WHERE file_path = ?
            `, [newKey, oldKey]);
        } catch (dbErr) {
            console.warn("更新 D1 下载记录路径失败（非致命）:", dbErr);
        }
    }
    return true;
}

// 移动文件到目标目录 (Move File)
export async function moveR2Object(bucketName, oldKey, targetDir, dbId = null) {
    const fileName = oldKey.split('/').pop();
    const cleanTargetDir = targetDir.replace(/^\/+/, '').replace(/\/+$/, '');
    const newKey = cleanTargetDir ? `${cleanTargetDir}/${fileName}` : fileName;
    
    return await renameR2Object(bucketName, oldKey, newKey, dbId);
}

// 重命名文件夹 (批量递归更新前缀 + D1 路径更新)
export async function renameR2Folder(bucketName, oldPrefix, newPrefix, dbId = null) {
    if (oldPrefix === newPrefix) return true;

    // 目标文件夹已存在（里面有任何文件）时不合并，避免同名文件被覆盖
    const { objects: existing } = await listR2Objects(bucketName, newPrefix);
    if (existing.length > 0) {
        throw new Error(`目标文件夹已存在：${newPrefix}`);
    }

    // 1. 列出该前缀下的所有对象（超过 1000 个时自动翻页）
    const { objects } = await listR2Objects(bucketName, oldPrefix);

    for (const obj of objects) {
        const oldKey = obj.key;
        if (oldKey) {
            const newKey = newPrefix + oldKey.slice(oldPrefix.length);
            // 上面已确认目标文件夹为空，逐个文件不再重复检查
            await renameR2Object(bucketName, oldKey, newKey, dbId, { skipExistCheck: true });
        }
    }
    return true;
}

// 删除文件夹 (批量删除该前缀下的所有对象与目录占位符)
export async function deleteR2Folder(bucketName, prefix) {
    const { objects } = await listR2Objects(bucketName, prefix);

    for (const obj of objects) {
        if (obj.key) {
            await deleteR2Object(bucketName, obj.key);
        }
    }

    // 同时清理可能存在的目录自身占位对象（如 "folder/" 或 "folder"）
    try {
        await deleteR2Object(bucketName, prefix);
    } catch (e) {}
    try {
        if (prefix.endsWith('/')) {
            await deleteR2Object(bucketName, prefix.slice(0, -1));
        }
    } catch (e) {}

    return true;
}

// ============================================
// Cloudflare Workers KV 键值存储 API 封装
// ============================================

export async function fetchKvNamespaces() {
    return await cfRequest('/storage/kv/namespaces');
}

export async function getKvValue(namespaceId, keyName) {
    const url = `/api/cf/accounts/${credentials.accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(keyName)}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.apiToken}`
        }
    });

    if (res.status === 404) {
        return null; // Key 尚不存在
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`读取 KV 失败 (${res.status}): ${text}`);
    }
    return await res.text();
}

export async function putKvValue(namespaceId, keyName, valueString) {
    const url = `/api/cf/accounts/${credentials.accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(keyName)}`;
    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${credentials.apiToken}`,
            'Content-Type': 'text/plain; charset=utf-8'
        },
        body: typeof valueString === 'string' ? valueString : JSON.stringify(valueString)
    });

    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        if (!res.ok) throw new Error(`写入 KV 失败 (${res.status}): ${text}`);
        return true;
    }

    if (!res.ok || (data && data.success === false)) {
        throw new Error(data?.errors?.[0]?.message || `写入 KV 失败 (${res.status})`);
    }
    return true;
}
