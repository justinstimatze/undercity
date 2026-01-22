/**
 * Hybrid Search Module
 *
 * Combines vector similarity search with FTS5 keyword search using
 * Reciprocal Rank Fusion (RRF) for optimal result ranking.
 *
 * Strategy:
 * 1. Run vector search and FTS5 search in parallel
 * 2. Combine results using RRF scoring
 * 3. Return top results with scores from both methods
 */

import { ftsSearch, getChunkById, getChunkByRowid, getDocumentById, vectorSearch } from "./database.js";
import type { LocalEmbedder } from "./embedder.js";
import type { SearchOptions, SearchResult } from "./types.js";

/**
 * Hybrid searcher combining vector and keyword search
 */
export class HybridSearcher {
	constructor(
		private embedder: LocalEmbedder,
		private stateDir: string = ".undercity",
	) {}

	/**
	 * Execute hybrid search combining vector and FTS5 results
	 */
	async search(options: SearchOptions): Promise<SearchResult[]> {
		const { query, limit = 10, vectorWeight = 0.7, ftsWeight = 0.3, sources } = options;

		if (!query.trim()) {
			return [];
		}

		// Generate query embedding for vector search
		const queryEmbedding = await this.embedder.embed(query);

		// Run both searches in parallel with extra results for fusion
		const fetchLimit = limit * 3; // Fetch more to allow for filtering
		const [vectorResults, ftsResults] = await Promise.all([
			this.executeVectorSearch(queryEmbedding, fetchLimit),
			this.executeFTSSearch(query, fetchLimit),
		]);

		// Apply RRF to combine results
		const fusedResults = this.reciprocalRankFusion(vectorResults, ftsResults, vectorWeight, ftsWeight);

		// Filter by sources if specified
		const filteredResults = sources?.length
			? fusedResults.filter((r) => sources.includes(r.document.source))
			: fusedResults;

		// Return top results
		return filteredResults.slice(0, limit);
	}

	/**
	 * Execute vector similarity search
	 */
	private async executeVectorSearch(queryEmbedding: number[], limit: number): Promise<SearchResult[]> {
		const results = vectorSearch(queryEmbedding, limit, this.stateDir);

		const searchResults: SearchResult[] = [];
		for (const result of results) {
			const chunk = getChunkById(result.chunkId, this.stateDir);
			if (!chunk) continue;

			const document = getDocumentById(chunk.documentId, this.stateDir);
			if (!document) continue;

			// Convert distance to similarity score (1 / (1 + distance))
			const vectorScore = 1 / (1 + result.distance);

			searchResults.push({
				chunk,
				document,
				score: vectorScore, // Will be updated by RRF
				vectorScore,
			});
		}

		return searchResults;
	}

	/**
	 * Execute FTS5 keyword search
	 */
	private async executeFTSSearch(query: string, limit: number): Promise<SearchResult[]> {
		const results = ftsSearch(query, limit, this.stateDir);

		const searchResults: SearchResult[] = [];
		for (const result of results) {
			const chunk = getChunkByRowid(result.rowid, this.stateDir);
			if (!chunk) continue;

			const document = getDocumentById(chunk.documentId, this.stateDir);
			if (!document) continue;

			// BM25 scores are negative (closer to 0 = more relevant)
			// Convert to positive score
			const ftsScore = Math.abs(result.score);

			searchResults.push({
				chunk,
				document,
				score: ftsScore, // Will be updated by RRF
				ftsScore,
			});
		}

		return searchResults;
	}

	/**
	 * Combine results using Reciprocal Rank Fusion
	 *
	 * RRF formula: score = sum(weight / (k + rank))
	 * where k is a constant (default 60) to prevent high scores for top results
	 */
	private reciprocalRankFusion(
		vectorResults: SearchResult[],
		ftsResults: SearchResult[],
		vectorWeight: number,
		ftsWeight: number,
		k = 60,
	): SearchResult[] {
		// Map from chunk ID to combined result
		const scores = new Map<string, { result: SearchResult; rrfScore: number }>();

		// Add vector search results
		vectorResults.forEach((result, rank) => {
			const rrfScore = vectorWeight / (k + rank + 1);
			scores.set(result.chunk.id, {
				result: { ...result },
				rrfScore,
			});
		});

		// Add FTS search results
		ftsResults.forEach((result, rank) => {
			const rrfScore = ftsWeight / (k + rank + 1);
			const existing = scores.get(result.chunk.id);

			if (existing) {
				// Chunk found in both searches - add scores
				existing.rrfScore += rrfScore;
				// Preserve FTS score in existing result
				existing.result.ftsScore = result.ftsScore;
			} else {
				// New chunk from FTS
				scores.set(result.chunk.id, {
					result: { ...result },
					rrfScore,
				});
			}
		});

		// Sort by combined RRF score
		return [...scores.values()]
			.sort((a, b) => b.rrfScore - a.rrfScore)
			.map(({ result, rrfScore }) => ({
				...result,
				score: rrfScore,
			}));
	}
}

/**
 * Create a hybrid searcher instance
 */
export function createHybridSearcher(embedder: LocalEmbedder, stateDir?: string): HybridSearcher {
	return new HybridSearcher(embedder, stateDir);
}
