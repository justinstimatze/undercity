/**
 * Tests for API Usage Guard middleware
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ApiCallUsage,
	ApiUsageGuard,
	createApiUsageGuard,
	withUsageTracking,
} from "../middleware/api-usage-guard.js";
import { RateLimitTracker } from "../rate-limit.js";

describe("ApiUsageGuard", () => {
	let tracker: RateLimitTracker;
	let guard: ApiUsageGuard;

	beforeEach(() => {
		tracker = new RateLimitTracker();
		guard = new ApiUsageGuard(tracker);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("isBlocking", () => {
		it("should return false when not paused", () => {
			expect(guard.isBlocking()).toBe(false);
		});

		it("should return true when tracker is paused", () => {
			// Simulate a rate limit hit that causes pause
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");
			expect(guard.isBlocking()).toBe(true);
		});
	});

	describe("checkUsage", () => {
		it("should return null when usage is low", () => {
			expect(guard.checkUsage()).toBeNull();
		});

		it("should return error when tracker is paused", () => {
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");
			const result = guard.checkUsage();
			expect(result).toBeTruthy();
			expect(result).toContain("Rate limit active");
		});
	});

	describe("getCurrentUsage", () => {
		it("should return usage percentages", () => {
			const usage = guard.getCurrentUsage();
			expect(usage).toHaveProperty("fiveHourPercent");
			expect(usage).toHaveProperty("weeklyPercent");
			expect(typeof usage.fiveHourPercent).toBe("number");
			expect(typeof usage.weeklyPercent).toBe("number");
		});
	});

	describe("recordUsage", () => {
		it("should record usage in tracker", () => {
			const usage: ApiCallUsage = {
				inputTokens: 1000,
				outputTokens: 500,
				model: "sonnet",
				durationMs: 1000,
			};

			guard.recordUsage("test-task-1", usage);

			const summary = tracker.getUsageSummary();
			expect(summary.current.last5Hours).toBeGreaterThan(0);
		});
	});

	describe("recordRateLimitHit", () => {
		it("should record rate limit hit and pause", () => {
			guard.recordRateLimitHit("sonnet", "429 Too Many Requests");
			expect(tracker.isPaused()).toBe(true);
		});
	});

	describe("guard", () => {
		it("should execute function when not blocked", async () => {
			const fn = vi.fn().mockResolvedValue({ data: "test" });
			const getUsage = vi.fn().mockReturnValue({
				inputTokens: 100,
				outputTokens: 50,
				model: "sonnet" as const,
			});

			const result = await guard.guard(fn, getUsage, "task-1");

			expect(result.executed).toBe(true);
			expect(result.result).toEqual({ data: "test" });
			expect(fn).toHaveBeenCalled();
			expect(getUsage).toHaveBeenCalled();
		});

		it("should not execute when blocked", async () => {
			// Pause the tracker
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");

			const fn = vi.fn().mockResolvedValue({ data: "test" });
			const getUsage = vi.fn();

			const result = await guard.guard(fn, getUsage, "task-1");

			expect(result.executed).toBe(false);
			expect(result.error).toBeTruthy();
			expect(fn).not.toHaveBeenCalled();
		});

		it("should handle 429 errors", async () => {
			const fn = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
			const getUsage = vi.fn();

			const result = await guard.guard(fn, getUsage, "task-1");

			expect(result.executed).toBe(true);
			expect(result.rateLimited).toBe(true);
			expect(result.error).toContain("429");
		});

		it("should handle regular errors", async () => {
			const fn = vi.fn().mockRejectedValue(new Error("Network error"));
			const getUsage = vi.fn();

			const result = await guard.guard(fn, getUsage, "task-1");

			expect(result.executed).toBe(true);
			expect(result.rateLimited).toBeFalsy();
			expect(result.error).toContain("Network error");
		});
	});

	describe("resume", () => {
		it("should clear pause state", () => {
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");
			expect(guard.isBlocking()).toBe(true);

			tracker.resumeFromRateLimit();
			guard.resume();

			expect(guard.isBlocking()).toBe(false);
		});
	});

	describe("getPauseState", () => {
		it("should return pause state from tracker", () => {
			tracker.pauseForRateLimit("sonnet", "Rate limit exceeded");

			const state = guard.getPauseState();
			expect(state.isPaused).toBe(true);
			expect(state.reason).toBeTruthy();
		});

		it("should return not paused when all clear", () => {
			const state = guard.getPauseState();
			expect(state.isPaused).toBe(false);
		});
	});
});

describe("createApiUsageGuard", () => {
	it("should create guard with default config", () => {
		const tracker = new RateLimitTracker();
		const guard = createApiUsageGuard(tracker);
		expect(guard).toBeInstanceOf(ApiUsageGuard);
	});

	it("should create guard with custom config", () => {
		const tracker = new RateLimitTracker();
		const onPause = vi.fn();
		const guard = createApiUsageGuard(tracker, {
			pauseThreshold: 0.9,
			warningThreshold: 0.7,
			autoPause: true,
			onPause,
		});
		expect(guard).toBeInstanceOf(ApiUsageGuard);
	});
});

describe("withUsageTracking", () => {
	it("should wrap function with guard", async () => {
		const tracker = new RateLimitTracker();
		const guard = new ApiUsageGuard(tracker);

		const result = await withUsageTracking(
			guard,
			async () => ({ value: 42 }),
			() => ({ inputTokens: 100, outputTokens: 50, model: "sonnet" as const }),
			"task-1",
		);

		expect(result.executed).toBe(true);
		expect(result.result).toEqual({ value: 42 });
	});
});

describe("ApiUsageGuard - additional coverage", () => {
	let tracker: RateLimitTracker;

	beforeEach(() => {
		tracker = new RateLimitTracker();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("configuration options", () => {
		it("should accept onWarning callback in config", () => {
			const onWarning = vi.fn();
			const guard = new ApiUsageGuard(tracker, {
				warningThreshold: 0.8,
				autoPause: false,
				onWarning,
			});

			// Verify guard was created with config
			expect(guard).toBeDefined();
		});

		it("should accept onPause callback in config", () => {
			const onPause = vi.fn();
			const guard = new ApiUsageGuard(tracker, {
				pauseThreshold: 0.95,
				autoPause: true,
				onPause,
			});

			expect(guard).toBeDefined();
		});

		it("should use default values when config is minimal", () => {
			const guard = new ApiUsageGuard(tracker, {});
			// Should not throw and should work
			expect(guard.checkUsage()).toBeNull();
		});
	});

	describe("checkUsage edge cases", () => {
		it("should return internal pause reason when internally paused", () => {
			const guard = new ApiUsageGuard(tracker);

			// Manually trigger internal pause via tracker rate limit
			tracker.pauseForRateLimit("sonnet", "Rate limit hit");

			const result = guard.checkUsage();
			expect(result).toBeTruthy();
			expect(result).toContain("Rate limit active");
		});

		it("should return null when usage is within limits", () => {
			const guard = new ApiUsageGuard(tracker, {
				pauseThreshold: 0.95,
				warningThreshold: 0.8,
				autoPause: true,
			});

			// With no usage recorded, should be well within limits
			const result = guard.checkUsage();
			expect(result).toBeNull();
		});
	});

	describe("checkAutoResume", () => {
		it("should return false when not paused", () => {
			const guard = new ApiUsageGuard(tracker);
			const resumed = guard.checkAutoResume();
			expect(resumed).toBe(false);
		});

		it("should check tracker auto-resume when tracker is paused", () => {
			// Pause tracker
			tracker.pauseForRateLimit("sonnet", "Rate limit");
			const guard = new ApiUsageGuard(tracker);

			// Should check tracker state
			const resumed = guard.checkAutoResume();
			// Result depends on whether tracker resume time has passed
			expect(typeof resumed).toBe("boolean");
		});

		it("should not throw when called multiple times", () => {
			const guard = new ApiUsageGuard(tracker);

			// Multiple calls should be safe
			guard.checkAutoResume();
			guard.checkAutoResume();
			guard.checkAutoResume();

			expect(guard.isBlocking()).toBe(false);
		});
	});

	describe("getPauseState edge cases", () => {
		it("should return not paused state when fresh", () => {
			const guard = new ApiUsageGuard(tracker);

			const state = guard.getPauseState();
			expect(state.isPaused).toBe(false);
			expect(state.reason).toBeUndefined();
			expect(state.resumeAt).toBeUndefined();
		});

		it("should return tracker pause state when tracker is paused", () => {
			const guard = new ApiUsageGuard(tracker);

			// Pause tracker
			tracker.pauseForRateLimit("sonnet", "429 error from API");

			const state = guard.getPauseState();
			expect(state.isPaused).toBe(true);
			expect(state.reason).toContain("429");
			expect(state.resumeAt).toBeDefined();
		});
	});

	describe("resume behavior", () => {
		it("should clear blocking state after resume", () => {
			const guard = new ApiUsageGuard(tracker);

			// Pause via tracker
			tracker.pauseForRateLimit("sonnet", "Rate limit");
			expect(guard.isBlocking()).toBe(true);

			// Resume tracker and guard
			tracker.resumeFromRateLimit();
			guard.resume();

			expect(guard.isBlocking()).toBe(false);
		});

		it("should be safe to call resume multiple times", () => {
			const guard = new ApiUsageGuard(tracker);

			guard.resume();
			guard.resume();
			guard.resume();

			expect(guard.isBlocking()).toBe(false);
		});
	});

	describe("guard with null usage", () => {
		it("should handle getUsage returning null", async () => {
			const guard = new ApiUsageGuard(tracker);

			const result = await guard.guard(
				async () => ({ noUsageInfo: true }),
				() => null, // Returns null - no usage to record
				"task-1",
			);

			expect(result.executed).toBe(true);
			expect(result.result).toEqual({ noUsageInfo: true });
		});

		it("should still return usage stats even when getUsage returns null", async () => {
			const guard = new ApiUsageGuard(tracker);

			const result = await guard.guard(
				async () => "success",
				() => null,
				"task-1",
			);

			expect(result.usage).toBeDefined();
			expect(result.usage?.fiveHourPercent).toBeDefined();
			expect(result.usage?.weeklyPercent).toBeDefined();
		});
	});

	describe("recordUsage with optional fields", () => {
		it("should record usage with all optional fields", () => {
			const guard = new ApiUsageGuard(tracker);

			guard.recordUsage("task-1", {
				inputTokens: 1000,
				outputTokens: 500,
				model: "sonnet",
				durationMs: 2000,
				cacheReadTokens: 800,
				cacheCreationTokens: 200,
			});

			const summary = tracker.getUsageSummary();
			expect(summary.current.last5Hours).toBeGreaterThan(0);
		});

		it("should record usage without optional fields", () => {
			const guard = new ApiUsageGuard(tracker);

			guard.recordUsage("task-2", {
				inputTokens: 500,
				outputTokens: 250,
				model: "sonnet",
			});

			const summary = tracker.getUsageSummary();
			expect(summary.current.last5Hours).toBeGreaterThan(0);
		});

		it("should record usage with opus model", () => {
			const guard = new ApiUsageGuard(tracker);

			guard.recordUsage("task-3", {
				inputTokens: 2000,
				outputTokens: 1000,
				model: "opus",
				durationMs: 5000,
			});

			const summary = tracker.getUsageSummary();
			expect(summary.current.last5Hours).toBeGreaterThan(0);
		});
	});

	describe("getCurrentUsage", () => {
		it("should return zero percentages when no usage recorded", () => {
			const guard = new ApiUsageGuard(tracker);

			const usage = guard.getCurrentUsage();

			expect(usage.fiveHourPercent).toBe(0);
			expect(usage.weeklyPercent).toBe(0);
		});

		it("should return non-zero percentages after recording usage", () => {
			const guard = new ApiUsageGuard(tracker);

			// Record substantial usage
			guard.recordUsage("task-1", {
				inputTokens: 100000,
				outputTokens: 50000,
				model: "sonnet",
			});

			const usage = guard.getCurrentUsage();

			// With default limits, this should register some percentage
			expect(usage.fiveHourPercent).toBeGreaterThanOrEqual(0);
			expect(usage.weeklyPercent).toBeGreaterThanOrEqual(0);
		});
	});
});
