/**
 * Tests for orchestrator/merge-helpers.ts
 *
 * Tests merge helper functions for orchestrator operations.
 */

import { existsSync, statSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cleanWorktreeDirectory,
	fetchMainIntoWorktree,
	mergeIntoLocalMain,
	runPostRebaseVerification,
	validateWorktreePath,
} from "../orchestrator/merge-helpers.js";

// Mock node:fs
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	statSync: vi.fn(),
}));

// Mock node:child_process
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	execSync: vi.fn(),
}));

// Mock output
vi.mock("../output.js", () => ({
	debug: vi.fn(),
	warning: vi.fn(),
	progress: vi.fn(),
	info: vi.fn(),
}));

// Mock git-utils (we're testing merge-helpers, not git-utils)
vi.mock("../orchestrator/git-utils.js", () => ({
	execGitInDir: vi.fn(),
	validateCwd: vi.fn(),
	validateGitRef: vi.fn(),
}));

describe("orchestrator/merge-helpers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("validateWorktreePath", () => {
		it("throws on empty worktree path", () => {
			expect(() => validateWorktreePath("task-123", "")).toThrow("Worktree path is empty");
		});

		it("throws when path does not exist", () => {
			vi.mocked(existsSync).mockReturnValue(false);

			expect(() => validateWorktreePath("task-123", "/nonexistent/path")).toThrow("Worktree path does not exist");
		});

		it("throws when path is not a directory", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as ReturnType<typeof statSync>);

			expect(() => validateWorktreePath("task-123", "/path/to/file")).toThrow("Worktree path is not a directory");
		});

		it("passes when path exists and is a directory", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);

			expect(() => validateWorktreePath("task-123", "/valid/worktree")).not.toThrow();
		});

		it("handles stat errors gracefully", () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(statSync).mockImplementation(() => {
				throw new Error("Permission denied");
			});

			expect(() => validateWorktreePath("task-123", "/protected/path")).toThrow("Cannot stat worktree path");
		});
	});

	describe("cleanWorktreeDirectory", () => {
		it("does nothing when worktree is clean", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue(""); // Empty status = clean

			cleanWorktreeDirectory("task-123", "/worktree/path");

			expect(execGitInDir).toHaveBeenCalledWith(["status", "--porcelain"], "/worktree/path");
			expect(execGitInDir).toHaveBeenCalledTimes(1); // Only status check
		});

		it("runs checkout and clean when worktree has changes", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir)
				.mockReturnValueOnce(" M src/file.ts\n?? build/") // Dirty status
				.mockReturnValueOnce("") // checkout result
				.mockReturnValueOnce(""); // clean result

			cleanWorktreeDirectory("task-123", "/worktree/path");

			expect(execGitInDir).toHaveBeenCalledWith(["status", "--porcelain"], "/worktree/path");
			expect(execGitInDir).toHaveBeenCalledWith(["checkout", "--", "."], "/worktree/path");
			expect(execGitInDir).toHaveBeenCalledWith(["clean", "-fd"], "/worktree/path");
		});

		it("throws descriptive error when worktree is corrupted", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockImplementation(() => {
				throw new Error("not a work tree");
			});

			expect(() => cleanWorktreeDirectory("task-123", "/corrupted/path")).toThrow("was deleted or corrupted");
		});

		it("logs warning on non-fatal clean errors", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const outputMock = await import("../output.js");
			vi.mocked(execGitInDir).mockImplementation(() => {
				throw new Error("some other error");
			});

			// Should not throw, just warn
			cleanWorktreeDirectory("task-123", "/worktree/path");

			expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("Failed to clean worktree"));
		});
	});

	describe("fetchMainIntoWorktree", () => {
		it("validates mainRepo and mainBranch before fetching", async () => {
			const { execGitInDir, validateCwd, validateGitRef } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockReturnValue(""); // Reset mock to return success

			fetchMainIntoWorktree("task-123", "/worktree", "/main/repo", "main");

			expect(validateCwd).toHaveBeenCalledWith("/main/repo");
			expect(validateGitRef).toHaveBeenCalledWith("main");
			expect(execGitInDir).toHaveBeenCalledWith(["fetch", "/main/repo", "main"], "/worktree");
		});

		it("throws descriptive error on fetch failure", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir).mockImplementation(() => {
				throw new Error("network error");
			});

			expect(() => fetchMainIntoWorktree("task-123", "/worktree", "/main/repo", "main")).toThrow(
				"Git fetch from main repo failed",
			);
		});
	});

	describe("runPostRebaseVerification", () => {
		it("runs typecheck and test", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue("");

			const attemptFix = vi.fn();
			await runPostRebaseVerification("task-123", "/worktree", attemptFix);

			expect(execSync).toHaveBeenCalledWith("pnpm typecheck", expect.objectContaining({ cwd: "/worktree" }));
			expect(execSync).toHaveBeenCalledWith("pnpm test --run", expect.objectContaining({ cwd: "/worktree" }));
			expect(attemptFix).not.toHaveBeenCalled();
		});

		it("attempts fix on verification failure", async () => {
			const { execSync } = await import("node:child_process");
			const outputMock = await import("../output.js");
			let callCount = 0;
			vi.mocked(execSync).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) {
					// First typecheck + test fail
					throw new Error("Type error");
				}
				return ""; // Subsequent calls succeed
			});

			const attemptFix = vi.fn();
			await runPostRebaseVerification("task-123", "/worktree", attemptFix);

			expect(attemptFix).toHaveBeenCalled();
			expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("Verification failed"));
		});

		it("throws after max fix attempts", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockImplementation(() => {
				throw new Error("Persistent error");
			});

			const attemptFix = vi.fn();
			await expect(runPostRebaseVerification("task-123", "/worktree", attemptFix)).rejects.toThrow(
				"Verification failed for task-123 after 2 fix attempts",
			);
		});

		it("sets UNDERCITY_VERIFICATION env for tests", async () => {
			const { execSync } = await import("node:child_process");
			vi.mocked(execSync).mockReturnValue("");

			await runPostRebaseVerification("task-123", "/worktree", vi.fn());

			// Check that test command was called with UNDERCITY_VERIFICATION
			const testCall = vi.mocked(execSync).mock.calls.find((call) => call[0] === "pnpm test --run");
			expect(testCall?.[1]?.env?.UNDERCITY_VERIFICATION).toBe("true");
		});
	});

	describe("mergeIntoLocalMain", () => {
		it("detaches HEAD, checks out main, and merges", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir)
				.mockReturnValueOnce("abc1234") // rev-parse HEAD
				.mockReturnValueOnce("") // checkout --detach
				.mockReturnValueOnce("") // status --porcelain (clean)
				.mockReturnValueOnce("") // checkout main
				.mockReturnValueOnce(""); // merge --ff-only

			mergeIntoLocalMain("task-123", "/worktree", "/main/repo", "main");

			expect(execGitInDir).toHaveBeenCalledWith(["rev-parse", "HEAD"], "/worktree");
			expect(execGitInDir).toHaveBeenCalledWith(["checkout", "--detach"], "/worktree");
			expect(execGitInDir).toHaveBeenCalledWith(["checkout", "main"], "/main/repo");
			expect(execGitInDir).toHaveBeenCalledWith(["merge", "--ff-only", "abc1234"], "/main/repo");
		});

		it("stashes and restores uncommitted changes in main repo", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			const outputMock = await import("../output.js");
			vi.mocked(execGitInDir)
				.mockReturnValueOnce("abc1234") // rev-parse HEAD
				.mockReturnValueOnce("") // checkout --detach
				.mockReturnValueOnce(" M src/file.ts") // status shows changes
				.mockReturnValueOnce("") // stash push
				.mockReturnValueOnce("") // checkout main
				.mockReturnValueOnce("") // merge --ff-only
				.mockReturnValueOnce(""); // stash pop

			mergeIntoLocalMain("task-123", "/worktree", "/main/repo", "main");

			expect(execGitInDir).toHaveBeenCalledWith(
				["stash", "push", "-m", "Auto-stash before merging task-123"],
				"/main/repo",
			);
			expect(execGitInDir).toHaveBeenCalledWith(["stash", "pop"], "/main/repo");
			expect(outputMock.warning).toHaveBeenCalledWith(expect.stringContaining("uncommitted changes"));
		});

		it("ignores .undercity/ changes when checking for uncommitted changes", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			vi.mocked(execGitInDir)
				.mockReturnValueOnce("abc1234") // rev-parse HEAD
				.mockReturnValueOnce("") // checkout --detach
				.mockReturnValueOnce(" M .undercity/tasks.json\n M .undercity/metrics.json") // Only undercity changes
				.mockReturnValueOnce("") // checkout main
				.mockReturnValueOnce(""); // merge --ff-only

			mergeIntoLocalMain("task-123", "/worktree", "/main/repo", "main");

			// Should NOT have called stash since only .undercity/ files changed
			const stashCalls = vi.mocked(execGitInDir).mock.calls.filter((call) => call[0][0] === "stash");
			expect(stashCalls).toHaveLength(0);
		});

		it("restores stash on merge failure", async () => {
			const { execGitInDir } = await import("../orchestrator/git-utils.js");
			let mergeAttempted = false;
			vi.mocked(execGitInDir).mockImplementation((args) => {
				if (args[0] === "rev-parse") return "abc1234";
				if (args[0] === "checkout" && args[1] === "--detach") return "";
				if (args[0] === "status") return " M file.ts"; // Has changes
				if (args[0] === "stash" && args[1] === "push") return "";
				if (args[0] === "checkout" && args[1] === "main") return "";
				if (args[0] === "merge") {
					mergeAttempted = true;
					throw new Error("Merge conflict");
				}
				if (args[0] === "stash" && args[1] === "pop") return "";
				return "";
			});

			expect(() => mergeIntoLocalMain("task-123", "/worktree", "/main/repo", "main")).toThrow(
				"Merge into local main failed",
			);
			expect(mergeAttempted).toBe(true);
		});
	});
});
