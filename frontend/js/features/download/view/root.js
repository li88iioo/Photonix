import { applyInteractiveEffects } from './effects.js';
import {
  iconPlus,
  iconPlay,
  iconStop,
  iconEye,
  iconEdit,
  iconClose,
  iconDownload,
  iconCircleCheck,
  iconCircleX,
  iconRefresh,
  iconChartBar,
  iconSettings,
  iconRss,
  iconFileText,
  iconImport,
  iconExport
} from '../../../shared/svg-templates.js';

let rootEl = null;
let navLinks = [];
let pageContainers = {};
let sidebarEl = null;

function ensureStyleHelpers() {
  if (document.getElementById('download-style-helpers')) return;
  const style = document.createElement('style');
  style.id = 'download-style-helpers';
  style.textContent = `
    :root {
      --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      --bg-color: #f7f8fa;
      --surface-color: #ffffff;
      --surface-muted: #f9fafb;
      --surface-subtle: #eef2ff;
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --primary-light: #eef2ff;
      --text-color: #1a202c;
      --text-secondary: #64748b;
      --border-color: #e2e8f0;
      --border-strong: #cbd5e1;
      --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.08);
      --shadow-md: 0 10px 30px rgba(15, 23, 42, 0.08);
      --shadow-lg: 0 20px 45px rgba(15, 23, 42, 0.12);
    }
    html.download-page-active {
      overflow: hidden;
      height: 100%;
    }
    body.download-page-active {
      margin: 0;
      overflow: hidden;
      font-family: var(--font-family);
      background: var(--bg-color);
      color: var(--text-color);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      width: 100%;
      height: 100%;
      position: relative;
    }
    .download-root {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 1500; /* ✅ 高于 topbar (1000)，低于 settings (2000) */
      display: flex;
      justify-content: flex-start;
      align-items: stretch;
      background: var(--bg-color);
      overflow: hidden;
      overscroll-behavior: contain;
    }
    .download-root.hidden { display: none !important; }
    .download-shell {
      display: flex;
      flex: 1;
      width: 100%;
      min-height: 0;
      background: var(--bg-color);
      color: var(--text-color);
      overflow: hidden;
    }
    .download-sidebar {
      width: 264px;
      background: var(--surface-color);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      padding: calc(24px + env(safe-area-inset-top, 0)) 16px calc(20px + env(safe-area-inset-bottom, 0));
      transition: transform 0.3s ease;
      position: relative;
      z-index: 10;
      flex-shrink: 0;
      box-sizing: border-box;
      min-height: 0;
    }
    .sidebar-scroll {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    .sidebar-header {
      padding: 0 8px 18px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .sidebar-title { display: flex; align-items: center; gap: 12px; }
    .sidebar-name {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: var(--text-color);
    }
    .sidebar-hint {
      margin: 4px 0 0;
      font-size: 12px;
      color: var(--text-secondary);
    }
    .sidebar-close {
      display: none;
      border: none;
      background: var(--primary-light);
      color: var(--primary);
      border-radius: 10px;
      width: 36px;
      height: 36px;
      box-shadow: var(--shadow-sm);
      cursor: pointer;
    }
    .sidebar-nav {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 16px 4px 12px;
      margin: 0;
      list-style: none;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable both-edges;
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-left: 3px solid transparent;
      border-radius: 10px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
    }
    .nav-item:hover { background: rgba(79, 70, 229, 0.12); color: var(--primary); }
    .nav-item.active {
      background: #eef2ff;
      color: #4f46e5;
      font-weight: 600;
      border-left-color: #4f46e5;
      box-shadow: none;
    }
    .nav-icon { display: inline-flex; align-items: center; justify-content: center; color: inherit; }
    .nav-icon svg { width: 20px; height: 20px; }
    .sidebar-footer {
      margin-top: 16px;
      padding: 16px 0 calc(18px + env(safe-area-inset-bottom, 0));
      border-top: 1px solid var(--border-color);
      background: linear-gradient(180deg, rgba(249, 250, 251, 0) 0%, rgba(249, 250, 251, 0.85) 45%, var(--surface-color) 100%);
      flex-shrink: 0;
    }
    .sidebar-footer .btn-outline { width: 100%; }
    .download-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      background: var(--bg-color);
    }
    .sidebar-toggle {
      display: none;
      border: 1px solid var(--border-color);
      background: var(--surface-color);
      color: var(--text-color);
      width: 40px;
      border-radius: 10px;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      margin-bottom: 24px;
    }
    .sidebar-toggle svg { width: 20px; height: 20px; display: block; margin: 0 auto; }
    .download-body {
      flex: 1;
      overflow-y: auto;
      padding: 32px 32px calc(140px + env(safe-area-inset-bottom, 20px));
      box-sizing: border-box;
      background: var(--bg-color);
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      position: relative;
      min-height: 100%;
    }
    .download-page { display: none; animation: fade-in 0.3s ease; }
    .download-page.hidden { display: none; }
    .download-page:not(.hidden) { display: block; }
    .section { margin-bottom: 32px; }
    .two-column { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 24px; }
    .metrics-grid { display: grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .metric-card {
      background: var(--surface-color);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 20px;
      box-shadow: var(--shadow-sm);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .metric-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
    .metric-label { font-size: 13px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
    .metric-value { font-size: 28px; font-weight: 700; margin: 8px 0 6px; color: var(--text-color); }
    .metric-desc { font-size: 12px; color: var(--text-secondary); }
    .download-root.is-loading .metric-card { pointer-events: none; opacity: 0.6; }
    .metric-trend { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; min-height: 64px; }
    .trend-meta { display: flex; align-items: baseline; justify-content: space-between; font-size: 12px; color: var(--text-secondary); }
    .trend-value { font-weight: 600; font-size: 14px; color: var(--text-color); }
    .trend-value[data-trend-state="up"] { color: #16a34a; }
    .trend-value[data-trend-state="down"] { color: #dc2626; }
    .trend-diff { font-size: 12px; color: var(--text-secondary); }
    .trend-chart { width: 100%; height: 48px; display: block; }
    .trend-line { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .trend-area { stroke: none; }
    .trend-placeholder { font-size: 12px; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 6px; }
    .panel {
      background: var(--surface-color);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      box-shadow: var(--shadow-sm);
      display: flex;
      flex-direction: column;
      gap: 18px;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .panel:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); }
    .panel-header { display: flex; flex-wrap: wrap;align-items: center; justify-content: space-between; }
    .panel-title { margin: 0; font-size: 18px; font-weight: 600; color: var(--text-color); }
    .panel-desc { margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); }
    .panel-actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .panel-actions > * { flex: 0 0 auto; }
    .panel-actions.compact { gap: 8px; }
    .btn,
    .btn-primary,
    .btn-secondary,
    .btn-outline,
    .btn-link,
    .btn-icon,
    .btn-danger { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border-radius: 10px; font-size: 14px; font-weight: 500; padding: 10px 16px; border: 1px solid transparent; cursor: pointer; transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, border-color 0.2s ease; }
    .btn:disabled,
    .btn-primary:disabled,
    .btn-secondary:disabled,
    .btn-outline:disabled,
    .btn-link:disabled,
    .btn-icon:disabled,
    .btn-danger:disabled { opacity: 0.6; cursor: not-allowed; box-shadow: none; transform: none; }
    .btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); box-shadow: var(--shadow-sm); }
    .btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); box-shadow: var(--shadow-md); transform: translateY(-1px); }
    .btn-secondary { background: var(--surface-muted); color: var(--text-color); border: 1px solid var(--border-color); }
    .btn-secondary:hover { background: #edf1f7; border-color: var(--border-strong); }
    .btn-outline { background: transparent; color: var(--primary); border: 1px solid rgba(79, 70, 229, 0.45); }
    .btn-outline:hover { background: var(--primary-light); }
    .btn-link { background: transparent; color: var(--primary); border: none; padding: 0; }
    .btn-link:hover { color: var(--primary-hover); }
    .btn-icon { width: 40px; min-width: 40px; height: 40px; padding: 0; border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-color); color: var(--text-secondary); box-shadow: var(--shadow-sm); }
    .btn-icon:hover { color: var(--primary); border-color: rgba(79, 70, 229, 0.45); }
    .btn-danger { background: #dc2626; border-color: #dc2626; color: #fff; }
    .btn-danger:hover { background: #b91c1c; border-color: #b91c1c; }
    .btn svg { width: 16px; height: 16px; }
    .btn-interactive { position: relative; overflow: hidden; }
    .btn-interactive:focus-visible { outline: 2px solid rgba(79, 70, 229, 0.45); outline-offset: 2px; }
    .btn-ripple { position: absolute; pointer-events: none; border-radius: 999px; transform: scale(0); opacity: 0.3; background: rgba(255, 255, 255, 0.6); }
    .btn-ripple.is-active { animation: ripple-expand 500ms ease-out forwards; }
    .queue-progress {
      margin: 20px -24px 0;
      padding: 16px 24px 0;
      border-top: 1px solid var(--border-color);
    }
    .queue-progress-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      font-size: 14px;
      color: var(--text-secondary);
      font-weight: 500;
    }
    .queue-label { font-size: 14px; color: var(--text-secondary); }
    .queue-percent { font-size: 14px; color: var(--text-secondary); font-weight: 600; }
    .queue-bar { width: 100%; height: 6px; border-radius: 999px; background: #e2e8f0; overflow: hidden; position: relative; }
    .queue-fill { height: 100%; width: 0; border-radius: inherit; background: linear-gradient(90deg, #4338ca, #4f46e5); transition: width 0.4s ease; }
    .queue-list { margin-top: 16px; display: flex; flex-direction: column; gap: 14px; }
    .queue-item {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 14px 16px;
      border-radius: 12px;
      background: var(--surface-color);
      border: 1px solid var(--border-color);
      box-shadow: var(--shadow-sm);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      width: 100%;
      box-sizing: border-box;
    }
    .queue-item:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); }
    .queue-item .info { flex: 1; min-width: 0; }
    .queue-item .title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .queue-item .meta { font-size: 12px; color: var(--text-secondary); margin-top: 4px; overflow-wrap: anywhere; word-break: break-word; }
    .queue-item .percent { font-size: 13px; color: var(--primary); font-weight: 600; }
    .recent-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin: 18px -24px 0;
      padding: 16px 24px 0;
      border-top: 1px solid var(--border-color);
    }
    .recent-card {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px;
      border-radius: 12px;
      background: var(--surface-color);
      border: 1px solid var(--border-color);
      box-shadow: var(--shadow-sm);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      width: 100%;
      box-sizing: border-box;
    }
    .recent-card:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); }
    .task-actions { display: flex; justify-content: flex-end; position: relative; overflow: visible; }
    .task-actions .actions-inline { display: flex; gap: 8px; }
    .task-actions .actions-compact { display: none; position: relative; align-items: center; }
    .task-actions .task-actions-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: var(--surface-color);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      box-shadow: var(--shadow-md);
      padding: 10px;
      display: none;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      min-width: 200px;
      max-width: min(260px, calc(100vw - 48px));
      z-index: 120;
      opacity: 0;
      transform: translate3d(0, 6px, 0);
      transition: transform 0.2s ease, opacity 0.2s ease;
    }
    .task-actions .task-actions-menu.is-open {
      display: flex;
      opacity: 1;
      transform: translate3d(0, 0, 0);
    }
    .task-menu-item {
      width: 100%;
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      font-size: 14px;
      padding: 10px 12px;
      border-radius: 10px;
      border: none;
      background: transparent;
      color: var(--text-color);
    }
    .task-menu-item:hover { background: var(--surface-muted); color: var(--primary); }
    .recent-card img { width: 54px; height: 54px; border-radius: 10px; object-fit: cover; }
    .recent-card .info { flex: 1; min-width: 0; }
    .recent-card .info h4 {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-color);
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      line-height: 1.4;
      word-break: break-word;
    }
    .recent-card .info p {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      word-break: break-word;
    }
    .recent-card .size { font-size: 12px; color: var(--text-secondary); }
    .empty-state { font-size: 13px; color: var(--text-secondary); text-align: center; padding: 12px 0; }
    .table-empty { text-align: center; padding: 24px 0; }
    .task-table-wrapper { margin-top: 16px; overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; -webkit-overflow-scrolling: touch; }
    .task-table-wrapper::-webkit-scrollbar { height: 8px; }
    .task-table-wrapper::-webkit-scrollbar-track { background: transparent; }
    .task-table-wrapper::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.45); border-radius: 999px; }
    .task-table-wrapper::-webkit-scrollbar-thumb:hover { background: rgba(99, 102, 241, 0.45); }
    .task-table-wrapper .data-table { min-width: 720px; }
    .data-table { width: 100%; border-collapse: collapse; font-size: 13px; color: var(--text-color); }
    .data-table thead { background: var(--surface-muted); text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-secondary); }
    .data-table th { font-weight: 600; }
    .data-table th, .data-table td { padding: 14px 16px; text-align: left; border-bottom: 1px solid var(--border-color); }
    .data-table tbody tr:hover { background: var(--surface-muted); }
    .data-table .text-right { text-align: right; }
    .task-toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .toolbar-input { min-width: 200px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-color); color: var(--text-color); height: 43px; line-height: 1.4; box-sizing: border-box; }
    .toolbar-input::placeholder { color: var(--text-secondary); }
    .select-control { position: relative; display: inline-flex; align-items: center; min-width: 160px; }
    .form-group .select-control { width: 100%; }
    .toolbar-select, .toggle-menu { display: none; }
    .dropdown-toggle { display: inline-flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 160px; height: 43px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-color); color: var(--text-color); font-weight: 500; cursor: pointer; box-shadow: var(--shadow-sm); transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease; width: 100%; }
    .dropdown-toggle:hover { border-color: var(--border-strong); background: var(--surface-muted); }
    .dropdown-toggle:focus-visible { outline: none; border-color: rgba(79, 70, 229, 0.55); box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.18); }
    .dropdown-toggle svg { width: 16px; height: 16px; color: #4f46e5; }
    .dropdown { position: relative; }
    .dropdown-menu { position: absolute; top: calc(100% + 6px); right: 0; min-width: 160px; border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-color); box-shadow: var(--shadow-md); padding: 8px; display: flex; flex-direction: column; gap: 4px; opacity: 0; transform: translateY(6px); pointer-events: none; transition: opacity 0.2s ease, transform 0.2s ease; z-index: 1700; }
    .dropdown.is-open .dropdown-menu { opacity: 1; transform: translateY(0); pointer-events: auto; }
    .dropdown-item { display: flex; align-items: center; gap: 8px; justify-content: flex-start; padding: 8px 12px; border-radius: 8px; border: none; background: transparent; color: var(--text-color); font-size: 14px; cursor: pointer; }
    .dropdown-item:hover { background: var(--surface-muted); color: var(--primary); }
    .dropdown-item.is-active { background: var(--primary-light); color: var(--primary); font-weight: 600; }
    .config-grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); margin-top: 24px; align-items: stretch; }
    .config-card { background: var(--surface-color); border: 1px solid var(--border-color); border-radius: 14px; padding: 22px 24px; display: flex; flex-direction: column; gap: 16px; box-shadow: var(--shadow-sm); }
    .config-card-full { grid-column: 1 / -1; }
    .config-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; color: var(--text-color); }
    .config-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-secondary); }
    .config-field input, .config-field textarea, .config-field select { border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-color); padding: 10px 14px; color: var(--text-color); resize: vertical; box-sizing: border-box; }
    .config-field input::placeholder, .config-field textarea::placeholder { color: rgba(100, 116, 139, 0.7); }
    .config-field select { -webkit-appearance: none; -moz-appearance: none; appearance: none; padding-right: 40px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2362748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; background-size: 16px; }
    .config-field select::-ms-expand { display: none; }
    .config-field textarea.font-mono { font-family: 'Fira Code', 'Courier New', monospace; min-height: 100px; }
    .config-switch { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 13px; background: var(--surface-muted); padding: 10px 14px; border-radius: 10px; border: 1px solid var(--border-color); color: var(--text-color); }
    .config-grid-two { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .config-grid-pairs { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .config-image-grid { display: grid; grid-template-columns: auto 1fr; gap: 18px; align-items: start; }
    .config-image-inputs, .config-image-headers { display: flex; flex-direction: column; gap: 12px; }
    .config-image-inputs { align-items: flex-start; }
    .config-image-inputs .config-field { width: 100%; max-width: 220px; }
    .config-image-inputs .config-field input { width: 100%; }
    .config-image-headers .config-field textarea { width: 100%; min-height: 140px; }
    @media (max-width: 768px) {
      .config-image-grid { grid-template-columns: 1fr; }
      .config-image-inputs .config-field { max-width: none; }
    }
    .config-hint { font-size: 12px; color: rgba(148, 163, 184, 0.6); }
    .settings-page-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 20px; margin-bottom: 24px; }
    .settings-page-header .header-info h2 { margin: 0; font-size: 24px; font-weight: 700; color: var(--text-color); }
    .settings-page-header .header-info p { margin: 8px 0 0; font-size: 14px; color: var(--text-secondary); line-height: 1.6; }
    .settings-page-header .header-actions { display: flex; gap: 12px; flex-wrap: wrap; }
    .settings-form { display: flex; flex-direction: column; gap: 24px; }
    .settings-card { background: var(--surface-color); border: 1px solid var(--border-color); border-radius: 14px; padding: 24px; box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 18px; transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease; }
    .settings-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); border-color: rgba(79, 70, 229, 0.35); }
    .settings-card h3 { margin: 0; font-size: 18px; font-weight: 600; color: var(--text-color); }
    .settings-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    .settings-grid.grid-span-2 { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
    .settings-grid .full-span { grid-column: 1 / -1; }
    .form-group { display: flex; flex-direction: column; gap: 8px; }
    .form-group label, .form-group .form-label { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
    .form-input, .form-textarea { width: 100%; border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-color); padding: 10px 14px; color: var(--text-color); font-size: 14px; box-sizing: border-box; transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease; }
    .form-select { width: 100%; border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-color); padding: 10px 14px; color: var(--text-color); font-size: 14px; box-sizing: border-box; transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease; }
    .form-input:focus, .form-select:focus, .form-textarea:focus { outline: none; border-color: rgba(79, 70, 229, 0.55); box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.18); background: #fff; }
    .form-textarea { min-height: 120px; resize: vertical; }
    .form-textarea.font-mono { font-family: 'Fira Code', 'Courier New', monospace; }
    .settings-meta-group { display: flex; flex-direction: column; gap: 4px; }
    .settings-meta { font-size: 12px; color: rgba(148, 163, 184, 0.7); }
    .toggle-row { display: flex; justify-content: space-between; align-items: center; padding: 14px; border-radius: 12px; border: 1px solid var(--border-color); background: var(--surface-muted); gap: 16px; }
    .toggle-row .label-group { display: flex; flex-direction: column; gap: 6px; }
    .toggle-row .label-group label { font-size: 14px; font-weight: 600; color: var(--text-color); }
    .toggle-row .setting-description { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .download-root .toggle-switch::after { display: none !important; content: none !important; }
    .toggle-switch { position: relative; display: inline-flex; align-items: center; width: 48px; height: 26px; flex-shrink: 0; cursor: pointer; }
    .toggle-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
    .toggle-switch .slider { position: absolute; inset: 0; background: rgba(148, 163, 184, 0.45); border-radius: 999px; transition: background 0.25s ease, box-shadow 0.25s ease; }
    .toggle-switch .slider::before { content: ''; position: absolute; width: 22px; height: 22px; left: 2px; top: 2px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(15, 23, 42, 0.2); transition: transform 0.25s ease; }
    .toggle-switch input:checked + .slider { background: linear-gradient(90deg, #6366f1 0%, #4f46e5 100%); box-shadow: 0 6px 14px rgba(79, 70, 229, 0.18); }
    .toggle-switch input:checked + .slider::before { transform: translateX(22px); }
    .toggle-switch input:focus-visible + .slider { box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.2); }
    /* Download page now reuses global notification styles */
    .feed-grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-top: 24px; }
    .config-footer { position: fixed; bottom: 0; left: 264px; right: 0; background: var(--bg-color); padding: 16px 32px calc(16px + env(safe-area-inset-bottom, 20px)); display: flex; justify-content: stretch; z-index: 15; }
    .config-footer-card { width: 100%; padding: 18px 32px calc(18px + env(safe-area-inset-bottom, 0)); background: var(--surface-color); border: 1px solid var(--border-color); border-radius: 14px; display: flex; align-items: center; justify-content: space-between; gap: 16px; box-shadow: var(--shadow-sm); }
    .config-footer-card h4 { margin: 0; font-size: 16px; font-weight: 600; color: var(--text-color); }
    .config-footer-meta { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-secondary); flex: 1; }
    .config-footer-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
    .config-footer-actions > * { flex: 0 0 auto; }
    .config-action-btn { display: inline-flex; align-items: center; gap: 8px; }
    .config-action-btn svg { width: 18px; height: 18px; }
    .config-action-btn span { display: inline-flex; align-items: center; }
    .feed-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; padding: 6px 12px; background: var(--surface-muted); border: 1px solid var(--border-color); border-radius: 12px; box-shadow: var(--shadow-sm); }
    .feed-toolbar-left { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text-secondary); }
    .feed-toolbar-left input { width: 16px; height: 16px; }
    .feed-toolbar-actions { display: inline-flex; align-items: center; gap: 10px; }
    .feed-toolbar .bulk-disabled { opacity: 0.4; pointer-events: none; }
    .feed-card { border-radius: 14px; padding: 20px 20px 20px 52px; background: var(--surface-color); border: 1px solid var(--border-color); position: relative; display: flex; flex-direction: column; gap: 12px; box-shadow: var(--shadow-sm); transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease; }
    .feed-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); border-color: rgba(79, 70, 229, 0.28); }
    .feed-card .feed-select { position: absolute; top: 16px; left: 16px; }
    .feed-card.has-selection { border-color: rgba(79,70,229,0.45); box-shadow: 0 10px 30px rgba(79,70,229,0.15); }
    .feed-card .card-header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .feed-card .card-header > div:first-child { flex: 1; min-width: 0; }
    .feed-card .feed-title { font-size: 16px; font-weight: 600; color: var(--text-color); line-height: 1.5; word-break: break-word; }
    .feed-card .feed-url { font-size: 12px; color: var(--text-secondary); word-break: break-all; }
    .feed-card .feed-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--text-secondary); }
    .feed-card .feed-actions { display: flex; gap: 8px; margin-top: auto; }
    .history-list { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-top: 24px; }
    .history-card { border-radius: 14px; padding: 16px; background: var(--surface-color); border: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-sm); transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease; }
    .history-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-md); border-color: rgba(79, 70, 229, 0.28); }
    .history-card h4 { font-size: 15px; font-weight: 600; color: var(--text-color); }
    .history-card .history-meta { font-size: 12px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 4px; }
    .log-container { margin-top: 24px; border-radius: 14px; border: 1px solid var(--border-color); background: var(--surface-color); padding: 20px; max-height: none; overflow-y: visible; box-shadow: var(--shadow-sm); }
    .log-entry { padding: 14px; border-radius: 12px; border: 1px solid var(--border-color); background: var(--surface-muted); margin-bottom: 12px; transition: border-color 0.2s ease, background 0.2s ease; }
    .log-entry:last-child { margin-bottom: 0; }
    .log-entry.level-info .log-level { color: #2563eb; }
    .log-entry.level-success { border-color: rgba(34, 197, 94, 0.35); background: rgba(16, 185, 129, 0.12); }
    .log-entry.level-success .log-level { color: #15803d; }
    .log-entry.level-warning { border-color: rgba(250, 204, 21, 0.45); background: rgba(250, 204, 21, 0.16); }
    .log-entry.level-warning .log-level { color: #b45309; }
    .log-entry.level-error { border-color: rgba(248, 113, 113, 0.45); background: rgba(248, 113, 113, 0.16); }
    .log-entry.level-error .log-level { color: #b91c1c; }
    .log-entry .log-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 12px; color: var(--text-secondary); }
    .log-entry .log-level { font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    .log-entry .log-message { font-size: 13px; color: var(--text-color); display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
    .log-entry .log-scope { font-weight: 600; color: var(--primary); margin-right: 4px; }
    .log-entry .log-text { flex: 1; min-width: 0; word-break: break-word; }
    .log-entry .log-details { margin-top: 6px; font-size: 12px; color: var(--text-secondary); display: flex; flex-wrap: wrap; gap: 8px; }
    .log-entry .log-details span { display: inline-flex; align-items: center; }
    .log-entry .log-details .log-divider { opacity: 0.5; }
    .log-entry .log-empty { opacity: 0.6; }
    .loading-panel { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 80px 0; }
    .loading-panel .spinner { width: 24px; height: 24px; border: 3px solid rgba(148, 163, 184, 0.45); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; }
    .error-panel { padding: 16px; border-radius: 12px; background: rgba(254, 226, 226, 0.8); border: 1px solid rgba(248, 113, 113, 0.6); color: #b91c1c; text-align: center; }
    .btn-link, .btn-outline, .btn-primary, .btn-secondary { cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
    .btn-primary svg, .btn-secondary svg, .btn-outline svg, .btn-link svg { width: 18px; height: 18px; }
    .task-status { display: inline-flex; align-items: center; justify-content: center; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
    .task-running { background: rgba(134, 239, 172, 0.4); color: #047857; }
    .task-paused { background: rgba(191, 219, 254, 0.5); color: #1d4ed8; }
    .task-error { background: rgba(254, 202, 202, 0.7); color: #b91c1c; }
    .task-success { background: rgba(165, 180, 252, 0.6); color: #3730a3; }
    .task-default { background: rgba(226, 232, 240, 0.8); color: var(--text-secondary); }
    .feed-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: var(--primary-light); color: var(--primary); font-size: 11px; }
    .preview-grid { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; padding-right: 4px; }
    .preview-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto auto; align-items: center; gap: 14px; padding: 12px 16px; border-radius: 12px; background: var(--surface-muted); border: 1px solid var(--border-color); }
    .preview-item span { font-size: 12px; color: var(--text-secondary); word-break: break-word; }
    .preview-item > :nth-child(2) { min-width: 0; }
    .preview-checkbox { width: 18px; height: 18px; }
    .preview-summary { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 12px; margin-bottom: 12px; padding: 0 16px; font-size: 13px; color: var(--text-secondary); }
    .preview-select-all { display: grid; grid-template-columns: auto auto; align-items: center; gap: 8px; font-size: 13px; color: var(--primary); }
    .preview-select-all .preview-checkbox { margin: 0; justify-self: center; }
    .preview-count { font-size: 13px; color: var(--text-secondary); }
    .preview-filter-group { display: flex; gap: 8px; }
    .preview-actions { display: flex; gap: 12px; justify-content: flex-end; align-items: center; margin-top: 16px; padding: 0 6px; }
    .preview-download-action { transition: background 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease; }
    .preview-download-action.is-active { background: rgba(187, 247, 208, 0.7); color: #166534; border-color: rgba(16, 185, 129, 0.4); box-shadow: 0 4px 12px rgba(16, 185, 129, 0.18); }
    .preview-download-action.is-active svg { color: #166534; }
    .panel-actions.feeds-controls { gap: 12px; }
    .panel-actions.feeds-controls .feed-search { min-width: 220px; }
    .panel-actions.feeds-controls .btn-outline,
    .panel-actions.feeds-controls .btn-primary { flex-shrink: 0; }
    .preview-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .preview-title { font-size: 13px; font-weight: 600; color: var(--text-color); }
    .preview-status { font-size: 12px; padding: 6px 12px; border-radius: 999px; font-weight: 600; text-align: center; min-width: 76px; }
    .preview-status.is-completed { background: rgba(187, 247, 208, 0.7); color: #166534; }
    .preview-status.is-pending { background: rgba(254, 202, 202, 0.7); color: #b91c1c; }
    .preview-time { font-size: 12px; color: var(--text-secondary); min-width: 110px; text-align: right; }
    .preview-actions-cell { display: flex; justify-content: flex-end; }
    .download-modal-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.25); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 1600; }
    .download-modal { width: min(560px, 100%); border-radius: 16px; background: var(--surface-color); border: 1px solid var(--border-color); box-shadow: var(--shadow-lg); padding: 24px; display: flex; flex-direction: column; gap: 18px; max-height: calc(100vh - 64px); overflow: visible; }
    .download-modal.modal-preview { width: min(1040px, 96vw); }
    .download-modal.modal-task { width: min(860px, 96vw); }
    .download-modal.modal-preview .modal-body,
    .download-modal.modal-task .modal-body { max-height: calc(100vh - 220px); overflow-y: auto; }
    .download-modal.modal-preview .modal-body { flex: 1; }
    .download-modal header { display: flex; justify-content: space-between; align-items: center; }
    .download-modal header h3 { font-size: 18px; font-weight: 600; color: var(--text-color); }
    .download-modal .modal-close { border: none; background: var(--primary-light); color: var(--primary); width: 32px; height: 32px; border-radius: 10px; font-size: 18px; display: inline-flex; align-items: center; justify-content: center; }
    .download-modal .modal-close:hover { background: rgba(79, 70, 229, 0.18); }
    .download-modal .modal-body { display: flex; flex-direction: column; gap: 14px; overflow: visible; }
    .field-group { display: flex; flex-direction: column; gap: 8px; }
    .field-label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); font-weight: 500; }
    .form-control { border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-muted); padding: 10px 14px; color: var(--text-color); box-sizing: border-box; }
    .form-control:focus { outline: none; border-color: rgba(79, 70, 229, 0.4); box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.2); }
    textarea.form-control { resize: vertical; min-height: 96px; }
    .form-help { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; background: var(--primary-light); color: var(--primary); font-size: 12px; font-weight: 600; cursor: pointer; }
    .form-help-bubble { position: fixed; left: 0; top: 0; transform: scale(0.95); transform-origin: center left; min-width: 220px; max-width: 320px; padding: 10px 14px; border-radius: 12px; background: var(--surface-color); color: var(--text-color); font-size: 12px; line-height: 1.5; box-shadow: var(--shadow-md); border: 1px solid var(--border-color); opacity: 0; pointer-events: none; transition: opacity 0.15s ease, transform 0.15s ease; z-index: 1600; visibility: hidden; }
    .form-help-bubble::after { content: ''; position: absolute; top: 50%; transform: translateY(-50%); border-width: 8px; border-style: solid; }
    .form-help-bubble[data-side="right"] { transform-origin: center left; }
    .form-help-bubble[data-side="right"]::after { right: 100%; border-color: transparent var(--surface-color) transparent transparent; }
    .form-help-bubble[data-side="left"] { transform-origin: center right; }
    .form-help-bubble[data-side="left"]::after { left: 100%; border-color: transparent transparent transparent var(--surface-color); }
    .form-help-bubble.is-visible { opacity: 1; transform: scale(1); pointer-events: auto; visibility: visible; }
    .form-help-bubble code { background: var(--surface-muted); padding: 2px 6px; border-radius: 6px; font-family: 'Fira Code', 'Courier New', monospace; color: var(--primary); }
    .download-modal .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-secondary); }
    .download-modal .field input,
    .download-modal .field textarea,
    .download-modal .field select { border-radius: 10px; border: 1px solid var(--border-color); background: var(--surface-muted); padding: 10px 14px; color: var(--text-color); box-sizing: border-box; }
    .download-modal .field select { -webkit-appearance: none; -moz-appearance: none; appearance: none; padding-right: 40px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2362748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; background-size: 16px; }
    .download-modal .field select::-ms-expand { display: none; }
    .download-modal .field textarea { resize: vertical; min-height: 90px; }
    .task-form-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 16px; }
    .task-form-grid .col-12 { grid-column: span 12; }
    .task-form-grid .col-8 { grid-column: span 8; }
    .task-form-grid .col-4 { grid-column: span 4; }
    .task-form-grid .col-9 { grid-column: span 9; }
    .task-form-grid .col-3 { grid-column: span 3; }
    .task-form-grid .col-6 { grid-column: span 6; }
    .task-form-grid .config-switch { grid-column: span 12; }
    .download-modal footer { display: flex; justify-content: flex-end; gap: 12px; }
    .download-modal footer .btn-secondary,
    .download-modal footer .btn-primary,
    .download-modal footer .btn-danger { justify-content: center; }
    .download-modal .modal-description { font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
    .download-modal .modal-error { font-size: 13px; color: #b91c1c; }
    .btn-secondary.is-active { background: var(--primary-light); color: var(--primary); }
    .modal-hint { font-size: 12px; color: var(--text-secondary); }
    .download-sidebar, .sidebar-nav, .download-body, .download-modal, .preview-grid {
      scrollbar-width: thin;
      scrollbar-color: rgba(148, 163, 184, 0.6) transparent;
    }
    .download-sidebar::-webkit-scrollbar, .sidebar-nav::-webkit-scrollbar, .download-body::-webkit-scrollbar,
    .download-modal::-webkit-scrollbar, .preview-grid::-webkit-scrollbar {
      width: 8px;
      height: 8px;
      background-color: transparent;
    }
    .download-sidebar::-webkit-scrollbar-thumb, .sidebar-nav::-webkit-scrollbar-thumb, .download-body::-webkit-scrollbar-thumb,
    .download-modal::-webkit-scrollbar-thumb, .preview-grid::-webkit-scrollbar-thumb {
      background: rgba(148, 163, 184, 0.6);
      border-radius: 999px;
    }
    .download-sidebar::-webkit-scrollbar-thumb:hover, .sidebar-nav::-webkit-scrollbar-thumb:hover, .download-body::-webkit-scrollbar-thumb:hover,
    .download-modal::-webkit-scrollbar-thumb:hover, .preview-grid::-webkit-scrollbar-thumb:hover {
      background: rgba(79, 70, 229, 0.6);
    }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes skeleton-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    @keyframes fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 1280px) {
      .download-shell { flex-direction: row; }
      .metric-value { font-size: 20px; }
    }
    @media (max-width: 1024px) {
      .download-shell { flex-direction: column; }
      .two-column { grid-template-columns: 1fr; }
      .download-sidebar { position: fixed; top: 0; right: auto; bottom: 0; left: 0; max-width: 320px; width: min(88vw, 320px); transform: translateX(-100%); border-radius: 0; box-shadow: none; background: var(--surface-color); border-right: 1px solid var(--border-color); z-index: 40; pointer-events: none; }
      .download-sidebar.is-open { transform: translateX(0); box-shadow: 12px 0 40px rgba(15, 23, 42, 0.18); pointer-events: auto; }
      .sidebar-close { display: inline-flex; align-items: center; justify-content: center; }
      .sidebar-toggle { display: inline-flex; }
      .download-body { padding: 24px 20px calc(160px + env(safe-area-inset-bottom, 20px)); }
      .metrics-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
      .download-modal.modal-preview { width: min(92vw, 100%); }
      .download-modal.modal-task { width: min(88vw, 100%); }
      .task-actions { justify-content: flex-start; }
      .task-actions .actions-inline { display: none; }
      .task-actions .actions-compact { display: inline-flex; align-items: center; gap: 8px; }
      .queue-progress { margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--border-color); }
      .queue-list { margin-top: 16px; }
      .recent-list { margin: 18px 0 0; padding: 16px 0 0; border-top: 1px solid var(--border-color); }
      .config-footer { left: 0; padding: 16px 20px calc(16px + env(safe-area-inset-bottom, 20px)); }
      .config-footer-card { flex-direction: column; align-items: stretch; gap: 14px; padding: 18px 20px; }
      .config-footer-actions { width: 100%; justify-content: center; }
      .config-footer-actions > * { flex: 1 1 48%; min-width: 160px; }
      .feed-card { padding: 18px 18px 18px 48px; }
      .feed-card .card-header { flex-direction: column; align-items: stretch; gap: 8px; }
      .config-action-btn { justify-content: center; padding: 10px 14px; }
      .config-action-btn span { display: none; }
    }
    @media (max-width: 768px) {
      .download-shell { min-height: 100vh; border-radius: 0; }
      .download-modal.modal-fullscreen-mobile { width: 100%; height: 100%; max-height: none; padding: 20px 18px; }
      .download-modal.modal-fullscreen-mobile .modal-body { flex: 1; overflow-y: auto; max-height: none; }
      .task-form-grid { grid-template-columns: 1fr; }
      .task-form-grid .col-8,
      .task-form-grid .col-4,
      .task-form-grid .col-9,
      .task-form-grid .col-3,
      .task-form-grid .col-6,
      .task-form-grid .col-12 { grid-column: span 1; }
      .config-grid-pairs { grid-template-columns: 1fr; }
      .config-image-grid { grid-template-columns: 1fr; }
      .settings-grid { grid-template-columns: 1fr; }
      .settings-page-header { flex-direction: column; align-items: flex-start; }
      .settings-page-header .header-actions { width: 100%; justify-content: flex-start; }
      .panel-actions.feeds-controls { flex-direction: column; align-items: stretch; gap: 10px; }
      .panel-actions.feeds-controls .feed-search { width: 100%; }
      .download-modal.modal-preview { width: 100%; height: 100%; max-height: none; border-radius: 0; padding: 20px 16px; overflow: hidden; }
      .download-modal.modal-preview .modal-body { flex: 1; max-height: none; overflow-y: auto; padding-right: 2px; }
      .preview-grid { padding-right: 0; }
      .preview-item { grid-template-columns: auto 1fr; grid-template-rows: auto auto auto; align-items: flex-start; gap: 10px; padding: 14px; }
      .preview-item > :nth-child(1) { grid-row: 1 / span 3; }
      .preview-item > :nth-child(2) { grid-column: 2; grid-row: 1; }
      .preview-item > :nth-child(3) { grid-column: 2; grid-row: 2; justify-self: flex-start; }
      .preview-item > :nth-child(4) { grid-column: 2; grid-row: 2; justify-self: flex-end; text-align: right; }
      .preview-item > :nth-child(5) { grid-column: 2; grid-row: 3; justify-self: flex-end; display: flex; }
    .preview-actions { flex-direction: row; align-items: center; justify-content: flex-end; gap: 10px; padding: 12px 0 0; }
    .preview-actions > div { width: auto; display: flex; gap: 10px; }
    .preview-actions > div:first-child button { flex: 0 0 auto; }
    .preview-actions > div:last-child { justify-content: flex-end; }
      .config-footer-card { padding: 18px; }
      .config-footer-actions { gap: 10px; }
      .config-footer-actions > * { flex: 1 1 48%; min-width: 0; }
    }
    @media (max-width: 640px) {
      .sidebar-toggle { margin-bottom: 18px; }
      .download-body { padding: 24px 16px calc(180px + env(safe-area-inset-bottom, 20px)); }
      .panel { padding: 20px 18px; }
      .panel-header { gap: 12px; }
      .task-toolbar { flex-direction: column; align-items: stretch; }
      .toolbar-input, .select-control { width: 100%; min-width: 0; }
      .select-control .dropdown-toggle { width: 100%; min-width: 0; }
      .panel-actions { width: 100%; justify-content: space-between; }
      .panel-actions.compact { justify-content: flex-end; }
      .queue-progress { margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--border-color); }
      .queue-list { margin-top: 16px; }
      .queue-item { flex-direction: column; align-items: flex-start; gap: 12px; width: 100%; }
      .queue-item .percent { align-self: flex-start; }
      .recent-list { margin: 18px 0 0; padding: 16px 0 0; border-top: 1px solid var(--border-color); }
      .recent-card { flex-direction: column; align-items: flex-start; width: 100%; }
      .config-footer { padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 20px)); }
      .config-footer-card { padding: 16px; }
      .config-footer-actions { gap: 10px; flex-wrap: nowrap; }
      .config-footer-actions > * { flex: 1 1 auto; min-width: 0; }
      .config-action-btn { justify-content: center; }
      .feed-grid { gap: 14px; }
      .feed-card { padding: 18px 16px 18px 46px; }
      .feed-card .feed-actions { margin-top: 4px; flex-wrap: wrap; }
    }
    @media (max-width: 600px) {
      .download-body { padding: 20px 14px calc(200px + env(safe-area-inset-bottom, 20px)); }
      .panel { padding: 18px; border-radius: 16px; }
      .panel-header { gap: 12px; }
      .panel-actions { width: 100%; justify-content: space-between; }
      .task-toolbar { flex-direction: column; align-items: stretch; }
      .dropdown { width: 100%; }
      .dropdown-menu { left: 0; right: 0; min-width: 100%; }
      .config-grid { grid-template-columns: 1fr; }
      .feed-grid { grid-template-columns: 1fr; }
      .history-list { grid-template-columns: 1fr; }
      .config-footer { padding: 16px 14px calc(16px + env(safe-area-inset-bottom, 20px)); }
      .config-footer-card { padding: 14px; }
      .config-footer-actions { gap: 8px; flex-wrap: nowrap; justify-content: space-between; }
      .config-footer-actions > * { flex: 1 1 0; min-width: 0; }
      .config-action-btn { min-height: 44px; }
      .feed-card { padding: 16px 14px 16px 42px; gap: 10px; }
      .feed-card .card-header { gap: 6px; }
      .feed-card .feed-actions { gap: 6px; }
      .feed-card .feed-title { font-size: 15px; }
    }
  `;
  document.head.appendChild(style);
}

function removeStyleHelpers() {
  const style = document.getElementById('download-style-helpers');
  if (style && style.parentNode) {
    style.parentNode.removeChild(style);
  }
}

const TEMPLATE = `
  <div id="download-root" class="download-root hidden">
    <div class="download-shell">
      <aside class="download-sidebar" data-role="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-title">
            <div>
              <p class="sidebar-name">图片下载服务</p>
              <p class="sidebar-hint">RSS 控制台</p>
            </div>
          </div>
          <button class="sidebar-close" data-action="close-sidebar" aria-label="关闭菜单">${iconClose()}</button>
        </div>
        <div class="sidebar-scroll">
          <nav class="sidebar-nav" data-role="download-nav" role="navigation" aria-label="下载控制台页面导航">
              <button class="nav-item active" data-page="dashboard"><span class="nav-icon">${iconChartBar()}</span><span>仪表盘</span></button>
              <button class="nav-item" data-page="config"><span class="nav-icon">${iconSettings()}</span><span>配置管理</span></button>
              <button class="nav-item" data-page="feeds"><span class="nav-icon">${iconRss()}</span><span>RSS 源管理</span></button>
              <button class="nav-item" data-page="history"><span class="nav-icon">${iconDownload()}</span><span>下载历史</span></button>
              <button class="nav-item" data-page="logs"><span class="nav-icon">${iconFileText()}</span><span>运行日志</span></button>
          </nav>
        </div>
        <div class="sidebar-footer">
          <button class="btn-outline" data-action="back-home">返回首页</button>
        </div>
      </aside>
      <section class="download-content">
        <div class="download-body" id="download-main" tabindex="-1">
          <button class="sidebar-toggle" data-action="open-sidebar" aria-label="打开菜单" aria-expanded="false"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path fill-rule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"></path></svg></button>
          <div data-role="download-loading" class="hidden" role="status" aria-live="polite"><div class="loading-panel"><div class="spinner"></div><span>加载中...</span></div></div>
          <div data-role="download-error" class="hidden" role="alert" aria-live="assertive"><div class="error-panel">加载失败，请稍后重试。</div></div>

          <div data-page-container="dashboard" class="download-page">
            <section class="section">
              <div class="metrics-grid">
                <article class="metric-card">
                  <p class="metric-label">订阅任务</p>
                  <p class="metric-value" data-metric="tasks">-</p>
                  <p class="metric-desc">总任务数 / 激活任务</p>
                  <div class="metric-trend" data-trend="tasks"></div>
                </article>
                <article class="metric-card">
                  <p class="metric-label">已下载文章</p>
                  <p class="metric-value" data-metric="articles">-</p>
                  <p class="metric-desc">累计文章数量</p>
                  <div class="metric-trend" data-trend="articles"></div>
                </article>
                <article class="metric-card">
                  <p class="metric-label">已下载图片</p>
                  <p class="metric-value" data-metric="images">-</p>
                  <p class="metric-desc">累计图片数量</p>
                  <div class="metric-trend" data-trend="images"></div>
                </article>
                <article class="metric-card">
                  <p class="metric-label">存储占用</p>
                  <p class="metric-value" data-metric="storage">-</p>
                  <p class="metric-desc">历史下载总大小</p>
                  <div class="metric-trend" data-trend="storage"></div>
                </article>
              </div>
            </section>

            <section class="section two-column">
              <article class="panel">
                <div class="panel-header">
                  <h3 class="panel-title">下载队列</h3>
                  <button class="btn-link" data-action="view-tasks"><span>查看全部</span></button>
                </div>
                <div class="queue-progress">
                  <div class="queue-progress-header">
                    <span class="queue-label" data-role="queue-progress-label">0 / 0 运行中</span>
                    <span class="queue-percent" data-role="queue-progress-percent">0%</span>
                  </div>
                  <div class="queue-bar"><div class="queue-fill" data-role="queue-progress"></div></div>
                </div>
                <ul class="queue-list" data-role="queue-list"></ul>
              </article>

              <article class="panel">
                <div class="panel-header">
                  <h3 class="panel-title">最近下载</h3>
                  <button class="btn-link" data-action="open-history">${iconEye()}<span>查看全部</span></button>
                </div>
                <ul class="recent-list" data-role="recent-list"></ul>
              </article>
            </section>

            <section class="section">
              <article class="panel">
                <div class="panel-header">
                  <div>
                    <h3 class="panel-title">订阅任务列表</h3>
                    <p class="panel-desc">管理抓取计划与运行状态</p>
                  </div>
                  <div class="task-toolbar">
                    <input type="search" class="toolbar-input" data-role="task-search" placeholder="搜索任务">
                    <div class="select-control dropdown" data-dropdown="task-filter">
                      <button type="button" class="dropdown-toggle" data-dropdown-trigger="task-filter">
                        <span data-dropdown-label>全部</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>
                      </button>
                      <select class="toolbar-select toggle-menu" data-role="task-filter">
                        <option value="all">全部</option>
                        <option value="running">运行中</option>
                        <option value="paused">已暂停</option>
                        <option value="error">异常</option>
                      </select>
                      <div class="dropdown-menu">
                        <button type="button" class="dropdown-item" data-value="all">全部</button>
                        <button type="button" class="dropdown-item" data-value="running">运行中</button>
                        <button type="button" class="dropdown-item" data-value="paused">已暂停</button>
                        <button type="button" class="dropdown-item" data-value="error">异常</button>
                      </div>
                    </div>
                    <button class="btn-primary" data-action="new-task">${iconPlus()}<span>新建任务</span></button>
                  </div>
                </div>
                <div class="task-table-wrapper">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>任务</th>
                        <th>状态</th>
                        <th>下载统计</th>
                        <th>更新周期</th>
                        <th>最近状态</th>
                        <th class="text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody data-role="task-table"></tbody>
                  </table>
                </div>
              </article>
            </section>
          </div>

          <div data-page-container="config" class="download-page hidden">
            <section class="section">
              <div class="settings-page-header">
                <div class="header-info">
                  <h2>配置管理</h2>
                  <p>调整下载服务的存储路径、并发策略与验证规则。修改后请别忘记保存配置。</p>
                </div>
              </div>

              <form class="settings-form" data-role="settings-form">
                <article class="settings-card">
                  <h3>基础路径</h3>
                  <div class="settings-grid grid-span-2">
                    <label class="form-group full-span">
                      <span class="form-label">下载根目录</span>
                      <input type="text" class="form-input" data-field="base-folder" placeholder="例如：/data/downloads">
                    </label>
                  </div>
                  <div class="settings-meta-group">
                    <p class="settings-meta" data-role="resolved-base"></p>
                    <p class="settings-meta" data-role="resolved-db"></p>
                    <p class="settings-meta" data-role="resolved-error"></p>
                  </div>
                </article>

                <article class="settings-card">
                  <h3>功能与策略</h3>
                  <div class="settings-grid grid-span-2">
                    <div class="form-group full-span">
                      <div class="toggle-row">
                        <div class="label-group">
                          <label>允许回退抓取原始页面</label>
                          <p class="setting-description">当 RSS 内容不完整时，尝试访问原始页面补全图片。</p>
                        </div>
                        <label class="toggle-switch"><input type="checkbox" data-field="allow-fallback"><span class="slider"></span></label>
                      </div>
                    </div>
                    <div class="form-group full-span">
                      <div class="toggle-row">
                        <div class="label-group">
                          <label>启用图片验证</label>
                          <p class="setting-description">依据尺寸和大小规则过滤不符合要求的图片。</p>
                        </div>
                        <label class="toggle-switch"><input type="checkbox" data-field="validation-enabled"><span class="slider"></span></label>
                      </div>
                    </div>
                    <div class="form-group full-span">
                      <div class="toggle-row">
                        <div class="label-group">
                          <label>严格模式（验证失败删除）</label>
                          <p class="setting-description">开启后，校验失败的图片会被直接删除。</p>
                        </div>
                        <label class="toggle-switch"><input type="checkbox" data-field="validation-strict"><span class="slider"></span></label>
                      </div>
                    </div>
                    <label class="form-group full-span">
                      <span class="form-label">跳过的订阅源（每行一个）</span>
                      <textarea class="form-textarea" data-field="skip-feeds" placeholder="https://example.com/rss.xml"></textarea>
                    </label>
                    <label class="form-group full-span">
                      <span class="form-label">去重策略</span>
                      <div class="select-control dropdown" data-dropdown="dedup-scope">
                        <button type="button" class="dropdown-toggle" data-dropdown-trigger="dedup-scope" aria-expanded="false" aria-haspopup="listbox">
                          <span data-dropdown-label>按链接去重（推荐）</span>
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>
                        </button>
                        <select class="form-select toggle-menu" data-field="dedup-scope">
                          <option value="by_link">按链接去重（推荐）</option>
                          <option value="per_feed">按源 + 标题去重</option>
                          <option value="global">按标题全局去重</option>
                        </select>
                        <div class="dropdown-menu" role="listbox">
                          <button type="button" class="dropdown-item" data-value="by_link">按链接去重（推荐）</button>
                          <button type="button" class="dropdown-item" data-value="per_feed">按源 + 标题去重</button>
                          <button type="button" class="dropdown-item" data-value="global">按标题全局去重</button>
                        </div>
                      </div>
                    </label>
                  </div>
                </article>

                <article class="settings-card">
                  <h3>性能与重试</h3>
                  <div class="settings-grid grid-span-2">
                    <label class="form-group">
                      <span class="form-label">最大订阅并行</span>
                      <input type="number" class="form-input" min="1" data-field="max-concurrent-feeds">
                    </label>
                    <label class="form-group">
                      <span class="form-label">每任务图片并行</span>
                      <input type="number" class="form-input" min="1" data-field="max-concurrent-downloads">
                    </label>
                    <label class="form-group">
                      <span class="form-label">请求超时 (秒)</span>
                      <input type="number" class="form-input" min="1" data-field="request-timeout">
                    </label>
                    <label class="form-group">
                      <span class="form-label">连接超时 (秒)</span>
                      <input type="number" class="form-input" min="1" data-field="connect-timeout">
                    </label>
                    <label class="form-group">
                      <span class="form-label">读取超时 (秒)</span>
                      <input type="number" class="form-input" min="1" data-field="read-timeout">
                    </label>
                    <label class="form-group">
                      <span class="form-label">重试等待 (秒)</span>
                      <input type="number" class="form-input" min="0" data-field="retry-delay">
                    </label>
                    <label class="form-group">
                      <span class="form-label">最大重试次数</span>
                      <input type="number" class="form-input" min="0" data-field="max-retries">
                    </label>
                    <label class="form-group">
                      <span class="form-label">分页最小延迟 (秒)</span>
                      <input type="number" class="form-input" min="0" step="0.1" data-field="pagination-min">
                    </label>
                    <label class="form-group">
                      <span class="form-label">分页最大延迟 (秒)</span>
                      <input type="number" class="form-input" min="0" step="0.1" data-field="pagination-max">
                    </label>
                  </div>
                </article>

                <article class="settings-card">
                  <h3>高级配置</h3>
                  <div class="settings-grid grid-span-2">
                    <label class="form-group">
                      <span class="form-label">最小大小 (Bytes)</span>
                      <input type="number" class="form-input" min="0" data-field="min-bytes">
                    </label>
                    <label class="form-group">
                      <span class="form-label">最小宽度 (px)</span>
                      <input type="number" class="form-input" min="0" data-field="min-width">
                    </label>
                    <label class="form-group">
                      <span class="form-label">最小高度 (px)</span>
                      <input type="number" class="form-input" min="0" data-field="min-height">
                    </label>
                    <label class="form-group full-span">
                      <span class="form-label">RSS 请求头 (JSON)</span>
                      <textarea class="form-textarea font-mono" data-field="request-headers" placeholder='{ "User-Agent": "..." }'></textarea>
                    </label>
                    <label class="form-group full-span">
                      <span class="form-label">图片请求头 (JSON)</span>
                      <textarea class="form-textarea font-mono" data-field="image-headers" placeholder='{ "Accept": "image/*" }'></textarea>
                    </label>
                  </div>
                  <p class="settings-meta" data-role="config-hint"></p>
                </article>
              </form>
              <div class="config-footer" data-role="config-footer">
                <div class="config-footer-card">
                  <div class="config-footer-meta">
                  </div>
                  <div class="config-footer-actions">
                    <button type="button" class="btn-secondary config-action-btn" data-action="export-config">${iconExport()}<span>导出配置</span></button>
                    <button type="button" class="btn-secondary config-action-btn" data-action="import-config">${iconImport()}<span>导入配置</span></button>
                    <button type="button" class="btn-outline config-action-btn" data-action="reload-config">${iconRefresh()}<span>同步配置</span></button>
                    <button type="button" class="btn-primary config-action-btn" data-action="save-config">${iconCircleCheck()}<span>保存配置</span></button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div data-page-container="feeds" class="download-page hidden">
            <section class="section">
              <div class="panel-header">
                <div>
                  <h3 class="panel-title">RSS 源管理</h3>
                  <p class="panel-desc">按源查看运行状态、编辑属性与预览内容</p>
                </div>
                <div class="panel-actions feeds-controls">
                  <input type="search" class="toolbar-input feed-search" data-role="feed-search" placeholder="搜索订阅源">
                  <button class="btn-outline" data-action="import-opml">${iconImport()}<span>导入 OPML</span></button>
                  <button class="btn-outline" data-action="export-opml">${iconExport()}<span>导出 OPML</span></button>
                  <button class="btn-primary" data-action="add-feed">${iconPlus()}<span>添加订阅</span></button>
                </div>
              </div>
              <div class="feed-toolbar">
                <label class="feed-toolbar-left">
                  <input type="checkbox" data-role="feed-select-all">
                  <span>全选</span>
                </label>
                <div class="feed-toolbar-actions">
                  <button class="btn-secondary btn-icon" data-action="bulk-feed-start" disabled title="批量启动">${iconPlay()}</button>
                  <button class="btn-secondary btn-icon" data-action="bulk-feed-pause" disabled title="批量暂停">${iconStop()}</button>
                  <button class="btn-secondary btn-icon" data-action="bulk-feed-delete" disabled title="批量删除">${iconClose()}</button>
                </div>
              </div>
              <div class="feed-grid" data-role="feed-grid"></div>
            </section>
          </div>

          <div data-page-container="history" class="download-page hidden">
            <section class="section">
              <div class="panel-header">
                <div>
                  <h3 class="panel-title">下载历史</h3>
                  <p class="panel-desc">按时间筛选已处理的文章与图片</p>
                </div>
                <div class="panel-actions compact">
                  <input type="search" class="toolbar-input" data-role="history-search" placeholder="搜索文件或来源">
                  <div class="select-control dropdown" data-dropdown="history-filter">
                    <button type="button" class="dropdown-toggle" data-dropdown-trigger="history-filter">
                      <span data-dropdown-label>最近</span>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>
                    </button>
                    <select class="toolbar-select toggle-menu" data-role="history-filter">
                      <option value="recent">最近</option>
                      <option value="24h">近 24 小时</option>
                      <option value="7d">近 7 天</option>
                    </select>
                    <div class="dropdown-menu">
                      <button type="button" class="dropdown-item" data-value="recent">最近</button>
                      <button type="button" class="dropdown-item" data-value="24h">近 24 小时</button>
                      <button type="button" class="dropdown-item" data-value="7d">近 7 天</button>
                    </div>
                  </div>
                </div>
              </div>
              <div class="history-list" data-role="history-list"></div>
            </section>
          </div>

          <div data-page-container="logs" class="download-page hidden">
            <section class="section">
              <div class="panel-header">
                <div>
                  <h3 class="panel-title">运行日志</h3>
                  <p class="panel-desc">实时查看服务输出的关键事件</p>
                </div>
                <div class="panel-actions compact">
                  <div class="select-control dropdown" data-dropdown="log-level">
                    <button type="button" class="dropdown-toggle" data-dropdown-trigger="log-level">
                      <span data-dropdown-label>全部</span>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>
                    </button>
                    <select class="toolbar-select toggle-menu" data-role="log-level">
                      <option value="all">全部</option>
                      <option value="info">INFO</option>
                      <option value="success">SUCCESS</option>
                      <option value="warning">WARNING</option>
                      <option value="error">ERROR</option>
                    </select>
                    <div class="dropdown-menu">
                      <button type="button" class="dropdown-item" data-value="all">全部</button>
                      <button type="button" class="dropdown-item" data-value="info">INFO</button>
                      <button type="button" class="dropdown-item" data-value="success">SUCCESS</button>
                      <button type="button" class="dropdown-item" data-value="warning">WARNING</button>
                      <button type="button" class="dropdown-item" data-value="error">ERROR</button>
                    </div>
                  </div>
                  <button class="btn-outline" data-action="refresh-logs">${iconRefresh()}<span>刷新</span></button>
                  <button class="btn-outline" data-action="clear-logs">${iconCircleX()}<span>清空</span></button>
                </div>
              </div>
              <div class="log-container" data-role="log-container"></div>
            </section>
          </div>
        </div>
      </section>
    </div>
  </div>
`;

function ensureDownloadRoot() {
  ensureStyleHelpers();
  if (rootEl) return rootEl;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = TEMPLATE.trim();
  const created = wrapper.firstChild;
  document.body.appendChild(created);
  created.style.display = 'none';
  hydrateCaches(created);

  return rootEl;
}

function hydrateCaches(existingRoot) {
  rootEl = existingRoot;
  sidebarEl = rootEl.querySelector('[data-role="sidebar"]');
  navLinks = Array.from(rootEl.querySelectorAll('[data-role="download-nav"] .nav-item'));
  pageContainers = Array.from(rootEl.querySelectorAll('[data-page-container]'))
    .reduce((acc, el) => {
      acc[el.getAttribute('data-page-container')] = el;
      return acc;
    }, {});
}

function getRootElement() {
  if (rootEl && document.body.contains(rootEl)) {
    return rootEl;
  }
  const existing = document.getElementById('download-root');
  if (existing) {
    hydrateCaches(existing);
    return rootEl;
  }
  return null;
}

function setRootVisible(visible) {
  if (!rootEl) return;
  visible ? rootEl?.classList.remove('hidden') : rootEl?.classList.add('hidden');
  rootEl.style.display = visible ? 'flex' : 'none';
  if (visible) {
    document.documentElement.classList.add('download-page-active');
    document.body.classList.add('download-page-active');

    // 下载页状态栏沉浸（移动端）
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.dataset.originalColor = themeColorMeta.getAttribute('content');
      themeColorMeta.setAttribute('content', '#f7f8fa');
    }

    applyInteractiveEffects(rootEl);
  } else {
    document.documentElement.classList.remove('download-page-active');
    document.body.classList.remove('download-page-active');

    // 恢复主应用状态栏颜色
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta && themeColorMeta.dataset.originalColor) {
      themeColorMeta.setAttribute('content', themeColorMeta.dataset.originalColor);
      delete themeColorMeta.dataset.originalColor;
    }

    removeStyleHelpers();
    const openMenus = rootEl.querySelectorAll('.task-actions-menu.is-open');
    openMenus.forEach((menu) => {
      menu.classList.remove('is-open');
      const toggle = menu.previousElementSibling;
      if (toggle?.dataset?.action === 'toggle-task-actions') {
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }
}

function switchPage(page) {
  if (!rootEl) return;
  const target = pageContainers[page];
  if (!target) return;

  Object.values(pageContainers).forEach((el) => {
    if (el === target) {
      el?.classList.remove('hidden');
    } else {
      el?.classList.add('hidden');
    }
  });

  navLinks.forEach((link) => {
    const matches = link.getAttribute('data-page') === page;
    if (matches) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    } else {
      link.classList.remove('active');
      link.setAttribute('aria-current', 'false');
    }
  });
}

function openSidebar() {
  if (!sidebarEl) return;
  sidebarEl.classList.add('is-open');
  const toggle = rootEl ? rootEl.querySelector('[data-action="open-sidebar"]') : null;
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  if (!sidebarEl) return;
  sidebarEl.classList.remove('is-open');
  const toggle = rootEl ? rootEl.querySelector('[data-action="open-sidebar"]') : null;
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

function isSidebarOpen() {
  return Boolean(sidebarEl && sidebarEl.classList.contains('is-open'));
}

export {
  ensureDownloadRoot,
  getRootElement,
  setRootVisible,
  switchPage,
  openSidebar,
  closeSidebar,
  isSidebarOpen
};
