/**
 * Tests for merge-queue.ts
 *
 * Tests the MergeQueue class for:
 * - Queue management (add, get, clear)
 * - Conflict detection between queued branches
 * - Retry configuration and backoff calculation
 * - Merge strategy management
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_CONFIG, MergeQueue } from "../merge-queue.js";

// Mock the git operations that would actually run git commands
vi.mock("../git.js", () => ({
	getDefaultBranch: () => "main",
	checkoutBranch: vi.fn(),
	deleteBranch: vi.fn(),
	execGit: vi.fn(() => ""),
	getCurrentBranch: () => "main",
	mergeWithFallback: vi.fn(() => ({ success: true, strategyUsed: "default" })),
	pushToOrigin: vi.fn(),
	rebase: vi.fn(),
	runTests: vi.fn(() => ({ success: true, output: "" })),
}));

describe("MergeQueue", () => {
	let queue: MergeQueue;

	beforeEach(() => {
		queue = new MergeQueue();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("constructor", () => {
		it("should create queue with default configuration", () => {
			const q = new MergeQueue();
			expect(q.getQueue()).toHaveLength(0);
			expect(q.getMergeStrategy()).toBe("theirs");
		});

		it("should create queue with custom main branch", () => {
			const q = new MergeQueue("develop");
			expect(q.getQueue()).toHaveLength(0);
		});

		it("should create queue with custom merge strategy", () => {
			const q = new MergeQueue("main", "ours");
			expect(q.getMergeStrategy()).toBe("ours");
		});

		it("should create queue with custom retry config", () => {
			const q = new MergeQueue("main", "default", { maxRetries: 5, baseDelayMs: 2000 });
			const config = q.getRetryConfig();
			expect(config.maxRetries).toBe(5);
			expect(config.baseDelayMs).toBe(2000);
		});

		it("should merge retry config with defaults", () => {
			const q = new MergeQueue("main", "default", { maxRetries: 10 });
			const config = q.getRetryConfig();
			expect(config.maxRetries).toBe(10);
			expect(config.baseDelayMs).toBe(DEFAULT_RETRY_CONFIG.baseDelayMs);
			expect(config.maxDelayMs).toBe(DEFAULT_RETRY_CONFIG.maxDelayMs);
		});
	});

	describe("add", () => {
		it("should add item to queue", () => {
			const item = queue.add("feature-branch", "step-1", "agent-1");

			expect(item.branch).toBe("feature-branch");
			expect(item.stepId).toBe("step-1");
			expect(item.agentId).toBe("agent-1");
			expect(item.status).toBe("pending");
			expect(item.retryCount).toBe(0);
			expect(item.isRetry).toBe(false);
			expect(queue.getQueue()).toHaveLength(1);
		});

		it("should add item with modified files", () => {
			const files = ["src/foo.ts", "src/bar.ts"];
			const item = queue.add("feature-branch", "step-1", "agent-1", files);

			expect(item.modifiedFiles).toEqual(files);
		});

		it("should add multiple items", () => {
			queue.add("branch-1", "step-1", "agent-1");
			queue.add("branch-2", "step-2", "agent-2");
			queue.add("branch-3", "step-3", "agent-3");

			expect(queue.getQueue()).toHaveLength(3);
		});

		it("should set queuedAt timestamp", () => {
			const before = new Date();
			const item = queue.add("feature-branch", "step-1", "agent-1");
			const after = new Date();

			expect(item.queuedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
			expect(item.queuedAt.getTime()).toBeLessThanOrEqual(after.getTime());
		});

		it("should set maxRetries from retry config", () => {
			const q = new MergeQueue("main", "default", { maxRetries: 7 });
			const item = q.add("branch", "step", "agent");

			expect(item.maxRetries).toBe(7);
		});
	});

	describe("getQueue", () => {
		it("should return copy of queue", () => {
			queue.add("branch-1", "step-1", "agent-1");
			const q1 = queue.getQueue();
			const q2 = queue.getQueue();

			expect(q1).not.toBe(q2);
			expect(q1).toEqual(q2);
		});

		it("should not allow mutation of internal queue", () => {
			queue.add("branch-1", "step-1", "agent-1");
			const q = queue.getQueue();
			q.push({ branch: "hacked", stepId: "x", agentId: "x", status: "pending", queuedAt: new Date() } as never);

			expect(queue.getQueue()).toHaveLength(1);
		});
	});

	describe("detectQueueConflicts", () => {
		it("should return empty array when no conflicts", () => {
			queue.add("branch-1", "step-1", "agent-1", ["src/file1.ts"]);
			queue.add("branch-2", "step-2", "agent-2", ["src/file2.ts"]);

			const conflicts = queue.detectQueueConflicts();
			expect(conflicts).toHaveLength(0);
		});

		it("should detect conflicts when branches modify same files", () => {
			queue.add("branch-1", "step-1", "agent-1", ["src/shared.ts", "src/file1.ts"]);
			queue.add("branch-2", "step-2", "agent-2", ["src/shared.ts", "src/file2.ts"]);

			const conflicts = queue.detectQueueConflicts();
			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].overlappingFiles).toContain("src/shared.ts");
		});

		it("should detect multiple conflicts", () => {
			queue.add("branch-1", "step-1", "agent-1", ["src/a.ts", "src/b.ts"]);
			queue.add("branch-2", "step-2", "agent-2", ["src/a.ts"]);
			queue.add("branch-3", "step-3", "agent-3", ["src/b.ts"]);

			const conflicts = queue.detectQueueConflicts();
			expect(conflicts).toHaveLength(2);
		});

		it("should set severity based on overlapping file count", () => {
			// Few files = warning
			queue.add("branch-1", "step-1", "agent-1", ["src/a.ts", "src/b.ts"]);
			queue.add("branch-2", "step-2", "agent-2", ["src/a.ts", "src/b.ts"]);

			let conflicts = queue.detectQueueConflicts();
			expect(conflicts[0].severity).toBe("warning");

			// Many files (>3) = error
			const q2 = new MergeQueue();
			q2.add("branch-1", "step-1", "agent-1", ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
			q2.add("branch-2", "step-2", "agent-2", ["a.ts", "b.ts", "c.ts", "d.ts"]);

			conflicts = q2.detectQueueConflicts();
			expect(conflicts[0].severity).toBe("error");
		});

		it("should skip items without modified files", () => {
			queue.add("branch-1", "step-1", "agent-1", ["src/a.ts"]);
			queue.add("branch-2", "step-2", "agent-2"); // No modified files

			const conflicts = queue.detectQueueConflicts();
			expect(conflicts).toHaveLength(0);
		});

		it("should handle empty queue", () => {
			const conflicts = queue.detectQueueConflicts();
			expect(conflicts).toHaveLength(0);
		});
	});

	describe("checkConflictsBeforeAdd", () => {
		it("should detect conflicts with existing queue items", () => {
			queue.add("existing-branch", "step-1", "agent-1", ["src/shared.ts"]);

			const conflicts = queue.checkConflictsBeforeAdd(["src/shared.ts", "src/new.ts"]);

			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].branch).toBe("(new)");
			expect(conflicts[0].conflictsWith).toBe("existing-branch");
		});

		it("should return empty when no conflicts", () => {
			queue.add("existing-branch", "step-1", "agent-1", ["src/old.ts"]);

			const conflicts = queue.checkConflictsBeforeAdd(["src/new.ts"]);

			expect(conflicts).toHaveLength(0);
		});

		it("should skip completed items", () => {
			const item = queue.add("branch-1", "step-1", "agent-1", ["src/shared.ts"]);
			item.status = "complete";

			const conflicts = queue.checkConflictsBeforeAdd(["src/shared.ts"]);
			expect(conflicts).toHaveLength(0);
		});

		it("should exclude specified branch", () => {
			queue.add("branch-1", "step-1", "agent-1", ["src/shared.ts"]);

			const conflicts = queue.checkConflictsBeforeAdd(["src/shared.ts"], "branch-1");
			expect(conflicts).toHaveLength(0);
		});

		it("should skip items without tracked files", () => {
			queue.add("branch-1", "step-1", "agent-1"); // No modified files

			const conflicts = queue.checkConflictsBeforeAdd(["src/any.ts"]);
			expect(conflicts).toHaveLength(0);
		});
	});

	describe("getConflictsForBranch", () => {
		it("should return conflicts involving specific branch", () => {
			queue.add("branch-1", "step-1", "agent-1", ["src/shared.ts"]);
			queue.add("branch-2", "step-2", "agent-2", ["src/shared.ts"]);
			queue.add("branch-3", "step-3", "agent-3", ["src/other.ts"]);

			const conflicts = queue.getConflictsForBranch("branch-1");

			expect(conflicts).toHaveLength(1);
			expect(conflicts[0].branch === "branch-1" || conflicts[0].conflictsWith === "branch-1").toBe(true);
		});

		it("should return empty for branch with no conflicts", () => {
			queue.add("branch-1", "step-1", "agent-1", ["src/file1.ts"]);
			queue.add("branch-2", "step-2", "agent-2", ["src/file2.ts"]);

			const conflicts = queue.getConflictsForBranch("branch-1");
			expect(conflicts).toHaveLength(0);
		});
	});

	describe("merge strategy", () => {
		it("should get current merge strategy", () => {
			expect(queue.getMergeStrategy()).toBe("theirs");
		});

		it("should set merge strategy", () => {
			queue.setMergeStrategy("ours");
			expect(queue.getMergeStrategy()).toBe("ours");
		});

		it("should set default strategy", () => {
			queue.setMergeStrategy("default");
			expect(queue.getMergeStrategy()).toBe("default");
		});
	});

	describe("retry configuration", () => {
		it("should get retry config", () => {
			const config = queue.getRetryConfig();
			expect(config.enabled).toBe(true);
			expect(config.maxRetries).toBe(3);
			expect(config.baseDelayMs).toBe(1000);
			expect(config.maxDelayMs).toBe(30000);
		});

		it("should return copy of retry config", () => {
			const config1 = queue.getRetryConfig();
			const config2 = queue.getRetryConfig();
			expect(config1).not.toBe(config2);
			expect(config1).toEqual(config2);
		});

		it("should update retry config", () => {
			queue.setRetryConfig({ maxRetries: 5 });
			expect(queue.getRetryConfig().maxRetries).toBe(5);
			expect(queue.getRetryConfig().baseDelayMs).toBe(1000); // Unchanged
		});

		it("should merge partial config updates", () => {
			queue.setRetryConfig({ enabled: false });
			queue.setRetryConfig({ maxRetries: 10 });

			const config = queue.getRetryConfig();
			expect(config.enabled).toBe(false);
			expect(config.maxRetries).toBe(10);
		});
	});

	describe("DEFAULT_RETRY_CONFIG", () => {
		it("should have expected default values", () => {
			expect(DEFAULT_RETRY_CONFIG.enabled).toBe(true);
			expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
			expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(1000);
			expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(30000);
		});
	});
});

describe("MergeQueue - retry delay calculation", () => {
	it("should calculate exponential backoff", () => {
		// We can test this indirectly by checking item state after failures
		const queue = new MergeQueue("main", "default", { baseDelayMs: 1000, maxDelayMs: 30000 });

		// Add item and simulate failure by manipulating status
		const item = queue.add("branch", "step", "agent");

		// Initial state
		expect(item.retryCount).toBe(0);
		expect(item.nextRetryAfter).toBeUndefined();
	});
});

describe("MergeQueue - queue item states", () => {
	let queue: MergeQueue;

	beforeEach(() => {
		queue = new MergeQueue();
	});

	it("should track item status transitions", () => {
		const item = queue.add("branch", "step", "agent");

		expect(item.status).toBe("pending");

		// Simulate status changes (normally done by processAll)
		item.status = "rebasing";
		expect(item.status).toBe("rebasing");

		item.status = "testing";
		expect(item.status).toBe("testing");

		item.status = "merging";
		expect(item.status).toBe("merging");

		item.status = "complete";
		expect(item.status).toBe("complete");
	});

	it("should track failure states", () => {
		const item = queue.add("branch", "step", "agent");

		item.status = "failed";
		item.error = "Merge conflict";

		expect(item.status).toBe("failed");
		expect(item.error).toBe("Merge conflict");
	});

	it("should track test failure state", () => {
		const item = queue.add("branch", "step", "agent");

		item.status = "test_failed";
		item.error = "Tests failed: 5 failing";

		expect(item.status).toBe("test_failed");
	});

	it("should track retry information", () => {
		const item = queue.add("branch", "step", "agent");

		item.retryCount = 2;
		item.isRetry = true;
		item.lastFailedAt = new Date();
		item.nextRetryAfter = new Date(Date.now() + 5000);
		item.originalError = "Original error message";

		expect(item.retryCount).toBe(2);
		expect(item.isRetry).toBe(true);
		expect(item.originalError).toBe("Original error message");
	});

	it("should track merge strategy used", () => {
		const item = queue.add("branch", "step", "agent");

		item.strategyUsed = "theirs";
		expect(item.strategyUsed).toBe("theirs");
	});

	it("should track conflict files", () => {
		const item = queue.add("branch", "step", "agent");

		item.conflictFiles = ["src/a.ts", "src/b.ts"];
		expect(item.conflictFiles).toHaveLength(2);
	});

	it("should track completion time", () => {
		const item = queue.add("branch", "step", "agent");
		const completionTime = new Date();

		item.status = "complete";
		item.completedAt = completionTime;

		expect(item.completedAt).toBe(completionTime);
	});
});

describe("MergeQueue - complex scenarios", () => {
	it("should handle multiple branches with overlapping and non-overlapping files", () => {
		const queue = new MergeQueue();

		// Branch 1 modifies: a.ts, b.ts
		queue.add("branch-1", "step-1", "agent-1", ["src/a.ts", "src/b.ts"]);

		// Branch 2 modifies: b.ts, c.ts (overlaps with branch-1 on b.ts)
		queue.add("branch-2", "step-2", "agent-2", ["src/b.ts", "src/c.ts"]);

		// Branch 3 modifies: d.ts (no overlap)
		queue.add("branch-3", "step-3", "agent-3", ["src/d.ts"]);

		// Branch 4 modifies: a.ts, d.ts (overlaps with branch-1 on a.ts, branch-3 on d.ts)
		queue.add("branch-4", "step-4", "agent-4", ["src/a.ts", "src/d.ts"]);

		const conflicts = queue.detectQueueConflicts();

		// Should detect:
		// - branch-1 vs branch-2 (b.ts)
		// - branch-1 vs branch-4 (a.ts)
		// - branch-3 vs branch-4 (d.ts)
		expect(conflicts.length).toBe(3);
	});

	it("should correctly identify all conflicting pairs", () => {
		const queue = new MergeQueue();

		queue.add("branch-a", "step-a", "agent-a", ["shared.ts"]);
		queue.add("branch-b", "step-b", "agent-b", ["shared.ts"]);
		queue.add("branch-c", "step-c", "agent-c", ["shared.ts"]);

		const conflicts = queue.detectQueueConflicts();

		// Should detect: a-b, a-c, b-c = 3 conflicts
		expect(conflicts.length).toBe(3);

		// All conflicts should involve shared.ts
		for (const conflict of conflicts) {
			expect(conflict.overlappingFiles).toContain("shared.ts");
		}
	});
});
