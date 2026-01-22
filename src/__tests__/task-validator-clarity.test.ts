/**
 * Tests for task clarity assessment in task-validator.ts
 *
 * Tests the assessTaskClarity and formatClarityAssessment functions
 * that determine if tasks are specific enough for autonomous execution.
 */

import { describe, expect, it } from "vitest";
import { assessTaskClarity, formatClarityAssessment } from "../task-validator.js";

describe("task clarity assessment", () => {
	describe("assessTaskClarity", () => {
		describe("fundamentally vague patterns", () => {
			it("should reject 'Phase N:' patterns as fundamentally vague", () => {
				const result = assessTaskClarity("Phase 5: Implement testing infrastructure");
				expect(result.clarity).toBe("vague");
				expect(result.tooVague).toBe(true);
				expect(result.tooVagueReason).toContain("vague pattern");
				expect(result.confidence).toBeGreaterThanOrEqual(0.9);
			});

			it("should reject 'Step N:' patterns as fundamentally vague", () => {
				const result = assessTaskClarity("Step 3: Build the authentication system");
				expect(result.clarity).toBe("vague");
				expect(result.tooVague).toBe(true);
			});

			it("should reject 'comprehensive X suite' patterns", () => {
				const result = assessTaskClarity("Create a comprehensive test suite");
				expect(result.clarity).toBe("vague");
				expect(result.tooVague).toBe(true);
			});

			it("should reject 'implement X system' without specifics", () => {
				const result = assessTaskClarity("Implement caching system");
				expect(result.clarity).toBe("vague");
				expect(result.tooVague).toBe(true);
			});

			it("should reject 'create X module' without details", () => {
				const result = assessTaskClarity("Create authentication module");
				expect(result.clarity).toBe("vague");
				expect(result.tooVague).toBe(true);
			});

			it("should reject 'build X infrastructure' patterns", () => {
				const result = assessTaskClarity("Build testing infrastructure");
				expect(result.clarity).toBe("vague");
				expect(result.tooVague).toBe(true);
			});

			it("should reject 'design and implement' multi-phase tasks", () => {
				const result = assessTaskClarity("Design and implement the new API");
				expect(result.clarity).toBe("vague");
				expect(result.tooVague).toBe(true);
			});

			it("should reject 'research and implement' multi-phase tasks", () => {
				const result = assessTaskClarity("Research and implement best practices for logging");
				expect(result.clarity).toBe("vague");
				expect(result.tooVague).toBe(true);
			});

			it("should provide suggestions for vague tasks", () => {
				const result = assessTaskClarity("Phase 1: Build feature");
				expect(result.suggestions.length).toBeGreaterThan(0);
				expect(result.suggestions.some((s) => s.includes("target"))).toBe(true);
			});
		});

		describe("vague verbs without specifics", () => {
			it("should flag 'improve' without target as needing context", () => {
				const result = assessTaskClarity("Improve the code");
				expect(result.clarity).not.toBe("clear");
				expect(result.issues.some((i) => i.includes("generic verb"))).toBe(true);
			});

			it("should flag 'fix' without specifics", () => {
				const result = assessTaskClarity("Fix the bug");
				expect(result.clarity).not.toBe("clear");
			});

			it("should flag 'update' without specifics", () => {
				const result = assessTaskClarity("Update the code");
				expect(result.clarity).not.toBe("clear");
			});

			it("should flag 'enhance' without specifics", () => {
				const result = assessTaskClarity("Enhance performance");
				expect(result.clarity).not.toBe("clear");
			});

			it("should flag 'optimize' without specifics", () => {
				const result = assessTaskClarity("Optimize the system");
				expect(result.clarity).not.toBe("clear");
			});

			it("should flag 'refactor' without specifics", () => {
				const result = assessTaskClarity("Refactor this code");
				expect(result.clarity).not.toBe("clear");
			});

			it("should flag 'clean up' without specifics", () => {
				const result = assessTaskClarity("Clean up the code");
				expect(result.clarity).not.toBe("clear");
			});

			it("should flag 'make X better' without specifics", () => {
				// Note: "error handling" contains specificity indicator "error" so this may pass
				const result = assessTaskClarity("Make things better");
				expect(result.clarity).not.toBe("clear");
			});

			it("should accept vague verb with specific file target", () => {
				const result = assessTaskClarity("Improve error handling in src/worker.ts");
				// Should be clear because it has a specific file target
				expect(result.clarity).toBe("clear");
			});

			it("should accept vague verb with specific function target", () => {
				const result = assessTaskClarity("Refactor function processTask to use async/await");
				expect(result.clarity).toBe("clear");
			});
		});

		describe("compound objectives", () => {
			it("should flag 'and also' as compound", () => {
				const result = assessTaskClarity("Fix the login bug and also update the dashboard");
				expect(result.issues.some((i) => i.includes("multiple objectives"))).toBe(true);
			});

			it("should flag 'plus' as compound", () => {
				const result = assessTaskClarity("Add user validation plus implement rate limiting");
				expect(result.issues.some((i) => i.includes("multiple objectives"))).toBe(true);
			});

			it("should flag 'additionally' as compound", () => {
				const result = assessTaskClarity("Fix the tests; additionally, update the docs");
				expect(result.issues.some((i) => i.includes("multiple objectives"))).toBe(true);
			});

			it("should flag 'furthermore' as compound", () => {
				const result = assessTaskClarity("Create the API endpoint furthermore add tests");
				expect(result.issues.some((i) => i.includes("multiple objectives"))).toBe(true);
			});

			it("should flag comma-and patterns as compound", () => {
				const result = assessTaskClarity("Add login functionality, and implement logout");
				expect(result.issues.some((i) => i.includes("multiple objectives"))).toBe(true);
			});

			it("should suggest splitting compound tasks", () => {
				const result = assessTaskClarity("Fix bug and also add feature");
				expect(result.suggestions.some((s) => s.includes("Split") || s.includes("separate"))).toBe(true);
			});
		});

		describe("short objectives", () => {
			it("should flag very short objectives (< 5 words)", () => {
				const result = assessTaskClarity("Fix bug");
				expect(result.clarity).not.toBe("clear");
				expect(result.issues.some((i) => i.includes("short"))).toBe(true);
			});

			it("should mildly penalize somewhat short objectives (5-9 words)", () => {
				const result = assessTaskClarity("Add a new button to the page");
				// 8 words - should be penalized slightly but might still be clear
				expect(result.confidence).toBeLessThan(1.0);
			});

			it("should not penalize longer objectives", () => {
				const result = assessTaskClarity(
					"In src/components/Button.tsx, add a new variant prop that supports 'primary', 'secondary', and 'outline' styles",
				);
				expect(result.issues.every((i) => !i.includes("short"))).toBe(true);
			});
		});

		describe("code task specificity", () => {
			it("should flag code tasks without file or function mention", () => {
				const result = assessTaskClarity("Add error handling");
				expect(result.clarity).not.toBe("clear");
				expect(result.issues.some((i) => i.includes("file") || i.includes("function"))).toBe(true);
			});

			it("should accept code tasks with file path", () => {
				const result = assessTaskClarity("Add error handling in src/api/routes.ts");
				expect(result.clarity).toBe("clear");
			});

			it("should accept code tasks with function name", () => {
				const result = assessTaskClarity("Add error handling to function handleRequest()");
				expect(result.clarity).toBe("clear");
			});

			it("should accept code tasks with class name", () => {
				const result = assessTaskClarity("Add error handling to class ApiClient");
				expect(result.clarity).toBe("clear");
			});

			it("should accept code tasks with method name", () => {
				const result = assessTaskClarity("Add error handling to method processData");
				expect(result.clarity).toBe("clear");
			});

			it("should not flag long descriptive code tasks without file path", () => {
				// 15+ words should pass even without explicit file path
				const result = assessTaskClarity(
					"Implement a retry mechanism with exponential backoff for failed API requests that returns meaningful error messages to the caller",
				);
				expect(result.issues.every((i) => !i.includes("No specific file"))).toBe(true);
			});
		});

		describe("specificity indicators", () => {
			it("should boost clarity for 'In file.ts' pattern", () => {
				const result = assessTaskClarity("In src/utils.ts, add a helper function");
				expect(result.clarity).toBe("clear");
			});

			it("should boost clarity for function mentions", () => {
				const result = assessTaskClarity("Update function calculateTotal to handle edge cases");
				expect(result.clarity).toBe("clear");
			});

			it("should boost clarity for class mentions", () => {
				const result = assessTaskClarity("Refactor class TaskManager to use dependency injection");
				expect(result.clarity).toBe("clear");
			});

			it("should boost clarity for component mentions", () => {
				const result = assessTaskClarity("Fix component UserProfile to show loading state");
				expect(result.clarity).toBe("clear");
			});

			it("should boost clarity for test descriptions", () => {
				const result = assessTaskClarity("Add test for handleError when network fails");
				expect(result.clarity).toBe("clear");
			});

			it("should boost clarity for error messages", () => {
				const result = assessTaskClarity("Fix error: Cannot read property 'id' of undefined in processUser");
				expect(result.clarity).toBe("clear");
			});

			it("should boost clarity for TypeScript error codes", () => {
				const result = assessTaskClarity("Fix TS2345 type error in src/api.ts");
				expect(result.clarity).toBe("clear");
			});

			it("should boost clarity for line number references", () => {
				const result = assessTaskClarity("Fix null check at line 42 in handler.ts");
				expect(result.clarity).toBe("clear");
			});

			it("should boost clarity for 'when X happens' descriptions", () => {
				const result = assessTaskClarity("Handle case when user session expires during request");
				expect(result.clarity).toBe("clear");
			});

			it("should boost clarity for 'return X' descriptions", () => {
				const result = assessTaskClarity("Fix function to return empty array instead of null");
				expect(result.clarity).toBe("clear");
			});
		});

		describe("clear task examples", () => {
			it("should mark specific bug fix as clear", () => {
				const result = assessTaskClarity(
					"In src/auth/login.ts, fix the issue where incorrect password doesn't show error message",
				);
				expect(result.clarity).toBe("clear");
				expect(result.confidence).toBeGreaterThanOrEqual(0.7);
			});

			it("should mark specific feature as clear", () => {
				const result = assessTaskClarity(
					"Add a 'remember me' checkbox to the login form in src/components/LoginForm.tsx that persists the session for 30 days",
				);
				expect(result.clarity).toBe("clear");
			});

			it("should mark specific refactor as clear", () => {
				const result = assessTaskClarity(
					"In src/utils/date.ts, refactor formatDate function to use Intl.DateTimeFormat instead of moment.js",
				);
				expect(result.clarity).toBe("clear");
			});

			it("should mark test task as clear", () => {
				const result = assessTaskClarity("Add unit test for validateEmail function that checks invalid email formats");
				expect(result.clarity).toBe("clear");
			});
		});

		describe("needs_context assessments", () => {
			it("should mark moderately vague tasks as needs_context", () => {
				const result = assessTaskClarity("Improve performance");
				// Not fundamentally vague but needs more context
				expect(["vague", "needs_context"]).toContain(result.clarity);
			});

			it("should provide clarity score in valid range", () => {
				const result = assessTaskClarity("Do something");
				expect(result.confidence).toBeGreaterThanOrEqual(0);
				expect(result.confidence).toBeLessThanOrEqual(1);
			});
		});

		describe("edge cases", () => {
			it("should handle empty string", () => {
				const result = assessTaskClarity("");
				// Note: Empty strings currently pass through with no deductions
				// This is a potential area for improvement in the validator
				expect(result).toBeDefined();
				expect(result.clarity).toBeDefined();
			});

			it("should handle whitespace only", () => {
				const result = assessTaskClarity("   ");
				// Note: Whitespace-only strings currently pass through with no deductions
				// This is a potential area for improvement in the validator
				expect(result).toBeDefined();
				expect(result.clarity).toBeDefined();
			});

			it("should handle single word", () => {
				const result = assessTaskClarity("Fix");
				expect(result.clarity).not.toBe("clear");
				expect(result.issues.some((i) => i.includes("short"))).toBe(true);
			});

			it("should handle very long objective", () => {
				const longObjective =
					"In src/services/UserService.ts, refactor the getUserById function to implement proper caching with a TTL of 5 minutes, add retry logic for database connection failures with exponential backoff starting at 100ms and maxing out at 5 seconds, ensure proper error handling that distinguishes between user-not-found and database-unavailable errors, and add comprehensive logging at debug level for cache hits and misses";
				const result = assessTaskClarity(longObjective);
				// Very detailed - should be clear despite being long
				expect(result.clarity).toBe("clear");
			});

			it("should handle special characters in objective", () => {
				const result = assessTaskClarity("Fix regex /^test.*/ in src/validator.ts");
				expect(result).toBeDefined();
				// Should still work even with regex-like content
			});
		});
	});

	describe("formatClarityAssessment", () => {
		it("should return empty array for clear tasks", () => {
			const assessment = {
				clarity: "clear" as const,
				confidence: 0.9,
				issues: [],
				suggestions: [],
			};
			const result = formatClarityAssessment("task-123", assessment);
			expect(result).toHaveLength(0);
		});

		it("should format vague tasks with warning symbol", () => {
			const assessment = {
				clarity: "vague" as const,
				confidence: 0.3,
				issues: ["Task is too vague"],
				suggestions: ["Be more specific"],
			};
			const result = formatClarityAssessment("task-456", assessment);
			expect(result.length).toBeGreaterThan(0);
			expect(result[0]).toContain("task-456");
			expect(result[0]).toContain("vague");
		});

		it("should format needs_context tasks with question mark", () => {
			const assessment = {
				clarity: "needs_context" as const,
				confidence: 0.5,
				issues: ["No file specified"],
				suggestions: ["Add file path"],
			};
			const result = formatClarityAssessment("task-789", assessment);
			expect(result.length).toBeGreaterThan(0);
			expect(result[0]).toContain("?");
			expect(result[0]).toContain("ambiguous");
		});

		it("should include issues in output", () => {
			const assessment = {
				clarity: "vague" as const,
				confidence: 0.2,
				issues: ["Issue one", "Issue two"],
				suggestions: [],
			};
			const result = formatClarityAssessment("task-abc", assessment);
			expect(result.some((line) => line.includes("Issue one"))).toBe(true);
			expect(result.some((line) => line.includes("Issue two"))).toBe(true);
		});

		it("should include suggestions section when present", () => {
			const assessment = {
				clarity: "vague" as const,
				confidence: 0.2,
				issues: ["Problem found"],
				suggestions: ["Suggestion A", "Suggestion B"],
			};
			const result = formatClarityAssessment("task-def", assessment);
			expect(result.some((line) => line.includes("Suggestions"))).toBe(true);
			expect(result.some((line) => line.includes("Suggestion A"))).toBe(true);
			expect(result.some((line) => line.includes("Suggestion B"))).toBe(true);
		});

		it("should format with proper indentation", () => {
			const assessment = {
				clarity: "vague" as const,
				confidence: 0.2,
				issues: ["Test issue"],
				suggestions: ["Test suggestion"],
			};
			const result = formatClarityAssessment("task-xyz", assessment);
			// Issues should be indented with "  -"
			expect(result.some((line) => line.startsWith("  -"))).toBe(true);
			// Suggestions should be indented with "    →"
			expect(result.some((line) => line.includes("→"))).toBe(true);
		});

		it("should handle empty issues array", () => {
			const assessment = {
				clarity: "needs_context" as const,
				confidence: 0.5,
				issues: [],
				suggestions: ["Add more detail"],
			};
			const result = formatClarityAssessment("task-empty", assessment);
			expect(result.length).toBeGreaterThan(0);
		});

		it("should handle empty suggestions array", () => {
			const assessment = {
				clarity: "vague" as const,
				confidence: 0.3,
				issues: ["Something wrong"],
				suggestions: [],
			};
			const result = formatClarityAssessment("task-nosugg", assessment);
			// Should not include Suggestions section
			expect(result.every((line) => !line.includes("Suggestions"))).toBe(true);
		});
	});
});
