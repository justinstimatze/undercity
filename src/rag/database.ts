/**
 * RAG Database Layer
 *
 * SQLite storage for RAG documents, chunks, and embeddings using:
 * - sqlite-vec for vector similarity search
 * - FTS5 for keyword search
 * - better-sqlite3 as the base driver
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { sessionLogger } from "../logger.js";
import type { Chunk, ChunkRow, Document, DocumentRow, RAGStats } from "./types.js";

const logger = sessionLogger.child({ module: "rag-database" });

const DEFAULT_STATE_DIR = ".undercity";
const RAG_DB_FILENAME = "rag.db";
const EMBEDDING_DIMENSIONS = 384; // all-MiniLM-L6-v2

// Singleton instance
let ragDbInstance: Database.Database | null = null;

/**
 * Get or create the RAG database connection
 */
export function getRAGDatabase(stateDir: string = DEFAULT_STATE_DIR): Database.Database {
	if (ragDbInstance) {
		return ragDbInstance;
	}

	const dbPath = join(stateDir, RAG_DB_FILENAME);

	// Ensure directory exists
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true });
	}

	ragDbInstance = new Database(dbPath);

	// Enable WAL mode for better concurrent access
	ragDbInstance.pragma("journal_mode = WAL");
	ragDbInstance.pragma("busy_timeout = 5000");
	ragDbInstance.pragma("synchronous = NORMAL");

	// Load sqlite-vec extension for vector operations
	loadSqliteVec(ragDbInstance);

	// Initialize schema
	initializeRAGSchema(ragDbInstance);

	logger.info({ path: dbPath }, "RAG database initialized");

	return ragDbInstance;
}

/**
 * Close the RAG database connection
 */
export function closeRAGDatabase(): void {
	if (ragDbInstance) {
		ragDbInstance.close();
		ragDbInstance = null;
		logger.debug("RAG database connection closed");
	}
}

/**
 * Reset RAG database instance (for testing)
 */
export function resetRAGDatabase(): void {
	closeRAGDatabase();
}

/**
 * Initialize the RAG schema
 */
function initializeRAGSchema(db: Database.Database): void {
	db.exec(`
		-- Documents table
		CREATE TABLE IF NOT EXISTS rag_documents (
			id TEXT PRIMARY KEY,
			source TEXT NOT NULL,
			title TEXT NOT NULL,
			file_path TEXT,
			file_hash TEXT,
			metadata TEXT NOT NULL DEFAULT '{}',
			indexed_at TEXT,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_rag_documents_source ON rag_documents(source);
		CREATE INDEX IF NOT EXISTS idx_rag_documents_file_hash ON rag_documents(file_hash);

		-- Chunks table
		CREATE TABLE IF NOT EXISTS rag_chunks (
			id TEXT PRIMARY KEY,
			document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL,
			content TEXT NOT NULL,
			token_count INTEGER NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		);

		CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON rag_chunks(document_id);

		-- Vector embeddings table (384 dimensions for all-MiniLM-L6-v2)
		CREATE VIRTUAL TABLE IF NOT EXISTS rag_embeddings USING vec0(
			chunk_id TEXT PRIMARY KEY,
			embedding FLOAT[${EMBEDDING_DIMENSIONS}]
		);

		-- FTS5 for keyword search
		CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
			content,
			content='rag_chunks',
			content_rowid='rowid'
		);

		-- Sync triggers for FTS5
		CREATE TRIGGER IF NOT EXISTS rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
			INSERT INTO rag_chunks_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
		END;

		CREATE TRIGGER IF NOT EXISTS rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
			INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
		END;

		CREATE TRIGGER IF NOT EXISTS rag_chunks_au AFTER UPDATE ON rag_chunks BEGIN
			INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
			INSERT INTO rag_chunks_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
		END;
	`);
}

// =============================================================================
// Document Operations
// =============================================================================

/**
 * Insert a new document
 */
export function insertDocument(doc: Document, stateDir: string = DEFAULT_STATE_DIR): void {
	const db = getRAGDatabase(stateDir);

	const stmt = db.prepare(`
		INSERT INTO rag_documents (id, source, title, file_path, file_hash, metadata, indexed_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);

	stmt.run(
		doc.id,
		doc.source,
		doc.title,
		doc.filePath ?? null,
		doc.fileHash ?? null,
		JSON.stringify(doc.metadata),
		doc.indexedAt?.toISOString() ?? null,
		new Date().toISOString(),
	);
}

/**
 * Get document by ID
 */
export function getDocumentById(id: string, stateDir: string = DEFAULT_STATE_DIR): Document | null {
	const db = getRAGDatabase(stateDir);
	const row = db.prepare("SELECT * FROM rag_documents WHERE id = ?").get(id) as DocumentRow | undefined;
	return row ? rowToDocument(row) : null;
}

/**
 * Get document by file hash (for deduplication)
 */
export function getDocumentByFileHash(fileHash: string, stateDir: string = DEFAULT_STATE_DIR): Document | null {
	const db = getRAGDatabase(stateDir);
	const row = db.prepare("SELECT * FROM rag_documents WHERE file_hash = ?").get(fileHash) as DocumentRow | undefined;
	return row ? rowToDocument(row) : null;
}

/**
 * Get all documents, optionally filtered by source
 */
export function getDocuments(source?: string, stateDir: string = DEFAULT_STATE_DIR): Document[] {
	const db = getRAGDatabase(stateDir);

	let rows: DocumentRow[];
	if (source) {
		rows = db
			.prepare("SELECT * FROM rag_documents WHERE source = ? ORDER BY created_at DESC")
			.all(source) as DocumentRow[];
	} else {
		rows = db.prepare("SELECT * FROM rag_documents ORDER BY created_at DESC").all() as DocumentRow[];
	}

	return rows.map(rowToDocument);
}

/**
 * Delete document and all associated chunks/embeddings
 */
export function deleteDocument(id: string, stateDir: string = DEFAULT_STATE_DIR): boolean {
	const db = getRAGDatabase(stateDir);

	// Delete embeddings for chunks of this document
	db.prepare(`
		DELETE FROM rag_embeddings WHERE chunk_id IN (
			SELECT id FROM rag_chunks WHERE document_id = ?
		)
	`).run(id);

	// Delete chunks (triggers will handle FTS5)
	db.prepare("DELETE FROM rag_chunks WHERE document_id = ?").run(id);

	// Delete document
	const result = db.prepare("DELETE FROM rag_documents WHERE id = ?").run(id);

	return result.changes > 0;
}

function rowToDocument(row: DocumentRow): Document {
	return {
		id: row.id,
		source: row.source,
		title: row.title,
		filePath: row.file_path ?? undefined,
		fileHash: row.file_hash ?? undefined,
		metadata: JSON.parse(row.metadata) as Record<string, unknown>,
		indexedAt: row.indexed_at ? new Date(row.indexed_at) : undefined,
	};
}

// =============================================================================
// Chunk Operations
// =============================================================================

/**
 * Insert a chunk
 */
export function insertChunk(chunk: Chunk, stateDir: string = DEFAULT_STATE_DIR): void {
	const db = getRAGDatabase(stateDir);

	const stmt = db.prepare(`
		INSERT INTO rag_chunks (id, document_id, sequence, content, token_count, metadata, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);

	stmt.run(
		chunk.id,
		chunk.documentId,
		chunk.sequence,
		chunk.content,
		chunk.tokenCount,
		JSON.stringify(chunk.metadata),
		new Date().toISOString(),
	);
}

/**
 * Get chunks for a document
 */
export function getChunksForDocument(documentId: string, stateDir: string = DEFAULT_STATE_DIR): Chunk[] {
	const db = getRAGDatabase(stateDir);
	const rows = db
		.prepare("SELECT * FROM rag_chunks WHERE document_id = ? ORDER BY sequence")
		.all(documentId) as ChunkRow[];
	return rows.map(rowToChunk);
}

/**
 * Get chunk by ID
 */
export function getChunkById(id: string, stateDir: string = DEFAULT_STATE_DIR): Chunk | null {
	const db = getRAGDatabase(stateDir);
	const row = db.prepare("SELECT * FROM rag_chunks WHERE id = ?").get(id) as ChunkRow | undefined;
	return row ? rowToChunk(row) : null;
}

function rowToChunk(row: ChunkRow): Chunk {
	return {
		id: row.id,
		documentId: row.document_id,
		sequence: row.sequence,
		content: row.content,
		tokenCount: row.token_count,
		metadata: JSON.parse(row.metadata) as Record<string, unknown>,
	};
}

// =============================================================================
// Embedding Operations
// =============================================================================

/**
 * Insert an embedding for a chunk
 */
export function insertEmbedding(chunkId: string, embedding: number[], stateDir: string = DEFAULT_STATE_DIR): void {
	const db = getRAGDatabase(stateDir);

	// Convert embedding array to JSON string for sqlite-vec
	const embeddingJson = JSON.stringify(embedding);

	db.prepare("INSERT INTO rag_embeddings (chunk_id, embedding) VALUES (?, ?)").run(chunkId, embeddingJson);
}

/**
 * Delete embedding for a chunk
 */
export function deleteEmbedding(chunkId: string, stateDir: string = DEFAULT_STATE_DIR): void {
	const db = getRAGDatabase(stateDir);
	db.prepare("DELETE FROM rag_embeddings WHERE chunk_id = ?").run(chunkId);
}

/**
 * Vector similarity search - returns chunk IDs with distances
 */
export function vectorSearch(
	queryEmbedding: number[],
	limit: number,
	stateDir: string = DEFAULT_STATE_DIR,
): Array<{ chunkId: string; distance: number }> {
	const db = getRAGDatabase(stateDir);

	// Convert embedding to JSON for sqlite-vec
	const embeddingJson = JSON.stringify(queryEmbedding);

	// Use vec_distance_L2 for Euclidean distance (lower = more similar)
	const rows = db
		.prepare(
			`
		SELECT chunk_id, distance
		FROM rag_embeddings
		WHERE embedding MATCH ?
		ORDER BY distance
		LIMIT ?
	`,
		)
		.all(embeddingJson, limit) as Array<{ chunk_id: string; distance: number }>;

	return rows.map((row) => ({
		chunkId: row.chunk_id,
		distance: row.distance,
	}));
}

// =============================================================================
// FTS5 Operations
// =============================================================================

/**
 * Full-text search - returns chunk rowids with BM25 scores
 */
export function ftsSearch(
	query: string,
	limit: number,
	stateDir: string = DEFAULT_STATE_DIR,
): Array<{ rowid: number; score: number }> {
	const db = getRAGDatabase(stateDir);

	// Escape special FTS5 characters and create search query
	const safeQuery = query.replace(/['"]/g, "").trim();
	if (!safeQuery) {
		return [];
	}

	// Use bm25() for relevance scoring (negative, closer to 0 = more relevant)
	const rows = db
		.prepare(
			`
		SELECT rowid, bm25(rag_chunks_fts) as score
		FROM rag_chunks_fts
		WHERE rag_chunks_fts MATCH ?
		ORDER BY score
		LIMIT ?
	`,
		)
		.all(safeQuery, limit) as Array<{ rowid: number; score: number }>;

	return rows;
}

/**
 * Get chunk by rowid (for FTS5 results)
 */
export function getChunkByRowid(rowid: number, stateDir: string = DEFAULT_STATE_DIR): Chunk | null {
	const db = getRAGDatabase(stateDir);
	const row = db.prepare("SELECT * FROM rag_chunks WHERE rowid = ?").get(rowid) as ChunkRow | undefined;
	return row ? rowToChunk(row) : null;
}

// =============================================================================
// Statistics
// =============================================================================

/**
 * Get RAG index statistics
 */
export function getRAGStats(stateDir: string = DEFAULT_STATE_DIR): RAGStats {
	const db = getRAGDatabase(stateDir);

	const docCount = (db.prepare("SELECT COUNT(*) as count FROM rag_documents").get() as { count: number }).count;
	const chunkCount = (db.prepare("SELECT COUNT(*) as count FROM rag_chunks").get() as { count: number }).count;

	const sourceStats = db
		.prepare(
			`
		SELECT
			d.source,
			COUNT(DISTINCT d.id) as doc_count,
			COUNT(c.id) as chunk_count
		FROM rag_documents d
		LEFT JOIN rag_chunks c ON d.id = c.document_id
		GROUP BY d.source
	`,
		)
		.all() as Array<{ source: string; doc_count: number; chunk_count: number }>;

	return {
		documentCount: docCount,
		chunkCount: chunkCount,
		embeddingDimensions: EMBEDDING_DIMENSIONS,
		sources: sourceStats.map((s) => ({
			source: s.source,
			documentCount: s.doc_count,
			chunkCount: s.chunk_count,
		})),
	};
}

/**
 * Clear all RAG data (for testing or reset)
 */
export function clearRAGData(stateDir: string = DEFAULT_STATE_DIR): void {
	const db = getRAGDatabase(stateDir);

	db.exec(`
		DELETE FROM rag_embeddings;
		DELETE FROM rag_chunks;
		DELETE FROM rag_documents;
	`);

	logger.info("RAG data cleared");
}
