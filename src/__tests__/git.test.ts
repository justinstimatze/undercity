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
import { execFileSync } from "node:child_process";
import {
	abortMerge,
	calculateCodebaseFingerprint,
	deleteBranch,
	execGit,
	GitError,
	generateBranchName,
	getConflictFiles,
	getCurrentBranch,
	getDefaultBranch,
	getHeadCommitHash,
	getWorkingTreeStatus,
	hashFingerprint,
	hashGoal,
	isCacheableState,
	isMergeInProgress,
	isWorkingTreeClean,
	merge,
	mergeWithFallback,
	pushToOrigin,
	rebase,
	resolveRepositoryPath,
} from "../git.js";
import { DEFAULT_RETRY_CONFIG, MergeQueue } from "../merge-queue.js";

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

// =============================================================================
// mergeWithFallback Tests
// =============================================================================

describe("mergeWithFallback", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns success with default strategy when clean merge succeeds", () => {
		// Import mergeWithFallback

		// Mock clean merge success
		vi.mocked(execFileSync).mockReturnValue("");

		const result = mergeWithFallback("feature/test", "Merge feature");

		expect(result.success).toBe(true);
		expect(result.strategyUsed).toBe("default");
		expect(result.conflictFiles).toBeUndefined();
	});

	it("falls back to ours strategy when clean merge fails", () => {
		vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
			if (Array.isArray(args)) {
				// First merge call (clean) fails
				if (args.includes("merge") && !args.includes("-X")) {
					throw new Error("Merge conflict");
				}
				// Abort always succeeds
				if (args.includes("--abort")) {
					return "";
				}
				// Second merge call (with -X ours) succeeds
				if (args.includes("-X") && args.includes("ours")) {
					return "";
				}
			}
			return "";
		});

		const result = mergeWithFallback("feature/test", "Merge feature");

		expect(result.success).toBe(true);
		expect(result.strategyUsed).toBe("ours");
	});

	it("returns conflict files when all strategies fail", () => {
		vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
			if (Array.isArray(args)) {
				// All merge attempts fail
				if (args.includes("merge")) {
					throw new Error("Merge conflict");
				}
				// Abort succeeds
				if (args.includes("--abort")) {
					return "";
				}
				// MERGE_HEAD check fails (no merge in progress after abort)
				if (args.includes("MERGE_HEAD")) {
					throw new Error("Not found");
				}
				// Conflict file list
				if (args.includes("--diff-filter=U")) {
					return "file1.ts\nfile2.ts";
				}
			}
			return "";
		});

		const result = mergeWithFallback("feature/test", "Merge feature");

		expect(result.success).toBe(false);
		expect(result.conflictFiles).toBeDefined();
		expect(result.error).toContain("unresolvable conflicts");
	});
});

// =============================================================================
// rebase Tests
// =============================================================================

describe("rebase", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when rebase succeeds", () => {
		vi.mocked(execFileSync).mockReturnValue("");

		const result = rebase("main");

		expect(result).toBe(true);
		expect(execFileSync).toHaveBeenCalledWith("git", ["rebase", "main"], expect.anything());
	});

	it("returns false and aborts when rebase fails", () => {
		let abortCalled = false;
		vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
			if (Array.isArray(args)) {
				if (args[0] === "rebase" && args[1] === "main") {
					throw new Error("Rebase conflict");
				}
				if (args.includes("--abort")) {
					abortCalled = true;
					return "";
				}
			}
			return "";
		});

		const result = rebase("main");

		expect(result).toBe(false);
		expect(abortCalled).toBe(true);
	});

	it("handles abort failure gracefully", () => {
		vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
			if (Array.isArray(args)) {
				if (args[0] === "rebase" && args[1] === "main") {
					throw new Error("Rebase conflict");
				}
				if (args.includes("--abort")) {
					throw new Error("Abort failed");
				}
			}
			return "";
		});

		// Should not throw, just return false
		const result = rebase("main");

		expect(result).toBe(false);
	});
});

// =============================================================================
// execGit Error Handling
// =============================================================================

describe("execGit error handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws GitError with command and exit code on failure", () => {
		const error = new Error("Command failed") as Error & {
			status: number;
			stderr: Buffer;
		};
		error.status = 128;
		error.stderr = Buffer.from("fatal: not a git repository");

		vi.mocked(execFileSync).mockImplementation(() => {
			throw error;
		});

		try {
			execGit(["status"]);
			expect.fail("Should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(GitError);
			expect((e as GitError).command).toBe("git status");
			expect((e as GitError).exitCode).toBe(128);
		}
	});

	it("includes stderr in error message", () => {
		const error = new Error("Command failed") as Error & {
			status: number;
			stderr: Buffer;
		};
		error.status = 1;
		error.stderr = Buffer.from("error: pathspec 'foo' did not match any file(s)");

		vi.mocked(execFileSync).mockImplementation(() => {
			throw error;
		});

		try {
			execGit(["checkout", "foo"]);
			expect.fail("Should have thrown");
		} catch (e) {
			expect((e as GitError).message).toContain("pathspec");
		}
	});

	it("trims output from successful commands", () => {
		vi.mocked(execFileSync).mockReturnValue("  output with whitespace  \n");

		const result = execGit(["status"]);

		expect(result).toBe("output with whitespace");
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
		// ZERO: Empty queue - no items to filter
		it("handles filtering on empty queue", () => {
			const queue = new MergeQueue();
			const allItems = queue.getQueue();

			const pendingItems = allItems.filter((i) => i.status === "pending");
			const conflictItems = allItems.filter((i) => i.status === "conflict");
			const mergedItems = allItems.filter((i) => i.status === "complete");

			expect(pendingItems).toHaveLength(0);
			expect(conflictItems).toHaveLength(0);
			expect(mergedItems).toHaveLength(0);
		});

		// ONE: Single item filtering
		it("filters single item by pending status", () => {
			const queue = new MergeQueue();
			queue.add("branch1", "t1", "a1");

			const allItems = queue.getQueue();
			const pendingItems = allItems.filter((i) => i.status === "pending");

			expect(pendingItems).toHaveLength(1);
			expect(pendingItems[0].branch).toBe("branch1");
		});

		it("filters single item by conflict status", () => {
			const queue = new MergeQueue();
			const item = queue.add("branch1", "t1", "a1");
			item.status = "conflict";

			const allItems = queue.getQueue();
			const conflictItems = allItems.filter((i) => i.status === "conflict");

			expect(conflictItems).toHaveLength(1);
			expect(conflictItems[0].branch).toBe("branch1");
		});

		it("returns empty result when single item doesn't match filter", () => {
			const queue = new MergeQueue();
			const item = queue.add("branch1", "t1", "a1");
			item.status = "pending";

			const allItems = queue.getQueue();
			const conflictItems = allItems.filter((i) => i.status === "conflict");
			const testFailedItems = allItems.filter((i) => i.status === "test_failed");

			expect(conflictItems).toHaveLength(0);
			expect(testFailedItems).toHaveLength(0);
		});

		// TWO-MAX: Multiple items with various statuses
		it("filters multiple items by different statuses", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("branch1", "t1", "a1");
			const item2 = queue.add("branch2", "t2", "a2");
			const item3 = queue.add("branch3", "t3", "a3");
			const item4 = queue.add("branch4", "t4", "a4");

			item1.status = "pending";
			item2.status = "conflict";
			item3.status = "test_failed";
			item4.status = "complete";

			const allItems = queue.getQueue();
			const pendingItems = allItems.filter((i) => i.status === "pending");
			const conflictItems = allItems.filter((i) => i.status === "conflict");
			const testFailedItems = allItems.filter((i) => i.status === "test_failed");
			const completeItems = allItems.filter((i) => i.status === "complete");

			expect(pendingItems).toHaveLength(1);
			expect(conflictItems).toHaveLength(1);
			expect(testFailedItems).toHaveLength(1);
			expect(completeItems).toHaveLength(1);
			expect(pendingItems[0].branch).toBe("branch1");
			expect(conflictItems[0].branch).toBe("branch2");
			expect(testFailedItems[0].branch).toBe("branch3");
			expect(completeItems[0].branch).toBe("branch4");
		});

		it("filters all items matching same status", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("branch1", "t1", "a1");
			const item2 = queue.add("branch2", "t2", "a2");
			const item3 = queue.add("branch3", "t3", "a3");

			item1.status = "conflict";
			item2.status = "conflict";
			item3.status = "conflict";

			const allItems = queue.getQueue();
			const conflictItems = allItems.filter((i) => i.status === "conflict");

			expect(conflictItems).toHaveLength(3);
			expect(conflictItems.map((i) => i.branch)).toEqual(["branch1", "branch2", "branch3"]);
		});

		it("filters no items when no matches exist", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("branch1", "t1", "a1");
			const item2 = queue.add("branch2", "t2", "a2");
			const item3 = queue.add("branch3", "t3", "a3");

			item1.status = "pending";
			item2.status = "pending";
			item3.status = "pending";

			const allItems = queue.getQueue();
			const conflictItems = allItems.filter((i) => i.status === "conflict");
			const testFailedItems = allItems.filter((i) => i.status === "test_failed");
			const completeItems = allItems.filter((i) => i.status === "complete");

			expect(conflictItems).toHaveLength(0);
			expect(testFailedItems).toHaveLength(0);
			expect(completeItems).toHaveLength(0);
		});

		// All valid status values
		it("filters by each valid status value", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("branch1", "t1", "a1");
			const item2 = queue.add("branch2", "t2", "a2");
			const item3 = queue.add("branch3", "t3", "a3");
			const item4 = queue.add("branch4", "t4", "a4");
			const item5 = queue.add("branch5", "t5", "a5");
			const item6 = queue.add("branch6", "t6", "a6");
			const item7 = queue.add("branch7", "t7", "a7");
			const item8 = queue.add("branch8", "t8", "a8");

			item1.status = "pending";
			item2.status = "rebasing";
			item3.status = "testing";
			item4.status = "merging";
			item5.status = "pushing";
			item6.status = "complete";
			item7.status = "conflict";
			item8.status = "test_failed";

			const allItems = queue.getQueue();

			// Each status should match exactly one item
			expect(allItems.filter((i) => i.status === "pending")).toHaveLength(1);
			expect(allItems.filter((i) => i.status === "rebasing")).toHaveLength(1);
			expect(allItems.filter((i) => i.status === "testing")).toHaveLength(1);
			expect(allItems.filter((i) => i.status === "merging")).toHaveLength(1);
			expect(allItems.filter((i) => i.status === "pushing")).toHaveLength(1);
			expect(allItems.filter((i) => i.status === "complete")).toHaveLength(1);
			expect(allItems.filter((i) => i.status === "conflict")).toHaveLength(1);
			expect(allItems.filter((i) => i.status === "test_failed")).toHaveLength(1);
		});

		// Chained filtering operations
		it("supports multiple chained filters", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("branch1", "t1", "a1");
			const item2 = queue.add("branch2", "t2", "a2");
			const item3 = queue.add("branch3", "t3", "a3");

			item1.status = "conflict";
			item1.stepId = "step-a";
			item2.status = "conflict";
			item2.stepId = "step-b";
			item3.status = "pending";
			item3.stepId = "step-a";

			const allItems = queue.getQueue();
			const conflictWithStepA = allItems.filter((i) => i.status === "conflict" && i.stepId === "step-a");

			expect(conflictWithStepA).toHaveLength(1);
			expect(conflictWithStepA[0].branch).toBe("branch1");
		});

		// Filter state preservation across calls
		it("preserves queue state across multiple filter calls", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("branch1", "t1", "a1");
			const item2 = queue.add("branch2", "t2", "a2");
			const item3 = queue.add("branch3", "t3", "a3");

			item1.status = "pending";
			item2.status = "conflict";
			item3.status = "test_failed";

			// First filter call
			let allItems = queue.getQueue();
			let pendingItems = allItems.filter((i) => i.status === "pending");
			expect(pendingItems).toHaveLength(1);

			// Second filter call - should get same results
			allItems = queue.getQueue();
			pendingItems = allItems.filter((i) => i.status === "pending");
			expect(pendingItems).toHaveLength(1);

			// Different filter - should work correctly
			allItems = queue.getQueue();
			const conflictItems = allItems.filter((i) => i.status === "conflict");
			expect(conflictItems).toHaveLength(1);

			// Back to pending filter - should still work
			allItems = queue.getQueue();
			pendingItems = allItems.filter((i) => i.status === "pending");
			expect(pendingItems).toHaveLength(1);
		});

		// Boundary condition: maximum items
		it("filters correctly with many items (boundary condition)", () => {
			const queue = new MergeQueue();
			const itemCount = 50;

			// Add 50 items, alternating statuses
			for (let i = 0; i < itemCount; i++) {
				const item = queue.add(`branch${i}`, `t${i}`, `a${i}`);
				item.status = i % 2 === 0 ? "pending" : "conflict";
			}

			const allItems = queue.getQueue();
			const pendingItems = allItems.filter((i) => i.status === "pending");
			const conflictItems = allItems.filter((i) => i.status === "conflict");

			expect(pendingItems).toHaveLength(25);
			expect(conflictItems).toHaveLength(25);
			expect(pendingItems.length + conflictItems.length).toBe(itemCount);
		});

		// Original simple test case
		it("can filter items by status (original test)", () => {
			const queue = new MergeQueue();
			const item1 = queue.add("branch1", "t1", "a1");
			const item2 = queue.add("branch2", "t2", "a2");
			const item3 = queue.add("branch3", "t3", "a3");

			item1.status = "pending";
			item2.status = "conflict";
			item3.status = "complete";

			const allItems = queue.getQueue();
			const pendingItems = allItems.filter((i) => i.status === "pending");
			const conflictItems = allItems.filter((i) => i.status === "conflict");

			expect(pendingItems).toHaveLength(1);
			expect(conflictItems).toHaveLength(1);
		});
	});
});

// =============================================================================
// Additional Git Functions Tests
// =============================================================================

describe("isMergeInProgress", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when MERGE_HEAD exists", () => {
		vi.mocked(execFileSync).mockReturnValue("abc123\n");
		expect(isMergeInProgress()).toBe(true);
	});

	it("returns false when MERGE_HEAD does not exist", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("Not found");
		});
		expect(isMergeInProgress()).toBe(false);
	});
});

describe("abortMerge", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls git merge --abort", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		abortMerge();
		expect(execFileSync).toHaveBeenCalledWith("git", ["merge", "--abort"], expect.anything());
	});

	it("silently handles abort errors", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("No merge to abort");
		});
		// Should not throw
		expect(() => abortMerge()).not.toThrow();
	});
});

describe("merge", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true on successful merge", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		const result = merge("feature-branch");
		expect(result).toBe(true);
		expect(execFileSync).toHaveBeenCalledWith("git", ["merge", "--no-ff", "feature-branch"], expect.anything());
	});

	it("includes commit message when provided", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		merge("feature-branch", "Merge feature into main");
		expect(execFileSync).toHaveBeenCalledWith(
			"git",
			["merge", "--no-ff", "feature-branch", "-m", "Merge feature into main"],
			expect.anything(),
		);
	});

	it("uses theirs strategy when specified", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		merge("feature-branch", undefined, "theirs");
		expect(execFileSync).toHaveBeenCalledWith(
			"git",
			["merge", "--no-ff", "-X", "theirs", "feature-branch"],
			expect.anything(),
		);
	});

	it("uses ours strategy when specified", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		merge("feature-branch", undefined, "ours");
		expect(execFileSync).toHaveBeenCalledWith(
			"git",
			["merge", "--no-ff", "-X", "ours", "feature-branch"],
			expect.anything(),
		);
	});

	it("does not add -X flag for default strategy", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		merge("feature-branch", undefined, "default");
		const call = vi.mocked(execFileSync).mock.calls[0];
		expect(call[1]).not.toContain("-X");
	});

	it("returns false and aborts on conflict", () => {
		let abortCalled = false;
		vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
			if (Array.isArray(args) && args.includes("--abort")) {
				abortCalled = true;
				return "";
			}
			throw new Error("Merge conflict");
		});

		const result = merge("feature-branch");
		expect(result).toBe(false);
		expect(abortCalled).toBe(true);
	});
});

describe("deleteBranch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("deletes branch with -d flag by default", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		deleteBranch("feature-branch");
		expect(execFileSync).toHaveBeenCalledWith("git", ["branch", "-d", "feature-branch"], expect.anything());
	});

	it("force deletes branch with -D flag when force is true", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		deleteBranch("feature-branch", true);
		expect(execFileSync).toHaveBeenCalledWith("git", ["branch", "-D", "feature-branch"], expect.anything());
	});
});

describe("pushToOrigin", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("pushes current branch when no branch specified", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		pushToOrigin();
		expect(execFileSync).toHaveBeenCalledWith("git", ["push", "origin"], expect.anything());
	});

	it("pushes specific branch when provided", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		pushToOrigin("feature-branch");
		expect(execFileSync).toHaveBeenCalledWith("git", ["push", "origin", "feature-branch"], expect.anything());
	});
});

describe("getHeadCommitHash", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns commit hash", () => {
		vi.mocked(execFileSync).mockReturnValue("abc123def456789\n");
		expect(getHeadCommitHash()).toBe("abc123def456789");
	});

	it("returns empty string on error", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("Not a git repo");
		});
		expect(getHeadCommitHash()).toBe("");
	});
});

describe("getWorkingTreeStatus", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns status output (trimmed)", () => {
		// Note: execGit trims output, so leading spaces on first line are removed
		vi.mocked(execFileSync).mockReturnValue(" M src/file.ts\n?? newfile.ts\n");
		// After trim: "M src/file.ts\n?? newfile.ts"
		expect(getWorkingTreeStatus()).toBe("M src/file.ts\n?? newfile.ts");
	});

	it("returns empty string for clean tree", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		expect(getWorkingTreeStatus()).toBe("");
	});

	it("returns empty string on error", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("Not a git repo");
		});
		expect(getWorkingTreeStatus()).toBe("");
	});
});

describe("isWorkingTreeClean", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when status is empty", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		expect(isWorkingTreeClean()).toBe(true);
	});

	it("returns false when there are changes", () => {
		vi.mocked(execFileSync).mockReturnValue(" M file.ts\n");
		expect(isWorkingTreeClean()).toBe(false);
	});

	it("throws GitError on git command failure", () => {
		// isWorkingTreeClean doesn't have error handling - it propagates GitError
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("Not a git repo");
		});
		expect(() => isWorkingTreeClean()).toThrow(GitError);
	});
});

describe("getConflictFiles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns list of conflict files", () => {
		vi.mocked(execFileSync).mockReturnValue("file1.ts\nfile2.ts\nfile3.ts\n");
		const conflicts = getConflictFiles();
		expect(conflicts).toEqual(["file1.ts", "file2.ts", "file3.ts"]);
	});

	it("returns empty array when no conflicts", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		expect(getConflictFiles()).toEqual([]);
	});

	it("returns empty array on error", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("No merge in progress");
		});
		expect(getConflictFiles()).toEqual([]);
	});
});

describe("calculateCodebaseFingerprint", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns fingerprint with all components", () => {
		vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
			if (Array.isArray(args)) {
				// Check most specific first: getCurrentBranch uses ["rev-parse", "--abbrev-ref", "HEAD"]
				if (args.includes("--abbrev-ref")) {
					return "main\n";
				}
				// getHeadCommitHash uses ["rev-parse", "HEAD"]
				if (args.includes("HEAD") && args.includes("rev-parse")) {
					return "abc123def456\n";
				}
				// getWorkingTreeStatus uses ["status", "--porcelain"]
				if (args.includes("--porcelain")) {
					// Note: execGit trims, so leading space removed
					return " M file.ts\n";
				}
			}
			return "";
		});

		const fingerprint = calculateCodebaseFingerprint();

		expect(fingerprint).not.toBeNull();
		expect(fingerprint?.commitHash).toBe("abc123def456");
		// After trim: "M file.ts"
		expect(fingerprint?.workingTreeStatus).toBe("M file.ts");
		expect(fingerprint?.branch).toBe("main");
		expect(fingerprint?.timestamp).toBeInstanceOf(Date);
	});

	it("returns null when not in git repo", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("Not a git repo");
		});

		const fingerprint = calculateCodebaseFingerprint();
		expect(fingerprint).toBeNull();
	});

	it("returns null when commit hash is empty", () => {
		vi.mocked(execFileSync).mockReturnValue("");

		const fingerprint = calculateCodebaseFingerprint();
		expect(fingerprint).toBeNull();
	});
});

describe("isCacheableState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when working tree is clean and has commit hash", () => {
		vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
			if (Array.isArray(args)) {
				if (args.includes("HEAD") && args.includes("rev-parse")) {
					return "abc123\n";
				}
				if (args.includes("--porcelain")) {
					return ""; // Clean
				}
			}
			return "";
		});

		expect(isCacheableState()).toBe(true);
	});

	it("returns false when working tree is dirty", () => {
		vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
			if (Array.isArray(args)) {
				if (args.includes("HEAD") && args.includes("rev-parse")) {
					return "abc123\n";
				}
				if (args.includes("--porcelain")) {
					return " M file.ts\n"; // Dirty
				}
			}
			return "";
		});

		expect(isCacheableState()).toBe(false);
	});

	it("returns false when not in git repo", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("Not a git repo");
		});

		expect(isCacheableState()).toBe(false);
	});

	it("returns false when commit hash is empty", () => {
		vi.mocked(execFileSync).mockReturnValue("");
		expect(isCacheableState()).toBe(false);
	});
});
