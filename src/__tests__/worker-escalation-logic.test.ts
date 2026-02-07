/**
 * Tests for worker/escalation-logic.ts
 *
 * These are pure functions that determine when to escalate models
 * based on error patterns and task state.
 */

import { describe, expect, it, vi } from "vitest";
import {
	checkDefaultRetryLimit,
	checkFileThrashing,
	checkFinalTier,
	checkNoChanges,
	checkRepeatedErrorLoop,
	checkSeriousErrors,
	checkTrivialErrors,
} from "../worker/escalation-logic.js";

// Mock the logger to avoid noise
vi.mock("../logger.js", () => ({
	sessionLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		child: vi.fn(() => ({
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
		})),
	},
}));

// Mock isTestTask for serious error tests
vi.mock("../task-planner.js", () => ({
	isTestTask: vi.fn((task: string) => task.toLowerCase().includes("test")),
}));

describe("worker/escalation-logic", () => {
	describe("checkRepeatedErrorLoop", () => {
		it("returns null when error is new", () => {
			const result = checkRepeatedErrorLoop("new error", [{ message: "different error" }]);
			expect(result).toBeNull();
		});

		it("returns null when error has appeared fewer than 2 times", () => {
			const history = [{ message: "same error message" }];
			const result = checkRepeatedErrorLoop("same error message", history);
			expect(result).toBeNull();
		});

		it("triggers failure when same error appears 2+ times", () => {
			const history = [{ message: "same error message" }, { message: "same error message" }];
			const result = checkRepeatedErrorLoop("same error message", history);
			expect(result).not.toBeNull();
			expect(result?.shouldEscalate).toBe(false);
			expect(result?.forceFailure).toBe(true);
			expect(result?.reason).toContain("same error repeated");
		});

		it("compares only first 80 chars for matching", () => {
			const longError = "A".repeat(100);
			const slightlyDifferent = "A".repeat(80) + "B".repeat(20);
			const history = [{ message: longError }, { message: longError }];
			// First 80 chars match, so this should trigger
			const result = checkRepeatedErrorLoop(slightlyDifferent, history);
			expect(result?.forceFailure).toBe(true);
		});
	});

	describe("checkFileThrashing", () => {
		it("returns null when no files exceed threshold", () => {
			const writesPerFile = new Map([
				["file1.ts", 2],
				["file2.ts", 3],
			]);
			const result = checkFileThrashing(writesPerFile, 6);
			expect(result).toBeNull();
		});

		it("returns null for empty map", () => {
			const result = checkFileThrashing(new Map(), 6);
			expect(result).toBeNull();
		});

		it("triggers failure when file exceeds max writes", () => {
			const writesPerFile = new Map([
				["file1.ts", 2],
				["problem.ts", 6],
			]);
			const result = checkFileThrashing(writesPerFile, 6);
			expect(result).not.toBeNull();
			expect(result?.forceFailure).toBe(true);
			expect(result?.reason).toContain("problem.ts");
			expect(result?.reason).toContain("6 times");
		});

		it("triggers on first file that exceeds threshold", () => {
			const writesPerFile = new Map([
				["first.ts", 10],
				["second.ts", 10],
			]);
			const result = checkFileThrashing(writesPerFile, 5);
			expect(result?.reason).toContain("first.ts");
		});
	});

	describe("checkNoChanges", () => {
		it("returns null when files were changed", () => {
			const result = checkNoChanges(5, 0, 0, "sonnet");
			expect(result).toBeNull();
		});

		it("returns completion hint when no-op edits detected", () => {
			const result = checkNoChanges(0, 1, 0, "sonnet");
			expect(result).not.toBeNull();
			expect(result?.shouldEscalate).toBe(false);
			expect(result?.forceFailure).toBeFalsy();
			expect(result?.reason).toContain("already be complete");
		});

		it("allows retry on first no-change attempt", () => {
			const result = checkNoChanges(0, 0, 0, "sonnet");
			expect(result).not.toBeNull();
			expect(result?.shouldEscalate).toBe(false);
			expect(result?.forceFailure).toBeFalsy();
			expect(result?.reason).toContain("retry 1/2");
		});

		it("allows retry on second no-change attempt", () => {
			const result = checkNoChanges(0, 0, 1, "sonnet");
			expect(result?.reason).toContain("retry 2/2");
			expect(result?.forceFailure).toBeFalsy();
		});

		it("triggers failure after max no-change retries", () => {
			const result = checkNoChanges(0, 0, 2, "sonnet");
			expect(result?.forceFailure).toBe(true);
			expect(result?.reason).toContain("consecutive no-change attempts");
		});
	});

	describe("checkFinalTier", () => {
		it("returns null when not at final tier", () => {
			const result = checkFinalTier("sonnet", "opus", 0, 7);
			expect(result).toBeNull();
		});

		it("returns null when at sonnet with opus max", () => {
			const result = checkFinalTier("sonnet", "opus", 0, 7);
			expect(result).toBeNull();
		});

		it("allows retries at opus tier within limit", () => {
			const result = checkFinalTier("opus", "opus", 3, 7);
			expect(result).not.toBeNull();
			expect(result?.shouldEscalate).toBe(false);
			expect(result?.reason).toContain("4 retries left");
		});

		it("escalates when retries exhausted at opus", () => {
			const result = checkFinalTier("opus", "opus", 7, 7);
			expect(result?.shouldEscalate).toBe(true);
			expect(result?.reason).toContain("max retries at final tier");
		});

		it("treats maxTier as final tier when not opus", () => {
			// If maxTier is sonnet, and we're at sonnet, that's final
			const result = checkFinalTier("sonnet", "sonnet", 0, 7);
			expect(result).not.toBeNull();
			expect(result?.reason).toContain("max-tier cap");
		});

		it("uses maxOpusRetries at final tier", () => {
			const result = checkFinalTier("opus", "opus", 4, 5);
			expect(result?.reason).toContain("1 retries left");
		});
	});

	describe("checkTrivialErrors", () => {
		it("returns null when errors are not trivial-only", () => {
			const result = checkTrivialErrors(["typecheck", "lint"], 0, 3);
			expect(result).toBeNull();
		});

		it("allows retry for lint-only errors within limit", () => {
			const result = checkTrivialErrors(["lint"], 1, 3);
			expect(result?.shouldEscalate).toBe(false);
			expect(result?.reason).toContain("trivial error");
			expect(result?.reason).toContain("2 retries left");
		});

		it("allows retry for spell-only errors", () => {
			const result = checkTrivialErrors(["spell"], 0, 3);
			expect(result?.shouldEscalate).toBe(false);
		});

		it("allows retry for lint+spell combo", () => {
			const result = checkTrivialErrors(["lint", "spell"], 0, 3);
			expect(result?.shouldEscalate).toBe(false);
		});

		it("escalates when trivial errors persist", () => {
			const result = checkTrivialErrors(["lint"], 3, 3);
			expect(result?.shouldEscalate).toBe(true);
			expect(result?.reason).toContain("trivial errors persist");
		});
	});

	describe("checkSeriousErrors", () => {
		it("returns null when no serious errors", () => {
			const result = checkSeriousErrors(["lint", "spell"], "some task", 0, 3);
			expect(result).toBeNull();
		});

		it("allows retry for typecheck errors within limit", () => {
			const result = checkSeriousErrors(["typecheck"], "fix bug", 0, 3);
			expect(result?.shouldEscalate).toBe(false);
			expect(result?.reason).toContain("serious error");
		});

		it("allows retry for build errors", () => {
			const result = checkSeriousErrors(["build"], "fix build", 0, 3);
			expect(result?.shouldEscalate).toBe(false);
		});

		it("allows retry for test errors", () => {
			const result = checkSeriousErrors(["test"], "fix test", 0, 3);
			expect(result?.shouldEscalate).toBe(false);
		});

		it("escalates after serious error retry limit", () => {
			// seriousRetryLimit = max(2, maxRetriesPerTier - 1) = max(2, 2) = 2
			const result = checkSeriousErrors(["typecheck"], "fix bug", 2, 3);
			expect(result?.shouldEscalate).toBe(true);
		});

		it("gives extra retries for test-writing tasks with test failures", () => {
			// For test tasks with test errors: seriousRetryLimit = maxRetriesPerTier + 1 = 4
			const result = checkSeriousErrors(["test"], "write tests for module", 3, 3);
			expect(result?.shouldEscalate).toBe(false);
			expect(result?.reason).toContain("1 retries left");
		});

		it("does not give extra retries for test tasks with non-test errors", () => {
			// Test task but typecheck error, not test error - normal limit applies
			const result = checkSeriousErrors(["typecheck"], "write tests for module", 2, 3);
			expect(result?.shouldEscalate).toBe(true);
		});
	});

	describe("checkDefaultRetryLimit", () => {
		it("allows retry within limit", () => {
			const result = checkDefaultRetryLimit(1, 3);
			expect(result.shouldEscalate).toBe(false);
			expect(result.reason).toBe("retrying");
		});

		it("escalates when limit reached", () => {
			const result = checkDefaultRetryLimit(3, 3);
			expect(result.shouldEscalate).toBe(true);
			expect(result.reason).toContain("max retries at tier");
		});

		it("escalates when over limit", () => {
			const result = checkDefaultRetryLimit(5, 3);
			expect(result.shouldEscalate).toBe(true);
		});

		it("allows at zero retries", () => {
			const result = checkDefaultRetryLimit(0, 3);
			expect(result.shouldEscalate).toBe(false);
		});
	});
});
