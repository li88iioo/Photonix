const eventBus = require('../services/event.service.js');
const logger = require('../config/logger');

// 环境检测：开发环境显示详细日志
const isDevelopment = process.env.NODE_ENV !== 'production';

// 保存活跃的客户端连接
const clients = new Set();

/**
 * 处理 SSE 事件流请求
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
exports.streamEvents = (req, res) => {
    // 1. 设置 SSE 头部
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    try { req.socket && req.socket.setKeepAlive && req.socket.setKeepAlive(true); } catch {}
    try { res.flushHeaders && res.flushHeaders(); } catch {}

    // 获取客户端真实 IP 地址
    const getClientIP = (req) => {
        // 优先从代理头获取真实 IP
        const forwardedFor = req.headers['x-forwarded-for'];
        if (forwardedFor) {
            return forwardedFor.split(',')[0].trim();
        }
        
        const realIP = req.headers['x-real-ip'];
        if (realIP) {
            return realIP;
        }
        
        // 回退到连接 IP
        return req.connection?.remoteAddress || 
               req.socket?.remoteAddress || 
               req.ip || 
               'unknown';
    };

    const clientIP = getClientIP(req);
    
    // 为这个客户端创建一个唯一的ID
    const clientId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    clients.add(clientId);
    logger.info(`[SSE] 新客户端连接: ${clientId} (IP: ${clientIP}, 当前共 ${clients.size} 个连接)`);

    // 2. 定义一个函数，用于向客户端发送格式化的 SSE 消息
    const sendEvent = (eventName, data) => {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 3. 定义事件监听器
    const onThumbnailGenerated = (data) => {
        if (isDevelopment) {
            logger.debug(`[SSE] 监听到 thumbnail-generated 事件，将发送给 ${clientId}`);
        }
        sendEvent('thumbnail-generated', data);
    };

    // 4. 将监听器附加到事件总线
    eventBus.on('thumbnail-generated', onThumbnailGenerated);

    // 5. 发送一个初始连接成功的消息
    sendEvent('connected', { message: 'SSE connection established.', clientId });

    // 7. 当客户端断开连接时，清理资源
    req.on('close', () => {
        eventBus.removeListener('thumbnail-generated', onThumbnailGenerated);
        clearInterval(keepAliveInterval);
        clients.delete(clientId);
        logger.info(`[SSE] 客户端断开连接: ${clientId} (IP: ${clientIP}, 剩余 ${clients.size} 个连接)`);
    });

    // 8. 添加错误处理和额外的断开检测
    req.on('error', (err) => {
        logger.warn(`[SSE] 客户端连接错误 ${clientId}:`, err);
        cleanup();
    });

    req.socket.on('error', (err) => {
        logger.warn(`[SSE] 客户端Socket错误 ${clientId}:`, err);
        cleanup();
    });

    req.socket.on('close', () => {
        logger.debug(`[SSE] 客户端Socket关闭 ${clientId}`);
        cleanup();
    });

    // 9. 改进的keep-alive，检测客户端是否还在接收数据
    const keepAliveInterval = setInterval(() => {
        try {
            // 检查连接是否还活跃
            if (res.destroyed || req.destroyed) {
                cleanup();
                return;
            }
            
            // 发送keep-alive并检查是否成功
            const success = res.write(': keep-alive\n\n');
            if (!success) {
                logger.debug(`[SSE] Keep-alive写入失败，客户端可能已断开 ${clientId}`);
                cleanup();
            }
        } catch (error) {
            logger.debug(`[SSE] Keep-alive发送失败，清理连接 ${clientId}:`, error);
            cleanup();
        }
    }, 15000);

    // 10. 统一的清理函数
    function cleanup() {
        try {
            eventBus.removeListener('thumbnail-generated', onThumbnailGenerated);
            clearInterval(keepAliveInterval);
            clients.delete(clientId);
            
            // 尝试关闭响应
            if (!res.destroyed) {
                res.end();
            }
            
            logger.info(`[SSE] 客户端连接已清理: ${clientId} (IP: ${clientIP}, 剩余 ${clients.size} 个连接)`);
        } catch (error) {
            logger.error(`[SSE] 清理客户端连接时出错 ${clientId}:`, error);
        }
    }
};

/**
 * 获取当前SSE连接状态
 * 用于监控和调试SSE连接问题
 */
exports.getConnectionStatus = () => {
    return {
        activeConnections: clients.size,
        timestamp: new Date().toISOString(),
        connections: Array.from(clients).map(clientId => ({
            clientId,
            connectedAt: clientId.split('-')[0] // 从clientId提取时间戳
        }))
    };
};
