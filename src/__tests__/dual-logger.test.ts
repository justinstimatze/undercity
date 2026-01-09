/**
 * Tests for Dual Logger
 *
 * Tests the dual logging functionality that writes to both terminal and log files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DualLogger } from "../dual-logger.js";

// Test directory
const TEST_DIR = ".test-undercity";

describe("DualLogger", () => {
	let logger: DualLogger;
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// Create test logger with test directory
		logger = new DualLogger(TEST_DIR);

		// Spy on console methods
		consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		// Stop logging and cleanup
		if (logger.isActive()) {
			logger.stop();
		}

		// Cleanup test directory
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}

		// Restore console
		consoleSpy.mockRestore();
		stdoutSpy.mockRestore();
	});

	it("should create log directory on start", () => {
		logger.start("test-raid-123");

		const logDir = join(TEST_DIR, "logs");
		expect(existsSync(logDir)).toBe(true);
	});

	it("should create current.log file on start", () => {
		logger.start("test-raid-123");
		logger.writeLine("Test content to create file");

		const currentLogPath = logger.getCurrentLogPath();
		expect(existsSync(currentLogPath)).toBe(true);
	});

	it("should write header to log file on start", () => {
		logger.start("test-raid-123");
		logger.writeLine("Test content"); // Force file creation

		const logContent = readFileSync(logger.getCurrentLogPath(), "utf-8");
		expect(logContent).toContain("=== Undercity Raid Log ===");
		expect(logContent).toContain("Raid ID: test-raid-123");
	});

	it("should write to both console and file", () => {
		logger.start("test-raid-123");

		const testMessage = "Test message";
		logger.writeLine(testMessage);

		// Check console output
		expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining(testMessage));

		// Check file output
		const logContent = readFileSync(logger.getCurrentLogPath(), "utf-8");
		expect(logContent).toContain(testMessage);
	});

	it("should write footer to log file on stop", () => {
		logger.start("test-raid-123");
		logger.writeLine("Test content");
		logger.stop(); // Stop without rotation to keep current.log

		const logContent = readFileSync(logger.getCurrentLogPath(), "utf-8");
		expect(logContent).toContain("=== End Log ===");
	});

	it("should rotate logs when raid ends", (done) => {
		logger.start("test-raid-123");
		logger.writeLine("Test content");
		logger.stop("test-raid-123");

		const logDir = join(TEST_DIR, "logs");

		// Wait for async rotation to complete
		setTimeout(() => {
			// current.log should not exist after rotation
			expect(existsSync(logger.getCurrentLogPath())).toBe(false);

			// Archived log should exist
			const files = require("fs").readdirSync(logDir);
			const archivedLog = files.find((file: string) => file.startsWith("raid-test-raid-123"));
			expect(archivedLog).toBeTruthy();

			if (archivedLog) {
				const archivedPath = join(logDir, archivedLog);
				const archivedContent = readFileSync(archivedPath, "utf-8");
				expect(archivedContent).toContain("Test content");
			}

			done();
		}, 100); // Wait 100ms for async operation
	});

	it("should track active status correctly", () => {
		expect(logger.isActive()).toBe(false);

		logger.start("test-raid-123");
		expect(logger.isActive()).toBe(true);

		logger.stop("test-raid-123");
		expect(logger.isActive()).toBe(false);
	});

	it("should get recent entries from log", () => {
		logger.start("test-raid-123");
		logger.writeLine("First message");
		logger.writeLine("Second message");
		logger.writeLine("Third message");
		logger.stop(); // Stop without rotation to keep current.log

		const recent = logger.getRecentEntries(5);
		expect(recent.length).toBeGreaterThanOrEqual(1);
		expect(recent.some(entry => entry.includes("Second message") || entry.includes("Third message"))).toBe(true);
	});

	it("should handle write operations when not active", () => {
		// Should not throw when writing without starting
		expect(() => {
			logger.writeLine("Test message when inactive");
		}).not.toThrow();

		// Console should still be called (dual logging only affects file writing)
		expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("Test message when inactive"));
	});
});