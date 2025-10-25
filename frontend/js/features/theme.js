/**
 * @file theme.js
 * @description Theme management module - handles light/dark mode switching with localStorage persistence
 */

import { createModuleLogger } from '../core/logger.js';

const themeLogger = createModuleLogger('Theme');

const THEME_STORAGE_KEY = 'photonix-theme';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';

/**
 * Get the current theme from localStorage or system preference
 * @returns {string} 'light' or 'dark'
 */
export function getCurrentTheme() {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === THEME_LIGHT || stored === THEME_DARK) {
            return stored;
        }
    } catch (e) {
        themeLogger.warn('Failed to read theme from localStorage', e);
    }
    
    // Fallback to system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        return THEME_LIGHT;
    }
    
    return THEME_DARK; // Default to dark
}

/**
 * Set the theme
 * @param {string} theme - 'light' or 'dark'
 */
export function setTheme(theme) {
    if (theme !== THEME_LIGHT && theme !== THEME_DARK) {
        themeLogger.warn('Invalid theme value', theme);
        return;
    }
    
    // Apply theme to document
    document.body.setAttribute('data-theme', theme);
    
    // Update theme-color meta tag
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
        if (theme === THEME_LIGHT) {
            metaThemeColor.setAttribute('content', '#f5f7fa');
        } else {
            metaThemeColor.setAttribute('content', '#1a1f2e');
        }
    }
    
    // Update icon visibility
    updateThemeIcons(theme);
    
    // Save to localStorage
    try {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (e) {
        themeLogger.warn('Failed to save theme to localStorage', e);
    }
    
    themeLogger.info('Theme changed to', theme);
}

/**
 * Toggle between light and dark theme
 */
export function toggleTheme() {
    const currentTheme = getCurrentTheme();
    const newTheme = currentTheme === THEME_LIGHT ? THEME_DARK : THEME_LIGHT;
    setTheme(newTheme);
}

/**
 * Update theme icon visibility
 * @param {string} theme - Current theme
 */
function updateThemeIcons(theme) {
    const lightIcon = document.getElementById('theme-icon-light');
    const darkIcon = document.getElementById('theme-icon-dark');
    
    if (lightIcon && darkIcon) {
        if (theme === THEME_LIGHT) {
            // In light mode, show moon icon (to switch to dark)
            lightIcon.style.display = 'none';
            darkIcon.style.display = 'block';
        } else {
            // In dark mode, show sun icon (to switch to light)
            lightIcon.style.display = 'block';
            darkIcon.style.display = 'none';
        }
    }
}

/**
 * Initialize theme system
 */
export function initializeTheme() {
    const theme = getCurrentTheme();
    setTheme(theme);
    
    // Set up toggle button
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', toggleTheme);
        themeLogger.info('Theme toggle button initialized');
    }
    
    // Listen for system theme changes
    if (window.matchMedia) {
        const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
        darkModeQuery.addEventListener('change', (e) => {
            // Only auto-switch if user hasn't explicitly set a preference
            try {
                const stored = localStorage.getItem(THEME_STORAGE_KEY);
                if (!stored) {
                    setTheme(e.matches ? THEME_DARK : THEME_LIGHT);
                }
            } catch (err) {
                themeLogger.warn('Failed to handle system theme change', err);
            }
        });
    }
    
    themeLogger.info('Theme system initialized', { currentTheme: theme });
}
