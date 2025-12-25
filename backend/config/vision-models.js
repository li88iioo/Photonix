/**
 * @file vision-models.js
 * @description 维护 AI 密语功能使用的视觉模型白名单及辅助规则。
 *   - 白名单用于在模型列表接口中快速识别主流视觉模型
 *   - 规则层提供额外关键字匹配，辅助识别新模型
 */

const MODEL_METADATA = {
    'gemini-2.0-flash': {
        label: 'Gemini 2.0 Flash',
        provider: 'Google Gemini',
        description: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-2.0-pro': {
        label: 'Gemini 2.0 Pro',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-2.5-flash': {
        label: 'Gemini 2.5 Flash',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-2.5-flash-lite': {
        label: 'Gemini 2.5 Flash Lite',
        provider: 'Google Gemini',
        capabilities: ['vision']
    },
    'gemini-2.5-pro': {
        label: 'Gemini 2.5 PRO',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-3-flash': {
        label: 'Gemini 3 Flash',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-3-flash-preview': {
        label: 'Gemini 3 Flash Preview',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-3-pro': {
        label: 'Gemini 3 Pro',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-3-pro-preview': {
        label: 'Gemini 3 Pro Preview',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-3-pro-image-preview': {
        label: 'Gemini 3 Pro Image Preview',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-2.5-flash-image': {
        label: 'Gemini 2.5 Flash Image',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-2.5-flash-image-preview': {
        label: 'Gemini 2.5 Flash Image Preview',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-1.5-flash': {
        label: 'Gemini 1.5 Flash',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-1.5-pro': {
        label: 'Gemini 1.5 Pro',
        provider: 'Google Gemini',
        capabilities: ['vision', 'multimodal']
    },
    'gemini-pro-vision': {
        label: 'Gemini Pro Vision',
        provider: 'Google Gemini',
        capabilities: ['vision']
    },
    'glm-4v': {
        label: 'GLM-4V',
        provider: 'Zhipu',
        capabilities: ['vision']
    },
    'glm-4.5v': {
        label: 'GLM-4.5V',
        provider: 'Zhipu',
        capabilities: ['vision']
    },
    'cogvlm2-19b': {
        label: 'CogVLM-2 19B',
        provider: 'THUDM',
        capabilities: ['vision']
    },
    'llava-1.5-13b': {
        label: 'LLaVA 1.5 13B',
        provider: 'LLaVA',
        capabilities: ['vision']
    },
    'llava-1.5-7b': {
        label: 'LLaVA 1.5 7B',
        provider: 'LLaVA',
        capabilities: ['vision']
    },
    'llava-next-34b': {
        label: 'LLaVA Next 34B',
        provider: 'LLaVA',
        capabilities: ['vision']
    },
    'llava-v1.6-34b': {
        label: 'LLaVA 1.6 34B',
        provider: 'LLaVA',
        capabilities: ['vision']
    },
    'gemma-3-27b-vision': {
        label: 'Gemma 3 27B Vision',
        provider: 'Google',
        capabilities: ['vision']
    },
    'gemma-3-9b-vision': {
        label: 'Gemma 3 9B Vision',
        provider: 'Google',
        capabilities: ['vision']
    },
    'minicpm-v2': {
        label: 'MiniCPM V2',
        provider: 'MiniCPM',
        capabilities: ['vision']
    },
    'minicpm-v2.5': {
        label: 'MiniCPM V2.5',
        provider: 'MiniCPM',
        capabilities: ['vision']
    },
    'phi-4-multimodal': {
        label: 'Phi-4 Multimodal',
        provider: 'Microsoft',
        capabilities: ['vision']
    },
    'pixtral-12b': {
        label: 'Pixtral 12B',
        provider: 'Mistral',
        capabilities: ['vision']
    },
    'gemma-3-27b': {
        label: 'Gemma 3 27B',
        provider: 'Google',
        capabilities: ['vision']
    },
    'gemma-3-27b-it': {
        label: 'Gemma 3 27B Instruct',
        provider: 'Google',
        capabilities: ['vision']
    },
    'gemma-3-12b': {
        label: 'Gemma 3 12B',
        provider: 'Google',
        capabilities: ['vision']
    },
    'gemma-3-9b': {
        label: 'Gemma 3 9B',
        provider: 'Google',
        capabilities: ['vision']
    },
    'gemma-3-4b': {
        label: 'Gemma 3 4B',
        provider: 'Google',
        capabilities: ['vision']
    },
    'qwen-2.5-vl-max': {
        label: 'Qwen 2.5 VL Max',
        provider: 'Alibaba Qwen',
        capabilities: ['vision']
    },
    'qwen-2.5-vl-plus': {
        label: 'Qwen 2.5 VL Plus',
        provider: 'Alibaba Qwen',
        capabilities: ['vision']
    },
    'qwen-2.5-vl-72b': {
        label: 'Qwen 2.5 VL 72B',
        provider: 'Alibaba Qwen',
        capabilities: ['vision']
    },
    'qwen-2.5-omni': {
        label: 'Qwen 2.5 Omni',
        provider: 'Alibaba Qwen',
        capabilities: ['vision', 'audio']
    },
    'qwen-vl-32b': {
        label: 'Qwen VL 32B',
        provider: 'Alibaba Qwen',
        capabilities: ['vision']
    },
    'qwen-vl-max': {
        label: 'Qwen VL Max',
        provider: 'Alibaba Qwen',
        capabilities: ['vision']
    },
    'qwen-vl-plus': {
        label: 'Qwen VL Plus',
        provider: 'Alibaba Qwen',
        capabilities: ['vision']
    },
    'deepseek-vl': {
        label: 'DeepSeek VL',
        provider: 'DeepSeek',
        capabilities: ['vision']
    },
    'deepseek-vl2': {
        label: 'DeepSeek VL2',
        provider: 'DeepSeek',
        capabilities: ['vision']
    },
    'deepseek-janus-pro-7b': {
        label: 'DeepSeek Janus Pro 7B',
        provider: 'DeepSeek',
        capabilities: ['vision']
    },
    'internvl-2.5': {
        label: 'InternVL 2.5',
        provider: 'OpenBMB',
        capabilities: ['vision']
    },
    'internvl-2-26b': {
        label: 'InternVL 2 26B',
        provider: 'OpenBMB',
        capabilities: ['vision']
    },
    'gpt-5': {
        label: 'GPT-5',
        provider: 'OpenAI',
        capabilities: ['vision', 'multimodal']
    },
    'gpt-5.1': {
        label: 'GPT-5.1',
        provider: 'OpenAI',
        capabilities: ['vision', 'multimodal']
    },
    'gpt-5-minimal': {
        label: 'GPT-5 Minimal',
        provider: 'OpenAI',
        capabilities: ['vision']
    },
    'gpt-5-codex': {
        label: 'GPT-5 Codex',
        provider: 'OpenAI',
        capabilities: ['vision', 'code']
    },
    'gpt-5.1-codex': {
        label: 'GPT-5.1 Codex',
        provider: 'OpenAI',
        capabilities: ['vision', 'code']
    },
    'gpt-5.1-codex-max': {
        label: 'GPT-5.1 Codex Max',
        provider: 'OpenAI',
        capabilities: ['vision', 'code']
    },
    'llama-4-moe-vision': {
        label: 'Llama 4 MoE Vision',
        provider: 'Meta',
        capabilities: ['vision']
    },
    'minicpm-v3': {
        label: 'MiniCPM V3',
        provider: 'MiniCPM',
        capabilities: ['vision']
    },
    'minicpm-o-2.6': {
        label: 'MiniCPM-o 2.6',
        provider: 'MiniCPM',
        capabilities: ['vision']
    },
    'yi-vision': {
        label: 'Yi Vision',
        provider: '01.AI',
        capabilities: ['vision']
    },
    'grok-4': {
        label: 'Grok 4',
        provider: 'xAI',
        capabilities: ['vision', 'multimodal']
    },
    'seed-1.6-flash': {
        label: 'Seed 1.6 Flash',
        provider: 'ByteDance',
        capabilities: ['vision', 'multimodal']
    },
    'kimi-vl-a3b-thinking': {
        label: 'Kimi VL A3B Thinking',
        provider: 'Moonshot AI',
        capabilities: ['vision']
    },
    'qwen2.5-vl-32b-instruct': {
        label: 'Qwen 2.5 VL 32B Instruct',
        provider: 'Alibaba Qwen',
        capabilities: ['vision']
    },
    'qwen2.5-vl-72b-instruct': {
        label: 'Qwen 2.5 VL 72B Instruct',
        provider: 'Alibaba Qwen',
        capabilities: ['vision']
    },
    'llama-3.2-11b-vision-instruct': {
        label: 'Llama 3.2 11B Vision Instruct',
        provider: 'Meta',
        capabilities: ['vision']
    },
    'llama-3.2-90b-vision-instruct': {
        label: 'Llama 3.2 90B Vision Instruct',
        provider: 'Meta',
        capabilities: ['vision']
    },
    'ministral-3b': {
        label: 'Ministral 3B',
        provider: 'Mistral',
        capabilities: ['vision']
    },
    'ministral-8b': {
        label: 'Ministral 8B',
        provider: 'Mistral',
        capabilities: ['vision']
    },
    'claude-3-5-sonnet-20241022': {
        label: 'Claude 3.5 Sonnet (Oct 2024)',
        provider: 'Anthropic',
        capabilities: ['vision']
    },
    'claude-3-5-haiku-20241022': {
        label: 'Claude 3.5 Haiku (Oct 2024)',
        provider: 'Anthropic',
        capabilities: ['vision']
    },
    'gpt-4.1': {
        label: 'GPT-4.1',
        provider: 'OpenAI',
        capabilities: ['vision', 'multimodal']
    },
    'gpt-4.1-mini': {
        label: 'GPT-4.1 Mini',
        provider: 'OpenAI',
        capabilities: ['vision']
    },
    'gpt-4.1-nano': {
        label: 'GPT-4.1 Nano',
        provider: 'OpenAI',
        capabilities: ['vision']
    },
    'o3': {
        label: 'OpenAI o3',
        provider: 'OpenAI',
        capabilities: ['vision', 'reasoning']
    },
    'o3-mini': {
        label: 'OpenAI o3 Mini',
        provider: 'OpenAI',
        capabilities: ['vision', 'reasoning']
    },
    'o4-mini': {
        label: 'OpenAI o4 Mini',
        provider: 'OpenAI',
        capabilities: ['vision', 'reasoning']
    },
    'llama-4-behemoth': {
        label: 'Llama 4 Behemoth',
        provider: 'Meta',
        capabilities: ['vision', 'multimodal']
    },
    'llama-4-maverick': {
        label: 'Llama 4 Maverick',
        provider: 'Meta',
        capabilities: ['vision', 'multimodal']
    },
    'llama-4-scout': {
        label: 'Llama 4 Scout',
        provider: 'Meta',
        capabilities: ['vision', 'multimodal']
    },
    'mistral-small-3.1-24b-instruct': {
        label: 'Mistral Small 3.1 24B Instruct',
        provider: 'Mistral',
        capabilities: ['vision']
    },
    'claude-opus-4.5': {
        label: 'Claude Opus 4.5',
        provider: 'Anthropic',
        capabilities: ['vision', 'multimodal']
    },
    'glm-4.6v': {
        label: 'GLM-4.6V',
        provider: 'Zhipu',
        capabilities: ['vision', 'multimodal']
    },
    'nemotron-nano-2-vl': {
        label: 'Nemotron Nano 2 VL',
        provider: 'NVIDIA',
        capabilities: ['vision', 'video']
    },
    'qwen2.5-vl-3b-instruct': {
        label: 'Qwen 2.5 VL 3B Instruct',
        provider: 'Alibaba Qwen',
        capabilities: ['vision']
    }
};

const RAW_VISION_MODELS = [
    'baichuan-4',
    'claude-3-5-sonnet-20240620',
    'claude-3-haiku-20240307',
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-haiku-4',
    'claude-haiku-4.5',
    'claude-opus-4',
    'claude-opus-4.1',
    'claude-sonnet-4',
    'claude-sonnet-4.1',
    'claude-sonnet-4.5',
    'cogvlm2-19b',
    'falcon-2-11b-vlm',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-image-preview',
    'gemini-3-flash',
    'gemini-3-flash-preview',
    'gemini-3-pro',
    'gemini-3-pro-preview',
    'gemini-3-pro-image-preview',
    'gemini-pro-vision',
    'gemma-3-27b-vision',
    'gemma-3-9b-vision',
    'gemma-3-27b',
    'gemma-3-27b-it',
    'gemma-3-12b',
    'gemma-3-9b',
    'gemma-3-4b',
    'glm-4v',
    'glm-4.5v',
    'gpt-4-turbo',
    'gpt-4-vision-preview',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-5',
    'gpt-5.1',
    'gpt-5-minimal',
    'gpt-5-codex',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'grok-2',
    'grok-3',
    'internvl-2-8b',
    'internvl-2-26b',
    'internvl-2.5',
    'internvl3-78b',
    'llama-3.2-vision-11b',
    'llama-3.2-vision-90b',
    'llama-4-moe-vision',
    'llava-1.5-13b',
    'llava-1.5-7b',
    'llava-next-34b',
    'llava-v1.6-34b',
    'minicpm-v2',
    'minicpm-v2.5',
    'minicpm-v3',
    'minicpm-o-2.6',
    'moonshot-v1',
    'ovis2-34b',
    'phi-4-multimodal',
    'pixtral-12b',
    'qwen-2.5-vl-72b',
    'qwen-2.5-vl-max',
    'qwen-2.5-vl-plus',
    'qwen-2.5-omni',
    'qwen-qvq',
    'qwen-vl-32b',
    'qwen-vl-max',
    'qwen-vl-plus',
    'yi-vision',
    'deepseek-vl',
    'deepseek-vl2',
    'deepseek-janus-pro-7b',
    'grok-4',
    'seed-1.6-flash',
    'kimi-vl-a3b-thinking',
    'qwen2.5-vl-32b-instruct',
    'qwen2.5-vl-72b-instruct',
    'llama-3.2-11b-vision-instruct',
    'llama-3.2-90b-vision-instruct',
    'ministral-3b',
    'ministral-8b',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'o3',
    'o3-mini',
    'o4-mini',
    'llama-4-behemoth',
    'llama-4-maverick',
    'llama-4-scout',
    'mistral-small-3.1-24b-instruct',
    'claude-opus-4.5',
    'glm-4.6v',
    'nemotron-nano-2-vl',
    'qwen2.5-vl-3b-instruct'
];

const NORMALIZED_WHITELIST = new Map();
for (const id of RAW_VISION_MODELS) {
    if (typeof id !== 'string' || !id.trim()) continue;
    const normalized = normalizeVisionModelId(id);
    const meta = MODEL_METADATA[normalized];
    NORMALIZED_WHITELIST.set(normalized, {
        id,
        normalizedId: normalized,
        label: meta?.label || buildModelLabel(id),
        description: meta?.description || '',
        provider: meta?.provider || '',
        capabilities: Array.isArray(meta?.capabilities) && meta.capabilities.length
            ? [...meta.capabilities]
            : ['vision']
    });
}

const VISION_MODEL_KEYWORDS = Array.from(new Set([
    'vision',
    'image',
    'omni',
    'flash',
    'multimodal',
    'photography',
    'vl',
    'gpt-4o',
    'gpt-4.1',
    'gpt-4-turbo',
    'gpt-5',
    'gpt-5.1',
    'sonnet',
    'opus',
    'haiku',
    'grok',
    'pixtral',
    'minicpm',
    'moonshot',
    'gemma',
    'llava',
    'glm-4v',
    'glm-4.5',
    'glm-4.5v',
    'zai-glm',
    'phi-4',
    'baichuan',
    'internvl',
    'gemini-1.5',
    'gemini-2.0',
    'gemini-2.5',
    'gemini-3',
    'cogvlm',
    'qwen-vl',
    'qvq'
]));

function normalizeVisionModelId(modelId = '') {
    const cleaned = String(modelId || '').trim();
    if (!cleaned) return '';

    // 去掉可选前缀 models/ 以及渠道/实例后缀（如 :free、:newapi）
    const withoutPrefix = cleaned.replace(/^models\//i, '');
    const withoutChannel = withoutPrefix.split(':')[0];

    return withoutChannel.toLowerCase();
}

function buildModelLabel(id = '') {
    const trimmed = String(id || '').trim();
    if (!trimmed) return '';
    // 例如：gemini-2.0-flash -> Gemini 2.0 Flash
    const parts = trimmed
        .replace(/[_]/g, '-')
        .split('-')
        .filter(Boolean)
        .map((seg) => seg.length <= 3 ? seg.toUpperCase() : `${seg.charAt(0).toUpperCase()}${seg.slice(1)}`);
    return parts.join(' ');
}

function getVisionModelMeta(modelId) {
    const normalized = normalizeVisionModelId(modelId);
    const meta = MODEL_METADATA[normalized];
    if (meta) {
        return {
            id: meta.id || modelId,
            normalizedId: normalized,
            label: meta.label || buildModelLabel(modelId),
            description: meta.description || '',
            provider: meta.provider || '',
            capabilities: Array.isArray(meta.capabilities) ? [...meta.capabilities] : []
        };
    }
    const fromWhitelist = NORMALIZED_WHITELIST.get(normalized);
    if (fromWhitelist) {
        return {
            ...fromWhitelist,
            capabilities: Array.isArray(fromWhitelist.capabilities)
                ? [...fromWhitelist.capabilities]
                : ['vision']
        };
    }
    return null;
}

function getModelCapabilities(modelId) {
    const meta = getVisionModelMeta(modelId);
    return Array.isArray(meta?.capabilities) ? [...meta.capabilities] : [];
}

function isVisionModelWhitelisted(modelId) {
    return NORMALIZED_WHITELIST.has(normalizeVisionModelId(modelId));
}

module.exports = {
    VISION_MODEL_WHITELIST: RAW_VISION_MODELS,
    VISION_MODEL_KEYWORDS,
    normalizeVisionModelId,
    getVisionModelMeta,
    getModelCapabilities,
    isVisionModelWhitelisted
};
