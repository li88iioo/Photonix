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
			name: 'ai-worker',
			script: './workers/ai-worker.js',
			cwd: './backend',
			instances: 1,
			exec_mode: 'fork',
			watch: false,
			merge_logs: true
		}
	]
};


