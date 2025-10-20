/**
 * @file frontend/js/settings/password-prompt.js
 * @description 在执行敏感操作前弹出密码或管理员密钥验证提示
 */

import { resolveMessage } from '../shared/utils.js';
import { safeGetElementById, safeClassList, safeSetStyle, safeGetStyle } from '../shared/dom-utils.js';
import { createModalShell } from '../app/modal.js';

/**
 * 显示密码或管理员密钥确认弹窗并处理用户响应。
 * @param {Object} options - 弹窗配置
 * @param {(password: string) => Promise<boolean>|boolean} options.onConfirm - 确认回调，返回 false 时保持弹窗
 * @param {() => void} [options.onCancel] - 取消操作后的回调
 * @param {boolean} [options.useAdminSecret=false] - 是否使用管理员密钥提示语
 * @returns {void}
 */
export function showPasswordPrompt({ onConfirm, onCancel, useAdminSecret = false }) {
  const template = safeGetElementById('password-prompt-template');
  if (!template) return;

  const fragment = template.content.cloneNode(true);
  const cardEl = fragment.querySelector('.password-prompt-card');
  if (!cardEl) return;

  // 使用共享模态外壳
  const { body, close } = createModalShell({ useHeader: false });

  body.appendChild(cardEl);

  const title = cardEl.querySelector('h3');
  const description = cardEl.querySelector('.password-prompt-description');
  const input = cardEl.querySelector('#prompt-password-input');

  if (useAdminSecret) {
    title.textContent = '需要管理员权限';
    description.textContent = '请输入管理员密钥以继续操作。';
    input.placeholder = '管理员密钥';
  } else {
    title.textContent = '身份验证';
    description.textContent = '请输入您的密码以继续操作。';
    input.placeholder = '密码';
  }

  const inputGroup = cardEl.querySelector('.input-group');
  const errorMsg = cardEl.querySelector('#prompt-error-message');
  const confirmBtn = cardEl.querySelector('.confirm-btn');
  const cancelBtn = cardEl.querySelector('.cancel-btn');
  const toggleBtn = cardEl.querySelector('.password-toggle-btn');

  requestAnimationFrame(() => {
    input && input.focus();
  });

  toggleBtn.addEventListener('click', () => {
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    safeSetStyle(toggleBtn.querySelector('.eye-open'), 'display', isPassword ? 'none' : 'block');
    safeSetStyle(toggleBtn.querySelector('.eye-closed'), 'display', isPassword ? 'block' : 'none');
    input.focus();
  });

  confirmBtn.addEventListener('click', async () => {
    safeClassList(inputGroup, 'remove', 'error');
    errorMsg.textContent = '';
    safeClassList(cardEl, 'remove', 'shake');

    if (!input.value) {
      errorMsg.textContent = '密码不能为空。';
      safeClassList(inputGroup, 'add', 'error');
      safeClassList(cardEl, 'add', 'shake');
      input.focus();
      return;
    }

    safeClassList(confirmBtn, 'add', 'loading');
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;

    try {
      const success = await onConfirm(input.value);
      if (success !== false) {
        safeClassList(inputGroup, 'add', 'success');
        safeClassList(confirmBtn, 'remove', 'loading');
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        setTimeout(() => close('success'), 250);
      } else {
        const manualMessage = useAdminSecret ? '管理员密钥错误，请重新输入' : '密码错误或验证失败';
        throw new Error(manualMessage);
      }
    } catch (err) {
      safeClassList(confirmBtn, 'remove', 'loading');
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      safeClassList(cardEl, 'add', 'shake');
      safeClassList(inputGroup, 'add', 'error');
      const fallbackMessage = useAdminSecret ? '管理员密钥错误，请重新输入' : '密码错误或验证失败';
      errorMsg.textContent = resolveMessage(err, fallbackMessage);
      input.focus();
      input.select();
      return;
    }
  });

  input.addEventListener('input', () => {
    safeClassList(inputGroup, 'remove', 'error');
    errorMsg.textContent = '';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmBtn.click();
  });

  cancelBtn.addEventListener('click', () => {
    try { close('cancel'); } catch {}
    if (typeof onCancel === 'function') onCancel();
  });
}
