/**
 * @file frontend/js/settings/password-prompt.js
 * @description 在执行敏感操作前弹出密码或管理员密钥验证提示
 */

import { resolveMessage } from '../shared/utils.js';
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
  const template = document.getElementById('password-prompt-template');
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
    promptElement?.classList.remove('active');
    promptElement.addEventListener('transitionend', () => promptElement.remove(), { once: true });
    if (closeReason === 'cancel' && onCancel) {
      onCancel();
    }
  };

  requestAnimationFrame(() => {
    promptElement?.classList.add('active');
    input.focus();
  });

  toggleBtn.addEventListener('click', () => {
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    toggleBtn.querySelector('.eye-open').style.display = isPassword ? 'none' : 'block';
    toggleBtn.querySelector('.eye-closed').style.display = isPassword ? 'block' : 'none';
    input.focus();
  });

  confirmBtn.addEventListener('click', async () => {
    inputGroup?.classList.remove('error');
    errorMsg.textContent = '';
    cardEl?.classList.remove('shake');

    if (!input.value) {
      errorMsg.textContent = '密码不能为空。';
      inputGroup?.classList.add('error');
      cardEl?.classList.add('shake');
      input.focus();
      return;
    }

    confirmBtn?.classList.add('loading');
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;

    try {
      const success = await onConfirm(input.value);
      if (success !== false) {
        inputGroup?.classList.add('success');
        confirmBtn?.classList.remove('loading');
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        closeReason = 'success';
        setTimeout(closePrompt, 250);
      } else {
        const manualMessage = useAdminSecret ? '管理员密钥错误，请重新输入' : '密码错误或验证失败';
        throw new Error(manualMessage);
      }
    } catch (err) {
      confirmBtn?.classList.remove('loading');
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      cardEl?.classList.add('shake');
      inputGroup?.classList.add('error');
      const fallbackMessage = useAdminSecret ? '管理员密钥错误，请重新输入' : '密码错误或验证失败';
      errorMsg.textContent = resolveMessage(err, fallbackMessage);
      input.focus();
      input.select();
      closeReason = 'cancel';
      return;
    }
  });

  input.addEventListener('input', () => {
    inputGroup?.classList.remove('error');
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
