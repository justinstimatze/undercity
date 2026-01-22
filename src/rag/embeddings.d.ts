/**
 * Type declarations for @themaximalist/embeddings.js
 *
 * This package doesn't have TypeScript types, so we declare them here.
 */

declare module "@themaximalist/embeddings.js" {
	interface EmbeddingsOptions {
		service?: "transformers" | "openai" | "mistral" | "modeldeployer";
		model?: string;
		cache?: boolean;
		cache_file?: string;
	}

	/**
	 * Generate embeddings for text.
	 *
	 * Can be called as a function or instantiated as a class:
	 * - `Embeddings("text")` - returns Promise<number[]>
	 * - `Embeddings("text", options)` - returns Promise<number[]>
	 * - `new Embeddings(options).fetch("text")` - returns Promise<number[]>
	 */
	function Embeddings(input: string, options?: EmbeddingsOptions): Promise<number[]>;

	namespace Embeddings {
		const defaultService: string;
		const defaultModel: string;
	}

	export = Embeddings;
}
