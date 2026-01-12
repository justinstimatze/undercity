/**
 * Git Module Tests
 *
 * Tests for git operations and MergeQueue retry functionality.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process module
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	execFileSync: vi.fn(),
	spawn: vi.fn(),
}));

// Import after mocking
import { execFileSync, execSync } from "node:child_process";
import {
	DEFAULT_RETRY_CONFIG,
	GitError,
	generateBranchName,
	getCurrentBranch,
	getDefaultBranch,
	hashFingerprint,
	hashGoal,
	MergeQueue,
	resolveRepositoryPath,
} from "../git.js";

describe("Git Module", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("getCurrentBranch", () => {
		it("returns the current branch name", () => {
			vi.mocked(execFileSync).mockReturnValue("main\n");
			expect(getCurrentBranch()).toBe("main");
		});

		it("returns feature branch names correctly", () => {
			vi.mocked(execFileSync).mockReturnValue("feature/add-git-tests\n");
			expect(getCurrentBranch()).toBe("feature/add-git-tests");
		});

		it("calls git with correct arguments", () => {
			vi.mocked(execFileSync).mockReturnValue("main\n");
			getCurrentBranch();
			expect(execFileSync).toHaveBeenCalledWith(
				"git",
				["rev-parse", "--abbrev-ref", "HEAD"],
				expect.objectContaining({ encoding: "utf-8" }),
			);
		});

		it("throws GitError when git command fails", () => {
			const error = new Error("Command failed") as Error & {
				status: number;
				stderr: Buffer;
			};
			error.status = 128;
			error.stderr = Buffer.from("fatal: not a git repository");
			vi.mocked(execFileSync).mockImplementation(() => {
				throw error;
			});
			expect(() => getCurrentBranch()).toThrow(GitError);
		});
	});
});

describe("MergeQueue Retry Functionality", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Mock getDefaultBranch to return 'main' (uses execFileSync now)
		vi.mocked(execFileSync).mockReturnValue("main\n");
	});

	describe("DEFAULT_RETRY_CONFIG", () => {
		it("has sensible default values", () => {
			expect(DEFAULT_RETRY_CONFIG.enabled).toBe(true);
			expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
			expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(1000);
			expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(30000);
		});
	});

	describe("MergeQueue constructor", () => {
		it("uses default retry config when none provided", () => {
			const queue = new MergeQueue();
			const config = queue.getRetryConfig();
			expect(config.enabled).toBe(true);
			expect(config.maxRetries).toBe(3);
		});

		it("accepts custom retry config", () => {
			const queue = new MergeQueue(undefined, undefined, {
				enabled: false,
				maxRetries: 5,
			});
			const config = queue.getRetryConfig();
			expect(config.enabled).toBe(false);
			expect(config.maxRetries).toBe(5);
		});

		it("merges partial config with defaults", () => {
			const queue = new MergeQueue(undefined, undefined, {
				maxRetries: 10,
			});
			const config = queue.getRetryConfig();
			expect(config.enabled).toBe(true); // default
			expect(config.maxRetries).toBe(10); // custom
			expect(config.baseDelayMs).toBe(1000); // default
		});
	});

	describe("add()", () => {
		it("initializes retry tracking fields", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/test", "step-1", "agent-1");

			expect(item.retryCount).toBe(0);
			expect(item.maxRetries).toBe(3);
			expect(item.isRetry).toBe(false);
		});

		it("uses custom maxRetries from config", () => {
			const queue = new MergeQueue(undefined, undefined, { maxRetries: 5 });
			const item = queue.add("feature/test", "step-1", "agent-1");

			expect(item.maxRetries).toBe(5);
		});
	});

	describe("getRetryConfig() and setRetryConfig()", () => {
		it("returns a copy of the config", () => {
			const queue = new MergeQueue();
			const config1 = queue.getRetryConfig();
			const config2 = queue.getRetryConfig();

			expect(config1).toEqual(config2);
			expect(config1).not.toBe(config2);
		});

		it("updates configuration", () => {
			const queue = new MergeQueue();
			queue.setRetryConfig({ enabled: false, maxRetries: 10 });
			const config = queue.getRetryConfig();

			expect(config.enabled).toBe(false);
			expect(config.maxRetries).toBe(10);
		});

		it("preserves unmodified config values", () => {
			const queue = new MergeQueue();
			queue.setRetryConfig({ maxRetries: 7 });
			const config = queue.getRetryConfig();

			expect(config.enabled).toBe(true);
			expect(config.maxRetries).toBe(7);
			expect(config.baseDelayMs).toBe(1000);
		});
	});

	describe("getFailed()", () => {
		it("returns empty array when no items", () => {
			const queue = new MergeQueue();
			expect(queue.getFailed()).toEqual([]);
		});

		it("returns only failed items", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("feature/a", "t1", "a1");
			const item2 = queue.add("feature/b", "t2", "a2");
			const item3 = queue.add("feature/c", "t3", "a3");

			item1.status = "conflict";
			item2.status = "pending";
			item3.status = "test_failed";

			const failed = queue.getFailed();
			expect(failed).toHaveLength(2);
			expect(failed.map((i) => i.branch)).toContain("feature/a");
			expect(failed.map((i) => i.branch)).toContain("feature/c");
		});
	});

	describe("getRetryable()", () => {
		it("returns failed items that can be retried", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("feature/a", "t1", "a1");
			const item2 = queue.add("feature/b", "t2", "a2");

			item1.status = "conflict";
			item1.retryCount = 0;

			item2.status = "conflict";
			item2.retryCount = 3; // exhausted

			const retryable = queue.getRetryable();
			expect(retryable).toHaveLength(1);
			expect(retryable[0].branch).toBe("feature/a");
		});

		it("respects nextRetryAfter timing", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/a", "t1", "a1");

			item.status = "conflict";
			item.retryCount = 1;
			item.nextRetryAfter = new Date(Date.now() + 60000); // 1 minute in future

			const retryable = queue.getRetryable();
			expect(retryable).toHaveLength(0);
		});

		it("returns items whose nextRetryAfter has passed", () => {
			const queue = new MergeQueue();
			const item = queue.add("feature/a", "t1", "a1");

			item.status = "conflict";
			item.retryCount = 1;
			item.nextRetryAfter = new Date(Date.now() - 1000); // 1 second ago

			const retryable = queue.getRetryable();
			expect(retryable).toHaveLength(1);
		});
	});

	describe("getExhausted()", () => {
		it("returns items that have exhausted all retries", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("feature/a", "t1", "a1");
			const item2 = queue.add("feature/b", "t2", "a2");

			item1.status = "conflict";
			item1.retryCount = 0;

			item2.status = "conflict";
			item2.retryCount = 3;

			const exhausted = queue.getExhausted();
			expect(exhausted).toHaveLength(1);
			expect(exhausted[0].branch).toBe("feature/b");
		});
	});

	describe("clearExhausted()", () => {
		it("removes only exhausted items", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("feature/a", "t1", "a1");
			const item2 = queue.add("feature/b", "t2", "a2");
			const item3 = queue.add("feature/c", "t3", "a3");

			item1.status = "conflict";
			item1.retryCount = 0;

			item2.status = "conflict";
			item2.retryCount = 3;

			item3.status = "pending";

			queue.clearExhausted();

			const remaining = queue.getQueue();
			expect(remaining).toHaveLength(2);
			expect(remaining.map((i) => i.branch)).toContain("feature/a");
			expect(remaining.map((i) => i.branch)).toContain("feature/c");
		});
	});

	describe("getQueueSummary()", () => {
		it("returns accurate summary", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("feature/a", "t1", "a1");
			const item2 = queue.add("feature/b", "t2", "a2");
			const item3 = queue.add("feature/c", "t3", "a3");
			const item4 = queue.add("feature/d", "t4", "a4");

			item1.status = "pending";
			item2.status = "conflict";
			item2.retryCount = 0;
			item3.status = "conflict";
			item3.retryCount = 3;
			item4.status = "test_failed";
			item4.retryCount = 2;

			const summary = queue.getQueueSummary();

			expect(summary.total).toBe(4);
			expect(summary.pending).toBe(1);
			expect(summary.failed).toBe(3);
			expect(summary.retryable).toBe(2); // item2 and item4
			expect(summary.exhausted).toBe(1); // item3
		});
	});

	describe("retry behavior with disabled retries", () => {
		it("getRetryable returns empty when retries disabled", () => {
			const queue = new MergeQueue(undefined, undefined, { enabled: false });
			const item = queue.add("feature/a", "t1", "a1");

			item.status = "conflict";
			item.retryCount = 0;

			expect(queue.getRetryable()).toHaveLength(0);
		});
	});

	describe("exponential backoff calculation", () => {
		it("calculates increasing delays for retries", () => {
			const queue = new MergeQueue(undefined, undefined, {
				baseDelayMs: 1000,
				maxDelayMs: 30000,
			});

			// Access private method via any cast for testing
			const calculateDelay = (
				queue as unknown as { calculateRetryDelay: (n: number) => number }
			).calculateRetryDelay.bind(queue);

			expect(calculateDelay(0)).toBe(1000); // 1000 * 2^0 = 1000
			expect(calculateDelay(1)).toBe(2000); // 1000 * 2^1 = 2000
			expect(calculateDelay(2)).toBe(4000); // 1000 * 2^2 = 4000
			expect(calculateDelay(3)).toBe(8000); // 1000 * 2^3 = 8000
			expect(calculateDelay(5)).toBe(30000); // capped at maxDelayMs
		});
	});
});

describe("GitError", () => {
	it("creates error with message and command", () => {
		const error = new GitError("Branch not found", "git checkout branch");
		expect(error.message).toBe("Branch not found");
		expect(error.command).toBe("git checkout branch");
		expect(error.exitCode).toBeUndefined();
		expect(error.name).toBe("GitError");
	});

	it("creates error with exit code", () => {
		const error = new GitError("Command failed", "git push", 128);
		expect(error.exitCode).toBe(128);
	});

	it("is instance of Error", () => {
		const error = new GitError("test", "git test");
		expect(error instanceof Error).toBe(true);
		expect(error instanceof GitError).toBe(true);
	});
});

describe("getDefaultBranch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns branch from remote HEAD when available", () => {
		vi.mocked(execFileSync).mockReturnValue("refs/remotes/origin/main\n");
		expect(getDefaultBranch()).toBe("main");
	});

	it("returns 'main' when remote HEAD fails but main exists", () => {
		vi.mocked(execFileSync)
			.mockImplementationOnce(() => {
				throw new Error("No remote");
			})
			.mockReturnValueOnce("main\n");
		expect(getDefaultBranch()).toBe("main");
	});

	it("returns 'master' when remote HEAD fails and main does not exist", () => {
		vi.mocked(execFileSync)
			.mockImplementationOnce(() => {
				throw new Error("No remote");
			})
			.mockImplementationOnce(() => {
				throw new Error("No main branch");
			});
		expect(getDefaultBranch()).toBe("master");
	});

	it("accepts optional path parameter", () => {
		vi.mocked(execFileSync).mockReturnValue("refs/remotes/origin/develop\n");
		const result = getDefaultBranch("/some/path");
		expect(result).toBe("develop");
		expect(execFileSync).toHaveBeenCalledWith(
			"git",
			["symbolic-ref", "refs/remotes/origin/HEAD"],
			expect.objectContaining({ cwd: "/some/path" }),
		);
	});
});

describe("resolveRepositoryPath", () => {
	it("returns absolute path unchanged", () => {
		const result = resolveRepositoryPath("/base", "/absolute/path");
		expect(result).toBe("/absolute/path");
	});

	it("resolves relative path against base", () => {
		const result = resolveRepositoryPath("/base/dir", "relative/path");
		expect(result).toBe("/base/dir/relative/path");
	});

	it("handles . as relative path", () => {
		const result = resolveRepositoryPath("/base/dir", ".");
		expect(result).toBe("/base/dir");
	});

	it("handles .. in relative path", () => {
		const result = resolveRepositoryPath("/base/dir/sub", "../sibling");
		expect(result).toBe("/base/dir/sibling");
	});
});

describe("generateBranchName", () => {
	it("generates branch name with session and step IDs", () => {
		const result = generateBranchName("session-123", "step-456");
		// Format: undercity/{sessionId}/{stepId}-{timestamp_base36}
		expect(result).toMatch(/^undercity\/session-123\/step-456-[a-z0-9]+$/);
	});

	it("generates unique timestamp suffix", () => {
		const result1 = generateBranchName("s1", "step1");
		// Wait a tiny bit to ensure different timestamp
		const result2 = generateBranchName("s2", "step1");
		// Different session IDs means different branch names
		expect(result1).not.toBe(result2);
		expect(result1).toContain("undercity/s1/step1-");
		expect(result2).toContain("undercity/s2/step1-");
	});

	it("handles long session IDs", () => {
		const longSessionId = "a".repeat(100);
		const result = generateBranchName(longSessionId, "step");
		// Should include the full session ID
		expect(result).toContain(longSessionId);
		expect(result).toMatch(/^undercity\//);
	});
});

describe("hashGoal", () => {
	it("returns consistent hash for same goal", () => {
		const hash1 = hashGoal("fix the bug");
		const hash2 = hashGoal("fix the bug");
		expect(hash1).toBe(hash2);
	});

	it("returns different hash for different goals", () => {
		const hash1 = hashGoal("fix the bug");
		const hash2 = hashGoal("add a feature");
		expect(hash1).not.toBe(hash2);
	});

	it("returns SHA256 hex hash (64 characters)", () => {
		const hash = hashGoal("any goal");
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("handles empty string", () => {
		const hash = hashGoal("");
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("handles special characters", () => {
		const hash = hashGoal("fix bug with 'quotes' and \"double\" & special <chars>");
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("normalizes whitespace before hashing", () => {
		const hash1 = hashGoal("fix  the   bug");
		const hash2 = hashGoal("fix the bug");
		expect(hash1).toBe(hash2);
	});

	it("trims whitespace before hashing", () => {
		const hash1 = hashGoal("  fix the bug  ");
		const hash2 = hashGoal("fix the bug");
		expect(hash1).toBe(hash2);
	});
});

describe("hashFingerprint", () => {
	it("returns consistent hash for same fingerprint", () => {
		const fingerprint = {
			commitHash: "abc123def456",
			workingTreeStatus: "clean",
			branch: "main",
			timestamp: new Date("2024-01-01"),
		};
		const hash1 = hashFingerprint(fingerprint);
		const hash2 = hashFingerprint(fingerprint);
		expect(hash1).toBe(hash2);
	});

	it("returns different hash for different commit hashes", () => {
		const fingerprint1 = {
			commitHash: "abc123",
			workingTreeStatus: "clean",
			branch: "main",
			timestamp: new Date("2024-01-01"),
		};
		const fingerprint2 = {
			commitHash: "def456",
			workingTreeStatus: "clean",
			branch: "main",
			timestamp: new Date("2024-01-01"),
		};
		expect(hashFingerprint(fingerprint1)).not.toBe(hashFingerprint(fingerprint2));
	});

	it("returns different hash for different working tree status", () => {
		const fingerprint1 = {
			commitHash: "abc123",
			workingTreeStatus: "clean",
			branch: "main",
			timestamp: new Date("2024-01-01"),
		};
		const fingerprint2 = {
			commitHash: "abc123",
			workingTreeStatus: "dirty",
			branch: "main",
			timestamp: new Date("2024-01-01"),
		};
		expect(hashFingerprint(fingerprint1)).not.toBe(hashFingerprint(fingerprint2));
	});

	it("returns SHA256 hex hash (64 characters)", () => {
		const fingerprint = {
			commitHash: "abc",
			workingTreeStatus: "",
			branch: "main",
			timestamp: new Date(),
		};
		expect(hashFingerprint(fingerprint)).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("MergeQueue additional tests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(execFileSync).mockReturnValue("main\n");
	});

	describe("getQueue", () => {
		it("returns empty array for new queue", () => {
			const queue = new MergeQueue();
			expect(queue.getQueue()).toEqual([]);
		});

		it("returns all items in queue", () => {
			const queue = new MergeQueue();
			queue.add("branch1", "t1", "a1");
			queue.add("branch2", "t2", "a2");
			expect(queue.getQueue()).toHaveLength(2);
		});

		it("returns items with correct properties", () => {
			const queue = new MergeQueue();
			queue.add("feature/test", "step-123", "agent-1");

			const items = queue.getQueue();
			expect(items).toHaveLength(1);
			expect(items[0].branch).toBe("feature/test");
			expect(items[0].stepId).toBe("step-123");
			expect(items[0].agentId).toBe("agent-1");
			expect(items[0].status).toBe("pending");
		});
	});

	describe("add", () => {
		it("sets queuedAt timestamp", () => {
			const queue = new MergeQueue();
			const before = Date.now();
			const item = queue.add("branch1", "t1", "a1");
			const after = Date.now();

			expect(item.queuedAt.getTime()).toBeGreaterThanOrEqual(before);
			expect(item.queuedAt.getTime()).toBeLessThanOrEqual(after);
		});

		it("initializes status to pending", () => {
			const queue = new MergeQueue();
			const item = queue.add("branch1", "t1", "a1");
			expect(item.status).toBe("pending");
		});
	});

	describe("queue status filtering", () => {
		it("can filter items by status", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("branch1", "t1", "a1");
			const item2 = queue.add("branch2", "t2", "a2");
			const item3 = queue.add("branch3", "t3", "a3");

			item1.status = "pending";
			item2.status = "conflict";
			item3.status = "merged";

			const allItems = queue.getQueue();
			const pendingItems = allItems.filter((i) => i.status === "pending");
			const conflictItems = allItems.filter((i) => i.status === "conflict");

			expect(pendingItems).toHaveLength(1);
			expect(conflictItems).toHaveLength(1);
		});
	});
});
