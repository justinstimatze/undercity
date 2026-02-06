/**
 * Tests for orchestrator/git-utils.ts
 *
 * Tests git utility functions for orchestrator operations.
 */

import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execGitInDir, validateCwd, validateGitRef } from "../orchestrator/git-utils.js";

// Mock node:fs
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
}));

// Mock node:child_process
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

describe("orchestrator/git-utils", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("validateCwd", () => {
		it("accepts valid absolute path that exists", () => {
			vi.mocked(existsSync).mockReturnValue(true);

			expect(() => validateCwd("/home/user/project")).not.toThrow();
			expect(existsSync).toHaveBeenCalledWith("/home/user/project");
		});

		it("rejects relative paths", () => {
			expect(() => validateCwd("./relative/path")).toThrow("must be absolute path");
		});

		it("rejects non-existent paths", () => {
			vi.mocked(existsSync).mockReturnValue(false);

			expect(() => validateCwd("/nonexistent/path")).toThrow("path does not exist");
		});

		it("normalizes paths before validation", () => {
			vi.mocked(existsSync).mockReturnValue(true);

			// Path with redundant slashes/dots should be normalized
			expect(() => validateCwd("/home/user/../user/project")).not.toThrow();
		});
	});

	describe("validateGitRef", () => {
		it("accepts valid branch names", () => {
			expect(() => validateGitRef("main")).not.toThrow();
			expect(() => validateGitRef("feature/add-login")).not.toThrow();
			expect(() => validateGitRef("release-1.0.0")).not.toThrow();
			expect(() => validateGitRef("fix_bug_123")).not.toThrow();
		});

		it("accepts valid tag names", () => {
			expect(() => validateGitRef("v1.0.0")).not.toThrow();
			expect(() => validateGitRef("release/v2.0")).not.toThrow();
		});

		it("rejects refs with spaces", () => {
			expect(() => validateGitRef("branch with space")).toThrow("Invalid git ref");
		});

		it("rejects refs with special characters", () => {
			expect(() => validateGitRef("branch~1")).toThrow("Invalid git ref");
			expect(() => validateGitRef("branch^2")).toThrow("Invalid git ref");
			expect(() => validateGitRef("branch:ref")).toThrow("Invalid git ref");
			expect(() => validateGitRef("branch?")).toThrow("Invalid git ref");
			expect(() => validateGitRef("branch*")).toThrow("Invalid git ref");
			expect(() => validateGitRef("branch[0]")).toThrow("Invalid git ref");
		});

		it("rejects refs with shell metacharacters", () => {
			expect(() => validateGitRef("branch;rm -rf")).toThrow("Invalid git ref");
			expect(() => validateGitRef("branch|cat")).toThrow("Invalid git ref");
			expect(() => validateGitRef("branch&")).toThrow("Invalid git ref");
			expect(() => validateGitRef("branch$var")).toThrow("Invalid git ref");
		});

		it("rejects empty refs", () => {
			expect(() => validateGitRef("")).toThrow("Invalid git ref");
		});
	});

	describe("execGitInDir", () => {
		it("validates cwd before executing", async () => {
			vi.mocked(existsSync).mockReturnValue(false);

			expect(() => execGitInDir(["status"], "/nonexistent")).toThrow("path does not exist");
		});

		it("calls execFileSync with git and args", async () => {
			const { execFileSync } = await import("node:child_process");
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue("output\n");

			const result = execGitInDir(["status", "--porcelain"], "/valid/path");

			expect(execFileSync).toHaveBeenCalledWith(
				"git",
				["status", "--porcelain"],
				expect.objectContaining({ cwd: "/valid/path", encoding: "utf-8" }),
			);
			expect(result).toBe("output");
		});

		it("trims output", async () => {
			const { execFileSync } = await import("node:child_process");
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(execFileSync).mockReturnValue("  output with whitespace  \n");

			const result = execGitInDir(["log"], "/valid/path");

			expect(result).toBe("output with whitespace");
		});
	});
});
