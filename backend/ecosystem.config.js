/**
 * PM2 进程管理配置
 */
module.exports = {
	apps: [
		{
			name: 'photonix-server',
			script: './server.js',
			cwd: './backend',
			instances: 1,
			exec_mode: 'fork',
			watch: false,
			merge_logs: true,
			node_args: '--expose-gc',  // 启用手动 GC，用于批量任务后释放内存
			env: {
				AI_MICROSERVICE_ENABLED: 'true',
				AI_CACHE_MAX_AGE_DAYS: '365'
			}
		}
	]
};


