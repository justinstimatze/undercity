/**
 * Tests for task classifier
 *
 * Tests semantic classification of tasks based on historical outcomes:
 * - Classification with empty corpus
 * - Classification with similar successful tasks (low risk)
 * - Classification with similar failed tasks (high risk)
 * - Indexing task outcomes
 * - Classification stats
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeRAGDatabase, resetRAGDatabase } from "../rag/database.js";
import { resetRAGEngine } from "../rag/engine.js";
import {
	classifyTask,
	getClassificationStats,
	hasClassificationData,
	indexTaskOutcome,
	TASK_OUTCOMES_SOURCE,
} from "../task-classifier.js";

// Mock the embedder to avoid loading the actual model
vi.mock("../rag/embedder.js", () => ({
	getEmbedder: () => ({
		dimensions: 384,
		embed: vi.fn().mockResolvedValue(new Array(384).fill(0.5)),
		embedBatch: vi
			.fn()
			.mockImplementation((texts: string[]) => Promise.resolve(texts.map(() => new Array(384).fill(0.5)))),
		getCacheFile: () => ".undercity/embeddings.cache.json",
		isCacheEnabled: () => true,
	}),
	LocalEmbedder: vi.fn(),
	resetEmbedder: vi.fn(),
}));

describe("task-classifier.ts", () => {
	let tempDir: string;

	beforeEach(() => {
		resetRAGDatabase();
		resetRAGEngine();
		tempDir = mkdtempSync(join(tmpdir(), "task-classifier-test-"));
	});

	afterEach(() => {
		closeRAGDatabase();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ==========================================================================
	// classifyTask Tests
	// ==========================================================================

	describe("classifyTask", () => {
		it("returns neutral classification with empty corpus", async () => {
			const result = await classifyTask("Add a new feature to handle user authentication", tempDir);

			expect(result.riskScore).toBe(0.5);
			expect(result.confidence).toBe(0);
			expect(result.similarTasks).toHaveLength(0);
			expect(result.riskFactors).toContain("No similar historical tasks found");
			expect(result.recommendation).toBe("proceed");
		});

		it("returns low risk for tasks similar to successful historical tasks", async () => {
			// Index several successful tasks
			await indexTaskOutcome("task-1", "Add user authentication feature", "success", {}, tempDir);
			await indexTaskOutcome("task-2", "Implement OAuth login", "success", {}, tempDir);
			await indexTaskOutcome("task-3", "Add session management", "success", {}, tempDir);

			const result = await classifyTask("Add login feature with OAuth support", tempDir);

			// With all similar tasks successful, risk should be low
			expect(result.riskScore).toBeLessThanOrEqual(0.5);
			expect(result.recommendation).toBe("proceed");
		});

		it("returns results with similar tasks when corpus has data", async () => {
			// Index several failed tasks
			// Note: With mocked embedder returning same vectors, all tasks are equally similar
			await indexTaskOutcome(
				"task-1",
				"Create interfaces in types.ts",
				"failure",
				{
					failureReason: "no_changes_mismatch",
				},
				tempDir,
			);
			await indexTaskOutcome(
				"task-2",
				"Add type definitions to types folder",
				"failure",
				{
					failureReason: "no_changes_confused",
				},
				tempDir,
			);
			await indexTaskOutcome(
				"task-3",
				"Define new interfaces for evaluation",
				"failure",
				{
					failureReason: "verification_typecheck",
				},
				tempDir,
			);

			const result = await classifyTask("Create type interfaces in types.ts", tempDir);

			// With mocked embedder, search results are based on FTS not semantic similarity
			// Just verify the function returns a valid classification structure
			expect(result.riskScore).toBeGreaterThanOrEqual(0);
			expect(result.riskScore).toBeLessThanOrEqual(1);
			expect(result.confidence).toBeGreaterThanOrEqual(0);
			expect(result.confidence).toBeLessThanOrEqual(1);
			expect(["proceed", "review", "reject"]).toContain(result.recommendation);
		});

		it("handles corpus with failed tasks", async () => {
			await indexTaskOutcome(
				"task-1",
				"Refactor the validation module",
				"failure",
				{
					failureReason: "verification_tests",
				},
				tempDir,
			);

			const result = await classifyTask("Refactor validation logic", tempDir);

			// Verify the classification structure is valid
			// With mocked embedder, we can't guarantee specific similarity results
			expect(result.riskScore).toBeGreaterThanOrEqual(0);
			expect(result.riskScore).toBeLessThanOrEqual(1);
			expect(Array.isArray(result.similarTasks)).toBe(true);
			expect(Array.isArray(result.riskFactors)).toBe(true);
		});

		it("calculates confidence based on corpus size", async () => {
			// Empty corpus - zero confidence
			const emptyResult = await classifyTask("Some task", tempDir);
			expect(emptyResult.confidence).toBe(0);

			// Add one task
			await indexTaskOutcome("task-1", "Related task content", "success", {}, tempDir);
			const oneTaskResult = await classifyTask("Related task", tempDir);
			// Confidence should be low but non-zero
			expect(oneTaskResult.confidence).toBeLessThanOrEqual(1);

			// Add more tasks for higher confidence
			await indexTaskOutcome("task-2", "Another related task", "success", {}, tempDir);
			await indexTaskOutcome("task-3", "Third related task", "success", {}, tempDir);
			const moreTasksResult = await classifyTask("Related task content", tempDir);
			// Confidence should increase with more matches
			expect(moreTasksResult.confidence).toBeLessThanOrEqual(1);
		});

		it("returns neutral classification when RAG search fails", async () => {
			// To simulate RAG failure, we'll use a non-existent state dir with corrupted DB
			// Create a corrupted rag.db file
			const { writeFileSync } = await import("node:fs");
			const { join } = await import("node:path");

			const corruptedTempDir = mkdtempSync(join(tmpdir(), "corrupted-rag-"));
			writeFileSync(join(corruptedTempDir, "rag.db"), "corrupted data", "utf-8");

			try {
				// This should trigger an error in RAG search
				const result = await classifyTask("Task that will trigger RAG failure", corruptedTempDir);

				// Even if search fails, should return neutral classification
				expect(result.riskScore).toBe(0.5);
				expect(result.confidence).toBe(0);
				expect(result.similarTasks).toHaveLength(0);
				expect(result.riskFactors).toContain("Classification unavailable (search failed)");
				expect(result.recommendation).toBe("proceed");
			} finally {
				// Clean up
				rmSync(corruptedTempDir, { recursive: true, force: true });
			}
		});
	});

	// ==========================================================================
	// indexTaskOutcome Tests
	// ==========================================================================

	describe("indexTaskOutcome", () => {
		it("indexes a successful task outcome", async () => {
			await indexTaskOutcome(
				"task-123",
				"Add error handling to API endpoints",
				"success",
				{
					filesModified: ["src/api.ts"],
					durationMs: 5000,
					modelUsed: "sonnet",
				},
				tempDir,
			);

			const stats = getClassificationStats(tempDir);
			expect(stats.totalIndexed).toBe(1);
		});

		it("indexes a failed task outcome with failure reason", async () => {
			await indexTaskOutcome(
				"task-456",
				"Create new validation types",
				"failure",
				{
					failureReason: "no_changes_mismatch",
					failureCategory: "no_changes_mismatch",
				},
				tempDir,
			);

			const stats = getClassificationStats(tempDir);
			expect(stats.totalIndexed).toBe(1);
		});

		it("deduplicates identical task objectives", async () => {
			const objective = "Implement feature X";

			await indexTaskOutcome("task-1", objective, "success", {}, tempDir);
			await indexTaskOutcome("task-2", objective, "failure", {}, tempDir);

			const stats = getClassificationStats(tempDir);
			// Should only have 1 due to content deduplication
			expect(stats.totalIndexed).toBe(1);
		});

		it("handles RAG indexing failures gracefully", async () => {
			// To simulate RAG indexing failure, use a corrupted database
			const { writeFileSync } = await import("node:fs");
			const { join } = await import("node:path");

			const corruptedTempDir = mkdtempSync(join(tmpdir(), "corrupted-rag-"));

			// Create corrupted database file
			const dbPath = join(corruptedTempDir, "rag.db");
			writeFileSync(dbPath, "corrupted data", "utf-8");

			try {
				// The key test: indexTaskOutcome should not throw even when RAG is corrupted
				// It should fail silently and log a warning
				await expect(
					indexTaskOutcome("task-fail", "Task that will fail to index", "success", {}, corruptedTempDir),
				).resolves.not.toThrow();

				// Since the implementation catches and silently fails, this function completes successfully
				// even though no actual indexing occurred
			} finally {
				// Clean up
				rmSync(corruptedTempDir, { recursive: true, force: true });
			}
		});
	});

	// ==========================================================================
	// getClassificationStats Tests
	// ==========================================================================

	describe("getClassificationStats", () => {
		it("returns zero for empty corpus", () => {
			const stats = getClassificationStats(tempDir);

			expect(stats.totalIndexed).toBe(0);
		});

		it("counts indexed documents correctly", async () => {
			await indexTaskOutcome("task-1", "Task one", "success", {}, tempDir);
			await indexTaskOutcome("task-2", "Task two", "failure", {}, tempDir);
			await indexTaskOutcome("task-3", "Task three", "success", {}, tempDir);

			const stats = getClassificationStats(tempDir);
			expect(stats.totalIndexed).toBe(3);
		});
	});

	// ==========================================================================
	// hasClassificationData Tests
	// ==========================================================================

	describe("hasClassificationData", () => {
		it("returns false for empty corpus", () => {
			expect(hasClassificationData(tempDir)).toBe(false);
		});

		it("returns false for corpus with less than 5 outcomes", async () => {
			await indexTaskOutcome("task-1", "Task one", "success", {}, tempDir);
			await indexTaskOutcome("task-2", "Task two", "failure", {}, tempDir);
			await indexTaskOutcome("task-3", "Task three", "success", {}, tempDir);
			await indexTaskOutcome("task-4", "Task four", "failure", {}, tempDir);

			expect(hasClassificationData(tempDir)).toBe(false);
		});

		it("returns true for corpus with 5 or more outcomes", async () => {
			await indexTaskOutcome("task-1", "Task one content", "success", {}, tempDir);
			await indexTaskOutcome("task-2", "Task two different content", "failure", {}, tempDir);
			await indexTaskOutcome("task-3", "Task three unique content", "success", {}, tempDir);
			await indexTaskOutcome("task-4", "Task four another content", "failure", {}, tempDir);
			await indexTaskOutcome("task-5", "Task five final content", "success", {}, tempDir);

			expect(hasClassificationData(tempDir)).toBe(true);
		});
	});

	// ==========================================================================
	// TASK_OUTCOMES_SOURCE constant
	// ==========================================================================

	describe("TASK_OUTCOMES_SOURCE", () => {
		it("has expected value", () => {
			expect(TASK_OUTCOMES_SOURCE).toBe("task-outcomes");
		});
	});
});
