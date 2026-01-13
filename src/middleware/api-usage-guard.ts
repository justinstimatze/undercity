/**
 * API Usage Guard Middleware
 *
 * Intercepts API-related operations to:
 * 1. Update usage tracking after each call
 * 2. Check rate limits before executing calls
 * 3. Automatically pause grinding when approaching limits
 *
 * This is a functional middleware that wraps async operations,
 * not HTTP middleware (project uses native Node.js HTTP, not Express).
 */

import { recordQueryResult } from "../live-metrics.js";
import { RateLimitTracker } from "../rate-limit.js";
import type { ModelChoice } from "../types.js";

/**
 * Configuration for the API usage guard
 */
export interface ApiUsageGuardConfig {
	/** Threshold percentage at which to pause (0-1). Default: 0.95 */
	pauseThreshold?: number;
	/** Threshold percentage at which to warn (0-1). Default: 0.8 */
	warningThreshold?: number;
	/** Whether to automatically pause when threshold is reached. Default: true */
	autoPause?: boolean;
	/** Callback when pause is triggered */
	onPause?: (reason: string, resumeAt?: Date) => void;
	/** Callback when warning threshold is reached */
	onWarning?: (usagePercent: number, window: "5hour" | "week") => void;
}

/**
 * Result from a guarded API call
 */
export interface GuardedCallResult<T> {
	/** Whether the call was executed */
	executed: boolean;
	/** The result if executed */
	result?: T;
	/** Error if call failed or was blocked */
	error?: string;
	/** Whether rate limit was hit during execution */
	rateLimited?: boolean;
	/** Current usage after the call */
	usage?: {
		fiveHourPercent: number;
		weeklyPercent: number;
	};
}

/**
 * Token usage information for a single API call
 */
export interface ApiCallUsage {
	inputTokens: number;
	outputTokens: number;
	model: ModelChoice;
	durationMs?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
}

/**
 * API Usage Guard
 *
 * Wraps API calls to track usage and enforce rate limits.
 * Use this to guard any operation that consumes API tokens.
 */
export class ApiUsageGuard {
	private tracker: RateLimitTracker;
	private config: Required<Omit<ApiUsageGuardConfig, "onPause" | "onWarning">> & {
		onPause?: (reason: string, resumeAt?: Date) => void;
		onWarning?: (usagePercent: number, window: "5hour" | "week") => void;
	};
	private isPaused = false;
	private pauseReason?: string;
	private resumeAt?: Date;

	constructor(tracker: RateLimitTracker, config: ApiUsageGuardConfig = {}) {
		this.tracker = tracker;
		this.config = {
			pauseThreshold: config.pauseThreshold ?? 0.95,
			warningThreshold: config.warningThreshold ?? 0.8,
			autoPause: config.autoPause ?? true,
			onPause: config.onPause,
			onWarning: config.onWarning,
		};
	}

	/**
	 * Check if the guard is currently blocking calls
	 */
	isBlocking(): boolean {
		return this.isPaused || this.tracker.isPaused();
	}

	/**
	 * Get the current pause state
	 */
	getPauseState(): { isPaused: boolean; reason?: string; resumeAt?: Date } {
		if (this.tracker.isPaused()) {
			const trackerState = this.tracker.getPauseState();
			return {
				isPaused: true,
				reason: trackerState.reason,
				resumeAt: trackerState.resumeAt,
			};
		}
		return {
			isPaused: this.isPaused,
			reason: this.pauseReason,
			resumeAt: this.resumeAt,
		};
	}

	/**
	 * Check usage levels and determine if we should block
	 * Returns null if OK to proceed, or an error message if should block
	 */
	checkUsage(): string | null {
		// First check if tracker is paused (hit actual rate limit)
		if (this.tracker.isPaused()) {
			const remaining = this.tracker.formatRemainingTime();
			return `Rate limit active, resume in ${remaining}`;
		}

		// Check if we're paused due to approaching limits
		if (this.isPaused) {
			return this.pauseReason ?? "API usage paused";
		}

		// Check current usage levels
		const fiveHourUsage = this.tracker.getUsagePercentage("5hour");
		const weeklyUsage = this.tracker.getUsagePercentage("week");

		// Check if we should auto-pause
		if (this.config.autoPause) {
			if (fiveHourUsage >= this.config.pauseThreshold) {
				this.triggerPause(`5-hour usage at ${(fiveHourUsage * 100).toFixed(1)}%`, "5hour");
				return this.pauseReason ?? "Usage limit reached";
			}
			if (weeklyUsage >= this.config.pauseThreshold) {
				this.triggerPause(`Weekly usage at ${(weeklyUsage * 100).toFixed(1)}%`, "week");
				return this.pauseReason ?? "Usage limit reached";
			}
		}

		// Check if we should warn
		if (fiveHourUsage >= this.config.warningThreshold) {
			this.config.onWarning?.(fiveHourUsage, "5hour");
		}
		if (weeklyUsage >= this.config.warningThreshold) {
			this.config.onWarning?.(weeklyUsage, "week");
		}

		return null;
	}

	/**
	 * Get current usage percentages
	 */
	getCurrentUsage(): { fiveHourPercent: number; weeklyPercent: number } {
		return {
			fiveHourPercent: this.tracker.getUsagePercentage("5hour"),
			weeklyPercent: this.tracker.getUsagePercentage("week"),
		};
	}

	/**
	 * Record usage from an API call
	 */
	recordUsage(taskId: string, usage: ApiCallUsage): void {
		// Record in rate limit tracker
		this.tracker.recordTask(taskId, usage.model, usage.inputTokens, usage.outputTokens, {
			durationMs: usage.durationMs,
		});

		// Record in live metrics for dashboard
		recordQueryResult({
			success: true,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheCreationTokens: usage.cacheCreationTokens,
			model: usage.model,
			durationMs: usage.durationMs,
		});

		// Check if we need to pause after this call
		this.checkUsage();
	}

	/**
	 * Record a rate limit hit (429 error)
	 */
	recordRateLimitHit(model: ModelChoice, errorMessage?: string, headers?: Record<string, string>): void {
		this.tracker.recordRateLimitHit(model, errorMessage, headers);

		// Record in live metrics
		recordQueryResult({
			success: false,
			rateLimited: true,
			model,
		});
	}

	/**
	 * Wrap an async function with usage tracking and rate limit checking
	 *
	 * @param fn The async function to execute
	 * @param getUsage Function to extract usage info from the result
	 * @param taskId Task ID for tracking
	 */
	async guard<T>(
		fn: () => Promise<T>,
		getUsage: (result: T) => ApiCallUsage | null,
		taskId: string,
	): Promise<GuardedCallResult<T>> {
		// Check if we should block before executing
		const blockReason = this.checkUsage();
		if (blockReason) {
			return {
				executed: false,
				error: blockReason,
				usage: this.getCurrentUsage(),
			};
		}

		try {
			const result = await fn();

			// Extract and record usage
			const usage = getUsage(result);
			if (usage) {
				this.recordUsage(taskId, usage);
			}

			return {
				executed: true,
				result,
				usage: this.getCurrentUsage(),
			};
		} catch (err) {
			const errorStr = String(err);

			// Check if it's a rate limit error
			if (RateLimitTracker.is429Error(err)) {
				// Try to extract model from error or default to sonnet
				const model: ModelChoice = "sonnet";
				this.recordRateLimitHit(model, errorStr);

				return {
					executed: true,
					error: errorStr,
					rateLimited: true,
					usage: this.getCurrentUsage(),
				};
			}

			// Regular error
			return {
				executed: true,
				error: errorStr,
				usage: this.getCurrentUsage(),
			};
		}
	}

	/**
	 * Trigger a pause due to approaching rate limits
	 */
	private triggerPause(reason: string, window: "5hour" | "week"): void {
		this.isPaused = true;
		this.pauseReason = reason;

		// Calculate resume time based on window
		const now = new Date();
		if (window === "5hour") {
			// Resume when some tokens age out of the 5-hour window
			// Estimate 30 minutes for sufficient tokens to age out
			this.resumeAt = new Date(now.getTime() + 30 * 60 * 1000);
		} else {
			// Weekly window - estimate 2 hours
			this.resumeAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
		}

		this.config.onPause?.(reason, this.resumeAt);
	}

	/**
	 * Manually resume from a pause
	 */
	resume(): void {
		this.isPaused = false;
		this.pauseReason = undefined;
		this.resumeAt = undefined;

		// Also try to resume the tracker if it was paused
		this.tracker.checkAutoResume();
	}

	/**
	 * Check if auto-resume conditions are met
	 */
	checkAutoResume(): boolean {
		// Check tracker auto-resume
		const trackerResumed = this.tracker.checkAutoResume();

		// Check our own pause state
		if (this.isPaused && this.resumeAt) {
			const now = new Date();
			if (now >= this.resumeAt) {
				// Check if usage has dropped enough
				const usage = this.getCurrentUsage();
				const resumeThreshold = this.config.pauseThreshold - 0.1; // 10% below pause threshold

				if (usage.fiveHourPercent < resumeThreshold && usage.weeklyPercent < resumeThreshold) {
					this.resume();
					return true;
				}
			}
		}

		return trackerResumed;
	}
}

/**
 * Create a guard instance with default configuration
 */
export function createApiUsageGuard(tracker: RateLimitTracker, config?: ApiUsageGuardConfig): ApiUsageGuard {
	return new ApiUsageGuard(tracker, config);
}

/**
 * Decorator-style function for wrapping API calls
 *
 * Usage:
 * ```ts
 * const result = await withUsageTracking(
 *   guard,
 *   () => callClaudeApi(prompt),
 *   (result) => ({ inputTokens: result.usage.input, outputTokens: result.usage.output, model: "sonnet" }),
 *   taskId
 * );
 * ```
 */
export async function withUsageTracking<T>(
	guard: ApiUsageGuard,
	fn: () => Promise<T>,
	getUsage: (result: T) => ApiCallUsage | null,
	taskId: string,
): Promise<GuardedCallResult<T>> {
	return guard.guard(fn, getUsage, taskId);
}
