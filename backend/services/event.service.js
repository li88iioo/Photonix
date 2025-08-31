const EventEmitter = require('events');
const { redis } = require('../config/redis');
const logger = require('../config/logger');

// 环境检测：开发环境显示详细日志
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * 全局事件发射器
 * 用于在应用内不同模块间解耦地传递事件。
 * 例如，当一个服务完成某个任务（如生成缩略图）时，它可以发出一个事件，
 * 而另一个服务（如 SSE 控制器）可以监听这个事件并作出响应。
 */
const eventBus = new EventEmitter();

// 设置Redis订阅器，监听跨进程事件
let redisSubscriber = null;

function setupRedisSubscriber() {
	if (!redis || redisSubscriber) return;

	try {
		redisSubscriber = redis.duplicate();
		redisSubscriber.subscribe('thumbnail-generated', (err) => {
			if (err) {
				logger.error('[SSE] Redis订阅失败:', err);
				return;
			}
			logger.debug('[SSE] 已订阅 thumbnail-generated 频道');
		});

		redisSubscriber.on('message', (channel, message) => {
			if (channel === 'thumbnail-generated') {
				try {
					const data = JSON.parse(message);
					logger.debug(`[SSE] 收到跨进程事件: ${data.path}`);
					eventBus.emit('thumbnail-generated', data);
				} catch (error) {
					logger.error('[SSE] 解析跨进程消息失败:', error);
				}
			}
		});

		if (isDevelopment) {
			logger.info('[SSE] Redis订阅器已启动');
		}
	} catch (error) {
		logger.error('[SSE] 启动Redis订阅器失败:', error);
	}
}

// 启动Redis订阅器
setupRedisSubscriber();

module.exports = eventBus;
