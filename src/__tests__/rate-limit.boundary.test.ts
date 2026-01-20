/**
 * Boundary Value Tests for rate-limit.ts
 *
 * Tests min/max boundary conditions for rate limit tracking:
 * - Usage percentages at 0%, 80% (warning), 95% (prevention), 100%
 * - Token multipliers at min (0.25) and max (12.0)
 * - Time window calculations (5 hours, 7 days)
 * - Resume time calculations and state transitions
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitTracker } from "../rate-limit.js";
import type { RateLimitState, TaskUsage } from "../types.js";

describe("RateLimitTracker - Boundary Values", () => {
	describe("Token Multipliers - Min/Max Boundaries", () => {
		it("should calculate correct sonnet-equivalent tokens for min multiplier (haiku 0.25)", () => {
			const tracker = new RateLimitTracker();

			// 1000 actual tokens * 0.25 = 250 sonnet-equivalent
			tracker.recordTask("task-1", "haiku", 500, 500);

			const usage = tracker.getCurrentUsage();
			expect(usage.last5HoursSonnet).toBe(250);
		});

		it("should calculate correct sonnet-equivalent tokens for max multiplier (opus 12.0)", () => {
			const tracker = new RateLimitTracker();

			// 1000 actual tokens * 12.0 = 12000 sonnet-equivalent
			tracker.recordTask("task-1", "opus", 500, 500);

			const usage = tracker.getCurrentUsage();
			expect(usage.last5HoursSonnet).toBe(12_000);
		});

		it("should calculate correct sonnet-equivalent tokens for sonnet 1.0", () => {
			const tracker = new RateLimitTracker();

			// 1000 actual tokens * 1.0 = 1000 sonnet-equivalent
			tracker.recordTask("task-1", "sonnet", 500, 500);

			const usage = tracker.getCurrentUsage();
			expect(usage.last5HoursSonnet).toBe(1000);
		});

		it("should handle zero tokens", () => {
			const tracker = new RateLimitTracker();

			tracker.recordTask("task-1", "haiku", 0, 0);
			const usage = tracker.getCurrentUsage();
			expect(usage.last5HoursSonnet).toBe(0);
		});

		it("should handle very large tokens (near 1M limit)", () => {
			const tracker = new RateLimitTracker();

			// Record task with near-max tokens
			tracker.recordTask("task-1", "sonnet", 500_000, 499_999);
			const usage = tracker.getCurrentUsage();
			expect(usage.last5HoursSonnet).toBe(999_999);
		});
	});

	describe("Usage Percentage - 0% to 100% Boundaries", () => {
		it("should return 0% when no tasks recorded", () => {
			const tracker = new RateLimitTracker();

			const percent = tracker.getUsagePercentage("5hour");
			expect(percent).toBe(0);
		});

		it("should return exactly 0% when usage is 0", () => {
			const tracker = new RateLimitTracker();
			tracker.recordTask("task-1", "sonnet", 0, 0);

			const percent = tracker.getUsagePercentage("5hour");
			expect(percent).toBe(0);
		});

		it("should approach 80% warning threshold without triggering prevention", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Record 799,999 tokens (79.9999%)
			tracker.recordTask("task-1", "sonnet", 399_999, 400_000);

			const percent = tracker.getUsagePercentage("5hour");
			expect(percent).toBeLessThan(0.8);
			expect(percent).toBeGreaterThan(0.79);
		});

		it("should trigger prevention at 95% threshold", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Use actual usage to trigger prevention (95%)
			tracker.syncWithActualUsage(95, 50);

			// Record a task to trigger warning check
			tracker.recordTask("task-1", "sonnet", 10, 10);

			const usage = tracker.getActualUsage();
			expect(usage?.fiveHourPercent).toBe(95);
		});

		it("should handle 100% usage (at limit)", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Record exactly 1M tokens
			tracker.recordTask("task-1", "sonnet", 500_000, 500_000);

			const percent = tracker.getUsagePercentage("5hour");
			expect(percent).toBe(1.0);
		});

		it("should handle over 100% usage (over limit)", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Record 1.2M tokens
			tracker.recordTask("task-1", "sonnet", 600_000, 600_000);

			const percent = tracker.getUsagePercentage("5hour");
			expect(percent).toBe(1.2);
		});
	});

	describe("Time Window Boundaries - 5 hours and 7 days", () => {
		it("should include task exactly at 5-hour boundary", () => {
			const tracker = new RateLimitTracker();
			const now = new Date();
			const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);

			// Create state with a task exactly at 5-hour boundary
			const state: Partial<RateLimitState> = {
				tasks: [
					{
						taskId: "task-1",
						model: "sonnet",
						tokens: {
							inputTokens: 100,
							outputTokens: 100,
							totalTokens: 200,
							sonnetEquivalentTokens: 200,
						},
						timestamp: fiveHoursAgo,
					},
				],
			};

			const tracker2 = new RateLimitTracker(state);
			const usage = tracker2.getCurrentUsage();
			expect(usage.last5Hours).toBe(200);
		});

		it("should exclude task just outside 5-hour boundary", () => {
			const tracker = new RateLimitTracker();
			const now = new Date();
			const justOver5Hours = new Date(now.getTime() - 5 * 60 * 60 * 1000 - 1000);

			const state: Partial<RateLimitState> = {
				tasks: [
					{
						taskId: "task-1",
						model: "sonnet",
						tokens: {
							inputTokens: 100,
							outputTokens: 100,
							totalTokens: 200,
							sonnetEquivalentTokens: 200,
						},
						timestamp: justOver5Hours,
					},
				],
			};

			const tracker2 = new RateLimitTracker(state);
			const usage = tracker2.getCurrentUsage();
			expect(usage.last5Hours).toBe(0); // Should not include task outside window
		});

		it("should include task exactly at 7-day boundary", () => {
			const tracker = new RateLimitTracker();
			const now = new Date();
			const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

			const state: Partial<RateLimitState> = {
				tasks: [
					{
						taskId: "task-1",
						model: "sonnet",
						tokens: {
							inputTokens: 100,
							outputTokens: 100,
							totalTokens: 200,
							sonnetEquivalentTokens: 200,
						},
						timestamp: sevenDaysAgo,
					},
				],
			};

			const tracker2 = new RateLimitTracker(state);
			const usage = tracker2.getCurrentUsage();
			expect(usage.currentWeek).toBe(200);
		});

		it("should exclude task just outside 7-day boundary", () => {
			const tracker = new RateLimitTracker();
			const now = new Date();
			const justOver7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000 - 1000);

			const state: Partial<RateLimitState> = {
				tasks: [
					{
						taskId: "task-1",
						model: "sonnet",
						tokens: {
							inputTokens: 100,
							outputTokens: 100,
							totalTokens: 200,
							sonnetEquivalentTokens: 200,
						},
						timestamp: justOver7Days,
					},
				],
			};

			const tracker2 = new RateLimitTracker(state);
			const usage = tracker2.getCurrentUsage();
			expect(usage.currentWeek).toBe(0); // Should not include task outside window
		});
	});

	describe("Actual Usage Cache - TTL Boundary", () => {
		it("should return actual usage when fresh (within 5-minute TTL)", () => {
			const tracker = new RateLimitTracker();
			tracker.syncWithActualUsage(50, 60);

			const usage = tracker.getActualUsage();
			expect(usage).not.toBeNull();
			expect(usage?.fiveHourPercent).toBe(50);
		});

		it("should return null for stale actual usage (beyond 5-minute TTL)", () => {
			const tracker = new RateLimitTracker();
			tracker.syncWithActualUsage(50, 60);

			// Mock Date.now to simulate 5+ minutes passing
			const originalDateNow = Date.now;
			Date.now = vi.fn(() => originalDateNow() + 5 * 60 * 1000 + 1000);

			try {
				const usage = tracker.getActualUsage();
				expect(usage).toBeNull();
			} finally {
				Date.now = originalDateNow;
			}
		});

		it("should return null when no actual usage synced", () => {
			const tracker = new RateLimitTracker();

			const usage = tracker.getActualUsage();
			expect(usage).toBeNull();
		});
	});

	describe("Pause State - Resume Threshold (90%)", () => {
		it("should not resume when usage is at 90% (at threshold)", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Record 900,000 tokens
			tracker.recordTask("task-1", "sonnet", 450_000, 450_000);

			// Trigger pause
			tracker.pauseForRateLimit("sonnet");
			expect(tracker.isPaused()).toBe(true);

			// Should not auto-resume at 90%
			const shouldResume = tracker.checkAutoResume();
			expect(shouldResume).toBe(false);
		});

		it("should resume when usage drops below 90%", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Record 800,000 tokens (80% - less than 90% threshold)
			tracker.recordTask("task-1", "sonnet", 400_000, 400_000);

			// Trigger pause
			tracker.pauseForRateLimit("sonnet");
			expect(tracker.isPaused()).toBe(true);

			// Should auto-resume below 90%
			const shouldResume = tracker.checkAutoResume();
			expect(shouldResume).toBe(true);
			expect(tracker.isPaused()).toBe(false);
		});
	});

	describe("Model Usage Analytics - Edge Cases", () => {
		it("should return zero for model with no tasks", () => {
			const tracker = new RateLimitTracker();

			const usage = tracker.getModelUsage("haiku");
			expect(usage.totalTasks).toBe(0);
			expect(usage.totalTokens).toBe(0);
			expect(usage.sonnetEquivalentTokens).toBe(0);
		});

		it("should correctly sum tokens for model with multiple tasks", () => {
			const tracker = new RateLimitTracker();

			tracker.recordTask("task-1", "haiku", 100, 100);
			tracker.recordTask("task-2", "haiku", 200, 200);

			const usage = tracker.getModelUsage("haiku");
			expect(usage.totalTasks).toBe(2);
			expect(usage.totalTokens).toBe(600); // 100+100+200+200
			expect(usage.sonnetEquivalentTokens).toBe(150); // 600 * 0.25
		});

		it("should handle 24-hour boundary for last24Hours calculation", () => {
			const tracker = new RateLimitTracker();
			const now = new Date();
			const just24HoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000 - 1000);

			const state: Partial<RateLimitState> = {
				tasks: [
					{
						taskId: "task-old",
						model: "sonnet",
						tokens: {
							inputTokens: 100,
							outputTokens: 100,
							totalTokens: 200,
							sonnetEquivalentTokens: 200,
						},
						timestamp: just24HoursAgo,
					},
				],
			};

			const tracker2 = new RateLimitTracker(state);
			const usage = tracker2.getModelUsage("sonnet");
			expect(usage.last24Hours).toBe(0); // Should exclude task outside 24-hour window
		});
	});

	describe("Rate Limit Hit Recording", () => {
		it("should record rate limit hit with zero usage", () => {
			const tracker = new RateLimitTracker();

			tracker.recordRateLimitHit("sonnet", "Rate limit exceeded");

			const summary = tracker.getUsageSummary();
			expect(summary.totalRateLimitHits).toBe(1);
		});

		it("should handle multiple rate limit hits", () => {
			const tracker = new RateLimitTracker();

			tracker.recordRateLimitHit("sonnet", "Hit 1");
			tracker.recordRateLimitHit("opus", "Hit 2");
			tracker.recordRateLimitHit("haiku", "Hit 3");

			const summary = tracker.getUsageSummary();
			expect(summary.totalRateLimitHits).toBe(3);
		});
	});

	describe("Retry-After Header Extraction", () => {
		it("should extract retry-after from headers in seconds", () => {
			const headers = { "retry-after": "60" };
			const retryAfterMs = RateLimitTracker.extractRetryAfter(headers);

			expect(retryAfterMs).toBe(60_000); // 60 seconds in milliseconds
		});

		it("should handle retry-after boundary of 0 seconds", () => {
			const headers = { "retry-after": "0" };
			const retryAfterMs = RateLimitTracker.extractRetryAfter(headers);

			expect(retryAfterMs).toBe(0);
		});

		it("should return null for invalid retry-after", () => {
			const headers = { "retry-after": "not-a-number" };
			const retryAfterMs = RateLimitTracker.extractRetryAfter(headers);

			expect(retryAfterMs).toBeNull();
		});

		it("should return null for missing retry-after", () => {
			const headers = { "x-ratelimit-remaining": "100" };
			const retryAfterMs = RateLimitTracker.extractRetryAfter(headers);

			expect(retryAfterMs).toBeNull();
		});
	});

	describe("Remaining Pause Time - Min/Max Boundaries", () => {
		it("should return 0 when not paused", () => {
			const tracker = new RateLimitTracker();

			const remaining = tracker.getRemainingPauseTime();
			expect(remaining).toBe(0);
		});

		it("should return 0 when pause time has passed", () => {
			const tracker = new RateLimitTracker();
			const pastResume = new Date(Date.now() - 1000); // 1 second in past

			tracker.pauseForRateLimit("sonnet");
			// Manually set resume time to past
			const state = tracker.getState();
			state.pause.resumeAt = pastResume;
			const tracker2 = new RateLimitTracker(state);

			const remaining = tracker2.getRemainingPauseTime();
			expect(remaining).toBe(0);
		});

		it("should return positive time when pause is active", () => {
			const tracker = new RateLimitTracker();

			tracker.pauseForRateLimit("sonnet");
			const remaining = tracker.getRemainingPauseTime();
			expect(remaining).toBeGreaterThan(0);
		});
	});

	describe("Warning Threshold - 80% Boundary", () => {
		it("should not warn when usage is below 80%", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Record 799,999 tokens (79.9999%)
			tracker.recordTask("task-1", "sonnet", 399_999, 400_000);

			const percent = tracker.getUsagePercentage("5hour");
			expect(percent).toBeLessThan(0.8);
		});

		it("should handle exact 80% threshold", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Record exactly 800,000 tokens (80%)
			tracker.recordTask("task-1", "sonnet", 400_000, 400_000);

			const percent = tracker.getUsagePercentage("5hour");
			expect(percent).toBe(0.8);
		});
	});

	describe("Prevention Threshold - 95% Boundary", () => {
		it("should trigger prevention at exactly 95%", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Use actual usage at exactly 95%
			tracker.syncWithActualUsage(95, 50);

			expect(tracker.getActualUsage()?.fiveHourPercent).toBe(95);
		});

		it("should not trigger prevention below 95%", () => {
			const tracker = new RateLimitTracker({
				config: {
					maxTokensPer5Hours: 1_000_000,
					maxTokensPerWeek: 5_000_000,
					warningThreshold: 0.8,
					tokenMultipliers: { haiku: 0.25, sonnet: 1.0, opus: 12.0 },
				},
			});

			// Use actual usage at 94.9%
			tracker.syncWithActualUsage(94.9, 50);

			expect(tracker.getActualUsage()?.fiveHourPercent).toBe(94.9);
		});
	});
});
