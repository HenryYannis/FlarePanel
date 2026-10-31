// ====================================================
// 统一 AI 代理网关 - 业务胶囊主控制器 (AI Hub Controller)
// 职责：总装预设配置、监控大盘、模型路由与交互弹窗，输出统一生命周期接口
// 网关地址见 sites.config.js 的 AI_HUB
// ====================================================

import { showConfirm, showAlert } from '../../dialog.js';
import { t, langHeaders } from '../../i18n.js';
import { getCredentials } from '../../api.js';
import { 
    AI_KV_NAMESPACE_ID, 
    AI_KV_CONFIG_KEY, 
    OFFICIAL_AI_GATEWAY_URL, 
    PROVIDER_TEMPLATES, 
    DEFAULT_AI_CONFIG, 
    generateRandomKey, 
    ensureGatewayKeys 
} from './presets.js';

import { 
    fetchAiHubMetrics, 
    renderMetricsTabHtml, 
    renderVerticalBarChart,
    getCachedMetricsData,
    isMetricsDataLoading 
} from './metrics.js';

import { 
    loadAiConfig, 
    saveAiConfigToKv, 
    renderConfigTabHtml, 
    getProviderPollModels, 
    renderFallbackChainItems, 
    renderProviderCards, 
    renderKeysSlotsHtml, 
    getCurrentAiConfig, 
    setCurrentAiConfig, 
    isKvAuthError, 
    maskApiKey,
    toggleProviderKeyRevealed,
    keyVisibilityIcon
} from './routing.js';

import { 
    setupModalCallbacks, 
    openProviderModal, 
    openTestModal, 
    openCodeModal, 
    openKeySlotModal, 
    ensureAiModals, 
    initModalBindings 
} from './modals.js';

// 子栏目与监控周期状态
let currentSubTab = 'metrics'; // 'metrics' | 'config'
let currentMetricsDays = 7;
let ctx = null; // 全局工具上下文 { showToast, showLoading, hideLoading }

// 自动持久化同步配置至 Cloudflare 边缘 KV
export async function syncAiConfig(toastMessage = '', showLoadingSpinner = false) {
    const currentAiConfig = getCurrentAiConfig();
    if (!currentAiConfig) return;
    ensureGatewayKeys(currentAiConfig);

    const firstActive = currentAiConfig.gateway?.keys?.find(k => k && k.enabled && k.key);
    if (currentAiConfig.gateway) {
        currentAiConfig.gateway.masterKey = firstActive ? firstActive.key : (currentAiConfig.gateway.keys?.[0]?.key || '');
    }
    const unauthLimitInput = document.getElementById('ai-unauth-limit');
    if (unauthLimitInput) {
        currentAiConfig.sitePolicy.unauthDailyLimit = parseInt(unauthLimitInput.value) || 9;
    }
    const authLimitInput = document.getElementById('ai-auth-limit');
    if (authLimitInput) {
        currentAiConfig.sitePolicy.authDailyLimit = parseInt(authLimitInput.value) || 64;
    }
    const moderationSelect = document.getElementById('ai-moderation-model');
    if (moderationSelect) {
        currentAiConfig.sitePolicy.moderationModel = moderationSelect.value || '';
    }
    const moderationCfInput = document.getElementById('ai-moderation-cf-enabled');
    if (moderationCfInput) {
        currentAiConfig.sitePolicy.moderationCfAiEnabled = !!moderationCfInput.checked;
    }
    const tgEnabledInput = document.getElementById('ai-tg-enabled');
    const tgBotTokenInput = document.getElementById('ai-tg-bot-token');
    const tgChatIdInput = document.getElementById('ai-tg-chat-id');
    if (tgEnabledInput || tgBotTokenInput || tgChatIdInput) {
        currentAiConfig.telegram = {
            enabled: !!tgEnabledInput?.checked,
            botToken: tgBotTokenInput?.value.trim() || '',
            chatId: tgChatIdInput?.value.trim() || ''
        };
    }

    if (showLoadingSpinner && ctx?.showLoading) {
        ctx.showLoading(t('ai.syncing'));
    }

    try {
        await saveAiConfigToKv(currentAiConfig);
        if (toastMessage && ctx?.showToast) {
            ctx.showToast(toastMessage);
        }
    } catch (err) {
        console.error('Failed to sync config to KV:', err);
        if (err.message && (err.message.includes('401') || err.message.includes('Authentication error'))) {
            if (ctx?.showToast) ctx.showToast(t('ai.syncNoKvPerm'), true);
        } else {
            if (ctx?.showToast) ctx.showToast(t('ai.syncFailed', { msg: err.message }), true);
        }
    } finally {
        if (showLoadingSpinner && ctx?.hideLoading) {
            ctx.hideLoading();
        }
    }
}

/** 添加/编辑服务商后：只刷新服务商卡片与容灾链，不整页重绘 */
export function refreshProvidersUi(container, config) {
    if (!container || !config) return;
    if (currentSubTab !== 'config') {
        renderAiHubView(container, config);
        return;
    }
    const activeProviders = config.providers.filter(p => p.enabled);
    const grid = container.querySelector('#ai-providers-grid');
    if (grid) grid.innerHTML = renderProviderCards(config.providers);
    const chainEl = container.querySelector('#ai-fallback-chain');
    if (chainEl) {
        chainEl.innerHTML = renderFallbackChainItems(config.providers, config.sitePolicy?.fallbackChain || []);
    }
    const summary = grid?.closest('.ai-card')?.querySelector('p');
    if (summary) summary.textContent = t('ai.providersSummary', { total: config.providers.length, active: activeProviders.length });
    bindAiHubEvents(container, config);
}

/** 删除/保存密钥后：只刷新密钥条 */
export function refreshKeysUi(container, config) {
    if (!container || !config) return;
    if (currentSubTab !== 'config') {
        renderAiHubView(container, config);
        return;
    }
    ensureGatewayKeys(config);
    const old = container.querySelector('.ai-keys-grid');
    if (old) {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderKeysSlotsHtml(config.gateway.keys);
        const next = wrap.firstElementChild;
        if (next) old.replaceWith(next);
    }
    container.querySelectorAll('.ai-key-slot-btn').forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.dataset.slotIndex);
            if (!isNaN(idx)) openKeySlotModal(idx);
        };
    });
}

// 渲染主视图
export function renderAiHubView(container, config) {
    const activeProviders = config.providers.filter(p => p.enabled);
    const chainIds = config.sitePolicy?.fallbackChain || [];

    const warningBannerHtml = isKvAuthError() ? `
    <div style="margin-top: 16px; padding: 14px 18px; background: rgba(var(--danger-color-rgb), 0.08); border: 1px solid rgba(var(--danger-color-rgb), 0.3); border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between; gap: 16px;">
        <div>
            <div style="font-weight: 700; color: var(--danger-color); font-size: 13.5px; margin-bottom: 2px;">
                ${t('ai.kvWarnTitle')}
            </div>
            <div style="font-size: 12.5px; color: var(--text-secondary); line-height: 1.5;">
                ${t('ai.kvWarnBody')}
            </div>
        </div>
        <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" class="btn btn-danger btn-sm" style="flex-shrink: 0;">${t('ai.kvWarnBtn')}</a>
    </div>
    ` : '';

    const html = `
    <div class="ai-hub-wrapper fade-in">
        <div class="ai-hub-header-card">
            <div class="ai-hub-header-left">
                <div class="ai-hub-title-row">
                    <h2 class="ai-hub-page-title">${t('ai.title')}</h2>
                    <span class="ai-status-pill"><span class="ai-dot active"></span> ${t('ai.edgeReady')}</span>
                </div>
                <p style="font-size: 13px; color: var(--text-secondary); margin-top: 6px; line-height: 1.5;">
                    ${t('ai.subtitle')}
                </p>
            </div>
            <div class="ai-hub-header-actions">
                <div class="ai-subtabs-segmented capsule-tabs" data-capsule-tabs="ai-subtabs">
                    <button class="ai-subtab-btn ${currentSubTab === 'metrics' ? 'active' : ''}" data-subtab="metrics">${t('ai.tabMetrics')}</button>
                    <button class="ai-subtab-btn ${currentSubTab === 'config' ? 'active' : ''}" data-subtab="config">${t('ai.tabConfig')}</button>
                </div>
            </div>
        </div>

        ${warningBannerHtml}

        <div id="ai-subtab-content" style="margin-top: 18px;">
            ${currentSubTab === 'metrics' ? renderMetricsTabHtml(getCachedMetricsData(), currentMetricsDays) : renderConfigTabHtml(config, activeProviders, chainIds)}
        </div>
    </div>
    `;

    container.innerHTML = html;
    bindAiHubEvents(container, config);
}

// 绑定视图内部事件
export function bindAiHubEvents(container, config) {
    // 子栏目切换
    container.querySelectorAll('.ai-subtab-btn').forEach(btn => {
        btn.onclick = () => {
            const subtab = btn.dataset.subtab;
            if (subtab && subtab !== currentSubTab) {
                currentSubTab = subtab;
                renderAiHubView(container, config);
                if (currentSubTab === 'metrics' && !getCachedMetricsData() && !isMetricsDataLoading()) {
                    fetchAiHubMetrics(currentMetricsDays, config).then(() => {
                        if (currentSubTab === 'metrics') renderAiHubView(container, config);
                    });
                }
            }
        };
    });

    // 7天 / 30天 走势图切换
    container.querySelectorAll('.ai-trend-switch-btn').forEach(btn => {
        btn.onclick = async () => {
            const days = parseInt(btn.dataset.days);
            if (days && days !== currentMetricsDays) {
                currentMetricsDays = days;
                if (ctx?.showLoading) ctx.showLoading(t('ai.loadingDays', { days }));
                try {
                    await fetchAiHubMetrics(currentMetricsDays, config);
                    renderAiHubView(container, config);
                } catch (err) {
                    if (ctx?.showToast) ctx.showToast(t('ai.switchDaysFailed', { msg: err.message }), true);
                } finally {
                    if (ctx?.hideLoading) ctx.hideLoading();
                }
            }
        };
    });

    // 监控页面刷新按钮
    const refreshMetricsBtn = container.querySelector('#ai-refresh-metrics-btn');
    if (refreshMetricsBtn) {
        refreshMetricsBtn.onclick = async () => {
            refreshMetricsBtn.disabled = true;
            refreshMetricsBtn.textContent = t('ai.refreshing');
            try {
                await fetchAiHubMetrics(currentMetricsDays, config);
                renderAiHubView(container, config);
                if (ctx?.showToast) ctx.showToast(t('ai.metricsRefreshed'));
            } catch (err) {
                if (ctx?.showToast) ctx.showToast(t('ai.metricsRefreshFailed', { msg: err.message }), true);
            }
        };
    }

    // 链路测速与接入向导
    const testBtn = container.querySelector('#ai-hub-test-btn');
    if (testBtn) testBtn.onclick = () => openTestModal();

    const codeBtn = container.querySelector('#ai-hub-code-btn');
    if (codeBtn) codeBtn.onclick = () => openCodeModal();

    // 复制按钮
    container.querySelectorAll('.copy-btn').forEach(btn => {
        btn.onclick = () => {
            const targetId = btn.dataset.target;
            const input = document.getElementById(targetId);
            if (input) {
                navigator.clipboard.writeText(input.value).then(() => {
                    if (ctx?.showToast) ctx.showToast(t('common.copied'));
                });
            }
        };
    });

    // 点击密钥卡片或「新建」打开二级管理弹窗
    container.querySelectorAll('.ai-key-slot-btn').forEach(btn => {
        btn.onclick = () => {
            const idx = parseInt(btn.dataset.slotIndex);
            if (!isNaN(idx)) {
                openKeySlotModal(idx);
            }
        };
    });

    // 防刷策略与 Telegram 配置自动同步
    ['#ai-unauth-limit', '#ai-auth-limit', '#ai-moderation-model', '#ai-moderation-cf-enabled', '#ai-tg-bot-token', '#ai-tg-chat-id'].forEach(sel => {
        const el = container.querySelector(sel);
        if (el) {
            el.onchange = () => syncAiConfig(t('ai.policySynced'), false);
        }
    });
    const tgEnabled = container.querySelector('#ai-tg-enabled');
    if (tgEnabled) {
        tgEnabled.onchange = () => syncAiConfig(tgEnabled.checked ? t('ai.tgOnSynced') : t('ai.tgOffSynced'), false);
    }

    // Telegram 测试发送
    const testTgBtn = container.querySelector('#ai-test-tg-btn');
    const testTgText = container.querySelector('#ai-test-tg-text');
    if (testTgBtn) {
        testTgBtn.onclick = async () => {
            const botToken = container.querySelector('#ai-tg-bot-token')?.value.trim();
            const chatId = container.querySelector('#ai-tg-chat-id')?.value.trim();
            if (!botToken || !chatId) {
                return showAlert({ title: t('ai.tgMissingTitle'), message: t('ai.tgMissing') });
            }

            testTgBtn.disabled = true;
            testTgText.textContent = t('ai.tgSending');

            try {
                // 只走 /api/test-telegram（需要管理员 Token），不再从浏览器直连 Telegram
                const res = await fetch('/api/test-telegram', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${getCredentials().apiToken}`,
                        ...langHeaders()
                    },
                    body: JSON.stringify({ botToken, chatId })
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.success) {
                    if (ctx?.showToast) ctx.showToast(t('ai.tgSent'));
                } else {
                    showAlert({
                        title: t('ai.tgFailedTitle'),
                        message: data.error || (res.ok ? t('ai.tgFailedDefault') : `HTTP ${res.status}`),
                        type: 'warning'
                    });
                }
            } catch (err) {
                showAlert({
                    title: t('ai.tgNetworkTitle'),
                    message: t('ai.tgNetwork', { msg: err.message }),
                    type: 'danger'
                });
            } finally {
                testTgBtn.disabled = false;
                testTgText.textContent = t('ai.tgSendTest');
            }
        };
    }

    // 启用/禁用服务商
    container.querySelectorAll('.ai-provider-toggle').forEach(chk => {
        chk.onchange = async () => {
            const pid = chk.dataset.id;
            const p = config.providers.find(item => item.id === pid);
            if (p) {
                p.enabled = chk.checked;
                renderAiHubView(container, config);
                await syncAiConfig(t(p.enabled ? 'ai.providerEnabledSynced' : 'ai.providerDisabledSynced', { name: p.name }), false);
            }
        };
    });

    // 服务商密钥：点眼睛或 Key 文本，在等长星号与明文之间切换
    container.querySelectorAll('.ai-provider-key-toggle, .ai-provider-key-val.is-toggle').forEach(el => {
        el.onclick = (e) => {
            e.stopPropagation();
            const id = e.currentTarget.dataset.providerId;
            if (!id) return;
            const p = config.providers.find(item => item.id === id);
            if (!p?.apiKey) return;
            const shown = toggleProviderKeyRevealed(id);
            const card = el.closest('.ai-provider-card');
            if (!card) return;
            const val = card.querySelector('.ai-provider-key-val');
            const eye = card.querySelector('.ai-provider-key-toggle');
            const raw = String(p.apiKey);
            if (val) val.textContent = shown ? raw : '*'.repeat(raw.length);
            if (eye) {
                eye.innerHTML = keyVisibilityIcon(shown);
                eye.setAttribute('aria-pressed', shown ? 'true' : 'false');
            }
        };
    });

    // 复制服务商完整 API Key
    container.querySelectorAll('.ai-copy-provider-key-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const key = btn.dataset.key;
            if (key) {
                navigator.clipboard.writeText(key).then(() => {
                    if (ctx?.showToast) ctx.showToast(t('ai.apiKeyCopied'));
                });
            }
        };
    });

    // 模型标签点击切换轮询
    container.querySelectorAll('.ai-model-tag-btn').forEach(btn => {
        btn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const pid = btn.dataset.providerId;
            const modelName = btn.dataset.model;
            const p = config.providers.find(item => item.id === pid);
            if (!p || !modelName) return;

            let poll = getProviderPollModels(p);
            if (poll.includes(modelName)) {
                if (poll.length <= 1) {
                    return showAlert({ title: t('dialog.alertTitle'), message: t('ai.keepOneModel', { name: p.name }) });
                }
                poll = poll.filter(m => m !== modelName);
                p.pollModels = poll;
                if (p.defaultModel === modelName) {
                    p.defaultModel = poll[0];
                }
                renderAiHubView(container, config);
                await syncAiConfig(t('ai.modelRemovedFromPoll', { model: modelName, name: p.name }), true);
            } else {
                poll.push(modelName);
                p.pollModels = poll;
                if (!p.defaultModel) p.defaultModel = poll[0];
                renderAiHubView(container, config);
                await syncAiConfig(t('ai.modelAddedToPoll', { model: modelName, name: p.name, pos: poll.length }), true);
            }
        };
    });

    // 编辑服务商
    container.querySelectorAll('.ai-edit-provider-btn').forEach(btn => {
        btn.onclick = () => {
            const pid = btn.dataset.id;
            const p = config.providers.find(item => item.id === pid);
            if (p) openProviderModal(p);
        };
    });

    // 删除服务商
    container.querySelectorAll('.ai-del-provider-btn').forEach(btn => {
        btn.onclick = async () => {
            const pid = btn.dataset.id;
            const p = config.providers.find(item => item.id === pid);
            if (p) {
                const ok = await showConfirm({
                    title: t('ai.deleteProviderTitle'),
                    message: t('ai.deleteProviderMessage', { name: p.name }),
                    confirmText: t('common.confirmDelete'),
                    danger: true
                });
                if (ok) {
                    config.providers = config.providers.filter(item => item.id !== pid);
                    config.sitePolicy.fallbackChain = config.sitePolicy.fallbackChain.filter(id => id !== pid);
                    renderAiHubView(container, config);
                    await syncAiConfig(t('ai.providerDeletedSynced', { name: p.name }), false);
                }
            }
        };
    });

    // 添加新服务商
    const addProviderBtn = container.querySelector('#ai-add-provider-btn');
    if (addProviderBtn) {
        addProviderBtn.onclick = () => openProviderModal(null);
    }

    // 降级链调整
    container.querySelectorAll('.ai-chain-move-btn, .ai-chain-del-btn').forEach(btn => {
        btn.onclick = async () => {
            const action = btn.dataset.action;
            const idx = parseInt(btn.dataset.index);
            const chain = config.sitePolicy.fallbackChain;

            if (action === 'move-up' && idx > 0) {
                const temp = chain[idx];
                chain[idx] = chain[idx - 1];
                chain[idx - 1] = temp;
                renderAiHubView(container, config);
                await syncAiConfig(t('ai.chainAdjusted'), false);
            } else if (action === 'move-down' && idx < chain.length - 1) {
                const temp = chain[idx];
                chain[idx] = chain[idx + 1];
                chain[idx + 1] = temp;
                renderAiHubView(container, config);
                await syncAiConfig(t('ai.chainAdjusted'), false);
            } else if (action === 'remove-chain') {
                chain.splice(idx, 1);
                renderAiHubView(container, config);
                await syncAiConfig(t('ai.chainRemoved'), false);
            }
        };
    });

    // 添加服务商到降级链
    const addChainBtn = container.querySelector('#ai-chain-add-btn');
    const addChainSelect = container.querySelector('#ai-chain-add-select');
    if (addChainBtn && addChainSelect) {
        addChainBtn.onclick = async () => {
            const val = addChainSelect.value;
            if (val && !config.sitePolicy.fallbackChain.includes(val)) {
                config.sitePolicy.fallbackChain.push(val);
                renderAiHubView(container, config);
                await syncAiConfig(t('ai.chainAdded'), false);
            }
        };
    }
}

// 统一向外部输出标准胶囊对象
export const AiHubModule = {
    init(context) {
        ctx = context;
        setupModalCallbacks({
            getConfig: () => getCurrentAiConfig(),
            getContext: () => ctx,
            renderAiHubView: (container, cfg) => renderAiHubView(container, cfg),
            refreshProvidersUi: (container, cfg) => refreshProvidersUi(container, cfg),
            refreshKeysUi: (container, cfg) => refreshKeysUi(container, cfg),
            syncAiConfig: (msg, spinner) => syncAiConfig(msg, spinner),
            fetchAiHubMetrics: (days) => fetchAiHubMetrics(days, getCurrentAiConfig()),
            getSubTab: () => currentSubTab,
            getMetricsDays: () => currentMetricsDays
        });
        initModalBindings();
    },

    async mount() {
        const container = document.getElementById('ai-hub-container');
        if (!container) return;

        container.style.display = 'block';

        const cachedCfg = getCurrentAiConfig();
        if (cachedCfg) {
            renderAiHubView(container, cachedCfg);
            if (!getCachedMetricsData() && !isMetricsDataLoading()) {
                fetchAiHubMetrics(currentMetricsDays, cachedCfg).then(() => {
                    if (currentSubTab === 'metrics') renderAiHubView(container, cachedCfg);
                });
            }
            return;
        }

        container.innerHTML = `<div class="empty-state" style="padding: 60px 0;"><span class="loader-inline"></span> ${t('ai.loadingConfig')}</div>`;
        try {
            const cfg = await loadAiConfig();
            renderAiHubView(container, cfg);
            fetchAiHubMetrics(currentMetricsDays, cfg).then(() => {
                if (currentSubTab === 'metrics') renderAiHubView(container, cfg);
            });
        } catch (err) {
            if (ctx?.showToast) ctx.showToast(t('ai.loadConfigFailed', { msg: err.message }), true);
        }
    },

    unmount() {
        const container = document.getElementById('ai-hub-container');
        if (container) container.style.display = 'none';

        ['ai-provider-modal', 'ai-test-modal', 'ai-code-modal', 'ai-keyslot-modal'].forEach(id => {
            const m = document.getElementById(id);
            if (m) m.style.display = 'none';
        });
    },

    onSiteChange() {
        // AI Hub 全网唯一网关路由，无需切站重拉
    }
};

// 重新导出全部公共常量与工具方法，保证 100% 接口向下兼容
export { 
    AI_KV_NAMESPACE_ID, 
    AI_KV_CONFIG_KEY, 
    OFFICIAL_AI_GATEWAY_URL, 
    PROVIDER_TEMPLATES, 
    DEFAULT_AI_CONFIG, 
    generateRandomKey, 
    ensureGatewayKeys,
    loadAiConfig,
    saveAiConfigToKv,
    fetchAiHubMetrics,
    maskApiKey,
    getProviderPollModels
};

// 确保 DOM 准备完毕时挂载弹窗骨架
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureAiModals);
    } else {
        ensureAiModals();
    }
}
