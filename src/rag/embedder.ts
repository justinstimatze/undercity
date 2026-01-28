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
	 *
	 * @param text - Text to embed
	 * @returns Vector embedding of 384 dimensions
	 * @throws {Error} If model loading fails, files are missing, or ONNX runtime errors occur
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
			const errorMessage = error instanceof Error ? error.message : String(error);
			const errorStack = error instanceof Error ? error.stack : undefined;

			// Detect specific error types and provide actionable guidance
			let enhancedMessage = "Embedding generation failed";
			let resolution = "";

			// Check for missing model files (ENOENT, file not found)
			if (errorMessage.includes("ENOENT") || errorMessage.toLowerCase().includes("no such file")) {
				enhancedMessage = `Model file not found for ${this.options.model}`;
				resolution =
					"The ONNX model files may not have been downloaded. " +
					"Ensure you have internet connectivity for the first run. " +
					"Model files are cached in the HuggingFace cache directory (~/.cache/huggingface).";
			}
			// Check for ONNX runtime errors
			else if (
				errorMessage.includes("onnx") ||
				errorMessage.includes("ONNX") ||
				errorMessage.toLowerCase().includes("runtime error")
			) {
				enhancedMessage = `ONNX runtime error while loading model ${this.options.model}`;
				resolution =
					"The model files may be corrupted or incompatible with your system. " +
					"Try clearing the HuggingFace cache (~/.cache/huggingface) and re-downloading. " +
					"Ensure @xenova/transformers is properly installed.";
			}
			// Check for network/download errors
			else if (
				errorMessage.toLowerCase().includes("network") ||
				errorMessage.toLowerCase().includes("fetch") ||
				errorMessage.includes("ECONNREFUSED") ||
				errorMessage.includes("ETIMEDOUT")
			) {
				enhancedMessage = `Network error while downloading model ${this.options.model}`;
				resolution =
					"Failed to download model files from HuggingFace. " +
					"Check your internet connection and firewall settings. " +
					"If behind a proxy, configure HTTP_PROXY/HTTPS_PROXY environment variables.";
			}
			// Generic embedding error
			else {
				enhancedMessage = `Failed to generate embedding using ${this.options.model}`;
				resolution =
					"An unexpected error occurred during embedding generation. " +
					"Check that @themaximalist/embeddings.js and @xenova/transformers are installed correctly.";
			}

			// Log structured error with full context
			logger.error(
				{
					error: errorMessage,
					stack: errorStack,
					model: this.options.model,
					cacheFile: this.options.cache_file,
					cacheEnabled: this.options.cache,
				},
				enhancedMessage,
			);

			// Throw enhanced error with actionable guidance
			const fullMessage = `${enhancedMessage}. ${resolution}\n\nOriginal error: ${errorMessage}`;
			throw new Error(fullMessage);
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
