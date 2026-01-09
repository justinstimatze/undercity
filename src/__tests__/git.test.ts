/**
 * Git Module Tests
 *
 * Tests for git operations, specifically getCurrentBranch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process module
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
	spawn: vi.fn(),
}));

// Import after mocking
import { execSync } from "node:child_process";
import { getCurrentBranch, GitError } from "../git.js";

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
