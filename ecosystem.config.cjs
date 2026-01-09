module.exports = {
	apps: [
		{
			name: "undercity",
			script: "./bin/undercity.js",
			args: "daemon",
			cwd: process.cwd(),
			watch: false,
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
