/**
 * DropdownController: Accessible dropdown manager with focus trapping,
 * outside-click dismissal, Escape handling, and local focus return.
 */

export class DropdownController {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.toggleButton - The button that toggles the dropdown
   * @param {HTMLElement} options.menu - The dropdown menu container
   * @param {boolean} [options.trapFocus=true] - Trap focus within menu when open
   * @param {boolean} [options.restoreFocus=true] - Return focus to toggle when closing
   * @param {boolean} [options.closeOnOutside=true] - Close when clicking outside
   * @param {Function} [options.onOpen] - Called after menu opens
   * @param {Function} [options.onClose] - Called after menu closes
   */
  constructor({ toggleButton, menu, trapFocus = true, restoreFocus = true, closeOnOutside = true, onOpen, onClose } = {}) {
    if (!toggleButton || !menu) throw new Error('DropdownController requires toggleButton and menu');
    this.button = toggleButton;
    this.menu = menu;
    this.trapFocus = trapFocus;
    this.restoreFocus = restoreFocus;
    this.closeOnOutside = closeOnOutside;
    this.onOpen = typeof onOpen === 'function' ? onOpen : null;
    this.onClose = typeof onClose === 'function' ? onClose : null;

    this.isOpen = false;
    this.previouslyFocused = null;

    // Ensure ARIA
    this.button.setAttribute('aria-haspopup', 'menu');
    this.button.setAttribute('aria-expanded', 'false');
    this.menu.setAttribute('role', this.menu.getAttribute('role') || 'menu');
    this.menu.classList.add('hidden');

    // Bind handlers
    this._onToggleClick = this._onToggleClick.bind(this);
    this._onButtonKeydown = this._onButtonKeydown.bind(this);
    this._onMenuKeydown = this._onMenuKeydown.bind(this);
    this._onDocumentPointerDown = this._onDocumentPointerDown.bind(this);

    // Attach
    this.button.addEventListener('click', this._onToggleClick);
    this.button.addEventListener('keydown', this._onButtonKeydown);
    this.menu.addEventListener('keydown', this._onMenuKeydown);
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.previouslyFocused = document.activeElement;
    this.button.setAttribute('aria-expanded', 'true');
    this.menu.classList.remove('hidden');

    if (this.closeOnOutside) {
      document.addEventListener('pointerdown', this._onDocumentPointerDown, { capture: true });
    }

    // Focus first focusable item
    const focusables = this._getFocusableItems();
    if (focusables.length > 0) {
      requestAnimationFrame(() => focusables[0].focus());
    }

    if (this.onOpen) this.onOpen();
  }

  close(returnFocus = true) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.button.setAttribute('aria-expanded', 'false');
    this.menu.classList.add('hidden');

    if (this.closeOnOutside) {
      document.removeEventListener('pointerdown', this._onDocumentPointerDown, { capture: true });
    }

    if (this.onClose) this.onClose();

    if (returnFocus && this.restoreFocus && this.button && document.contains(this.button)) {
      requestAnimationFrame(() => this.button.focus());
    }
  }

  destroy() {
    this.close(false);
    this.button.removeEventListener('click', this._onToggleClick);
    this.button.removeEventListener('keydown', this._onButtonKeydown);
    this.menu.removeEventListener('keydown', this._onMenuKeydown);
  }

  _onToggleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (this.isOpen) this.close(true); else this.open();
  }

  _onButtonKeydown(e) {
    const key = e.key;
    if (key === 'ArrowDown' || key === 'Enter' || key === ' ') {
      e.preventDefault();
      this.open();
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      this.open();
      const items = this._getFocusableItems();
      if (items.length) items[items.length - 1].focus();
    } else if (key === 'Escape') {
      e.preventDefault();
      this.close(true);
    }
  }

  _onMenuKeydown(e) {
    const key = e.key;
    const items = this._getFocusableItems();
    if (key === 'Escape') {
      e.preventDefault();
      this.close(true);
      return;
    }
    if (!this.trapFocus) return;

    const currentIndex = items.indexOf(document.activeElement);
    if (key === 'Tab') {
      if (items.length === 0) return;
      if (e.shiftKey) {
        if (currentIndex <= 0) {
          e.preventDefault();
          items[items.length - 1].focus();
        }
      } else {
        if (currentIndex === -1 || currentIndex >= items.length - 1) {
          e.preventDefault();
          items[0].focus();
        }
      }
    } else if (key === 'ArrowDown') {
      e.preventDefault();
      const next = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, items.length - 1);
      if (items[next]) items[next].focus();
    } else if (key === 'ArrowUp') {
      e.preventDefault();
      const prev = currentIndex < 0 ? items.length - 1 : Math.max(currentIndex - 1, 0);
      if (items[prev]) items[prev].focus();
    }
  }

  _onDocumentPointerDown(e) {
    const target = e.target;
    if (!target) return;
    if (this.button.contains(target) || this.menu.contains(target)) return;
    this.close(false);
  }

  _getFocusableItems() {
    const selectors = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ];
    const els = Array.from(this.menu.querySelectorAll(selectors.join(',')));
    return els.filter(el => el.offsetParent !== null);
  }
}
