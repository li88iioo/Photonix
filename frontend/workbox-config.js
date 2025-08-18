module.exports = {
  // Run from /app/frontend, so use project-local paths
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


