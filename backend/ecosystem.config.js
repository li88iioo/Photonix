module.exports = {
	apps: [
		{
			name: 'server',
			script: './server.js',
			cwd: './backend',
			instances: 1,
			exec_mode: 'fork',
			watch: false,
			merge_logs: true
		},
		{
			name: 'thumb-queue-worker',
			script: './queue/thumb-queue-worker.js',
			cwd: './backend',
			instances: 1,
			exec_mode: 'fork',
			watch: false,
			merge_logs: true
		},
		{
			name: 'ai-worker',
			script: './workers/ai-worker.js',
			cwd: './backend',
			instances: 1,
			exec_mode: 'fork',
			watch: false,
			merge_logs: true
		},
		{
			name: 'video-queue-worker',
			script: './queue/video-queue-worker.js',
			cwd: './backend',
			instances: 1,
			exec_mode: 'fork',
			watch: false,
			merge_logs: true
		}
	]
};


