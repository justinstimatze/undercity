/**
 * Tests for orchestrator/budget-and-aggregation.ts
 *
 * Pure functions for opus budget checking and task result aggregation.
 */

import { describe, expect, it } from "vitest";
import {
	aggregateTaskResults,
	buildSummaryItems,
	calculateOpusUsagePercent,
	calculateSuccessRate,
	canUseOpusBudget,
	generateTaskBatches,
	isBatchSuccessful,
	type ParallelTaskResult,
	shouldContinueBatchProcessing,
} from "../orchestrator/budget-and-aggregation.js";

// Helper to create mock task results
const createResult = (overrides: Partial<ParallelTaskResult> = {}): ParallelTaskResult => ({
	task: "test task",
	taskId: "task-1",
	result: {
		task: "test task",
		status: "complete",
		model: "sonnet",
		attempts: 1,
		durationMs: 1000,
		tokenUsage: { attempts: [], total: 0 },
	},
	...overrides,
});

describe("orchestrator/budget-and-aggregation", () => {
	describe("canUseOpusBudget", () => {
		it("always allows first opus task", () => {
			expect(canUseOpusBudget(0, 0, 10)).toBe(true);
			expect(canUseOpusBudget(0, 10, 10)).toBe(true);
			expect(canUseOpusBudget(0, 100, 1)).toBe(true);
		});

		it("allows opus when under budget", () => {
			// 1 opus out of 20 total = 5%, under 10% budget
			expect(canUseOpusBudget(1, 20, 10)).toBe(true);
		});

		it("blocks opus when at budget", () => {
			// 1 opus out of 10 total = 10%, at 10% budget
			expect(canUseOpusBudget(1, 10, 10)).toBe(false);
		});

		it("blocks opus when over budget", () => {
			// 2 opus out of 10 total = 20%, over 10% budget
			expect(canUseOpusBudget(2, 10, 10)).toBe(false);
		});

		it("handles zero total tasks (uses max of 1)", () => {
			// 1 opus / max(1, 0) = 100%, over any reasonable budget
			expect(canUseOpusBudget(1, 0, 10)).toBe(false);
		});

		it("respects custom budget percentage", () => {
			// 2 opus out of 10 = 20%, under 25% budget
			expect(canUseOpusBudget(2, 10, 25)).toBe(true);
			// 3 opus out of 10 = 30%, over 25% budget
			expect(canUseOpusBudget(3, 10, 25)).toBe(false);
		});

		it("uses default 10% budget", () => {
			expect(canUseOpusBudget(1, 11, undefined as unknown as number)).toBe(true); // 9% < 10%
			expect(canUseOpusBudget(1, 10, undefined as unknown as number)).toBe(false); // 10% = 10%
		});
	});

	describe("calculateOpusUsagePercent", () => {
		it("returns 0 for no tasks", () => {
			expect(calculateOpusUsagePercent(0, 0)).toBe(0);
		});

		it("returns 0 for no opus tasks", () => {
			expect(calculateOpusUsagePercent(0, 10)).toBe(0);
		});

		it("calculates correct percentage", () => {
			expect(calculateOpusUsagePercent(1, 10)).toBe(10);
			expect(calculateOpusUsagePercent(5, 20)).toBe(25);
			expect(calculateOpusUsagePercent(10, 10)).toBe(100);
		});
	});

	describe("aggregateTaskResults", () => {
		it("handles empty results", () => {
			const agg = aggregateTaskResults([]);
			expect(agg.successful).toBe(0);
			expect(agg.failed).toBe(0);
			expect(agg.merged).toBe(0);
			expect(agg.decomposed).toBe(0);
			expect(agg.mergeFailed).toBe(0);
			expect(agg.total).toBe(0);
		});

		it("counts successful tasks", () => {
			const results = [createResult(), createResult({ taskId: "task-2" })];
			const agg = aggregateTaskResults(results);
			expect(agg.successful).toBe(2);
			expect(agg.failed).toBe(0);
		});

		it("counts failed tasks", () => {
			const results = [
				createResult({
					result: {
						task: "test",
						status: "failed",
						model: "sonnet",
						attempts: 1,
						durationMs: 1000,
						tokenUsage: { attempts: [], total: 0 },
					},
				}),
				createResult({ result: null }),
			];
			const agg = aggregateTaskResults(results);
			expect(agg.successful).toBe(0);
			expect(agg.failed).toBe(2);
		});

		it("counts merged tasks", () => {
			const results = [createResult({ merged: true }), createResult({ taskId: "task-2", merged: false })];
			const agg = aggregateTaskResults(results);
			expect(agg.merged).toBe(1);
		});

		it("excludes decomposed from successful and failed", () => {
			const results = [
				createResult({ decomposed: true }),
				createResult({
					taskId: "task-2",
					decomposed: true,
					result: {
						task: "test",
						status: "failed",
						model: "sonnet",
						attempts: 1,
						durationMs: 1000,
						tokenUsage: { attempts: [], total: 0 },
					},
				}),
			];
			const agg = aggregateTaskResults(results);
			expect(agg.successful).toBe(0);
			expect(agg.failed).toBe(0);
			expect(agg.decomposed).toBe(2);
		});

		it("calculates merge failures correctly", () => {
			const results = [
				createResult({ branch: "branch-1", merged: true }),
				createResult({ taskId: "task-2", branch: "branch-2", merged: false }),
				createResult({ taskId: "task-3", branch: "branch-3" }), // merged undefined = not merged
			];
			const agg = aggregateTaskResults(results);
			expect(agg.successful).toBe(3);
			expect(agg.merged).toBe(1);
			expect(agg.mergeFailed).toBe(2); // 3 successful with branch - 1 merged
		});

		it("returns correct total", () => {
			const results = [createResult(), createResult({ taskId: "task-2" }), createResult({ taskId: "task-3" })];
			expect(aggregateTaskResults(results).total).toBe(3);
		});
	});

	describe("buildSummaryItems", () => {
		it("builds basic summary items", () => {
			const agg = { successful: 5, failed: 2, merged: 4, decomposed: 0, mergeFailed: 0, total: 7 };
			const items = buildSummaryItems(agg, 60000);

			expect(items).toHaveLength(4);
			expect(items[0]).toEqual({ label: "Executed", value: 5, status: "good" });
			expect(items[1]).toEqual({ label: "Failed", value: 2, status: "bad" });
			expect(items[2]).toEqual({ label: "Merged", value: 4 });
			expect(items[3]).toEqual({ label: "Duration", value: "60s" });
		});

		it("includes decomposed when present", () => {
			const agg = { successful: 3, failed: 0, merged: 3, decomposed: 2, mergeFailed: 0, total: 5 };
			const items = buildSummaryItems(agg, 30000);

			expect(items).toHaveLength(5);
			expect(items[4]).toEqual({ label: "Decomposed", value: 2, status: "neutral" });
		});

		it("includes merge failed when present", () => {
			const agg = { successful: 5, failed: 0, merged: 3, decomposed: 0, mergeFailed: 2, total: 5 };
			const items = buildSummaryItems(agg, 30000);

			expect(items).toHaveLength(5);
			expect(items[4]).toEqual({ label: "Merge failed", value: 2, status: "bad" });
		});

		it("marks executed as neutral when zero", () => {
			const agg = { successful: 0, failed: 0, merged: 0, decomposed: 3, mergeFailed: 0, total: 3 };
			const items = buildSummaryItems(agg, 1000);

			expect(items[0].status).toBe("neutral");
		});

		it("marks failed as neutral when zero", () => {
			const agg = { successful: 5, failed: 0, merged: 5, decomposed: 0, mergeFailed: 0, total: 5 };
			const items = buildSummaryItems(agg, 1000);

			expect(items[1].status).toBe("neutral");
		});

		it("rounds duration to whole seconds", () => {
			const agg = { successful: 1, failed: 0, merged: 1, decomposed: 0, mergeFailed: 0, total: 1 };

			expect(buildSummaryItems(agg, 1500)[3].value).toBe("2s");
			expect(buildSummaryItems(agg, 1499)[3].value).toBe("1s");
		});
	});

	describe("calculateSuccessRate", () => {
		it("returns 100 for all successful", () => {
			const agg = { successful: 10, failed: 0, merged: 0, decomposed: 0, mergeFailed: 0, total: 10 };
			expect(calculateSuccessRate(agg)).toBe(100);
		});

		it("returns 0 for all failed", () => {
			const agg = { successful: 0, failed: 10, merged: 0, decomposed: 0, mergeFailed: 0, total: 10 };
			expect(calculateSuccessRate(agg)).toBe(0);
		});

		it("calculates correct percentage", () => {
			const agg = { successful: 7, failed: 3, merged: 0, decomposed: 0, mergeFailed: 0, total: 10 };
			expect(calculateSuccessRate(agg)).toBe(70);
		});

		it("returns 100 for no executed tasks", () => {
			const agg = { successful: 0, failed: 0, merged: 0, decomposed: 5, mergeFailed: 0, total: 5 };
			expect(calculateSuccessRate(agg)).toBe(100);
		});
	});

	describe("isBatchSuccessful", () => {
		it("returns true for no executed tasks", () => {
			const agg = { successful: 0, failed: 0, merged: 0, decomposed: 5, mergeFailed: 0, total: 5 };
			expect(isBatchSuccessful(agg)).toBe(true);
		});

		it("returns true when success rate above threshold", () => {
			const agg = { successful: 6, failed: 4, merged: 0, decomposed: 0, mergeFailed: 0, total: 10 };
			expect(isBatchSuccessful(agg, 50)).toBe(true); // 60% > 50%
		});

		it("returns true when success rate equals threshold", () => {
			const agg = { successful: 5, failed: 5, merged: 0, decomposed: 0, mergeFailed: 0, total: 10 };
			expect(isBatchSuccessful(agg, 50)).toBe(true); // 50% >= 50%
		});

		it("returns false when success rate below threshold", () => {
			const agg = { successful: 4, failed: 6, merged: 0, decomposed: 0, mergeFailed: 0, total: 10 };
			expect(isBatchSuccessful(agg, 50)).toBe(false); // 40% < 50%
		});

		it("uses 50% default threshold", () => {
			const agg = { successful: 5, failed: 5, merged: 0, decomposed: 0, mergeFailed: 0, total: 10 };
			expect(isBatchSuccessful(agg)).toBe(true);
		});
	});

	describe("shouldContinueBatchProcessing", () => {
		it("stops when draining", () => {
			const decision = shouldContinueBatchProcessing(true, 5);
			expect(decision.continueProcessing).toBe(false);
			expect(decision.reason).toContain("Drain");
			expect(decision.reason).toContain("5");
		});

		it("stops when no tasks remaining", () => {
			const decision = shouldContinueBatchProcessing(false, 0);
			expect(decision.continueProcessing).toBe(false);
			expect(decision.reason).toContain("All tasks processed");
		});

		it("continues when tasks remain and not draining", () => {
			const decision = shouldContinueBatchProcessing(false, 10);
			expect(decision.continueProcessing).toBe(true);
			expect(decision.reason).toContain("10");
		});

		it("handles negative remaining tasks", () => {
			const decision = shouldContinueBatchProcessing(false, -1);
			expect(decision.continueProcessing).toBe(false);
		});
	});

	describe("generateTaskBatches", () => {
		it("returns empty array for no tasks", () => {
			expect(generateTaskBatches([], 3)).toEqual([]);
		});

		it("returns single batch when fewer than max", () => {
			const tasks = ["a", "b"];
			expect(generateTaskBatches(tasks, 5)).toEqual([["a", "b"]]);
		});

		it("returns single batch when exactly max", () => {
			const tasks = ["a", "b", "c"];
			expect(generateTaskBatches(tasks, 3)).toEqual([["a", "b", "c"]]);
		});

		it("splits into multiple batches", () => {
			const tasks = ["a", "b", "c", "d", "e"];
			expect(generateTaskBatches(tasks, 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
		});

		it("handles max of 1", () => {
			const tasks = ["a", "b", "c"];
			expect(generateTaskBatches(tasks, 1)).toEqual([["a"], ["b"], ["c"]]);
		});

		it("preserves task order", () => {
			const tasks = ["first", "second", "third", "fourth"];
			const batches = generateTaskBatches(tasks, 2);
			expect(batches[0]).toEqual(["first", "second"]);
			expect(batches[1]).toEqual(["third", "fourth"]);
		});
	});
});
