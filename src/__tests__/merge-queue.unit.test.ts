/**
 * MergeQueue Unit Tests
 *
 * Tests for retry logic, state transitions, and conflict detection.
 * These tests focus on the algorithmic behavior without requiring git operations.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process module before importing
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	execFileSync: vi.fn(() => "main\n"),
	spawn: vi.fn(),
}));

// Mock Agent SDK to prevent actual API calls
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

import { MergeQueue } from "../merge-queue.js";
import type { MergeQueueItem } from "../types.js";

describe("MergeQueue Unit Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// =========================================================================
	// Exponential Backoff Calculation
	// =========================================================================

	describe("calculateRetryDelay (exponential backoff)", () => {
		it("returns base delay for retryCount=0", () => {
			const queue = new MergeQueue(undefined, undefined, {
				baseDelayMs: 1000,
				maxDelayMs: 30000,
			});

			// Access private method via type assertion
			const calculateDelay = (
				queue as unknown as { calculateRetryDelay: (n: number) => number }
			).calculateRetryDelay.bind(queue);

			expect(calculateDelay(0)).toBe(1000); // 1000 * 2^0 = 1000
		});

		it("doubles delay for each retry", () => {
			const queue = new MergeQueue(undefined, undefined, {
				baseDelayMs: 1000,
				maxDelayMs: 60000,
			});

			const calculateDelay = (
				queue as unknown as { calculateRetryDelay: (n: number) => number }
			).calculateRetryDelay.bind(queue);

			expect(calculateDelay(0)).toBe(1000); // 1000 * 2^0 = 1000
			expect(calculateDelay(1)).toBe(2000); // 1000 * 2^1 = 2000
			expect(calculateDelay(2)).toBe(4000); // 1000 * 2^2 = 4000
			expect(calculateDelay(3)).toBe(8000); // 1000 * 2^3 = 8000
			expect(calculateDelay(4)).toBe(16000); // 1000 * 2^4 = 16000
		});

		it("caps delay at maxDelayMs", () => {
			const queue = new MergeQueue(undefined, undefined, {
				baseDelayMs: 1000,
				maxDelayMs: 30000,
			});

			const calculateDelay = (
				queue as unknown as { calculateRetryDelay: (n: number) => number }
			).calculateRetryDelay.bind(queue);

			// 1000 * 2^5 = 32000, should be capped at 30000
			expect(calculateDelay(5)).toBe(30000);
			// 1000 * 2^10 = 1024000, should also be capped
			expect(calculateDelay(10)).toBe(30000);
		});

		it("handles edge case: baseDelay larger than maxDelay", () => {
			const queue = new MergeQueue(undefined, undefined, {
				baseDelayMs: 50000,
				maxDelayMs: 30000,
			});

			const calculateDelay = (
				queue as unknown as { calculateRetryDelay: (n: number) => number }
			).calculateRetryDelay.bind(queue);

			// Should be capped even at retryCount=0
			expect(calculateDelay(0)).toBe(30000);
		});
	});

	// =========================================================================
	// canRetry() Eligibility
	// =========================================================================

	describe("canRetry eligibility", () => {
		it("returns false when retries are disabled", () => {
			const queue = new MergeQueue(undefined, undefined, { enabled: false });
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 0;

			const canRetry = (queue as unknown as { canRetry: (item: MergeQueueItem) => boolean }).canRetry.bind(queue);

			expect(canRetry(item)).toBe(false);
		});

		it("returns false when maxRetries is exhausted", () => {
			const queue = new MergeQueue(undefined, undefined, { maxRetries: 3 });
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 3; // Equals maxRetries

			const canRetry = (queue as unknown as { canRetry: (item: MergeQueueItem) => boolean }).canRetry.bind(queue);

			expect(canRetry(item)).toBe(false);
		});

		it("returns false when nextRetryAfter is in the future", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 1;
			item.nextRetryAfter = new Date(Date.now() + 60000); // 1 minute in future

			const canRetry = (queue as unknown as { canRetry: (item: MergeQueueItem) => boolean }).canRetry.bind(queue);

			expect(canRetry(item)).toBe(false);
		});

		it("returns true when all conditions are met", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 1;
			item.nextRetryAfter = new Date(Date.now() - 1000); // 1 second ago

			const canRetry = (queue as unknown as { canRetry: (item: MergeQueueItem) => boolean }).canRetry.bind(queue);

			expect(canRetry(item)).toBe(true);
		});

		it("returns true when nextRetryAfter is undefined", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 0;
			item.nextRetryAfter = undefined;

			const canRetry = (queue as unknown as { canRetry: (item: MergeQueueItem) => boolean }).canRetry.bind(queue);

			expect(canRetry(item)).toBe(true);
		});

		it("respects item-level maxRetries over config maxRetries", () => {
			const queue = new MergeQueue(undefined, undefined, { maxRetries: 5 });
			const item = queue.add("feature/test", "step-1", "agent-1");

			// Item has its own maxRetries set to 2
			item.maxRetries = 2;
			item.status = "conflict";
			item.retryCount = 2;

			const canRetry = (queue as unknown as { canRetry: (item: MergeQueueItem) => boolean }).canRetry.bind(queue);

			expect(canRetry(item)).toBe(false);
		});
	});

	// =========================================================================
	// prepareForRetry() State Transitions
	// =========================================================================

	describe("prepareForRetry state transitions", () => {
		it("increments retryCount", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 0;
			item.error = "Merge conflict";

			const prepareForRetry = (
				queue as unknown as { prepareForRetry: (item: MergeQueueItem) => void }
			).prepareForRetry.bind(queue);

			prepareForRetry(item);

			expect(item.retryCount).toBe(1);
		});

		it("preserves originalError on first failure only", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 0;
			item.error = "First error";
			item.originalError = undefined;

			const prepareForRetry = (
				queue as unknown as { prepareForRetry: (item: MergeQueueItem) => void }
			).prepareForRetry.bind(queue);

			prepareForRetry(item);

			expect(item.originalError).toBe("First error");
		});

		it("does not overwrite originalError on subsequent failures", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 1;
			item.error = "Second error";
			item.originalError = "First error";

			const prepareForRetry = (
				queue as unknown as { prepareForRetry: (item: MergeQueueItem) => void }
			).prepareForRetry.bind(queue);

			prepareForRetry(item);

			expect(item.originalError).toBe("First error");
		});

		it("sets nextRetryAfter based on exponential backoff", () => {
			const queue = new MergeQueue(undefined, undefined, {
				baseDelayMs: 1000,
				maxDelayMs: 30000,
			});
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 0;
			item.error = "Merge conflict";

			const beforePrepare = Date.now();

			const prepareForRetry = (
				queue as unknown as { prepareForRetry: (item: MergeQueueItem) => void }
			).prepareForRetry.bind(queue);

			prepareForRetry(item);

			// After first failure, retryCount becomes 1, delay is 1000 * 2^1 = 2000ms
			const afterPrepare = Date.now();
			const expectedMinDelay = beforePrepare + 2000;
			const expectedMaxDelay = afterPrepare + 2000;

			expect(item.nextRetryAfter).toBeDefined();
			expect(item.nextRetryAfter!.getTime()).toBeGreaterThanOrEqual(expectedMinDelay);
			expect(item.nextRetryAfter!.getTime()).toBeLessThanOrEqual(expectedMaxDelay);
		});

		it("resets status to pending", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 0;
			item.error = "Merge conflict";

			const prepareForRetry = (
				queue as unknown as { prepareForRetry: (item: MergeQueueItem) => void }
			).prepareForRetry.bind(queue);

			prepareForRetry(item);

			expect(item.status).toBe("pending");
		});

		it("sets isRetry flag to true", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.isRetry = false;
			item.retryCount = 0;
			item.error = "Merge conflict";

			const prepareForRetry = (
				queue as unknown as { prepareForRetry: (item: MergeQueueItem) => void }
			).prepareForRetry.bind(queue);

			prepareForRetry(item);

			expect(item.isRetry).toBe(true);
		});

		it("clears completedAt and error", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 0;
			item.error = "Merge conflict";
			item.completedAt = new Date();

			const prepareForRetry = (
				queue as unknown as { prepareForRetry: (item: MergeQueueItem) => void }
			).prepareForRetry.bind(queue);

			prepareForRetry(item);

			expect(item.completedAt).toBeUndefined();
			expect(item.error).toBeUndefined();
		});

		it("sets lastFailedAt timestamp", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			item.status = "conflict";
			item.retryCount = 0;
			item.error = "Merge conflict";

			const beforePrepare = Date.now();

			const prepareForRetry = (
				queue as unknown as { prepareForRetry: (item: MergeQueueItem) => void }
			).prepareForRetry.bind(queue);

			prepareForRetry(item);

			const afterPrepare = Date.now();

			expect(item.lastFailedAt).toBeDefined();
			expect(item.lastFailedAt!.getTime()).toBeGreaterThanOrEqual(beforePrepare);
			expect(item.lastFailedAt!.getTime()).toBeLessThanOrEqual(afterPrepare);
		});
	});

	// =========================================================================
	// Conflict Detection Severity
	// =========================================================================

	describe("detectQueueConflicts severity", () => {
		it("returns 'warning' severity for 1-3 overlapping files", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1", ["file1.ts", "file2.ts"]);
			queue.add("branch-b", "t2", "a2", ["file2.ts", "file3.ts"]);

			const conflicts = queue.detectQueueConflicts();

			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].severity).toBe("warning");
			expect(conflicts[0].overlappingFiles).toEqual(["file2.ts"]);
		});

		it("returns 'error' severity for >3 overlapping files", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1", ["file1.ts", "file2.ts", "file3.ts", "file4.ts"]);
			queue.add("branch-b", "t2", "a2", ["file1.ts", "file2.ts", "file3.ts", "file4.ts"]);

			const conflicts = queue.detectQueueConflicts();

			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].severity).toBe("error");
			expect(conflicts[0].overlappingFiles).toHaveLength(4);
		});

		it("returns empty array when no overlapping files", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1", ["file1.ts", "file2.ts"]);
			queue.add("branch-b", "t2", "a2", ["file3.ts", "file4.ts"]);

			const conflicts = queue.detectQueueConflicts();

			expect(conflicts).toHaveLength(0);
		});

		it("detects conflicts between multiple branches", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1", ["shared.ts", "a.ts"]);
			queue.add("branch-b", "t2", "a2", ["shared.ts", "b.ts"]);
			queue.add("branch-c", "t3", "a3", ["shared.ts", "c.ts"]);

			const conflicts = queue.detectQueueConflicts();

			// Should detect conflicts: a-b, a-c, b-c
			expect(conflicts).toHaveLength(3);
		});

		it("ignores completed items in conflict detection", () => {
			const queue = new MergeQueue();
			const itemA = queue.add("branch-a", "t1", "a1", ["file1.ts"]);
			queue.add("branch-b", "t2", "a2", ["file1.ts"]);

			// Mark first item as complete
			itemA.status = "complete";

			const conflicts = queue.detectQueueConflicts();

			expect(conflicts).toHaveLength(0);
		});

		it("ignores items without modifiedFiles", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1"); // No modifiedFiles
			queue.add("branch-b", "t2", "a2", ["file1.ts"]);

			const conflicts = queue.detectQueueConflicts();

			expect(conflicts).toHaveLength(0);
		});
	});

	// =========================================================================
	// checkConflictsBeforeAdd
	// =========================================================================

	describe("checkConflictsBeforeAdd", () => {
		it("detects potential conflicts before adding", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1", ["file1.ts", "file2.ts"]);

			const conflicts = queue.checkConflictsBeforeAdd(["file2.ts", "file3.ts"]);

			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].overlappingFiles).toEqual(["file2.ts"]);
		});

		it("excludes specific branch from conflict check", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1", ["file1.ts"]);

			const conflicts = queue.checkConflictsBeforeAdd(["file1.ts"], "branch-a");

			expect(conflicts).toHaveLength(0);
		});

		it("returns empty array when no conflicts would occur", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1", ["file1.ts"]);

			const conflicts = queue.checkConflictsBeforeAdd(["file2.ts"]);

			expect(conflicts).toHaveLength(0);
		});
	});

	// =========================================================================
	// getConflictsForBranch
	// =========================================================================

	describe("getConflictsForBranch", () => {
		it("returns conflicts involving specific branch", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1", ["shared.ts"]);
			queue.add("branch-b", "t2", "a2", ["shared.ts"]);
			queue.add("branch-c", "t3", "a3", ["other.ts"]);

			const conflictsForA = queue.getConflictsForBranch("branch-a");

			expect(conflictsForA).toHaveLength(1);
			expect(conflictsForA[0].branch === "branch-a" || conflictsForA[0].conflictsWith === "branch-a").toBe(true);
		});

		it("returns empty array for branch with no conflicts", () => {
			const queue = new MergeQueue();
			queue.add("branch-a", "t1", "a1", ["file1.ts"]);
			queue.add("branch-b", "t2", "a2", ["file2.ts"]);

			const conflicts = queue.getConflictsForBranch("branch-a");

			expect(conflicts).toHaveLength(0);
		});
	});

	// =========================================================================
	// Queue State Management
	// =========================================================================

	describe("queue state management", () => {
		it("clearFailed removes conflict and test_failed items", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("branch-a", "t1", "a1");
			const item2 = queue.add("branch-b", "t2", "a2");
			const item3 = queue.add("branch-c", "t3", "a3");

			item1.status = "conflict";
			item2.status = "test_failed";
			item3.status = "pending";

			queue.clearFailed();

			const remaining = queue.getQueue();
			expect(remaining).toHaveLength(1);
			expect(remaining[0].branch).toBe("branch-c");
		});

		it("getMergeStrategy returns current strategy", () => {
			const queue = new MergeQueue(undefined, "ours");
			expect(queue.getMergeStrategy()).toBe("ours");
		});

		it("setMergeStrategy updates strategy", () => {
			const queue = new MergeQueue(undefined, "default");
			queue.setMergeStrategy("theirs");
			expect(queue.getMergeStrategy()).toBe("theirs");
		});
	});

	// =========================================================================
	// Integration: Retry Flow
	// =========================================================================

	describe("retry flow integration", () => {
		it("tracks retry state correctly through multiple failures", () => {
			const queue = new MergeQueue(undefined, undefined, {
				baseDelayMs: 100,
				maxDelayMs: 10000,
				maxRetries: 3,
			});
			const item = queue.add("feature/test", "step-1", "agent-1");

			const prepareForRetry = (
				queue as unknown as { prepareForRetry: (item: MergeQueueItem) => void }
			).prepareForRetry.bind(queue);

			// First failure
			item.status = "conflict";
			item.error = "Error 1";
			prepareForRetry(item);

			expect(item.retryCount).toBe(1);
			expect(item.originalError).toBe("Error 1");
			expect(item.status).toBe("pending");

			// Second failure
			item.status = "conflict";
			item.error = "Error 2";
			prepareForRetry(item);

			expect(item.retryCount).toBe(2);
			expect(item.originalError).toBe("Error 1"); // Preserved
			expect(item.status).toBe("pending");

			// Third failure
			item.status = "conflict";
			item.error = "Error 3";
			prepareForRetry(item);

			expect(item.retryCount).toBe(3);
			expect(item.originalError).toBe("Error 1"); // Still preserved
			expect(item.status).toBe("pending");
			expect(item.isRetry).toBe(true);
		});

		it("getQueueSummary reflects retry state", () => {
			const queue = new MergeQueue(undefined, undefined, { maxRetries: 3 });
			const item1 = queue.add("branch-a", "t1", "a1");
			const item2 = queue.add("branch-b", "t2", "a2");
			const item3 = queue.add("branch-c", "t3", "a3");

			item1.status = "conflict";
			item1.retryCount = 0; // Can retry

			item2.status = "conflict";
			item2.retryCount = 3; // Exhausted

			item3.status = "pending";

			const summary = queue.getQueueSummary();

			expect(summary.total).toBe(3);
			expect(summary.pending).toBe(1);
			expect(summary.failed).toBe(2);
			expect(summary.retryable).toBe(1);
			expect(summary.exhausted).toBe(1);
		});
	});
});
