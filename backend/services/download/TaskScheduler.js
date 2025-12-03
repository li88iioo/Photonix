/**
 * @file TaskScheduler.js
 * @description 任务调度管理器，负责RSS任务的定时执行和调度
 */

const { CronJob } = require('cron');
const { Mutex } = require('async-mutex');

class TaskScheduler {
  constructor(logManager) {
    this.logManager = logManager;
    this.taskLocks = new Map();     // 任务互斥锁
    this.taskTimers = new Map();    // 定时器引用集合
    this.cronJobs = new Map();      // cron job 实例集合
    this.activeRuns = 0;            // 当前正在执行的 feed 数量
  }

  /**
   * 获取（若无则新建）任务互斥锁
   * @param {string} taskId 
   * @returns {Mutex}
   */
  getTaskMutex(taskId) {
    if (!this.taskLocks.has(taskId)) {
      this.taskLocks.set(taskId, new Mutex());
    }
    return this.taskLocks.get(taskId);
  }

  /**
   * 清除定时器/cronjob
   * @param {string} taskId 
   */
  clearSchedule(taskId) {
    if (this.taskTimers.has(taskId)) {
      clearTimeout(this.taskTimers.get(taskId));
      this.taskTimers.delete(taskId);
    }
    if (this.cronJobs.has(taskId)) {
      const job = this.cronJobs.get(taskId);
      job.stop();
      this.cronJobs.delete(taskId);
    }
  }

  /**
   * 调度订阅任务：配置定时器 或 cronjob
   * @param {object} task 
   * @param {function} executeCallback 执行任务的回调函数
   * @param {object} options 
   */
  scheduleTask(task, executeCallback, options = {}) {
    this.clearSchedule(task.id);

    if (task.status !== 'running') {
      task.schedule.next = null;
      return;
    }

    const resolved = this.resolveInterval(task.interval);
    const immediate = options.immediate === true;

    if (!resolved) {
      task.schedule.next = null;
      return;
    }

    if (typeof resolved === 'string') {
      // Cron表达式
      try {
        const job = new CronJob(
          resolved, // cronTime
          () => {   // onTick
            executeCallback(task.id).catch((error) => {
              if (this.logManager) {
                this.logManager.log('error', '自动执行任务失败', {
                  taskId: task.id,
                  error: error.message
                });
              }
            });
          },
          null,     // onComplete
          true,     // start immediately
          Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' // timeZone
        );
        this.cronJobs.set(task.id, job);
        task.schedule.next = null;
        if (immediate) {
          executeCallback(task.id).catch((error) => {
            if (this.logManager) {
              this.logManager.log('error', '任务即时执行失败', {
                taskId: task.id,
                error: error.message
              });
            }
          });
        }
      } catch (error) {
        if (this.logManager) {
          this.logManager.log('error', 'Cron 表达式无效，任务暂停', {
            taskId: task.id,
            interval: task.interval,
            error: error.message
          });
        }
        task.status = 'paused';
      }
      return;
    }

    // 定时器调度
    const nextRun = new Date(Date.now() + resolved);
    task.schedule.next = nextRun.toISOString();

    const timer = setTimeout(() => {
      executeCallback(task.id).catch((error) => {
        if (this.logManager) {
          this.logManager.log('error', '定时执行任务失败', {
            taskId: task.id,
            error: error.message
          });
        }
      });
    }, immediate ? 250 : resolved);

    this.taskTimers.set(task.id, timer);
  }

  /**
   * 统一解析 interval（支持时间字符串/cron/毫秒数字）
   * @param {string|number} interval 
   * @returns {number|string|null} 毫秒数 或 cron 字符串 或 null
   */
  resolveInterval(interval) {
    if (!interval) return null;
    const value = String(interval).trim().toLowerCase();

    if (!value || value === 'manual' || value === 'off' || value === 'pause') {
      return null;
    }

    if (/^\d+$/.test(value)) {
      return Number(value) * 1000;
    }

    if (value.endsWith('ms')) {
      return Number(value.replace('ms', ''));
    }

    if (value.endsWith('s')) {
      return Number(value.replace('s', '')) * 1000;
    }

    if (value.endsWith('m')) {
      return Number(value.replace('m', '')) * 60 * 1000;
    }

    if (value.endsWith('h')) {
      return Number(value.replace('h', '')) * 60 * 60 * 1000;
    }

    if (value.endsWith('d')) {
      return Number(value.replace('d', '')) * 24 * 60 * 60 * 1000;
    }

    if (this.isValidCronExpression(value)) {
      return value;
    }

    return null;
  }

  /**
   * 判断字符串是否为有效的 cron 表达式（5-7 字段有效）
   * @param {string} value 
   * @returns {boolean}
   */
  isValidCronExpression(value) {
    if (!value) return false;
    const parts = value.trim().split(/\s+/);
    return parts.length >= 5 && parts.length <= 7;
  }

  /**
   * 获取全局任务执行 slot（限流）
   * @param {number} maxConcurrentFeeds 
   */
  async acquireGlobalSlot(maxConcurrentFeeds) {
    const max = Math.max(1, maxConcurrentFeeds);
    while (this.activeRuns >= max) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    this.activeRuns += 1;
  }

  /**
   * 释放全局任务 slot
   */
  releaseGlobalSlot() {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
  }

  /**
   * 清理所有资源
   */
  cleanup() {
    for (const taskId of this.taskTimers.keys()) {
      this.clearSchedule(taskId);
    }
    this.taskLocks.clear();
  }
}

module.exports = TaskScheduler;
