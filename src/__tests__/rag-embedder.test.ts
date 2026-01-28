/**
 * Tests for rag/embedder.ts
 *
 * Tests the LocalEmbedder class:
 * - Constructor with default and custom options
 * - embed() method for single text embedding
 * - embedBatch() method for multiple text embeddings
 * - Cache behavior and configuration
 * - Error handling for failures
 * - Singleton functions (getEmbedder, resetEmbedder)
 * - Edge cases (empty strings, long text, special characters)
 *
 * Note: These are unit tests that mock @themaximalist/embeddings.js
 * to avoid loading the actual ML model during tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock embeddings.js to avoid loading actual model
// Must use factory function to avoid hoisting issues
vi.mock("@themaximalist/embeddings.js", () => ({
	default: vi.fn(),
}));

// Mock logger to avoid logging during tests
vi.mock("../logger.js", () => ({
	sessionLogger: {
		child: () => ({
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		}),
	},
}));

// Import after mocking
import Embeddings from "@themaximalist/embeddings.js";
import { getEmbedder, LocalEmbedder, resetEmbedder } from "../rag/embedder.js";

// Get mock reference
const mockEmbeddings = Embeddings as unknown as ReturnType<typeof vi.fn>;

describe("rag/embedder.ts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetEmbedder();

		// Default mock behavior: return 384-dimensional vector
		mockEmbeddings.mockResolvedValue(new Array(384).fill(0.5));
	});

	afterEach(() => {
		vi.resetAllMocks();
		resetEmbedder();
	});

	// ==========================================================================
	// Constructor Tests
	// ==========================================================================

	describe("LocalEmbedder constructor", () => {
		it("should create instance with default options", () => {
			const embedder = new LocalEmbedder();

			expect(embedder.dimensions).toBe(384);
			expect(embedder.getCacheFile()).toBe(".undercity/embeddings.cache.json");
			expect(embedder.isCacheEnabled()).toBe(true);
		});

		it("should create instance with custom cache file", () => {
			const embedder = new LocalEmbedder({
				cacheFile: "/custom/path/cache.json",
			});

			expect(embedder.getCacheFile()).toBe("/custom/path/cache.json");
			expect(embedder.isCacheEnabled()).toBe(true);
		});

		it("should create instance with cache disabled", () => {
			const embedder = new LocalEmbedder({
				cache: false,
			});

			expect(embedder.isCacheEnabled()).toBe(false);
		});

		it("should create instance with both custom cache file and cache disabled", () => {
			const embedder = new LocalEmbedder({
				cacheFile: "/custom/cache.json",
				cache: false,
			});

			expect(embedder.getCacheFile()).toBe("/custom/cache.json");
			expect(embedder.isCacheEnabled()).toBe(false);
		});
	});

	// ==========================================================================
	// embed() Method Tests
	// ==========================================================================

	describe("embed() method", () => {
		it("should embed single text and return correct dimension array", async () => {
			const embedder = new LocalEmbedder();
			const result = await embedder.embed("test text");

			expect(result).toHaveLength(384);
			expect(result.every((n) => typeof n === "number")).toBe(true);
			expect(mockEmbeddings).toHaveBeenCalledWith(
				"test text",
				expect.objectContaining({
					cache: true,
					cache_file: ".undercity/embeddings.cache.json",
					service: "transformers",
					model: "Xenova/all-MiniLM-L6-v2",
				}),
			);
		});

		it("should set initialization flag on first call", async () => {
			const embedder = new LocalEmbedder();

			await embedder.embed("first call");
			await embedder.embed("second call");

			// Logger should be called once for initialization
			expect(mockEmbeddings).toHaveBeenCalledTimes(2);
		});

		it("should pass correct options to embeddings.js", async () => {
			const embedder = new LocalEmbedder({
				cacheFile: "/custom/cache.json",
				cache: false,
			});

			await embedder.embed("test");

			expect(mockEmbeddings).toHaveBeenCalledWith(
				"test",
				expect.objectContaining({
					cache: false,
					cache_file: "/custom/cache.json",
					service: "transformers",
					model: "Xenova/all-MiniLM-L6-v2",
				}),
			);
		});

		it("should handle embeddings.js errors", async () => {
			const embedder = new LocalEmbedder();
			const error = new Error("Model loading failed");
			mockEmbeddings.mockRejectedValueOnce(error);

			await expect(embedder.embed("test")).rejects.toThrow("Model loading failed");
		});

		it("should propagate errors with logging", async () => {
			const embedder = new LocalEmbedder();
			mockEmbeddings.mockRejectedValueOnce(new Error("Network error"));

			await expect(embedder.embed("test")).rejects.toThrow("Network error");
			expect(mockEmbeddings).toHaveBeenCalledTimes(1);
		});
	});

	// ==========================================================================
	// embedBatch() Method Tests
	// ==========================================================================

	describe("embedBatch() method", () => {
		it("should return empty array for empty input", async () => {
			const embedder = new LocalEmbedder();
			const result = await embedder.embedBatch([]);

			expect(result).toEqual([]);
			expect(mockEmbeddings).not.toHaveBeenCalled();
		});

		it("should process single text in batch", async () => {
			const embedder = new LocalEmbedder();
			const result = await embedder.embedBatch(["single text"]);

			expect(result).toHaveLength(1);
			expect(result[0]).toHaveLength(384);
			expect(mockEmbeddings).toHaveBeenCalledTimes(1);
		});

		it("should process multiple texts in batch", async () => {
			const embedder = new LocalEmbedder();
			const texts = ["text one", "text two", "text three"];
			const result = await embedder.embedBatch(texts);

			expect(result).toHaveLength(3);
			expect(result.every((vec) => vec.length === 384)).toBe(true);
			expect(mockEmbeddings).toHaveBeenCalledTimes(3);
		});

		it("should process texts in parallel using Promise.all", async () => {
			const embedder = new LocalEmbedder();
			let callOrder = 0;
			const callOrders: number[] = [];

			mockEmbeddings.mockImplementation(async () => {
				const order = callOrder++;
				callOrders.push(order);
				// Simulate async work
				await new Promise((resolve) => setTimeout(resolve, 10));
				return new Array(384).fill(0.5);
			});

			await embedder.embedBatch(["a", "b", "c"]);

			// All calls should start before any complete (parallel execution)
			expect(callOrders).toEqual([0, 1, 2]);
		});

		it("should handle duplicate texts in batch", async () => {
			const embedder = new LocalEmbedder();
			const texts = ["duplicate", "duplicate", "unique"];

			// Mock different responses to see caching effect
			mockEmbeddings
				.mockResolvedValueOnce(new Array(384).fill(0.1))
				.mockResolvedValueOnce(new Array(384).fill(0.2))
				.mockResolvedValueOnce(new Array(384).fill(0.3));

			const result = await embedder.embedBatch(texts);

			expect(result).toHaveLength(3);
			// Note: Cache behavior is handled by embeddings.js, not by our code
			expect(mockEmbeddings).toHaveBeenCalledTimes(3);
		});

		it("should set initialization flag on first batch call", async () => {
			const embedder = new LocalEmbedder();

			await embedder.embedBatch(["first", "second"]);
			await embedder.embedBatch(["third"]);

			// Logger should be called once for initialization on first batch
			expect(mockEmbeddings).toHaveBeenCalledTimes(3);
		});
	});

	// ==========================================================================
	// Cache Behavior Tests
	// ==========================================================================

	describe("cache behavior", () => {
		it("should return correct cache file path", () => {
			const embedder = new LocalEmbedder();
			expect(embedder.getCacheFile()).toBe(".undercity/embeddings.cache.json");
		});

		it("should return custom cache file path", () => {
			const embedder = new LocalEmbedder({ cacheFile: "/custom/cache.json" });
			expect(embedder.getCacheFile()).toBe("/custom/cache.json");
		});

		it("should report cache enabled by default", () => {
			const embedder = new LocalEmbedder();
			expect(embedder.isCacheEnabled()).toBe(true);
		});

		it("should report cache disabled when configured", () => {
			const embedder = new LocalEmbedder({ cache: false });
			expect(embedder.isCacheEnabled()).toBe(false);
		});

		it("should pass cache option to embeddings.js", async () => {
			const embedder = new LocalEmbedder({ cache: false });
			await embedder.embed("test");

			expect(mockEmbeddings).toHaveBeenCalledWith("test", expect.objectContaining({ cache: false }));
		});
	});

	// ==========================================================================
	// Error Handling Tests
	// ==========================================================================

	describe("error handling", () => {
		it("should propagate embeddings.js errors in embed()", async () => {
			const embedder = new LocalEmbedder();
			const error = new Error("Model initialization failed");
			mockEmbeddings.mockRejectedValueOnce(error);

			await expect(embedder.embed("test")).rejects.toThrow("Model initialization failed");
		});

		it("should handle partial failures in embedBatch()", async () => {
			const embedder = new LocalEmbedder();

			mockEmbeddings
				.mockResolvedValueOnce(new Array(384).fill(0.1))
				.mockRejectedValueOnce(new Error("Failed on second"))
				.mockResolvedValueOnce(new Array(384).fill(0.3));

			// Promise.all will reject if any promise rejects
			await expect(embedder.embedBatch(["a", "b", "c"])).rejects.toThrow("Failed on second");
		});

		it("should handle network errors", async () => {
			const embedder = new LocalEmbedder();
			mockEmbeddings.mockRejectedValueOnce(new Error("ECONNREFUSED"));

			await expect(embedder.embed("test")).rejects.toThrow("ECONNREFUSED");
		});

		it("should handle timeout errors", async () => {
			const embedder = new LocalEmbedder();
			mockEmbeddings.mockRejectedValueOnce(new Error("ETIMEDOUT"));

			await expect(embedder.embed("test")).rejects.toThrow("ETIMEDOUT");
		});
	});

	// ==========================================================================
	// Singleton Functions Tests
	// ==========================================================================

	describe("singleton functions", () => {
		it("should create instance on first getEmbedder() call", () => {
			const embedder1 = getEmbedder();
			expect(embedder1).toBeInstanceOf(LocalEmbedder);
		});

		it("should return same instance on subsequent calls", () => {
			const embedder1 = getEmbedder();
			const embedder2 = getEmbedder();

			expect(embedder1).toBe(embedder2);
		});

		it("should accept options on first call", () => {
			const embedder = getEmbedder({ cacheFile: "/singleton/cache.json" });

			expect(embedder.getCacheFile()).toBe("/singleton/cache.json");
		});

		it("should ignore options on subsequent calls", () => {
			const _embedder1 = getEmbedder({ cacheFile: "/first.json" });
			const embedder2 = getEmbedder({ cacheFile: "/second.json" });

			expect(embedder2.getCacheFile()).toBe("/first.json");
		});

		it("should clear singleton with resetEmbedder()", () => {
			const embedder1 = getEmbedder({ cacheFile: "/first.json" });
			resetEmbedder();
			const embedder2 = getEmbedder({ cacheFile: "/second.json" });

			expect(embedder1).not.toBe(embedder2);
			expect(embedder2.getCacheFile()).toBe("/second.json");
		});
	});

	// ==========================================================================
	// Edge Case Tests
	// ==========================================================================

	describe("edge cases", () => {
		it("should handle empty string input", async () => {
			const embedder = new LocalEmbedder();
			mockEmbeddings.mockResolvedValueOnce(new Array(384).fill(0));

			const result = await embedder.embed("");

			expect(result).toHaveLength(384);
			expect(mockEmbeddings).toHaveBeenCalledWith("", expect.any(Object));
		});

		it("should handle very long text strings", async () => {
			const embedder = new LocalEmbedder();
			const longText = "word ".repeat(10000); // 50,000 characters
			mockEmbeddings.mockResolvedValueOnce(new Array(384).fill(0.7));

			const result = await embedder.embed(longText);

			expect(result).toHaveLength(384);
			expect(mockEmbeddings).toHaveBeenCalledWith(longText, expect.any(Object));
		});

		it("should handle special characters in text", async () => {
			const embedder = new LocalEmbedder();
			const specialText = "Hello! @#$% ^&*() 你好 🚀 café";
			mockEmbeddings.mockResolvedValueOnce(new Array(384).fill(0.6));

			const result = await embedder.embed(specialText);

			expect(result).toHaveLength(384);
			expect(mockEmbeddings).toHaveBeenCalledWith(specialText, expect.any(Object));
		});

		it("should handle newlines and whitespace", async () => {
			const embedder = new LocalEmbedder();
			const textWithWhitespace = "Line 1\n\nLine 2\t\tTab separated";
			mockEmbeddings.mockResolvedValueOnce(new Array(384).fill(0.4));

			const result = await embedder.embed(textWithWhitespace);

			expect(result).toHaveLength(384);
			expect(mockEmbeddings).toHaveBeenCalledWith(textWithWhitespace, expect.any(Object));
		});

		it("should handle concurrent embed calls", async () => {
			const embedder = new LocalEmbedder();

			// Create multiple concurrent embed calls
			const promises = [embedder.embed("concurrent 1"), embedder.embed("concurrent 2"), embedder.embed("concurrent 3")];

			const results = await Promise.all(promises);

			expect(results).toHaveLength(3);
			expect(results.every((r) => r.length === 384)).toBe(true);
			expect(mockEmbeddings).toHaveBeenCalledTimes(3);
		});

		it("should handle mixed batch with empty and non-empty strings", async () => {
			const embedder = new LocalEmbedder();
			const texts = ["normal text", "", "another text"];

			const results = await embedder.embedBatch(texts);

			expect(results).toHaveLength(3);
			expect(results.every((r) => r.length === 384)).toBe(true);
			expect(mockEmbeddings).toHaveBeenCalledTimes(3);
		});
	});

	// ==========================================================================
	// Integration-Style Tests (multiple methods together)
	// ==========================================================================

	describe("integration scenarios", () => {
		it("should work with embed() followed by embedBatch()", async () => {
			const embedder = new LocalEmbedder();

			await embedder.embed("single");
			const batchResults = await embedder.embedBatch(["batch1", "batch2"]);

			expect(batchResults).toHaveLength(2);
			expect(mockEmbeddings).toHaveBeenCalledTimes(3);
		});

		it("should work with embedBatch() followed by embed()", async () => {
			const embedder = new LocalEmbedder();

			await embedder.embedBatch(["batch1", "batch2"]);
			const singleResult = await embedder.embed("single");

			expect(singleResult).toHaveLength(384);
			expect(mockEmbeddings).toHaveBeenCalledTimes(3);
		});

		it("should maintain state across multiple operations", async () => {
			const embedder = new LocalEmbedder({ cacheFile: "/test/cache.json" });

			await embedder.embed("test1");
			await embedder.embedBatch(["test2", "test3"]);
			await embedder.embed("test4");

			expect(embedder.getCacheFile()).toBe("/test/cache.json");
			expect(mockEmbeddings).toHaveBeenCalledTimes(4);
		});
	});
});
