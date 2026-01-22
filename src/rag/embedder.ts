/**
 * Embedder Module
 *
 * Wrapper around embeddings.js for local CPU-based embeddings.
 * Uses Xenova/all-MiniLM-L6-v2 (384 dimensions) via ONNX runtime.
 *
 * Key features:
 * - Built-in caching (re-indexing identical text reuses cached embeddings)
 * - Cache survives process restarts (.undercity/embeddings.cache.json)
 * - First call downloads ~90MB model (cached in HuggingFace cache)
 */

import Embeddings from "@themaximalist/embeddings.js";
import { sessionLogger } from "../logger.js";

const logger = sessionLogger.child({ module: "rag-embedder" });

export interface EmbedderOptions {
	cacheFile?: string; // default: .undercity/embeddings.cache.json
	cache?: boolean; // default: true
}

/**
 * Local embedder using transformers.js (ONNX runtime)
 */
export class LocalEmbedder {
	readonly dimensions = 384;
	private options: { cache: boolean; cache_file: string; service: "transformers"; model: string };
	private initialized = false;

	constructor(opts: EmbedderOptions = {}) {
		this.options = {
			cache: opts.cache ?? true,
			cache_file: opts.cacheFile ?? ".undercity/embeddings.cache.json",
			service: "transformers" as const,
			model: "Xenova/all-MiniLM-L6-v2",
		};
	}

	/**
	 * Embed a single text string
	 *
	 * First call downloads the model (~90MB). Subsequent calls with the
	 * same text return instantly from cache.
	 */
	async embed(text: string): Promise<number[]> {
		if (!this.initialized) {
			logger.info("Initializing embedder (first call may download model)");
			this.initialized = true;
		}

		try {
			// embeddings.js handles caching automatically
			const embedding = (await Embeddings(text, this.options)) as number[];
			return embedding;
		} catch (error) {
			logger.error({ error: String(error) }, "Embedding failed");
			throw error;
		}
	}

	/**
	 * Embed multiple texts in batch
	 *
	 * Runs embeddings in parallel. Duplicate texts benefit from caching.
	 */
	async embedBatch(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}

		if (!this.initialized) {
			logger.info({ count: texts.length }, "Initializing embedder for batch (first call may download model)");
			this.initialized = true;
		}

		// Process in parallel - cache handles duplicates automatically
		const results = await Promise.all(texts.map((t) => this.embed(t)));
		return results;
	}

	/**
	 * Get cache file path
	 */
	getCacheFile(): string {
		return this.options.cache_file;
	}

	/**
	 * Check if caching is enabled
	 */
	isCacheEnabled(): boolean {
		return this.options.cache;
	}
}

// Singleton instance for convenience
let defaultEmbedder: LocalEmbedder | null = null;

/**
 * Get or create the default embedder instance
 */
export function getEmbedder(opts?: EmbedderOptions): LocalEmbedder {
	if (!defaultEmbedder) {
		defaultEmbedder = new LocalEmbedder(opts);
	}
	return defaultEmbedder;
}

/**
 * Reset the default embedder (for testing)
 */
export function resetEmbedder(): void {
	defaultEmbedder = null;
}
