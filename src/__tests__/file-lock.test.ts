/**
 * File Lock Tests
 *
 * Tests for the withFileLock utility that prevents data loss during
 * concurrent read-modify-write operations on JSON state files.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
