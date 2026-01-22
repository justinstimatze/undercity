/**
 * Tests for RAG engine
 *
 * Tests the main RAG orchestrator:
 * - Content indexing
 * - File indexing
 * - Document management
 * - Statistics
 *
 * Note: These are unit tests that mock the embedder to avoid
 * actual model loading during tests.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeRAGDatabase, resetRAGDatabase } from "../rag/database.js";
import { RAGEngine, resetRAGEngine } from "../rag/engine.js";

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

describe("rag/engine.ts", () => {
	let tempDir: string;
	let engine: RAGEngine;

	beforeEach(() => {
		resetRAGDatabase();
		resetRAGEngine();
		tempDir = mkdtempSync(join(tmpdir(), "rag-engine-test-"));
		engine = new RAGEngine({ stateDir: tempDir });
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
	// indexContent Tests
	// ==========================================================================

	describe("indexContent", () => {
		it("should index content and return result", async () => {
			const result = await engine.indexContent({
				content: "This is test content for indexing. It has multiple sentences.",
				source: "test",
				title: "Test Document",
			});

			expect(result.documentId).toBeDefined();
			expect(result.chunksCreated).toBeGreaterThan(0);
			expect(result.tokensIndexed).toBeGreaterThan(0);
		});

		it("should skip empty content", async () => {
			const result = await engine.indexContent({
				content: "",
				source: "test",
				title: "Empty",
			});

			expect(result.documentId).toBe("");
			expect(result.chunksCreated).toBe(0);
		});

		it("should skip whitespace-only content", async () => {
			const result = await engine.indexContent({
				content: "   \n\n   ",
				source: "test",
				title: "Whitespace",
			});

			expect(result.documentId).toBe("");
			expect(result.chunksCreated).toBe(0);
		});

		it("should deduplicate identical content", async () => {
			const content = "Same content for both documents.";

			const result1 = await engine.indexContent({
				content,
				source: "test",
				title: "First",
			});

			const result2 = await engine.indexContent({
				content,
				source: "test",
				title: "Second",
			});

			// Second call should return existing document ID
			expect(result2.documentId).toBe(result1.documentId);
			expect(result2.chunksCreated).toBe(0);
		});

		it("should include metadata in indexed content", async () => {
			await engine.indexContent({
				content: "Content with metadata.",
				source: "test",
				title: "Test",
				metadata: { author: "tester", version: 1 },
			});

			const docs = engine.getDocuments();
			expect(docs[0].metadata.author).toBe("tester");
			expect(docs[0].metadata.version).toBe(1);
		});
	});

	// ==========================================================================
	// indexFile Tests
	// ==========================================================================

	describe("indexFile", () => {
		it("should index a text file", async () => {
			const filePath = join(tempDir, "test.txt");
			writeFileSync(
				filePath,
				"This is test file content that is long enough to be properly indexed by the chunker and pass the minimum size requirement for creating chunks.",
			);

			const results = await engine.indexFile({
				filePath,
				source: "files",
			});

			expect(results.length).toBe(1);
			expect(results[0].chunksCreated).toBeGreaterThan(0);
		});

		it("should index a markdown file", async () => {
			const filePath = join(tempDir, "test.md");
			writeFileSync(filePath, "# Heading\n\nSome content here.");

			const results = await engine.indexFile({
				filePath,
				source: "docs",
			});

			expect(results.length).toBe(1);
		});

		it("should index a TypeScript file", async () => {
			const filePath = join(tempDir, "test.ts");
			writeFileSync(filePath, "export const x = 1;\n\nfunction test() { return x; }");

			const results = await engine.indexFile({
				filePath,
				source: "code",
			});

			expect(results.length).toBe(1);
		});

		it("should skip unsupported file types", async () => {
			const filePath = join(tempDir, "test.xyz");
			writeFileSync(filePath, "Content in unknown format.");

			const results = await engine.indexFile({
				filePath,
				source: "test",
			});

			expect(results.length).toBe(0);
		});

		it("should throw for non-existent file", async () => {
			await expect(
				engine.indexFile({
					filePath: join(tempDir, "nonexistent.txt"),
					source: "test",
				}),
			).rejects.toThrow();
		});

		it("should index directory non-recursively", async () => {
			const subDir = join(tempDir, "subdir");
			mkdirSync(subDir);

			writeFileSync(join(tempDir, "root.txt"), "Root file content.");
			writeFileSync(join(subDir, "nested.txt"), "Nested file content.");

			const results = await engine.indexFile({
				filePath: tempDir,
				source: "test",
				recursive: false,
			});

			// Should only index root file, not nested
			expect(results.length).toBe(1);
		});

		it("should index directory recursively", async () => {
			const subDir = join(tempDir, "subdir");
			mkdirSync(subDir);

			writeFileSync(join(tempDir, "root.txt"), "Root file content.");
			writeFileSync(join(subDir, "nested.txt"), "Nested file content.");

			const results = await engine.indexFile({
				filePath: tempDir,
				source: "test",
				recursive: true,
			});

			expect(results.length).toBe(2);
		});
	});

	// ==========================================================================
	// getDocuments Tests
	// ==========================================================================

	describe("getDocuments", () => {
		it("should return empty array when no documents", () => {
			const docs = engine.getDocuments();
			expect(docs).toEqual([]);
		});

		it("should return all documents", async () => {
			await engine.indexContent({ content: "Doc 1 content.", source: "a", title: "Doc 1" });
			await engine.indexContent({ content: "Doc 2 content.", source: "b", title: "Doc 2" });

			const docs = engine.getDocuments();
			expect(docs.length).toBe(2);
		});

		it("should filter by source", async () => {
			await engine.indexContent({ content: "Doc 1 content.", source: "docs", title: "Doc 1" });
			await engine.indexContent({ content: "Doc 2 content.", source: "code", title: "Doc 2" });
			await engine.indexContent({ content: "Doc 3 content.", source: "docs", title: "Doc 3" });

			const docs = engine.getDocuments("docs");
			expect(docs.length).toBe(2);
			expect(docs.every((d) => d.source === "docs")).toBe(true);
		});
	});

	// ==========================================================================
	// removeDocument Tests
	// ==========================================================================

	describe("removeDocument", () => {
		it("should remove existing document", async () => {
			const result = await engine.indexContent({
				content: "Content to remove.",
				source: "test",
				title: "Test",
			});

			const removed = engine.removeDocument(result.documentId);
			expect(removed).toBe(true);

			const docs = engine.getDocuments();
			expect(docs.length).toBe(0);
		});

		it("should return false for non-existent document", () => {
			const removed = engine.removeDocument("nonexistent");
			expect(removed).toBe(false);
		});
	});

	// ==========================================================================
	// getStats Tests
	// ==========================================================================

	describe("getStats", () => {
		it("should return zero counts when empty", () => {
			const stats = engine.getStats();

			expect(stats.documentCount).toBe(0);
			expect(stats.chunkCount).toBe(0);
			expect(stats.embeddingDimensions).toBe(384);
		});

		it("should count documents and chunks", async () => {
			await engine.indexContent({
				content: "First document content that is long enough to be properly indexed and create chunks.",
				source: "test",
				title: "Doc 1",
			});
			await engine.indexContent({
				content: "Second document content that is also long enough to be properly indexed and create chunks.",
				source: "test",
				title: "Doc 2",
			});

			const stats = engine.getStats();

			expect(stats.documentCount).toBe(2);
			expect(stats.chunkCount).toBeGreaterThan(0);
		});
	});

	// ==========================================================================
	// clear Tests
	// ==========================================================================

	describe("clear", () => {
		it("should remove all data", async () => {
			await engine.indexContent({ content: "Content to clear.", source: "test", title: "Test" });

			engine.clear();

			const stats = engine.getStats();
			expect(stats.documentCount).toBe(0);
			expect(stats.chunkCount).toBe(0);
		});
	});
});
