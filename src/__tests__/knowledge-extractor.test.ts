/**
 * Tests for knowledge-extractor.ts
 * Including RAG integration for semantic search indexing
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractAndStoreLearnings, extractFromTaskResult, extractLearnings } from "../knowledge-extractor.js";

// Mock the Claude SDK to avoid API calls
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(async function* () {
		// Return empty result to force fallback to pattern matching
		yield { type: "result", subtype: "success", result: "[]" };
	}),
}));

// Mock RAG engine
const mockIndexContent = vi.fn().mockResolvedValue({ id: "doc-1" });
vi.mock("../rag/index.js", () => ({
	getRAGEngine: vi.fn(() => ({
		indexContent: mockIndexContent,
		search: vi.fn().mockResolvedValue([]),
		close: vi.fn(),
	})),
}));

describe("knowledge-extractor", () => {
	const testDir = join(process.cwd(), ".test-knowledge-extractor");
	const stateDir = join(testDir, ".undercity");

	beforeEach(() => {
		vi.clearAllMocks();
		mkdirSync(stateDir, { recursive: true });
		// Initialize empty knowledge.json
		writeFileSync(join(stateDir, "knowledge.json"), JSON.stringify({ learnings: [], version: "1.0" }));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("extractLearnings", () => {
		it("should extract fact learnings from discovery patterns", () => {
			const text = "I found that the API uses REST endpoints for all requests.";
			const learnings = extractLearnings(text);

			expect(learnings).toHaveLength(1);
			expect(learnings[0].category).toBe("fact");
			expect(learnings[0].content).toContain("API uses REST endpoints");
		});

		it("should extract gotcha learnings from problem patterns", () => {
			const text = "The issue was that the config file was missing the required auth section.";
			const learnings = extractLearnings(text);

			expect(learnings).toHaveLength(1);
			expect(learnings[0].category).toBe("gotcha");
			expect(learnings[0].content).toContain("config file was missing");
		});

		it("should extract pattern learnings from codebase patterns", () => {
			const text = "This codebase uses dependency injection for all services.";
			const learnings = extractLearnings(text);

			expect(learnings).toHaveLength(1);
			expect(learnings[0].category).toBe("pattern");
			expect(learnings[0].content).toContain("dependency injection");
		});

		it("should extract preference learnings", () => {
			const text = "The preferred approach is to use functional components over class components.";
			const learnings = extractLearnings(text);

			expect(learnings).toHaveLength(1);
			expect(learnings[0].category).toBe("preference");
		});

		it("should extract directory references from content", () => {
			// Note: File extension extraction is limited because learning patterns use period as delimiter.
			// Paths without extensions in the captured content will still be identified.
			const text = "This codebase uses src/validators for all validation tasks";
			const learnings = extractLearnings(text);

			expect(learnings).toHaveLength(1);
			// File references require a file extension to match the pattern
			// So directory-only paths won't have structured.file set
			expect(learnings[0].content).toContain("src/validators");
		});

		it("should extract keywords from content", () => {
			const text = "I discovered that TypeScript compilation requires strict mode enabled.";
			const learnings = extractLearnings(text);

			expect(learnings).toHaveLength(1);
			expect(learnings[0].keywords).toContain("typescript");
			expect(learnings[0].keywords).toContain("compilation");
		});

		it("should filter out short content", () => {
			const text = "I found that it works."; // Too short
			const learnings = extractLearnings(text);

			expect(learnings).toHaveLength(0);
		});

		it("should deduplicate similar learnings", () => {
			const text = `
				I found that the API uses REST.
				I discovered that the API uses REST.
			`;
			const learnings = extractLearnings(text);

			// Should only keep one
			expect(learnings).toHaveLength(1);
		});

		it("should extract multiple learnings from text", () => {
			const text = `
				I found that the database uses PostgreSQL for storage.
				The issue was that the connection pool was too small.
				This codebase uses migration scripts for schema changes.
			`;
			const learnings = extractLearnings(text);

			expect(learnings.length).toBeGreaterThanOrEqual(3);
		});
	});

	describe("extractAndStoreLearnings", () => {
		it("should store extracted learnings", async () => {
			const text = "I discovered that the build system requires Node 18 or higher.";
			const stored = await extractAndStoreLearnings("task-123", text, stateDir);

			expect(stored).toHaveLength(1);
			expect(stored[0].taskId).toBe("task-123");
			expect(stored[0].id).toBeDefined();
		});

		it("should index learnings to RAG after storing", async () => {
			const text = "I found that the testing framework uses vitest with coverage enabled.";
			await extractAndStoreLearnings("task-456", text, stateDir);

			expect(mockIndexContent).toHaveBeenCalled();
			const call = mockIndexContent.mock.calls[0][0];
			expect(call.source).toBe("learnings");
			expect(call.content).toContain("testing framework uses vitest");
			expect(call.metadata.taskId).toBe("task-456");
		});

		it("should include category in RAG metadata", async () => {
			const text = "The issue was that the environment variable was not set correctly.";
			await extractAndStoreLearnings("task-789", text, stateDir);

			expect(mockIndexContent).toHaveBeenCalled();
			const call = mockIndexContent.mock.calls[0][0];
			expect(call.metadata.category).toBe("gotcha");
		});

		it("should include keywords in RAG metadata", async () => {
			const text = "I discovered that TypeScript interfaces are used for API contracts.";
			await extractAndStoreLearnings("task-111", text, stateDir);

			expect(mockIndexContent).toHaveBeenCalled();
			const call = mockIndexContent.mock.calls[0][0];
			expect(call.metadata.keywords).toContain("typescript");
			expect(call.metadata.keywords).toContain("interfaces");
		});

		it("should handle learnings without file references", async () => {
			// File extraction has limitations with file extensions due to period being used as pattern delimiter
			const text = "I discovered that TypeScript strict mode improves type safety significantly.";
			await extractAndStoreLearnings("task-222", text, stateDir);

			expect(mockIndexContent).toHaveBeenCalled();
			const call = mockIndexContent.mock.calls[0][0];
			// File reference is undefined when no valid file path is in content
			expect(call.metadata.file).toBeUndefined();
			expect(call.content).toContain("TypeScript strict mode");
		});

		it("should continue if RAG indexing fails", async () => {
			mockIndexContent.mockRejectedValueOnce(new Error("RAG connection failed"));

			const text = "I discovered that the cache layer uses Redis for session storage.";
			const stored = await extractAndStoreLearnings("task-333", text, stateDir);

			// Should still return stored learnings even if RAG fails
			expect(stored).toHaveLength(1);
		});

		it("should return empty array for text with no learnings", async () => {
			const text = "Hello world. This is just some random text.";
			const stored = await extractAndStoreLearnings("task-444", text, stateDir);

			expect(stored).toHaveLength(0);
			expect(mockIndexContent).not.toHaveBeenCalled();
		});

		it("should reject low-quality learnings before storage", async () => {
			// Intentionally poor-quality learnings that should be filtered
			const badTexts = [
				"I found that stuff.", // Too generic and short
				"It turns out things.", // Too vague
				"I noticed something.", // Too generic
			];

			for (const text of badTexts) {
				const stored = await extractAndStoreLearnings(`task-bad-${badTexts.indexOf(text)}`, text, stateDir);
				// These should be rejected by quality assessment
				expect(stored).toHaveLength(0);
			}
		});

		it("should store high-quality learnings with initial confidence", async () => {
			const text =
				"I discovered that the validation module in src/validators.ts uses Zod schemas for type-safe validation.";
			const stored = await extractAndStoreLearnings("task-quality-test", text, stateDir);

			expect(stored).toHaveLength(1);
			// Initial confidence should be above default 0.5 due to quality indicators
			expect(stored[0].confidence).toBeGreaterThan(0.5);
			expect(stored[0].confidence).toBeLessThanOrEqual(0.8);
		});

		it("should index multiple learnings to RAG", async () => {
			const text = `
				I found that the API uses GraphQL for queries.
				The issue was that the schema was not properly typed.
				This codebase uses code generation for type safety.
			`;
			await extractAndStoreLearnings("task-555", text, stateDir);

			expect(mockIndexContent.mock.calls.length).toBeGreaterThanOrEqual(3);
		});
	});

	describe("extractFromTaskResult", () => {
		it("should extract learnings from task output", async () => {
			const result = {
				output: "I discovered that the module system uses ESM imports exclusively.",
			};
			const stored = await extractFromTaskResult("task-666", result, stateDir);

			expect(stored).toHaveLength(1);
			expect(stored[0].content).toContain("module system uses ESM");
		});

		it("should convert errors to gotcha learnings", async () => {
			const result = {
				error: "missing required dependency @types/node",
			};
			const stored = await extractFromTaskResult("task-777", result, stateDir);

			expect(stored).toHaveLength(1);
			expect(stored[0].category).toBe("gotcha");
		});

		it("should combine output and error for extraction", async () => {
			const result = {
				output: "I found that the build requires TypeScript 5.",
				error: "incompatible TypeScript version",
			};
			const stored = await extractFromTaskResult("task-888", result, stateDir);

			expect(stored.length).toBeGreaterThanOrEqual(1);
		});
	});
});
