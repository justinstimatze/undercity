/**
 * Git Module Tests
 *
 * Tests for git operations and elevator retry functionality.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process module
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	spawn: vi.fn(),
}));

// Import after mocking
import { execSync } from "node:child_process";
import { DEFAULT_RETRY_CONFIG, Elevator, GitError, getCurrentBranch } from "../git.js";

describe("Git Module", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("getCurrentBranch", () => {
		it("returns the current branch name", () => {
			vi.mocked(execSync).mockReturnValue("main\n");
			expect(getCurrentBranch()).toBe("main");
		});

		it("returns feature branch names correctly", () => {
			vi.mocked(execSync).mockReturnValue("feature/add-git-tests\n");
			expect(getCurrentBranch()).toBe("feature/add-git-tests");
		});

		it("calls git with correct arguments", () => {
			vi.mocked(execSync).mockReturnValue("main\n");
			getCurrentBranch();
			expect(execSync).toHaveBeenCalledWith(
				"git rev-parse --abbrev-ref HEAD",
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
			vi.mocked(execSync).mockImplementation(() => {
				throw error;
			});
			expect(() => getCurrentBranch()).toThrow(GitError);
		});
	});
});

describe("Elevator Retry Functionality", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Mock getDefaultBranch to return 'main'
		vi.mocked(execSync).mockReturnValue("main\n");
	});

	describe("DEFAULT_RETRY_CONFIG", () => {
		it("has sensible default values", () => {
			expect(DEFAULT_RETRY_CONFIG.enabled).toBe(true);
			expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
			expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(1000);
			expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(30000);
		});
	});

	describe("Elevator constructor", () => {
		it("uses default retry config when none provided", () => {
			const queue = new Elevator();
			const config = queue.getRetryConfig();
			expect(config.enabled).toBe(true);
			expect(config.maxRetries).toBe(3);
		});

		it("accepts custom retry config", () => {
			const queue = new Elevator(undefined, undefined, {
				enabled: false,
				maxRetries: 5,
			});
			const config = queue.getRetryConfig();
			expect(config.enabled).toBe(false);
			expect(config.maxRetries).toBe(5);
		});

		it("merges partial config with defaults", () => {
			const queue = new Elevator(undefined, undefined, {
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
			const queue = new Elevator();
			const item = queue.add("feature/test", "step-1", "agent-1");

			expect(item.retryCount).toBe(0);
			expect(item.maxRetries).toBe(3);
			expect(item.isRetry).toBe(false);
		});

		it("uses custom maxRetries from config", () => {
			const queue = new Elevator(undefined, undefined, { maxRetries: 5 });
			const item = queue.add("feature/test", "step-1", "agent-1");

			expect(item.maxRetries).toBe(5);
		});
	});

	describe("getRetryConfig() and setRetryConfig()", () => {
		it("returns a copy of the config", () => {
			const queue = new Elevator();
			const config1 = queue.getRetryConfig();
			const config2 = queue.getRetryConfig();

			expect(config1).toEqual(config2);
			expect(config1).not.toBe(config2);
		});

		it("updates configuration", () => {
			const queue = new Elevator();
			queue.setRetryConfig({ enabled: false, maxRetries: 10 });
			const config = queue.getRetryConfig();

			expect(config.enabled).toBe(false);
			expect(config.maxRetries).toBe(10);
		});

		it("preserves unmodified config values", () => {
			const queue = new Elevator();
			queue.setRetryConfig({ maxRetries: 7 });
			const config = queue.getRetryConfig();

			expect(config.enabled).toBe(true);
			expect(config.maxRetries).toBe(7);
			expect(config.baseDelayMs).toBe(1000);
		});
	});

	describe("getFailed()", () => {
		it("returns empty array when no items", () => {
			const queue = new Elevator();
			expect(queue.getFailed()).toEqual([]);
		});

		it("returns only failed items", () => {
			const queue = new Elevator();
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
			const queue = new Elevator();
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
			const queue = new Elevator();
			const item = queue.add("feature/a", "t1", "a1");

			item.status = "conflict";
			item.retryCount = 1;
			item.nextRetryAfter = new Date(Date.now() + 60000); // 1 minute in future

			const retryable = queue.getRetryable();
			expect(retryable).toHaveLength(0);
		});

		it("returns items whose nextRetryAfter has passed", () => {
			const queue = new Elevator();
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
			const queue = new Elevator();
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
			const queue = new Elevator();
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
			const queue = new Elevator();
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
			const queue = new Elevator(undefined, undefined, { enabled: false });
			const item = queue.add("feature/a", "t1", "a1");

			item.status = "conflict";
			item.retryCount = 0;

			expect(queue.getRetryable()).toHaveLength(0);
		});
	});

	describe("exponential backoff calculation", () => {
		it("calculates increasing delays for retries", () => {
			const queue = new Elevator(undefined, undefined, {
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
