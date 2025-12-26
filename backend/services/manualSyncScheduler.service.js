const { CronJob, CronTime } = require('cron');
const logger = require('../config/logger');
const { LOG_PREFIXES } = logger;
const settingsService = require('./settings.service');
const albumManagementService = require('./albumManagement.service');
const {
  thumbnailSyncService,
  triggerSyncOperation,
  triggerCleanupOperation
} = require('./settings/maintenance.service');

/**
 * 默认调度配置
 */
const DEFAULT_SCHEDULE = 'off';

/**
 * 调度器状态对象
 */
const state = {
  current: { type: 'off', raw: DEFAULT_SCHEDULE }, // 当前调度配置
  timer: null,                                      // 定时器句柄
  cronJob: null,                                    // Cron 任务
  running: false,                                   // 是否正在运行
  lastRunAt: null,                                  // 上次运行时间
  nextRunAt: null,                                  // 下次运行时间
  pipelineRunning: false                            // 维护流水线运行互斥
};

/**
 * 清除当前的定时器
 */
function clearTimer() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.cronJob) {
    try {
      state.cronJob.stop();
    } catch (error) {
      logger.debug(`${LOG_PREFIXES.AUTO_SYNC} 停止 Cron 任务失败`, error);
    }
    state.cronJob = null;
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
  const cronExpression = validateCronExpression(rawValue);
  return { type: 'cron', raw: cronExpression };
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

  if (state.pipelineRunning) {
    logger.debug(`${LOG_PREFIXES.AUTO_SYNC} 自动维护流水线运行中，跳过本次手动触发 (${trigger})`);
    return;
  }

  state.running = true;
  try {
    const isScheduled = trigger === 'schedule';
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 开始${isScheduled ? '自动' : '手动'}维护周期: trigger=${trigger}, schedule=${raw}`);

    if (isScheduled) {
      await runScheduledMaintenancePipeline();
    }

    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 启动索引同步`);
    const result = await albumManagementService.syncAlbumsAndMedia();
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 手动同步完成: changes=${result?.summary?.totalChanges || 0}`);

    // 获取增量变化
    const diff = result?.diff || {};
    const addedPhotos = Array.isArray(diff?.addedMedia?.photo) ? diff.addedMedia.photo : [];
    const addedVideos = Array.isArray(diff?.addedMedia?.video) ? diff.addedMedia.video : [];
    const removedPhotos = Array.isArray(diff?.removedMedia?.photo) ? diff.removedMedia.photo : [];
    const removedVideos = Array.isArray(diff?.removedMedia?.video) ? diff.removedMedia.video : [];
    const removalList = [...removedPhotos, ...removedVideos];

    // 进行缩略图增量或全量同步
    if (addedPhotos.length || addedVideos.length || removalList.length) {
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

  } catch (error) {
    logger.error(`${LOG_PREFIXES.AUTO_SYNC} 手动同步失败:`, error);
  } finally {
    state.lastRunAt = new Date();
    state.running = false;
    if (state.current.type === 'interval') {
      scheduleNextRun();
    } else if (state.current.type === 'cron') {
      refreshCronNextRun();
    }
  }
}

async function runScheduledMaintenancePipeline() {
  if (state.pipelineRunning) {
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护流水线已在运行，跳过本次触发`);
    return;
  }
  state.pipelineRunning = true;
  try {
    try {
      logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：启动缩略图同步`);
      const resyncResult = await thumbnailSyncService.resyncThumbnailStatus({
        trigger: 'auto-sync',
        waitForCompletion: true,
        skipIfRunning: true
      });
      if (resyncResult?.skipped || resyncResult?.inProgress) {
        logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：缩略图同步已在运行，跳过本次触发`);
      } else if (resyncResult) {
        logger.info(
          `${LOG_PREFIXES.AUTO_SYNC} 自动维护：缩略图同步完成 (total=${resyncResult.syncedCount}, exists=${resyncResult.existsCount}, missing=${resyncResult.missingCount})`
        );
      }
    } catch (thumbResyncError) {
      logger.error(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：缩略图同步失败`, thumbResyncError);
    }

    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：启动缩略图补全`);
    const thumbSyncResult = await triggerSyncOperation('thumbnail');
    const thumbMessage = thumbSyncResult?.message ? `(${thumbSyncResult.message})` : '';
    logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：缩略图补全完成 ${thumbMessage}`.trim());

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
      const hlsCleanupMessage = hlsCleanupResult?.message ? `(${hlsCleanupResult.message})` : '';
      logger.info(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：HLS 清理完成 ${hlsCleanupMessage}`.trim());
    } catch (hlsCleanupError) {
      logger.error(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：HLS 清理失败`, hlsCleanupError);
    }
  } catch (pipelineError) {
    logger.error(`${LOG_PREFIXES.AUTO_SYNC} 自动维护：维护流水线执行失败`, pipelineError);
  } finally {
    state.pipelineRunning = false;
  }
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

  if (state.current.type === 'interval') {
    const nextRun = computeNextIntervalRun();
    if (!nextRun) {
      state.nextRunAt = null;
      return;
    }
    state.nextRunAt = nextRun;
    const delay = Math.max(nextRun.getTime() - Date.now(), 1000);
    logNextRunTime(nextRun);
    state.timer = setTimeout(() => runManualSync('schedule', state.current.raw), delay);
    return;
  }

  try {
    state.cronJob = new CronJob(state.current.raw, () => runManualSync('schedule', state.current.raw), null, false);
    refreshCronNextRun();
    logNextRunTime(state.nextRunAt);
    state.cronJob.start();
  } catch (error) {
    state.nextRunAt = null;
    logger.error(`${LOG_PREFIXES.AUTO_SYNC} 启动 Cron 任务失败: ${error && error.message ? error.message : error}`);
  }
}

function computeNextIntervalRun() {
  const base = state.lastRunAt ? state.lastRunAt.getTime() : Date.now();
  const nextTs = base + state.current.intervalMinutes * 60000;
  return new Date(Math.max(nextTs, Date.now() + 1000));
}

function refreshCronNextRun() {
  if (state.current.type !== 'cron') {
    return;
  }
  state.nextRunAt = getNextCronDate(state.current.raw);
}

function getNextCronDate(expression) {
  try {
    const cronTime = new CronTime(expression);
    const next = cronTime.sendAt();
    return next ? next.toJSDate() : null;
  } catch (error) {
    logger.debug(`${LOG_PREFIXES.AUTO_SYNC} 计算 Cron 下次运行时间失败`, error && error.message ? error.message : error);
    return null;
  }
}

function logNextRunTime(date) {
  if (!date) return;
  const localTime = date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  logger.info(`${LOG_PREFIXES.AUTO_SYNC} 下次手动同步时间: ${localTime}`);
}

function validateCronExpression(expression) {
  try {
    // CronTime 会在构造时校验表达式
    // eslint-disable-next-line no-new
    new CronTime(expression);
    return expression;
  } catch (error) {
    throw new Error(error && error.message ? error.message : 'Cron 表达式无效');
  }
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
