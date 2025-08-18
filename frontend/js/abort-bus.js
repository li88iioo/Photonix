// frontend/js/abort-bus.js

// 轻量的全局 Abort 管理器
// 分组：page（路由页主请求）、search（搜索）、scroll（无限滚动分页）、thumb（缩略图轮询）、modal（模态相关）

const groupToController = new Map();

function abort(group) {
  const controller = groupToController.get(group);
  if (controller) {
    try { controller.abort(); } catch {}
    groupToController.delete(group);
  }
}

function next(group) {
  abort(group);
  const controller = new AbortController();
  groupToController.set(group, controller);
  return controller.signal;
}

function get(group) {
  const controller = groupToController.get(group);
  return controller ? controller.signal : null;
}

function abortMany(groups) {
  groups.forEach(abort);
}

export const AbortBus = { abort, next, get, abortMany };


