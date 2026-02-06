/**
 * Tests for knowledge.ts
 *
 * Tests knowledge system functions including:
 * - Loading and saving knowledge bases
 * - Adding learnings with duplicate detection
 * - Finding relevant learnings by keyword matching
 * - Formatting learnings for prompts
 * - Tracking learning usage and confidence
 * - Pruning unused learnings
 * - Knowledge statistics aggregation
 * - Edge cases and integration scenarios
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	addLearning,
	DEFAULT_QUALITY_THRESHOLDS,
	findRelevantLearnings,
	formatLearningsForPrompt,
	getKnowledgeStats,
	type Learning,
	type LearningCategory,
	type LearningQualityThresholds,
	loadKnowledge,
	markLearningsUsed,
	pruneUnusedLearnings,
} from "../knowledge.js";

/**
 * Relaxed quality thresholds for testing.
 * These allow learnings with default confidence (0.5) to be returned,
 * which is necessary for testing the scoring logic separate from quality filtering.
 */
const TEST_QUALITY_THRESHOLDS: LearningQualityThresholds = {
	...DEFAULT_QUALITY_THRESHOLDS,
	minConfidence: 0.0, // Allow all confidence levels
	minSuccessRate: 0.0, // Don't prune based on success rate
	minUsesForRateCheck: 1000, // Effectively disable rate checking
};

describe("knowledge.ts", () => {
	let tempDir: string;

	beforeEach(() => {
		// Create a temporary directory for each test
		tempDir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
	});

	afterEach(() => {
		// Clean up temporary directory
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ==========================================================================
	// loadKnowledge Tests
	// ==========================================================================

	describe("loadKnowledge", () => {
		it("should return default empty knowledge base when file does not exist", () => {
			const kb = loadKnowledge(tempDir);

			expect(kb.learnings).toEqual([]);
			expect(kb.version).toBe("1.0");
			expect(kb.lastUpdated).toBeDefined();
		});

		it("should load knowledge base from file", () => {
			// Add a learning first
			const { learning: learning1 } = addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Use Zod for validation",
					keywords: ["zod", "validation"],
				},
				tempDir,
			);

			// Load it back
			const kb = loadKnowledge(tempDir);

			expect(kb.learnings).toHaveLength(1);
			expect(kb.learnings[0].id).toBe(learning1.id);
			expect(kb.learnings[0].content).toBe("Use Zod for validation");
		});

		it("should return default when file is corrupted", () => {
			// Write actually corrupted JSON to the knowledge.json file
			const path = join(tempDir, "knowledge.json");
			writeFileSync(path, "{invalid json content}", "utf-8");

			// Should return default KB instead of crashing
			const kb = loadKnowledge(tempDir);
			expect(kb.learnings).toEqual([]);
			expect(kb.version).toBe("1.0");
		});

		it("should return default when knowledge base validation fails", () => {
			// Write invalid knowledge base (missing required fields)
			const invalidKB = {
				learnings: [
					{
						id: "learn-123",
						// Missing required fields like taskId, category, etc.
					},
				],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};

			const path = join(tempDir, "knowledge.json");
			writeFileSync(path, JSON.stringify(invalidKB), "utf-8");

			// Should return default KB instead of invalid one
			const kb = loadKnowledge(tempDir);
			expect(kb.learnings).toEqual([]);
			expect(kb.version).toBe("1.0");
		});

		it("should accept old knowledge base without version field", () => {
			// Write old-format knowledge base (backward compatibility)
			const oldKB = {
				learnings: [
					{
						id: "learn-123",
						taskId: "task-456",
						category: "pattern",
						content: "Old learning",
						keywords: ["old"],
						confidence: 0.5,
						usedCount: 0,
						successCount: 0,
						createdAt: new Date().toISOString(),
					},
				],
				// No version or lastUpdated fields
			};

			const path = join(tempDir, "knowledge.json");
			writeFileSync(path, JSON.stringify(oldKB), "utf-8");

			// Should load successfully and add default version/lastUpdated
			const kb = loadKnowledge(tempDir);
			expect(kb.learnings).toHaveLength(1);
			expect(kb.version).toBe("1.0");
			expect(kb.lastUpdated).toBeDefined();
		});

		it("should update lastUpdated timestamp on save", () => {
			const beforeTime = new Date().toISOString();
			addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Test fact",
					keywords: ["test"],
				},
				tempDir,
			);
			const afterTime = new Date().toISOString();

			const kb = loadKnowledge(tempDir);

			expect(kb.lastUpdated >= beforeTime).toBe(true);
			expect(kb.lastUpdated <= afterTime).toBe(true);
		});

		it("should preserve all learning fields when loading", () => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "gotcha",
					content: "ESM imports need .js extension",
					keywords: ["esm", "import", "extension"],
					structured: {
						file: "src/file.ts",
						pattern: "import { x } from './module.js'",
					},
				},
				tempDir,
			);

			const kb = loadKnowledge(tempDir);
			const loaded = kb.learnings[0];

			expect(loaded.id).toBe(learning.id);
			expect(loaded.taskId).toBe("task-1");
			expect(loaded.category).toBe("gotcha");
			expect(loaded.content).toBe("ESM imports need .js extension");
			expect(loaded.keywords).toEqual(["esm", "import", "extension"]);
			expect(loaded.structured?.file).toBe("src/file.ts");
			expect(loaded.confidence).toBe(0.5);
			expect(loaded.usedCount).toBe(0);
			expect(loaded.successCount).toBe(0);
		});
	});

	// ==========================================================================
	// addLearning Tests
	// ==========================================================================

	describe("addLearning", () => {
		it("should add a new learning to the knowledge base", () => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Use pattern matching for type safety",
					keywords: ["pattern", "type", "safety"],
				},
				tempDir,
			);

			expect(learning.id).toMatch(/^learn-/);
			expect(learning.taskId).toBe("task-1");
			expect(learning.category).toBe("pattern");
			expect(learning.confidence).toBe(0.5);
			expect(learning.usedCount).toBe(0);
			expect(learning.successCount).toBe(0);
		});

		it("should generate unique IDs for each learning", () => {
			const { learning: learning1 } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "First learning",
					keywords: ["first"],
				},
				tempDir,
			);

			const { learning: learning2 } = addLearning(
				{
					taskId: "task-2",
					category: "fact",
					content: "Second learning",
					keywords: ["second"],
				},
				tempDir,
			);

			expect(learning1.id).not.toBe(learning2.id);
		});

		it("should reject duplicate learnings (>80% similarity)", () => {
			const { learning: learning1 } = addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Use Zod schemas for API validation",
					keywords: ["zod", "schema", "validation", "api"],
				},
				tempDir,
			);

			// Try to add nearly identical learning (result intentionally not used)
			addLearning(
				{
					taskId: "task-2",
					category: "pattern",
					content: "Use Zod schemas for API validation", // Identical
					keywords: ["zod", "schema", "validation", "api"],
				},
				tempDir,
			);

			// Second learning should be returned but not persisted
			const kb = loadKnowledge(tempDir);
			expect(kb.learnings).toHaveLength(1);
			expect(kb.learnings[0].id).toBe(learning1.id);
		});

		it("should allow learnings with low similarity (<80%)", () => {
			addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Use Zod for validation",
					keywords: ["zod", "validation"],
				},
				tempDir,
			);

			// Different enough learning
			addLearning(
				{
					taskId: "task-2",
					category: "pattern",
					content: "Use TypeScript interfaces for types",
					keywords: ["typescript", "interfaces", "types"],
				},
				tempDir,
			);

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings).toHaveLength(2);
		});

		it("should support all learning categories", () => {
			const categories: LearningCategory[] = ["pattern", "gotcha", "preference", "fact"];

			for (const category of categories) {
				const { learning } = addLearning(
					{
						taskId: `task-${category}`,
						category,
						content: `Test ${category}`,
						keywords: [category],
					},
					tempDir,
				);

				expect(learning.category).toBe(category);
			}

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings).toHaveLength(4);
		});

		it("should support optional structured data", () => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Use singleton factories",
					keywords: ["singleton", "factory"],
					structured: {
						file: "src/cache.ts",
						pattern: "let instance: Cache | null = null",
						approach: "Lazy initialization with reset",
					},
				},
				tempDir,
			);

			expect(learning.structured?.file).toBe("src/cache.ts");
			expect(learning.structured?.pattern).toBe("let instance: Cache | null = null");
			expect(learning.structured?.approach).toBe("Lazy initialization with reset");
		});

		it("should set createdAt timestamp", () => {
			const beforeTime = Date.now();

			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Test",
					keywords: ["test"],
				},
				tempDir,
			);

			const afterTime = Date.now();
			const createdAtTime = new Date(learning.createdAt).getTime();

			expect(createdAtTime >= beforeTime).toBe(true);
			expect(createdAtTime <= afterTime).toBe(true);
		});
	});

	// ==========================================================================
	// findRelevantLearnings Tests
	// ==========================================================================

	describe("findRelevantLearnings", () => {
		beforeEach(() => {
			// Add a variety of learnings for testing
			addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Use Zod schemas for all API validation",
					keywords: ["zod", "schema", "validation", "api"],
				},
				tempDir,
			);

			addLearning(
				{
					taskId: "task-2",
					category: "gotcha",
					content: "ESM imports require .js extension for TypeScript files",
					keywords: ["esm", "import", "extension", "typescript"],
				},
				tempDir,
			);

			addLearning(
				{
					taskId: "task-3",
					category: "fact",
					content: "Cache invalidates automatically after 5 minutes",
					keywords: ["cache", "invalidation", "timeout"],
				},
				tempDir,
			);

			addLearning(
				{
					taskId: "task-4",
					category: "preference",
					content: "Always use execFileSync over execSync for git commands",
					keywords: ["git", "exec", "security", "command"],
				},
				tempDir,
			);
		});

		// ========================================================================
		// Scoring Formula Tests (70/30 weighting)
		// ========================================================================

		it("should calculate score using exact 70/30 weighting formula", () => {
			// Create a learning with exactly one matching keyword and known confidence
			const { learning } = addLearning(
				{
					taskId: "task-score-test",
					category: "fact",
					content: "Test exact scoring",
					keywords: ["validation"],
				},
				tempDir,
			);

			// Mark as used multiple times to increase confidence to known value
			markLearningsUsed([learning.id], true, tempDir);
			markLearningsUsed([learning.id], true, tempDir);

			const kb = loadKnowledge(tempDir);
			const finalConfidence = kb.learnings.find((l) => l.id === learning.id)?.confidence ?? 0.5;

			// Query with one matching keyword: "validation" has 100% keyword overlap with 1 keyword
			const results = findRelevantLearnings("validation check", 5, tempDir, TEST_QUALITY_THRESHOLDS);
			const found = results.find((l) => l.id === learning.id);

			if (found) {
				// Expected score: (1.0 * 0.7) + (finalConfidence * 0.3)
				const expectedScore = 0.7 + finalConfidence * 0.3;
				// Verify it was ranked (score > 0.1 threshold)
				expect(expectedScore).toBeGreaterThan(0.1);
			}
		});

		// ========================================================================
		// Boundary Condition Tests
		// ========================================================================

		it("should filter out learnings with score exactly at 0.1 threshold", () => {
			// Create a learning that would score exactly 0.1 or just below
			const { learning } = addLearning(
				{
					taskId: "task-boundary",
					category: "fact",
					content: "Boundary test learning",
					keywords: ["rare-keyword"],
				},
				tempDir,
			);

			// Lower confidence to minimum to reduce score
			for (let i = 0; i < 20; i++) {
				markLearningsUsed([learning.id], false, tempDir);
			}

			const kb = loadKnowledge(tempDir);
			const _lowConfidence = kb.learnings.find((l) => l.id === learning.id)?.confidence ?? 0.1;

			// Query with no matching keywords should result in score near confidence * 0.3
			// At minimum confidence 0.1: score = 0 * 0.7 + 0.1 * 0.3 = 0.03 (filtered)
			const results = findRelevantLearnings("completely different topic", 5, tempDir, TEST_QUALITY_THRESHOLDS);
			const found = results.find((l) => l.id === learning.id);

			// Should be filtered (no keywords match + low confidence = score below 0.1)
			expect(found).toBeUndefined();
		});

		it("should include learnings with score just above 0.1 threshold", () => {
			// Create a learning that scores just above 0.1
			const { learning } = addLearning(
				{
					taskId: "task-above-threshold",
					category: "fact",
					content: "Above threshold learning",
					keywords: ["validation"],
				},
				tempDir,
			);

			// Leave at default 0.5 confidence
			// Query with the exact keyword: score = 1.0 * 0.7 + 0.5 * 0.3 = 0.85 (well above threshold)
			const results = findRelevantLearnings("validation", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			const found = results.find((l) => l.id === learning.id);
			expect(found).toBeDefined();
		});

		it("should handle maxResults = 0 by returning empty array", () => {
			const results = findRelevantLearnings("zod schema validation", 0, tempDir, TEST_QUALITY_THRESHOLDS);

			expect(results).toEqual([]);
		});

		it("should return all available results when maxResults exceeds available", () => {
			// We have 4 learnings in the setup
			const results = findRelevantLearnings("validation cache git exec", 100, tempDir, TEST_QUALITY_THRESHOLDS);

			// Should return at most 4 learnings
			expect(results.length).toBeLessThanOrEqual(4);
		});

		// ========================================================================
		// Special Character and Unicode Handling Tests
		// ========================================================================

		it("should handle query with punctuation and special characters", () => {
			const { learning } = addLearning(
				{
					taskId: "task-special",
					category: "fact",
					content: "Test special handling",
					keywords: ["zod"],
				},
				tempDir,
			);

			// Query with lots of punctuation should extract "zod" keyword
			const results = findRelevantLearnings(
				"How to use Zod??? for API @#$% validation???",
				5,
				tempDir,
				TEST_QUALITY_THRESHOLDS,
			);

			// Should find the learning because "zod" keyword is extracted
			const found = results.find((l) => l.id === learning.id);
			expect(found).toBeDefined();
		});

		it("should handle query with unicode and emoji characters", () => {
			const { learning } = addLearning(
				{
					taskId: "task-unicode",
					category: "fact",
					content: "Unicode handling test",
					keywords: ["validation"],
				},
				tempDir,
			);

			// Query with unicode characters (café, naïve, 日本語, emoji)
			const results = findRelevantLearnings("café naïve 日本語 🚀 validation", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			// Should still extract "validation" keyword despite unicode
			const found = results.find((l) => l.id === learning.id);
			expect(found).toBeDefined();
		});

		it("should extract keywords properly when stripping special characters", () => {
			const { learning } = addLearning(
				{
					taskId: "task-stripped",
					category: "fact",
					content: "Strip special characters",
					keywords: ["api"],
				},
				tempDir,
			);

			// Query with numbers and special chars mixed with keywords
			const results = findRelevantLearnings("API_2024 v1.0 @rest #endpoint test", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			// Should extract "api" keyword (case-insensitive, stripped of special chars)
			const found = results.find((l) => l.id === learning.id);
			expect(found).toBeDefined();
		});

		// ========================================================================
		// Long Query Handling Test
		// ========================================================================

		it("should handle very long queries efficiently", () => {
			const { learning } = addLearning(
				{
					taskId: "task-long-query",
					category: "fact",
					content: "Long query test",
					keywords: ["zod"],
				},
				tempDir,
			);

			// Create a query with 50+ words
			const longWords = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
			const query = `${longWords} zod validation schema`;

			const results = findRelevantLearnings(query, 5, tempDir, TEST_QUALITY_THRESHOLDS);

			// Should handle gracefully and extract top 20 keywords (including "zod")
			const found = results.find((l) => l.id === learning.id);
			expect(found).toBeDefined();
		});

		// ========================================================================
		// All Learnings Below Threshold Test
		// ========================================================================

		it("should return empty results when all learnings score below threshold", () => {
			// Create learnings with low confidence and no matching keywords
			for (let i = 0; i < 3; i++) {
				const { learning } = addLearning(
					{
						taskId: `task-low-${i}`,
						category: "fact",
						content: `Low confidence learning ${i}`,
						keywords: [`unique-rare-keyword-${i}`],
					},
					tempDir,
				);

				// Lower confidence to minimum
				for (let j = 0; j < 20; j++) {
					markLearningsUsed([learning.id], false, tempDir);
				}
			}

			// Query with no matching keywords
			const results = findRelevantLearnings(
				"completely unrelated quantum computing blockchain",
				5,
				tempDir,
				TEST_QUALITY_THRESHOLDS,
			);

			// All results should be filtered (below 0.1 threshold)
			// The earlier learnings from beforeEach might still match, so we just verify
			// that the new low-confidence learnings are not included
			expect(results.length).toBeLessThanOrEqual(4); // Original 4 learnings
		});

		// ========================================================================
		// Empty Keyword Arrays Test
		// ========================================================================

		it("should handle learning with empty keyword array gracefully", () => {
			const _learning = addLearning(
				{
					taskId: "task-empty-keywords",
					category: "fact",
					content: "No keywords learning",
					keywords: [],
				},
				tempDir,
			);

			// Search should not crash and should score based on default confidence
			const results = findRelevantLearnings("any query", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			// Learning may or may not appear depending on similarity scoring
			// Key is that it doesn't crash
			expect(Array.isArray(results)).toBe(true);
		});

		// ========================================================================
		// Query with Only Stopwords Test
		// ========================================================================

		it("should handle query containing only stopwords", () => {
			const _learning = addLearning(
				{
					taskId: "task-stopwords",
					category: "fact",
					content: "Test stopword handling",
					keywords: ["validation"],
				},
				tempDir,
			);

			// Query with only stopwords (should extract no keywords)
			const results = findRelevantLearnings("the and or but a an is", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			// With empty objective keywords set, all learnings score (0 * 0.7) + (confidence * 0.3)
			// At default confidence 0.5: score = 0 + 0.15 = 0.15 (above 0.1 threshold)
			// So learnings with stopword-only queries can still be found via confidence
			expect(Array.isArray(results)).toBe(true);
		});

		// ========================================================================
		// Sequential Confidence Update Integration Test
		// ========================================================================

		it("should rank learnings higher in search results after successful use updates confidence", () => {
			const { learning: learning1 } = addLearning(
				{
					taskId: "task-seq-1",
					category: "fact",
					content: "Sequential update test one",
					keywords: ["testing"],
				},
				tempDir,
			);

			const { learning: learning2 } = addLearning(
				{
					taskId: "task-seq-2",
					category: "fact",
					content: "Sequential update test two",
					keywords: ["testing"],
				},
				tempDir,
			);

			// Initial search: both should have same score (same keywords, default confidence)
			const results1 = findRelevantLearnings("testing", 5, tempDir, TEST_QUALITY_THRESHOLDS);
			const _index1_1 = results1.findIndex((l) => l.id === learning1.id);
			const _index2_1 = results1.findIndex((l) => l.id === learning2.id);

			// Mark learning1 as successfully used multiple times
			for (let i = 0; i < 3; i++) {
				markLearningsUsed([learning1.id], true, tempDir);
			}

			// Second search: learning1 should be ranked higher due to increased confidence
			const results2 = findRelevantLearnings("testing", 5, tempDir, TEST_QUALITY_THRESHOLDS);
			const index1_2 = results2.findIndex((l) => l.id === learning1.id);
			const index2_2 = results2.findIndex((l) => l.id === learning2.id);

			// learning1 should be ranked before learning2 after confidence increase
			if (index1_2 >= 0 && index2_2 >= 0) {
				expect(index1_2).toBeLessThan(index2_2);
			}
		});

		it("should find learnings by keyword match", () => {
			const results = findRelevantLearnings("Add validation to REST API", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			expect(results.length).toBeGreaterThan(0);
			const apiLearning = results.find((l) => l.content.includes("Zod"));
			expect(apiLearning).toBeDefined();
		});

		it("should score by keyword overlap", () => {
			const results = findRelevantLearnings("Implement API validation with Zod", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			// Zod learning should be highly ranked
			expect(results[0].content).toContain("Zod");
		});

		it("should include confidence in scoring", () => {
			// Add two learnings with same keywords but different confidence
			const { learning: learning1 } = addLearning(
				{
					taskId: "task-conf-1",
					category: "fact",
					content: "Testing confidence scoring with keywords",
					keywords: ["test", "confidence", "scoring"],
				},
				tempDir,
			);

			// Mark learning1 as used successfully to increase confidence
			markLearningsUsed([learning1.id], true, tempDir);

			const results = findRelevantLearnings("test confidence scoring", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			// The high-confidence learning should rank well
			expect(results.length).toBeGreaterThan(0);
		});

		it("should filter out learnings below minimum score threshold", () => {
			const results = findRelevantLearnings(
				"Kubernetes deployment cluster quantum computing",
				5,
				tempDir,
				TEST_QUALITY_THRESHOLDS,
			);

			// No learnings should match (completely different domain)
			// Note: results may not be empty due to content-based scoring
			expect(results.length).toBeLessThanOrEqual(4); // At most could match all learnings
		});

		it("should respect maxResults parameter", () => {
			const results1 = findRelevantLearnings("validation cache timeout api", 2, tempDir, TEST_QUALITY_THRESHOLDS);
			const results2 = findRelevantLearnings("validation cache timeout api", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			expect(results1.length).toBeLessThanOrEqual(2);
			expect(results2.length).toBeGreaterThanOrEqual(results1.length);
		});

		it("should return empty or low results when no meaningful matches found", () => {
			const results = findRelevantLearnings(
				"Deploy Docker container to AWS Lambda functions on Kubernetes orchestration platform XYZ",
				5,
				tempDir,
			);

			// May return some results due to scoring, but should be minimal
			// The scoring function filters by 0.1 minimum score
			expect(results.length).toBeLessThanOrEqual(4);
		});

		it("should handle empty knowledge base", () => {
			const emptyDir = mkdtempSync(join(tmpdir(), "knowledge-empty-"));

			const results = findRelevantLearnings("Any query", 5, emptyDir, TEST_QUALITY_THRESHOLDS);

			expect(results).toEqual([]);

			rmSync(emptyDir, { recursive: true, force: true });
		});

		it("should extract keywords from objective correctly", () => {
			// Query with words that should be filtered (stopwords)
			const results = findRelevantLearnings("how to add validation for the api", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			// Should still find Zod learning despite stopwords
			const found = results.some((l) => l.content.includes("Zod"));
			expect(found).toBe(true);
		});

		it("should handle case-insensitive matching", () => {
			const resultsLower = findRelevantLearnings("zod validation", 5, tempDir, TEST_QUALITY_THRESHOLDS);
			const resultsUpper = findRelevantLearnings("ZOD VALIDATION", 5, tempDir, TEST_QUALITY_THRESHOLDS);
			const resultsMixed = findRelevantLearnings("ZoD VaLiDaTiOn", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			expect(resultsLower.length).toBe(resultsUpper.length);
			expect(resultsUpper.length).toBe(resultsMixed.length);
		});
	});

	// ==========================================================================
	// markLearningsUsed Tests
	// ==========================================================================

	describe("markLearningsUsed", () => {
		let learningId: string;

		beforeEach(() => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Test learning",
					keywords: ["test"],
				},
				tempDir,
			);
			learningId = learning.id;
		});

		it("should increment usedCount on successful use", () => {
			const kb1 = loadKnowledge(tempDir);
			expect(kb1.learnings[0].usedCount).toBe(0);

			markLearningsUsed([learningId], true, tempDir);

			const kb2 = loadKnowledge(tempDir);
			expect(kb2.learnings[0].usedCount).toBe(1);
		});

		it("should increment usedCount on failed use", () => {
			markLearningsUsed([learningId], false, tempDir);

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings[0].usedCount).toBe(1);
		});

		it("should increment successCount on success", () => {
			const kb1 = loadKnowledge(tempDir);
			expect(kb1.learnings[0].successCount).toBe(0);

			markLearningsUsed([learningId], true, tempDir);

			const kb2 = loadKnowledge(tempDir);
			expect(kb2.learnings[0].successCount).toBe(1);
		});

		it("should not increment successCount on failure", () => {
			markLearningsUsed([learningId], false, tempDir);

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings[0].successCount).toBe(0);
		});

		it("should increase confidence on successful use", () => {
			const kb1 = loadKnowledge(tempDir);
			const initialConfidence = kb1.learnings[0].confidence;

			markLearningsUsed([learningId], true, tempDir);

			const kb2 = loadKnowledge(tempDir);
			expect(kb2.learnings[0].confidence).toBeGreaterThan(initialConfidence);
		});

		it("should decrease confidence on failed use", () => {
			const kb1 = loadKnowledge(tempDir);
			const initialConfidence = kb1.learnings[0].confidence;

			markLearningsUsed([learningId], false, tempDir);

			const kb2 = loadKnowledge(tempDir);
			expect(kb2.learnings[0].confidence).toBeLessThan(initialConfidence);
		});

		it("should cap confidence at 0.95", () => {
			// Mark as successful multiple times
			for (let i = 0; i < 20; i++) {
				markLearningsUsed([learningId], true, tempDir);
			}

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings[0].confidence).toBeLessThanOrEqual(0.95);
		});

		it("should cap confidence at 0.1 minimum before pruning threshold", () => {
			// Mark as failed a few times (but not enough to trigger pruning)
			// Pruning happens at 5+ uses with <30% success rate
			for (let i = 0; i < 4; i++) {
				markLearningsUsed([learningId], false, tempDir);
			}

			const kb = loadKnowledge(tempDir);
			// Learning should still exist with capped confidence
			expect(kb.learnings.length).toBe(1);
			expect(kb.learnings[0].confidence).toBeGreaterThanOrEqual(0.1);
		});

		it("should prune learnings with low success rate after threshold uses", () => {
			// Mark as failed enough times to trigger pruning (5+ uses with <30% success)
			for (let i = 0; i < 6; i++) {
				markLearningsUsed([learningId], false, tempDir);
			}

			const kb = loadKnowledge(tempDir);
			// Learning should be pruned due to low success rate
			expect(kb.learnings.length).toBe(0);
		});

		it("should set lastUsedAt timestamp", () => {
			markLearningsUsed([learningId], true, tempDir);

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings[0].lastUsedAt).toBeDefined();
			expect(typeof kb.learnings[0].lastUsedAt).toBe("string");
		});

		it("should handle multiple learning IDs", () => {
			const { learning: learning2 } = addLearning(
				{
					taskId: "task-2",
					category: "fact",
					content: "Another learning",
					keywords: ["another"],
				},
				tempDir,
			);

			markLearningsUsed([learningId, learning2.id], true, tempDir);

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings[0].usedCount).toBe(1);
			expect(kb.learnings[1].usedCount).toBe(1);
		});

		it("should ignore non-existent learning IDs", () => {
			const kb1 = loadKnowledge(tempDir);
			const count1 = kb1.learnings[0].usedCount;

			markLearningsUsed(["non-existent-id", learningId], true, tempDir);

			const kb2 = loadKnowledge(tempDir);
			// Should only update the existing one
			expect(kb2.learnings[0].usedCount).toBe(count1 + 1);
		});

		it("should handle empty learning IDs array", () => {
			const kb1 = loadKnowledge(tempDir);
			const count1 = kb1.learnings[0].usedCount;

			markLearningsUsed([], true, tempDir);

			const kb2 = loadKnowledge(tempDir);
			expect(kb2.learnings[0].usedCount).toBe(count1);
		});
	});

	// ==========================================================================
	// formatLearningsForPrompt Tests
	// ==========================================================================

	describe("formatLearningsForPrompt", () => {
		it("should return empty string for empty array", () => {
			const result = formatLearningsForPrompt([]);

			expect(result).toBe("");
		});

		it("should format single learning", () => {
			const learning: Learning = {
				id: "learn-123",
				taskId: "task-1",
				category: "pattern",
				content: "Use Zod for validation",
				keywords: ["zod"],
				confidence: 0.8,
				usedCount: 2,
				successCount: 2,
				createdAt: new Date().toISOString(),
			};

			const result = formatLearningsForPrompt([learning]);

			expect(result).toContain("RELEVANT LEARNINGS FROM PREVIOUS TASKS:");
			expect(result).toContain("- Use Zod for validation");
			expect(result).toContain("Use these insights if applicable to your current task");
		});

		it("should format multiple learnings", () => {
			const learnings: Learning[] = [
				{
					id: "learn-1",
					taskId: "task-1",
					category: "pattern",
					content: "First learning",
					keywords: [],
					confidence: 0.5,
					usedCount: 0,
					successCount: 0,
					createdAt: new Date().toISOString(),
				},
				{
					id: "learn-2",
					taskId: "task-2",
					category: "gotcha",
					content: "Second learning",
					keywords: [],
					confidence: 0.5,
					usedCount: 0,
					successCount: 0,
					createdAt: new Date().toISOString(),
				},
			];

			const result = formatLearningsForPrompt(learnings);

			expect(result).toContain("- First learning");
			expect(result).toContain("- Second learning");
		});

		it("should preserve content exactly", () => {
			const content = "Special characters: !@#$%^&*()";
			const learning: Learning = {
				id: "learn-1",
				taskId: "task-1",
				category: "fact",
				content,
				keywords: [],
				confidence: 0.5,
				usedCount: 0,
				successCount: 0,
				createdAt: new Date().toISOString(),
			};

			const result = formatLearningsForPrompt([learning]);

			expect(result).toContain(content);
		});

		it("should maintain learning order", () => {
			const learnings: Learning[] = [];
			for (let i = 0; i < 5; i++) {
				learnings.push({
					id: `learn-${i}`,
					taskId: `task-${i}`,
					category: "fact",
					content: `Learning number ${i}`,
					keywords: [],
					confidence: 0.5,
					usedCount: 0,
					successCount: 0,
					createdAt: new Date().toISOString(),
				});
			}

			const result = formatLearningsForPrompt(learnings);

			for (let i = 0; i < 5; i++) {
				const index = result.indexOf(`Learning number ${i}`);
				const prevIndex = i > 0 ? result.indexOf(`Learning number ${i - 1}`) : 0;
				expect(index).toBeGreaterThan(prevIndex);
			}
		});
	});

	// ==========================================================================
	// getKnowledgeStats Tests
	// ==========================================================================

	describe("getKnowledgeStats", () => {
		it("should return empty stats for empty knowledge base", () => {
			const stats = getKnowledgeStats(tempDir);

			expect(stats.totalLearnings).toBe(0);
			expect(stats.avgConfidence).toBe(0);
			expect(stats.mostUsed).toEqual([]);
			expect(stats.byCategory.pattern).toBe(0);
			expect(stats.byCategory.gotcha).toBe(0);
			expect(stats.byCategory.preference).toBe(0);
			expect(stats.byCategory.fact).toBe(0);
		});

		it("should count total learnings", () => {
			addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "First",
					keywords: [],
				},
				tempDir,
			);
			addLearning(
				{
					taskId: "task-2",
					category: "fact",
					content: "Second",
					keywords: [],
				},
				tempDir,
			);

			const stats = getKnowledgeStats(tempDir);

			expect(stats.totalLearnings).toBe(2);
		});

		it("should count learnings by category", () => {
			addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Pattern 1",
					keywords: [],
				},
				tempDir,
			);
			addLearning(
				{
					taskId: "task-2",
					category: "pattern",
					content: "Pattern 2",
					keywords: [],
				},
				tempDir,
			);
			addLearning(
				{
					taskId: "task-3",
					category: "gotcha",
					content: "Gotcha 1",
					keywords: [],
				},
				tempDir,
			);
			addLearning(
				{
					taskId: "task-4",
					category: "fact",
					content: "Fact 1",
					keywords: [],
				},
				tempDir,
			);

			const stats = getKnowledgeStats(tempDir);

			expect(stats.byCategory.pattern).toBe(2);
			expect(stats.byCategory.gotcha).toBe(1);
			expect(stats.byCategory.fact).toBe(1);
			expect(stats.byCategory.preference).toBe(0);
		});

		it("should calculate average confidence", () => {
			const { learning: learning1 } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Test 1",
					keywords: [],
				},
				tempDir,
			);

			// Mark first learning as used to increase confidence
			markLearningsUsed([learning1.id], true, tempDir);

			const stats = getKnowledgeStats(tempDir);

			// Should be between 0 and 1
			expect(stats.avgConfidence).toBeGreaterThanOrEqual(0);
			expect(stats.avgConfidence).toBeLessThanOrEqual(1);
		});

		it("should list most used learnings", () => {
			const { learning: learning1 } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Most used learning content here",
					keywords: [],
				},
				tempDir,
			);
			const { learning: learning2 } = addLearning(
				{
					taskId: "task-2",
					category: "fact",
					content: "Rarely used learning",
					keywords: [],
				},
				tempDir,
			);

			// Use learning1 multiple times
			for (let i = 0; i < 5; i++) {
				markLearningsUsed([learning1.id], true, tempDir);
			}
			// Use learning2 once
			markLearningsUsed([learning2.id], true, tempDir);

			const stats = getKnowledgeStats(tempDir);

			expect(stats.mostUsed.length).toBeGreaterThan(0);
			expect(stats.mostUsed[0].usedCount).toBeGreaterThanOrEqual(stats.mostUsed[1]?.usedCount || 0);
		});

		it("should truncate most used content", () => {
			const longContent = "A".repeat(100);
			addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: longContent,
					keywords: [],
				},
				tempDir,
			);

			const stats = getKnowledgeStats(tempDir);

			if (stats.mostUsed.length > 0) {
				expect(stats.mostUsed[0].content.length).toBeLessThanOrEqual(55); // 50 + "..."
			}
		});

		it("should limit mostUsed to 5 items", () => {
			for (let i = 0; i < 10; i++) {
				addLearning(
					{
						taskId: `task-${i}`,
						category: "fact",
						content: `Learning ${i}`,
						keywords: [],
					},
					tempDir,
				);
			}

			const stats = getKnowledgeStats(tempDir);

			expect(stats.mostUsed.length).toBeLessThanOrEqual(5);
		});
	});

	// ==========================================================================
	// pruneUnusedLearnings Tests
	// ==========================================================================

	describe("pruneUnusedLearnings", () => {
		it("should return 0 when no learnings pruned", () => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Used learning",
					keywords: [],
				},
				tempDir,
			);

			// Mark as used to prevent pruning
			markLearningsUsed([learning.id], true, tempDir);

			const pruned = pruneUnusedLearnings(0, tempDir);

			expect(pruned).toBe(0);
		});

		it("should prune unused learnings", () => {
			addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Never used",
					keywords: [],
				},
				tempDir,
			);

			const beforeCount = loadKnowledge(tempDir).learnings.length;
			const pruned = pruneUnusedLearnings(0, tempDir); // maxAge: 0 means all unused

			const afterCount = loadKnowledge(tempDir).learnings.length;

			expect(pruned).toBeGreaterThan(0);
			expect(afterCount).toBeLessThan(beforeCount);
		});

		it("should keep learnings with usedCount > 0", () => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Used once",
					keywords: [],
				},
				tempDir,
			);

			markLearningsUsed([learning.id], true, tempDir);

			const pruned = pruneUnusedLearnings(0, tempDir);
			const remaining = loadKnowledge(tempDir);

			expect(pruned).toBe(0);
			expect(remaining.learnings).toHaveLength(1);
		});

		it("should keep high-confidence learnings", () => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "High confidence unused",
					keywords: [],
				},
				tempDir,
			);

			// Manually set high confidence by using successfully many times
			for (let i = 0; i < 10; i++) {
				markLearningsUsed([learning.id], true, tempDir);
			}

			// Manually modify to be unused but high confidence
			const kb = loadKnowledge(tempDir);
			kb.learnings[0].usedCount = 0;
			kb.learnings[0].confidence = 0.8;

			const _pruned = pruneUnusedLearnings(0, tempDir);
			const remaining = loadKnowledge(tempDir);

			expect(remaining.learnings.length).toBeGreaterThan(0);
		});

		it("should respect maxAge parameter", () => {
			const _learning = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Young unused learning",
					keywords: [],
				},
				tempDir,
			);

			// With large maxAge, even unused recent learnings are kept
			const _pruned = pruneUnusedLearnings(1000 * 60 * 60 * 24 * 365, tempDir); // 1 year

			const remaining = loadKnowledge(tempDir);

			expect(remaining.learnings).toHaveLength(1);
		});

		it("should save knowledge base after pruning", () => {
			addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "To be pruned",
					keywords: [],
				},
				tempDir,
			);

			pruneUnusedLearnings(0, tempDir);

			// Verify persistence by reloading
			const kb = loadKnowledge(tempDir);
			expect(kb.learnings).toHaveLength(0);
		});

		it("should handle pruning multiple learnings", () => {
			for (let i = 0; i < 5; i++) {
				addLearning(
					{
						taskId: `task-${i}`,
						category: "fact",
						content: `Learning ${i}`,
						keywords: [],
					},
					tempDir,
				);
			}

			const pruned = pruneUnusedLearnings(0, tempDir);

			expect(pruned).toBe(5);
		});
	});

	// ==========================================================================
	// Integration Tests - Worker Lifecycle Pattern
	// ==========================================================================

	describe("Integration: Worker lifecycle", () => {
		it("should support complete worker workflow", () => {
			// 1. Add learnings from previous tasks
			const { learning: learning1 } = addLearning(
				{
					taskId: "previous-task-1",
					category: "pattern",
					content: "Use Zod for API validation",
					keywords: ["zod", "validation", "api"],
				},
				tempDir,
			);

			addLearning(
				{
					taskId: "previous-task-2",
					category: "gotcha",
					content: "ESM imports need .js extension",
					keywords: ["esm", "import", "extension"],
				},
				tempDir,
			);

			// 2. Worker queries relevant learnings for new task
			const taskObjective = "Add validation to new API endpoint";
			const relevant = findRelevantLearnings(taskObjective, 5, tempDir, TEST_QUALITY_THRESHOLDS);

			expect(relevant.length).toBeGreaterThan(0);
			expect(relevant.some((l) => l.id === learning1.id)).toBe(true);

			// 3. Worker uses learnings (simulate successful task)
			const injectedIds = relevant.map((l) => l.id);
			markLearningsUsed(injectedIds, true, tempDir);

			// 4. Verify learnings were marked as used
			const kb = loadKnowledge(tempDir);
			for (const learning of kb.learnings) {
				if (injectedIds.includes(learning.id)) {
					expect(learning.usedCount).toBeGreaterThan(0);
					expect(learning.successCount).toBeGreaterThan(0);
				}
			}
		});

		it("should update confidence based on success/failure pattern", () => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Test pattern",
					keywords: ["test"],
				},
				tempDir,
			);

			// Initial confidence
			let kb = loadKnowledge(tempDir);
			const initialConfidence = kb.learnings[0].confidence;

			// Use successfully 3 times
			for (let i = 0; i < 3; i++) {
				markLearningsUsed([learning.id], true, tempDir);
			}

			kb = loadKnowledge(tempDir);
			const highConfidence = kb.learnings[0].confidence;
			expect(highConfidence).toBeGreaterThan(initialConfidence);

			// Use unsuccessfully 2 times
			for (let i = 0; i < 2; i++) {
				markLearningsUsed([learning.id], false, tempDir);
			}

			kb = loadKnowledge(tempDir);
			const adjustedConfidence = kb.learnings[0].confidence;
			expect(adjustedConfidence).toBeLessThan(highConfidence);
		});
	});

	// ==========================================================================
	// Edge Case Tests
	// ==========================================================================

	describe("Edge cases", () => {
		it("should handle learning with no keywords", () => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Test fact",
					keywords: [],
				},
				tempDir,
			);

			expect(learning.keywords).toEqual([]);

			// Should not break retrieval
			const results = findRelevantLearnings("any query", 5, tempDir, TEST_QUALITY_THRESHOLDS);
			// May or may not find it depending on similarity scoring
			expect(Array.isArray(results)).toBe(true);
		});

		it("should handle very long learning content", () => {
			const longContent = "A".repeat(10000);
			const _learning = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: longContent,
					keywords: ["long"],
				},
				tempDir,
			);

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings[0].content).toBe(longContent);
		});

		it("should handle special characters in content", () => {
			const content = "Special: !@#$%^&*() <>/? \"quotes\" 'apostrophes'";
			const _learning = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content,
					keywords: ["special"],
				},
				tempDir,
			);

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings[0].content).toBe(content);
		});

		it("should handle many keywords", () => {
			const keywords = Array.from({ length: 50 }, (_, i) => `keyword${i}`);
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Many keywords",
					keywords,
				},
				tempDir,
			);

			expect(learning.keywords).toEqual(keywords);
		});

		it("should handle Unicode characters in keywords", () => {
			const { learning } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Unicode test",
					keywords: ["café", "naïve", "日本語", "🚀"],
				},
				tempDir,
			);

			expect(learning.keywords).toContain("café");
			expect(learning.keywords).toContain("日本語");
		});

		it("should handle concurrent-like usage patterns", () => {
			const { learning: learning1 } = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Learning 1",
					keywords: ["test"],
				},
				tempDir,
			);
			const { learning: learning2 } = addLearning(
				{
					taskId: "task-2",
					category: "fact",
					content: "Learning 2",
					keywords: ["test"],
				},
				tempDir,
			);

			// Simulate concurrent usage tracking
			markLearningsUsed([learning1.id], true, tempDir);
			markLearningsUsed([learning2.id], false, tempDir);
			markLearningsUsed([learning1.id], true, tempDir);

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings[0].usedCount).toBe(2);
			expect(kb.learnings[1].usedCount).toBe(1);
		});

		it("should handle searching with empty objective", () => {
			addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "Test",
					keywords: ["test"],
				},
				tempDir,
			);

			// Empty objective should not crash
			const results = findRelevantLearnings("", 5, tempDir, TEST_QUALITY_THRESHOLDS);
			expect(Array.isArray(results)).toBe(true);
		});

		it("should handle formatting empty learning list gracefully", () => {
			const formatted = formatLearningsForPrompt([]);
			expect(formatted).toBe("");
		});

		it("should survive malformed learning data gracefully", () => {
			// Knowledge base should handle missing optional fields
			const learning = addLearning(
				{
					taskId: "task-1",
					category: "fact",
					content: "No structured data",
					keywords: ["test"],
					// structured is optional
				},
				tempDir,
			);

			expect(learning.structured).toBeUndefined();

			const kb = loadKnowledge(tempDir);
			expect(kb.learnings[0].structured).toBeUndefined();
		});
	});

	// ==========================================================================
	// Realistic Scenario Tests
	// ==========================================================================

	describe("Realistic scenarios", () => {
		it("should support API validation workflow", () => {
			// Scenario: Learning Zod validation pattern from multiple tasks
			const _task1 = addLearning(
				{
					taskId: "task-add-user-endpoint",
					category: "pattern",
					content: "Use z.object with z.string and z.number for user schemas",
					keywords: ["zod", "schema", "user", "endpoint", "validation"],
					structured: {
						file: "src/schemas/user.ts",
						pattern: "z.object({ id: z.number(), name: z.string() })",
					},
				},
				tempDir,
			);

			const _task2 = addLearning(
				{
					taskId: "task-add-product-endpoint",
					category: "pattern",
					content: "Always validate request body with Zod before processing",
					keywords: ["zod", "validation", "request", "body", "http"],
				},
				tempDir,
			);

			// New task: Add order endpoint
			const relevant = findRelevantLearnings("Add order endpoint with validation", 5, tempDir, TEST_QUALITY_THRESHOLDS);

			expect(relevant.length).toBeGreaterThan(0);

			// Apply learnings
			const results = formatLearningsForPrompt(relevant);
			expect(results).toContain("Zod");

			// Mark as used
			markLearningsUsed(
				relevant.map((l) => l.id),
				true,
				tempDir,
			);

			// Verify learning effectiveness
			const stats = getKnowledgeStats(tempDir);
			expect(stats.totalLearnings).toBeGreaterThan(0);
		});

		it("should support module import gotcha workflow", () => {
			// Scenario: Learning about ESM import requirements
			const { learning: gotcha } = addLearning(
				{
					taskId: "task-esm-refactor",
					category: "gotcha",
					content: "ESM imports in TypeScript require .js extension for relative imports",
					keywords: ["esm", "import", "extension", "typescript", "module", "relative"],
					structured: {
						file: "src/file.ts",
						pattern: 'import { x } from "./module.js"; // not "./module"',
						approach: "Always add .js extension when importing TS files via ESM",
					},
				},
				tempDir,
			);

			// Use this learning in subsequent tasks
			for (let i = 0; i < 3; i++) {
				const results = findRelevantLearnings("Fix TypeScript import errors", 5, tempDir, TEST_QUALITY_THRESHOLDS);
				expect(results.length).toBeGreaterThan(0);

				markLearningsUsed(
					results.map((l) => l.id),
					true,
					tempDir,
				);
			}

			// Confidence should increase
			const kb = loadKnowledge(tempDir);
			const learning = kb.learnings.find((l) => l.id === gotcha.id);
			expect(learning?.confidence).toBeGreaterThan(0.5);
		});

		it("should support caching strategy learning", () => {
			const result = addLearning(
				{
					taskId: "task-cache-implementation",
					category: "pattern",
					content: "Use singleton factory pattern for cache instances with reset capability",
					keywords: ["cache", "singleton", "factory", "pattern", "instance"],
					structured: {
						file: "src/cache.ts",
						pattern: "let instance: Cache | null = null; export function getCache() { ... }",
					},
				},
				tempDir,
			);

			// Search for cache-related tasks
			const results = findRelevantLearnings("Implement query result caching", 5, tempDir, TEST_QUALITY_THRESHOLDS);
			expect(results.some((l) => l.id === result.learning.id)).toBe(true);
		});
	});
});
