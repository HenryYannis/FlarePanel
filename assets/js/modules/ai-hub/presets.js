// ====================================================
// 统一 AI 代理网关 - 预设配置与静态常量 (Presets & Constants)
// 包含：KV 空间常量、各大厂商预设模板、默认容灾链配置、Master Key 槽位保障
// 网关地址和 KV 命名空间在 sites.config.js 的 AI_HUB 里配置
// ====================================================

import { AI_HUB } from '../../sites.js';

export const AI_KV_NAMESPACE_ID = AI_HUB.kvNamespaceId || '';
export const AI_KV_CONFIG_KEY = AI_HUB.configKey || 'AI_GATEWAY_CONFIG';
export const OFFICIAL_AI_GATEWAY_URL = (AI_HUB.gatewayUrl || '').replace(/\/+$/, '');

/**
 * 常用服务商预设模板与默认端点（默认配置 3 个模型按序自动轮询降级）
 */
export const PROVIDER_TEMPLATES = [
    {
        name: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com/v1',
        models: 'deepseek-chat, deepseek-reasoner, deepseek-coder',
        defaultModel: 'deepseek-chat',
        desc: '低延迟、高智商代码与推理主力'
    },
    {
        name: '硅基流动 SiliconFlow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        models: 'deepseek-ai/DeepSeek-V3, deepseek-ai/DeepSeek-R1, Qwen/Qwen2.5-72B-Instruct',
        defaultModel: 'deepseek-ai/DeepSeek-V3',
        desc: '国内高速算力、高并发白嫖/低价'
    },
    {
        name: '魔搭 ModelScope',
        baseUrl: 'https://api-inference.modelscope.cn/v1',
        models: 'deepseek-ai/DeepSeek-V4-Flash, Qwen/Qwen2.5-72B-Instruct, deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
        defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
        desc: '阿里云魔搭推理，免费额度充裕'
    },
    {
        name: 'MiniMax 原生',
        baseUrl: 'https://api.minimaxi.com/v1',
        models: 'MiniMax-M3, MiniMax-Text-01, abab6.5s-chat',
        defaultModel: 'MiniMax-M3',
        desc: '主力模型'
    },
    {
        name: 'NVIDIA NIM',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        models: 'minimaxai/minimax-m3, meta/llama-3.3-70b-instruct, deepseek-ai/deepseek-r1',
        defaultModel: 'minimaxai/minimax-m3',
        desc: '英伟达云端 NIM 极速推理'
    },
    {
        name: '智谱清言 (GLM)',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: 'glm-4-plus, glm-4-flash, glm-4-air',
        defaultModel: 'glm-4-flash',
        desc: '智谱开放平台，GLM 系列大模型'
    },
    {
        name: '月之暗面 (Kimi)',
        baseUrl: 'https://api.moonshot.cn/v1',
        models: 'moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k',
        defaultModel: 'moonshot-v1-8k',
        desc: 'Moonshot Kimi 长文本推理问答'
    },
    {
        name: '零一万物 (01.AI)',
        baseUrl: 'https://api.lingyiwanwu.com/v1',
        models: 'yi-large, yi-medium, yi-spark',
        defaultModel: 'yi-large',
        desc: '零一万物 Yi 系列大模型'
    },
    {
        name: '百川智能 (Baichuan)',
        baseUrl: 'https://api.baichuan-ai.com/v1',
        models: 'Baichuan4, Baichuan3-Turbo, Baichuan2-Turbo',
        defaultModel: 'Baichuan3-Turbo',
        desc: '百川智能官方大模型 API'
    },
    {
        name: '阶跃星辰 (StepFun)',
        baseUrl: 'https://api.stepfun.com/v1',
        models: 'step-1-8k, step-1-32k, step-2-16k',
        defaultModel: 'step-1-8k',
        desc: '阶跃星辰超长文本模型'
    },
    {
        name: 'OpenAI 官方',
        baseUrl: 'https://api.openai.com/v1',
        models: 'gpt-4o, gpt-4o-mini, o3-mini',
        defaultModel: 'gpt-4o-mini',
        desc: 'OpenAI 官方原厂 API'
    },
    {
        name: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        models: 'gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash',
        defaultModel: 'gemini-2.0-flash',
        desc: '百万级长上下文，原生兼容端点'
    },
    {
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        models: 'llama-3.3-70b-versatile, deepseek-r1-distill-llama-70b, llama-3.1-8b-instant',
        defaultModel: 'llama-3.3-70b-versatile',
        desc: 'LPU 芯片极致吐字速度'
    },
    {
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: 'anthropic/claude-3.5-sonnet, deepseek/deepseek-r1, meta-llama/llama-3.3-70b-instruct',
        defaultModel: 'anthropic/claude-3.5-sonnet',
        desc: '全网模型聚合路由'
    },
    {
        name: 'Cloudflare Workers AI (自带免费)',
        baseUrl: 'cloudflare-workers-ai',
        models: '@cf/meta/llama-3.3-70b-instruct, @cf/deepseek-ai/deepseek-r1-distill-qwen-32b, @cf/qwen/qwen2.5-72b-instruct',
        defaultModel: '@cf/meta/llama-3.3-70b-instruct',
        desc: 'CF 官方每日免费算力，免 API Key 兜底'
    },
    {
        name: '自定义 OpenAI 兼容',
        baseUrl: 'https://api.example.com/v1',
        models: 'gpt-4o-mini, gpt-4o, gpt-3.5-turbo',
        defaultModel: 'gpt-4o-mini',
        desc: '任何兼容 OpenAI 格式的自建或第三方网关'
    }
];

export function generateRandomKey(prefix = 'sk-xb-ai-') {
    return prefix + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
}

export function ensureGatewayKeys(config) {
    if (!config) return;
    if (!config.gateway) config.gateway = {};
    if (!Array.isArray(config.gateway.keys)) {
        config.gateway.keys = [];
    }
    // 不再限制数量：只保留已配置的密钥，空槽位统一由界面末尾的「新建」按钮承担
    const legacyMaster = config.gateway.masterKey;
    config.gateway.keys = config.gateway.keys.filter(k => k && k.enabled !== false && k.key && k.key.trim() && k.name && k.name.trim());
    // 兼容历史单 masterKey：若没有任何密钥，且有历史 masterKey，则安全迁移为第 1 组
    if (config.gateway.keys.length === 0 && legacyMaster) {
        config.gateway.keys[0] = {
            id: 'key_1',
            name: 'VS Code Continue',
            key: legacyMaster,
            enabled: true
        };
    }
    // 兼容老字段 masterKey
    const firstActive = config.gateway.keys.find(k => k && k.enabled && k.key);
    config.gateway.masterKey = firstActive ? firstActive.key : (config.gateway.keys[0]?.key || '');
}

export const DEFAULT_AI_CONFIG = {
    version: 1,
    gateway: {
        masterKey: '',
        endpoint: OFFICIAL_AI_GATEWAY_URL,
        keys: []
    },
    sitePolicy: {
        unauthDailyLimit: 9,
        authDailyLimit: 64,
        fallbackChain: ['provider_minimax', 'provider_modelscope', 'provider_nvidia']
    },
    telegram: {
        enabled: true,
        botToken: '',
        chatId: ''
    },
    providers: [
        {
            id: 'provider_minimax',
            name: 'MiniMax 原生',
            baseUrl: 'https://api.minimaxi.com/v1',
            apiKey: '',
            models: 'MiniMax-M3, MiniMax-Text-01, abab6.5s-chat',
            defaultModel: 'MiniMax-M3',
            enabled: true
        },
        {
            id: 'provider_modelscope',
            name: '魔搭 ModelScope',
            baseUrl: 'https://api-inference.modelscope.cn/v1',
            apiKey: '',
            models: 'deepseek-ai/DeepSeek-V4-Flash, Qwen/Qwen2.5-72B-Instruct, deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
            defaultModel: 'deepseek-ai/DeepSeek-V4-Flash',
            enabled: true
        },
        {
            id: 'provider_nvidia',
            name: 'NVIDIA NIM',
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            apiKey: '',
            models: 'minimaxai/minimax-m3, meta/llama-3.3-70b-instruct, deepseek-ai/deepseek-r1',
            defaultModel: 'minimaxai/minimax-m3',
            enabled: true
        },
        {
            id: 'provider_siliconflow',
            name: '硅基流动 SiliconFlow',
            baseUrl: 'https://api.siliconflow.cn/v1',
            apiKey: '',
            models: 'deepseek-ai/DeepSeek-V3, deepseek-ai/DeepSeek-R1, Qwen/Qwen2.5-72B-Instruct',
            defaultModel: 'deepseek-ai/DeepSeek-V3',
            enabled: false
        },
        {
            id: 'provider_deepseek',
            name: 'DeepSeek 官方',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: '',
            models: 'deepseek-chat, deepseek-reasoner, deepseek-coder',
            defaultModel: 'deepseek-chat',
            enabled: false
        }
    ]
};
