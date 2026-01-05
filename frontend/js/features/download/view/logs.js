import { safeSetInnerHTML } from '../../../shared/dom-utils.js';
import { getRootElement } from './root.js';
import {
  sanitize,
  formatBytes,
  formatLogTimestamp,
  extractLogContext
} from './utils.js';

/**
 * 渲染日志列表到日志容器
 * @param {Array} entries 日志条目数据数组
 */
export function renderLogs(entries) {
  const rootEl = getRootElement();
  if (!rootEl) return;
  const container = rootEl.querySelector('[data-role="log-container"]');
  if (!container) return;

  // 如果没有日志条目，则显示空内容提示
  if (!entries || !entries.length) {
    safeSetInnerHTML(container, `
      <div class="flex flex-col items-center justify-center p-12 text-gray-400 font-mono">
        <svg class="w-12 h-12 mb-3 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
        <div class="text-sm">_NO_LOGS_FOUND_</div>
      </div>
    `);
    return;
  }

  const items = entries.slice(0, 200).map((entry) => {
    const rawLevel = String(entry?.level || entry?.severity || 'info').toLowerCase();
    const levelClass = ['info', 'success', 'warning', 'error'].includes(rawLevel) ? rawLevel : 'info';

    // 日志等级对应的终端主题颜色和标记
    const statusConfig = {
      info: { color: 'text-blue-500', marker: '›' },
      success: { color: 'text-green-500', marker: '✔' },
      warning: { color: 'text-amber-500', marker: '⚠' },
      error: { color: 'text-red-500', marker: '✖' }
    };
    const config = statusConfig[levelClass];

    const timestampValue = entry?.timestamp || entry?.time || entry?.date || new Date().toISOString();
    // 格式化日志时间戳为 HH:MM:SS
    const timestamp = sanitize(formatLogTimestamp(timestampValue)); // HH:MM:SS

    // 日志上下文信息（如 feed、article 标题）
    let { feed, article } = extractLogContext(entry);

    // 日志消息解析与技术 ID 清理
    let messageRaw = entry?.message || entry?.msg || '';
    if (!messageRaw && entry?.line) {
      const segments = String(entry.line).split(' - ');
      messageRaw = segments.length >= 4 ? segments.slice(3).join(' - ') : entry.line;
    }

    // 如果无消息但有 meta，则序列化 meta 作为日志内容（清理前）
    if (!messageRaw && entry?.meta && Object.keys(entry.meta).length) {
      try { messageRaw = JSON.stringify(entry.meta); } catch { messageRaw = ''; }
    }

    // 清理技术性 ID 标签，如 [Task:...] 或 [任务:...]
    let isProcessing = false;
    let isCompleted = false;
    if (typeof messageRaw === 'string') {
      messageRaw = messageRaw.replace(/^\[(?:Task|任务):[^\]]+\]/, '');
      if (feed) {
        const feedPattern = new RegExp(`\\[${feed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'i');
        messageRaw = messageRaw.replace(feedPattern, '');
      }
      messageRaw = messageRaw.trim();

      // 检查是否为新文章处理日志前缀
      if (/^处理新文章[:：]/.test(messageRaw)) {
        isProcessing = true;
        messageRaw = messageRaw.replace(/^处理新文章[:：]\s*/, '');
      }

      // 如果是成功日志，则解析并提取统计信息
      if (levelClass === 'success') {
        isCompleted = true;

        // 兼容旧日志格式，缺失 meta 时自动从文本提取相关数据
        const legacyMatch = messageRaw.match(/总[\s\u00A0]*(\d+)[\s\u00A0]*(?:成功下载|成功)[\s\u00A0]*(\d+)[\s\u00A0]*失败[\s\u00A0]*(\d+)[\s\u00A0]*[（(](?:(.*?),\s*(.*?))?[)）]/);

        if (legacyMatch) {
          const [, total, success, fail, sizeStr, timeStr] = legacyMatch;
          entry.meta = entry.meta || {};
          if (!entry.meta.attempted) entry.meta.attempted = total;
          if (!entry.meta.successCount && !entry.meta.downloadedCount) entry.meta.downloadedCount = success;
          if (!entry.meta.failedCount && !entry.meta.failed) entry.meta.failedCount = fail;

          // 如果 meta 未设置则补充 size/time
          if (sizeStr && (!entry.meta.size && !entry.meta.totalBytes)) {
            entry.meta._legacySize = sizeStr;
          }
          if (timeStr && !entry.meta.durationMs) {
            entry.meta._legacyTime = timeStr;
          }
        }

        // 清理多余的统计信息文本片段
        messageRaw = messageRaw.replace(/[\s\u00A0]*总[\s\u00A0]*\d+[\s\u00A0]*(?:成功下载|成功)[\s\u00A0]*\d+[\s\u00A0]*失败[\s\u00A0]*\d+[\s\u00A0]*[（(].*?[)）]/g, '');
      }

      messageRaw = messageRaw.trim();

      // 去重：如消息内容仅为标题，则隐藏该消息
      // 必须在处理完 success 日志冗余后执行
      if (article) {
        const cleanMsg = messageRaw.replace(/^['"]|['"]$/g, '').trim();
        if (cleanMsg === article.trim()) {
          messageRaw = '';
        }
      }
    }

    // 如果最终消息内容为空但没有文章标题，显示占位 // empty，否则置空
    const message = messageRaw ? sanitize(messageRaw) : (article ? '' : '<span class="opacity-25">// empty</span>');

    // 构建底部详情区（如文件大小、用时、统计数等信息 Key:Value 格式）
    const meta = entry?.meta || {};
    const details = [];

    /**
     * 格式化时间区间（ms → s 或 ms）
     * @param {number} ms 毫秒
     * @returns {string} 格式化文本
     */
    const formatDuration = (ms) => {
      if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
      return `${ms}ms`;
    };

    // 文件体积
    if (meta.totalBytes || meta.size || meta._legacySize) {
      const sizeVal = meta.totalBytes || meta.size;
      details.push(`Size:${sizeVal ? formatBytes(sizeVal) : meta._legacySize}`);
    }
    // 用时
    if (meta.durationMs || meta._legacyTime) {
      details.push(`Time:${meta.durationMs ? formatDuration(Number(meta.durationMs)) : meta._legacyTime}`);
    }

    // 统计计数（尝试数、成功数、失败数、请求数等）
    const attempted = Number(meta.attempted);
    const downloaded = Number(meta.downloadedCount ?? meta.successCount);
    const failed = Number(meta.failedCount ?? meta.failed);
    const requested = Number(meta.requestedEntries);

    if (attempted > 0) details.push(`Total:${attempted}`);
    if (downloaded > 0) details.push(`OK:${downloaded}`);
    if (failed > 0) details.push(`Fail:${failed}`);
    if (requested > 0) details.push(`Items:${requested}`);

    // 失败日志额外补充状态码与错误
    if (levelClass !== 'success') {
      if (meta.statusCode) details.push(`HTTP:${meta.statusCode}`);
      if (meta.reason) details.push(`Err:${meta.reason}`);
    }

    // 渲染单条日志终端风格行
    return `
      <div class="flex flex-col md:flex-row md:items-baseline md:space-x-3 py-2.5 md:py-1.5 border-b border-gray-100/50 hover:bg-gray-50/50 font-mono text-sm leading-relaxed transition-colors">
         
         <!-- 移动端：顶部显示时间与状态标记；桌面端：并列显示 -->
         <div class="flex items-center space-x-2 md:contents mb-1.5 md:mb-0">
             <!-- 时间戳 -->
             <span class="text-xs text-gray-400 shrink-0 select-none md:w-[160px]">${timestamp}</span>
             
             <!-- 状态标记 -->
             <span class="${config.color} shrink-0 select-none font-bold align-middle text-center md:w-[12px]">${config.marker}</span>
         </div>
         
         <!-- 内容区 -->
         <div class="flex-1 break-words text-gray-700 w-full min-w-0">
            ${feed ? `<span class="text-indigo-500 font-medium mr-2">[${sanitize(feed)}]</span>` : ''}
            ${isProcessing ? `<span class="text-gray-400 mr-2 select-none">正在处理 :</span>` : ''}
            ${isCompleted ? `<span class="text-green-600 mr-2 select-none">处理完成 :</span>` : ''}
            ${article ? `<span class="text-gray-900 font-medium mr-2">"${sanitize(article)}"</span>` : ''}
            <span class="text-gray-600">${message}</span>
            
            ${details.length ? `
              <span class="ml-3 inline-flex flex-wrap gap-x-3 text-sm text-gray-400 select-none">
                 ${details.map(d => {
      const [k, v] = d.split(':');
      let valColor = 'text-gray-500';
      if (k === 'Fail' || k === 'Err') valColor = 'text-red-500';
      if (k === 'OK') valColor = 'text-green-600';
      return `<span>${k}:<span class="${valColor} ml-0.5">${v}</span></span>`;
    }).join('')}
              </span>
            ` : ''}
            
            ${meta.imageUrl ? `
               <a href="${sanitize(meta.imageUrl)}" target="_blank" class="ml-2 text-xs text-blue-400 hover:text-blue-600 hover:underline">
                 (View Image ↗)
               </a>
            ` : ''}
         </div>
      </div>
    `;
  });

  // 渲染日志条目到日志容器
  safeSetInnerHTML(container, `
    <div class="flex flex-col w-full bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm p-4 font-mono text-sm mt-6">
      ${items.join('')}
    </div>
  `);
}
