const crypto = require('crypto');

/**
 * 安全地比较两个字符串是否相等，防止时序攻击
 *
 * 使用 crypto.timingSafeEqual 进行恒定时间比较，避免攻击者通过测量比较时间推断密钥信息。
 * 处理 UTF-8 编码、类型安全和异常情况。
 * 
 * 安全增强：即使长度不同也执行恒定时间操作，避免泄露长度信息。
 *
 * @param {string|Buffer} a - 第一个值
 * @param {string|Buffer} b - 第二个值
 * @returns {boolean} 如果两个值相等返回 true，否则返回 false
 *
 * @example
 * secureCompare(userPassword, storedSecret) // true/false
 * secureCompare('你好', 'ab') // false (字节长度不同：6 vs 2)
 */
function secureCompare(a, b) {
  try {
    // 类型规范化：确保输入为 string 或 Buffer
    if (a == null || b == null) {
      // 执行一次无意义的 timingSafeEqual 以保持恒定时间
      const dummy = Buffer.alloc(32);
      crypto.timingSafeEqual(dummy, dummy);
      return false;
    }

    // 转换为 Buffer（使用 UTF-8 编码）
    const bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
    const bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8');

    // 长度不同时：填充到相同长度后再比较，避免泄露长度信息
    // 使用较大长度作为填充目标，结果一定为 false 但执行时间恒定
    if (bufA.length !== bufB.length) {
      const maxLen = Math.max(bufA.length, bufB.length);
      const paddedA = Buffer.alloc(maxLen);
      const paddedB = Buffer.alloc(maxLen);
      bufA.copy(paddedA);
      bufB.copy(paddedB);
      // 执行比较（结果必定不等，但时间恒定）
      crypto.timingSafeEqual(paddedA, paddedB);
      return false;
    }

    // 恒定时间比较
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (error) {
    // 降级处理：任何异常都视为不匹配（安全优先）
    return false;
  }
}

module.exports = { secureCompare };
