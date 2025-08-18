const EventEmitter = require('events');

/**
 * 全局事件发射器
 * 用于在应用内不同模块间解耦地传递事件。
 * 例如，当一个服务完成某个任务（如生成缩略图）时，它可以发出一个事件，
 * 而另一个服务（如 SSE 控制器）可以监听这个事件并作出响应。
 */
const eventBus = new EventEmitter();

module.exports = eventBus;
