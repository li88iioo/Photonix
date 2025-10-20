const STORAGE_KEY = 'photonix:theme';
export const Theme = {
  LIGHT: 'light',
  DARK: 'dark',
  SYSTEM: 'system'
};

let mediaQuery = null;
let currentPreference = null; // 'light' | 'dark' | 'system'

function systemPrefersDark() {
  try {
    mediaQuery = mediaQuery || window.matchMedia('(prefers-color-scheme: dark)');
    return !!mediaQuery.matches;
  } catch {
    return false;
  }
}

function applyComputedTheme(computed) {
  const root = document.documentElement;
  root.dataset.theme = computed; // data-theme="light" | "dark"
  root.classList.toggle('theme-dark', computed === 'dark');
  root.classList.toggle('theme-light', computed === 'light');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', computed === 'dark' ? '#111827' : '#ffffff');
  }
}

function _compute(mode) {
  if (mode === Theme.SYSTEM) return systemPrefersDark() ? Theme.DARK : Theme.LIGHT;
  return mode === Theme.DARK ? Theme.DARK : Theme.LIGHT;
}

function _onSystemChange() {
  if (currentPreference !== Theme.SYSTEM) return;
  const computed = _compute(Theme.SYSTEM);
  applyComputedTheme(computed);
}

export function initTheme() {
  try {
    currentPreference = localStorage.getItem(STORAGE_KEY) || Theme.SYSTEM;
  } catch {
    currentPreference = Theme.SYSTEM;
  }
  const computed = _compute(currentPreference);
  applyComputedTheme(computed);

  try {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    if (mediaQuery && typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', _onSystemChange);
    } else if (mediaQuery && typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(_onSystemChange); // old Safari
    }
  } catch {}
}

export function setTheme(mode) {
  currentPreference = mode;
  try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
  const computed = _compute(mode);
  applyComputedTheme(computed);
}

export function getTheme() {
  return currentPreference || Theme.SYSTEM;
}

export function bindThemeSwitcher(container) {
  if (!container) return;
  const buttons = Array.from(container.querySelectorAll('[data-theme]'));
  if (buttons.length === 0) return;

  const updatePressed = () => {
    const selected = getTheme();
    // selected could be 'system', but UI shows pressed for that button
    buttons.forEach(btn => {
      const target = btn.getAttribute('data-theme');
      const pressed = String(target) === String(selected);
      btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
  };

  // Initialize ARIA
  container.setAttribute('role', container.getAttribute('role') || 'group');
  container.setAttribute('aria-label', container.getAttribute('aria-label') || 'Theme');

  buttons.forEach((btn, index) => {
    btn.setAttribute('role', 'button');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const target = btn.getAttribute('data-theme') || Theme.SYSTEM;
      setTheme(target);
      updatePressed();
    });
    btn.addEventListener('keydown', (e) => {
      const key = e.key;
      if (key === ' ' || key === 'Enter') {
        e.preventDefault();
        btn.click();
      } else if (key === 'ArrowRight' || key === 'ArrowLeft') {
        e.preventDefault();
        const dir = key === 'ArrowRight' ? 1 : -1;
        const next = (index + dir + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    });
  });

  updatePressed();
}
