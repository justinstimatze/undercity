/**
 * Tests for RAG database layer
 *
 * Tests database operations:
 * - Document CRUD operations
 * - Chunk CRUD operations
 * - Embedding storage and retrieval
 * - FTS5 search functionality
 * - Vector search functionality
 * - Statistics gathering
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	clearRAGData,
	closeRAGDatabase,
	deleteDocument,
	ftsSearch,
	getChunkById,
	getChunksForDocument,
	getDocumentByFileHash,
	getDocumentById,
	getDocuments,
	getRAGDatabase,
	getRAGStats,
	insertChunk,
	insertDocument,
	insertEmbedding,
	resetRAGDatabase,
	vectorSearch,
} from "../rag/database.js";
import type { Chunk, Document } from "../rag/types.js";

describe("rag/database.ts", () => {
	let tempDir: string;

	beforeEach(() => {
		resetRAGDatabase();
		tempDir = mkdtempSync(join(tmpdir(), "rag-db-test-"));
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
	// Database Initialization Tests
	// ==========================================================================

	describe("getRAGDatabase", () => {
		it("should create database and initialize schema", () => {
			const db = getRAGDatabase(tempDir);
			expect(db).toBeDefined();

			// Check tables exist
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
			const tableNames = tables.map((t) => t.name);

			expect(tableNames).toContain("rag_documents");
			expect(tableNames).toContain("rag_chunks");
		});

		it("should return same instance on subsequent calls", () => {
			const db1 = getRAGDatabase(tempDir);
			const db2 = getRAGDatabase(tempDir);
			expect(db1).toBe(db2);
		});
	});

	// ==========================================================================
	// Document Operations Tests
	// ==========================================================================

	describe("Document operations", () => {
		it("should insert and retrieve document", () => {
			const doc: Document = {
				id: "doc-1",
				source: "test",
				title: "Test Document",
				metadata: { key: "value" },
				indexedAt: new Date(),
			};

			insertDocument(doc, tempDir);
			const retrieved = getDocumentById("doc-1", tempDir);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe("doc-1");
			expect(retrieved?.source).toBe("test");
			expect(retrieved?.title).toBe("Test Document");
			expect(retrieved?.metadata.key).toBe("value");
		});

		it("should return null for non-existent document", () => {
			getRAGDatabase(tempDir); // Initialize
			const doc = getDocumentById("nonexistent", tempDir);
			expect(doc).toBeNull();
		});

		it("should find document by file hash", () => {
			const doc: Document = {
				id: "doc-1",
				source: "test",
				title: "Test",
				fileHash: "abc123",
				metadata: {},
			};

			insertDocument(doc, tempDir);
			const found = getDocumentByFileHash("abc123", tempDir);

			expect(found).not.toBeNull();
			expect(found?.id).toBe("doc-1");
		});

		it("should get all documents", () => {
			insertDocument({ id: "doc-1", source: "a", title: "Doc 1", metadata: {} }, tempDir);
			insertDocument({ id: "doc-2", source: "b", title: "Doc 2", metadata: {} }, tempDir);
			insertDocument({ id: "doc-3", source: "a", title: "Doc 3", metadata: {} }, tempDir);

			const all = getDocuments(undefined, tempDir);
			expect(all.length).toBe(3);
		});

		it("should filter documents by source", () => {
			insertDocument({ id: "doc-1", source: "a", title: "Doc 1", metadata: {} }, tempDir);
			insertDocument({ id: "doc-2", source: "b", title: "Doc 2", metadata: {} }, tempDir);
			insertDocument({ id: "doc-3", source: "a", title: "Doc 3", metadata: {} }, tempDir);

			const filtered = getDocuments("a", tempDir);
			expect(filtered.length).toBe(2);
			expect(filtered.every((d) => d.source === "a")).toBe(true);
		});

		it("should delete document", () => {
			insertDocument({ id: "doc-1", source: "test", title: "Test", metadata: {} }, tempDir);

			const deleted = deleteDocument("doc-1", tempDir);
			expect(deleted).toBe(true);

			const doc = getDocumentById("doc-1", tempDir);
			expect(doc).toBeNull();
		});

		it("should return false when deleting non-existent document", () => {
			getRAGDatabase(tempDir);
			const deleted = deleteDocument("nonexistent", tempDir);
			expect(deleted).toBe(false);
		});
	});

	// ==========================================================================
	// Chunk Operations Tests
	// ==========================================================================

	describe("Chunk operations", () => {
		beforeEach(() => {
			// Insert a document first
			insertDocument({ id: "doc-1", source: "test", title: "Test", metadata: {} }, tempDir);
		});

		it("should insert and retrieve chunk", () => {
			const chunk: Chunk = {
				id: "chunk-1",
				documentId: "doc-1",
				sequence: 0,
				content: "Test content",
				tokenCount: 10,
				metadata: { key: "value" },
			};

			insertChunk(chunk, tempDir);
			const retrieved = getChunkById("chunk-1", tempDir);

			expect(retrieved).not.toBeNull();
			expect(retrieved?.content).toBe("Test content");
			expect(retrieved?.tokenCount).toBe(10);
		});

		it("should get chunks for document", () => {
			insertChunk(
				{ id: "c1", documentId: "doc-1", sequence: 0, content: "First", tokenCount: 5, metadata: {} },
				tempDir,
			);
			insertChunk(
				{ id: "c2", documentId: "doc-1", sequence: 1, content: "Second", tokenCount: 5, metadata: {} },
				tempDir,
			);
			insertChunk(
				{ id: "c3", documentId: "doc-1", sequence: 2, content: "Third", tokenCount: 5, metadata: {} },
				tempDir,
			);

			const chunks = getChunksForDocument("doc-1", tempDir);

			expect(chunks.length).toBe(3);
			expect(chunks[0].sequence).toBe(0);
			expect(chunks[1].sequence).toBe(1);
			expect(chunks[2].sequence).toBe(2);
		});

		it("should cascade delete chunks when document deleted", () => {
			insertChunk(
				{ id: "c1", documentId: "doc-1", sequence: 0, content: "Test", tokenCount: 5, metadata: {} },
				tempDir,
			);

			deleteDocument("doc-1", tempDir);

			const chunk = getChunkById("c1", tempDir);
			expect(chunk).toBeNull();
		});
	});

	// ==========================================================================
	// Embedding Operations Tests
	// ==========================================================================

	describe("Embedding operations", () => {
		beforeEach(() => {
			insertDocument({ id: "doc-1", source: "test", title: "Test", metadata: {} }, tempDir);
			insertChunk(
				{ id: "c1", documentId: "doc-1", sequence: 0, content: "Test", tokenCount: 5, metadata: {} },
				tempDir,
			);
		});

		it("should insert embedding", () => {
			// 384-dimensional embedding (all-MiniLM-L6-v2)
			const embedding = new Array(384).fill(0).map((_, i) => i / 384);

			// Should not throw
			expect(() => insertEmbedding("c1", embedding, tempDir)).not.toThrow();
		});

		it("should perform vector search", () => {
			// Insert embeddings for multiple chunks
			insertChunk(
				{ id: "c2", documentId: "doc-1", sequence: 1, content: "Other", tokenCount: 5, metadata: {} },
				tempDir,
			);

			const emb1 = new Array(384).fill(0.1);
			const emb2 = new Array(384).fill(0.9);

			insertEmbedding("c1", emb1, tempDir);
			insertEmbedding("c2", emb2, tempDir);

			// Search with query similar to emb1
			const query = new Array(384).fill(0.1);
			const results = vectorSearch(query, 10, tempDir);

			expect(results.length).toBe(2);
			// First result should be c1 (closer to query)
			expect(results[0].chunkId).toBe("c1");
		});
	});

	// ==========================================================================
	// FTS5 Search Tests
	// ==========================================================================

	describe("FTS5 search", () => {
		beforeEach(() => {
			insertDocument({ id: "doc-1", source: "test", title: "Test", metadata: {} }, tempDir);
			insertChunk(
				{
					id: "c1",
					documentId: "doc-1",
					sequence: 0,
					content: "TypeScript validation with Zod schemas",
					tokenCount: 10,
					metadata: {},
				},
				tempDir,
			);
			insertChunk(
				{
					id: "c2",
					documentId: "doc-1",
					sequence: 1,
					content: "Python data processing with pandas",
					tokenCount: 10,
					metadata: {},
				},
				tempDir,
			);
		});

		it("should find chunks by keyword", () => {
			const results = ftsSearch("TypeScript", 10, tempDir);
			expect(results.length).toBeGreaterThan(0);
		});

		it("should rank results by relevance", () => {
			const results = ftsSearch("Zod", 10, tempDir);
			expect(results.length).toBe(1);
		});

		it("should return empty for no matches", () => {
			const results = ftsSearch("nonexistent", 10, tempDir);
			expect(results.length).toBe(0);
		});

		it("should handle empty query", () => {
			const results = ftsSearch("", 10, tempDir);
			expect(results).toEqual([]);
		});

		it("should handle queries with forward slashes (file paths)", () => {
			insertChunk(
				{
					id: "c3",
					documentId: "doc-1",
					sequence: 2,
					content: "The ftsSearch() function in src/rag/database.ts handles escaping",
					tokenCount: 15,
					metadata: {},
				},
				tempDir,
			);

			// Should not throw FTS5 syntax error
			expect(() => ftsSearch("src/rag/database.ts", 10, tempDir)).not.toThrow();

			// Should find the chunk
			const results = ftsSearch("src/rag/database.ts", 10, tempDir);
			expect(results.length).toBeGreaterThan(0);
		});

		it("should handle queries with at signs (email addresses)", () => {
			insertChunk(
				{
					id: "c3",
					documentId: "doc-1",
					sequence: 2,
					content: "Contact user@example.com for support",
					tokenCount: 10,
					metadata: {},
				},
				tempDir,
			);

			// Should not throw FTS5 syntax error
			expect(() => ftsSearch("user@example.com", 10, tempDir)).not.toThrow();

			// Should find the chunk
			const results = ftsSearch("user@example.com", 10, tempDir);
			expect(results.length).toBeGreaterThan(0);
		});

		it("should handle queries with double quotes", () => {
			insertChunk(
				{
					id: "c3",
					documentId: "doc-1",
					sequence: 2,
					content: 'The function returns "success" or "failure"',
					tokenCount: 10,
					metadata: {},
				},
				tempDir,
			);

			// Should not throw FTS5 syntax error
			expect(() => ftsSearch('say "hello"', 10, tempDir)).not.toThrow();

			// Should find results (phrase search)
			const results = ftsSearch('"success"', 10, tempDir);
			expect(results.length).toBeGreaterThan(0);
		});

		it("should handle queries with hyphens", () => {
			insertChunk(
				{
					id: "c3",
					documentId: "doc-1",
					sequence: 2,
					content: "Use the foo-bar-baz pattern for naming",
					tokenCount: 10,
					metadata: {},
				},
				tempDir,
			);

			// Should not throw FTS5 syntax error
			expect(() => ftsSearch("foo-bar-baz", 10, tempDir)).not.toThrow();

			// Should find the chunk
			const results = ftsSearch("foo-bar-baz", 10, tempDir);
			expect(results.length).toBeGreaterThan(0);
		});

		it("should handle queries with asterisks", () => {
			insertChunk(
				{
					id: "c3",
					documentId: "doc-1",
					sequence: 2,
					content: "The pattern test*pattern matches wildcards",
					tokenCount: 10,
					metadata: {},
				},
				tempDir,
			);

			// Should not throw FTS5 syntax error
			expect(() => ftsSearch("test*pattern", 10, tempDir)).not.toThrow();

			// Should find the chunk
			const results = ftsSearch("test*pattern", 10, tempDir);
			expect(results.length).toBeGreaterThan(0);
		});

		it("should handle queries with parentheses", () => {
			insertChunk(
				{
					id: "c3",
					documentId: "doc-1",
					sequence: 2,
					content: "The function signature is foo(bar, baz)",
					tokenCount: 10,
					metadata: {},
				},
				tempDir,
			);

			// Should not throw FTS5 syntax error
			expect(() => ftsSearch("foo(bar, baz)", 10, tempDir)).not.toThrow();

			// Should find the chunk
			const results = ftsSearch("foo(bar", 10, tempDir);
			expect(results.length).toBeGreaterThan(0);
		});

		it("should handle queries with colons", () => {
			insertChunk(
				{
					id: "c3",
					documentId: "doc-1",
					sequence: 2,
					content: "The URL is https://example.com:8080/path",
					tokenCount: 10,
					metadata: {},
				},
				tempDir,
			);

			// Should not throw FTS5 syntax error
			expect(() => ftsSearch("https://example.com", 10, tempDir)).not.toThrow();

			// Should find the chunk
			const results = ftsSearch("https://example.com", 10, tempDir);
			expect(results.length).toBeGreaterThan(0);
		});

		it("should handle queries with mixed special characters", () => {
			insertChunk(
				{
					id: "c3",
					documentId: "doc-1",
					sequence: 2,
					content: "Email support@test-site.com for help with path/to/file.ts:42",
					tokenCount: 15,
					metadata: {},
				},
				tempDir,
			);

			// Should not throw FTS5 syntax error with mixed special chars
			expect(() => ftsSearch("support@test-site.com", 10, tempDir)).not.toThrow();
			expect(() => ftsSearch("path/to/file.ts", 10, tempDir)).not.toThrow();
			expect(() => ftsSearch("file.ts:42", 10, tempDir)).not.toThrow();

			// Should find the chunk
			const results = ftsSearch("support@test-site.com", 10, tempDir);
			expect(results.length).toBeGreaterThan(0);
		});

		it("should handle queries with only special characters", () => {
			// Should not throw but return empty (no meaningful query)
			expect(() => ftsSearch("@#$%", 10, tempDir)).not.toThrow();
		});

		it("should handle whitespace queries", () => {
			const results = ftsSearch("   ", 10, tempDir);
			expect(results).toEqual([]);
		});
	});

	// ==========================================================================
	// Statistics Tests
	// ==========================================================================

	describe("getRAGStats", () => {
		it("should return zero counts for empty database", () => {
			getRAGDatabase(tempDir);
			const stats = getRAGStats(tempDir);

			expect(stats.documentCount).toBe(0);
			expect(stats.chunkCount).toBe(0);
			expect(stats.embeddingDimensions).toBe(384);
		});

		it("should count documents and chunks", () => {
			insertDocument({ id: "doc-1", source: "a", title: "Doc 1", metadata: {} }, tempDir);
			insertDocument({ id: "doc-2", source: "b", title: "Doc 2", metadata: {} }, tempDir);
			insertChunk(
				{ id: "c1", documentId: "doc-1", sequence: 0, content: "Test", tokenCount: 5, metadata: {} },
				tempDir,
			);
			insertChunk(
				{ id: "c2", documentId: "doc-1", sequence: 1, content: "Test", tokenCount: 5, metadata: {} },
				tempDir,
			);
			insertChunk(
				{ id: "c3", documentId: "doc-2", sequence: 0, content: "Test", tokenCount: 5, metadata: {} },
				tempDir,
			);

			const stats = getRAGStats(tempDir);

			expect(stats.documentCount).toBe(2);
			expect(stats.chunkCount).toBe(3);
		});

		it("should group by source", () => {
			insertDocument({ id: "doc-1", source: "docs", title: "Doc 1", metadata: {} }, tempDir);
			insertDocument({ id: "doc-2", source: "code", title: "Doc 2", metadata: {} }, tempDir);
			insertChunk(
				{ id: "c1", documentId: "doc-1", sequence: 0, content: "Test", tokenCount: 5, metadata: {} },
				tempDir,
			);
			insertChunk(
				{ id: "c2", documentId: "doc-2", sequence: 0, content: "Test", tokenCount: 5, metadata: {} },
				tempDir,
			);

			const stats = getRAGStats(tempDir);

			expect(stats.sources.length).toBe(2);
			const docsSource = stats.sources.find((s) => s.source === "docs");
			const codeSource = stats.sources.find((s) => s.source === "code");

			expect(docsSource?.documentCount).toBe(1);
			expect(codeSource?.documentCount).toBe(1);
		});
	});

	// ==========================================================================
	// clearRAGData Tests
	// ==========================================================================

	describe("clearRAGData", () => {
		it("should remove all data", () => {
			insertDocument({ id: "doc-1", source: "test", title: "Test", metadata: {} }, tempDir);
			insertChunk(
				{ id: "c1", documentId: "doc-1", sequence: 0, content: "Test", tokenCount: 5, metadata: {} },
				tempDir,
			);
			insertEmbedding("c1", new Array(384).fill(0.5), tempDir);

			clearRAGData(tempDir);

			const stats = getRAGStats(tempDir);
			expect(stats.documentCount).toBe(0);
			expect(stats.chunkCount).toBe(0);
		});
	});
});
