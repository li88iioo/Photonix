const INTERACTIVE_SELECTOR = '.btn-primary, .btn-secondary, .btn-outline, .btn-danger, .btn-link, .btn-icon, .nav-item, .sidebar-close, .sidebar-toggle, .panel-actions button, .modal-close, .task-menu-item';

function createRipple(element, event, { center = false } = {}) {
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const radius = Math.max(rect.width, rect.height);
  const ripple = document.createElement('span');
  ripple.className = 'btn-ripple';
  const offsetX = center ? rect.width / 2 : (event?.clientX ?? rect.left) - rect.left;
  const offsetY = center ? rect.height / 2 : (event?.clientY ?? rect.top) - rect.top;
  ripple.style.width = ripple.style.height = `${radius * 2}px`;
  ripple.style.left = `${offsetX - radius}px`;
  ripple.style.top = `${offsetY - radius}px`;
  element.appendChild(ripple);
  requestAnimationFrame(() => {
    ripple.classList.add('is-active');
  });
  ripple.addEventListener('animationend', () => {
    if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
  });
}

function attachRippleHandlers(element) {
  if (!element || element.dataset.fxReady) return;
  element.dataset.fxReady = 'true';
  element.classList.add('btn-interactive');
  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || element.disabled) return;
    createRipple(element, event);
  });
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    createRipple(element, null, { center: true });
  });
}

export function applyInteractiveEffects(scope = document) {
  if (!scope) return;
  const nodes = scope.querySelectorAll(INTERACTIVE_SELECTOR);
  nodes.forEach((node) => attachRippleHandlers(node));
}
