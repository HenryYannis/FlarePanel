// ============================================
// 原生轻量级 AWS SigV4 签名器 & R2 S3 分片上传引擎
// 零外部依赖，使用浏览器原生 Web Crypto API
// ============================================

import { t, langHeaders } from './i18n.js';
import { getCredentials } from './api.js';

async function sha256Hex(data) {
    let buffer;
    if (typeof data === 'string') {
        buffer = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
        buffer = data;
    } else if (ArrayBuffer.isView(data)) {
        buffer = data.buffer;
    } else if (data instanceof Blob) {
        buffer = await data.arrayBuffer();
    } else {
        buffer = new ArrayBuffer(0);
    }
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        typeof key === 'string' ? new TextEncoder().encode(key) : key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign(
        'HMAC',
        cryptoKey,
        typeof data === 'string' ? new TextEncoder().encode(data) : data
    );
    return new Uint8Array(signature);
}

async function getSigningKey(secretAccessKey, dateStamp, region, service) {
    const kDate = await hmacSha256('AWS4' + secretAccessKey, dateStamp);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    const kSigning = await hmacSha256(kService, 'aws4_request');
    return kSigning;
}

export class R2S3Client {
    constructor({ accountId, accessKeyId, secretAccessKey, cfToken = '' }) {
        this.accountId = accountId;
        this.cfToken = cfToken;
        this.accessKeyId = accessKeyId;
        this.secretAccessKey = secretAccessKey;
        this.region = 'auto';
        this.service = 's3';
        this.host = `${accountId}.r2.cloudflarestorage.com`;
    }

    async signRequest({ method, path, queryParams = {}, headers = {}, body = null }) {
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);

        const reqHeaders = { ...headers };
        reqHeaders['host'] = this.host;
        reqHeaders['x-amz-date'] = amzDate;
        reqHeaders['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD';

        // 排序查询参数
        const sortedQueryKeys = Object.keys(queryParams).sort();
        const canonicalQueryString = sortedQueryKeys
            .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
            .join('&');

        // 排序请求头
        const canonicalHeaderKeys = Object.keys(reqHeaders).map(k => k.toLowerCase()).sort();
        const canonicalHeadersStr = canonicalHeaderKeys
            .map(k => `${k}:${reqHeaders[k] || reqHeaders[Object.keys(reqHeaders).find(orig => orig.toLowerCase() === k)]}\n`)
            .join('');
        const signedHeadersStr = canonicalHeaderKeys.join(';');

        // Canonical URI
        const canonicalUri = '/' + path.split('/').map(encodeURIComponent).join('/');

        // 规范请求
        const canonicalRequest = [
            method.toUpperCase(),
            canonicalUri,
            canonicalQueryString,
            canonicalHeadersStr,
            signedHeadersStr,
            'UNSIGNED-PAYLOAD'
        ].join('\n');

        const canonicalRequestHash = await sha256Hex(canonicalRequest);

        // String to sign
        const credentialScope = `${dateStamp}/${this.region}/${this.service}/aws4_request`;
        const stringToSign = [
            'AWS4-HMAC-SHA256',
            amzDate,
            credentialScope,
            canonicalRequestHash
        ].join('\n');

        // 计算签名
        const signingKey = await getSigningKey(this.secretAccessKey, dateStamp, this.region, this.service);
        const signatureBytes = await hmacSha256(signingKey, stringToSign);
        const signatureHex = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');

        const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signatureHex}`;

        // x-cf-token：后台登录用的 Cloudflare API Token，代理用它校验管理员（不参与签名，也不会转发给 R2）
        const finalHeaders = {
            ...reqHeaders,
            'Authorization': authorizationHeader,
            'x-cf-account-id': this.accountId,
            'x-cf-token': this.cfToken || getCredentials().apiToken || '',
            ...langHeaders()
        };

        // 构造发送到本地 Pages Functions 反代路由的 URL
        const proxyUrl = `/api/s3${canonicalUri}${canonicalQueryString ? '?' + canonicalQueryString : ''}`;

        return {
            url: proxyUrl,
            headers: finalHeaders
        };
    }

    // 1. 初始化分片上传
    async createMultipartUpload(bucket, key, contentType = 'application/octet-stream') {
        const path = `${bucket}/${key}`;
        const queryParams = { uploads: '' };
        const headers = {
            'content-type': contentType
        };

        const { url, headers: signedHeaders } = await this.signRequest({
            method: 'POST',
            path,
            queryParams,
            headers
        });

        const res = await fetch(url, {
            method: 'POST',
            headers: signedHeaders
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(t('s3.initFailed', { status: res.status, msg: errText }));
        }

        const xmlText = await res.text();
        const match = xmlText.match(/<UploadId>(.+?)<\/UploadId>/);
        if (!match) {
            throw new Error(t('s3.noUploadId', { msg: xmlText }));
        }
        return match[1];
    }

    // 2. 上传单个分片
    async uploadPart({ bucket, key, uploadId, partNumber, chunkBlob, onProgress, signal }) {
        const path = `${bucket}/${key}`;
        const queryParams = {
            partNumber: String(partNumber),
            uploadId: uploadId
        };
        const headers = {
            'content-type': 'application/octet-stream'
        };

        const { url, headers: signedHeaders } = await this.signRequest({
            method: 'PUT',
            path,
            queryParams,
            headers
        });

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', url, true);

            for (const [k, v] of Object.entries(signedHeaders)) {
                if (k.toLowerCase() !== 'host') {
                    xhr.setRequestHeader(k, v);
                }
            }

            if (xhr.upload && onProgress) {
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        onProgress(e.loaded);
                    }
                };
            }

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    let etag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag') || '';
                    etag = etag.replace(/"/g, '');
                    resolve({ partNumber, etag });
                } else {
                    reject(new Error(t('s3.partFailed', { part: partNumber, status: xhr.status, msg: xhr.responseText })));
                }
            };

            xhr.onerror = () => reject(new Error(t('s3.partNetwork', { part: partNumber })));
            xhr.onabort = () => reject(new DOMException(t('s3.partCancelled', { part: partNumber }), 'AbortError'));

            if (signal) {
                signal.addEventListener('abort', () => xhr.abort());
            }

            xhr.send(chunkBlob);
        });
    }

    // 3. 完成分片合并
    async completeMultipartUpload(bucket, key, uploadId, parts) {
        const path = `${bucket}/${key}`;
        const queryParams = { uploadId };

        // 构造 CompleteMultipartUpload XML
        const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
${sortedParts.map(p => `  <Part>
    <PartNumber>${p.partNumber}</PartNumber>
    <ETag>"${p.etag}"</ETag>
  </Part>`).join('\n')}
</CompleteMultipartUpload>`;

        const headers = {
            'content-type': 'application/xml'
        };

        const { url, headers: signedHeaders } = await this.signRequest({
            method: 'POST',
            path,
            queryParams,
            headers
        });

        const res = await fetch(url, {
            method: 'POST',
            headers: signedHeaders,
            body: xmlBody
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(t('s3.completeFailed', { status: res.status, msg: errText }));
        }

        return true;
    }

    // 4. 取消分片上传
    async abortMultipartUpload(bucket, key, uploadId) {
        const path = `${bucket}/${key}`;
        const queryParams = { uploadId };

        const { url, headers: signedHeaders } = await this.signRequest({
            method: 'DELETE',
            path,
            queryParams
        });

        await fetch(url, {
            method: 'DELETE',
            headers: signedHeaders
        }).catch(() => {});
    }
}
