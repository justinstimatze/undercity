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
import {
	FILE_LOCK_BACKOFF_FACTOR,
	FILE_LOCK_MAX_DELAY_MS,
	FILE_LOCK_MIN_DELAY_MS,
	MAX_FILE_LOCK_RETRIES,
} from "./constants.js";
import { sessionLogger } from "./logger.js";

const logger = sessionLogger.child({ module: "file-lock" });

/**
 * Options for file locking
 */
interface FileLockOptions {
	/** Maximum number of retry attempts (default: 5) */
	maxRetries?: number;
	/** Minimum delay between retries in ms (default: 50) */
	minDelayMs?: number;
	/** Maximum delay between retries in ms (default: 1000) */
	maxDelayMs?: number;
	/** Exponential backoff multiplier (default: 2) */
	exponentialFactor?: number;
	/** Stale lock threshold in ms (default: 30000) */
	stale?: number;
}

const DEFAULT_OPTIONS: FileLockOptions = {
	maxRetries: MAX_FILE_LOCK_RETRIES,
	minDelayMs: FILE_LOCK_MIN_DELAY_MS,
	maxDelayMs: FILE_LOCK_MAX_DELAY_MS,
	exponentialFactor: FILE_LOCK_BACKOFF_FACTOR,
	stale: 30000,
};

/**
 * Synchronous sleep using busy-wait.
 * WARNING: This blocks the event loop and should only be used for short delays.
 *
 * @param ms - Milliseconds to sleep
 */
export function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// Busy wait
	}
}

/**
 * Execute a function while holding a file lock (synchronous).
 *
 * Critical pattern: acquire lock -> re-read fresh state -> mutate -> save -> release.
 * The callback receives no arguments - it should re-read the file inside the lock
 * to ensure it has the latest state.
 *
 * Implements exponential backoff retry logic to handle transient lock contention.
 * If all retries are exhausted, proceeds without the lock rather than failing.
 *
 * @param filePath - Path to the file to lock (lockfile created at filePath.lock)
 * @param fn - Function to execute while holding the lock
 * @param options - Lock configuration including retry parameters
 * @returns The return value of fn
 */
export function withFileLock<T>(filePath: string, fn: () => T, options?: FileLockOptions): T {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const maxRetries = opts.maxRetries ?? MAX_FILE_LOCK_RETRIES;
	const minDelay = opts.minDelayMs ?? FILE_LOCK_MIN_DELAY_MS;
	const maxDelay = opts.maxDelayMs ?? FILE_LOCK_MAX_DELAY_MS;
	const factor = opts.exponentialFactor ?? FILE_LOCK_BACKOFF_FACTOR;

	let lastError: unknown;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			lockSync(filePath, {
				stale: opts.stale,
				realpath: false,
			});

			// Lock acquired successfully
			try {
				return fn();
			} finally {
				try {
					unlockSync(filePath, { realpath: false });
				} catch (error) {
					logger.debug({ filePath, error: String(error) }, "Failed to release file lock");
				}
			}
		} catch (error) {
			lastError = error;

			// If this was the last attempt, break and proceed without lock
			if (attempt >= maxRetries) {
				break;
			}

			// Calculate exponential backoff delay with jitter
			const baseDelay = Math.min(minDelay * factor ** attempt, maxDelay);
			const jitter = Math.random() * 0.3 * baseDelay; // Add up to 30% random jitter
			const delay = Math.floor(baseDelay + jitter);

			logger.debug(
				{ filePath, attempt: attempt + 1, maxRetries: maxRetries + 1, delayMs: delay },
				"Lock acquisition failed, retrying with exponential backoff",
			);

			sleepSync(delay);
		}
	}

	// All retries exhausted - proceed without lock
	logger.warn(
		{ filePath, attempts: maxRetries + 1, error: String(lastError) },
		"Failed to acquire file lock after all retries, proceeding without lock",
	);
	return fn();
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
				retries: opts.maxRetries ?? MAX_FILE_LOCK_RETRIES,
				minTimeout: opts.minDelayMs ?? FILE_LOCK_MIN_DELAY_MS,
				maxTimeout: opts.maxDelayMs ?? FILE_LOCK_MAX_DELAY_MS,
				factor: opts.exponentialFactor ?? FILE_LOCK_BACKOFF_FACTOR,
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
