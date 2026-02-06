/**
 * File Lock Tests
 *
 * Tests for the withFileLock utility that prevents data loss during
 * concurrent read-modify-write operations on JSON state files.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockSync, unlockSync } from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock, withFileLockAsync } from "../file-lock.js";

describe("withFileLock", () => {
	const testDir = join(import.meta.dirname, "../../.test-file-lock");
	const testFile = join(testDir, "test-state.json");

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		writeFileSync(testFile, JSON.stringify({ value: 0 }));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("executes callback and returns result", () => {
		const result = withFileLock(testFile, () => {
			return 42;
		});

		expect(result).toBe(42);
	});

	it("releases lock after callback completes", () => {
		withFileLock(testFile, () => "first");

		// Should be able to acquire lock again
		const result = withFileLock(testFile, () => "second");
		expect(result).toBe("second");
	});

	it("releases lock even if callback throws", () => {
		expect(() => {
			withFileLock(testFile, () => {
				throw new Error("test error");
			});
		}).toThrow("test error");

		// Lock should be released - can acquire again
		const result = withFileLock(testFile, () => "after-error");
		expect(result).toBe("after-error");
	});

	it("proceeds without lock when file does not exist", () => {
		const nonExistent = join(testDir, "nonexistent.json");

		// Should proceed without crashing (graceful fallback)
		const result = withFileLock(nonExistent, () => "fallback");
		expect(result).toBe("fallback");
	});

	it("retries lock acquisition with exponential backoff", () => {
		// Acquire lock externally and hold it throughout
		lockSync(testFile, { realpath: false });

		const startTime = Date.now();

		try {
			// withFileLock will retry several times before giving up
			const result = withFileLock(
				testFile,
				() => {
					return "completed-after-retries";
				},
				{ maxRetries: 2, minDelayMs: 50, maxDelayMs: 300 },
			);

			const elapsed = Date.now() - startTime;

			// Should complete (via fallback after retries exhausted)
			expect(result).toBe("completed-after-retries");

			// Should have tried multiple times: initial + 2 retries = 3 attempts
			// Each retry has ~50ms, ~100ms delays = ~150ms minimum
			expect(elapsed).toBeGreaterThan(100);
		} finally {
			unlockSync(testFile, { realpath: false });
		}
	});

	it("falls back to no lock after max retries exceeded", () => {
		// Acquire lock externally and hold it
		lockSync(testFile, { realpath: false });

		try {
			// withFileLock should eventually give up and proceed without lock
			const result = withFileLock(
				testFile,
				() => {
					return "fallback-after-retries";
				},
				{ maxRetries: 2, minDelayMs: 20, maxDelayMs: 100 },
			);

			expect(result).toBe("fallback-after-retries");
		} finally {
			unlockSync(testFile, { realpath: false });
		}
	});

	it("uses exponential backoff timing", () => {
		// Acquire lock externally
		lockSync(testFile, { realpath: false });

		const delays: number[] = [];
		const startTime = Date.now();
		const lastCheckpoint = startTime;

		try {
			withFileLock(
				testFile,
				() => {
					// Track when we finally execute (after all retries fail)
					const now = Date.now();
					delays.push(now - lastCheckpoint);
					return "done";
				},
				{
					maxRetries: 3,
					minDelayMs: 50,
					maxDelayMs: 500,
					exponentialFactor: 2,
				},
			);
		} finally {
			unlockSync(testFile, { realpath: false });
		}

		// Should have attempted 4 times (initial + 3 retries)
		// Total time should reflect exponential backoff: ~50 + ~100 + ~200 = ~350ms minimum
		const totalElapsed = Date.now() - startTime;
		expect(totalElapsed).toBeGreaterThan(300); // Account for jitter
	});

	it("respects custom retry configuration", () => {
		lockSync(testFile, { realpath: false });

		const startTime = Date.now();

		try {
			withFileLock(testFile, () => "custom-config", {
				maxRetries: 1, // Only 1 retry
				minDelayMs: 100,
				maxDelayMs: 200,
			});
		} finally {
			unlockSync(testFile, { realpath: false });
		}

		const elapsed = Date.now() - startTime;

		// Should have tried 2 times total (initial + 1 retry) with ~100ms delay
		// Total time should be at least 100ms
		expect(elapsed).toBeGreaterThan(90);
		expect(elapsed).toBeLessThan(300); // Should not take too long with just 1 retry
	});
});

describe("withFileLockAsync", () => {
	const testDir = join(import.meta.dirname, "../../.test-file-lock-async");
	const testFile = join(testDir, "test-state.json");

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
		writeFileSync(testFile, JSON.stringify({ value: 0 }));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("executes async callback and returns result", async () => {
		const result = await withFileLockAsync(testFile, async () => {
			return 42;
		});

		expect(result).toBe(42);
	});

	it("releases lock after async callback completes", async () => {
		await withFileLockAsync(testFile, async () => "first");

		const result = await withFileLockAsync(testFile, async () => "second");
		expect(result).toBe("second");
	});

	it("releases lock even if async callback rejects", async () => {
		await expect(
			withFileLockAsync(testFile, async () => {
				throw new Error("async error");
			}),
		).rejects.toThrow("async error");

		// Lock should be released
		const result = await withFileLockAsync(testFile, async () => "after-error");
		expect(result).toBe("after-error");
	});
});
