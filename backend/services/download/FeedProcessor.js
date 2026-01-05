/**
 * @file FeedProcessor.js
 * @description RSS源处理器，负责解析RSS/OPML和提取图片链接
 */

const Parser = require('rss-parser');
const cheerio = require('cheerio');
const http = require('http');
const https = require('https');
const axios = require('axios');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const { ExternalServiceError } = require('../../utils/errors');

// HTTP 连接复用 Agent，避免每次请求重建 TCP 连接
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, timeout: 60000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 60000 });

class FeedProcessor {
  constructor(config, logManager) {
    this.config = config;
    this.logManager = logManager;
    this.parser = new Parser({
      customFields: {
        item: ['content:encoded', 'media:content', 'mediaThumbnails', 'media:thumbnail']
      }
    });
  }

  /**
   * 拉取RSS Feed
   * @param {object} task 任务对象
   * @returns {Promise<object>} 解析后的Feed对象
   */
  async fetchFeed(task) {
    const timeoutMs = Math.max(5000, this.config.requestTimeout * 1000);
    const { signal, clearConnectTimeout } = this.createConnectTimeoutController();
    const headers = this.resolveHeadersForUrl(task, task.feedUrl, this.config.requestHeaders);

    const requestConfig = {
      url: task.feedUrl,
      method: 'GET',
      timeout: timeoutMs,
      headers,
      responseType: 'text',
      signal,
      httpAgent,
      httpsAgent
    };

    try {
      const response = await axios(requestConfig);
      return this.parser.parseString(response.data);
    } catch (error) {
      // 构建用户友好的错误消息
      const feedName = task.title || task.feedUrl;
      const statusCode = error.response?.status;
      const errorReason = this.formatErrorReason(error);

      // 日志中包含完整的 feed 信息
      if (this.logManager) {
        this.logManager.log('error', `拉取 RSS 源失败: ${feedName}`, {
          taskId: task.id,
          feedUrl: task.feedUrl,
          feedTitle: task.title,
          statusCode,
          reason: errorReason,
          error: error.message
        });
      }

      // 抛出用户友好的错误，前端通知会显示这个消息
      throw new ExternalServiceError(`RSS 源「${feedName}」`, {
        feedUrl: task.feedUrl,
        feedTitle: task.title,
        statusCode,
        reason: errorReason,
        originalError: error.message
      });
    } finally {
      clearConnectTimeout();
    }
  }

  /**
   * 格式化错误原因为用户友好的描述
   * @param {Error} error axios错误对象
   * @returns {string} 用户友好的错误描述
   */
  formatErrorReason(error) {
    // HTTP 状态码错误
    if (error.response?.status) {
      const status = error.response.status;
      const statusMessages = {
        400: '请求格式错误',
        401: '需要认证',
        403: '访问被拒绝',
        404: '源地址不存在',
        429: '请求过于频繁',
        500: '服务器内部错误',
        502: '网关错误',
        503: '服务暂时不可用',
        504: '网关超时'
      };
      return statusMessages[status] || `HTTP ${status}`;
    }

    // 网络错误
    if (error.code) {
      const codeMessages = {
        'ECONNREFUSED': '连接被拒绝',
        'ENOTFOUND': '域名无法解析',
        'ETIMEDOUT': '连接超时',
        'ECONNRESET': '连接被重置',
        'ECONNABORTED': '连接中断',
        'ERR_CANCELED': '请求超时被取消'
      };
      return codeMessages[error.code] || error.code;
    }

    // AbortError（连接超时）
    if (error.name === 'AbortError') {
      return '连接超时';
    }

    return '未知错误';
  }

  /**
   * 解析请求头，智能应用Cookie
   * @param {object} task 任务对象
   * @param {string} targetUrl 目标URL
   * @param {object} baseHeaders 基础请求头
   * @returns {object} 合并后的请求头
   */
  resolveHeadersForUrl(task, targetUrl, baseHeaders = {}) {
    const headers = { ...(baseHeaders || {}) };
    if (!task?.cookie) {
      return headers;
    }

    const domain = task.cookieDomain || '';
    if (!domain) {
      headers.Cookie = task.cookie;
      return headers;
    }

    try {
      const resolvedUrl = targetUrl ? new URL(targetUrl, task.feedUrl) : null;
      const hostname = resolvedUrl?.hostname?.toLowerCase();
      if (hostname && (hostname === domain || hostname.endsWith(`.${domain}`))) {
        headers.Cookie = task.cookie;
      }
    } catch {
      // ignore malformed URL
    }

    return headers;
  }

  /**
   * 提取RSS条目中的图片URL
   * @param {object} item RSS条目
   * @param {string} fallbackBase 基础URL用于相对路径解析
   * @returns {Promise<string[]>} 图片URL数组
   */
  async extractImageUrls(item, fallbackBase) {
    const urls = [];

    // 检查enclosure
    if (item.enclosure && item.enclosure.url && String(item.enclosure.type || '').startsWith('image/')) {
      urls.push(item.enclosure.url);
    }

    // 检查enclosures数组
    if (Array.isArray(item.enclosures)) {
      item.enclosures.forEach((enclosure) => {
        if (enclosure.url && String(enclosure.type || '').startsWith('image/')) {
          urls.push(enclosure.url);
        }
      });
    }

    // 从HTML内容中提取
    const encoded = item['content:encoded'] || item.content || item.description || '';
    if (encoded) {
      const $ = cheerio.load(encoded);

      // 提取img标签的各种图片属性
      $('img').each((_, img) => {
        // 优先获取懒加载图片URL
        const lazyUrl = $(img).attr('data-lazy-src');
        const dataSrc = $(img).attr('data-src');
        const src = $(img).attr('src');

        // 按优先级选择URL
        if (lazyUrl && !lazyUrl.startsWith('data:')) {
          urls.push(lazyUrl);
        } else if (dataSrc && !dataSrc.startsWith('data:')) {
          urls.push(dataSrc);
        } else if (src && !src.startsWith('data:')) {
          urls.push(src);
        }
      });

      // 额外检查noscript标签中的备用图片
      $('noscript').each((_, noscript) => {
        const noscriptHtml = $(noscript).html();
        if (noscriptHtml) {
          const $noscript = cheerio.load(noscriptHtml);
          $noscript('img').each((_, img) => {
            const src = $noscript(img).attr('src');
            if (src && !src.startsWith('data:')) {
              urls.push(src);
            }
          });
        }
      });
    }

    const resolved = urls.map((url) => this.resolveUrl(url, item.link || fallbackBase));
    return this.unique(resolved).filter((url) => url.startsWith('http://') || url.startsWith('https://'));
  }

  /**
   * 回退抓取文章页面图片
   * @param {object} task 任务对象
   * @param {string} articleUrl 文章URL
   * @returns {Promise<string[]>} 图片URL数组
   */
  async fetchFallbackImages(task, articleUrl) {
    const { signal, clearConnectTimeout } = this.createConnectTimeoutController();
    try {
      await this.applyPaginationDelay();
      const headers = this.resolveHeadersForUrl(task, articleUrl, this.config.requestHeaders);
      const response = await axios.get(articleUrl, {
        timeout: Math.max(5000, this.config.requestTimeout * 1000),
        headers,
        responseType: 'text',
        signal,
        httpAgent,
        httpsAgent
      });

      const $ = cheerio.load(response.data);
      const urls = [];

      $('img').each((_, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src');
        if (src) {
          try {
            const resolved = new URL(src, articleUrl).toString();
            urls.push(resolved);
          } catch { }
        }
      });

      return this.unique(urls);
    } catch (error) {
      if (typeof error?.name === 'string' && error.name === 'AbortError') {
        if (this.logManager) {
          this.logManager.log('warning', '回退抓取文章页面超时（连接阶段）', {
            taskId: task?.id,
            url: articleUrl
          });
        }
        return [];
      }
      if (this.logManager) {
        this.logManager.log('warning', '回退抓取文章页面失败', {
          taskId: task?.id,
          url: articleUrl,
          error: error.message
        });
      }
      return [];
    } finally {
      clearConnectTimeout();
    }
  }

  /**
   * 导出OPML
   * @param {Map} tasks 任务集合
   * @returns {object} OPML导出结果
   */
  exportOpml(tasks) {
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      format: true,
      suppressEmptyNode: true
    });

    const outlines = Array.from(tasks.values()).map((task) => {
      const outline = {
        '@_text': task.title || task.feedUrl,
        '@_title': task.title || task.feedUrl,
        '@_type': 'rss',
        '@_xmlUrl': task.feedUrl,
        '@_interval': task.interval
      };

      if (task.category) outline['@_category'] = task.category;
      if (Array.isArray(task.tags) && task.tags.length) outline['@_tags'] = task.tags.join(',');
      if (Array.isArray(task.excludeKeywords) && task.excludeKeywords.length) outline['@_exclude'] = task.excludeKeywords.join(',');
      if (task.cookie) outline['@_cookie'] = task.cookie;
      if (task.cookieDomain) outline['@_cookieDomain'] = task.cookieDomain;

      return outline;
    });

    const opmlObject = {
      opml: {
        '@_version': '2.0',
        head: {
          title: 'Photonix 下载服务订阅',
          dateCreated: new Date().toISOString()
        },
        body: {
          outline: outlines
        }
      }
    };

    const content = builder.build(opmlObject);
    return { content, count: outlines.length };
  }

  /**
   * 导入OPML
   * @param {string} content OPML内容
   * @returns {Array} 解析出的订阅源列表
   */
  importOpml(content) {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_'
    });

    const parsed = parser.parse(content);
    const outlines = this.flattenOpmlOutlines(parsed?.opml?.body?.outline);

    return outlines.map(outline => {
      const feedUrl = outline['@_xmlUrl'] || outline['@_xmlurl'] || outline['@_url'] || outline['@_URL'];
      if (!feedUrl) return null;

      return {
        feedUrl,
        title: outline['@_title'] || outline['@_text'] || feedUrl,
        interval: outline['@_interval'] || '60m',
        category: outline['@_category'] || '',
        tags: this.parseStringArray(outline['@_tags']),
        excludeKeywords: this.parseStringArray(outline['@_exclude']),
        cookie: outline['@_cookie'] || '',
        cookieDomain: outline['@_cookieDomain'] || outline['@_cookiedomain'] || ''
      };
    }).filter(Boolean);
  }

  /**
   * 展平OPML Outline结构
   */
  flattenOpmlOutlines(outlines, accumulator = []) {
    if (!outlines) return accumulator;
    const list = Array.isArray(outlines) ? outlines : [outlines];

    list.forEach((outline) => {
      if (!outline) return;
      if (outline['@_xmlUrl'] || outline['@_xmlurl'] || outline['@_URL'] || outline['@_url']) {
        accumulator.push(outline);
      }
      if (outline.outline) {
        this.flattenOpmlOutlines(outline.outline, accumulator);
      }
    });

    return accumulator;
  }

  /**
   * 相对路径解析
   */
  resolveUrl(url, baseUrl) {
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      return url;
    }
  }

  /**
   * 数组去重
   */
  unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  /**
   * 解析字符串数组
   */
  parseStringArray(value) {
    if (!value) return [];
    if (typeof value === 'string') {
      return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    return [];
  }

  /**
   * 连接超时控制器（仅用于建立连接阶段）
   * @returns {{signal: AbortSignal|undefined, clearConnectTimeout: Function}}
   */
  createConnectTimeoutController() {
    const rawSeconds = Number(this.config.connectTimeout);
    if (!Number.isFinite(rawSeconds) || rawSeconds <= 0) {
      return { signal: undefined, clearConnectTimeout: () => {} };
    }

    const timeoutMs = Math.max(1000, rawSeconds * 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return {
      signal: controller.signal,
      clearConnectTimeout: () => clearTimeout(timer)
    };
  }

  /**
   * 应用分页延迟（秒级随机抖动）
   */
  async applyPaginationDelay() {
    const delay = this.config.paginationDelay;
    if (!Array.isArray(delay) || delay.length !== 2) return;

    const min = Number(delay[0]);
    const max = Number(delay[1]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;

    const safeMin = Math.max(0, min);
    const safeMax = Math.max(safeMin, max);
    if (safeMax <= 0) return;

    const waitSeconds = safeMin + Math.random() * (safeMax - safeMin);
    if (waitSeconds <= 0) return;

    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
  }
}

module.exports = FeedProcessor;
