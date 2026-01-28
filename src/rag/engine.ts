/**
 * RAG Engine
 *
 * Main orchestrator for the RAG system. Provides high-level API for:
 * - Indexing files and content
 * - Searching with hybrid vector + keyword search
 * - Managing the RAG index
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { glob } from "glob";
import { sessionLogger } from "../logger.js";
import { type Chunker, createChunker } from "./chunker.js";
import {
	clearRAGData,
	deleteDocument,
	getDocumentByFileHash,
	getDocuments,
	getRAGStats,
	insertChunk,
	insertDocument,
	insertEmbedding,
} from "./database.js";
import { getEmbedder, type LocalEmbedder } from "./embedder.js";
import { createHybridSearcher, type HybridSearcher } from "./hybrid-search.js";
import type {
	Document,
	IndexContentOptions,
	IndexFileOptions,
	IndexResult,
	RAGStats,
	SearchOptions,
	SearchResult,
} from "./types.js";

const logger = sessionLogger.child({ module: "rag-engine" });

/**
 * Supported file extensions for indexing
 */
const SUPPORTED_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".rs",
	".go",
	".java",
	".c",
	".cpp",
	".h",
	".hpp",
	".rb",
	".php",
	".yaml",
	".yml",
	".toml",
	".ini",
	".cfg",
	".conf",
	".sh",
	".bash",
	".zsh",
	".fish",
	".css",
	".scss",
	".less",
	".html",
	".xml",
	".sql",
]);

/**
 * Generate a unique document ID
 */
function generateDocumentId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `doc-${timestamp}-${random}`;
}

/**
 * Compute file hash for deduplication
 */
function computeFileHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

/**
 * RAG Engine - main orchestrator
 */
export class RAGEngine {
	private embedder: LocalEmbedder;
	private chunker: Chunker;
	private searcher: HybridSearcher;
	private stateDir: string;

	constructor(options: { stateDir?: string; chunker?: Chunker } = {}) {
		this.stateDir = options.stateDir ?? ".undercity";
		this.embedder = getEmbedder({ cacheFile: join(this.stateDir, "embeddings.cache.json") });
		this.chunker = options.chunker ?? createChunker();
		this.searcher = createHybridSearcher(this.embedder, this.stateDir);
	}

	/**
	 * Index content programmatically (not from a file)
	 *
	 * Use this for indexing learnings, decisions, and other in-memory content.
	 *
	 * @throws {Error} If embedder fails to generate embeddings (model loading, network issues, etc.)
	 */
	async indexContent(opts: IndexContentOptions): Promise<IndexResult> {
		const { content, source, title, metadata = {} } = opts;

		if (!content.trim()) {
			return { documentId: "", chunksCreated: 0, tokensIndexed: 0 };
		}

		const documentId = generateDocumentId();
		const contentHash = computeFileHash(content);

		// Check for duplicate content
		const existing = getDocumentByFileHash(contentHash, this.stateDir);
		if (existing) {
			logger.debug({ existingId: existing.id }, "Content already indexed, skipping");
			return { documentId: existing.id, chunksCreated: 0, tokensIndexed: 0 };
		}

		// Create document
		const document: Document = {
			id: documentId,
			source,
			title,
			fileHash: contentHash,
			metadata,
			indexedAt: new Date(),
		};

		insertDocument(document, this.stateDir);

		// Chunk content
		const chunks = this.chunker.chunk(content, documentId, metadata);

		if (chunks.length === 0) {
			logger.debug({ documentId }, "No chunks created from content");
			return { documentId, chunksCreated: 0, tokensIndexed: 0 };
		}

		// Generate embeddings for all chunks
		let embeddings: number[][];
		try {
			embeddings = await this.embedder.embedBatch(chunks.map((c) => c.content));
		} catch (error) {
			// Clean up orphaned document if embedding fails
			deleteDocument(documentId, this.stateDir);

			const errorMessage =
				`Failed to generate embeddings for content in indexContent(). ` +
				`This may indicate: model loading failure, network issues accessing HuggingFace models, ` +
				`corrupted model cache, or insufficient memory. ` +
				`Document: ${title || source} (${documentId}). ` +
				`Try clearing the HuggingFace cache at ~/.cache/huggingface or checking network connectivity. ` +
				`Underlying error: ${error instanceof Error ? error.message : String(error)}`;

			logger.error(
				{
					documentId,
					source,
					title,
					chunkCount: chunks.length,
					error: String(error),
				},
				errorMessage,
			);

			throw new Error(errorMessage);
		}

		// Store chunks and embeddings
		let tokensIndexed = 0;
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			insertChunk(chunk, this.stateDir);
			insertEmbedding(chunk.id, embeddings[i], this.stateDir);
			tokensIndexed += chunk.tokenCount;
		}

		logger.info({ documentId, chunks: chunks.length, tokens: tokensIndexed, source }, "Content indexed");

		return {
			documentId,
			chunksCreated: chunks.length,
			tokensIndexed,
		};
	}

	/**
	 * Index a file or directory
	 */
	async indexFile(opts: IndexFileOptions): Promise<IndexResult[]> {
		const { filePath, source, recursive = false } = opts;

		if (!existsSync(filePath)) {
			throw new Error(`Path does not exist: ${filePath}`);
		}

		const stat = statSync(filePath);

		if (stat.isDirectory()) {
			return this.indexDirectory(filePath, source, recursive);
		}

		// Single file
		const result = await this.indexSingleFile(filePath, source);
		return result ? [result] : [];
	}

	/**
	 * Index a single file
	 */
	private async indexSingleFile(filePath: string, source: string): Promise<IndexResult | null> {
		const ext = extname(filePath).toLowerCase();

		if (!SUPPORTED_EXTENSIONS.has(ext)) {
			logger.debug({ filePath, ext }, "Skipping unsupported file type");
			return null;
		}

		try {
			const content = readFileSync(filePath, "utf-8");
			const contentHash = computeFileHash(content);

			// Check for existing document with same hash
			const existing = getDocumentByFileHash(contentHash, this.stateDir);
			if (existing) {
				logger.debug({ filePath, existingId: existing.id }, "File already indexed, skipping");
				return { documentId: existing.id, chunksCreated: 0, tokensIndexed: 0 };
			}

			const title = basename(filePath);

			return this.indexContent({
				content,
				source,
				title,
				metadata: {
					filePath,
					extension: ext,
				},
			});
		} catch (error) {
			const errorMessage = String(error);
			// Distinguish between file read errors and embedding errors
			if (errorMessage.includes("generate embeddings") || errorMessage.includes("model loading")) {
				logger.error(
					{ filePath, error: errorMessage },
					"Failed to index file due to embedding/model loading failure. " +
						"Check HuggingFace cache, network connectivity, or available memory.",
				);
			} else {
				logger.warn({ filePath, error: errorMessage }, "Failed to read or process file");
			}
			return null;
		}
	}

	/**
	 * Index a directory
	 */
	private async indexDirectory(dirPath: string, source: string, recursive: boolean): Promise<IndexResult[]> {
		const pattern = recursive ? "**/*" : "*";
		const files = await glob(pattern, {
			cwd: dirPath,
			nodir: true,
			absolute: true,
		});

		const results: IndexResult[] = [];

		for (const file of files) {
			const result = await this.indexSingleFile(file, source);
			if (result) {
				results.push(result);
			}
		}

		logger.info({ dirPath, filesIndexed: results.length, recursive }, "Directory indexed");

		return results;
	}

	/**
	 * Search the RAG index
	 */
	async search(query: string, options: Partial<SearchOptions> = {}): Promise<SearchResult[]> {
		return this.searcher.search({
			query,
			...options,
		});
	}

	/**
	 * Get all indexed documents
	 */
	getDocuments(source?: string): Document[] {
		return getDocuments(source, this.stateDir);
	}

	/**
	 * Remove a document from the index
	 */
	removeDocument(documentId: string): boolean {
		const deleted = deleteDocument(documentId, this.stateDir);
		if (deleted) {
			logger.info({ documentId }, "Document removed from index");
		}
		return deleted;
	}

	/**
	 * Get RAG statistics
	 */
	getStats(): RAGStats {
		return getRAGStats(this.stateDir);
	}

	/**
	 * Clear all RAG data
	 */
	clear(): void {
		clearRAGData(this.stateDir);
		logger.info("RAG index cleared");
	}
}

// Singleton instance for convenience
let defaultEngine: RAGEngine | null = null;

/**
 * Get or create the default RAG engine instance
 */
export function getRAGEngine(stateDir?: string): RAGEngine {
	if (!defaultEngine || (stateDir && stateDir !== ".undercity")) {
		defaultEngine = new RAGEngine({ stateDir });
	}
	return defaultEngine;
}

/**
 * Reset the default engine (for testing)
 */
export function resetRAGEngine(): void {
	defaultEngine = null;
}
