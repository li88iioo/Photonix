// frontend/js/settings.js

import { state } from './state.js';
import { fetchSettings, saveSettings, waitForSettingsUpdate } from './api.js';
import { showNotification } from './utils.js';

/**
 * 设置管理模块
 * 负责处理应用程序的设置界面、数据存储和用户交互
 */

// --- DOM元素 ---
const modal = document.getElementById('settings-modal');           // 设置模态框
const card = document.getElementById('settings-card');             // 设置卡片容器
const settingsTemplate = document.getElementById('settings-form-template'); // 设置表单模板

let initialSettings = {};  // 初始设置状态，用于检测变更

/**
 * AI配置本地存储工具
 * 用于在本地存储中保存和获取AI相关设置
 */
const AI_LOCAL_KEY = 'ai_settings';  // AI设置的本地存储键名

/**
 * 获取本地存储的AI设置
 * @returns {Object} AI设置对象
 */
function getLocalAISettings() {
    try {
        return JSON.parse(localStorage.getItem(AI_LOCAL_KEY)) || {};
    } catch { return {}; }
}

/**
 * 保存AI设置到本地存储
 * @param {Object} obj - 要保存的AI设置对象
 */
function setLocalAISettings(obj) {
    localStorage.setItem(AI_LOCAL_KEY, JSON.stringify(obj || {}));
}

/**
 * AI提示词默认值
 * 定义AI对话的默认提示模板
 */
const DEFAULT_AI_PROMPT = `请你扮演这张照片中的人物，以第一人称的视角，对正在看照片的我说话。
你的任务是：
1.  仔细观察你的着装、姿态、表情和周围的环境。
2.  基于这些观察，构思一个符合你当前人设和心境的对话。
3.  你的话语可以是对我的邀请、提问，也可以是分享你此刻的感受或一个只属于我们之间的小秘密。
4.  语言风格要自然、有代入感，就像我们正在面对面交流。
5.  请直接开始对话，不要有任何前缀，比如“你好”或“嗨”。
6.  总字数控制在80字以内。
7.  中文回复。`;

// --- 核心模态框函数 ---
/**
 * 显示设置模态框
 * 加载设置数据并初始化设置界面
 */
export async function showSettingsModal() {
    // 显示加载状态
    card.innerHTML = `<div style="display:flex;justify-content:center;align-items:center;height:100%;"><div class="spinner" style="width:3rem;height:3rem;"></div></div>`;
    modal.classList.add('visible');
    
    try {
        // 获取服务器设置和本地AI设置
        const settings = await fetchSettings();
        const localAI = getLocalAISettings();
        
        // 合并设置，AI功能默认关闭
        settings.AI_ENABLED = (typeof localAI.AI_ENABLED !== 'undefined') ? localAI.AI_ENABLED : 'false';
        settings.AI_URL = localAI.AI_URL ?? ''; 
        settings.AI_MODEL = localAI.AI_MODEL ?? 'gemini-2.0-flash'; 
        settings.AI_PROMPT = localAI.AI_PROMPT ?? DEFAULT_AI_PROMPT; 
        settings.AI_KEY = '';

        // 保存初始设置并渲染表单
        initialSettings = { ...settings, ...localAI };
        card.innerHTML = settingsTemplate.innerHTML;
        requestAnimationFrame(() => {
            populateForm(settings);
            setupListeners();
        });
    } catch (error) {
        // 显示错误信息
        card.innerHTML = `<p style="color:var(--red-400);text-align:center;">加载失败: ${error.message}</p>`;
        console.error("加载设置失败:", error);
    }
}

/**
 * 关闭设置模态框
 * 移除可见状态并在过渡动画结束后清空内容
 */
function closeSettingsModal() {
    modal.classList.remove('visible');
    modal.addEventListener('transitionend', () => {
        card.innerHTML = '';
    }, { once: true });
}

// --- 表单与数据处理 ---
/**
 * 根据设置对象填充表单内容
 * @param {Object} settings - 设置数据对象
 */
function populateForm(settings) {
    card.querySelector('#password-enabled').checked = settings.PASSWORD_ENABLED === 'true';
    card.querySelector('#ai-enabled').checked = settings.AI_ENABLED === 'true';
    card.querySelector('#ai-url').value = settings.AI_URL || '';
    card.querySelector('#ai-key').value = '';
    card.querySelector('#ai-model').value = settings.AI_MODEL || '';
    card.querySelector('#ai-prompt').value = settings.AI_PROMPT || '';
    updateDynamicUI(settings.PASSWORD_ENABLED === 'true', settings.AI_ENABLED === 'true', settings.hasPassword);
}

/**
 * 根据当前开关状态动态显示/隐藏相关设置区域
 * @param {boolean} isPasswordEnabled - 是否启用密码
 * @param {boolean} isAiEnabled - 是否启用AI
 * @param {boolean} hasPassword - 是否已设置过密码
 */
function updateDynamicUI(isPasswordEnabled, isAiEnabled, hasPassword) {
    const passwordSettingsGroup = card.querySelector('#password-settings-group');
    const apiSettingsGroup = card.querySelector('#api-settings-group');
    const newPasswordInput = card.querySelector('#new-password');
    const passwordEnabledWrapper = card.querySelector('#password-enabled-wrapper');
    const newPasswordWrapper = card.querySelector('#new-password-wrapper');

    // 根据总开关决定是否显示密码设置组和AI设置组
    if (passwordSettingsGroup) {
        passwordSettingsGroup.style.display = isPasswordEnabled ? 'block' : 'none';
    }
    if (apiSettingsGroup) {
        apiSettingsGroup.style.display = isAiEnabled ? 'block' : 'none';
    }

    // 检查是否应禁用敏感操作
    const shouldDisable = hasPassword && !initialSettings.isAdminSecretConfigured;

    // 更新密码启用开关的状态：只改变外观，不实际禁用，以确保change事件能被触发
    passwordEnabledWrapper.classList.toggle('disabled', shouldDisable);
    passwordEnabledWrapper.title = shouldDisable ? '未配置超级管理员密码，无法更改此设置' : '';

    // 更新新密码输入框的状态
    if (isPasswordEnabled) {
        newPasswordInput.disabled = shouldDisable;
        newPasswordWrapper.classList.toggle('disabled', shouldDisable);
        newPasswordWrapper.title = shouldDisable ? '未配置超级管理员密码，无法更改此设置' : '';
        newPasswordInput.placeholder = hasPassword ? '新密码' : '设置新密码';
    }
}

/**
 * 检查表单内容是否有变更，控制保存按钮状态
 */
function checkForChanges() {
    const saveBtn = card.querySelector('.save-btn');
    if (!saveBtn) return;
    const currentData = {
        PASSWORD_ENABLED: card.querySelector('#password-enabled').checked,
        AI_ENABLED: card.querySelector('#ai-enabled').checked,
        AI_URL: card.querySelector('#ai-url').value,
        AI_MODEL: card.querySelector('#ai-model').value,
        AI_PROMPT: card.querySelector('#ai-prompt').value,
    };
    let hasChanged = false;
    if (String(currentData.PASSWORD_ENABLED) !== String(initialSettings.PASSWORD_ENABLED === 'true') ||
        String(currentData.AI_ENABLED) !== String(initialSettings.AI_ENABLED === 'true') ||
        currentData.AI_URL !== initialSettings.AI_URL ||
        currentData.AI_MODEL !== initialSettings.AI_MODEL ||
        currentData.AI_PROMPT !== initialSettings.AI_PROMPT) {
        hasChanged = true;
    }
    if (card.querySelector('#new-password').value || card.querySelector('#ai-key').value) {
        hasChanged = true;
    }
    // 移除无条件启用：仅当确有变更或填写了敏感字段时，才启用保存
    saveBtn.disabled = !hasChanged;
}

async function handleSave() {
    const saveBtn = card.querySelector('.save-btn');
    const newPassInput = card.querySelector('#new-password');
    const isPasswordEnabled = card.querySelector('#password-enabled').checked;
    const newPasswordValue = newPassInput.value;

    // 检查是否为需要管理员权限的敏感操作
    const isChangingPassword = isPasswordEnabled && newPasswordValue.trim() !== '' && initialSettings.hasPassword;
    const isDisablingPassword = !isPasswordEnabled && initialSettings.hasPassword;
    const needsAdmin = isChangingPassword || isDisablingPassword;

    if (needsAdmin) {
        if (!initialSettings.isAdminSecretConfigured) {
            showNotification('操作失败：未配置超级管理员密码', 'error');
            saveBtn.classList.remove('loading');
            saveBtn.disabled = false;
            return;
        }

        showPasswordPrompt({
            useAdminSecret: true,
            onConfirm: async (adminSecret) => {
                // 直接返回 executeSave 的执行结果
                return await executeSave(adminSecret);
            }
        });
    } else {
        await executeSave();
    }
}

async function executeSave(adminSecret = null) {
    const saveBtn = card.querySelector('.save-btn');
    saveBtn.classList.add('loading');
    saveBtn.disabled = true;

    const newPassInput = card.querySelector('#new-password');
    newPassInput.classList.remove('input-error');

    const isPasswordEnabled = card.querySelector('#password-enabled').checked;
    const newPasswordValue = newPassInput.value;

    // 校验：首次启用密码必须设置新密码
    if (isPasswordEnabled && !initialSettings.hasPassword && !newPasswordValue) {
        showNotification('请设置新密码以启用密码访问', 'error');
        card.querySelector('button[data-tab="security"]').click();
        newPassInput.focus();
        newPassInput.classList.add('input-error');
        saveBtn.classList.remove('loading');
        saveBtn.disabled = false;
        return false; // 修复：返回 false 表示操作失败
    }

    // 组装本地AI设置
    const localAI = {
        AI_ENABLED: String(card.querySelector('#ai-enabled').checked),
        AI_URL: card.querySelector('#ai-url').value.trim(),
        AI_MODEL: card.querySelector('#ai-model').value.trim(),
        AI_PROMPT: card.querySelector('#ai-prompt').value.trim(),
    };
    const newApiKey = card.querySelector('#ai-key').value;
    if (newApiKey) {
        localAI.AI_KEY = newApiKey;
    } else {
        const oldAI = getLocalAISettings();
        if (oldAI.AI_KEY) localAI.AI_KEY = oldAI.AI_KEY;
    }
    setLocalAISettings(localAI);

    // 组装要发送到后端的设置
    const settingsToSend = {
        PASSWORD_ENABLED: String(isPasswordEnabled),
    };
    if (newPasswordValue) {
        settingsToSend.newPassword = newPasswordValue;
    }
    if (adminSecret) {
        settingsToSend.adminSecret = adminSecret;
    }

    try {
        const result = await saveSettings(settingsToSend);

        // 行为判定：用于细分通知
        const prevPasswordEnabled = String(initialSettings.PASSWORD_ENABLED) === 'true';
        const nextPasswordEnabled = isPasswordEnabled;
        const aiPrevEnabled = String(initialSettings.AI_ENABLED) === 'true';
        const aiNextEnabled = String(card.querySelector('#ai-enabled').checked) === 'true';
        const newPassProvided = !!newPasswordValue.trim();

        const actions = [];
        if (prevPasswordEnabled !== nextPasswordEnabled) {
            actions.push(nextPasswordEnabled ? 'enable_password' : 'disable_password');
        } else if (nextPasswordEnabled && newPassProvided) {
            actions.push('change_password');
        }
        if (aiPrevEnabled !== aiNextEnabled) {
            actions.push(aiNextEnabled ? 'enable_ai' : 'disable_ai');
        }

        const buildMessage = (status, extraMsg) => {
            const parts = [];
            for (const act of actions) {
                switch (act) {
                    case 'enable_password':
                        parts.push(status === 'success' ? '访问密码已设置' : status === 'timeout' ? '启用访问密码超时' : '启用访问密码失败');
                        break;
                    case 'disable_password':
                        parts.push(status === 'success' ? '访问密码已关闭' : status === 'timeout' ? '关闭访问密码超时' : '关闭访问密码失败');
                        break;
                    case 'change_password':
                        parts.push(status === 'success' ? '访问密码已修改' : status === 'timeout' ? '修改访问密码超时' : '修改访问密码失败');
                        break;
                    case 'enable_ai':
                        parts.push(status === 'success' ? 'AI密语功能已打开' : status === 'timeout' ? '开启 AI 密语功能超时' : '开启 AI 密语功能失败');
                        break;
                    case 'disable_ai':
                        parts.push(status === 'success' ? 'AI密语功能已关闭' : status === 'timeout' ? '关闭 AI 密语功能超时' : '关闭 AI 密语功能失败');
                        break;
                }
            }
            if (parts.length === 0) {
                // 回退：无识别到的动作
                parts.push(status === 'success' ? '设置更新成功' : status === 'timeout' ? '设置更新超时' : (extraMsg || '设置更新失败'));
            }
            if (extraMsg && status !== 'success') parts.push(extraMsg);
            return parts.join('；');
        };

        // 如果后端采用异步队列，返回202 + updateId，主动轮询直到完成
        if (result && result.status === 'pending' && result.updateId) {
            const { final, info } = await waitForSettingsUpdate(result.updateId, { intervalMs: 1000, timeoutMs: 30000 });
            if (final === 'success') {
                showNotification(buildMessage('success'), 'success');
            } else if (final === 'failed') {
                const extra = (info && info.message) ? info.message : null;
                showNotification(buildMessage('failed', extra), 'error');
            } else if (final === 'timeout') {
                showNotification(buildMessage('timeout'), 'warn');
            } else {
                const msg = info && info.message ? info.message : '设置更新发生错误';
                showNotification(buildMessage('failed', msg), 'error');
            }
        } else {
            // 立即返回成功的情形（当前主要用于非认证项；保持与细分提示一致）
            showNotification(buildMessage('success', result && result.message), 'success');
        }
        
        // 立即更新state，确保设置实时生效
        state.update('aiEnabled', localAI.AI_ENABLED === 'true');
        state.update('passwordEnabled', settingsToSend.PASSWORD_ENABLED === 'true');
        
        // 触发设置变更事件，通知其他组件
        window.dispatchEvent(new CustomEvent('settingsChanged', {
            detail: {
                aiEnabled: localAI.AI_ENABLED === 'true',
                passwordEnabled: settingsToSend.PASSWORD_ENABLED === 'true',
                aiSettings: localAI
            }
        }));
        
        // 延迟关闭设置模态框，让密码模态框先关闭
        setTimeout(closeSettingsModal, 1000);
        return true; // 新增：成功时返回 true
    } catch (error) {
        showNotification(error.message, 'error');
        if (error.message.includes('密码')) {
            const oldPassInput = card.querySelector('#old-password');
            const target = (error.message.includes('旧密码') && oldPassInput) ? oldPassInput : newPassInput;
            target.classList.add('input-error');
            target.focus();
        }
        saveBtn.classList.remove('loading');
        checkForChanges();
        return false; // 新增：失败时返回 false
    }
}

// --- 事件监听与交互 ---
/**
 * 设置界面所有事件监听器的初始化
 * 包括tab切换、保存、取消、输入变更等
 */
function setupListeners() {
    const nav = card.querySelector('.settings-nav');
    const panels = card.querySelectorAll('.settings-tab-content');
    const passwordEnabledToggle = card.querySelector('#password-enabled');
    const aiEnabledToggle = card.querySelector('#ai-enabled');
    const newPasswordInput = card.querySelector('#new-password');
    const newPasswordWrapper = card.querySelector('#new-password-wrapper');

    // 当新密码输入框的容器被点击时，如果输入框被禁用，则显示通知
    newPasswordWrapper.addEventListener('click', (e) => {
        if (newPasswordInput.disabled) {
            e.preventDefault();
            showNotification('未配置超级管理员密码，无法更改此设置', 'error');
        }
    });

    // Tab 切换
    nav.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        nav.querySelector('.active').classList.remove('active');
        panels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        card.querySelector(`#${btn.dataset.tab}-settings-content`).classList.add('active');
    });

    // 关闭与取消按钮
    card.querySelector('.close-btn').addEventListener('click', closeSettingsModal);
    card.querySelector('.cancel-btn').addEventListener('click', closeSettingsModal);
    card.querySelector('.save-btn').addEventListener('click', handleSave);

    // 输入变更检测 (通用)
    card.querySelectorAll('input:not(#password-enabled), textarea').forEach(el => {
        el.addEventListener('input', checkForChanges);
        el.addEventListener('change', checkForChanges);
    });

    // 新密码输入框的错误样式处理
    if(newPasswordInput) {
        newPasswordInput.addEventListener('input', () => {
            newPasswordInput.classList.remove('input-error');
        });
    }

    // --- 密码开关的特殊处理 ---
    // 1. 使用 click 事件在 'change' 事件触发前进行拦截
    passwordEnabledToggle.addEventListener('click', e => {
        const shouldBeDisabled = initialSettings.hasPassword && !initialSettings.isAdminSecretConfigured;

        // 如果开关当前是勾选状态，且应该被禁用，那么用户的意图是取消勾选。我们阻止这个行为。
        if (e.target.checked && shouldBeDisabled) {
            e.preventDefault(); // 这会阻止开关状态的改变，因此 'change' 事件不会触发
            showNotification('未配置超级管理员密码，无法更改此设置', 'error');
        }
    });

    // 2. 'change' 事件只在合法的状态改变后触发
    passwordEnabledToggle.addEventListener('change', e => {
        updateDynamicUI(e.target.checked, aiEnabledToggle.checked, initialSettings.hasPassword);
        checkForChanges(); // 合法改变，检查并更新保存按钮状态
    });

    // AI 开关逻辑
    aiEnabledToggle.addEventListener('change', e => {
        updateDynamicUI(passwordEnabledToggle.checked, e.target.checked, initialSettings.hasPassword);
        checkForChanges(); // AI开关总是合法的，检查并更新保存按钮状态
    });

    setupPasswordToggles();
}

/**
 * 密码输入框显示/隐藏切换功能
 * 绑定眼睛图标点击事件
 */
function setupPasswordToggles() {
    const wrappers = card.querySelectorAll('.password-wrapper');
    wrappers.forEach(wrapper => {
        const input = wrapper.querySelector('input');
        const icon = wrapper.querySelector('.password-toggle-icon');
        if (!input || !icon) return;
        const openEye = icon.querySelector('.eye-open');
        const closedEye = icon.querySelector('.eye-closed');
        openEye.style.display = input.type === 'password' ? 'block' : 'none';
        closedEye.style.display = input.type === 'password' ? 'none' : 'block';
        icon.addEventListener('click', (e) => {
            e.stopPropagation();
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            openEye.style.display = isPassword ? 'none' : 'block';
            closedEye.style.display = isPassword ? 'block' : 'none';
            const originalColor = icon.style.color;
            icon.style.color = 'white';
            setTimeout(() => {
                icon.style.color = originalColor || '';
            }, 200);
        });
    });
}

// --- 工具函数 ---

/**
 * 显示密码或管理员密钥验证弹窗
 * @param {Object} param0 - 配置对象，包含onConfirm和onCancel回调
 */
function showPasswordPrompt({ onConfirm, onCancel, useAdminSecret = false }) {
    const template = document.getElementById('password-prompt-template');
    if (!template) return;
    const promptElement = template.content.cloneNode(true).firstElementChild;
    document.body.appendChild(promptElement);

    const title = promptElement.querySelector('h3');
    const description = promptElement.querySelector('.password-prompt-description');
    const input = promptElement.querySelector('#prompt-password-input');

    if (useAdminSecret) {
        title.textContent = '需要管理员权限';
        description.textContent = '请输入管理员密钥以继续操作。';
        input.placeholder = '管理员密钥';
    } else {
        title.textContent = '身份验证';
        description.textContent = '请输入您的密码以继续操作。';
        input.placeholder = '密码';
    }

    const cardEl = promptElement.querySelector('.password-prompt-card');
    const inputGroup = promptElement.querySelector('.input-group');
    const errorMsg = promptElement.querySelector('#prompt-error-message');
    const confirmBtn = promptElement.querySelector('.confirm-btn');
    const cancelBtn = promptElement.querySelector('.cancel-btn');
    const toggleBtn = promptElement.querySelector('.password-toggle-btn');

    /**
     * 关闭弹窗
     */
    const closePrompt = () => {
        promptElement.classList.remove('active');
        promptElement.addEventListener('transitionend', () => promptElement.remove(), { once: true });
        if (onCancel) onCancel();
    };

    requestAnimationFrame(() => {
        promptElement.classList.add('active');
        input.focus();
    });

    // 密码可见性切换
    toggleBtn.addEventListener('click', () => {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        toggleBtn.querySelector('.eye-open').style.display = isPassword ? 'none' : 'block';
        toggleBtn.querySelector('.eye-closed').style.display = isPassword ? 'block' : 'none';
        input.focus();
    });

    // 确认按钮逻辑
    confirmBtn.addEventListener('click', async () => {
        inputGroup.classList.remove('error');
        errorMsg.textContent = '';
        cardEl.classList.remove('shake');
        if (!input.value) {
            errorMsg.textContent = '密码不能为空。';
            inputGroup.classList.add('error');
            cardEl.classList.add('shake');
            input.focus();
            return;
        }
        confirmBtn.classList.add('loading');
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
            const success = await onConfirm(input.value);
            if (success === true) {
                inputGroup.classList.add('success');
                confirmBtn.classList.remove('loading');
                setTimeout(closePrompt, 800);
            } else {
                throw new Error("密码错误或验证失败");
            }
        } catch (err) {
            confirmBtn.classList.remove('loading');
            confirmBtn.disabled = false;
            cancelBtn.disabled = false;
            cardEl.classList.add('shake');
            inputGroup.classList.add('error');
            errorMsg.textContent = err.message || '密码错误或验证失败';
            input.focus();
            input.select();
        }
    });

    // 输入框事件
    input.addEventListener('input', () => {
        inputGroup.classList.remove('error');
        errorMsg.textContent = '';
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmBtn.click(); });
    cancelBtn.addEventListener('click', closePrompt);
    promptElement.addEventListener('click', (e) => { if (e.target === promptElement) closePrompt(); });
    
    // ESC键关闭弹窗
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            closePrompt();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

// --- 导出 ---
export { getLocalAISettings, setLocalAISettings };