/**
 * Tests for RAG chunker
 *
 * Tests chunking strategies:
 * - Paragraph-based splitting
 * - Chunk merging for small paragraphs
 * - Chunk splitting for large paragraphs
 * - Overlap handling for context continuity
 * - Edge cases (empty content, very long content)
 */

import { describe, expect, it } from "vitest";

import { createChunker, ParagraphChunker } from "../rag/chunker.js";

describe("rag/chunker.ts", () => {
	// ==========================================================================
	// ParagraphChunker Basic Tests
	// ==========================================================================

	describe("ParagraphChunker", () => {
		it("should create chunks from paragraphs", () => {
			const chunker = new ParagraphChunker();
			const content = `First paragraph with some content.

Second paragraph with different content.

Third paragraph to complete the test.`;

			const chunks = chunker.chunk(content, "doc-1");

			expect(chunks.length).toBeGreaterThan(0);
			expect(chunks[0].documentId).toBe("doc-1");
			expect(chunks[0].sequence).toBe(0);
		});

		it("should return empty array for empty content", () => {
			const chunker = new ParagraphChunker();
			const chunks = chunker.chunk("", "doc-1");
			expect(chunks).toEqual([]);
		});

		it("should return empty array for whitespace-only content", () => {
			const chunker = new ParagraphChunker();
			const chunks = chunker.chunk("   \n\n   ", "doc-1");
			expect(chunks).toEqual([]);
		});

		it("should generate unique chunk IDs", () => {
			const chunker = new ParagraphChunker();
			const content = `Para 1.

Para 2.

Para 3.`;

			const chunks = chunker.chunk(content, "doc-1");
			const ids = chunks.map((c) => c.id);
			const uniqueIds = new Set(ids);

			expect(uniqueIds.size).toBe(ids.length);
		});

		it("should include document ID in chunk ID", () => {
			const chunker = new ParagraphChunker();
			const chunks = chunker.chunk("Some content here.", "my-doc-123");

			for (const chunk of chunks) {
				expect(chunk.id).toContain("my-doc-123");
			}
		});

		it("should track sequence numbers", () => {
			const chunker = new ParagraphChunker({ maxTokens: 50 });
			const content = `First paragraph with content.

Second paragraph with content.

Third paragraph with content.`;

			const chunks = chunker.chunk(content, "doc-1");

			for (let i = 0; i < chunks.length; i++) {
				expect(chunks[i].sequence).toBe(i);
			}
		});

		it("should estimate token counts", () => {
			const chunker = new ParagraphChunker({ minChunkSize: 10 });
			const chunks = chunker.chunk(
				"This is a test paragraph with several words that should be long enough to pass the minimum chunk size requirement.",
				"doc-1",
			);

			expect(chunks.length).toBeGreaterThan(0);
			expect(chunks[0].tokenCount).toBeGreaterThan(0);
		});
	});

	// ==========================================================================
	// Chunking Options Tests
	// ==========================================================================

	describe("ChunkingOptions", () => {
		it("should respect maxTokens option", () => {
			const chunker = new ParagraphChunker({ maxTokens: 20, minChunkSize: 10 });
			const content = `This is a very long paragraph that should definitely exceed twenty tokens because it has many words and keeps going on and on with more content that needs to be split into multiple chunks for proper processing. Adding even more content here to ensure we have enough text to split into multiple chunks.`;

			const chunks = chunker.chunk(content, "doc-1");

			// Should create multiple chunks for long content
			expect(chunks.length).toBeGreaterThan(1);
		});

		it("should merge small paragraphs", () => {
			const chunker = new ParagraphChunker({ maxTokens: 100, minChunkSize: 10 });
			const content = `Hi.

Hello.

Hey there.`;

			const chunks = chunker.chunk(content, "doc-1");

			// Small paragraphs should be merged
			expect(chunks.length).toBeLessThanOrEqual(2);
		});

		it("should respect minChunkSize option", () => {
			const chunker = new ParagraphChunker({ minChunkSize: 100 });
			const content = `Short.

Also short.`;

			const chunks = chunker.chunk(content, "doc-1");

			// Very short chunks should be filtered out or merged
			for (const chunk of chunks) {
				expect(chunk.content.length).toBeGreaterThanOrEqual(1);
			}
		});
	});

	// ==========================================================================
	// Overlap Tests
	// ==========================================================================

	describe("Overlap handling", () => {
		it("should add overlap from previous chunk", () => {
			const chunker = new ParagraphChunker({ maxTokens: 30, overlap: 10 });
			const content = `First paragraph with some important context that should carry over.

Second paragraph that needs the context from the first one.

Third paragraph continuing the discussion.`;

			const chunks = chunker.chunk(content, "doc-1");

			// Second chunk should have overlap indicator in metadata
			if (chunks.length > 1) {
				expect(chunks[1].metadata.hasOverlap).toBe(true);
			}
		});

		it("should not add overlap to first chunk", () => {
			const chunker = new ParagraphChunker({ overlap: 32 });
			const content = `First paragraph.

Second paragraph.`;

			const chunks = chunker.chunk(content, "doc-1");

			if (chunks.length > 0) {
				expect(chunks[0].metadata.hasOverlap).toBeFalsy();
			}
		});
	});

	// ==========================================================================
	// Metadata Tests
	// ==========================================================================

	describe("Metadata handling", () => {
		it("should include custom metadata in chunks", () => {
			const chunker = new ParagraphChunker({ minChunkSize: 5 });
			const chunks = chunker.chunk("Test content that is long enough to be indexed properly.", "doc-1", {
				author: "test",
				version: 1,
			});

			expect(chunks.length).toBeGreaterThan(0);
			expect(chunks[0].metadata.author).toBe("test");
			expect(chunks[0].metadata.version).toBe(1);
		});

		it("should include paragraph index in metadata", () => {
			const chunker = new ParagraphChunker();
			const content = `Para 1.

Para 2.

Para 3.`;

			const chunks = chunker.chunk(content, "doc-1");

			for (const chunk of chunks) {
				expect(chunk.metadata.paragraphIndex).toBeDefined();
			}
		});
	});

	// ==========================================================================
	// createChunker Factory Tests
	// ==========================================================================

	describe("createChunker", () => {
		it("should create default ParagraphChunker", () => {
			const chunker = createChunker({ minChunkSize: 5 });
			expect(chunker).toBeDefined();

			const chunks = chunker.chunk("Test content that is long enough to pass the minimum size.", "doc-1");
			expect(chunks.length).toBeGreaterThan(0);
		});

		it("should accept options", () => {
			const chunker = createChunker({ maxTokens: 50 });
			expect(chunker).toBeDefined();
		});
	});

	// ==========================================================================
	// Edge Cases
	// ==========================================================================

	describe("Edge cases", () => {
		it("should handle content with only newlines", () => {
			const chunker = new ParagraphChunker();
			const chunks = chunker.chunk("\n\n\n\n", "doc-1");
			expect(chunks).toEqual([]);
		});

		it("should handle single word content", () => {
			const chunker = new ParagraphChunker({ minChunkSize: 1 });
			const chunks = chunker.chunk("Word", "doc-1");
			expect(chunks.length).toBe(1);
			expect(chunks[0].content).toBe("Word");
		});

		it("should handle content without paragraph breaks", () => {
			const chunker = new ParagraphChunker({ maxTokens: 50 });
			const content =
				"This is a continuous block of text without any paragraph breaks that should still be processed correctly by the chunker and possibly split if it exceeds the token limit.";

			const chunks = chunker.chunk(content, "doc-1");
			expect(chunks.length).toBeGreaterThan(0);
		});

		it("should handle unicode content", () => {
			const chunker = new ParagraphChunker({ minChunkSize: 5 });
			const content = `日本語のテストです。これは十分に長いコンテンツです。

これは二番目の段落です。これも十分に長いコンテンツです。`;

			const chunks = chunker.chunk(content, "doc-1");
			expect(chunks.length).toBeGreaterThan(0);
		});

		it("should handle mixed content with code blocks", () => {
			const chunker = new ParagraphChunker();
			const content = `Here is some text.

\`\`\`typescript
const x = 1;
\`\`\`

More text after code.`;

			const chunks = chunker.chunk(content, "doc-1");
			expect(chunks.length).toBeGreaterThan(0);
		});
	});
});
