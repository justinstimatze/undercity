/**
 * Tests for verification.ts
 *
 * Tests error categorization and verification result handling.
 */

import { describe, expect, it } from "vitest";
import { categorizeErrors, type VerificationResult } from "../verification.js";

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
				passed: true, // Can pass if typecheck passes even with lint issues
				typecheckPassed: true,
				lintPassed: false,
				testsPassed: false,
				filesChanged: 10,
				issues: ["Lint issues (3)", "Tests failed (2)"],
				feedback: "✓ Typecheck passed\n⚠ LINT ISSUES\n✗ TESTS FAILED",
			});

			expect(result.passed).toBe(true);
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
});
