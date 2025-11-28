const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const settingsService = require('./settings.service');
const albumManagementService = require('./albumManagement.service');

/**
 * 默认调度配置
 */
const DEFAULT_SCHEDULE = 'off';

/**
 * 查找下次 cron 时间的最大分钟数（1年）
 */
const MAX_CRON_LOOKAHEAD_MINUTES = 525600; // 1 year

/**
 * 调度器状态对象
 */
const state = {
  current: { type: 'off', raw: DEFAULT_SCHEDULE }, // 当前调度配置
  timer: null,                                      // 定时器句柄
  running: false,                                   // 是否正在运行
  lastRunAt: null,                                  // 上次运行时间
  nextRunAt: null                                   // 下次运行时间
};

/**
 * 清除当前的定时器
 */
function clearTimer() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/**
 * 标准化手动同步调度输入
 * @param {string|number|null} input - 用户输入
 * @returns {object} - { type, raw, ... }
 * @throws {Error} - 输入无效时抛出异常
 */
function normalizeScheduleInput(input) {
  if (input == null) {
    return { type: 'off', raw: DEFAULT_SCHEDULE };
  }

  const rawValue = String(input).trim();
  if (rawValue.length === 0 || rawValue.toLowerCase() === 'off') {
    return { type: 'off', raw: DEFAULT_SCHEDULE };
  }

  // 检查数字间隔（分钟）
  if (/^\d+$/.test(rawValue)) {
    const minutes = Number(rawValue);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error('分钟间隔必须为正整数');
    }
    if (minutes > 24 * 60 * 7) {
      throw new Error('分钟间隔过大，建议小于 10080');
    }
    return { type: 'interval', raw: String(minutes), intervalMinutes: minutes };
  }

  // 否则视为 Cron 表达式
  const cron = parseCronExpression(rawValue);
  return { type: 'cron', raw: cron.raw, cron };
}

/**
 * 解析 cron 字符串为内部结构
 * @param {string} expression - Cron 表达式
 * @returns {object} - 包含匹配器等信息
 * @throws {Error} - 表达式不合法时抛出异常
 */
function parseCronExpression(expression) {
  const parts = expression.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error('Cron 表达式必须包含 5 个字段 (分 时 日 月 星期)');
  }

  const ranges = [
    { min: 0, max: 59 },  // 分钟
    { min: 0, max: 23 },  // 小时
    { min: 1, max: 31 },  // 日
    { min: 1, max: 12 },  // 月
    { min: 0, max: 6 }    // 星期
  ];

  const matchers = parts.map((part, idx) => buildCronMatcher(part, ranges[idx]));

  return {
    raw: expression,
    matchers,
    isDayOfMonthWildcard: isWildcard(parts[2]),
    isDayOfWeekWildcard: isWildcard(parts[4])
  };
}

/**
 * 检查 cron 字段是否为通配符
 * @param {string} segment 
 * @returns {boolean}
 */
function isWildcard(segment) {
  return segment === '*' || segment === '*/1';
}

/**
 * 生成某一 cron 字段的数值判定函数
 * @param {string} segment - 字段内容
 * @param {object} range - { min, max }
 * @returns {function(number):boolean}
 */
function buildCronMatcher(segment, range) {
  const cleaned = segment.trim();
  if (!cleaned) {
    throw new Error('Cron 字段不能为空');
  }

  const parts = cleaned.split(',');
  const matchers = parts.map((part) => buildCronPartMatcher(part, range));

  return (value) => matchers.some((matcher) => matcher(value));
}

/**
 * 生成 cron 单个部分匹配器
 * @param {string} part - 字段片段，如"3-5/2"
 * @param {object} range - { min, max }
 * @returns {function(number):boolean}
 */
function buildCronPartMatcher(part, range) {
  let base = part;
  let step = 1;

  // 解析步长
  if (part.includes('/')) {
    const [rangePart, stepPart] = part.split('/');
    if (!stepPart) {
      throw new Error(`Cron 步长缺失: ${part}`);
    }
    step = Number(stepPart);
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Cron 步长无效: ${part}`);
    }
    base = rangePart || '*';
  }

  let start = range.min;
  let end = range.max;

  if (base !== '*' && base.length > 0) {
    if (base.includes('-')) {
      // 范围
      const [startStr, endStr] = base.split('-');
      start = Number(startStr);
      end = Number(endStr);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
        throw new Error(`Cron 范围无效: ${part}`);
      }
    } else {
      // 单一值
      const exact = Number(base);
      if (!Number.isFinite(exact)) {
        throw new Error(`Cron 数值无效: ${part}`);
      }
      start = exact;
      end = exact;
    }
  }

  if (start < range.min || end > range.max) {
    throw new Error(`Cron 数值超出范围: ${part}`);
  }

  // 匹配器函数
  return (value) => {
    if (value < start || value > end) {
      return false;
    }
    return ((value - start) % step) === 0;
  };
}

/**
 * 立即执行一次手动同步，并处理缩略图状态更新
 * @param {string} trigger - 触发类型
 * @param {string} raw - 当前调度原始值
 */
async function runManualSync(trigger, raw) {
  if (state.running) {
    logger.debug(`${LOG_PREFIXES.AUTO_SYNC} 已有任务在运行，跳过 (${trigger})`);
    return;
  }

  state.running = true;
  try {
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 触发手动同步: trigger=${trigger}, schedule=${raw}`);
    const result = await albumManagementService.syncAlbumsAndMedia();
    state.lastRunAt = new Date();
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 手动同步完成: changes=${result?.summary?.totalChanges || 0}`);

    // 获取增量变化
    const diff = result?.diff || {};
    const addedPhotos = diff?.addedMedia?.photo || [];
    const addedVideos = diff?.addedMedia?.video || [];
    const removedPhotos = diff?.removedMedia?.photo || [];
    const removedVideos = diff?.removedMedia?.video || [];
    const removalList = [...removedPhotos, ...removedVideos];

    // 进行缩略图增量或全量同步
    if (addedPhotos.length || addedVideos.length || removalList.length) {
      const { thumbnailSyncService } = require('./settings/maintenance.service');
      const incrementalResult = thumbnailSyncService.updateThumbnailStatusIncremental({
        addedPhotos,
        addedVideos,
        removed: removalList,
        trigger: 'manual-sync-scheduler',
        waitForCompletion: false
      });
      const incrementalPromise = incrementalResult && typeof incrementalResult.then === 'function'
        ? incrementalResult
        : incrementalResult?.promise;

      if (incrementalPromise && typeof incrementalPromise.then === 'function') {
        incrementalPromise.catch((error) => {
          logger.warn(`${LOG_PREFIXES.AUTO_SYNC} 缩略图增量更新失败，尝试降级全量重建：`, error && error.message ? error.message : error);
          // 降级尝试全量同步
          const fallback = thumbnailSyncService.resyncThumbnailStatus({
            trigger: 'manual-sync-scheduler-fallback',
            waitForCompletion: false
          });
          const fallbackPromise = fallback && typeof fallback.then === 'function'
            ? fallback
            : fallback?.promise;
          if (fallbackPromise && typeof fallbackPromise.then === 'function') {
            fallbackPromise.catch((fallbackError) => {
              logger.error(`${LOG_PREFIXES.AUTO_SYNC} 缩略图全量重建失败（降级阶段）：`, fallbackError && fallbackError.message ? fallbackError.message : fallbackError);
            });
          }
        });
      }
    }

    if (trigger === 'schedule') {
      await runScheduledMaintenancePipeline();
    }
  } catch (error) {
    logger.error(`${LOG_PREFIXES.AUTO_SYNC} 手动同步失败:`, error);
  } finally {
    state.running = false;
    scheduleNextRun();
  }
}

async function runScheduledMaintenancePipeline() {
  try {
    const { triggerSyncOperation, triggerCleanupOperation } = require('./settings/maintenance.service');
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：启动缩略图补全`);
    const thumbSyncResult = await triggerSyncOperation('thumbnail');
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：缩略图补全完成 ${thumbSyncResult?.message ? `(${thumbSyncResult.message})` : ''}`.trim());

    try {
      logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：启动缩略图清理`);
      const thumbCleanupResult = await triggerCleanupOperation('thumbnail');
      logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：缩略图清理完成 ${thumbCleanupResult?.message ? `(${thumbCleanupResult.message})` : ''}`.trim());
    } catch (thumbCleanupError) {
      logger.error(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：缩略图清理失败`, thumbCleanupError);
    }

    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：启动 HLS 补全`);
    const hlsSyncResult = await triggerSyncOperation('hls');
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：HLS 补全完成 ${hlsSyncResult?.message ? `(${hlsSyncResult.message})` : ''}`.trim());

    try {
      logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：启动 HLS 清理`);
      const hlsCleanupResult = await triggerCleanupOperation('hls');
      logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：HLS 清理完成 ${hlsCleanupResult?.message ? `(${hlsCleanupResult.message})` : ''}`.trim());
    } catch (hlsCleanupError) {
      logger.error(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：HLS 清理失败`, hlsCleanupError);
    }
  } catch (pipelineError) {
    logger.error(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：维护流水线执行失败`, pipelineError);
  }
}

/**
 * 计算下次应运行的时间（根据当前调度）
 * @returns {Date|null} 若未找到合适时间则返回null
 */
function computeNextRun() {
  if (state.current.type === 'off') {
    return null;
  }

  if (state.current.type === 'interval') {
    const base = state.lastRunAt ? state.lastRunAt.getTime() : Date.now();
    const nextTs = base + state.current.intervalMinutes * 60000;
    return new Date(Math.max(nextTs, Date.now() + 1000));
  }

  const now = new Date();
  now.setSeconds(0, 0);
  const start = new Date(now.getTime() + 60000); // 下一分钟开始

  for (let i = 0; i < MAX_CRON_LOOKAHEAD_MINUTES; i++) {
    const candidate = new Date(start.getTime() + i * 60000);
    if (matchesCron(state.current.cron, candidate)) {
      return candidate;
    }
  }

  logger.warn(`${LOG_PREFIXES.AUTO_SYNC} 未能在 1 年内找到下次运行时间，停止调度。`);
  return null;
}

/**
 * 检查给定时间是否满足 cron 匹配
 * @param {object} cron - 由parseCronExpression生成的cron对象
 * @param {Date} date - 时间点
 * @returns {boolean}
 */
function matchesCron(cron, date) {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  const minuteMatch = cron.matchers[0](minute);
  const hourMatch = cron.matchers[1](hour);
  const domMatch = cron.matchers[2](day);
  const monthMatch = cron.matchers[3](month);
  const dowMatch = cron.matchers[4](dow);

  // 必须分钟、小时、月份都满足
  if (!minuteMatch || !hourMatch || !monthMatch) {
    return false;
  }

  const domWildcard = cron.isDayOfMonthWildcard;
  const dowWildcard = cron.isDayOfWeekWildcard;

  // 日和星期均为通配符则通过
  if (domWildcard && dowWildcard) {
    return true;
  }

  // 只要有一个指定且命中即可
  if (!domWildcard && domMatch) {
    return true;
  }

  if (!dowWildcard && dowMatch) {
    return true;
  }

  // 皆指定时必须皆命中
  return domMatch && dowMatch;
}

/**
 * 安排下次自动同步任务
 */
function scheduleNextRun() {
  clearTimer();

  if (state.current.type === 'off') {
    state.nextRunAt = null;
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护已关闭`);
    return;
  }

  const nextRun = computeNextRun();
  if (!nextRun) {
    state.nextRunAt = null;
    return;
  }

  state.nextRunAt = nextRun;
  const delay = Math.max(nextRun.getTime() - Date.now(), 1000);
  const localTime = nextRun.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  logger.info(`${LOG_PREFIXES.AUTO_SYNC} 下次手动同步时间: ${localTime}`);
  state.timer = setTimeout(() => runManualSync('schedule', state.current.raw), delay);
}

/**
 * 初始化手动同步调度器（读取当前设置并应用）
 */
async function initialize() {
  try {
    const settings = await settingsService.getAllSettings({ preferFreshSensitive: true });
    const configured = settings?.MANUAL_SYNC_SCHEDULE || DEFAULT_SCHEDULE;
    applySchedule(configured, false);
  } catch (error) {
    logger.error(`${LOG_PREFIXES.AUTO_SYNC} 初始化失败:`, error);
  }
}

/**
 * 应用/切换调度设置，并重设下一次运行时间
 * @param {string|object} value - 新调度值
 * @param {boolean} logChange - 是否打印日志
 * @returns {object} - 规范化后的调度对象
 */
function applySchedule(value, logChange = true) {
  const normalized = normalizeScheduleInput(value);

  state.current = normalized;
  if (logChange) {
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 更新自动维护计划: ${normalized.raw}`);
  }
  scheduleNextRun();

  return normalized;
}

/**
 * 更新调度并保存到设置
 * @param {string|object} value 
 * @returns {object} - 规范化后的调度对象
 */
async function updateSchedule(value) {
  const normalized = normalizeScheduleInput(value);
  await settingsService.updateSettings({ MANUAL_SYNC_SCHEDULE: normalized.raw });
  applySchedule(normalized.raw);
  return normalized;
}

/**
 * 获取当前调度状态
 */
function getStatus() {
  return {
    schedule: state.current.raw,
    type: state.current.type,
    running: state.running,
    lastRunAt: state.lastRunAt ? state.lastRunAt.toISOString() : null,
    nextRunAt: state.nextRunAt ? state.nextRunAt.toISOString() : null
  };
}

module.exports = {
  initialize,
  updateSchedule,
  applySchedule,
  normalizeScheduleInput,
  getStatus,
  runManualSync: () => runManualSync('manual-trigger', state.current.raw)
};
