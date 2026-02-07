/**
 * Logger Module
 *
 * Pino-based structured logging for the main process.
 * Provides child loggers for different modules (session, squad, git, persistence, cache, server).
 *
 * For worker-specific logging that writes to files for external monitoring,
 * see dual-logger.ts which wraps this logger with file output.
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
// sessionLogger specializes in logging events and details specific to session operations in the Undercity system
export const sessionLogger = logger.child({ module: "session" });
// agentLogger specializes in logging events and details related to agent management and agent interactions in the Undercity system
export const agentLogger = logger.child({ module: "squad" });
export const gitLogger = logger.child({ module: "git" });
export const persistenceLogger = logger.child({ module: "persistence" });
export const cacheLogger = logger.child({ module: "cache" });
export const serverLogger = logger.child({ module: "server" });
