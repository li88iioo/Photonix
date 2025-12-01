/**
 * @file frontend/js/shared/dom-utils.js
 * @description DOM 操作工具函数（简化版）
 *
 * @changelog
 * - 2025-12-01: Optional Chaining 迁移
 *   - 删除 13 个函数（查询、classList、元素操作等）
 *   - 保留 XSS 防护函数（safeSetInnerHTML）
 *   - 样式函数标记为 @deprecated（待逐步迁移）
 */

import { domLogger } from '../core/logger.js';


/**
 * 安全地为元素设置 innerHTML，自动进行XSS防护。
 * - 优先使用DOMPurify进行HTML净化（如果已加载）
 * - Fallback: 使用基础的脚本标签过滤
 * - 作为最后防线：仅设置textContent（完全禁用HTML）
 * @param {Element} element - 目标元素
 * @param {string} html - HTML内容
 * @returns {boolean} 是否成功
 */
export function safeSetInnerHTML(element, html) {
    if (!element) {
        domLogger.warn('设置innerHTML失败：元素不存在');
        return false;
    }

    try {
        // 优先使用DOMPurify（如果全局可用）
        if (typeof window !== 'undefined' && typeof window.DOMPurify !== 'undefined') {
            element.innerHTML = window.DOMPurify.sanitize(html);
            return true;
        }

        // Fallback 1: 基础XSS防护 - 移除script标签和事件处理器属性
        const sanitized = html
            // 移除所有<script>标签及其内容
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            // 移除所有内联事件处理器 (on* 属性)
            .replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '')
            .replace(/\s*on\w+\s*=\s*[^\s>]*/gi, '')
            // 移除javascript: 协议
            .replace(/javascript:/gi, '');

        element.innerHTML = sanitized;
        
        // 如果原始HTML包含被过滤的危险内容，记录警告
        if (sanitized !== html) {
            domLogger.warn('HTML内容已净化：检测到潜在XSS风险', {
                removed: html.length - sanitized.length + ' 字符'
            });
        }
        
        return true;
    } catch (error) {
        domLogger.error('设置innerHTML失败', { error: error.message });
        // 降级到纯文本模式（完全安全）
        try {
            element.textContent = html.replace(/<[^>]*>/g, '');
            domLogger.warn('已降级为textContent模式');
            return true;
        } catch {
            return false;
        }
    }
}

