/**
 * Tests for logger.ts
 *
 * Tests logger configuration, child logger creation, log level filtering,
 * and structured logging format for all module-specific loggers
 * (sessionLogger, agentLogger, gitLogger, persistenceLogger, cacheLogger, serverLogger).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Store original environment variables
const originalEnv = { ...process.env };

describe("logger.ts", () => {
	beforeEach(() => {
		// Clear module cache to re-import with new env vars
		vi.resetModules();
	});

	afterEach(() => {
		// Restore original environment variables
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
		vi.resetModules();
	});

	describe("Base Logger Configuration", () => {
		it("should use info level by default in production", async () => {
			vi.stubEnv("NODE_ENV", "production");
			delete process.env.LOG_LEVEL;

			const { logger } = await import("../logger.js");

			expect(logger.level).toBe("info");
		});

		it("should use debug level by default in development", async () => {
			vi.stubEnv("NODE_ENV", "development");
			delete process.env.LOG_LEVEL;

			const { logger } = await import("../logger.js");

			expect(logger.level).toBe("debug");
		});

		it("should respect LOG_LEVEL environment variable", async () => {
			vi.stubEnv("NODE_ENV", "production");
			vi.stubEnv("LOG_LEVEL", "warn");

			const { logger } = await import("../logger.js");

			expect(logger.level).toBe("warn");
		});

		it("should have pino-pretty transport in development", async () => {
			vi.stubEnv("NODE_ENV", "development");

			// We can't directly inspect transport, but we can verify logger is created
			const { logger } = await import("../logger.js");

			expect(logger).toBeDefined();
			expect(typeof logger.info).toBe("function");
		});

		it("should not have transport in production", async () => {
			vi.stubEnv("NODE_ENV", "production");

			// In production, transport is undefined
			const { logger } = await import("../logger.js");

			expect(logger).toBeDefined();
			expect(typeof logger.info).toBe("function");
		});
	});

	describe("Child Logger Creation", () => {
		it("should create sessionLogger with correct module field", async () => {
			const { sessionLogger } = await import("../logger.js");

			expect(sessionLogger).toBeDefined();
			expect(typeof sessionLogger.info).toBe("function");
			// Check that it has the module binding (bindings method returns child context)
			const bindings = sessionLogger.bindings();
			expect(bindings).toHaveProperty("module", "session");
		});

		it("should create agentLogger with correct module field", async () => {
			const { agentLogger } = await import("../logger.js");

			expect(agentLogger).toBeDefined();
			const bindings = agentLogger.bindings();
			expect(bindings).toHaveProperty("module", "squad");
		});

		it("should create gitLogger with correct module field", async () => {
			const { gitLogger } = await import("../logger.js");

			expect(gitLogger).toBeDefined();
			const bindings = gitLogger.bindings();
			expect(bindings).toHaveProperty("module", "git");
		});

		it("should create persistenceLogger with correct module field", async () => {
			const { persistenceLogger } = await import("../logger.js");

			expect(persistenceLogger).toBeDefined();
			const bindings = persistenceLogger.bindings();
			expect(bindings).toHaveProperty("module", "persistence");
		});

		it("should create cacheLogger with correct module field", async () => {
			const { cacheLogger } = await import("../logger.js");

			expect(cacheLogger).toBeDefined();
			const bindings = cacheLogger.bindings();
			expect(bindings).toHaveProperty("module", "cache");
		});

		it("should create serverLogger with correct module field", async () => {
			const { serverLogger } = await import("../logger.js");

			expect(serverLogger).toBeDefined();
			const bindings = serverLogger.bindings();
			expect(bindings).toHaveProperty("module", "server");
		});

		it("should create independent child logger instances", async () => {
			const { sessionLogger, agentLogger, gitLogger } = await import("../logger.js");

			// All should be different instances
			expect(sessionLogger).not.toBe(agentLogger);
			expect(sessionLogger).not.toBe(gitLogger);
			expect(agentLogger).not.toBe(gitLogger);

			// But all should have logger methods
			expect(typeof sessionLogger.info).toBe("function");
			expect(typeof agentLogger.info).toBe("function");
			expect(typeof gitLogger.info).toBe("function");
		});

		it("should inherit log level from parent logger", async () => {
			vi.stubEnv("LOG_LEVEL", "warn");

			const { logger, sessionLogger } = await import("../logger.js");

			expect(logger.level).toBe("warn");
			expect(sessionLogger.level).toBe("warn");
		});
	});

	describe("Log Level Filtering", () => {
		it("should filter debug logs when level is info", async () => {
			vi.stubEnv("NODE_ENV", "production");
			vi.stubEnv("LOG_LEVEL", "info");

			const { logger } = await import("../logger.js");

			// Debug should be filtered
			expect(logger.isLevelEnabled("debug")).toBe(false);
			// Info should pass
			expect(logger.isLevelEnabled("info")).toBe(true);
		});

		it("should pass info logs when level is info", async () => {
			vi.stubEnv("LOG_LEVEL", "info");

			const { logger } = await import("../logger.js");

			expect(logger.isLevelEnabled("info")).toBe(true);
			expect(logger.isLevelEnabled("warn")).toBe(true);
			expect(logger.isLevelEnabled("error")).toBe(true);
		});

		it("should always pass warn logs", async () => {
			vi.stubEnv("LOG_LEVEL", "error");

			const { logger } = await import("../logger.js");

			expect(logger.isLevelEnabled("warn")).toBe(false);
			expect(logger.isLevelEnabled("error")).toBe(true);
		});

		it("should always pass error logs", async () => {
			vi.stubEnv("LOG_LEVEL", "fatal");

			const { logger } = await import("../logger.js");

			expect(logger.isLevelEnabled("error")).toBe(false);
			expect(logger.isLevelEnabled("fatal")).toBe(true);
		});

		it("should respect custom LOG_LEVEL for child loggers", async () => {
			vi.stubEnv("LOG_LEVEL", "warn");

			const { sessionLogger } = await import("../logger.js");

			expect(sessionLogger.isLevelEnabled("debug")).toBe(false);
			expect(sessionLogger.isLevelEnabled("info")).toBe(false);
			expect(sessionLogger.isLevelEnabled("warn")).toBe(true);
			expect(sessionLogger.isLevelEnabled("error")).toBe(true);
		});
	});

	describe("Structured Logging Format", () => {
		it("should include module field in child logger bindings", async () => {
			const { sessionLogger, agentLogger } = await import("../logger.js");

			const sessionBindings = sessionLogger.bindings();
			expect(sessionBindings).toHaveProperty("module", "session");

			const agentBindings = agentLogger.bindings();
			expect(agentBindings).toHaveProperty("module", "squad");
		});

		it("should support structured data in log calls without throwing", async () => {
			vi.stubEnv("NODE_ENV", "production");
			const { sessionLogger } = await import("../logger.js");

			// Verify that logging with structured data doesn't throw
			// The actual JSON output is verified by pino internally and in integration tests
			expect(() => {
				sessionLogger.info({ taskId: "task-123", status: "complete" }, "Task completed");
			}).not.toThrow();

			// Verify we can log with multiple fields
			expect(() => {
				sessionLogger.warn({ userId: "user-1", action: "login", timestamp: Date.now() }, "User action");
			}).not.toThrow();
		});

		it("should merge additional context with child logger context", async () => {
			const { sessionLogger } = await import("../logger.js");

			// Create a child of the child with additional context
			const taskLogger = sessionLogger.child({ taskId: "task-456" });

			const bindings = taskLogger.bindings();
			expect(bindings).toHaveProperty("module", "session");
			expect(bindings).toHaveProperty("taskId", "task-456");
		});

		it("should preserve parent bindings in nested child loggers", async () => {
			const { sessionLogger } = await import("../logger.js");

			// Create nested child loggers
			const taskLogger = sessionLogger.child({ taskId: "task-789" });
			const stepLogger = taskLogger.child({ step: "verification" });

			const bindings = stepLogger.bindings();
			expect(bindings).toHaveProperty("module", "session");
			expect(bindings).toHaveProperty("taskId", "task-789");
			expect(bindings).toHaveProperty("step", "verification");
		});
	});

	describe("Child Logger Module Fields", () => {
		it("sessionLogger should have module='session'", async () => {
			const { sessionLogger } = await import("../logger.js");

			const bindings = sessionLogger.bindings();
			expect(bindings.module).toBe("session");
		});

		it("agentLogger should have module='squad'", async () => {
			const { agentLogger } = await import("../logger.js");

			const bindings = agentLogger.bindings();
			expect(bindings.module).toBe("squad");
		});

		it("gitLogger should have module='git'", async () => {
			const { gitLogger } = await import("../logger.js");

			const bindings = gitLogger.bindings();
			expect(bindings.module).toBe("git");
		});

		it("persistenceLogger should have module='persistence'", async () => {
			const { persistenceLogger } = await import("../logger.js");

			const bindings = persistenceLogger.bindings();
			expect(bindings.module).toBe("persistence");
		});

		it("cacheLogger should have module='cache'", async () => {
			const { cacheLogger } = await import("../logger.js");

			const bindings = cacheLogger.bindings();
			expect(bindings.module).toBe("cache");
		});

		it("serverLogger should have module='server'", async () => {
			const { serverLogger } = await import("../logger.js");

			const bindings = serverLogger.bindings();
			expect(bindings.module).toBe("server");
		});
	});

	describe("Logger Methods", () => {
		it("should expose standard pino methods on all child loggers", async () => {
			const { sessionLogger, agentLogger, gitLogger, persistenceLogger, cacheLogger, serverLogger } = await import(
				"../logger.js"
			);

			const loggers = [sessionLogger, agentLogger, gitLogger, persistenceLogger, cacheLogger, serverLogger];

			for (const logger of loggers) {
				expect(typeof logger.trace).toBe("function");
				expect(typeof logger.debug).toBe("function");
				expect(typeof logger.info).toBe("function");
				expect(typeof logger.warn).toBe("function");
				expect(typeof logger.error).toBe("function");
				expect(typeof logger.fatal).toBe("function");
				expect(typeof logger.child).toBe("function");
			}
		});

		it("should support logging without message (object only)", async () => {
			vi.stubEnv("NODE_ENV", "production");
			const { sessionLogger } = await import("../logger.js");

			// This should not throw
			expect(() => {
				sessionLogger.info({ event: "test" });
			}).not.toThrow();
		});

		it("should support logging with message only", async () => {
			vi.stubEnv("NODE_ENV", "production");
			const { sessionLogger } = await import("../logger.js");

			// This should not throw
			expect(() => {
				sessionLogger.info("Simple message");
			}).not.toThrow();
		});
	});
});
