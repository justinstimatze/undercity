/**
 * Vector Embeddings for Semantic Search
 *
 * Implements TF-IDF based vector representations for semantic similarity search.
 * Works offline without external API dependencies.
 *
 * Features:
 * - TF-IDF vectorization with sparse storage
 * - Cosine similarity search
 * - Incremental vocabulary updates
 * - SQLite-backed persistence
 *
 * Future: Can be upgraded to use real embedding models when available.
 */

import { sessionLogger } from "./logger.js";
import { getDatabase } from "./storage.js";

const logger = sessionLogger.child({ module: "embeddings" });

const DEFAULT_STATE_DIR = ".undercity";

// =============================================================================
// Text Preprocessing
// =============================================================================

/** Stop words to filter from content */
const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"must",
	"shall",
	"can",
	"need",
	"dare",
	"and",
	"or",
	"but",
	"if",
	"then",
	"else",
	"when",
	"while",
	"as",
	"at",
	"by",
	"for",
	"with",
	"about",
	"against",
	"between",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"to",
	"from",
	"up",
	"down",
	"in",
	"out",
	"on",
	"off",
	"over",
	"under",
	"again",
	"further",
	"then",
	"once",
	"here",
	"there",
	"where",
	"why",
	"how",
	"all",
	"each",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"nor",
	"not",
	"only",
	"own",
	"same",
	"so",
	"than",
	"too",
	"very",
	"just",
	"also",
	"now",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
]);

/** Common programming tokens to keep */
const PROGRAMMING_TOKENS = new Set([
	"function",
	"class",
	"interface",
	"type",
	"const",
	"let",
	"var",
	"async",
	"await",
	"return",
	"import",
	"export",
	"default",
	"module",
	"error",
	"warning",
	"test",
	"fix",
	"bug",
	"feature",
	"refactor",
	"update",
	"add",
	"remove",
	"delete",
	"create",
	"modify",
	"change",
	"api",
	"http",
	"get",
	"post",
	"put",
	"patch",
	"request",
	"response",
	"database",
	"query",
	"schema",
	"table",
	"index",
	"migration",
	"component",
	"hook",
	"state",
	"props",
	"render",
	"effect",
	"promise",
	"callback",
	"event",
	"listener",
	"handler",
]);

/**
 * Tokenize text into normalized terms
 */
export function tokenize(text: string): string[] {
	// Convert to lowercase
	const lower = text.toLowerCase();

	// Split on non-alphanumeric, keeping underscores and hyphens
	const tokens = lower.split(/[^a-z0-9_-]+/).filter(Boolean);

	// Split camelCase and snake_case
	const expanded: string[] = [];
	for (const token of tokens) {
		// Split camelCase: "camelCase" -> ["camel", "case"]
		const camelParts = token
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.split(" ");
		// Split snake_case: "snake_case" -> ["snake", "case"]
		const snakeParts = camelParts.flatMap((p) => p.split("_"));
		// Split kebab-case: "kebab-case" -> ["kebab", "case"]
		const kebabParts = snakeParts.flatMap((p) => p.split("-"));
		expanded.push(...kebabParts);
	}

	// Filter tokens
	return expanded.filter((token) => {
		// Must be at least 2 characters
		if (token.length < 2) return false;
		// Keep programming tokens regardless of stop words
		if (PROGRAMMING_TOKENS.has(token)) return true;
		// Filter stop words
		if (STOP_WORDS.has(token)) return false;
		// Keep the rest
		return true;
	});
}

/**
 * Calculate term frequencies for a document
 */
export function termFrequencies(tokens: string[]): Map<string, number> {
	const tf = new Map<string, number>();
	for (const token of tokens) {
		tf.set(token, (tf.get(token) || 0) + 1);
	}

	// Normalize by document length (log-normalized TF)
	const maxFreq = Math.max(...tf.values());
	for (const [term, count] of tf) {
		tf.set(term, 0.5 + 0.5 * (count / maxFreq));
	}

	return tf;
}

// =============================================================================
// Vocabulary Management
// =============================================================================

interface VocabularyEntry {
	term: string;
	docFreq: number; // Number of documents containing this term
	termId: number; // For sparse vector indexing
}

/**
 * Load or initialize vocabulary from database
 */
function loadVocabulary(stateDir: string = DEFAULT_STATE_DIR): Map<string, VocabularyEntry> {
	const db = getDatabase(stateDir);

	// Ensure vocabulary table exists
	db.exec(`
		CREATE TABLE IF NOT EXISTS vocabulary (
			term TEXT PRIMARY KEY,
			doc_freq INTEGER NOT NULL DEFAULT 1,
			term_id INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_vocabulary_term_id ON vocabulary(term_id);
	`);

	const rows = db.prepare("SELECT term, doc_freq, term_id FROM vocabulary").all() as Array<{
		term: string;
		doc_freq: number;
		term_id: number;
	}>;

	const vocab = new Map<string, VocabularyEntry>();
	for (const row of rows) {
		vocab.set(row.term, { term: row.term, docFreq: row.doc_freq, termId: row.term_id });
	}

	return vocab;
}

/**
 * Get or create vocabulary entry for a term
 */
function getOrCreateTerm(term: string, vocab: Map<string, VocabularyEntry>, stateDir: string): VocabularyEntry {
	let entry = vocab.get(term);
	if (entry) {
		return entry;
	}

	const db = getDatabase(stateDir);
	const nextId = vocab.size;

	db.prepare("INSERT OR IGNORE INTO vocabulary (term, doc_freq, term_id) VALUES (?, 1, ?)").run(term, nextId);

	entry = { term, docFreq: 1, termId: nextId };
	vocab.set(term, entry);

	return entry;
}

/**
 * Increment document frequency for terms
 */
function incrementDocFreqs(terms: Set<string>, stateDir: string): void {
	const db = getDatabase(stateDir);
	const stmt = db.prepare("UPDATE vocabulary SET doc_freq = doc_freq + 1 WHERE term = ?");

	const transaction = db.transaction(() => {
		for (const term of terms) {
			stmt.run(term);
		}
	});

	transaction();
}

/**
 * Get total document count for IDF calculation
 */
function getDocCount(stateDir: string): number {
	const db = getDatabase(stateDir);
	const result = db.prepare("SELECT COUNT(*) as count FROM learnings WHERE embedding IS NOT NULL").get() as {
		count: number;
	};
	return Math.max(1, result.count);
}

// =============================================================================
// TF-IDF Vectors
// =============================================================================

/**
 * Sparse vector representation (only non-zero terms)
 */
export interface SparseVector {
	indices: number[];
	values: number[];
	magnitude: number;
}

/**
 * Serialize sparse vector to buffer for SQLite storage
 */
function serializeVector(vec: SparseVector): Buffer {
	// Format: [count (4 bytes)] [indices...] [values...] [magnitude (8 bytes)]
	const count = vec.indices.length;
	const buffer = Buffer.alloc(4 + count * 4 + count * 8 + 8);

	let offset = 0;
	buffer.writeUInt32LE(count, offset);
	offset += 4;

	for (const idx of vec.indices) {
		buffer.writeUInt32LE(idx, offset);
		offset += 4;
	}

	for (const val of vec.values) {
		buffer.writeDoubleLE(val, offset);
		offset += 8;
	}

	buffer.writeDoubleLE(vec.magnitude, offset);

	return buffer;
}

/**
 * Deserialize sparse vector from buffer
 */
function deserializeVector(buffer: Buffer): SparseVector {
	let offset = 0;
	const count = buffer.readUInt32LE(offset);
	offset += 4;

	const indices: number[] = [];
	for (let i = 0; i < count; i++) {
		indices.push(buffer.readUInt32LE(offset));
		offset += 4;
	}

	const values: number[] = [];
	for (let i = 0; i < count; i++) {
		values.push(buffer.readDoubleLE(offset));
		offset += 8;
	}

	const magnitude = buffer.readDoubleLE(offset);

	return { indices, values, magnitude };
}

/**
 * Calculate TF-IDF vector for content
 *
 * @param content - Text content to vectorize
 * @param vocab - Vocabulary map for term lookups
 * @param docCount - Total document count for IDF calculation
 * @param stateDir - State directory for database operations
 * @returns Sparse vector representation. On error, returns an empty vector with zero magnitude.
 */
export function calculateVector(
	content: string,
	vocab: Map<string, VocabularyEntry>,
	docCount: number,
	stateDir: string,
): SparseVector {
	try {
		const tokens = tokenize(content);
		const tf = termFrequencies(tokens);

		const indices: number[] = [];
		const values: number[] = [];
		let magnitude = 0;

		for (const [term, tfValue] of tf) {
			const entry = getOrCreateTerm(term, vocab, stateDir);
			// Use smoothed IDF that works well with small corpora
			// Formula: log(1 + (docCount + 1) / (docFreq + 1))
			// This ensures IDF is always positive and scales reasonably
			const idf = Math.log(1 + (docCount + 1) / (entry.docFreq + 1));
			const tfidf = tfValue * idf;

			// Always include terms (no zero-filtering with smoothed IDF)
			indices.push(entry.termId);
			values.push(tfidf);
			magnitude += tfidf * tfidf;
		}

		magnitude = Math.sqrt(magnitude);

		return { indices, values, magnitude };
	} catch (error) {
		logger.warn(
			{
				error: String(error),
				contentLength: content?.length ?? 0,
				contentPreview: content?.substring(0, 100) ?? "",
			},
			"Failed to calculate TF-IDF vector, returning empty vector",
		);
		return { indices: [], values: [], magnitude: 0 };
	}
}

/**
 * Calculate cosine similarity between two sparse vectors
 */
export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
	if (a.magnitude === 0 || b.magnitude === 0) {
		return 0;
	}

	// Create index maps for efficient lookup
	const aMap = new Map<number, number>();
	for (let i = 0; i < a.indices.length; i++) {
		aMap.set(a.indices[i], a.values[i]);
	}

	let dotProduct = 0;
	for (let i = 0; i < b.indices.length; i++) {
		const aValue = aMap.get(b.indices[i]);
		if (aValue !== undefined) {
			dotProduct += aValue * b.values[i];
		}
	}

	return dotProduct / (a.magnitude * b.magnitude);
}

// =============================================================================
// Learning Embeddings
// =============================================================================

/**
 * Generate and store embedding for a learning
 */
export function embedLearning(learningId: string, content: string, stateDir: string = DEFAULT_STATE_DIR): void {
	const vocab = loadVocabulary(stateDir);
	const docCount = getDocCount(stateDir);
	const vector = calculateVector(content, vocab, docCount, stateDir);

	// Store embedding
	const db = getDatabase(stateDir);
	const buffer = serializeVector(vector);

	db.prepare("UPDATE learnings SET embedding = ? WHERE id = ?").run(buffer, learningId);

	// Update document frequencies
	const tokens = tokenize(content);
	const uniqueTerms = new Set(tokens);
	incrementDocFreqs(uniqueTerms, stateDir);

	logger.debug({ learningId, vectorSize: vector.indices.length }, "Generated embedding for learning");
}

/**
 * Generate embeddings for all learnings without them
 */
export function embedAllLearnings(stateDir: string = DEFAULT_STATE_DIR): number {
	const db = getDatabase(stateDir);

	const rows = db.prepare("SELECT id, content FROM learnings WHERE embedding IS NULL").all() as Array<{
		id: string;
		content: string;
	}>;

	let count = 0;
	for (const row of rows) {
		try {
			embedLearning(row.id, row.content, stateDir);
			count++;
		} catch (err) {
			logger.warn({ learningId: row.id, error: String(err) }, "Failed to embed learning");
		}
	}

	logger.info({ count }, "Generated embeddings for learnings");
	return count;
}

/**
 * Search learnings by semantic similarity
 */
export function searchBySemanticSimilarity(
	query: string,
	limit: number = 10,
	minSimilarity: number = 0.1,
	stateDir: string = DEFAULT_STATE_DIR,
): Array<{ learningId: string; similarity: number }> {
	const vocab = loadVocabulary(stateDir);
	const docCount = getDocCount(stateDir);
	const queryVector = calculateVector(query, vocab, docCount, stateDir);

	if (queryVector.magnitude === 0) {
		return [];
	}

	const db = getDatabase(stateDir);
	const rows = db.prepare("SELECT id, embedding FROM learnings WHERE embedding IS NOT NULL").all() as Array<{
		id: string;
		embedding: Buffer;
	}>;

	const results: Array<{ learningId: string; similarity: number }> = [];

	for (const row of rows) {
		const docVector = deserializeVector(row.embedding);
		const similarity = cosineSimilarity(queryVector, docVector);

		if (similarity >= minSimilarity) {
			results.push({ learningId: row.id, similarity });
		}
	}

	// Sort by similarity descending
	results.sort((a, b) => b.similarity - a.similarity);

	return results.slice(0, limit);
}

/**
 * Enhanced search combining keyword and semantic similarity
 */
export function hybridSearch(
	query: string,
	options: {
		limit?: number;
		keywordWeight?: number;
		semanticWeight?: number;
		minScore?: number;
	} = {},
	stateDir: string = DEFAULT_STATE_DIR,
): Array<{ learningId: string; score: number; keywordScore: number; semanticScore: number }> {
	const { limit = 10, keywordWeight = 0.4, semanticWeight = 0.6, minScore = 0.1 } = options;

	const db = getDatabase(stateDir);
	const vocab = loadVocabulary(stateDir);
	const docCount = getDocCount(stateDir);

	// Get query tokens and vector
	const queryTokens = tokenize(query);
	const queryVector = calculateVector(query, vocab, docCount, stateDir);

	// Score all learnings
	const scores = new Map<string, { keyword: number; semantic: number }>();

	// Keyword scoring
	const keywordConditions = queryTokens.map(() => "keywords LIKE ?").join(" OR ");
	const keywordParams = queryTokens.map((t) => `%"${t}"%`);

	if (keywordConditions) {
		const keywordRows = db
			.prepare(
				`
			SELECT id, keywords FROM learnings
			WHERE ${keywordConditions}
		`,
			)
			.all(...keywordParams) as Array<{ id: string; keywords: string }>;

		for (const row of keywordRows) {
			const keywords = JSON.parse(row.keywords) as string[];
			const matches = queryTokens.filter((t) => keywords.includes(t)).length;
			const keywordScore = matches / Math.max(queryTokens.length, 1);
			scores.set(row.id, { keyword: keywordScore, semantic: 0 });
		}
	}

	// Semantic scoring
	if (queryVector.magnitude > 0) {
		const embeddingRows = db.prepare("SELECT id, embedding FROM learnings WHERE embedding IS NOT NULL").all() as Array<{
			id: string;
			embedding: Buffer;
		}>;

		for (const row of embeddingRows) {
			const docVector = deserializeVector(row.embedding);
			const similarity = cosineSimilarity(queryVector, docVector);

			const existing = scores.get(row.id);
			if (existing) {
				existing.semantic = similarity;
			} else {
				scores.set(row.id, { keyword: 0, semantic: similarity });
			}
		}
	}

	// Combine scores
	const results: Array<{ learningId: string; score: number; keywordScore: number; semanticScore: number }> = [];

	for (const [id, score] of scores) {
		const combinedScore = score.keyword * keywordWeight + score.semantic * semanticWeight;
		if (combinedScore >= minScore) {
			results.push({
				learningId: id,
				score: combinedScore,
				keywordScore: score.keyword,
				semanticScore: score.semantic,
			});
		}
	}

	// Sort by combined score
	results.sort((a, b) => b.score - a.score);

	return results.slice(0, limit);
}

// =============================================================================
// Statistics
// =============================================================================

export interface EmbeddingStats {
	vocabSize: number;
	embeddedCount: number;
	unembeddedCount: number;
	avgVectorSize: number;
}

/**
 * Get embedding statistics
 */
export function getEmbeddingStats(stateDir: string = DEFAULT_STATE_DIR): EmbeddingStats {
	const db = getDatabase(stateDir);

	// Ensure vocabulary table exists
	db.exec(`
		CREATE TABLE IF NOT EXISTS vocabulary (
			term TEXT PRIMARY KEY,
			doc_freq INTEGER NOT NULL DEFAULT 1,
			term_id INTEGER NOT NULL
		);
	`);

	const vocabSize = (db.prepare("SELECT COUNT(*) as count FROM vocabulary").get() as { count: number }).count;

	const embeddedCount = (
		db.prepare("SELECT COUNT(*) as count FROM learnings WHERE embedding IS NOT NULL").get() as { count: number }
	).count;

	const unembeddedCount = (
		db.prepare("SELECT COUNT(*) as count FROM learnings WHERE embedding IS NULL").get() as { count: number }
	).count;

	// Calculate average vector size
	let avgVectorSize = 0;
	if (embeddedCount > 0) {
		const rows = db.prepare("SELECT embedding FROM learnings WHERE embedding IS NOT NULL LIMIT 100").all() as Array<{
			embedding: Buffer;
		}>;

		let totalSize = 0;
		for (const row of rows) {
			const vec = deserializeVector(row.embedding);
			totalSize += vec.indices.length;
		}
		avgVectorSize = totalSize / rows.length;
	}

	return {
		vocabSize,
		embeddedCount,
		unembeddedCount,
		avgVectorSize,
	};
}
