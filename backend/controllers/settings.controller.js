const bcrypt = require('bcryptjs');
const logger = require('../config/logger');
const settingsService = require('../services/settings.service');
const { settingsWorker } = require('../services/worker.manager'); // 兼容保留
const { settingsUpdateQueue } = require('../config/redis');

// 存储最近的设置更新状态（向后兼容，同时引入基于ID的 Map 存储）
let lastSettingsUpdateStatus = null;
const updateStatusMap = new Map(); // key: updateId, value: { status, message, updatedKeys, timestamp }

// 获取设置的逻辑不变
exports.getSettingsForClient = async (req, res) => {
    const allSettings = await settingsService.getAllSettings();
    const clientSettings = {
        // 仅公开非敏感字段；AI_URL/AI_MODEL/AI_PROMPT 不对外返回
        AI_ENABLED: allSettings.AI_ENABLED,
        PASSWORD_ENABLED: allSettings.PASSWORD_ENABLED,
        hasPassword: !!(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== ''),
        isAdminSecretConfigured: !!(process.env.ADMIN_SECRET && process.env.ADMIN_SECRET.trim() !== '')
    };
    res.json(clientSettings);
};

// 通用旧密码或管理员密钥校验函数
async function verifyAdminSecret(adminSecret) {
    // 首先检查服务器是否配置了ADMIN_SECRET
    if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET.trim() === '') {
        logger.warn('安全操作失败：管理员密钥未在.env文件中配置。');
        return { ok: false, code: 500, msg: '管理员密钥未在服务器端配置，无法执行此操作' };
    }

    // 然后检查用户是否提供了密钥
    if (!adminSecret || adminSecret.trim() === '') {
        return { ok: false, code: 400, msg: '必须提供管理员密钥' };
    }

    // 最后验证密钥是否正确
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return { ok: false, code: 401, msg: '管理员密钥错误' };
    }

    logger.info('管理员密钥验证成功');
    return { ok: true };
}

// 更新设置的逻辑改变
exports.updateSettings = async (req, res) => {
        const { newPassword, adminSecret, ...rawSettings } = req.body;

        // 明确禁止持久化 AI 密钥相关字段
        const forbiddenKeys = ['AI_KEY', 'AI_API_KEY', 'OPENAI_API_KEY'];
        const settingsToUpdate = Object.fromEntries(
            Object.entries(rawSettings).filter(([k]) => !forbiddenKeys.includes(k))
        );

        const allSettings = await settingsService.getAllSettings();
        const passwordIsCurrentlySet = !!(allSettings.PASSWORD_HASH && allSettings.PASSWORD_HASH !== '');

        const isTryingToSetOrChangePassword = newPassword && newPassword.trim() !== '';
        const isTryingToDisablePassword = Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') && settingsToUpdate.PASSWORD_ENABLED === 'false';

        // 敏感操作指的是修改或禁用一个已经存在的密码
        const isSensitiveOperation = (isTryingToSetOrChangePassword || isTryingToDisablePassword) && passwordIsCurrentlySet;

        // --- 审计辅助：构建安全的审计上下文（不写入敏感值） ---
        function buildAuditContext(extra) {
            const headerUserId = req.headers['x-user-id'] || req.headers['x-userid'] || req.headers['x-user'];
            const userId = (req.user && req.user.id) ? String(req.user.id) : (headerUserId ? String(headerUserId) : 'anonymous');
            return {
                requestId: req.requestId || '-',
                ip: req.ip,
                userId,
                ...extra
            };
        }

        if (isSensitiveOperation) {
            const verifyResult = await verifyAdminSecret(adminSecret);
            if (!verifyResult.ok) {
                // 审计：敏感操作校验失败
                logger.warn(JSON.stringify(buildAuditContext({
                    action: 'update_settings',
                    sensitive: true,
                    status: 'denied',
                    reason: verifyResult.msg
                })));
                return res.status(verifyResult.code).json({ error: verifyResult.msg });
            }
        }

        // 根据操作类型，更新密码哈希
        if (isTryingToSetOrChangePassword) {
            logger.info('正在为新密码生成哈希值...');
            const salt = await bcrypt.genSalt(10);
            settingsToUpdate.PASSWORD_HASH = await bcrypt.hash(newPassword, salt);
        } else if (isTryingToDisablePassword && passwordIsCurrentlySet) {
            settingsToUpdate.PASSWORD_HASH = '';
        }
        
        // 开启密码访问时，若数据库无密码，必须强制要求设置新密码
        if (
            Object.prototype.hasOwnProperty.call(settingsToUpdate, 'PASSWORD_ENABLED') &&
            settingsToUpdate.PASSWORD_ENABLED === 'true' &&
            !passwordIsCurrentlySet && !isTryingToSetOrChangePassword
        ) {
            return res.status(400).json({ error: '请设置新密码以启用密码访问' });
        }

        // 检查是否包含认证相关设置（密码或AI配置）
        const authRelatedKeys = ['PASSWORD_ENABLED', 'PASSWORD_HASH', 'AI_ENABLED', 'AI_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_PROMPT'];
        const hasAuthChanges = Object.keys(settingsToUpdate).some(key => authRelatedKeys.includes(key));

        // 使用时间戳+随机串作为唯一ID，降低并发碰撞概率
        const updateId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // 设置初始状态
        const initialStatus = {
            timestamp: updateId,
            status: 'pending',
            updatedKeys: Object.keys(settingsToUpdate)
        };
        lastSettingsUpdateStatus = initialStatus; // 兼容旧查询
        updateStatusMap.set(updateId, initialStatus);
        
        // 首选：投递到 BullMQ 队列（持久化、可重试）
        try {
            await settingsUpdateQueue.add('update_settings', { settingsToUpdate, updateId });
            logger.info('设置更新任务已投递到队列');
        } catch (e) {
            logger.warn('投递到设置队列失败，降级使用线程消息：', e && e.message);
            try { settingsWorker.postMessage({ type: 'update_settings', payload: { settingsToUpdate, updateId } }); } catch {}
        }

        if (hasAuthChanges) {
            // 对于认证相关设置，异步处理，立即返回202 Accepted
            logger.info('检测到认证相关设置变更，任务已提交到后台处理...');

            // 审计：敏感相关变更已提交
            logger.info(JSON.stringify(buildAuditContext({
                action: 'update_settings',
                sensitive: true,
                status: 'submitted',
                updatedKeys: Object.keys(settingsToUpdate)
            })));

            // 立即返回202，告知客户端任务已接受，并提供查询ID
            return res.status(202).json({ 
                success: true, 
                message: '设置更新任务已接受，正在后台处理',
                status: 'pending',
                updateId
            });
        } else {
            // 对于非认证相关设置，立即返回成功
            logger.info('非认证相关设置变更，立即返回成功');

            // 审计：非敏感设置已提交
            logger.info(JSON.stringify(buildAuditContext({
                action: 'update_settings',
                sensitive: false,
                status: 'submitted',
                updatedKeys: Object.keys(settingsToUpdate)
            })));

            res.json({ 
                success: true, 
                message: '配置更新任务已提交',
                status: 'submitted',
                updateId
            });
        }
};

// 新增：获取设置更新状态
exports.getSettingsUpdateStatus = async (req, res) => {
    const id = req.query?.id || req.body?.id;
    if (id && updateStatusMap.has(id)) {
        const st = updateStatusMap.get(id);
        if (st.status === 'pending' && Date.now() - (Number(st.timestamp.split('-')[0]) || Date.now()) > 30000) {
            st.status = 'timeout';
        }
        // 优先读取 worker 写入的 Redis 状态以获得最终态
        try {
            const { redis } = require('../config/redis');
            const raw = await redis.get(`settings_update_status:${id}`);
            if (raw) {
                const parsed = JSON.parse(raw);
                return res.json({ status: parsed.status, timestamp: st.timestamp, updatedKeys: parsed.updatedKeys || st.updatedKeys, message: parsed.message || null });
            }
        } catch {}
        return res.json({ status: st.status, timestamp: st.timestamp, updatedKeys: st.updatedKeys, message: st.message || null });
    }
    if (lastSettingsUpdateStatus) {
        const st = lastSettingsUpdateStatus;
        if (st.status === 'pending' && Date.now() - (Number(String(st.timestamp).split('-')[0]) || Date.now()) > 30000) {
            st.status = 'timeout';
        }
        return res.json({ status: st.status, timestamp: st.timestamp, updatedKeys: st.updatedKeys, message: st.message || null });
    }
    return res.status(404).json({ error: '没有找到最近的设置更新记录' });
};

// 导出函数供 indexer.service.js 调用
exports.updateSettingsStatus = (status, message = null, updateId = null) => {
    if (updateId && updateStatusMap.has(updateId)) {
        const st = updateStatusMap.get(updateId);
        st.status = status;
        st.message = message;
        lastSettingsUpdateStatus = st; // 顺带刷新最后一次
    } else if (lastSettingsUpdateStatus) {
        lastSettingsUpdateStatus.status = status;
        lastSettingsUpdateStatus.message = message;
    }
};