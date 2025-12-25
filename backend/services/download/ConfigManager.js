/**
 * @file ConfigManager.js
 * @description 配置管理器，负责加载、验证和持久化配置
 */

const path = require('path');
const fsp = require('fs/promises');
const YAML = require('yaml');
const logger = require('../../config/logger');

class ConfigManager {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.configFile = path.join(dataRoot, 'config.yaml');
    this.config = null;
    this.paths = {};
  }

  /**
   * 加载并规范化配置
   */
  async loadConfig() {
    const defaults = this.buildDefaultConfig();
    let raw = {};

    try {
      const content = await fsp.readFile(this.configFile, 'utf-8');
      raw = YAML.parse(content) || {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('读取下载配置失败，使用默认配置', { error: error.message });
      }
    }

    const normalized = this.normalizeConfig(raw, defaults);
    this.config = normalized;
    this.paths = this.resolvePaths(normalized);

    // 创建必要的目录
    await fsp.mkdir(this.paths.baseFolder, { recursive: true });
    await fsp.mkdir(path.dirname(this.paths.databasePath), { recursive: true });
    await fsp.mkdir(path.dirname(this.paths.activityLogPath), { recursive: true });
    await fsp.mkdir(path.dirname(this.paths.errorLogPath), { recursive: true });

    await this.persistConfig();
    return this.config;
  }

  /**
   * 构建默认配置
   */
  buildDefaultConfig() {
    return {
      baseFolder: this.autoDetectBaseFolder(),
      dbFile: 'downloads.db',
      opmlFile: 'feeds.opml',
      activityLogFile: path.join('logs', 'activity.log'),
      errorLogFile: path.join('logs', 'errors.log'),
      skipFeeds: [],
      allowFallbackToSourceSite: false,
      imageValidation: {
        enabled: true,
        strictMode: false
      },
      maxConcurrentFeeds: 3,
      maxConcurrentDownloads: 8,
      requestTimeout: 60,
      connectTimeout: 10,
      readTimeout: 30,
      minImageBytes: 1024,
      minImageWidth: 0,
      minImageHeight: 0,
      retryDelay: 15,
      maxRetries: 5,
      paginationDelay: [0.8, 2.0],
      dedupScope: 'by_link',
      security: {
        requestInterval: [0.4, 1.2]
      },
      throttler: {
        baseLimit: 4,
        minLimit: 1,
        maxLimit: 8,
        baseDelay: 0,
        maxDelay: 10,
        decay: 0.9
      },
      proxies: [],
      domainProxies: {},
      requestHeaders: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        Referer: 'https://www.google.com/'
      },
      imageHeaders: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8'
      }
    };
  }

  /**
   * 自动检测基础下载目录
   */
  autoDetectBaseFolder() {
    const envPath = process.env.PHOTONIX_DOWNLOAD_PATH;
    if (envPath) return path.resolve(envPath);
    return path.resolve(this.dataRoot, '../downloads');
  }

  /**
   * 规范化用户配置
   */
  normalizeConfig(raw, defaults) {
    const config = { ...defaults };

    // 基础路径
    const baseFolder = raw.base_folder || raw.baseFolder;
    if (baseFolder) {
      config.baseFolder = path.isAbsolute(baseFolder)
        ? baseFolder
        : path.resolve(process.cwd(), baseFolder);
    }

    // 文件配置
    config.dbFile = raw.db_file || raw.dbFile || defaults.dbFile;
    config.opmlFile = raw.opml_file || raw.opmlFile || defaults.opmlFile;
    config.activityLogFile = raw.activity_log_file || raw.activityLogFile || defaults.activityLogFile;
    config.errorLogFile = raw.error_log_file || raw.errorLogFile || defaults.errorLogFile;
    config.skipFeeds = this.normalizeStringArray(raw.skip_feeds || raw.skipFeeds);
    config.allowFallbackToSourceSite = this.normalizeBoolean(
      raw.allow_fallback_to_source_site ?? raw.allowFallbackToSourceSite,
      defaults.allowFallbackToSourceSite
    );

    // 图片验证
    const imageValidation = raw.image_validation || raw.imageValidation;
    if (imageValidation) {
      config.imageValidation = {
        enabled: this.normalizeBoolean(imageValidation.enabled, defaults.imageValidation.enabled),
        strictMode: this.normalizeBoolean(
          imageValidation.strict_mode || imageValidation.strictMode,
          defaults.imageValidation.strictMode
        )
      };
    }

    // 并发配置
    config.maxConcurrentFeeds = this.normalizeNumber(
      raw.max_concurrent_feeds || raw.maxConcurrentFeeds,
      defaults.maxConcurrentFeeds,
      { min: 1, integer: true }
    );
    config.maxConcurrentDownloads = this.normalizeNumber(
      raw.max_concurrent_downloads || raw.maxConcurrentDownloads,
      defaults.maxConcurrentDownloads,
      { min: 1, integer: true }
    );

    // 网络和重试参数
    config.requestTimeout = this.normalizeNumber(raw.request_timeout ?? raw.requestTimeout, defaults.requestTimeout, { min: 5 });
    config.connectTimeout = this.normalizeNumber(raw.connect_timeout ?? raw.connectTimeout, defaults.connectTimeout, { min: 1 });
    config.readTimeout = this.normalizeNumber(raw.read_timeout ?? raw.readTimeout, defaults.readTimeout, { min: 1 });

    // 图片过滤参数
    config.minImageBytes = this.normalizeNumber(raw.min_image_bytes ?? raw.minImageBytes, defaults.minImageBytes, { min: 0, integer: true });
    config.minImageWidth = this.normalizeNumber(raw.min_image_width ?? raw.minImageWidth, defaults.minImageWidth, { min: 0, integer: true });
    config.minImageHeight = this.normalizeNumber(raw.min_image_height ?? raw.minImageHeight, defaults.minImageHeight, { min: 0, integer: true });

    // 重试和延迟
    config.retryDelay = this.normalizeNumber(raw.retry_delay ?? raw.retryDelay, defaults.retryDelay, { min: 1 });
    config.maxRetries = this.normalizeNumber(raw.max_retries ?? raw.maxRetries, defaults.maxRetries, { min: 1, max: 20, integer: true });
    config.paginationDelay = this.normalizePaginationDelay(raw.pagination_delay ?? raw.paginationDelay, defaults.paginationDelay);

    // 去重策略
    config.dedupScope = (raw.dedup_scope || raw.dedupScope || defaults.dedupScope).toLowerCase();
    if (!['global', 'per_feed', 'by_link'].includes(config.dedupScope)) {
      config.dedupScope = defaults.dedupScope;
    }

    // 安全配置
    if (raw.security) {
      const interval = raw.security.request_interval || raw.security.requestInterval;
      config.security = {
        requestInterval: this.normalizePaginationDelay(interval, defaults.security.requestInterval)
      };
    }

    // 限流器配置
    if (raw.throttler) {
      const throttler = raw.throttler;
      config.throttler = {
        baseLimit: this.normalizeNumber(throttler.base_limit || throttler.baseLimit, defaults.throttler.baseLimit, { min: 1, integer: true }),
        minLimit: this.normalizeNumber(throttler.min_limit || throttler.minLimit, defaults.throttler.minLimit, { min: 1, integer: true }),
        maxLimit: this.normalizeNumber(throttler.max_limit || throttler.maxLimit, defaults.throttler.maxLimit, { min: 1, integer: true }),
        baseDelay: this.normalizeNumber(throttler.base_delay || throttler.baseDelay, defaults.throttler.baseDelay, { min: 0 }),
        maxDelay: this.normalizeNumber(throttler.max_delay || throttler.maxDelay, defaults.throttler.maxDelay, { min: 0 }),
        decay: this.normalizeNumber(throttler.decay, defaults.throttler.decay)
      };
    }

    // 代理和请求头
    config.proxies = Array.isArray(raw.proxies) ? raw.proxies.map(p => String(p).trim()).filter(Boolean) : defaults.proxies;
    config.domainProxies = typeof raw.domain_proxies === 'object' ? raw.domain_proxies : (raw.domainProxies || defaults.domainProxies);

    if (raw.request_headers || raw.requestHeaders) {
      config.requestHeaders = { ...defaults.requestHeaders, ...(raw.request_headers || raw.requestHeaders) };
    }
    if (raw.image_headers || raw.imageHeaders) {
      config.imageHeaders = { ...defaults.imageHeaders, ...(raw.image_headers || raw.imageHeaders) };
    }

    return config;
  }

  /**
   * 解析配置路径
   */
  resolvePaths(config) {
    const baseFolder = path.resolve(config.baseFolder);
    const logsDir = path.join(this.dataRoot, 'logs');

    return {
      baseFolder,
      databasePath: path.isAbsolute(config.dbFile)
        ? config.dbFile
        : path.join(baseFolder, config.dbFile),
      opmlPath: path.isAbsolute(config.opmlFile)
        ? config.opmlFile
        : path.join(this.dataRoot, config.opmlFile),
      activityLogPath: path.isAbsolute(config.activityLogFile)
        ? config.activityLogFile
        : path.join(this.dataRoot, config.activityLogFile),
      errorLogPath: path.isAbsolute(config.errorLogFile)
        ? config.errorLogFile
        : path.join(this.dataRoot, config.errorLogFile),
      logsDir
    };
  }

  /**
   * 持久化配置到YAML文件
   */
  async persistConfig() {
    const serialized = this.serializeConfigForYaml(this.config);
    const yamlContent = YAML.stringify(serialized, { indent: 2 });
    await fsp.writeFile(this.configFile, yamlContent, 'utf-8');
  }

  /**
   * YAML序列化前的配置转换
   */
  serializeConfigForYaml(config) {
    const converted = {};
    Object.entries(config).forEach(([key, value]) => {
      if (value === undefined) return;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        converted[this.toSnakeCase(key)] = this.serializeConfigForYaml(value);
      } else {
        converted[this.toSnakeCase(key)] = value;
      }
    });
    return converted;
  }

  /**
   * 驼峰转下划线
   */
  toSnakeCase(key) {
    return key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }

  /**
   * 工具方法：规范化布尔值
   */
  normalizeBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
  }

  /**
   * 工具方法：规范化数值
   */
  normalizeNumber(value, fallback, { min, max, integer = false } = {}) {
    const num = Number(value);
    if (Number.isNaN(num)) return fallback;
    let result = num;
    if (integer) result = Math.round(result);
    if (typeof min === 'number' && result < min) result = min;
    if (typeof max === 'number' && result > max) result = max;
    return result;
  }

  /**
   * 工具方法：规范化延迟参数
   */
  normalizePaginationDelay(value, fallback) {
    if (!value) return fallback;
    if (Array.isArray(value) && value.length === 2) {
      const [min, max] = value.map(item => Number(item));
      if (!Number.isNaN(min) && !Number.isNaN(max) && max >= min && min >= 0) {
        return [min, max];
      }
    }
    return fallback;
  }

  /**
   * 工具方法：规范化字符串数组
   */
  normalizeStringArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    if (typeof value === 'string') {
      return value.split(/[,\n]/).map(item => item.trim()).filter(Boolean);
    }
    return [];
  }

  /**
   * 更新配置
   */
  async updateConfig(partialConfig = {}) {
    const current = this.config;
    const merged = { ...current, ...partialConfig };
    const normalized = this.normalizeConfig(merged, this.buildDefaultConfig());

    this.config = normalized;
    this.paths = this.resolvePaths(normalized);

    await fsp.mkdir(this.paths.baseFolder, { recursive: true });
    await fsp.mkdir(path.dirname(this.paths.databasePath), { recursive: true });
    await fsp.mkdir(path.dirname(this.paths.activityLogPath), { recursive: true });
    await fsp.mkdir(path.dirname(this.paths.errorLogPath), { recursive: true });

    await this.persistConfig();
    return this.config;
  }

  getConfig() {
    return {
      ...this.config,
      resolved: this.paths
    };
  }
}

module.exports = ConfigManager;
