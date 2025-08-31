module.exports = {
  // 从 /app/frontend 运行，因此使用项目本地路径
  swSrc: 'sw-src.js',
  swDest: 'sw.js',
  globDirectory: '.',
  globPatterns: [
    'index.html',
    'output.css',
    'manifest.json',
    'assets/**/*',
    'js/dist/**/*.js'
  ],
  maximumFileSizeToCacheInBytes: 8 * 1024 * 1024 // 8MB 上限，避免意外缓存超大文件
};


