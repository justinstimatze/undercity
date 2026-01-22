/**
 * RAG Module Types
 *
 * Core type definitions for the RAG (Retrieval-Augmented Generation) system.
 * Provides semantic search over documents using hybrid vector + FTS5 search.
 */

/**
 * A document stored in the RAG system
 */
export interface Document {
	id: string;
	source: string;
	title: string;
	filePath?: string;
	fileHash?: string;
	metadata: Record<string, unknown>;
	indexedAt?: Date;
}

/**
 * A chunk of content from a document
 */
export interface Chunk {
	id: string;
	documentId: string;
	sequence: number;
	content: string;
	tokenCount: number;
	metadata: Record<string, unknown>;
}

/**
 * Options for searching the RAG index
 */
export interface SearchOptions {
	query: string;
	limit?: number; // default 10
	vectorWeight?: number; // default 0.7
	ftsWeight?: number; // default 0.3
	sources?: string[];
}

/**
 * A search result from the RAG index
 */
export interface SearchResult {
	chunk: Chunk;
	document: Document;
	score: number;
	vectorScore?: number;
	ftsScore?: number;
}

/**
 * Result from indexing a document or content
 */
export interface IndexResult {
	documentId: string;
	chunksCreated: number;
	tokensIndexed: number;
}

/**
 * Options for indexing content programmatically (not from file)
 */
export interface IndexContentOptions {
	content: string;
	source: string;
	title: string;
	metadata?: Record<string, unknown>;
}

/**
 * Options for indexing a file
 */
export interface IndexFileOptions {
	filePath: string;
	source: string;
	recursive?: boolean;
}

/**
 * RAG index statistics
 */
export interface RAGStats {
	documentCount: number;
	chunkCount: number;
	embeddingDimensions: number;
	sources: Array<{ source: string; documentCount: number; chunkCount: number }>;
}

/**
 * Database row types for SQLite mapping
 */
export interface DocumentRow {
	id: string;
	source: string;
	title: string;
	file_path: string | null;
	file_hash: string | null;
	metadata: string;
	indexed_at: string | null;
	created_at: string;
}

export interface ChunkRow {
	id: string;
	document_id: string;
	sequence: number;
	content: string;
	token_count: number;
	metadata: string;
	created_at: string;
	rowid?: number;
}
