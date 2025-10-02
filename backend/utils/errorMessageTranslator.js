/**
 * 统一的错误消息转换工具
 * 提供标准化的错误消息本地化和转换功能
 */

/**
 * 错误消息翻译器类
 */
class ErrorMessageTranslator {
    constructor() {
        // 错误消息映射表
        this.messageMap = {
            // Sharp相关错误
            'WebP': 'WebP 文件头损坏或格式异常，无法解析',
            'unable to parse image': '图片文件损坏或格式异常，无法解析',
            'corrupt header': '文件头损坏，无法解析',
            'Invalid marker': 'JPEG 文件损坏或不完整，无法解析',
            'bad': 'PNG 文件损坏或格式异常，无法解析',
            'invalid': '文件格式异常，无法解析',

            // 文件系统错误
            'ENOENT': '文件或目录不存在',
            'EACCES': '访问被拒绝，权限不足',
            'ENOTDIR': '路径不是目录',
            'EISDIR': '路径是目录，不是文件',
            'EMFILE': '打开的文件太多',
            'ENOSPC': '磁盘空间不足',

            // 数据库错误
            'SQLITE_BUSY': '数据库忙碌，请稍后重试',
            'SQLITE_LOCKED': '数据库被锁定',
            'SQLITE_CORRUPT': '数据库文件损坏',
            'SQLITE_FULL': '数据库磁盘空间不足',

            // 网络错误
            'ECONNREFUSED': '连接被拒绝',
            'ECONNRESET': '连接被重置',
            'ETIMEDOUT': '连接超时',
            'ENOTFOUND': '主机未找到',

            // Redis错误
            'Redis connection': 'Redis连接失败',
            'Redis timeout': 'Redis操作超时',

            // FFmpeg相关错误
            'ffmpeg': '视频处理失败',
            'avconv': '视频转换失败',
            'moov atom': '视频文件格式异常',
            'stream': '视频流处理失败'
        };

        // 错误类型映射
        this.typeMap = {
            'sharp': this.translateSharpError.bind(this),
            'filesystem': this.translateFileSystemError.bind(this),
            'database': this.translateDatabaseError.bind(this),
            'network': this.translateNetworkError.bind(this),
            'redis': this.translateRedisError.bind(this),
            'ffmpeg': this.translateFFmpegError.bind(this),
            'generic': this.translateGenericError.bind(this)
        };
    }

    /**
     * 翻译Sharp相关的错误
     * @param {string} message - 原始错误消息
     * @returns {string} 翻译后的消息
     */
    translateSharpError(message) {
        const msg = String(message || '').toLowerCase();

        if (msg.includes('webp') && (msg.includes('unable to parse image') || msg.includes('corrupt header'))) {
            return 'WebP 文件头损坏或格式异常，无法解析';
        }
        if (msg.includes('invalid marker') || msg.includes('jpeg')) {
            return 'JPEG 文件损坏或不完整，无法解析';
        }
        if (msg.includes('png') && (msg.includes('bad') || msg.includes('invalid'))) {
            return 'PNG 文件损坏或格式异常，无法解析';
        }

        return this.translateGenericError(message);
    }

    /**
     * 翻译文件系统错误
     * @param {string} message - 原始错误消息
     * @param {string} code - 错误代码
     * @returns {string} 翻译后的消息
     */
    translateFileSystemError(message, code) {
        if (code && this.messageMap[code]) {
            return this.messageMap[code];
        }

        const msg = String(message || '').toLowerCase();

        for (const [key, translation] of Object.entries(this.messageMap)) {
            if (key.startsWith('E') && msg.includes(key.toLowerCase())) {
                return translation;
            }
        }

        return this.translateGenericError(message);
    }

    /**
     * 翻译数据库错误
     * @param {string} message - 原始错误消息
     * @param {string} code - 错误代码
     * @returns {string} 翻译后的消息
     */
    translateDatabaseError(message, code) {
        const msg = String(message || '').toLowerCase();

        if (msg.includes('sqlite_') || code === 'SQLITE_ERROR') {
            for (const [key, translation] of Object.entries(this.messageMap)) {
                if (key.startsWith('SQLITE_') && msg.includes(key.toLowerCase())) {
                    return translation;
                }
            }
        }

        return this.translateGenericError(message);
    }

    /**
     * 翻译网络错误
     * @param {string} message - 原始错误消息
     * @param {string} code - 错误代码
     * @returns {string} 翻译后的消息
     */
    translateNetworkError(message, code) {
        if (code && this.messageMap[code]) {
            return this.messageMap[code];
        }

        const msg = String(message || '').toLowerCase();

        for (const [key, translation] of Object.entries(this.messageMap)) {
            if (key.startsWith('E') && msg.includes(key.toLowerCase())) {
                return translation;
            }
        }

        return this.translateGenericError(message);
    }

    /**
     * 翻译Redis错误
     * @param {string} message - 原始错误消息
     * @returns {string} 翻译后的消息
     */
    translateRedisError(message) {
        const msg = String(message || '').toLowerCase();

        if (msg.includes('redis') || msg.includes('connection')) {
            return this.messageMap['Redis connection'] || 'Redis连接错误';
        }
        if (msg.includes('timeout')) {
            return this.messageMap['Redis timeout'] || 'Redis操作超时';
        }

        return this.translateGenericError(message);
    }

    /**
     * 翻译FFmpeg错误
     * @param {string} message - 原始错误消息
     * @returns {string} 翻译后的消息
     */
    translateFFmpegError(message) {
        const msg = String(message || '').toLowerCase();

        if (msg.includes('ffmpeg') || msg.includes('avconv')) {
            return this.messageMap['ffmpeg'] || '视频处理失败';
        }
        if (msg.includes('moov atom') || msg.includes('atom')) {
            return this.messageMap['moov atom'] || '视频文件格式异常';
        }
        if (msg.includes('stream')) {
            return this.messageMap['stream'] || '视频流处理失败';
        }

        return this.translateGenericError(message);
    }

    /**
     * 翻译通用错误
     * @param {string} message - 原始错误消息
     * @returns {string} 翻译后的消息
     */
    translateGenericError(message) {
        if (!message) return '未知错误';

        // 尝试根据关键词进行翻译
        const msg = String(message).toLowerCase();

        for (const [key, translation] of Object.entries(this.messageMap)) {
            if (msg.includes(key.toLowerCase())) {
                return translation;
            }
        }

        // 如果找不到匹配的翻译，返回原始消息
        return String(message);
    }

    /**
     * 主翻译方法
     * @param {string|Error} error - 错误对象或错误消息
     * @param {string} type - 错误类型 ('sharp'|'filesystem'|'database'|'network'|'redis'|'ffmpeg'|'generic')
     * @returns {string} 翻译后的错误消息
     */
    translate(error, type = 'generic') {
        const message = error instanceof Error ? error.message : String(error || '');
        const code = error instanceof Error ? error.code : undefined;

        const translator = this.typeMap[type] || this.typeMap.generic;
        return translator(message, code);
    }

    /**
     * 添加自定义错误消息映射
     * @param {string} key - 错误关键词
     * @param {string} translation - 翻译后的消息
     */
    addMapping(key, translation) {
        this.messageMap[key] = translation;
    }

    /**
     * 批量添加错误消息映射
     * @param {Object} mappings - 映射对象
     */
    addMappings(mappings) {
        Object.assign(this.messageMap, mappings);
    }
}

// 创建单例实例
const errorMessageTranslator = new ErrorMessageTranslator();

module.exports = {
    ErrorMessageTranslator,
    errorMessageTranslator
};
