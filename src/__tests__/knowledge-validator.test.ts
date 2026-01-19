/**
 * Tests for knowledge-validator.ts
 *
 * Tests validation functions for knowledge base structure including:
 * - Type guard functions (isLearning, isLearningCategory, isKnowledgeBase)
 * - Detailed validation with error reporting (validateLearning, validateKnowledgeBase)
 * - Valid structure acceptance
 * - Invalid/malformed data rejection
 * - Type coercion detection
 * - Required field validation
 * - Field value range validation (confidence, usedCount, etc.)
 * - Edge cases (empty arrays, missing optional fields)
 * - Backward compatibility (old knowledge.json without version/lastUpdated)
 */

import { describe, expect, it } from "vitest";

import type { KnowledgeBase, Learning } from "../knowledge.js";
import {
	formatValidationIssues,
	isKnowledgeBase,
	isLearning,
	isLearningCategory,
	validateKnowledgeBase,
	validateLearning,
} from "../knowledge-validator.js";

describe("knowledge-validator.ts", () => {
	// ==========================================================================
	// Type Guard Tests: isLearningCategory
	// ==========================================================================

	describe("isLearningCategory", () => {
		it("should accept valid learning categories", () => {
			expect(isLearningCategory("pattern")).toBe(true);
			expect(isLearningCategory("gotcha")).toBe(true);
			expect(isLearningCategory("preference")).toBe(true);
			expect(isLearningCategory("fact")).toBe(true);
		});

		it("should reject invalid categories", () => {
			expect(isLearningCategory("invalid")).toBe(false);
			expect(isLearningCategory("")).toBe(false);
			expect(isLearningCategory("Pattern")).toBe(false); // Case-sensitive
			expect(isLearningCategory(123)).toBe(false);
			expect(isLearningCategory(null)).toBe(false);
			expect(isLearningCategory(undefined)).toBe(false);
		});
	});

	// ==========================================================================
	// Type Guard Tests: isLearning
	// ==========================================================================

	describe("isLearning", () => {
		it("should accept valid Learning object", () => {
			const validLearning: Learning = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test content",
				keywords: ["test", "content"],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			expect(isLearning(validLearning)).toBe(true);
		});

		it("should accept Learning with optional fields", () => {
			const learningWithOptional: Learning = {
				id: "learn-123",
				taskId: "task-456",
				category: "gotcha",
				content: "Test content",
				keywords: ["test"],
				confidence: 0.8,
				usedCount: 5,
				successCount: 4,
				createdAt: new Date().toISOString(),
				lastUsedAt: new Date().toISOString(),
				structured: {
					file: "src/test.ts",
					pattern: "test pattern",
					approach: "test approach",
				},
			};

			expect(isLearning(learningWithOptional)).toBe(true);
		});

		it("should reject non-object values", () => {
			expect(isLearning(null)).toBe(false);
			expect(isLearning(undefined)).toBe(false);
			expect(isLearning("string")).toBe(false);
			expect(isLearning(123)).toBe(false);
			expect(isLearning([])).toBe(false);
		});

		it("should reject Learning with missing required fields", () => {
			const missingId = {
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(missingId)).toBe(false);

			const missingTaskId = {
				id: "learn-123",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(missingTaskId)).toBe(false);

			const missingCategory = {
				id: "learn-123",
				taskId: "task-456",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(missingCategory)).toBe(false);
		});

		it("should reject Learning with wrong field types", () => {
			const wrongIdType = {
				id: 123, // Should be string
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(wrongIdType)).toBe(false);

			const wrongKeywordsType = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: "not-array", // Should be array
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(wrongKeywordsType)).toBe(false);

			const keywordsWithNonString = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: ["valid", 123], // All keywords must be strings
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(keywordsWithNonString)).toBe(false);
		});

		it("should reject Learning with invalid confidence range", () => {
			const negativeConfidence = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: -0.1, // Must be 0-1
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(negativeConfidence)).toBe(false);

			const tooHighConfidence = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 1.5, // Must be 0-1
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(tooHighConfidence)).toBe(false);
		});

		it("should reject Learning with invalid counts", () => {
			const negativeUsedCount = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: -1, // Must be non-negative
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(negativeUsedCount)).toBe(false);

			const floatUsedCount = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 1.5, // Must be integer
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(floatUsedCount)).toBe(false);
		});

		it("should reject Learning with invalid date", () => {
			const invalidCreatedAt = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: "not-a-date",
			};
			expect(isLearning(invalidCreatedAt)).toBe(false);

			const invalidLastUsedAt = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
				lastUsedAt: "invalid-date",
			};
			expect(isLearning(invalidLastUsedAt)).toBe(false);
		});

		it("should reject Learning with empty required strings", () => {
			const emptyId = {
				id: "",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(emptyId)).toBe(false);

			const emptyContent = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};
			expect(isLearning(emptyContent)).toBe(false);
		});

		it("should reject Learning with invalid structured field types", () => {
			const invalidStructured = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
				structured: "not-object", // Must be object
			};
			expect(isLearning(invalidStructured)).toBe(false);

			const invalidStructuredFile = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
				structured: {
					file: 123, // Must be string
				},
			};
			expect(isLearning(invalidStructuredFile)).toBe(false);
		});
	});

	// ==========================================================================
	// Type Guard Tests: isKnowledgeBase
	// ==========================================================================

	describe("isKnowledgeBase", () => {
		it("should accept valid KnowledgeBase", () => {
			const validKB: KnowledgeBase = {
				learnings: [],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
			expect(isKnowledgeBase(validKB)).toBe(true);
		});

		it("should accept KnowledgeBase with learnings", () => {
			const kbWithLearnings: KnowledgeBase = {
				learnings: [
					{
						id: "learn-123",
						taskId: "task-456",
						category: "pattern",
						content: "Test",
						keywords: ["test"],
						confidence: 0.5,
						usedCount: 0,
						successCount: 0,
						createdAt: new Date().toISOString(),
					},
				],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
			expect(isKnowledgeBase(kbWithLearnings)).toBe(true);
		});

		it("should accept KnowledgeBase without version/lastUpdated (backward compatibility)", () => {
			const oldKB = {
				learnings: [],
			};
			expect(isKnowledgeBase(oldKB)).toBe(true);
		});

		it("should reject non-object values", () => {
			expect(isKnowledgeBase(null)).toBe(false);
			expect(isKnowledgeBase(undefined)).toBe(false);
			expect(isKnowledgeBase("string")).toBe(false);
			expect(isKnowledgeBase(123)).toBe(false);
			expect(isKnowledgeBase([])).toBe(false);
		});

		it("should reject KnowledgeBase with missing learnings array", () => {
			const noLearnings = {
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
			expect(isKnowledgeBase(noLearnings)).toBe(false);
		});

		it("should reject KnowledgeBase with invalid learnings array", () => {
			const notArray = {
				learnings: "not-array",
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
			expect(isKnowledgeBase(notArray)).toBe(false);
		});

		it("should reject KnowledgeBase with invalid learning in array", () => {
			const invalidLearning = {
				learnings: [
					{
						id: "learn-123",
						// Missing required fields
					},
				],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
			expect(isKnowledgeBase(invalidLearning)).toBe(false);
		});

		it("should reject KnowledgeBase with invalid version type", () => {
			const wrongVersionType = {
				learnings: [],
				version: 123, // Must be string
				lastUpdated: new Date().toISOString(),
			};
			expect(isKnowledgeBase(wrongVersionType)).toBe(false);
		});

		it("should reject KnowledgeBase with invalid lastUpdated", () => {
			const invalidLastUpdated = {
				learnings: [],
				version: "1.0",
				lastUpdated: "not-a-date",
			};
			expect(isKnowledgeBase(invalidLastUpdated)).toBe(false);
		});
	});

	// ==========================================================================
	// Detailed Validation Tests: validateLearning
	// ==========================================================================

	describe("validateLearning", () => {
		it("should validate correct Learning without issues", () => {
			const validLearning: Learning = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test content",
				keywords: ["test"],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			const result = validateLearning(validLearning);
			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});

		it("should report missing required fields", () => {
			const missingFields = {
				// Missing id, taskId, category, content, keywords, etc.
			};

			const result = validateLearning(missingFields);
			expect(result.valid).toBe(false);
			expect(result.issues.length).toBeGreaterThan(0);

			const issueTypes = result.issues.map((i) => i.type);
			expect(issueTypes).toContain("missing_field");
		});

		it("should report invalid field types", () => {
			const wrongTypes = {
				id: 123, // Should be string
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: "not-array", // Should be array
				confidence: "0.5", // Should be number
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			const result = validateLearning(wrongTypes);
			expect(result.valid).toBe(false);
			expect(result.issues.length).toBeGreaterThan(0);
		});

		it("should report invalid category", () => {
			const invalidCategory = {
				id: "learn-123",
				taskId: "task-456",
				category: "invalid-category",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			const result = validateLearning(invalidCategory);
			expect(result.valid).toBe(false);

			const categoryIssue = result.issues.find((i) => i.type === "invalid_category");
			expect(categoryIssue).toBeDefined();
			expect(categoryIssue?.message).toContain("Invalid category");
		});

		it("should report confidence out of range", () => {
			const outOfRange = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 1.5, // Out of range
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			const result = validateLearning(outOfRange);
			expect(result.valid).toBe(false);

			const confidenceIssue = result.issues.find((i) => i.type === "invalid_confidence");
			expect(confidenceIssue).toBeDefined();
		});

		it("should report invalid date strings", () => {
			const invalidDate = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: "not-a-valid-date",
			};

			const result = validateLearning(invalidDate);
			expect(result.valid).toBe(false);

			const dateIssue = result.issues.find((i) => i.type === "invalid_date");
			expect(dateIssue).toBeDefined();
		});

		it("should report non-string keywords in array", () => {
			const nonStringKeywords = {
				id: "learn-123",
				taskId: "task-456",
				category: "pattern",
				content: "Test",
				keywords: ["valid", 123, "another"], // Mixed types
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			const result = validateLearning(nonStringKeywords);
			expect(result.valid).toBe(false);

			const keywordIssue = result.issues.find((i) => i.path.includes("keywords"));
			expect(keywordIssue).toBeDefined();
		});

		it("should include array index in validation path", () => {
			const invalid = {
				id: 123, // Invalid type
			};

			const result = validateLearning(invalid, 5);
			expect(result.valid).toBe(false);

			const issue = result.issues[0];
			expect(issue.path).toContain("learnings[5]");
		});
	});

	// ==========================================================================
	// Detailed Validation Tests: validateKnowledgeBase
	// ==========================================================================

	describe("validateKnowledgeBase", () => {
		it("should validate correct KnowledgeBase without issues", () => {
			const validKB: KnowledgeBase = {
				learnings: [
					{
						id: "learn-123",
						taskId: "task-456",
						category: "pattern",
						content: "Test",
						keywords: ["test"],
						confidence: 0.5,
						usedCount: 0,
						successCount: 0,
						createdAt: new Date().toISOString(),
					},
				],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};

			const result = validateKnowledgeBase(validKB);
			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});

		it("should validate empty KnowledgeBase", () => {
			const emptyKB: KnowledgeBase = {
				learnings: [],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};

			const result = validateKnowledgeBase(emptyKB);
			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});

		it("should accept KnowledgeBase without version/lastUpdated", () => {
			const oldKB = {
				learnings: [],
			};

			const result = validateKnowledgeBase(oldKB);
			expect(result.valid).toBe(true);
		});

		it("should report non-object root", () => {
			const result = validateKnowledgeBase("not-an-object");
			expect(result.valid).toBe(false);

			const issue = result.issues.find((i) => i.type === "invalid_structure");
			expect(issue).toBeDefined();
		});

		it("should report missing learnings array", () => {
			const noLearnings = {
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};

			const result = validateKnowledgeBase(noLearnings);
			expect(result.valid).toBe(false);

			const issue = result.issues.find((i) => i.path === "learnings");
			expect(issue).toBeDefined();
		});

		it("should validate all learnings in array", () => {
			const kbWithInvalidLearnings = {
				learnings: [
					{
						id: "learn-valid",
						taskId: "task-456",
						category: "pattern",
						content: "Valid",
						keywords: ["test"],
						confidence: 0.5,
						usedCount: 0,
						successCount: 0,
						createdAt: new Date().toISOString(),
					},
					{
						id: "learn-invalid",
						// Missing required fields
					},
					{
						id: "learn-another-invalid",
						taskId: "task",
						category: "invalid-category", // Invalid
						content: "Test",
						keywords: [],
						confidence: 0.5,
						usedCount: 0,
						successCount: 0,
						createdAt: new Date().toISOString(),
					},
				],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};

			const result = validateKnowledgeBase(kbWithInvalidLearnings);
			expect(result.valid).toBe(false);

			// Should have issues for both invalid learnings
			const learningIssues = result.issues.filter((i) => i.path.startsWith("learnings["));
			expect(learningIssues.length).toBeGreaterThan(0);
		});

		it("should report invalid version type as warning", () => {
			const wrongVersionType = {
				learnings: [],
				version: 123, // Should be string
				lastUpdated: new Date().toISOString(),
			};

			const result = validateKnowledgeBase(wrongVersionType);
			// Warnings don't make it invalid
			expect(result.valid).toBe(true);

			const warning = result.issues.find((i) => i.severity === "warning" && i.path === "version");
			expect(warning).toBeDefined();
		});

		it("should report invalid lastUpdated as warning", () => {
			const invalidLastUpdated = {
				learnings: [],
				version: "1.0",
				lastUpdated: "not-a-date",
			};

			const result = validateKnowledgeBase(invalidLastUpdated);
			// Warnings don't make it invalid
			expect(result.valid).toBe(true);

			const warning = result.issues.find((i) => i.severity === "warning" && i.type === "invalid_date");
			expect(warning).toBeDefined();
		});
	});

	// ==========================================================================
	// Format Validation Issues Tests
	// ==========================================================================

	describe("formatValidationIssues", () => {
		it("should return empty array for valid result", () => {
			const validResult = {
				valid: true,
				issues: [],
			};

			const formatted = formatValidationIssues(validResult);
			expect(formatted).toEqual([]);
		});

		it("should format errors", () => {
			const resultWithErrors = {
				valid: false,
				issues: [
					{
						type: "missing_field" as const,
						severity: "error" as const,
						message: "Missing id field",
						path: "learnings[0].id",
					},
					{
						type: "invalid_type" as const,
						severity: "error" as const,
						message: "Confidence out of range",
						path: "learnings[0].confidence",
					},
				],
			};

			const formatted = formatValidationIssues(resultWithErrors);
			expect(formatted.length).toBeGreaterThan(0);
			expect(formatted.some((line) => line.includes("✗"))).toBe(true);
			expect(formatted.some((line) => line.includes("Missing id field"))).toBe(true);
		});

		it("should format warnings", () => {
			const resultWithWarnings = {
				valid: true,
				issues: [
					{
						type: "invalid_type" as const,
						severity: "warning" as const,
						message: "Version should be string",
						path: "version",
					},
				],
			};

			const formatted = formatValidationIssues(resultWithWarnings);
			expect(formatted.length).toBeGreaterThan(0);
			expect(formatted.some((line) => line.includes("⚠"))).toBe(true);
		});

		it("should limit displayed errors to 10", () => {
			const manyErrors = {
				valid: false,
				issues: Array.from({ length: 15 }, (_, i) => ({
					type: "missing_field" as const,
					severity: "error" as const,
					message: `Error ${i}`,
					path: `learnings[${i}]`,
				})),
			};

			const formatted = formatValidationIssues(manyErrors);
			const errorLines = formatted.filter((line) => line.includes("✗"));
			expect(errorLines.length).toBeLessThanOrEqual(10);
			expect(formatted.some((line) => line.includes("... and 5 more errors"))).toBe(true);
		});
	});
});
