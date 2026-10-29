// ====================================================
// 统一 AI 代理网关 - 业务胶囊主控制器 (AI Hub Controller)
// 职责：总装预设配置、监控大盘、模型路由与交互弹窗，输出统一生命周期接口
// 网关地址见 sites.config.js 的 AI_HUB
// ====================================================

import { showConfirm, showAlert } from '../../dialog.js';
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
    maskApiKey 
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
        ctx.showLoading('正在同步至边缘节点...');
    }

    try {
        await saveAiConfigToKv(currentAiConfig);
        if (toastMessage && ctx?.showToast) {
            ctx.showToast(toastMessage);
        }
    } catch (err) {
        console.error('自动同步配置至 KV 失败:', err);
        if (err.message && (err.message.includes('401') || err.message.includes('Authentication error'))) {
            if (ctx?.showToast) ctx.showToast('同步失败: API Token 缺少 Workers KV Edit 权限！', true);
        } else {
            if (ctx?.showToast) ctx.showToast(`同步失败: ${err.message}`, true);
        }
    } finally {
        if (showLoadingSpinner && ctx?.hideLoading) {
            ctx.hideLoading();
        }
    }
}

// 渲染主视图
export function renderAiHubView(container, config) {
    const activeProviders = config.providers.filter(p => p.enabled);
    const chainIds = config.sitePolicy?.fallbackChain || [];

    const warningBannerHtml = isKvAuthError() ? `
    <div style="margin-top: 16px; padding: 14px 18px; background: rgba(255, 60, 60, 0.08); border: 1px solid rgba(255, 60, 60, 0.3); border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: space-between; gap: 16px;">
        <div>
            <div style="font-weight: 700; color: var(--danger-color); font-size: 13.5px; margin-bottom: 2px;">
                提示：当前 Cloudflare API Token 缺少 Workers KV 存储权限 (401)
            </div>
            <div style="font-size: 12.5px; color: var(--text-secondary); line-height: 1.5;">
                当前已加载安全默认模板。如需在后台保存与实时同步网关配置，请前往 Cloudflare 仪表盘为该 Token 补充勾选 <strong>Account -> Workers KV Storage -> Edit</strong> 权限。
            </div>
        </div>
        <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" class="btn btn-danger btn-sm" style="flex-shrink: 0;">前往补充权限</a>
    </div>
    ` : '';

    const html = `
    <div class="ai-hub-wrapper fade-in">
        <div class="ai-hub-header-card">
            <div class="ai-hub-header-left">
                <div class="ai-hub-title-row">
                    <h2 style="font-size: 1.35rem; font-weight: 700; color: var(--text-primary); margin: 0;">代理网关控制中心</h2>
                    <span class="ai-status-pill"><span class="ai-dot active"></span> 边缘就绪</span>
                </div>
                <p style="font-size: 13px; color: var(--text-secondary); margin-top: 6px; line-height: 1.5;">
                    统一管理多服务商大模型密钥与降级容灾链路，向全站及 VS Code / Hermes 输出标准 OpenAI 兼容接口。
                </p>
            </div>
            <div class="ai-hub-header-actions">
                <div class="ai-subtabs-segmented capsule-tabs" data-capsule-tabs="ai-subtabs">
                    <button class="ai-subtab-btn ${currentSubTab === 'metrics' ? 'active' : ''}" data-subtab="metrics">运行监控</button>
                    <button class="ai-subtab-btn ${currentSubTab === 'config' ? 'active' : ''}" data-subtab="config">网关配置</button>
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
                if (ctx?.showLoading) ctx.showLoading(`正在拉取近 ${days} 天运行数据...`);
                try {
                    await fetchAiHubMetrics(currentMetricsDays, config);
                    renderAiHubView(container, config);
                } catch (err) {
                    if (ctx?.showToast) ctx.showToast(`切换天数失败: ${err.message}`, true);
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
            refreshMetricsBtn.textContent = '正在刷新...';
            try {
                await fetchAiHubMetrics(currentMetricsDays, config);
                renderAiHubView(container, config);
                if (ctx?.showToast) ctx.showToast('监控统计已刷新');
            } catch (err) {
                if (ctx?.showToast) ctx.showToast(`刷新监控统计失败: ${err.message}`, true);
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
                    if (ctx?.showToast) ctx.showToast('已复制到剪贴板');
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
            el.onchange = () => syncAiConfig('策略配置已自动同步', false);
        }
    });
    const tgEnabled = container.querySelector('#ai-tg-enabled');
    if (tgEnabled) {
        tgEnabled.onchange = () => syncAiConfig(tgEnabled.checked ? '已开启 Telegram 告警并同步' : '已关闭 Telegram 告警并同步', false);
    }

    // Telegram 测试发送
    const testTgBtn = container.querySelector('#ai-test-tg-btn');
    const testTgText = container.querySelector('#ai-test-tg-text');
    if (testTgBtn) {
        testTgBtn.onclick = async () => {
            const botToken = container.querySelector('#ai-tg-bot-token')?.value.trim();
            const chatId = container.querySelector('#ai-tg-chat-id')?.value.trim();
            if (!botToken || !chatId) {
                return showAlert({ title: '参数缺失', message: '请先填写完整的 Telegram Bot Token 和 Chat ID！' });
            }

            testTgBtn.disabled = true;
            testTgText.textContent = '发送中...';

            try {
                let handled = false;
                try {
                    const edgeRes = await fetch('/api/test-telegram', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getCredentials().apiToken}` },
                        body: JSON.stringify({ botToken, chatId })
                    });
                    if (edgeRes.status !== 404 && edgeRes.status !== 405) {
                        handled = true;
                        const data = await edgeRes.json();
                        if (data.success) {
                            if (ctx?.showToast) ctx.showToast('Telegram 测试消息已成功送达！');
                        } else {
                            showAlert({ 
                                title: '发送失败', 
                                message: data.error || '未能发送测试通知，请检查参数设置。', 
                                type: 'warning' 
                            });
                        }
                    }
                } catch {
                    // 若边缘函数不可达（如无 Functions 的静态环境），回退至浏览器直连
                }

                if (!handled) {
                    const bjtString = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
                    const message = [
                        `✅ <b>Telegram 通知测试</b>`,
                        ``,
                        `<b>来源</b>：FlarePanel（${location.host}）`,
                        `<b>状态</b>：通知通道正常`,
                        `<b>说明</b>：AI 网关告警会推送到这里`,
                        ``,
                        `<b>时间</b>：${bjtString}（北京时间）`
                    ].join('\n');
                    const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
                    const res = await fetch(tgUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: chatId,
                            text: message,
                            parse_mode: 'HTML'
                        })
                    });
                    const data = await res.json();
                    if (data.ok) {
                        if (ctx?.showToast) ctx.showToast('Telegram 测试消息已成功送达！');
                    } else {
                        showAlert({ 
                            title: '发送失败', 
                            message: `发送失败: ${data.description || '未知错误'}\n请检查 Token 与 Chat ID 是否正确。`, 
                            type: 'warning' 
                        });
                    }
                }
            } catch (err) {
                showAlert({ 
                    title: '网络异常', 
                    message: `网络请求异常: ${err.message}\n提示：直接在浏览器请求 Telegram API 可能受网络环境限制。`, 
                    type: 'danger' 
                });
            } finally {
                testTgBtn.disabled = false;
                testTgText.textContent = '发送测试通知';
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
                await syncAiConfig(`服务商「${p.name}」已${p.enabled ? '启用' : '禁用'}并同步`, false);
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
                    if (ctx?.showToast) ctx.showToast('API Key 已复制到剪贴板');
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
                    return showAlert({ title: '提示', message: `服务商「${p.name}」至少需要保留 1 个生效模型！` });
                }
                poll = poll.filter(m => m !== modelName);
                p.pollModels = poll;
                if (p.defaultModel === modelName) {
                    p.defaultModel = poll[0];
                }
                renderAiHubView(container, config);
                await syncAiConfig(`已将模型「${modelName}」移出「${p.name}」轮询`, true);
            } else {
                poll.push(modelName);
                p.pollModels = poll;
                if (!p.defaultModel) p.defaultModel = poll[0];
                renderAiHubView(container, config);
                await syncAiConfig(`已将模型「${modelName}」加入「${p.name}」轮询 (顺位: ${poll.length})`, true);
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
                    title: '删除服务商确认',
                    message: `确定要删除服务商「${p.name}」吗？其在主备降级链中的路由也将被移除。`,
                    confirmText: '确认删除',
                    danger: true
                });
                if (ok) {
                    config.providers = config.providers.filter(item => item.id !== pid);
                    config.sitePolicy.fallbackChain = config.sitePolicy.fallbackChain.filter(id => id !== pid);
                    renderAiHubView(container, config);
                    await syncAiConfig(`服务商「${p.name}」已删除并同步`, false);
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
                await syncAiConfig('主备降级链已调整并同步', false);
            } else if (action === 'move-down' && idx < chain.length - 1) {
                const temp = chain[idx];
                chain[idx] = chain[idx + 1];
                chain[idx + 1] = temp;
                renderAiHubView(container, config);
                await syncAiConfig('主备降级链已调整并同步', false);
            } else if (action === 'remove-chain') {
                chain.splice(idx, 1);
                renderAiHubView(container, config);
                await syncAiConfig('已从降级链移除并同步', false);
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
                await syncAiConfig('已追加服务商到降级链并同步', false);
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

        container.innerHTML = `<div class="empty-state" style="padding: 60px 0;"><span class="loader-inline"></span> 正在读取统一网关边缘路由配置...</div>`;
        try {
            const cfg = await loadAiConfig();
            renderAiHubView(container, cfg);
            fetchAiHubMetrics(currentMetricsDays, cfg).then(() => {
                if (currentSubTab === 'metrics') renderAiHubView(container, cfg);
            });
        } catch (err) {
            if (ctx?.showToast) ctx.showToast(`加载网关配置失败: ${err.message}`, true);
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
