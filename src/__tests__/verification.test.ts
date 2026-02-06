/**
 * Tests for verification.ts
 *
 * Tests error categorization and verification result handling.
 */

import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categorizeErrors, type VerificationResult, verifyWork } from "../verification.js";

// Mock child_process
vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

// Mock cache module
vi.mock("../cache.js", () => ({
	parseTypeScriptErrors: vi.fn(() => []),
	formatErrorsForAgent: vi.fn(() => "Formatted errors"),
	getCache: vi.fn(() => ({
		findSimilarFixes: vi.fn(() => []),
	})),
}));

/**
 * Helper to create a base verification result
 */
function createResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
	return {
		passed: true,
		typecheckPassed: true,
		testsPassed: true,
		lintPassed: true,
		spellPassed: true,
		codeHealthPassed: true,
		filesChanged: 5,
		linesChanged: 100,
		issues: [],
		feedback: "All checks passed",
		hasWarnings: false,
		...overrides,
	};
}

describe("verification.ts", () => {
	describe("categorizeErrors", () => {
		it("should return ['unknown'] for passing result with no issues", () => {
			const result = createResult();
			const categories = categorizeErrors(result);
			expect(categories).toEqual(["unknown"]);
		});

		it("should categorize lint failures", () => {
			const result = createResult({ lintPassed: false });
			const categories = categorizeErrors(result);
			expect(categories).toContain("lint");
		});

		it("should categorize spell failures", () => {
			const result = createResult({ spellPassed: false });
			const categories = categorizeErrors(result);
			expect(categories).toContain("spell");
		});

		it("should categorize typecheck failures", () => {
			const result = createResult({ typecheckPassed: false });
			const categories = categorizeErrors(result);
			expect(categories).toContain("typecheck");
		});

		it("should categorize test failures", () => {
			const result = createResult({ testsPassed: false });
			const categories = categorizeErrors(result);
			expect(categories).toContain("test");
		});

		it("should categorize no changes", () => {
			const result = createResult({ filesChanged: 0 });
			const categories = categorizeErrors(result);
			expect(categories).toContain("no_changes");
		});

		it("should categorize build issues when typecheck passes but build fails", () => {
			const result = createResult({
				typecheckPassed: true,
				issues: ["Build failed due to missing module"],
			});
			const categories = categorizeErrors(result);
			expect(categories).toContain("build");
		});

		it("should not categorize build if typecheck also failed", () => {
			const result = createResult({
				typecheckPassed: false,
				issues: ["Build failed"],
			});
			const categories = categorizeErrors(result);
			expect(categories).not.toContain("build");
			expect(categories).toContain("typecheck");
		});

		it("should handle multiple failures", () => {
			const result = createResult({
				lintPassed: false,
				testsPassed: false,
				typecheckPassed: false,
			});
			const categories = categorizeErrors(result);
			expect(categories).toContain("lint");
			expect(categories).toContain("test");
			expect(categories).toContain("typecheck");
			expect(categories).toHaveLength(3);
		});

		it("should detect build keyword case-insensitively", () => {
			const result = createResult({
				typecheckPassed: true,
				issues: ["BUILD error occurred"],
			});
			const categories = categorizeErrors(result);
			expect(categories).toContain("build");
		});

		it("should return all applicable categories", () => {
			const result = createResult({
				lintPassed: false,
				spellPassed: false,
				testsPassed: false,
				typecheckPassed: false,
				filesChanged: 0,
			});
			const categories = categorizeErrors(result);
			expect(categories).toContain("lint");
			expect(categories).toContain("spell");
			expect(categories).toContain("test");
			expect(categories).toContain("typecheck");
			expect(categories).toContain("no_changes");
			expect(categories).toHaveLength(5);
		});
	});

	describe("VerificationResult structure", () => {
		it("should have all required fields", () => {
			const result = createResult();

			// Type assertions ensure structure is correct
			expect(typeof result.passed).toBe("boolean");
			expect(typeof result.typecheckPassed).toBe("boolean");
			expect(typeof result.testsPassed).toBe("boolean");
			expect(typeof result.lintPassed).toBe("boolean");
			expect(typeof result.spellPassed).toBe("boolean");
			expect(typeof result.codeHealthPassed).toBe("boolean");
			expect(typeof result.filesChanged).toBe("number");
			expect(typeof result.linesChanged).toBe("number");
			expect(Array.isArray(result.issues)).toBe(true);
			expect(typeof result.feedback).toBe("string");
		});

		it("should correctly represent a failing result", () => {
			const result = createResult({
				passed: false,
				typecheckPassed: false,
				filesChanged: 3,
				linesChanged: 50,
				issues: ["Typecheck failed (5 errors)"],
				feedback: "✗ TYPECHECK FAILED:\nsrc/file.ts:10 - error TS2345",
			});

			expect(result.passed).toBe(false);
			expect(result.typecheckPassed).toBe(false);
			expect(result.issues).toHaveLength(1);
			expect(result.issues[0]).toContain("Typecheck failed");
			expect(result.feedback).toContain("TYPECHECK FAILED");
		});

		it("should correctly represent partial failures", () => {
			const result = createResult({
				passed: false, // Lint and tests are blocking
				typecheckPassed: true,
				lintPassed: false,
				testsPassed: false,
				filesChanged: 10,
				issues: ["Lint issues (3)", "Tests failed (2)"],
				feedback: "✓ Typecheck passed\n⚠ LINT ISSUES\n✗ TESTS FAILED",
			});

			expect(result.passed).toBe(false);
			expect(result.typecheckPassed).toBe(true);
			expect(result.lintPassed).toBe(false);
			expect(result.testsPassed).toBe(false);
			expect(result.issues).toHaveLength(2);
		});
	});

	describe("edge cases", () => {
		it("should handle empty issues array", () => {
			const result = createResult({ issues: [] });
			const categories = categorizeErrors(result);
			// Should return unknown since nothing failed
			expect(categories).toEqual(["unknown"]);
		});

		it("should handle issues with build-like words that are not build failures", () => {
			const result = createResult({
				typecheckPassed: true,
				issues: ["Rebuild suggested for performance"],
			});
			const categories = categorizeErrors(result);
			// "rebuild" contains "build" so this will categorize as build
			expect(categories).toContain("build");
		});

		it("should handle zero lines changed with files changed", () => {
			const result = createResult({
				filesChanged: 1,
				linesChanged: 0,
			});
			const categories = categorizeErrors(result);
			// Files changed but no lines - could be file mode changes
			expect(categories).not.toContain("no_changes");
		});

		it("should handle zero files but lines changed", () => {
			// Edge case: shouldn't happen but handle gracefully
			const result = createResult({
				filesChanged: 0,
				linesChanged: 100,
			});
			const categories = categorizeErrors(result);
			expect(categories).toContain("no_changes");
		});
	});

	describe("feedback content", () => {
		it("should indicate passing checks with checkmark", () => {
			const result = createResult({
				feedback: "✓ Typecheck passed\n✓ Lint passed\n✓ Tests passed",
			});
			expect(result.feedback).toContain("✓");
		});

		it("should indicate failures with cross", () => {
			const result = createResult({
				feedback: "✗ TYPECHECK FAILED:\nError details here",
			});
			expect(result.feedback).toContain("✗");
		});

		it("should indicate warnings with warning symbol", () => {
			const result = createResult({
				feedback: "⚠ LINT ISSUES:\nWarning details here",
			});
			expect(result.feedback).toContain("⚠");
		});
	});

	describe("verifyWork", () => {
		const mockExecSync = vi.mocked(execSync);

		beforeEach(() => {
			vi.clearAllMocks();
		});

		afterEach(() => {
			vi.resetAllMocks();
		});

		/**
		 * Helper to set up successful execSync responses
		 */
		function mockSuccessfulRun(overrides: Record<string, string> = {}) {
			const defaults: Record<string, string> = {
				"pnpm spell": "",
				"git diff --stat": " 2 files changed, 10 insertions(+), 5 deletions(-)",
				"git status --porcelain": "",
				"git diff --name-only": "src/file.ts\nsrc/other.ts",
				"pnpm typecheck": "",
				"pnpm check": "",
				"pnpm test --run": "",
				"pnpm quality:check": "",
			};
			const responses = { ...defaults, ...overrides };

			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				for (const [key, value] of Object.entries(responses)) {
					if (cmd.includes(key)) {
						return value;
					}
				}
				return "";
			});
		}

		it("should return passing result when all checks succeed", async () => {
			mockSuccessfulRun();

			const result = await verifyWork({ runTypecheck: true, runTests: true, workingDirectory: "/test/dir" });

			expect(result.passed).toBe(true);
			expect(result.typecheckPassed).toBe(true);
			expect(result.lintPassed).toBe(true);
			expect(result.spellPassed).toBe(true);
			expect(result.filesChanged).toBe(2);
			expect(result.feedback).toContain("✓ Spell check passed");
			expect(result.feedback).toContain("✓ Typecheck passed");
			expect(result.feedback).toContain("✓ Lint passed");
		});

		it("should parse file and line counts from git diff", async () => {
			mockSuccessfulRun({
				"git diff --stat": " 5 files changed, 100 insertions(+), 25 deletions(-)",
			});

			const result = await verifyWork({ runTypecheck: true, runTests: true, workingDirectory: "/test/dir" });

			expect(result.filesChanged).toBe(5);
			expect(result.linesChanged).toBe(125); // 100 + 25
		});

		it("should include untracked files in count", async () => {
			mockSuccessfulRun({
				"git diff --stat": " 1 file changed, 10 insertions(+)",
				"git status --porcelain": "?? src/newfile.ts\n?? src/another.ts",
			});

			const result = await verifyWork({ runTypecheck: true, runTests: true, workingDirectory: "/test/dir" });

			// 1 from diff + 2 untracked
			expect(result.filesChanged).toBe(3);
		});

		it("should detect spell check failures as non-blocking", async () => {
			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					const error = new Error("Spell check failed") as Error & { stdout: string };
					error.stdout = "spelling error: teh -> the\nspelling error: wiht -> with";
					throw error;
				}
				if (cmd.includes("git diff --stat")) {
					return " 1 file changed, 5 insertions(+)";
				}
				if (cmd.includes("git status --porcelain")) {
					return "";
				}
				if (cmd.includes("git diff --name-only")) {
					return "src/file.ts";
				}
				return "";
			});

			const result = await verifyWork({ runTypecheck: true, runTests: false, workingDirectory: "/test/dir" });

			expect(result.spellPassed).toBe(false);
			expect(result.passed).toBe(true); // Spell is non-blocking
			expect(result.feedback).toContain("⚠ Spelling issues");
		});

		it("should fail when typecheck fails", async () => {
			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					return "";
				}
				if (cmd.includes("git diff --stat")) {
					return " 1 file changed, 5 insertions(+)";
				}
				if (cmd.includes("git status --porcelain")) {
					return "";
				}
				if (cmd.includes("git diff --name-only")) {
					return "src/file.ts";
				}
				if (cmd.includes("pnpm typecheck")) {
					const error = new Error("Typecheck failed") as Error & { stdout: string };
					error.stdout = "src/file.ts:10:5 - error TS2345: Type mismatch";
					throw error;
				}
				return "";
			});

			const result = await verifyWork({ runTypecheck: true, runTests: false, workingDirectory: "/test/dir" });

			expect(result.typecheckPassed).toBe(false);
			expect(result.passed).toBe(false);
			expect(result.issues).toContain("Typecheck failed (0 errors)");
			expect(result.feedback).toContain("✗ TYPECHECK FAILED");
		});

		it("should detect lint failures", async () => {
			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					return "";
				}
				if (cmd.includes("git diff --stat")) {
					return " 1 file changed, 5 insertions(+)";
				}
				if (cmd.includes("git status --porcelain")) {
					return "";
				}
				if (cmd.includes("git diff --name-only")) {
					return "src/file.ts";
				}
				if (cmd.includes("pnpm typecheck")) {
					return "";
				}
				if (cmd.includes("pnpm check")) {
					const error = new Error("Lint failed") as Error & { stdout: string };
					error.stdout = "error: Unexpected any\nerror: Missing return type\nwarning: Unused variable";
					throw error;
				}
				return "";
			});

			const result = await verifyWork({ runTypecheck: true, runTests: false, workingDirectory: "/test/dir" });

			expect(result.lintPassed).toBe(false);
			expect(result.passed).toBe(false); // Lint is blocking
			expect(result.feedback).toContain("⚠ LINT ISSUES");
		});

		it("should detect test failures", async () => {
			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					return "";
				}
				if (cmd.includes("git diff --stat")) {
					return " 1 file changed, 5 insertions(+)";
				}
				if (cmd.includes("git status --porcelain")) {
					return "";
				}
				if (cmd.includes("git diff --name-only")) {
					return "src/file.ts";
				}
				if (cmd.includes("pnpm typecheck")) {
					return "";
				}
				if (cmd.includes("pnpm check")) {
					return "";
				}
				if (cmd.includes("pnpm test --run")) {
					const error = new Error("Tests failed") as Error & { stdout: string };
					error.stdout = "FAIL src/file.test.ts\n2 failed, 10 passed\nAssertionError: expected true";
					throw error;
				}
				return "";
			});

			const result = await verifyWork({ runTypecheck: true, runTests: true, workingDirectory: "/test/dir" });

			expect(result.testsPassed).toBe(false);
			expect(result.passed).toBe(false); // Tests are blocking
			expect(result.issues).toContain("Tests failed (2)");
			expect(result.feedback).toContain("✗ TESTS FAILED");
		});

		it("should skip typecheck when runTypecheck is false", async () => {
			mockSuccessfulRun();

			const result = await verifyWork({ runTypecheck: false, runTests: false, workingDirectory: "/test/dir" });

			expect(result.typecheckPassed).toBe(true);
			// Typecheck should not be in the feedback when skipped
			const typecheckCalls = mockExecSync.mock.calls.filter((call) => String(call[0]).includes("pnpm typecheck"));
			expect(typecheckCalls).toHaveLength(0);
		});

		it("should skip tests when runTests is false", async () => {
			mockSuccessfulRun();

			const result = await verifyWork({ runTypecheck: true, runTests: false, workingDirectory: "/test/dir" });

			expect(result.testsPassed).toBe(true);
			const testCalls = mockExecSync.mock.calls.filter((call) => String(call[0]).includes("pnpm test"));
			expect(testCalls).toHaveLength(0);
		});

		it("should handle no changes detected (empty diff)", async () => {
			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					return "";
				}
				if (cmd.includes("git diff --stat")) {
					return "";
				}
				if (cmd.includes("git status --porcelain")) {
					return "";
				}
				if (cmd.includes("git diff --name-only")) {
					return "";
				}
				return "";
			});

			const result = await verifyWork({ runTypecheck: false, runTests: false, workingDirectory: "/test/dir" });

			expect(result.filesChanged).toBe(0);
			expect(result.passed).toBe(false); // No changes = fail
		});

		it("should add 'No changes detected' issue when git operations fail", async () => {
			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					return "";
				}
				if (cmd.includes("git diff") || cmd.includes("git status")) {
					throw new Error("Git operation failed");
				}
				return "";
			});

			const result = await verifyWork({ runTypecheck: false, runTests: false, workingDirectory: "/test/dir" });

			expect(result.filesChanged).toBe(0);
			expect(result.passed).toBe(false);
			expect(result.issues).toContain("No changes detected");
			expect(result.feedback).toContain("No file changes were made");
		});

		it("should fall back to comparing HEAD~1 when no uncommitted changes", async () => {
			let checkedCommittedChanges = false;

			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					return "";
				}
				if (cmd.includes("git diff --stat HEAD 2>/dev/null")) {
					return ""; // No uncommitted changes
				}
				if (cmd.includes("git status --porcelain")) {
					return ""; // No untracked files
				}
				if (cmd.includes("git diff --stat HEAD~1 HEAD")) {
					checkedCommittedChanges = true;
					return " 3 files changed, 50 insertions(+)";
				}
				if (cmd.includes("git diff --name-only")) {
					return "src/file.ts";
				}
				return "";
			});

			const result = await verifyWork({ runTypecheck: false, runTests: false, workingDirectory: "/test/dir" });

			expect(checkedCommittedChanges).toBe(true);
			expect(result.filesChanged).toBe(3);
		});

		it("should use baseCommit when provided", async () => {
			let usedBaseCommit = false;

			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					return "";
				}
				if (cmd.includes("git diff --stat HEAD 2>/dev/null")) {
					return ""; // No uncommitted changes
				}
				if (cmd.includes("git status --porcelain")) {
					return "";
				}
				if (cmd.includes("git diff --stat abc123 HEAD")) {
					usedBaseCommit = true;
					return " 2 files changed, 30 insertions(+)";
				}
				if (cmd.includes("git diff --name-only")) {
					return "src/file.ts";
				}
				return "";
			});

			const result = await verifyWork({
				runTypecheck: false,
				runTests: false,
				workingDirectory: "/test/dir",
				baseCommit: "abc123",
			});

			expect(usedBaseCommit).toBe(true);
			expect(result.filesChanged).toBe(2);
		});

		it("should detect code health issues", async () => {
			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					return "";
				}
				if (cmd.includes("git diff --stat")) {
					return " 1 file changed, 5 insertions(+)";
				}
				if (cmd.includes("git status --porcelain")) {
					return "";
				}
				if (cmd.includes("git diff --name-only")) {
					return "src/file.ts";
				}
				if (cmd.includes("pnpm typecheck")) {
					return "";
				}
				if (cmd.includes("pnpm check")) {
					return "";
				}
				if (cmd.includes("pnpm quality:check")) {
					return "Code Health: problematic - high complexity";
				}
				return "";
			});

			const result = await verifyWork({ runTypecheck: true, runTests: false, workingDirectory: "/test/dir" });

			expect(result.codeHealthPassed).toBe(false);
			expect(result.issues).toContain("Code health issues detected");
			expect(result.feedback).toContain("⚠ CODE HEALTH");
		});

		it("should skip code health for test files", async () => {
			mockExecSync.mockImplementation((command: string) => {
				const cmd = String(command);
				if (cmd.includes("pnpm spell")) {
					return "";
				}
				if (cmd.includes("git diff --stat")) {
					return " 1 file changed, 5 insertions(+)";
				}
				if (cmd.includes("git status --porcelain")) {
					return "";
				}
				if (cmd.includes("git diff --name-only")) {
					return "src/file.test.ts"; // Only test file
				}
				if (cmd.includes("pnpm typecheck")) {
					return "";
				}
				if (cmd.includes("pnpm check")) {
					return "";
				}
				return "";
			});

			const _result = await verifyWork({ runTypecheck: true, runTests: false, workingDirectory: "/test/dir" });

			// quality:check should not be called for test-only changes
			const qualityCalls = mockExecSync.mock.calls.filter((call) => String(call[0]).includes("pnpm quality:check"));
			expect(qualityCalls).toHaveLength(0);
		});

		it("should skip tests when only test files changed", async () => {
			mockSuccessfulRun({
				"git diff --name-only": "src/file.test.ts",
			});

			await verifyWork({ runTypecheck: true, runTests: true, workingDirectory: "/test/dir" });

			// Tests should not run when only test files changed (no source files)
			const testCalls = mockExecSync.mock.calls.filter((call) => String(call[0]).includes("pnpm test"));
			expect(testCalls).toHaveLength(0);
		});

		it("should handle single file change grammar correctly", async () => {
			mockSuccessfulRun({
				"git diff --stat": " 1 file changed, 10 insertions(+)",
			});

			const result = await verifyWork({ runTypecheck: true, runTests: false, workingDirectory: "/test/dir" });

			expect(result.filesChanged).toBe(1);
		});

		it("should filter untracked files by extension", async () => {
			mockSuccessfulRun({
				"git diff --stat": "",
				"git status --porcelain": "?? src/file.ts\n?? README.md\n?? image.png",
			});

			const result = await verifyWork({ runTypecheck: false, runTests: false, workingDirectory: "/test/dir" });

			// Only .ts files should be counted from untracked
			expect(result.filesChanged).toBe(1);
		});
	});
});
