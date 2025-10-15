/**
 * @file abort-bus.js
 * @module AbortBus
 * @description
 * 轻量级全局 Abort 管理器，用于统一管理各类异步请求的中止操作。
 * 支持分组管理，常用分组包括：
 * - page：路由页主请求
 * - search：搜索
 * - scroll：无限滚动分页
 * - thumb：缩略图轮询
 * - modal：模态相关
 */

/** @type {Map<string, AbortController>} 组名到 AbortController 的映射 */
const groupToController = new Map();

/**
 * 中止指定组的控制器并移除
 * @param {string} group 组名
 * @returns {void}
 */
function abort(group) {
  const controller = groupToController.get(group);
  if (controller) {
    try { controller.abort(); } catch {}
    groupToController.delete(group);
  }
}

/**
 * 为指定组创建新的 AbortController，并返回其 signal。
 * 会先中止并移除该组原有的控制器。
 * @param {string} group 组名
 * @returns {AbortSignal} 新的中止信号
 */
function next(group) {
  abort(group);
  const controller = new AbortController();
  groupToController.set(group, controller);
  return controller.signal;
}

/**
 * 获取指定组当前的 AbortSignal。
 * @param {string} group 组名
 * @returns {AbortSignal|null} 当前中止信号，若无则为 null
 */
function get(group) {
  const controller = groupToController.get(group);
  return controller ? controller.signal : null;
}

/**
 * 中止多个组的控制器
 * @param {string[]} groups 组名数组
 * @returns {void}
 */
function abortMany(groups) {
  groups.forEach(abort);
}

/**
 * AbortBus 命名空间
 * @namespace AbortBus
 * @property {function(string):void} abort 中止指定组的控制器
 * @property {function(string):AbortSignal} next 为指定组创建新的控制器并返回信号
 * @property {function(string):AbortSignal|null} get 获取指定组的控制器信号
 * @property {function(string[]):void} abortMany 中止多个组的控制器
 */
export const AbortBus = { abort, next, get, abortMany };
