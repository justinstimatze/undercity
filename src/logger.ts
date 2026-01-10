/**
 * Logger Module
 *
 * Structured logging using pino.
 */

import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
	level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
	transport: isDev
		? {
				target: "pino-pretty",
				options: {
					colorize: true,
					ignore: "pid,hostname",
					translateTime: "HH:MM:ss",
				},
			}
		: undefined,
});

// Child loggers for different components
// raidLogger specializes in logging events and details specific to raid operations in the Undercity system
export const raidLogger = logger.child({ module: "raid" });
export const squadLogger = logger.child({ module: "squad" });
export const gitLogger = logger.child({ module: "git" });
export const persistenceLogger = logger.child({ module: "persistence" });
export const cacheLogger = logger.child({ module: "cache" });
