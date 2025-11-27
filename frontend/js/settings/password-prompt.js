/**
 * @file frontend/js/settings/password-prompt.js
 * @description 在执行敏感操作前弹出密码或管理员密钥验证提示
 */

import { resolveMessage } from '../shared/utils.js';
import { safeGetElementById, safeClassList, safeSetStyle, safeGetStyle } from '../shared/dom-utils.js';

/**
 * 显示密码或管理员密钥确认弹窗并处理用户响应。
 * @param {Object} options - 弹窗配置
 * @param {(password: string) => Promise<boolean>|boolean} options.onConfirm - 确认回调，返回 false 时保持弹窗
 * @param {() => void} [options.onCancel] - 取消操作后的回调
 * @param {boolean} [options.useAdminSecret=false] - 是否使用管理员密钥提示语
 * @returns {void}
 */
export function showPasswordPrompt({
  onConfirm,
  onCancel,
  useAdminSecret = false,
  titleText,
  descriptionText,
  placeholderText
}) {
  const template = safeGetElementById('password-prompt-template');
  if (!template) return;

  const promptElement = template.content.cloneNode(true).firstElementChild;
  document.body.appendChild(promptElement);

  const title = promptElement.querySelector('h3');
  const description = promptElement.querySelector('.password-prompt-description');
  const input = promptElement.querySelector('#prompt-password-input');

  const resolvedTitle = titleText || (useAdminSecret ? '需要管理员权限' : '身份验证');
  const resolvedDescription = descriptionText || (useAdminSecret ? '请输入管理员密钥以继续操作。' : '请输入您的密码以继续操作。');
  const resolvedPlaceholder = placeholderText || (useAdminSecret ? '管理员密钥' : '密码');

  title.textContent = resolvedTitle;
  description.textContent = resolvedDescription;
  input.placeholder = resolvedPlaceholder;

  const cardEl = promptElement.querySelector('.password-prompt-card');
  const inputGroup = promptElement.querySelector('.input-group');
  const errorMsg = promptElement.querySelector('#prompt-error-message');
  const confirmBtn = promptElement.querySelector('.confirm-btn');
  const cancelBtn = promptElement.querySelector('.cancel-btn');
  const toggleBtn = promptElement.querySelector('.password-toggle-btn');

  let closeReason = 'cancel';

  const closePrompt = () => {
    safeClassList(promptElement, 'remove', 'active');
    promptElement.addEventListener('transitionend', () => promptElement.remove(), { once: true });
    if (closeReason === 'cancel' && onCancel) {
      onCancel();
    }
  };

  requestAnimationFrame(() => {
    safeClassList(promptElement, 'add', 'active');
    input.focus();
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
        closeReason = 'success';
        setTimeout(closePrompt, 250);
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
      closeReason = 'cancel';
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

  cancelBtn.addEventListener('click', closePrompt);
  promptElement.addEventListener('click', (e) => {
    if (e.target === promptElement) closePrompt();
  });

  const escapeHandler = (e) => {
    if (e.key === 'Escape') {
      closePrompt();
      document.removeEventListener('keydown', escapeHandler);
    }
  };

  document.addEventListener('keydown', escapeHandler);
}
