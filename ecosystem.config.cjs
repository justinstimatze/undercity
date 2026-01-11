module.exports = {
	apps: [
		{
			name: "undercity",
			script: "./bin/undercity.js",
			args: "daemon",
			cwd: process.cwd(),
			watch: false,

			// Resilience for overnight operation
			autorestart: true,
			max_restarts: 10,
			min_uptime: "30s",
			restart_delay: 5000,

			// Exponential backoff on repeated failures
			exp_backoff_restart_delay: 1000,

			// Memory limits (restart if exceeds 2GB)
			max_memory_restart: "2G",

			// Logging
			error_file: ".undercity/logs/pm2-error.log",
			out_file: ".undercity/logs/pm2-out.log",
			merge_logs: true,
			time: true,

			env: {
				NODE_ENV: "development",
				LOG_LEVEL: "debug",
			},
			env_production: {
				NODE_ENV: "production",
				LOG_LEVEL: "info",
			},
		},
	],
};
