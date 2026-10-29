// ====================================================
// 统一 AI 代理网关 - 模型路由与容灾流水线模块 (Routing & Fallback)
// 职责：KV 边缘配置读写、服务商卡片/轮询模型选择、主备降级链编排、开发者 3 槽位 Key
// 规范：恪守 AGENTS.md（0 Emoji 铁律、保存即刷新网关 /v1/reload 缓存）
// ====================================================

import { getKvValue, putKvValue } from '../../api.js';
import { t } from '../../i18n.js';
import { escapeHtml, escapeAttr } from '../../utils.js';
import { 
    AI_KV_NAMESPACE_ID, 
    AI_KV_CONFIG_KEY, 
    DEFAULT_AI_CONFIG, 
    OFFICIAL_AI_GATEWAY_URL, 
    PROVIDER_TEMPLATES, 
    ensureGatewayKeys 
} from './presets.js';

let currentAiConfig = null;
let kvAuthError = false;

export function getCurrentAiConfig() {
    return currentAiConfig;
}

export function setCurrentAiConfig(cfg) {
    currentAiConfig = cfg;
}

export function isKvAuthError() {
    return kvAuthError;
}

export async function loadAiConfig() {
    kvAuthError = false;
    try {
        const rawJson = await getKvValue(AI_KV_NAMESPACE_ID, AI_KV_CONFIG_KEY);
        if (rawJson) {
            currentAiConfig = JSON.parse(rawJson);
            if (!currentAiConfig.sitePolicy) currentAiConfig.sitePolicy = { ...DEFAULT_AI_CONFIG.sitePolicy };
            if (!currentAiConfig.telegram) currentAiConfig.telegram = { ...DEFAULT_AI_CONFIG.telegram };
            if (!currentAiConfig.gateway) {
                currentAiConfig.gateway = { ...DEFAULT_AI_CONFIG.gateway };
            } else if (!currentAiConfig.gateway.endpoint) {
                currentAiConfig.gateway.endpoint = OFFICIAL_AI_GATEWAY_URL;
            }
            if (!currentAiConfig.providers) currentAiConfig.providers = [...DEFAULT_AI_CONFIG.providers];
            // 清理遗留名称后缀并补齐默认 URL
            if (Array.isArray(currentAiConfig.providers)) {
                currentAiConfig.providers.forEach(p => {
                    if (p.name) {
                        p.name = p.name.replace(/\s*\(?(主力|备用一|备用二\/兜底|备用二|兜底)\)?/g, '').trim();
                    }
                    if (!p.baseUrl) {
                        const matched = PROVIDER_TEMPLATES.find(tpl => 
                            (p.id && tpl.name.toLowerCase().includes(p.id.replace('provider_', '').toLowerCase())) ||
                            (p.name && tpl.name.toLowerCase().includes(p.name.toLowerCase()))
                        );
                        if (matched) p.baseUrl = matched.baseUrl;
                    }
                });
            }
        } else {
            currentAiConfig = JSON.parse(JSON.stringify(DEFAULT_AI_CONFIG));
        }
    } catch (err) {
        if (err.message && (err.message.includes('401') || err.message.includes('Authentication error'))) {
            kvAuthError = true;
            console.warn('API Token has no Workers KV permission (401); loaded the default preset.');
        } else {
            console.warn('Failed to read KV config; using the default preset:', err);
        }
    }
    ensureGatewayKeys(currentAiConfig);
    return currentAiConfig;
}

export async function saveAiConfigToKv(config) {
    if (config.gateway) {
        config.gateway.endpoint = OFFICIAL_AI_GATEWAY_URL;
    }
    currentAiConfig = config;
    const jsonStr = JSON.stringify(config, null, 2);
    await putKvValue(AI_KV_NAMESPACE_ID, AI_KV_CONFIG_KEY, jsonStr);
    kvAuthError = false;

    // 触发网关边缘秒级刷新内存缓存（破除 60 分钟缓存，实现保存即生效）
    try {
        const masterKey = config?.gateway?.masterKey || (Array.isArray(config?.gateway?.keys) && config.gateway.keys[0]?.key);
        const reloadHeaders = {};
        if (masterKey) reloadHeaders['Authorization'] = `Bearer ${masterKey}`;
        fetch(`${OFFICIAL_AI_GATEWAY_URL}/v1/reload`, {
            method: 'POST',
            headers: reloadHeaders
        }).catch(e => console.warn('Failed to ask the gateway to reload its cache (non-fatal):', e));
    } catch (_) {}

    return true;
}

export function maskApiKey(key) {
    if (!key) return '<span style="color: var(--text-secondary); font-style: italic;">' + t('ai.noApiKey') + '</span>';
    if (key.length <= 8) return '****';
    return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

// 渲染降级链条节点
export function renderFallbackChainItems(providers, chainIds) {
    const providerMap = new Map(providers.map(p => [p.id, p]));

    return `
    <div class="ai-fallback-chain-list">
        ${chainIds.map((id, index) => {
            const p = providerMap.get(id);
            const name = p ? p.name : id;
            const model = p ? p.defaultModel || p.models.split(',')[0] : '';
            const isFirst = index === 0;
            const isLast = index === chainIds.length - 1;

            return `
            <div class="ai-chain-node ${p && !p.enabled ? 'node-disabled' : ''}">
                <div class="ai-chain-index">${index + 1}</div>
                <div class="ai-chain-info">
                    <span class="ai-chain-role">${isFirst ? t('ai.rolePrimary') : (isLast ? t('ai.roleLast') : t('ai.roleBackup'))}</span>
                    <strong class="ai-chain-name" title="${escapeAttr(name)}">${escapeHtml(name)}</strong>
                    <span class="ai-chain-model" title="${escapeAttr(model)}">${escapeHtml(model)}</span>
                </div>
                <div class="ai-chain-ctrls">
                    ${!isFirst ? `<button class="ai-chain-move-btn" data-action="move-up" data-index="${index}" title="${t('ai.moveUp')}" aria-label="${t('ai.moveUp')}" style="display: inline-flex; align-items: center; justify-content: center;"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg></button>` : ''}
                    ${!isLast ? `<button class="ai-chain-move-btn" data-action="move-down" data-index="${index}" title="${t('ai.moveDown')}" aria-label="${t('ai.moveDown')}" style="display: inline-flex; align-items: center; justify-content: center;"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>` : ''}
                    <button class="ai-chain-del-btn" data-action="remove-chain" data-index="${index}" title="${t('ai.removeFromChain')}" aria-label="${t('ai.removeFromChain')}" style="display: inline-flex; align-items: center; justify-content: center;"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                </div>
            </div>
            ${index < chainIds.length - 1 ? '<div class="ai-chain-arrow" style="display: inline-flex; align-items: center; justify-content: center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg></div>' : ''}
            `;
        }).join('')}

        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
            <select id="ai-chain-add-select" class="form-control" style="width: auto; height: 38px; padding: 4px 10px;">
                <option value="">${t('ai.addChainPlaceholder')}</option>
                ${providers.filter(p => !chainIds.includes(p.id)).map(p => `
                    <option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.defaultModel || t('ai.defaultModel'))})</option>
                `).join('')}
            </select>
            <button class="btn btn-outline btn-sm" id="ai-chain-add-btn">${t('common.add')}</button>
        </div>
    </div>
    `;
}

// 获取服务商已勾选生效的轮询模型列表
export function getProviderPollModels(p) {
    if (!p) return [];
    const rawList = (p.models || '').split(',').map(m => m.trim()).filter(Boolean);
    let poll = [];
    if (Array.isArray(p.pollModels)) {
        poll = p.pollModels.map(m => m.trim()).filter(m => rawList.includes(m));
    } else if (typeof p.pollModels === 'string' && p.pollModels.trim()) {
        poll = p.pollModels.split(',').map(m => m.trim()).filter(m => rawList.includes(m));
    }
    // 未指定 pollModels 时，默认只勾选首选模型（单模型模式，绝不替用户自作主张多选）
    if (poll.length === 0) {
        if (p.defaultModel && rawList.includes(p.defaultModel)) {
            poll = [p.defaultModel];
        } else if (rawList.length > 0) {
            poll = [rawList[0]];
        }
    }
    return poll;
}

// 渲染服务商卡片
export function renderProviderCards(providers) {
    return providers.map(p => {
        const rawModelList = (p.models || '').split(',').map(m => m.trim()).filter(Boolean);
        const pollModels = getProviderPollModels(p);

        return `
        <div class="ai-provider-card ${p.enabled ? 'active' : 'disabled'}" data-id="${p.id}">
            <div class="ai-provider-top">
                <div class="ai-provider-top-left">
                    <label class="ai-switch" title="${t('ai.toggleProvider')}">
                        <input type="checkbox" class="ai-provider-toggle" data-id="${p.id}" ${p.enabled ? 'checked' : ''}>
                        <span class="ai-slider"></span>
                    </label>
                    <div style="min-width: 0; flex: 1;">
                        <div class="ai-provider-name">${escapeHtml(p.name)}</div>
                        <div class="ai-provider-url">${escapeHtml(p.baseUrl)}</div>
                    </div>
                </div>
                <div class="ai-provider-ops">
                    <button class="btn btn-outline btn-sm ai-edit-provider-btn" data-id="${p.id}">${t('common.edit')}</button>
                    <button class="btn btn-danger btn-sm ai-del-provider-btn" data-id="${p.id}">${t('common.delete')}</button>
                </div>
            </div>

            <div class="ai-provider-body">
                <div class="ai-provider-key-row" style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;">
                        <span class="ai-provider-label">API Key:</span>
                        <code class="ai-provider-key-val" style="font-family: monospace; font-size: 12px; letter-spacing: 1px; color: var(--text-secondary);" title="${t('ai.keyMasked')}">${p.apiKey ? '••••••••••••••••' : '<span style="color: var(--text-secondary); font-style: italic; letter-spacing: normal;">' + t('ai.notConfigured') + '</span>'}</code>
                    </div>
                    ${p.apiKey ? `<button type="button" class="btn btn-outline btn-sm ai-copy-provider-key-btn" data-key="${escapeAttr(p.apiKey)}" style="padding: 2px 8px; font-size: 11px; flex-shrink: 0;" title="${t('ai.copyFullKey')}">${t('common.copy')}</button>` : ''}
                </div>
                <div class="ai-provider-models-block">
                    <div class="ai-provider-models-header">
                        <span class="ai-provider-label">${t('ai.pollModels')}</span>
                        <span class="ai-models-stats-hint">
                            ${t('ai.pollStats', { checked: pollModels.length, total: rawModelList.length })}
                        </span>
                    </div>
                    <div class="ai-models-tags">
                        ${rawModelList.map(m => {
                            const isChecked = pollModels.includes(m);
                            const rank = pollModels.indexOf(m);
                            const roleText = rank === 0 ? t('ai.rolePrimary') : t('ai.roleBackupN', { n: rank + 1 });
                            return `
                                <button type="button"
                                        class="ai-model-tag-btn ${isChecked ? (rank === 0 ? 'is-primary' : 'is-backup') : 'is-unchecked'}"
                                        data-provider-id="${p.id}"
                                        data-model="${escapeAttr(m)}"
                                        title="${isChecked ? t('ai.modelCheckedTitle', { role: roleText }) : t('ai.modelUncheckedTitle')}">
                                    <span class="ai-tag-checkbox ${isChecked ? 'checked' : ''}">
                                        ${isChecked ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>` : ''}
                                    </span>
                                    <span class="ai-tag-name">${escapeHtml(m)}</span>
                                    ${isChecked ? `<span class="ai-tag-role-pill">${roleText}</span>` : ''}
                                </button>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        </div>
        `;
    }).join('');
}

// 渲染开发者专属密钥 (从左到右排列，已配置仅展示名称，末尾固定一个「新建」按钮，数量不限)
export function renderKeysSlotsHtml(keys) {
    if (!Array.isArray(keys)) return '';
    const configured = keys.map((k, idx) => {
        const safeName = escapeHtml(k.name || '');
        return `
            <button type="button" class="ai-key-slot-btn active" data-slot-index="${idx}" title="${escapeAttr(k.name || '')}">
                ${safeName}
            </button>
            `;
    }).join('');
    return `
    <div class="ai-keys-grid">
        ${configured}
        <button type="button" class="ai-key-slot-btn empty" data-slot-index="${keys.length}" title="${t('ai.newKeyTitle')}">
            ${t('ai.newKey')}
        </button>
    </div>
    `;
}

// 渲染「网关配置」子栏目内容
export function renderConfigTabHtml(config, activeProviders, chainIds) {
    ensureGatewayKeys(config);
    return `
    <div class="ai-grid-2" style="margin-top: 20px;">
        <div class="ai-card">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px;">
                <h3 class="ai-card-title" style="margin-bottom: 0;">${t('ai.devEndpointTitle')}</h3>
                <span style="font-size: 11.5px; color: var(--text-secondary);">${t('ai.devEndpointHint')}</span>
            </div>
            <div class="form-group" style="margin-bottom: 14px;">
                <label style="font-size: 12px; margin-bottom: 4px;">${t('ai.baseUrlLabel')}</label>
                <div class="ai-endpoint-row">
                    <input type="text" id="ai-endpoint-input" class="form-control" value="${OFFICIAL_AI_GATEWAY_URL}" readonly style="font-family: monospace; background: rgba(0,0,0,0.02);">
                    <button class="btn btn-outline copy-btn" data-target="ai-endpoint-input" style="flex-shrink: 0;">${t('common.copy')}</button>
                </div>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <label style="font-size: 12px; margin: 0; display: block;">${t('ai.devKeysLabel')}</label>
                </div>
                ${renderKeysSlotsHtml(config.gateway.keys)}
            </div>
        </div>

        <div class="ai-card">
            <h3 class="ai-card-title">${t('ai.policyTitle')}</h3>
            <div class="ai-policy-grid">
                <div>
                    <label style="font-size: 12px; margin-bottom: 4px; display: block; color: var(--text-secondary);">${t('ai.unauthLimit')}</label>
                    <input type="number" id="ai-unauth-limit" class="form-control" value="${config.sitePolicy.unauthDailyLimit || 9}" min="1" max="100">
                </div>
                <div>
                    <label style="font-size: 12px; margin-bottom: 4px; display: block; color: var(--text-secondary);">${t('ai.authLimit')}</label>
                    <input type="number" id="ai-auth-limit" class="form-control" value="${config.sitePolicy.authDailyLimit || 64}" min="1" max="500">
                </div>
            </div>
            <div style="margin-bottom: 12px;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; margin: 0 0 8px; color: var(--text-primary);">
                    <input type="checkbox" id="ai-moderation-cf-enabled" ${config.sitePolicy?.moderationCfAiEnabled === false ? '' : 'checked'}>
                    <span>${t('ai.cfModeration')}</span>
                </label>
                <label style="font-size: 12px; margin-bottom: 4px; display: block; color: var(--text-secondary);">${t('ai.backupModeration')}</label>
                ${renderModerationSelectHtml(config)}
            </div>

            <div style="padding-top: 10px; border-top: 1px dashed var(--border-color);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; cursor: pointer; user-select: none; margin: 0; color: var(--text-primary);">
                        <input type="checkbox" id="ai-tg-enabled" ${config.telegram?.enabled ? 'checked' : ''}>
                        <span>${t('ai.tgEnable')}</span>
                    </label>
                    <button type="button" class="btn btn-outline btn-sm" id="ai-test-tg-btn" style="padding: 2px 8px; font-size: 11px; display: inline-flex; align-items: center; border-color: var(--primary-color); color: var(--primary-color);" title="${t('ai.tgTestTitle')}">
                        <span id="ai-test-tg-text">${t('ai.tgSendTest')}</span>
                    </button>
                </div>
                <div class="ai-tg-fields-grid">
                    <div>
                        <label style="font-size: 11px; margin-bottom: 3px; display: block; color: var(--text-secondary);">Bot Token</label>
                        <input type="password" id="ai-tg-bot-token" class="form-control" placeholder="${t('ai.tgTokenPlaceholder')}" value="${escapeAttr(config.telegram?.botToken || '')}" autocomplete="off" spellcheck="false">
                    </div>
                    <div>
                        <label style="font-size: 11px; margin-bottom: 3px; display: block; color: var(--text-secondary);">Chat ID</label>
                        <input type="text" id="ai-tg-chat-id" class="form-control" placeholder="${t('ai.tgChatPlaceholder')}" value="${escapeAttr(config.telegram?.chatId || '')}" spellcheck="false">
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="ai-card" style="margin-top: 20px;">
        <div style="margin-bottom: 12px;">
            <h3 class="ai-card-title" style="margin-bottom: 2px;">${t('ai.chainTitle')}</h3>
            <p style="font-size: 12px; color: var(--text-secondary); margin: 0;">${t('ai.chainDesc')}</p>
        </div>

        <div class="ai-fallback-chain-container" id="ai-fallback-chain">
            ${renderFallbackChainItems(config.providers, chainIds)}
        </div>
    </div>

    <div class="ai-card" style="margin-top: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
            <div>
                <h3 class="ai-card-title" style="margin-bottom: 2px;">${t('ai.providersTitle')}</h3>
                <p style="font-size: 12px; color: var(--text-secondary); margin: 0;">${t('ai.providersSummary', { total: config.providers.length, active: activeProviders.length })}</p>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
                <button class="btn btn-outline btn-sm" id="ai-hub-code-btn" title="${t('ai.guideTitle')}" style="font-size: 12px; padding: 4px 10px;">${t('ai.guide')}</button>
                <button class="btn btn-outline btn-sm" id="ai-hub-test-btn" title="${t('ai.speedTestTitle')}" style="font-size: 12px; padding: 4px 10px;">${t('ai.speedTest')}</button>
                <button class="btn btn-success btn-sm" id="ai-add-provider-btn" style="font-size: 12px; padding: 4px 12px;">${t('ai.addProvider')}</button>
            </div>
        </div>

        <div class="ai-providers-grid" id="ai-providers-grid">
            ${renderProviderCards(config.providers)}
        </div>
    </div>
    `;
}

/**
 * 评论备用审核模型下拉框：值为 "服务商ID/模型名"，空值表示跟随默认降级链
 */
function renderModerationSelectHtml(config) {
    const current = config.sitePolicy?.moderationModel || '';
    let found = false;
    let options = '';
    for (const p of (config.providers || [])) {
        if (!p || !p.id) continue;
        const models = String(p.models || '').split(',').map(m => m.trim()).filter(Boolean);
        if (p.defaultModel && !models.includes(p.defaultModel)) models.unshift(p.defaultModel);
        if (models.length === 0) continue;
        options += `<optgroup label="${escapeAttr(p.name || p.id)}${p.enabled ? '' : escapeAttr(t('ai.disabledSuffix'))}">`;
        for (const m of models) {
            const val = `${p.id}/${m}`;
            const sel = val === current ? ' selected' : '';
            if (sel) found = true;
            options += `<option value="${escapeAttr(val)}"${sel}>${escapeHtml(m)}</option>`;
        }
        options += '</optgroup>';
    }
    if (current && !found) {
        options = `<option value="${escapeAttr(current)}" selected>${escapeHtml(current)}${t('ai.invalidSuffix')}</option>` + options;
    }
    return `<select id="ai-moderation-model" class="form-control">
                    <option value=""${current ? '' : ' selected'}>${t('ai.followChain')}</option>
                    ${options}
                </select>`;
}
