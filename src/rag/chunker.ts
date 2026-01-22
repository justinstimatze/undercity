/**
 * Chunker Module
 *
 * Splits content into chunks suitable for embedding and retrieval.
 * Provides a Chunker interface for extensibility (cobalt can plug in VerseChunker later).
 */

import type { Chunk } from "./types.js";

/**
 * Chunker interface for splitting content into chunks
 */
export interface Chunker {
	chunk(content: string, documentId: string, metadata?: Record<string, unknown>): Chunk[];
}

/**
 * Options for chunking
 */
export interface ChunkingOptions {
	maxTokens?: number; // default 256
	overlap?: number; // default 32 tokens worth of characters
	minChunkSize?: number; // default 50 characters
}

/**
 * Estimate token count from text
 * Approximation: ~0.75 words per token for English
 */
function estimateTokens(text: string): number {
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	return Math.ceil(words.length / 0.75);
}

/**
 * Generate a unique chunk ID
 */
function generateChunkId(documentId: string, sequence: number): string {
	return `${documentId}-chunk-${sequence.toString().padStart(4, "0")}`;
}

/**
 * Paragraph-based chunker
 *
 * Strategy:
 * 1. Split content by paragraphs (double newlines)
 * 2. Merge small paragraphs together
 * 3. Split large paragraphs that exceed maxTokens
 * 4. Add overlap between chunks for context continuity
 */
export class ParagraphChunker implements Chunker {
	private maxTokens: number;
	private overlap: number;
	private minChunkSize: number;

	constructor(options: ChunkingOptions = {}) {
		this.maxTokens = options.maxTokens ?? 256;
		this.overlap = options.overlap ?? 32;
		this.minChunkSize = options.minChunkSize ?? 50;
	}

	chunk(content: string, documentId: string, metadata: Record<string, unknown> = {}): Chunk[] {
		if (!content.trim()) {
			return [];
		}

		// Split into paragraphs
		const paragraphs = this.splitIntoParagraphs(content);

		// Merge small paragraphs and split large ones
		const normalizedParagraphs = this.normalizeParagraphs(paragraphs);

		// Create chunks with overlap
		const chunks = this.createChunksWithOverlap(normalizedParagraphs, documentId, metadata);

		return chunks;
	}

	/**
	 * Split content into paragraphs by double newlines
	 */
	private splitIntoParagraphs(content: string): string[] {
		return content
			.split(/\n\s*\n/)
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
	}

	/**
	 * Normalize paragraphs: merge small ones, split large ones
	 */
	private normalizeParagraphs(paragraphs: string[]): string[] {
		const result: string[] = [];
		let buffer = "";

		for (const para of paragraphs) {
			const paraTokens = estimateTokens(para);

			// If paragraph itself is too large, split it
			if (paraTokens > this.maxTokens) {
				// Flush buffer first
				if (buffer) {
					result.push(buffer.trim());
					buffer = "";
				}
				// Split large paragraph by sentences
				const splitParas = this.splitLargeParagraph(para);
				result.push(...splitParas);
				continue;
			}

			// Check if adding to buffer would exceed limit
			const bufferTokens = estimateTokens(buffer);
			if (bufferTokens + paraTokens > this.maxTokens) {
				// Flush buffer and start new one
				if (buffer) {
					result.push(buffer.trim());
				}
				buffer = para;
			} else {
				// Add to buffer
				buffer = buffer ? `${buffer}\n\n${para}` : para;
			}
		}

		// Flush remaining buffer
		if (buffer.trim()) {
			result.push(buffer.trim());
		}

		return result;
	}

	/**
	 * Split a large paragraph into smaller chunks by sentences
	 */
	private splitLargeParagraph(paragraph: string): string[] {
		// Split by sentences (simple heuristic)
		const sentences = paragraph.split(/(?<=[.!?])\s+/);
		const result: string[] = [];
		let buffer = "";

		for (const sentence of sentences) {
			const sentenceTokens = estimateTokens(sentence);
			const bufferTokens = estimateTokens(buffer);

			if (bufferTokens + sentenceTokens > this.maxTokens) {
				if (buffer) {
					result.push(buffer.trim());
				}
				// If single sentence is too large, just add it
				if (sentenceTokens > this.maxTokens) {
					result.push(sentence.trim());
					buffer = "";
				} else {
					buffer = sentence;
				}
			} else {
				buffer = buffer ? `${buffer} ${sentence}` : sentence;
			}
		}

		if (buffer.trim()) {
			result.push(buffer.trim());
		}

		return result;
	}

	/**
	 * Create chunks with overlap for context continuity
	 */
	private createChunksWithOverlap(
		paragraphs: string[],
		documentId: string,
		metadata: Record<string, unknown>,
	): Chunk[] {
		const chunks: Chunk[] = [];

		for (let i = 0; i < paragraphs.length; i++) {
			let content = paragraphs[i];

			// Add overlap from previous chunk (last few sentences)
			if (i > 0 && this.overlap > 0) {
				const prevOverlap = this.getOverlapText(paragraphs[i - 1], this.overlap);
				if (prevOverlap) {
					content = `${prevOverlap}...\n\n${content}`;
				}
			}

			// Skip chunks that are too small
			if (content.length < this.minChunkSize) {
				continue;
			}

			const tokenCount = estimateTokens(content);

			chunks.push({
				id: generateChunkId(documentId, i),
				documentId,
				sequence: i,
				content,
				tokenCount,
				metadata: {
					...metadata,
					paragraphIndex: i,
					hasOverlap: i > 0 && this.overlap > 0,
				},
			});
		}

		return chunks;
	}

	/**
	 * Get overlap text from end of a paragraph
	 */
	private getOverlapText(text: string, targetTokens: number): string {
		const sentences = text.split(/(?<=[.!?])\s+/);

		// Take sentences from end until we reach target tokens
		const result: string[] = [];
		let tokens = 0;

		for (let i = sentences.length - 1; i >= 0; i--) {
			const sentenceTokens = estimateTokens(sentences[i]);
			if (tokens + sentenceTokens > targetTokens && result.length > 0) {
				break;
			}
			result.unshift(sentences[i]);
			tokens += sentenceTokens;
		}

		return result.join(" ");
	}
}

/**
 * Create default chunker instance
 */
export function createChunker(options?: ChunkingOptions): Chunker {
	return new ParagraphChunker(options);
}
