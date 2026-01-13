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
