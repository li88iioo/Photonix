/**
 * @file imageValidationWorker.js
 * @description Worker线程用于异步图片验证，避免阻塞主线程
 */

const { parentPort } = require('worker_threads');
const fs = require('fs');
const imageSize = require('image-size');

/**
 * 验证图片
 * @param {object} data 验证参数
 */
function validateImage(data) {
  const { filePath, fileSize, minWidth, minHeight } = data;
  
  try {
    // 读取文件
    const buffer = fs.readFileSync(filePath);
    
    // 验证文件大小
    if (buffer.length !== fileSize) {
      return {
        valid: false,
        reason: 'File size mismatch'
      };
    }
    
    // 获取图片尺寸
    let dimensions;
    try {
      dimensions = imageSize(buffer);
    } catch (error) {
      return {
        valid: false,
        reason: 'Failed to parse image dimensions',
        error: error.message
      };
    }
    
    // 验证尺寸
    const meetsWidth = !minWidth || dimensions.width >= minWidth;
    const meetsHeight = !minHeight || dimensions.height >= minHeight;
    
    if (!meetsWidth || !meetsHeight) {
      return {
        valid: false,
        reason: 'Image dimensions too small',
        dimensions: {
          width: dimensions.width,
          height: dimensions.height,
          required: {
            minWidth,
            minHeight
          }
        }
      };
    }
    
    return {
      valid: true,
      dimensions: {
        width: dimensions.width,
        height: dimensions.height,
        type: dimensions.type
      }
    };
  } catch (error) {
    return {
      valid: false,
      reason: 'Validation error',
      error: error.message
    };
  }
}

// 监听主线程消息
parentPort.on('message', (task) => {
  const result = validateImage(task);
  parentPort.postMessage({
    taskId: task.taskId,
    result
  });
});
