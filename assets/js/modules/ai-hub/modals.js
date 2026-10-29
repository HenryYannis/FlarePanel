// ====================================================
// 统一 AI 代理网关 - 交互弹窗与调试模块 (Modals & Playground)
// 职责：服务商编辑弹窗、即时测速 Playground、集成代码向导、专属密钥槽位弹窗
// 规范：恪守 AGENTS.md（0 Emoji 铁律、SVG 图标、Promise 对话框统一）
// ====================================================

import { showConfirm, showAlert } from '../../dialog.js';
import { escapeHtml } from '../../utils.js';
import { 
    OFFICIAL_AI_GATEWAY_URL, 
    generateRandomKey, 
    ensureGatewayKeys 
} from './presets.js';
import { getProviderPollModels } from './routing.js';
import { getCredentials } from '../../api.js';

let editingProviderId = null;
let currentFetchedModelsCache = [];
let currentEditingSlotIndex = -1;

// 依赖由外部绑定的回调
let callbacks = {
    getConfig: () => null,
    getContext: () => null,
    renderAiHubView: () => {},
    syncAiConfig: async () => {},
    fetchAiHubMetrics: async () => {},
    getSubTab: () => 'config',
    getMetricsDays: () => 7
};

export function setupModalCallbacks(cbs) {
    callbacks = { ...callbacks, ...cbs };
}

// 获取服务商模态框 DOM 元素
export function getProviderModalElements() {
    return {
        modal: document.getElementById('ai-provider-modal'),
        title: document.getElementById('ai-provider-modal-title'),
        nameInput: document.getElementById('ai-provider-name-input'),
        idInput: document.getElementById('ai-provider-id-input'),
        urlInput: document.getElementById('ai-provider-url-input'),
        keyInput: document.getElementById('ai-provider-key-input'),
        modelsInput: document.getElementById('ai-provider-models-input'),
        defaultModelInput: document.getElementById('ai-provider-default-model-input'),
        fetchedPanel: document.getElementById('ai-fetched-models-panel'),
        fetchedBadges: document.getElementById('ai-fetched-badges-list'),
        fetchedCount: document.getElementById('ai-fetched-count-text')
    };
}

// 关闭默认模型下拉/上拉菜单
export function closeDefaultModelMenu() {
    const menu = document.getElementById('ai-provider-default-model-menu');
    const btn = document.getElementById('ai-provider-default-model-dropdown-btn');
    if (menu) menu.style.display = 'none';
    if (btn) btn.classList.remove('open');
}

// 智能计算并定位默认模型菜单（优先向上折叠展开 Dropup）
export function positionDefaultModelMenu() {
    const menu = document.getElementById('ai-provider-default-model-menu');
    const wrapper = document.getElementById('ai-provider-default-model-wrapper');
    if (!menu || !wrapper) return;

    const rect = wrapper.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    const shouldDropUp = spaceBelow < 260 || spaceAbove > spaceBelow;

    if (shouldDropUp) {
        menu.classList.add('dropup');
        menu.classList.remove('dropdown');
        const maxH = Math.min(280, Math.max(140, Math.floor(spaceAbove - 24)));
        menu.style.maxHeight = `${maxH}px`;
    } else {
        menu.classList.add('dropdown');
        menu.classList.remove('dropup');
        const maxH = Math.min(280, Math.max(140, Math.floor(spaceBelow - 24)));
        menu.style.maxHeight = `${maxH}px`;
    }
}

// 动态刷新默认模型选单候选列表
export function updateDefaultModelDropdownMenu(filterKeyword = '') {
    const menu = document.getElementById('ai-provider-default-model-menu');
    const { modelsInput, defaultModelInput } = getProviderModalElements();
    if (!menu) return;

    const inputModels = (modelsInput?.value || '').split(',').map(m => m.trim()).filter(Boolean);
    const combined = Array.from(new Set([...inputModels, ...currentFetchedModelsCache]));

    if (combined.length === 0) {
        menu.innerHTML = `
            <div style="padding: 12px 14px; font-size: 11px; color: var(--text-secondary); text-align: center;">
                暂无候选模型，请先输入支持的模型或点击【自动拉取模型】
            </div>
        `;
        return;
    }

    const currentVal = defaultModelInput?.value.trim() || '';
    const kw = (typeof filterKeyword === 'string' ? filterKeyword : '').trim().toLowerCase();
    const filtered = kw ? combined.filter(m => m.toLowerCase().includes(kw)) : combined;

    if (filtered.length === 0) {
        menu.innerHTML = `
            <div style="padding: 12px 14px; font-size: 11px; color: var(--text-secondary); text-align: center;">
                未匹配到模型「${escapeHtml(filterKeyword)}」
            </div>
        `;
        return;
    }

    menu.innerHTML = filtered.map(m => `
        <div class="ai-dropdown-item ${m === currentVal ? 'active' : ''}" data-model="${escapeHtml(m)}">
            <span class="ai-dropdown-model-name">${escapeHtml(m)}</span>
        </div>
    `).join('');

    menu.querySelectorAll('.ai-dropdown-item').forEach(item => {
        item.onclick = (e) => {
            e.stopPropagation();
            const val = item.getAttribute('data-model');
            if (defaultModelInput) {
                defaultModelInput.value = val;
            }
            closeDefaultModelMenu();
            const ctx = callbacks.getContext();
            if (ctx?.showToast) ctx.showToast(`已选首选模型: ${val}`);
        };
    });
}

// 展开默认模型选单并平滑滚动到选中项
export function openDefaultModelMenu(filterKeyword = '') {
    const menu = document.getElementById('ai-provider-default-model-menu');
    const btn = document.getElementById('ai-provider-default-model-dropdown-btn');
    if (!menu) return;

    updateDefaultModelDropdownMenu(filterKeyword);
    positionDefaultModelMenu();
    menu.style.display = 'block';
    if (btn) btn.classList.add('open');

    requestAnimationFrame(() => {
        const activeItem = menu.querySelector('.ai-dropdown-item.active');
        if (activeItem) {
            activeItem.scrollIntoView({ block: 'nearest' });
        }
    });
}

// 模态框管理：服务商编辑
export function openProviderModal(provider) {
    editingProviderId = provider ? provider.id : null;
    const {
        modal, title,
        nameInput, idInput, urlInput, keyInput,
        modelsInput, defaultModelInput,
        fetchedPanel, fetchedBadges
    } = getProviderModalElements();

    if (!modal) return;

    if (title) title.textContent = provider ? `编辑服务商「${provider.name}」` : '添加新服务商';

    if (provider) {
        if (nameInput) nameInput.value = provider.name || '';
        if (idInput) {
            idInput.value = provider.id || '';
            idInput.disabled = false;
        }
        if (urlInput) urlInput.value = provider.baseUrl || '';
        if (keyInput) keyInput.value = provider.apiKey || '';
        if (modelsInput) modelsInput.value = provider.models || '';
        if (defaultModelInput) defaultModelInput.value = provider.defaultModel || '';
    } else {
        if (nameInput) nameInput.value = '';
        if (idInput) {
            idInput.value = '';
            idInput.disabled = false;
        }
        if (urlInput) urlInput.value = '';
        if (keyInput) keyInput.value = '';
        if (modelsInput) modelsInput.value = '';
        if (defaultModelInput) defaultModelInput.value = '';
    }

    const searchInput = document.getElementById('ai-models-search-input');
    const searchClear = document.getElementById('ai-models-search-clear');
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.style.display = 'none';
    currentFetchedModelsCache = [];
    if (fetchedPanel) fetchedPanel.style.display = 'none';
    if (fetchedBadges) fetchedBadges.innerHTML = '';

    closeDefaultModelMenu();
    updateDefaultModelDropdownMenu();

    modal.style.display = 'flex';
}

// 渲染拉取到的模型列表徽章
export function renderFetchedModelBadges(filterKeyword = '') {
    const { fetchedBadges: listEl, modelsInput, defaultModelInput } = getProviderModalElements();
    const countText = document.getElementById('ai-fetched-count-text');
    if (!listEl) return;

    const curVal = modelsInput ? modelsInput.value : '';
    const currentSelected = curVal.split(',').map(m => m.trim()).filter(Boolean);

    const kw = (typeof filterKeyword === 'string' ? filterKeyword : '').trim().toLowerCase();
    const visibleModels = kw
        ? currentFetchedModelsCache.filter(m => m.toLowerCase().includes(kw))
        : currentFetchedModelsCache;

    if (countText) {
        if (kw) {
            countText.textContent = `筛选结果: ${visibleModels.length} / ${currentFetchedModelsCache.length} 个模型 (点击添加/移除):`;
        } else {
            countText.textContent = `已获取 ${currentFetchedModelsCache.length} 个模型 (点击标签添加/移除):`;
        }
    }

    if (visibleModels.length === 0) {
        listEl.innerHTML = `<div style="padding: 8px 12px; font-size: 11px; color: var(--text-secondary);">无匹配模型，请尝试更换搜索词</div>`;
        return;
    }

    listEl.innerHTML = visibleModels.map(m => {
        const isSelected = currentSelected.includes(m);
        return `
            <button type="button" class="ai-model-badge" data-model="${escapeHtml(m)}" style="
                font-size: 11px;
                padding: 3px 8px;
                border-radius: 4px;
                border: 1px solid ${isSelected ? 'var(--primary-color)' : 'var(--border-color)'};
                background: ${isSelected ? 'var(--primary-color)' : 'var(--bg-secondary)'};
                color: ${isSelected ? '#ffffff' : 'var(--text-primary)'};
                cursor: pointer;
                user-select: none;
                transition: background 0.15s, border-color 0.15s;
            ">${escapeHtml(m)}</button>
        `;
    }).join('');

    listEl.querySelectorAll('.ai-model-badge').forEach(btn => {
        btn.onclick = () => {
            const modelName = btn.getAttribute('data-model');
            let cur = (modelsInput?.value || '').split(',').map(m => m.trim()).filter(Boolean);
            if (cur.includes(modelName)) {
                cur = cur.filter(m => m !== modelName);
                if (defaultModelInput && defaultModelInput.value.trim() === modelName) {
                    defaultModelInput.value = cur[0] || '';
                }
            } else {
                cur.push(modelName);
                if (defaultModelInput && !defaultModelInput.value.trim()) {
                    defaultModelInput.value = modelName;
                }
            }
            if (modelsInput) modelsInput.value = cur.join(', ');
            const searchInput = document.getElementById('ai-models-search-input');
            renderFetchedModelBadges(searchInput ? searchInput.value : '');
            updateDefaultModelDropdownMenu();
        };
    });
}

// 模态框管理：测速 Playground
export function openTestModal() {
    const modal = document.getElementById('ai-test-modal');
    const resultBox = document.getElementById('ai-test-result-box');
    const timing = document.getElementById('ai-test-timing');
    const targetSelect = document.getElementById('ai-test-target-select') || document.getElementById('ai-test-target');
    if (!modal) return;

    if (resultBox) resultBox.textContent = '请选择上方测试目标，点击下方【发送测试请求】开始验证...';
    if (timing) timing.textContent = '耗时: -';

    const currentAiConfig = callbacks.getConfig();
    if (targetSelect && currentAiConfig) {
        let optionsHtml = `<option value="__AUTO__">全自动双层容灾降级链 (全网首选路由及多级故障转移)</option>`;
        const providers = (currentAiConfig.providers || []).filter(p => p.enabled);
        if (providers.length > 0) {
            providers.forEach(p => {
                optionsHtml += `<optgroup label="服务商: ${escapeHtml(p.name)} (${escapeHtml(p.id)})">`;
                const pollModels = getProviderPollModels(p);
                const pollSummary = pollModels.length > 1
                    ? `已勾选 ${pollModels.length} 个模型轮询`
                    : `单模型模式: ${pollModels[0] || '默认'}`;
                optionsHtml += `<option value="provider:${p.id}">${escapeHtml(p.name)} (${pollSummary})</option>`;
                const rawModelList = (p.models || '').split(',').map(m => m.trim()).filter(Boolean);
                rawModelList.forEach(m => {
                    const isChecked = pollModels.includes(m);
                    const rank = pollModels.indexOf(m);
                    const roleLabel = isChecked ? (rank === 0 ? '首选' : `备用 ${rank + 1}`) : '未勾选';
                    const scopedM = p.id ? `${p.id}/${m}` : m;
                    optionsHtml += `<option value="model:${scopedM}">${scopedM} (${roleLabel})</option>`;
                });
                optionsHtml += `</optgroup>`;
            });
        }
        targetSelect.innerHTML = optionsHtml;
    }

    modal.style.display = 'flex';
}

// 模态框管理：代码向导
export function openCodeModal() {
    const modal = document.getElementById('ai-code-modal');
    const codeContinue = document.getElementById('code-continue');
    const codeHermes = document.getElementById('code-hermes');
    const currentAiConfig = callbacks.getConfig();
    if (!modal || !currentAiConfig) return;

    const firstActiveKey = currentAiConfig.gateway?.keys?.find(k => k && k.enabled && k.key);
    const masterKey = firstActiveKey?.key || currentAiConfig.gateway?.keys?.[0]?.key || currentAiConfig.gateway?.masterKey || 'sk-xb-...';
    const firstEnabledProvider = currentAiConfig.providers.find(p => p.enabled);
    let sampleModel = 'MiniMax-M3';
    if (firstEnabledProvider) {
        const rawModel = firstEnabledProvider.defaultModel || (firstEnabledProvider.models || '').split(',')[0]?.trim() || 'MiniMax-M3';
        sampleModel = firstEnabledProvider.id ? `${firstEnabledProvider.id}/${rawModel}` : rawModel;
    }

    const continueConfig = {
        models: [
            {
                title: `AI 网关 - ${sampleModel}`,
                provider: "openai",
                model: sampleModel,
                apiKey: masterKey,
                apiBase: OFFICIAL_AI_GATEWAY_URL
            }
        ]
    };
    if (codeContinue) codeContinue.value = JSON.stringify(continueConfig, null, 2);
    if (codeHermes) codeHermes.value = `export OPENAI_API_BASE="${OFFICIAL_AI_GATEWAY_URL}"\nexport OPENAI_API_KEY="${masterKey}"`;

    modal.style.display = 'flex';
}

// 模态框管理：专属密钥槽位设置
export function openKeySlotModal(slotIndex) {
    const currentAiConfig = callbacks.getConfig();
    if (!currentAiConfig) return;
    ensureGatewayKeys(currentAiConfig);
    const modal = document.getElementById('ai-keyslot-modal');
    if (!modal) return;

    currentEditingSlotIndex = slotIndex;
    const k = currentAiConfig.gateway.keys[slotIndex] || { id: '', name: '', key: '', enabled: false };
    const hasConfig = !!(k.enabled && k.key && k.key.trim() && k.name && k.name.trim());

    const titleEl = document.getElementById('ai-keyslot-modal-title');
    const badgeEl = document.getElementById('ai-keyslot-badge');
    const nameInput = document.getElementById('ai-keyslot-name-input');
    const valInput = document.getElementById('ai-keyslot-val-input');
    const deleteBtn = document.getElementById('ai-delete-keyslot-btn');

    if (titleEl) titleEl.textContent = hasConfig ? '管理开发者专属密钥' : '新建开发者专属密钥';
    if (badgeEl) badgeEl.textContent = hasConfig ? `第 ${slotIndex + 1} 组` : "新建";
    if (nameInput) nameInput.value = hasConfig ? k.name : '';
    if (valInput) valInput.value = hasConfig ? k.key : generateRandomKey();
    if (deleteBtn) deleteBtn.style.display = hasConfig ? 'inline-flex' : 'none';

    modal.style.display = 'flex';
    if (nameInput) {
        setTimeout(() => nameInput.focus(), 50);
    }
}

// 动态创建并挂载模态框 DOM
export function ensureAiModals() {
    if (document.getElementById('ai-provider-modal')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'ai-hub-modals-host';
    wrapper.innerHTML = `
    <!-- AI 服务商添加/编辑模态框 -->
    <div class="modal-overlay" id="ai-provider-modal" data-static="true">
        <div class="modal" style="max-width: 580px;">
            <h3 id="ai-provider-modal-title" style="margin-bottom: 0.75rem; color: var(--text-primary);">添加/编辑大模型服务商</h3>

            <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 12px;">
                <div class="form-group">
                    <label for="ai-provider-name-input">服务商显示名称</label>
                    <input type="text" id="ai-provider-name-input" class="form-control" placeholder="例如: 硅基流动 SiliconFlow">
                </div>
                <div class="form-group">
                    <label for="ai-provider-id-input">唯一标识 ID</label>
                    <input type="text" id="ai-provider-id-input" class="form-control" placeholder="例如: provider_siliconflow" spellcheck="false">
                </div>
            </div>

            <div class="form-group">
                <label for="ai-provider-url-input">API Base URL (OpenAI 兼容)</label>
                <input type="text" id="ai-provider-url-input" class="form-control" placeholder="例如: https://api.siliconflow.cn/v1" spellcheck="false">
            </div>

            <div class="form-group">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                    <label for="ai-provider-key-input" style="margin: 0;">API Key (密钥 - 明文可见)</label>
                    <button type="button" class="btn btn-outline btn-sm" id="ai-copy-modal-key-btn" style="padding: 2px 8px; font-size: 11px;" title="复制此密钥">复制密钥</button>
                </div>
                <input type="text" id="ai-provider-key-input" class="form-control" placeholder="输入从服务商获取的 sk-..." spellcheck="false" style="font-family: monospace;">
            </div>

            <div class="form-group">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <label for="ai-provider-models-input" style="margin: 0; font-weight: 600;">支持的模型列表 (英文逗号分隔，默认前 3 个自动轮询)</label>
                    <button type="button" class="btn btn-outline btn-sm" id="ai-fetch-models-btn" style="padding: 2px 8px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px; border-color: var(--primary-color); color: var(--primary-color);" title="向服务商 API 拉取模型 ID 清单">
                        <span id="ai-fetch-models-text">自动拉取模型</span>
                    </button>
                </div>
                <input type="text" id="ai-provider-models-input" class="form-control" placeholder="例如: MiniMax-M3, MiniMax-Text-01, abab6.5s-chat (建议配置 3 个模型)" spellcheck="false">
                <!-- 自动拉取候选面板 -->
                <div id="ai-fetched-models-panel" style="display: none; margin-top: 8px; padding: 10px 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 11px; color: var(--text-secondary);">
                        <span id="ai-fetched-count-text">已拉取可用模型 (点击标签选择，默认按前 3 个自动轮询):</span>
                        <div style="display: flex; gap: 8px;">
                            <a href="javascript:void(0)" id="ai-models-fill-all" style="color: var(--primary-color); text-decoration: none; font-size: 11px;">全选填入</a>
                            <a href="javascript:void(0)" id="ai-models-clear" style="color: var(--text-secondary); text-decoration: none; font-size: 11px;">清空已选</a>
                        </div>
                    </div>
                    <div style="position: relative; margin-bottom: 8px;">
                        <input type="text" id="ai-models-search-input" class="form-control ai-models-search-box" placeholder="搜索过滤拉取的模型 (如 deepseek, qwen, llama, v3)..." spellcheck="false">
                        <button type="button" id="ai-models-search-clear" style="position: absolute; right: 6px; top: 50%; transform: translateY(-50%); background: transparent; border: none; font-size: 12px; color: var(--text-secondary); cursor: pointer; display: none; line-height: 1; align-items: center; justify-content: center; padding: 2px;" title="清空搜索">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                    <div id="ai-fetched-badges-list" style="display: flex; flex-wrap: wrap; gap: 6px; max-height: 120px; overflow-y: auto;"></div>
                </div>
            </div>

            <div class="form-group">
                <label for="ai-provider-default-model-input">首选调用模型 (报错时自动轮询该服务商其余备用模型)</label>
                <div id="ai-provider-default-model-wrapper" style="position: relative; display: flex; align-items: center;">
                    <input type="text" id="ai-provider-default-model-input" class="form-control" placeholder="输入或点击右侧箭头选择模型" spellcheck="false" style="padding-right: 32px;">
                    <button type="button" id="ai-provider-default-model-dropdown-btn" style="position: absolute; right: 4px; width: 26px; height: 26px; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 10px; border-radius: 4px; transition: transform 0.2s ease, color 0.15s ease;" title="展开可用模型列表">
                        <svg class="dropdown-chevron-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition: transform 0.2s ease;"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </button>
                    <div id="ai-provider-default-model-menu" class="ai-dropdown-menu dropup" style="display: none;"></div>
                </div>
            </div>

            <div class="modal-actions" style="margin-top: 24px;">
                <button class="btn btn-outline" id="close-ai-provider-btn">取消</button>
                <button class="btn btn-primary" id="save-ai-provider-btn">保存</button>
            </div>
        </div>
    </div>

    <!-- AI 连通性测试 Playground 模态框 -->
    <div class="modal-overlay" id="ai-test-modal" data-static="true">
        <div class="modal" style="max-width: 650px;">
            <h3 style="margin-bottom: 0.5rem; color: var(--text-primary);">网关链路连通性实时测速</h3>
            <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 14px;">
                通过 Master Key 向统一网关（<code>${OFFICIAL_AI_GATEWAY_URL}</code>）发起真实推理，可任意切换测试各服务商与指定模型。
            </p>
            
            <div class="form-group">
                <label for="ai-test-target-select">选择测试目标（服务商 / 指定模型）</label>
                <select id="ai-test-target-select" class="form-control custom-select">
                    <option value="__AUTO__">全自动主备容灾降级链 (默认兜底流水线)</option>
                </select>
            </div>

            <div class="form-group">
                <label for="ai-test-prompt-input">测试提示词 (Prompt)</label>
                <input type="text" id="ai-test-prompt-input" class="form-control" value="你好！请用一句话告诉我你是谁，并且输出当前时间。">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <label style="margin: 0; font-size: 13px; font-weight: 600; color: var(--text-secondary);">返回响应结果</label>
                <span id="ai-test-timing" style="font-size: 12px; font-family: monospace; color: var(--primary-color);">耗时: -</span>
            </div>
            <div id="ai-test-result-box" class="ai-code-block" style="min-height: 120px; white-space: pre-wrap; font-size: 13px;">点击下方【发送测试请求】开始验证...</div>

            <div class="modal-actions">
                <button class="btn btn-outline" id="close-ai-test-btn">取消</button>
                <button class="btn btn-primary" id="send-ai-test-btn">发送测试请求</button>
            </div>
        </div>
    </div>

    <!-- AI 接入向导代码预览模态框 -->
    <div class="modal-overlay" id="ai-code-modal">
        <div class="modal" style="max-width: 720px;">
            <h3 style="margin-bottom: 0.5rem; color: var(--text-primary);">外部开发工具接入向导</h3>
            <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 16px;">
                网关完全遵循标准 OpenAI API 格式。复制以下配置粘贴至对应的插件中即可使用：
            </p>

            <div style="margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <strong style="font-size: 13px;">1. VS Code Continue 插件 (<code>~/.continue/config.json</code>)</strong>
                    <button class="btn btn-outline btn-sm copy-btn" data-target="code-continue">一键复制</button>
                </div>
                <textarea id="code-continue" class="ai-code-block" style="width: 100%; height: 130px; resize: none;" readonly></textarea>
            </div>

            <div style="margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <strong style="font-size: 13px;">2. Hermes / 终端 CLI 环境变量 (<code>.bashrc</code> / 命令行)</strong>
                    <button class="btn btn-outline btn-sm copy-btn" data-target="code-hermes">一键复制</button>
                </div>
                <textarea id="code-hermes" class="ai-code-block" style="width: 100%; height: 75px; resize: none;" readonly></textarea>
            </div>

            <div class="modal-actions">
                <button class="btn btn-outline" id="close-ai-code-btn">关闭</button>
            </div>
        </div>
    </div>

    <!-- 独立开发者密钥槽位管理模态框 (二级弹窗) -->
    <div class="modal-overlay" id="ai-keyslot-modal" data-static="true">
        <div class="modal" style="max-width: 520px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h3 id="ai-keyslot-modal-title" style="margin: 0; color: var(--text-primary);">配置开发者专属密钥</h3>
                <span id="ai-keyslot-badge" class="ai-slot-badge">槽位 1</span>
            </div>

            <div class="form-group">
                <label for="ai-keyslot-name-input">平台或用途名称</label>
                <input type="text" id="ai-keyslot-name-input" class="form-control" placeholder="例如: VS Code Continue 或 Open Code">
                <div style="display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center;">
                    <span style="font-size: 11px; color: var(--text-secondary);">快捷填入:</span>
                    <button type="button" class="btn btn-outline btn-xs ai-quick-slot-tag" data-tag="VS Code Continue" style="font-size: 11px; padding: 2px 7px;">VS Code Continue</button>
                    <button type="button" class="btn btn-outline btn-xs ai-quick-slot-tag" data-tag="Cline" style="font-size: 11px; padding: 2px 7px;">Cline</button>
                    <button type="button" class="btn btn-outline btn-xs ai-quick-slot-tag" data-tag="Open Code" style="font-size: 11px; padding: 2px 7px;">Open Code</button>
                    <button type="button" class="btn btn-outline btn-xs ai-quick-slot-tag" data-tag="Hermes CLI" style="font-size: 11px; padding: 2px 7px;">Hermes CLI</button>
                </div>
            </div>

            <div class="form-group" style="margin-top: 14px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <label for="ai-keyslot-val-input" style="margin: 0;">API 密钥 (明文可见)</label>
                    <div style="display: flex; gap: 6px;">
                        <button type="button" class="btn btn-outline btn-sm" id="ai-copy-keyslot-btn" style="padding: 2px 8px; font-size: 11px;">复制密钥</button>
                        <button type="button" class="btn btn-outline btn-sm" id="ai-regen-keyslot-btn" style="padding: 2px 8px; font-size: 11px;">重新生成</button>
                    </div>
                </div>
                <input type="text" id="ai-keyslot-val-input" class="form-control" placeholder="sk-xb-ai-..." spellcheck="false" style="font-family: monospace; font-size: 13px;">
                <p style="font-size: 11.5px; color: var(--text-secondary); margin: 6px 0 0 0;">免受普通 IP 限额约束，全网大模型直通调用</p>
            </div>

            <div class="modal-actions-between" style="display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 24px; width: 100%; box-sizing: border-box;">
                <button type="button" class="btn btn-danger" id="ai-delete-keyslot-btn" style="display: none;">删除此密钥</button>
                <div style="display: flex; gap: 10px; margin-left: auto; align-items: center;">
                    <button type="button" class="btn btn-outline" id="close-ai-keyslot-btn">取消</button>
                    <button type="button" class="btn btn-primary" id="save-ai-keyslot-btn">保存</button>
                </div>
            </div>
        </div>
    </div>
    `;

    document.body.appendChild(wrapper);
}

let modalBindingsInitialized = false;

// 初始化全局弹窗交互事件
export function initModalBindings() {
    ensureAiModals();
    if (modalBindingsInitialized) return;
    modalBindingsInitialized = true;

    const searchInput = document.getElementById('ai-models-search-input');
    const searchClearBtn = document.getElementById('ai-models-search-clear');
    if (searchInput) {
        searchInput.oninput = () => {
            const q = searchInput.value;
            if (searchClearBtn) searchClearBtn.style.display = q ? 'block' : 'none';
            renderFetchedModelBadges(q);
        };
    }
    if (searchClearBtn) {
        searchClearBtn.onclick = () => {
            if (searchInput) {
                searchInput.value = '';
                searchClearBtn.style.display = 'none';
                searchInput.focus();
            }
            renderFetchedModelBadges('');
        };
    }

    const defaultModelDropdownBtn = document.getElementById('ai-provider-default-model-dropdown-btn');
    const defaultModelMenu = document.getElementById('ai-provider-default-model-menu');
    const { defaultModelInput: dInput, modelsInput: mInput } = getProviderModalElements();

    if (defaultModelDropdownBtn) {
        defaultModelDropdownBtn.onclick = (e) => {
            e.stopPropagation();
            if (defaultModelMenu && defaultModelMenu.style.display === 'block') {
                closeDefaultModelMenu();
            } else {
                openDefaultModelMenu('');
            }
        };
    }

    if (dInput) {
        dInput.onclick = (e) => {
            e.stopPropagation();
            if (!defaultModelMenu || defaultModelMenu.style.display !== 'block') {
                openDefaultModelMenu('');
            }
        };
        dInput.onfocus = () => {
            if (!defaultModelMenu || defaultModelMenu.style.display !== 'block') {
                openDefaultModelMenu('');
            }
        };
        dInput.oninput = () => {
            openDefaultModelMenu(dInput.value);
        };
    }
    if (mInput) {
        mInput.oninput = () => {
            updateDefaultModelDropdownMenu();
        };
    }

    document.addEventListener('click', (e) => {
        const menu = document.getElementById('ai-provider-default-model-menu');
        const wrapper = document.getElementById('ai-provider-default-model-wrapper');
        if (menu && menu.style.display === 'block') {
            if (wrapper && !wrapper.contains(e.target)) {
                closeDefaultModelMenu();
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeDefaultModelMenu();
        }
    });

    window.addEventListener('resize', () => {
        const menu = document.getElementById('ai-provider-default-model-menu');
        if (menu && menu.style.display === 'block') {
            positionDefaultModelMenu();
        }
    });

    // 自动拉取模型列表
    const fetchModelsBtn = document.getElementById('ai-fetch-models-btn');
    const fetchModelsText = document.getElementById('ai-fetch-models-text');
    if (fetchModelsBtn) {
        fetchModelsBtn.onclick = async () => {
            const { urlInput, keyInput } = getProviderModalElements();
            const baseUrl = urlInput?.value.trim();
            const apiKey = keyInput?.value.trim();
            if (!baseUrl) {
                return showAlert({ title: '参数缺失', message: '请先填写 API Base URL！' });
            }

            fetchModelsBtn.disabled = true;
            if (fetchModelsText) fetchModelsText.textContent = '拉取中...';

            try {
                let resData = null;
                try {
                    const proxyRes = await fetch('/api/fetch-models', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${getCredentials().apiToken}`
                        },
                        body: JSON.stringify({ baseUrl, apiKey })
                    });
                    if (proxyRes.ok) {
                        resData = await proxyRes.json();
                    }
                } catch (proxyErr) {
                    console.warn('Functions 代理拉取未成功，尝试直连服务商:', proxyErr);
                }

                if (!resData || !resData.success) {
                    if (resData && resData.error) throw new Error(resData.error);
                    let cleanUrl = baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
                    if (!cleanUrl.endsWith('/models')) cleanUrl += '/models';
                    const headers = { 'Accept': 'application/json' };
                    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
                    const directRes = await fetch(cleanUrl, { headers });
                    const json = await directRes.json();
                    let list = [];
                    if (Array.isArray(json.data)) list = json.data.map(i => typeof i === 'string' ? i : i.id);
                    else if (Array.isArray(json.models)) list = json.models.map(i => typeof i === 'string' ? i : (i.id || i.name));
                    else if (Array.isArray(json)) list = json.map(i => typeof i === 'string' ? i : i.id);
                    resData = { success: true, count: list.length, models: list };
                }

                if (!resData.success || !resData.models || resData.models.length === 0) {
                    throw new Error(resData.error || '未能从该服务商读取到模型列表，请确认 Base URL 是否包含 /v1');
                }

                currentFetchedModelsCache = resData.models;
                const ctx = callbacks.getContext();
                if (ctx?.showToast) ctx.showToast(`成功获取到 ${currentFetchedModelsCache.length} 个模型！`);

                const fetchedPanel = document.getElementById('ai-fetched-models-panel');
                if (fetchedPanel) fetchedPanel.style.display = 'block';

                const sInput = document.getElementById('ai-models-search-input');
                const sClear = document.getElementById('ai-models-search-clear');
                if (sInput) sInput.value = '';
                if (sClear) sClear.style.display = 'none';

                renderFetchedModelBadges('');
                updateDefaultModelDropdownMenu();

            } catch (err) {
                showAlert({ title: '拉取模型失败', message: `拉取模型列表失败: ${err.message}\n请检查 Base URL 与 API Key 是否有效，亦可手动填入模型 ID。`, type: 'warning' });
            } finally {
                fetchModelsBtn.disabled = false;
                if (fetchModelsText) fetchModelsText.textContent = '自动拉取模型';
            }
        };
    }

    // 全选 / 清空模型
    const fillAllBtn = document.getElementById('ai-models-fill-all');
    if (fillAllBtn) {
        fillAllBtn.onclick = () => {
            const { modelsInput, defaultModelInput } = getProviderModalElements();
            const sInput = document.getElementById('ai-models-search-input');
            const kw = sInput ? sInput.value.trim().toLowerCase() : '';
            const targets = kw
                ? currentFetchedModelsCache.filter(m => m.toLowerCase().includes(kw))
                : currentFetchedModelsCache;

            if (targets.length > 0 && modelsInput) {
                let cur = (modelsInput.value || '').split(',').map(m => m.trim()).filter(Boolean);
                targets.forEach(m => {
                    if (!cur.includes(m)) cur.push(m);
                });
                modelsInput.value = cur.join(', ');
                if (defaultModelInput && !defaultModelInput.value.trim()) {
                    defaultModelInput.value = cur[0];
                }
                renderFetchedModelBadges(sInput ? sInput.value : '');
                updateDefaultModelDropdownMenu();
                const ctx = callbacks.getContext();
                if (ctx?.showToast) ctx.showToast(`已填入 ${targets.length} 个模型`);
            }
        };
    }

    const clearModelsBtn = document.getElementById('ai-models-clear');
    if (clearModelsBtn) {
        clearModelsBtn.onclick = () => {
            const { modelsInput, defaultModelInput } = getProviderModalElements();
            if (modelsInput) modelsInput.value = '';
            if (defaultModelInput) defaultModelInput.value = '';
            const sInput = document.getElementById('ai-models-search-input');
            renderFetchedModelBadges(sInput ? sInput.value : '');
            updateDefaultModelDropdownMenu();
        };
    }

    // 保存服务商
    const saveProviderBtn = document.getElementById('save-ai-provider-btn');
    if (saveProviderBtn) {
        saveProviderBtn.onclick = async () => {
            const currentAiConfig = callbacks.getConfig();
            const { nameInput, idInput, urlInput, keyInput, modelsInput, defaultModelInput, modal } = getProviderModalElements();
            const name = nameInput?.value.trim();
            const id = idInput?.value.trim();
            let rawBaseUrl = urlInput?.value.trim() || '';
            const baseUrl = rawBaseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
            const apiKey = keyInput?.value.trim();
            const models = modelsInput?.value.trim() || '';
            const defaultModel = defaultModelInput?.value.trim() || (models ? models.split(',')[0].trim() : '');

            if (!name || !id || !baseUrl) {
                return showAlert({ title: '提示', message: '请填写完整的服务商名称、ID 和 Base URL！' });
            }

            if (editingProviderId) {
                const target = currentAiConfig.providers.find(p => p.id === editingProviderId);
                if (target) {
                    if (id !== editingProviderId) {
                        if (currentAiConfig.providers.some(p => p.id === id)) {
                            return showAlert({ title: '提示', message: '该服务商 ID 已被其他服务商使用，请更换 ID！' });
                        }
                        target.id = id;
                        if (currentAiConfig.sitePolicy?.fallbackChain) {
                            currentAiConfig.sitePolicy.fallbackChain = currentAiConfig.sitePolicy.fallbackChain.map(cid => cid === editingProviderId ? id : cid);
                        }
                    }
                    target.name = name;
                    target.baseUrl = baseUrl;
                    target.apiKey = apiKey;
                    target.models = models;
                    target.defaultModel = defaultModel;
                    const validModels = models.split(',').map(m => m.trim()).filter(Boolean);
                    let currentPoll = Array.isArray(target.pollModels) ? target.pollModels.filter(m => validModels.includes(m)) : [];
                    if (defaultModel && !currentPoll.includes(defaultModel)) {
                        currentPoll.unshift(defaultModel);
                    }
                    if (currentPoll.length === 0 && defaultModel) {
                        currentPoll = [defaultModel];
                    }
                    target.pollModels = currentPoll;
                }
            } else {
                if (currentAiConfig.providers.some(p => p.id === id)) {
                    return showAlert({ title: '提示', message: '该服务商 ID 已存在，请更换 ID！' });
                }
                currentAiConfig.providers.push({
                    id,
                    name,
                    baseUrl,
                    apiKey,
                    models,
                    defaultModel,
                    pollModels: defaultModel ? [defaultModel] : (models ? [models.split(',')[0].trim()] : []),
                    enabled: true
                });
            }

            closeDefaultModelMenu();
            if (modal) modal.style.display = 'none';

            const container = document.getElementById('ai-hub-container');
            if (container) callbacks.renderAiHubView(container, currentAiConfig);
            await callbacks.syncAiConfig(`已${editingProviderId ? '更新' : '添加'}服务商「${name}」并同步至边缘网关`, true);
        };
    }

    // 关闭服务商弹窗
    const closeProviderBtn = document.getElementById('close-ai-provider-btn');
    if (closeProviderBtn) {
        closeProviderBtn.onclick = () => {
            closeDefaultModelMenu();
            const modal = document.getElementById('ai-provider-modal');
            if (modal) modal.style.display = 'none';
        };
    }

    // 复制密钥
    const copyModalKeyBtn = document.getElementById('ai-copy-modal-key-btn');
    if (copyModalKeyBtn) {
        copyModalKeyBtn.onclick = () => {
            const { keyInput } = getProviderModalElements();
            const val = keyInput ? keyInput.value.trim() : '';
            const ctx = callbacks.getContext();
            if (!val) {
                if (ctx?.showToast) ctx.showToast('API Key 尚为空，请先输入密钥', true);
                return;
            }
            navigator.clipboard.writeText(val).then(() => {
                if (ctx?.showToast) ctx.showToast('API Key 已复制到剪贴板');
            });
        };
    }

    // 测速发送
    const sendTestBtn = document.getElementById('send-ai-test-btn');
    if (sendTestBtn) {
        sendTestBtn.onclick = async () => {
            const promptInput = document.getElementById('ai-test-prompt-input') || document.getElementById('ai-test-prompt');
            const targetSelect = document.getElementById('ai-test-target-select') || document.getElementById('ai-test-target');
            const resultBox = document.getElementById('ai-test-result-box');
            const timing = document.getElementById('ai-test-timing');
            const currentAiConfig = callbacks.getConfig();

            const prompt = promptInput?.value.trim() || '你好';
            const endpoint = OFFICIAL_AI_GATEWAY_URL;
            const masterKey = currentAiConfig.gateway.masterKey;
            const targetVal = targetSelect ? targetSelect.value : '__AUTO__';

            const requestBody = {
                messages: [{ role: 'user', content: prompt }]
            };
            let targetLabel = '全自动主备容灾降级链';

            if (targetVal && targetVal.startsWith('model:')) {
                const targetModel = targetVal.replace('model:', '');
                requestBody.model = targetModel;
                targetLabel = `指定模型 [${targetModel}]`;
            } else if (targetVal && targetVal.startsWith('provider:')) {
                const providerId = targetVal.replace('provider:', '');
                requestBody.model = providerId;
                const p = (currentAiConfig.providers || []).find(item => item.id === providerId);
                targetLabel = `服务商 [${p?.name || providerId}] 3 模型自动轮询`;
            }

            if (resultBox) resultBox.textContent = `正在向统一网关发送测试请求 (测试目标: ${targetLabel})...`;
            if (timing) timing.textContent = '测速中...';
            sendTestBtn.disabled = true;

            const startTime = Date.now();
            try {
                const url = endpoint.endsWith('/') ? `${endpoint}chat/completions` : `${endpoint}/chat/completions`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${masterKey}`
                    },
                    body: JSON.stringify(requestBody)
                });

                const elapsed = Date.now() - startTime;
                if (timing) timing.textContent = `耗时: ${elapsed} ms`;

                const data = await res.json();
                if (res.ok) {
                    const answer = data.choices?.[0]?.message?.content || JSON.stringify(data, null, 2);
                    if (resultBox) resultBox.textContent = `【测试通过 200 OK | 目标: ${targetLabel} | 响应模型: ${data.model || 'Auto'}】\n\n${answer}`;
                } else {
                    if (resultBox) resultBox.textContent = `【返回错误 HTTP ${res.status} | 目标: ${targetLabel}】\n${JSON.stringify(data, null, 2)}\n\n提示：若您刚刚在后台新增或修改了该服务商，请先点击页面右上角【保存】同步至边缘 KV 后再行测速。`;
                }
            } catch (err) {
                const elapsed = Date.now() - startTime;
                if (timing) timing.textContent = `耗时: ${elapsed} ms`;
                if (resultBox) resultBox.textContent = `【网络连接异常 | 目标: ${targetLabel}】: ${err.message}\n提示：请确认网关域名是否可访问并且支持跨域访问。`;
            } finally {
                sendTestBtn.disabled = false;
                callbacks.fetchAiHubMetrics(callbacks.getMetricsDays()).then(() => {
                    if (callbacks.getSubTab() === 'metrics') {
                        const c = document.getElementById('ai-hub-container');
                        if (c && currentAiConfig) callbacks.renderAiHubView(c, currentAiConfig);
                    }
                });
            }
        };
    }

    const closeTestBtn = document.getElementById('close-ai-test-btn');
    if (closeTestBtn) {
        closeTestBtn.onclick = () => {
            const modal = document.getElementById('ai-test-modal');
            if (modal) modal.style.display = 'none';
        };
    }

    const closeCodeBtn = document.getElementById('close-ai-code-btn');
    if (closeCodeBtn) {
        closeCodeBtn.onclick = () => {
            const modal = document.getElementById('ai-code-modal');
            if (modal) modal.style.display = 'none';
        };
    }

    // 开发者专属密钥二级模态框事件绑定
    const keySlotModal = document.getElementById('ai-keyslot-modal');
    const closeKeySlotBtn = document.getElementById('close-ai-keyslot-btn');
    const saveKeySlotBtn = document.getElementById('save-ai-keyslot-btn');
    const copyKeySlotBtn = document.getElementById('ai-copy-keyslot-btn');
    const regenKeySlotBtn = document.getElementById('ai-regen-keyslot-btn');
    const deleteKeySlotBtn = document.getElementById('ai-delete-keyslot-btn');
    const keySlotValInput = document.getElementById('ai-keyslot-val-input');
    const keySlotNameInput = document.getElementById('ai-keyslot-name-input');

    if (closeKeySlotBtn && keySlotModal) {
        closeKeySlotBtn.onclick = () => {
            keySlotModal.style.display = 'none';
        };
    }

    document.querySelectorAll('.ai-quick-slot-tag').forEach(tagBtn => {
        tagBtn.onclick = () => {
            if (keySlotNameInput) {
                keySlotNameInput.value = tagBtn.dataset.tag || '';
                keySlotNameInput.focus();
            }
        };
    });

    if (copyKeySlotBtn && keySlotValInput) {
        copyKeySlotBtn.onclick = () => {
            const val = keySlotValInput.value.trim();
            const ctx = callbacks.getContext();
            if (!val) {
                if (ctx?.showToast) ctx.showToast('密钥内容为空，请先填写或重新生成', true);
                return;
            }
            navigator.clipboard.writeText(val).then(() => {
                if (ctx?.showToast) ctx.showToast('密钥已成功复制到剪贴板！');
            });
        };
    }

    if (regenKeySlotBtn && keySlotValInput) {
        regenKeySlotBtn.onclick = async () => {
            const ok = await showConfirm({
                title: '重新生成密钥',
                message: '确认生成新的随机密钥吗？如果保存，旧密钥将立即失效。',
                confirmText: '确认生成'
            });
            if (ok) {
                const newKey = generateRandomKey();
                keySlotValInput.value = newKey;
                const ctx = callbacks.getContext();
                if (ctx?.showToast) ctx.showToast('已生成新随机密钥，请点击右下角保存生效');
            }
        };
    }

    if (deleteKeySlotBtn && keySlotModal) {
        deleteKeySlotBtn.onclick = async () => {
            const currentAiConfig = callbacks.getConfig();
            if (currentEditingSlotIndex < 0 || !currentAiConfig) return;
            const k = currentAiConfig.gateway?.keys?.[currentEditingSlotIndex];
            const name = k?.name || `槽位 ${currentEditingSlotIndex + 1}`;
            const ok = await showConfirm({
                title: '删除此密钥',
                message: `确认删除【${name}】吗？删除后使用该密钥的工具将无法再调用网关。`,
                confirmText: '确认删除',
                danger: true
            });
            if (ok) {
                currentAiConfig.gateway.keys.splice(currentEditingSlotIndex, 1);
                // 先清空旧 masterKey，避免删光后被兼容逻辑迁移回来；同步时会按剩余第一组重新计算
                currentAiConfig.gateway.masterKey = '';
                keySlotModal.style.display = 'none';
                const container = document.getElementById('ai-hub-container');
                if (container) callbacks.renderAiHubView(container, currentAiConfig);
                await callbacks.syncAiConfig(`【${name}】已删除`, true);
            }
        };
    }

    if (saveKeySlotBtn && keySlotModal) {
        saveKeySlotBtn.onclick = async () => {
            const currentAiConfig = callbacks.getConfig();
            if (currentEditingSlotIndex < 0 || !currentAiConfig) return;
            const name = keySlotNameInput?.value.trim();
            const key = keySlotValInput?.value.trim();
            if (!name) {
                showAlert({ title: '参数缺失', message: '请填写平台或用途名称（例如: VS Code Continue 或 Open Code）！' });
                return;
            }
            if (!key) {
                showAlert({ title: '参数缺失', message: '密钥不能为空，请填写或点击重新生成！' });
                return;
            }

            const prevId = currentAiConfig.gateway.keys[currentEditingSlotIndex]?.id;
            const usedIds = new Set(currentAiConfig.gateway.keys.map(x => x && x.id));
            let newId = prevId;
            if (!newId) {
                let n = currentAiConfig.gateway.keys.length + 1;
                while (usedIds.has(`key_${n}`)) n++;
                newId = `key_${n}`;
            }
            if (currentAiConfig.gateway.keys.some((x, i) => i !== currentEditingSlotIndex && x && x.key === key)) {
                showAlert({ title: '密钥重复', message: '该密钥已被其他工具使用，请重新生成一个！' });
                return;
            }
            currentAiConfig.gateway.keys[currentEditingSlotIndex] = {
                id: newId,
                name: name,
                key: key,
                enabled: true
            };
            if (currentEditingSlotIndex === 0) {
                currentAiConfig.gateway.masterKey = key;
            }
            keySlotModal.style.display = 'none';
            const container = document.getElementById('ai-hub-container');
            if (container) callbacks.renderAiHubView(container, currentAiConfig);
            await callbacks.syncAiConfig(`【${name}】配置已保存并生效`, true);
        };
    }
}
