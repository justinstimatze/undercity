/**
 * File Lock Utility
 *
 * Provides file-level locking for JSON state files that use read-modify-write
 * cycles. Prevents data loss during parallel grind execution when multiple
 * workers complete tasks and record learnings simultaneously.
 *
 * Uses proper-lockfile with stale lock eviction.
 *
 * NOT needed for SQLite-backed state (task-file-patterns, error-fix-patterns,
 * decision-tracker) - SQLite WAL mode + busy_timeout handles concurrency.
 *
 * Used by:
 * - knowledge.ts (knowledge.json)
 * - capability-ledger.ts (capability-ledger.json)
 */

import { lock, lockSync, unlockSync } from "proper-lockfile";
import { sessionLogger } from "./logger.js";

const logger = sessionLogger.child({ module: "file-lock" });

/**
 * Options for file locking
 */
interface FileLockOptions {
	/** Number of retries for async lock (default: 5, only used by async variant) */
	retries?: number;
	/** Stale lock threshold in ms (default: 30000) */
	stale?: number;
}

const DEFAULT_OPTIONS: FileLockOptions = {
	retries: 5,
	stale: 30000,
};

/**
 * Execute a function while holding a file lock (synchronous).
 *
 * Critical pattern: acquire lock -> re-read fresh state -> mutate -> save -> release.
 * The callback receives no arguments - it should re-read the file inside the lock
 * to ensure it has the latest state.
 *
 * Note: lockSync does not support retries. If the lock is already held,
 * it will fail immediately and the function proceeds without the lock.
 *
 * @param filePath - Path to the file to lock (lockfile created at filePath.lock)
 * @param fn - Function to execute while holding the lock
 * @param options - Lock configuration
 * @returns The return value of fn
 */
export function withFileLock<T>(filePath: string, fn: () => T, options?: FileLockOptions): T {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	try {
		lockSync(filePath, {
			stale: opts.stale,
			realpath: false,
		});
	} catch (error) {
		logger.warn({ filePath, error: String(error) }, "Failed to acquire file lock, proceeding without lock");
		// Proceed without lock rather than failing the entire task completion
		return fn();
	}

	try {
		return fn();
	} finally {
		try {
			unlockSync(filePath, { realpath: false });
		} catch (error) {
			logger.debug({ filePath, error: String(error) }, "Failed to release file lock");
		}
	}
}

/**
 * Async version of withFileLock for async callbacks.
 * Supports retries with exponential backoff via proper-lockfile.
 *
 * @param filePath - Path to the file to lock
 * @param fn - Async function to execute while holding the lock
 * @param options - Lock configuration
 * @returns The return value of fn
 */
export async function withFileLockAsync<T>(
	filePath: string,
	fn: () => Promise<T>,
	options?: FileLockOptions,
): Promise<T> {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	let release: (() => Promise<void>) | undefined;
	try {
		release = await lock(filePath, {
			retries: {
				retries: opts.retries ?? 5,
				minTimeout: 100,
				maxTimeout: 2000,
				factor: 2,
				randomize: true,
			},
			stale: opts.stale,
			realpath: false,
		});
	} catch (error) {
		logger.warn({ filePath, error: String(error) }, "Failed to acquire file lock, proceeding without lock");
		return fn();
	}

	try {
		return await fn();
	} finally {
		try {
			await release();
		} catch (error) {
			logger.debug({ filePath, error: String(error) }, "Failed to release file lock");
		}
	}
}
