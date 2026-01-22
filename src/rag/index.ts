/**
 * RAG Module
 *
 * Local RAG (Retrieval-Augmented Generation) system using:
 * - embeddings.js for CPU-based embeddings (Xenova/all-MiniLM-L6-v2)
 * - sqlite-vec for vector similarity search
 * - FTS5 for keyword search
 * - Reciprocal Rank Fusion for hybrid search
 */

// Chunker
export { type Chunker, type ChunkingOptions, createChunker, ParagraphChunker } from "./chunker.js";
// Database (low-level, for advanced usage)
export {
	clearRAGData,
	closeRAGDatabase,
	deleteDocument,
	deleteEmbedding,
	ftsSearch,
	getChunkById,
	getChunkByRowid,
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
} from "./database.js";
// Embedder
export { type EmbedderOptions, getEmbedder, LocalEmbedder, resetEmbedder } from "./embedder.js";
// Engine (main entry point)
export { getRAGEngine, RAGEngine, resetRAGEngine } from "./engine.js";

// Hybrid Search
export { createHybridSearcher, HybridSearcher } from "./hybrid-search.js";
// Types
export type {
	Chunk,
	ChunkRow,
	Document,
	DocumentRow,
	IndexContentOptions,
	IndexFileOptions,
	IndexResult,
	RAGStats,
	SearchOptions,
	SearchResult,
} from "./types.js";
