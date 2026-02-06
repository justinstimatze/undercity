/**
 * Tests for worker/task-results.ts
 *
 * Pure functions for building TaskResult objects.
 */

import { describe, expect, it, vi } from "vitest";
import type { TokenUsage } from "../types.js";
import {
	buildInvalidTargetResult,
	buildNeedsDecompositionResult,
	buildTokenUsageSummary,
	buildValidationFailureResult,
	calculateTotalTokens,
	type FailureResultContext,
	isStandardImplementationTask,
	isTaskAlreadyComplete,
	parseSuggestedSubtasks,
} from "../worker/task-results.js";

// Mock the logger to avoid noise
vi.mock("../logger.js", () => ({
	sessionLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

describe("worker/task-results", () => {
	describe("calculateTotalTokens", () => {
		it("returns 0 for empty array", () => {
			expect(calculateTotalTokens([])).toBe(0);
		});

		it("sums totalTokens from single usage", () => {
			const usages: TokenUsage[] = [{ inputTokens: 100, outputTokens: 50, totalTokens: 150 }];
			expect(calculateTotalTokens(usages)).toBe(150);
		});

		it("sums totalTokens from multiple usages", () => {
			const usages: TokenUsage[] = [
				{ inputTokens: 100, outputTokens: 50, totalTokens: 150 },
				{ inputTokens: 200, outputTokens: 100, totalTokens: 300 },
				{ inputTokens: 50, outputTokens: 25, totalTokens: 75 },
			];
			expect(calculateTotalTokens(usages)).toBe(525);
		});
	});

	describe("buildTokenUsageSummary", () => {
		it("returns empty summary for no attempts", () => {
			const result = buildTokenUsageSummary([]);
			expect(result.attempts).toEqual([]);
			expect(result.total).toBe(0);
		});

		it("includes all attempts and calculates total", () => {
			const attempts: TokenUsage[] = [
				{ inputTokens: 100, outputTokens: 50, totalTokens: 150 },
				{ inputTokens: 200, outputTokens: 100, totalTokens: 300 },
			];
			const result = buildTokenUsageSummary(attempts);
			expect(result.attempts).toEqual(attempts);
			expect(result.total).toBe(450);
		});
	});

	describe("parseSuggestedSubtasks", () => {
		it("returns undefined when no semicolons", () => {
			expect(parseSuggestedSubtasks("single task")).toBeUndefined();
		});

		it("splits on semicolons and trims", () => {
			const result = parseSuggestedSubtasks("task 1 ; task 2 ; task 3");
			expect(result).toEqual(["task 1", "task 2", "task 3"]);
		});

		it("filters empty segments", () => {
			const result = parseSuggestedSubtasks("task 1 ; ; task 2 ; ");
			expect(result).toEqual(["task 1", "task 2"]);
		});

		it("handles whitespace-only segments", () => {
			const result = parseSuggestedSubtasks("task 1 ;    ; task 2");
			expect(result).toEqual(["task 1", "task 2"]);
		});
	});

	describe("isTaskAlreadyComplete", () => {
		const passedVerification = {
			passed: true,
			filesChanged: 0,
			issues: [],
		};

		const failedVerification = {
			passed: false,
			filesChanged: 0,
			issues: [{ type: "typecheck" as const, message: "error" }],
		};

		const changedFilesVerification = {
			passed: true,
			filesChanged: 3,
			issues: [],
		};

		it("returns true when passed, no changes, and task complete reason exists", () => {
			expect(isTaskAlreadyComplete(passedVerification, "already done", 0)).toBe(true);
		});

		it("returns true when passed, no changes, and no-op edits detected", () => {
			expect(isTaskAlreadyComplete(passedVerification, null, 1)).toBe(true);
		});

		it("returns false when verification failed", () => {
			expect(isTaskAlreadyComplete(failedVerification, "already done", 0)).toBe(false);
		});

		it("returns false when files were changed", () => {
			expect(isTaskAlreadyComplete(changedFilesVerification, "already done", 0)).toBe(false);
		});

		it("returns false when passed but no completion indicator", () => {
			expect(isTaskAlreadyComplete(passedVerification, null, 0)).toBe(false);
		});
	});

	describe("isStandardImplementationTask", () => {
		it("returns true for normal tasks", () => {
			expect(isStandardImplementationTask(false, false)).toBe(true);
		});

		it("returns false for meta tasks", () => {
			expect(isStandardImplementationTask(true, false)).toBe(false);
		});

		it("returns false for research tasks", () => {
			expect(isStandardImplementationTask(false, true)).toBe(false);
		});

		it("returns false when both meta and research", () => {
			expect(isStandardImplementationTask(true, true)).toBe(false);
		});
	});

	describe("buildInvalidTargetResult", () => {
		const createContext = (): FailureResultContext => ({
			task: "fix bug in nonexistent.ts",
			taskId: "task-123",
			model: "sonnet",
			attempts: 1,
			startTime: Date.now() - 1000,
			tokenUsageThisTask: [{ inputTokens: 100, outputTokens: 50, totalTokens: 150 }],
		});

		it("builds failed result with INVALID_TARGET error", () => {
			const ctx = createContext();
			const result = buildInvalidTargetResult(ctx, "file does not exist");

			expect(result.status).toBe("failed");
			expect(result.error).toBe("INVALID_TARGET: file does not exist");
			expect(result.task).toBe(ctx.task);
			expect(result.model).toBe("sonnet");
			expect(result.attempts).toBe(1);
		});

		it("calculates duration from startTime", () => {
			const ctx = createContext();
			ctx.startTime = Date.now() - 5000;
			const result = buildInvalidTargetResult(ctx, "reason");

			expect(result.durationMs).toBeGreaterThanOrEqual(5000);
			expect(result.durationMs).toBeLessThan(10000);
		});

		it("includes token usage summary", () => {
			const ctx = createContext();
			const result = buildInvalidTargetResult(ctx, "reason");

			expect(result.tokenUsage.attempts).toEqual(ctx.tokenUsageThisTask);
			expect(result.tokenUsage.total).toBe(150);
		});
	});

	describe("buildNeedsDecompositionResult", () => {
		const createContext = (): FailureResultContext => ({
			task: "implement entire feature",
			taskId: "task-456",
			model: "sonnet",
			attempts: 2,
			startTime: Date.now() - 2000,
			tokenUsageThisTask: [],
		});

		it("builds failed result with NEEDS_DECOMPOSITION error", () => {
			const ctx = createContext();
			const result = buildNeedsDecompositionResult(ctx, "task too large");

			expect(result.status).toBe("failed");
			expect(result.error).toBe("NEEDS_DECOMPOSITION: task too large");
		});

		it("includes needsDecomposition metadata", () => {
			const ctx = createContext();
			const result = buildNeedsDecompositionResult(ctx, "task too large");

			expect(result.needsDecomposition).toBeDefined();
			expect(result.needsDecomposition?.reason).toBe("task too large");
		});

		it("parses suggested subtasks when semicolons present", () => {
			const ctx = createContext();
			const result = buildNeedsDecompositionResult(ctx, "add tests; add docs; update readme");

			expect(result.needsDecomposition?.suggestedSubtasks).toEqual(["add tests", "add docs", "update readme"]);
		});

		it("does not include suggested subtasks without semicolons", () => {
			const ctx = createContext();
			const result = buildNeedsDecompositionResult(ctx, "task is too vague");

			expect(result.needsDecomposition?.suggestedSubtasks).toBeUndefined();
		});
	});

	describe("buildValidationFailureResult", () => {
		it("builds minimal failure result for early validation", () => {
			const startTime = Date.now() - 100;
			const result = buildValidationFailureResult("invalid task", "sonnet", "file not found", startTime);

			expect(result.status).toBe("failed");
			expect(result.task).toBe("invalid task");
			expect(result.model).toBe("sonnet");
			expect(result.attempts).toBe(0);
			expect(result.error).toBe("INVALID_TARGET: file not found");
			expect(result.tokenUsage).toEqual({ attempts: [], total: 0 });
		});

		it("calculates duration correctly", () => {
			const startTime = Date.now() - 500;
			const result = buildValidationFailureResult("task", "sonnet", "reason", startTime);

			expect(result.durationMs).toBeGreaterThanOrEqual(500);
			expect(result.durationMs).toBeLessThan(5000);
		});
	});
});
