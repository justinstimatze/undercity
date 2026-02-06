/**
 * Type-level tests for security validation and sanitization functions
 *
 * These tests verify compile-time correctness of type signatures.
 * Run with: pnpm vitest typecheck
 */

import { describe, expectTypeOf, it } from "vitest";
import type { SanitizationResult } from "../../content-sanitizer.js";
import {
	detectInjectionPatterns,
	isContentSafe,
	sanitizeContent,
	wrapUntrustedContent,
} from "../../content-sanitizer.js";
import type { PathValidationResult, TaskSecurityResult } from "../../task-security.js";
import {
	filterSafeProposals,
	getSecurityPatterns,
	isSensitiveFile,
	isTaskObjectiveSafe,
	validateTaskObjective,
	validateTaskPaths,
	validateTaskProposals,
} from "../../task-security.js";
import type { TicketContent } from "../../types.js";
import { formatTicketContext } from "../../worker/prompt-builder.js";

describe("task-security.ts type tests", () => {
	describe("validateTaskObjective", () => {
		it("accepts string input", () => {
			expectTypeOf(validateTaskObjective).parameter(0).toBeString();
		});

		it("returns TaskSecurityResult", () => {
			expectTypeOf(validateTaskObjective).returns.toEqualTypeOf<TaskSecurityResult>();
		});

		it("TaskSecurityResult has correct structure", () => {
			const result = validateTaskObjective("test");
			expectTypeOf(result).toHaveProperty("isSafe");
			expectTypeOf(result.isSafe).toBeBoolean();
			expectTypeOf(result.rejectionReasons).toEqualTypeOf<string[]>();
			expectTypeOf(result.warnings).toEqualTypeOf<string[]>();
			expectTypeOf(result.sanitizedObjective).toEqualTypeOf<string | undefined>();
		});
	});

	describe("isSensitiveFile", () => {
		it("accepts string input", () => {
			expectTypeOf(isSensitiveFile).parameter(0).toBeString();
		});

		it("returns boolean", () => {
			expectTypeOf(isSensitiveFile).returns.toBeBoolean();
		});
	});

	describe("validateTaskProposals", () => {
		it("accepts array of objects with objective", () => {
			expectTypeOf(validateTaskProposals).parameter(0).toEqualTypeOf<Array<{ objective: string }>>();
		});

		it("returns array with validation results", () => {
			expectTypeOf(validateTaskProposals).returns.toEqualTypeOf<
				Array<{
					objective: string;
					validation: TaskSecurityResult;
				}>
			>();
		});

		it("preserves objective in return type", () => {
			const result = validateTaskProposals([{ objective: "test" }]);
			expectTypeOf(result[0].objective).toBeString();
			expectTypeOf(result[0].validation).toEqualTypeOf<TaskSecurityResult>();
		});
	});

	describe("filterSafeProposals", () => {
		it("accepts generic array with objective constraint", () => {
			expectTypeOf(filterSafeProposals).toBeCallableWith([{ objective: "test" }]);
		});

		it("preserves generic type parameter with extra properties", () => {
			interface ProposalWithExtras {
				objective: string;
				priority: number;
				tags: string[];
			}

			const input: ProposalWithExtras[] = [{ objective: "test", priority: 1, tags: ["tag1"] }];

			const result = filterSafeProposals(input);

			// Result should preserve all properties
			expectTypeOf(result).toEqualTypeOf<ProposalWithExtras[]>();
			expectTypeOf(result[0]).toHaveProperty("priority");
			expectTypeOf(result[0]).toHaveProperty("tags");
		});

		it("requires objective property", () => {
			// @ts-expect-error - missing objective property
			filterSafeProposals([{ notObjective: "test" }]);
		});
	});

	describe("isTaskObjectiveSafe", () => {
		it("accepts string input", () => {
			expectTypeOf(isTaskObjectiveSafe).parameter(0).toBeString();
		});

		it("returns boolean", () => {
			expectTypeOf(isTaskObjectiveSafe).returns.toBeBoolean();
		});
	});

	describe("validateTaskPaths", () => {
		it("accepts string as first parameter", () => {
			expectTypeOf(validateTaskPaths).parameter(0).toBeString();
		});

		it("accepts optional string as second parameter", () => {
			expectTypeOf(validateTaskPaths).parameter(1).toEqualTypeOf<string | undefined>();
		});

		it("can be called with one argument", () => {
			expectTypeOf(validateTaskPaths).toBeCallableWith("test");
		});

		it("can be called with two arguments", () => {
			expectTypeOf(validateTaskPaths).toBeCallableWith("test", "/path");
		});

		it("returns PathValidationResult", () => {
			expectTypeOf(validateTaskPaths).returns.toEqualTypeOf<PathValidationResult>();
		});

		it("PathValidationResult has correct structure", () => {
			const result = validateTaskPaths("test");
			expectTypeOf(result.isValid).toBeBoolean();
			expectTypeOf(result.invalidDirectories).toEqualTypeOf<string[]>();
			expectTypeOf(result.invalidFiles).toEqualTypeOf<string[]>();
		});
	});

	describe("getSecurityPatterns", () => {
		it("returns array of pattern metadata", () => {
			const patterns = getSecurityPatterns();
			expectTypeOf(patterns).toBeArray();
			expectTypeOf(patterns[0]).toHaveProperty("category");
			expectTypeOf(patterns[0]).toHaveProperty("severity");
			expectTypeOf(patterns[0]).toHaveProperty("description");
			expectTypeOf(patterns[0].category).toBeString();
			expectTypeOf(patterns[0].description).toBeString();
		});

		it("severity is union of block and warn", () => {
			const patterns = getSecurityPatterns();
			// Severity should be the literal union type
			expectTypeOf(patterns[0].severity).toMatchTypeOf<"block" | "warn">();
		});
	});
});

describe("content-sanitizer.ts type tests", () => {
	describe("sanitizeContent", () => {
		it("accepts string as first parameter", () => {
			expectTypeOf(sanitizeContent).parameter(0).toBeString();
		});

		it("accepts optional string as second parameter (source)", () => {
			expectTypeOf(sanitizeContent).parameter(1).toEqualTypeOf<string | undefined>();
		});

		it("accepts optional number as third parameter (maxLength)", () => {
			expectTypeOf(sanitizeContent).parameter(2).toEqualTypeOf<number | undefined>();
		});

		it("can be called with just content", () => {
			expectTypeOf(sanitizeContent).toBeCallableWith("content");
		});

		it("can be called with content and source", () => {
			expectTypeOf(sanitizeContent).toBeCallableWith("content", "source");
		});

		it("can be called with all parameters", () => {
			expectTypeOf(sanitizeContent).toBeCallableWith("content", "source", 1000);
		});

		it("returns SanitizationResult", () => {
			expectTypeOf(sanitizeContent).returns.toEqualTypeOf<SanitizationResult>();
		});

		it("SanitizationResult has correct structure", () => {
			const result = sanitizeContent("test");
			expectTypeOf(result.content).toBeString();
			expectTypeOf(result.blocked).toBeBoolean();
			expectTypeOf(result.matchedPatterns).toEqualTypeOf<string[]>();
			expectTypeOf(result.warnings).toEqualTypeOf<string[]>();
		});
	});

	describe("wrapUntrustedContent", () => {
		it("accepts two string parameters", () => {
			expectTypeOf(wrapUntrustedContent).parameter(0).toBeString();
			expectTypeOf(wrapUntrustedContent).parameter(1).toBeString();
		});

		it("returns string", () => {
			expectTypeOf(wrapUntrustedContent).returns.toBeString();
		});

		it("requires both parameters", () => {
			expectTypeOf(wrapUntrustedContent).toBeCallableWith("content", "source");
			// @ts-expect-error - missing second parameter
			wrapUntrustedContent("content");
		});
	});

	describe("detectInjectionPatterns", () => {
		it("accepts string parameter", () => {
			expectTypeOf(detectInjectionPatterns).parameter(0).toBeString();
		});

		it("returns detection result object", () => {
			const result = detectInjectionPatterns("test");
			expectTypeOf(result).toHaveProperty("hasBlockingPatterns");
			expectTypeOf(result).toHaveProperty("hasStrippingPatterns");
			expectTypeOf(result).toHaveProperty("hasWarningPatterns");
			expectTypeOf(result).toHaveProperty("patterns");
			expectTypeOf(result.hasBlockingPatterns).toBeBoolean();
			expectTypeOf(result.hasStrippingPatterns).toBeBoolean();
			expectTypeOf(result.hasWarningPatterns).toBeBoolean();
			expectTypeOf(result.patterns).toEqualTypeOf<string[]>();
		});
	});

	describe("isContentSafe", () => {
		it("accepts string parameter", () => {
			expectTypeOf(isContentSafe).parameter(0).toBeString();
		});

		it("returns boolean", () => {
			expectTypeOf(isContentSafe).returns.toBeBoolean();
		});
	});
});

describe("prompt-builder.ts type tests", () => {
	describe("formatTicketContext", () => {
		it("accepts TicketContent parameter", () => {
			expectTypeOf(formatTicketContext).parameter(0).toEqualTypeOf<TicketContent>();
		});

		it("returns string", () => {
			expectTypeOf(formatTicketContext).returns.toBeString();
		});

		it("works with minimal ticket", () => {
			const ticket: TicketContent = {
				description: "test",
			};
			expectTypeOf(formatTicketContext).toBeCallableWith(ticket);
		});

		it("works with full ticket", () => {
			const ticket: TicketContent = {
				description: "test",
				acceptanceCriteria: ["criterion 1"],
				testPlan: "test plan",
				implementationNotes: "notes",
				rationale: "rationale",
				researchFindings: ["finding 1"],
			};
			expectTypeOf(formatTicketContext).toBeCallableWith(ticket);
		});
	});
});

describe("Type narrowing and guards", () => {
	it("validateTaskObjective result allows type narrowing", () => {
		const result = validateTaskObjective("test");

		if (result.isSafe) {
			// TypeScript doesn't narrow boolean properties to literal types in branches
			// but we can verify the overall structure is preserved
			expectTypeOf(result).toMatchTypeOf<TaskSecurityResult>();
			expectTypeOf(result.rejectionReasons).toEqualTypeOf<string[]>();
		} else {
			expectTypeOf(result).toMatchTypeOf<TaskSecurityResult>();
			expectTypeOf(result.rejectionReasons).toEqualTypeOf<string[]>();
		}
	});

	it("sanitizeContent result allows type narrowing", () => {
		const result = sanitizeContent("test");

		if (result.blocked) {
			// TypeScript doesn't narrow boolean properties to literal types in branches
			// but we can verify the overall structure is preserved
			expectTypeOf(result).toMatchTypeOf<SanitizationResult>();
			expectTypeOf(result.content).toBeString();
		} else {
			expectTypeOf(result).toMatchTypeOf<SanitizationResult>();
			expectTypeOf(result.content).toBeString();
		}
	});

	it("boolean guards work as type predicates", () => {
		const objective = "test";

		if (isTaskObjectiveSafe(objective)) {
			// Type guard worked - objective is still string
			expectTypeOf(objective).toBeString();
		}

		if (isContentSafe("content")) {
			// Type guard worked - content is still string
			expectTypeOf("content").toBeString();
		}

		if (isSensitiveFile("/path/to/.env")) {
			// Type guard worked - path is still string
			expectTypeOf("/path/to/.env").toBeString();
		}
	});
});

describe("Invalid usage patterns (should fail compilation)", () => {
	it("rejects non-string inputs to string functions", () => {
		// @ts-expect-error - number not assignable to string
		validateTaskObjective(123);

		// @ts-expect-error - boolean not assignable to string
		isSensitiveFile(true);

		// @ts-expect-error - object not assignable to string
		isTaskObjectiveSafe({ objective: "test" });

		// @ts-expect-error - array not assignable to string
		sanitizeContent(["test"]);

		// @ts-expect-error - undefined not assignable to string
		isContentSafe(undefined);
	});

	it("rejects invalid proposal objects", () => {
		// @ts-expect-error - missing objective property
		validateTaskProposals([{ description: "test" }]);

		// @ts-expect-error - objective must be string
		filterSafeProposals([{ objective: 123 }]);
	});

	it("rejects wrong parameter counts", () => {
		// @ts-expect-error - too many parameters
		isSensitiveFile("path", "extra");

		// @ts-expect-error - too many parameters
		isTaskObjectiveSafe("test", "extra");

		// @ts-expect-error - missing required parameter
		wrapUntrustedContent("content");
	});

	it("rejects wrong types for optional parameters", () => {
		// @ts-expect-error - source must be string, not number
		sanitizeContent("content", 123);

		// @ts-expect-error - maxLength must be number, not string
		sanitizeContent("content", "source", "1000");

		// @ts-expect-error - cwd must be string, not number
		validateTaskPaths("objective", 123);
	});
});
