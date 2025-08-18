/**
 * 搜索工具模块
 * 提供全文搜索相关的工具函数，支持n-gram分词和模糊匹配
 */

/**
 * 创建n-gram分词
 * 将输入文本分解为n-gram序列，用于全文搜索的模糊匹配
 * @param {string} text - 要处理的文本
 * @param {number} minGram - 最小n-gram长度，默认为1
 * @param {number} maxGram - 最大n-gram长度，默认为2
 * @returns {string} 空格分隔的n-gram序列，如果输入无效则返回空字符串
 */
function createNgrams(text, minGram = 1, maxGram = 2) {
    // 检查输入类型，如果不是字符串则返回空字符串
    if (typeof text !== 'string') return '';
    
    // 清理文本：转换为小写并移除所有空白字符
    const sanitizedText = text.toLowerCase().replace(/\s+/g, '');
    
    // 使用Set存储n-gram，自动去重
    const ngrams = new Set();
    
    // 生成指定长度范围内的所有n-gram
    for (let n = minGram; n <= maxGram; n++) {
        // 遍历文本，提取每个位置的n-gram
        for (let i = 0; i < sanitizedText.length - n + 1; i++) {
            ngrams.add(sanitizedText.substring(i, i + n));
        }
    }
    
    // 将Set转换为数组并用空格连接
    return Array.from(ngrams).join(' ');
}

// 导出搜索工具函数
module.exports = {
    createNgrams  // n-gram分词函数
};