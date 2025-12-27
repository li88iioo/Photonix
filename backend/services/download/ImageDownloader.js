/**
 * @file ImageDownloader.js
 * @description 图片下载器，负责下载、验证和保存图片
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const { Worker } = require('worker_threads');
const axios = require('axios');
const imageSize = require('image-size');
const { v4: uuidv4 } = require('uuid');

class ImageDownloader {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.validationWorker = null;
    this.validationTasks = new Map();
    this.initWorker();
  }

  /**
   * 并发限流下载图片
   * @param {object} task 任务对象
   * @param {string[]} urls 图片URL列表
   * @param {string} directory 保存目录
   * @param {object} context 上下文信息
   * @returns {Promise<Array>} 下载成功的图片信息
   */
  async downloadImagesWithLimits(task, urls, directory, context = {}) {
    const limit = Math.max(1, this.config.maxConcurrentDownloads);
    const queue = [...this.unique(urls)];
    const downloaded = [];

    const worker = async () => {
      while (queue.length > 0) {
        const url = queue.shift();
        const started = Date.now();

        try {
          const info = await this.downloadImageWithValidation(task, url, directory);
          if (info) {
            info.durationMs = Date.now() - started;
            downloaded.push(info);

            if (this.logger) {
              this.logger.log('success', `成功下载 ${info.filename} (${this.formatBytes(info.size)}, ${info.durationMs}ms)`, {
                ...context,
                imageUrl: url,
                size: info.size,
                durationMs: info.durationMs
              });
            }
          }

          await this.applySecurityDelay();
        } catch (error) {
          if (this.logger) {
            this.logger.log('warning', `下载图片失败：${error.message || '未知错误'}`, {
              ...context,
              imageUrl: url,
              error: error.message
            });
          }

          await this.delay(this.config.retryDelay * 1000);
        }
      }
    };

    const workers = Array.from({ length: Math.min(limit, queue.length) }, () => worker());
    await Promise.all(workers);

    return downloaded;
  }

  /**
   * 下载并验证单个图片（原子写入模式）
   * 
   * 使用临时文件 + 原子重命名策略防止以下问题：
   * - 容器重启导致文件写入不完整
   * - 网络中断导致的半成品文件
   * - 进程崩溃时的数据损坏
   * 
   * @param {object} task 任务对象
   * @param {string} url 图片URL
   * @param {string} directory 保存目录
   * @returns {Promise<object>} 图片信息
   */
  async downloadImageWithValidation(task, url, directory) {
    const timeoutMs = Math.max(5000, this.config.readTimeout * 1000);
    const maxRetries = Math.max(1, this.config.maxRetries);
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
      attempt += 1;
      let tempPath = null;
      const { signal, clearConnectTimeout } = this.createConnectTimeoutController();

      try {
        const headers = this.resolveHeadersForUrl(task, url, this.config.imageHeaders);
        const response = await axios.get(url, {
          responseType: 'stream',
          timeout: timeoutMs,
          headers,
          maxRedirects: 3,
          signal
        });
        clearConnectTimeout();

        const extension = this.resolveImageExtension(url);
        const filename = `${Date.now()}-${this.slugify(path.basename(url).split('.')[0] || 'image')}${extension}`;
        const filePath = path.join(directory, filename);

        // 原子写入：先写入临时文件
        tempPath = `${filePath}.download.tmp`;
        await pipeline(response.data, fs.createWriteStream(tempPath));
        const stats = await fsp.stat(tempPath);

        // 验证文件大小
        if (stats.size < this.config.minImageBytes) {
          await fsp.unlink(tempPath).catch(() => { });
          tempPath = null;
          throw new Error('文件体积过小');
        }

        // 图片验证（如果启用）
        if (this.config.imageValidation.enabled) {
          const valid = await this.validateImage(tempPath, stats.size);
          if (!valid) {
            // 非严格模式下，验证失败仅记录警告，仍接受文件
            if (!this.config.imageValidation.strictMode) {
              if (this.logger) {
                this.logger.log('warn', `图片验证失败但非严格模式，继续保留: ${url}`);
              }
            } else {
              // 严格模式下，验证失败则删除并抛出错误
              await fsp.unlink(tempPath).catch(() => { });
              tempPath = null;
              throw new Error('图片验证失败');
            }
          }
        }

        // 验证通过，原子重命名到最终路径
        await fsp.rename(tempPath, filePath);
        tempPath = null; // 已成功重命名，不需要清理

        return {
          filename,
          path: path.relative(this.config.baseFolder || directory, filePath),
          size: stats.size,
          url
        };
      } catch (error) {
        clearConnectTimeout();
        // 清理可能残留的临时文件
        if (tempPath) {
          await fsp.unlink(tempPath).catch(() => { });
        }
        lastError = error;
        await this.delay(this.config.retryDelay * 1000);
      }
    }

    throw lastError || new Error('下载失败');
  }

  /**
   * 初始化Worker线程
   */
  initWorker() {
    try {
      const workerPath = path.join(__dirname, 'imageValidationWorker.js');
      this.validationWorker = new Worker(workerPath);

      this.validationWorker.on('message', ({ taskId, result }) => {
        const task = this.validationTasks.get(taskId);
        if (task) {
          task.resolve(result);
          this.validationTasks.delete(taskId);
        }
      });

      this.validationWorker.on('error', (error) => {
        if (this.logger) {
          this.logger.log('error', 'Worker线程错误', { error: error.message });
        }
        // 拒绝所有待处理任务
        this.validationTasks.forEach(task => {
          task.reject(new Error('Worker thread error'));
        });
        this.validationTasks.clear();
      });
    } catch (error) {
      if (this.logger) {
        this.logger.log('warning', 'Worker线程初始化失败，回退到同步验证', { error: error.message });
      }
      this.validationWorker = null;
    }
  }

  /**
   * 验证图片尺寸（异步Worker或回退到同步）
   * @param {string} filePath 文件路径
   * @param {number} fileSize 文件大小
   * @returns {Promise<boolean>} 是否有效
   */
  async validateImage(filePath, fileSize) {
    // 如果Worker可用，使用异步验证
    if (this.validationWorker) {
      try {
        const taskId = uuidv4();
        const promise = new Promise((resolve, reject) => {
          this.validationTasks.set(taskId, { resolve, reject });

          // 设置超时
          setTimeout(() => {
            if (this.validationTasks.has(taskId)) {
              this.validationTasks.delete(taskId);
              reject(new Error('Validation timeout'));
            }
          }, 5000);
        });

        // 发送任务到Worker
        this.validationWorker.postMessage({
          taskId,
          filePath,
          fileSize,
          minWidth: this.config.minImageWidth,
          minHeight: this.config.minImageHeight
        });

        const result = await promise;
        return result.valid;
      } catch (error) {
        if (this.logger) {
          this.logger.log('warning', 'Worker验证失败，回退到同步验证', { error: error.message });
        }
        // 回退到同步验证
        return this.validateImageSync(filePath, fileSize);
      }
    }

    // 没有Worker，使用同步验证
    return this.validateImageSync(filePath, fileSize);
  }

  /**
   * 同步验证图片（回退方案）
   * @param {string} filePath 文件路径
   * @param {number} fileSize 文件大小
   * @returns {Promise<boolean>} 是否有效
   */
  async validateImageSync(filePath, fileSize) {
    try {
      const buffer = await fsp.readFile(filePath);
      if (buffer.length !== fileSize) return false;

      const dimensions = imageSize(buffer);
      const meetsWidth = !this.config.minImageWidth || dimensions.width >= this.config.minImageWidth;
      const meetsHeight = !this.config.minImageHeight || dimensions.height >= this.config.minImageHeight;

      return meetsWidth && meetsHeight;
    } catch (error) {
      if (this.logger) {
        this.logger.log('warning', '图片验证失败', { filePath, error: error.message });
      }
      return false;
    }
  }

  /**
   * 应用安全延迟
   */
  async applySecurityDelay() {
    const [min, max] = this.config.security?.requestInterval || [0, 0];
    if (min <= 0 && max <= 0) return;

    const wait = this.randomBetween(min, max) * 1000;
    if (wait > 0) {
      await this.delay(wait);
    }
  }

  /**
   * 解析请求头
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
   * 根据URL确定图片扩展名
   */
  resolveImageExtension(url) {
    try {
      const pathname = new URL(url).pathname;
      const ext = path.extname(pathname);
      if (ext) return ext;
    } catch { }
    return '.jpg';
  }

  /**
   * 字符串slug化
   */
  slugify(value, fallback = 'item') {
    if (!value || typeof value !== 'string') return fallback;
    return value
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}\s\-_.]+/gu, '_')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 120) || fallback;
  }

  /**
   * 延时函数
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 随机数生成
   */
  randomBetween(min, max) {
    if (Number.isNaN(min) || Number.isNaN(max)) return min;
    if (max <= min) return min;
    return min + Math.random() * (max - min);
  }

  /**
   * 数组去重
   */
  unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  /**
   * 格式化字节数
   */
  formatBytes(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) return '';
    if (size < 1024) return `${size}B`;

    const units = ['KB', 'MB', 'GB', 'TB'];
    let index = -1;
    let value = size;

    do {
      value /= 1024;
      index += 1;
    } while (value >= 1024 && index < units.length - 1);

    return `${value.toFixed(value >= 10 ? 1 : 2)}${units[index]}`;
  }

  /**
   * 清理资源
   */
  cleanup() {
    if (this.validationWorker) {
      this.validationWorker.terminate();
      this.validationWorker = null;
    }
    this.validationTasks.clear();
  }
}

module.exports = ImageDownloader;
