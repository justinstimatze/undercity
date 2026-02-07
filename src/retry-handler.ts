/**
 * Retry Handler Module
 *
 * Provides reusable retry primitives for handling transient failures with
 * exponential backoff and jitter. Consolidates retry logic currently scattered
 * across file-lock.ts, embeddings.ts, and knowledge.ts.
 *
 * ## Synchronous vs Asynchronous Patterns
 *
 * - **Synchronous**: Use `sleepSync()` + `calculateBackoffDelay()` for sync contexts
 *   (e.g., file lock acquisition in `withFileLock`). Implement custom retry loops
 *   when you need specialized control flow.
 *
 * - **Asynchronous**: Use `withRetry()` wrapper for standard async retry patterns
 *   (e.g., database operations, API calls). For custom async retry logic, use
 *   `sleep()` + `calculateBackoffDelay()`.
 *
 * ## Exponential Backoff Formula
 *
 * ```
 * baseDelay = min(minDelayMs * factor^attempt, maxDelayMs)
 * actualDelay = baseDelay + (baseDelay * random * jitterPercent / 100)
 * ```
 *
 * ## Jitter Rationale
 *
 * Adding randomness to retry delays prevents "thundering herd" problems where
 * multiple processes retry simultaneously, causing coordinated load spikes.
 * Different consumers use different jitter percentages based on their needs:
 * - 10% jitter: General purpose (embeddings, database operations)
 * - 30% jitter: High contention scenarios (file lock acquisition)
 *
 * ## Phase 1: Module Creation (This File)
 *
 * This module provides primitives but doesn't modify existing consumers yet.
 * Consumers (embeddings.ts, file-lock.ts, knowledge.ts) will be migrated in
 * Phase 2 to avoid breaking changes during extraction.
 */

/**
 * Configuration options for retry behavior
 */
export interface RetryOptions {
	/** Maximum number of retry attempts (0 = no retries) */
	maxRetries: number;
	/** Minimum delay between retries in milliseconds */
	minDelayMs: number;
	/** Maximum delay between retries in milliseconds */
	maxDelayMs: number;
	/** Exponential backoff multiplier (e.g., 2 = double each attempt) */
	exponentialFactor: number;
	/** Jitter percentage (0-100) to add randomness to delays. Default: 10% */
	jitterPercent?: number;
	/** Optional predicate to determine if an error should be retried */
	shouldRetry?: (error: unknown) => boolean;
}

// =============================================================================
// Retry Constants
// =============================================================================

/** Default maximum retry attempts */
export const DEFAULT_MAX_RETRIES = 3;

/** Default initial delay for exponential backoff (ms) */
export const DEFAULT_INITIAL_DELAY_MS = 100;

/** Default maximum delay for exponential backoff (ms) */
export const DEFAULT_MAX_DELAY_MS = 5000;

/** File lock minimum delay (ms) */
export const FILE_LOCK_MIN_DELAY_MS = 50;

/** File lock maximum delay (ms) */
export const FILE_LOCK_MAX_DELAY_MS = 1000;

// =============================================================================
// Sleep Utilities
// =============================================================================

/**
 * Synchronous sleep using busy-wait.
 *
 * **WARNING: This blocks the Node.js event loop** and prevents any other
 * operations from running during the delay. Use this ONLY when:
 * 1. You're in a synchronous context that cannot use async/await
 * 2. The delay is short (< 1 second)
 * 3. You understand the performance implications
 *
 * For async contexts, use `sleep()` instead.
 *
 * @param ms - Milliseconds to sleep (blocks execution)
 *
 * @example
 * ```typescript
 * // In synchronous file lock retry
 * for (let attempt = 0; attempt < maxRetries; attempt++) {
 *   try {
 *     lockSync(filePath);
 *     return doWork();
 *   } catch (error) {
 *     if (attempt < maxRetries - 1) {
 *       const delay = calculateBackoffDelay(attempt, options);
 *       sleepSync(delay);
 *     }
 *   }
 * }
 * ```
 */
export function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		// Busy wait - blocks event loop
	}
}

/**
 * Asynchronous sleep utility.
 *
 * Non-blocking delay that allows other operations to continue during the wait.
 * Use this for async retry patterns.
 *
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the delay
 *
 * @example
 * ```typescript
 * // In async retry loop
 * for (let attempt = 0; attempt < maxRetries; attempt++) {
 *   try {
 *     return await operation();
 *   } catch (error) {
 *     if (attempt < maxRetries - 1) {
 *       const delay = calculateBackoffDelay(attempt, options);
 *       await sleep(delay);
 *     }
 *   }
 * }
 * ```
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Backoff Calculation
// =============================================================================

/**
 * Calculate exponential backoff delay with configurable jitter.
 *
 * Formula: `delay = min(minDelay * factor^attempt, maxDelay) * (1 + random * jitterPercent / 100)`
 *
 * The jitter adds randomness to prevent synchronized retries across multiple
 * processes. Higher jitter values (e.g., 30%) are useful for high-contention
 * scenarios like file lock acquisition.
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param options - Retry configuration
 * @returns Delay in milliseconds with jitter applied
 *
 * @example
 * ```typescript
 * const options: RetryOptions = {
 *   maxRetries: 5,
 *   minDelayMs: 50,
 *   maxDelayMs: 1000,
 *   exponentialFactor: 2,
 *   jitterPercent: 30,
 * };
 *
 * // Attempt 0: ~50ms + jitter
 * // Attempt 1: ~100ms + jitter
 * // Attempt 2: ~200ms + jitter
 * // Attempt 3: ~400ms + jitter
 * // Attempt 4: ~800ms + jitter
 * // Attempt 5: ~1000ms (capped) + jitter
 * for (let attempt = 0; attempt < options.maxRetries; attempt++) {
 *   const delay = calculateBackoffDelay(attempt, options);
 *   console.log(`Retry in ${delay}ms`);
 *   await sleep(delay);
 * }
 * ```
 */
export function calculateBackoffDelay(attempt: number, options: RetryOptions): number {
	const { minDelayMs, maxDelayMs, exponentialFactor, jitterPercent = 10 } = options;

	// Calculate base exponential delay
	const exponentialDelay = minDelayMs * exponentialFactor ** attempt;
	const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

	// Add jitter: delay * (1 + random * jitterPercent / 100)
	const jitter = cappedDelay * (jitterPercent / 100) * Math.random();

	return Math.floor(cappedDelay + jitter);
}

// =============================================================================
// Error Detection
// =============================================================================

/**
 * Check if an error is transient and should be retried.
 *
 * Detects common transient errors:
 * - SQLite busy/locked errors
 * - Timeout errors
 * - Network errors
 * - Rate limit errors
 *
 * @param error - The error to check
 * @returns true if the error is likely transient
 *
 * @example
 * ```typescript
 * try {
 *   return await databaseOperation();
 * } catch (error) {
 *   if (isTransientError(error)) {
 *     // Retry the operation
 *     return await retryOperation();
 *   }
 *   // Permanent error, don't retry
 *   throw error;
 * }
 * ```
 */
export function isTransientError(error: unknown): boolean {
	if (error instanceof Error) {
		const message = error.message.toLowerCase();

		// SQLite busy/locked errors
		if (message.includes("sqlite_busy") || message.includes("database is locked")) {
			return true;
		}

		// Timeout errors
		if (message.includes("timeout") || message.includes("etimedout")) {
			return true;
		}

		// Network errors
		if (message.includes("econnreset") || message.includes("econnrefused") || message.includes("enetunreach")) {
			return true;
		}

		// Rate limit errors
		if (message.includes("rate limit") || message.includes("too many requests") || message.includes("429")) {
			return true;
		}
	}

	return false;
}

// =============================================================================
// Async Retry Wrapper
// =============================================================================

/**
 * Execute an async operation with retry logic.
 *
 * Automatically retries transient failures with exponential backoff and jitter.
 * Use this for standard async retry patterns (database ops, API calls, etc.).
 *
 * For custom retry control flow (e.g., knowledge.ts with break-on-empty-results),
 * use the primitives (`sleep`, `calculateBackoffDelay`) directly.
 *
 * @param operation - Async function to execute
 * @param options - Retry configuration
 * @returns Result of the operation
 * @throws Error after exhausting all retry attempts
 *
 * @example
 * ```typescript
 * // Standard retry pattern
 * const result = await withRetry(
 *   async () => {
 *     const db = getDatabase();
 *     return db.prepare("SELECT * FROM data").all();
 *   },
 *   {
 *     maxRetries: 3,
 *     minDelayMs: 100,
 *     maxDelayMs: 5000,
 *     exponentialFactor: 2,
 *     jitterPercent: 10,
 *     shouldRetry: isTransientError,
 *   }
 * );
 * ```
 */
export async function withRetry<T>(operation: () => Promise<T> | T, options: RetryOptions): Promise<T> {
	const { maxRetries, shouldRetry = isTransientError } = options;
	let lastError: unknown;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await operation();
		} catch (error: unknown) {
			lastError = error;

			// Don't retry non-transient errors
			if (!shouldRetry(error)) {
				throw error;
			}

			// Last attempt failed
			if (attempt >= maxRetries) {
				break;
			}

			// Calculate delay and retry
			const delayMs = calculateBackoffDelay(attempt, options);
			await sleep(delayMs);
		}
	}

	throw lastError;
}
