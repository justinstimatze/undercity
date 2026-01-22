/**
 * Tests for automated-pm.ts RAG integration
 *
 * Tests that the PM uses RAG for enhanced context when making decisions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted to define mock functions that are used in vi.mock factories
const { mockRAGSearch, mockFindSimilarDecisions, mockMakeDecisionAx } = vi.hoisted(() => ({
	mockRAGSearch: vi.fn().mockResolvedValue([]),
	mockFindSimilarDecisions: vi.fn().mockReturnValue([]),
	mockMakeDecisionAx: vi.fn().mockResolvedValue({
		decision: "proceed with option A",
		reasoning: "Based on patterns",
		confidence: "high",
		escalate: false,
	}),
}));

// Mock the Ax program
vi.mock("../ax-programs.js", () => ({
	makeDecisionAx: mockMakeDecisionAx,
}));

// Mock RAG engine
vi.mock("../rag/index.js", () => ({
	getRAGEngine: vi.fn(() => ({
		search: mockRAGSearch,
		indexContent: vi.fn().mockResolvedValue({ id: "doc-1" }),
		close: vi.fn(),
	})),
}));

// Mock knowledge base
vi.mock("../knowledge.js", () => ({
	findRelevantLearnings: vi.fn().mockReturnValue([]),
}));

// Mock task-file-patterns
vi.mock("../task-file-patterns.js", () => ({
	findRelevantFiles: vi.fn().mockReturnValue([]),
	getTaskFileStats: vi.fn().mockReturnValue({ riskyKeywords: [] }),
}));

// Mock decision-tracker
vi.mock("../decision-tracker.js", () => ({
	findSimilarDecisions: mockFindSimilarDecisions,
	loadDecisionStore: vi.fn().mockReturnValue({
		pending: [],
		resolved: [],
		overrides: [],
		version: "1.0",
		lastUpdated: new Date().toISOString(),
	}),
	resolveDecision: vi.fn().mockResolvedValue(true),
	recordResearchConclusion: vi.fn().mockResolvedValue({
		id: "dec-1",
		taskId: "task-1",
		question: "test",
		context: "test",
		category: "research_conclusion",
		keywords: [],
		capturedAt: new Date().toISOString(),
	}),
}));

// Mock logger with child function
vi.mock("../logger.js", () => {
	const mockLogger = {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn(() => mockLogger),
	};
	return { sessionLogger: mockLogger };
});

// Mock content-sanitizer
vi.mock("../content-sanitizer.js", () => ({
	sanitizeContent: vi.fn((content: string) => content),
	wrapUntrustedContent: vi.fn((content: string) => content),
}));

// Mock pm-schemas
vi.mock("../pm-schemas.js", () => ({
	constrainResearchResult: vi.fn((result: unknown) => result),
}));

// Mock research-roi
vi.mock("../research-roi.js", () => ({
	assessResearchROI: vi.fn().mockReturnValue({ shouldResearch: true, reasoning: "test" }),
	createResearchConclusion: vi.fn().mockReturnValue({ conclusion: "implement", reasoning: "test" }),
	gatherResearchROIContext: vi.fn().mockResolvedValue({}),
}));

// Mock task-security
vi.mock("../task-security.js", () => ({
	filterSafeProposals: vi.fn((proposals: unknown[]) => proposals),
}));

// Mock url-validator
vi.mock("../url-validator.js", () => ({
	extractAndValidateURLs: vi.fn().mockReturnValue([]),
	logURLsForAudit: vi.fn(),
}));

import { pmDecide } from "../automated-pm.js";
// Import after mocking
import type { DecisionPoint } from "../decision-tracker.js";

describe("automated-pm RAG integration", () => {
	const createMockDecision = (overrides: Partial<DecisionPoint> = {}): DecisionPoint => ({
		id: "dec-123",
		taskId: "task-456",
		question: "Should we use a database or file storage?",
		context: "Evaluating storage options for the application",
		category: "pm_decidable",
		keywords: ["database", "storage", "file"],
		capturedAt: new Date().toISOString(),
		options: ["Database", "File storage"],
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mockRAGSearch.mockResolvedValue([]);
		mockFindSimilarDecisions.mockReturnValue([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("gatherPMContext RAG integration", () => {
		it("should search RAG index for decision context", async () => {
			const decision = createMockDecision();
			await pmDecide(decision);

			expect(mockRAGSearch).toHaveBeenCalledWith(
				decision.question,
				expect.objectContaining({
					limit: 5,
					sources: ["learnings", "decisions"],
				}),
			);
		});

		it("should include RAG results in decision context", async () => {
			mockRAGSearch.mockResolvedValue([
				{
					chunk: { content: "Previous decision: use PostgreSQL for relational data" },
					document: { source: "decisions" },
					score: 0.85,
				},
				{
					chunk: { content: "File storage works well for blob data" },
					document: { source: "learnings" },
					score: 0.72,
				},
			]);

			const decision = createMockDecision();
			await pmDecide(decision);

			// Verify makeDecisionAx was called with RAG context
			expect(mockMakeDecisionAx).toHaveBeenCalled();
			const knowledgeArg = mockMakeDecisionAx.mock.calls[0][4];
			expect(knowledgeArg).toContain("Semantically Related");
			expect(knowledgeArg).toContain("[decisions] Previous decision: use PostgreSQL");
			expect(knowledgeArg).toContain("[learnings] File storage works well");
		});

		it("should filter RAG results by score threshold", async () => {
			mockRAGSearch.mockResolvedValue([
				{
					chunk: { content: "High relevance result" },
					document: { source: "learnings" },
					score: 0.8,
				},
				{
					chunk: { content: "Low relevance result" },
					document: { source: "learnings" },
					score: 0.2, // Below 0.3 threshold
				},
			]);

			const decision = createMockDecision();
			await pmDecide(decision);

			const knowledgeArg = mockMakeDecisionAx.mock.calls[0][4];
			expect(knowledgeArg).toContain("High relevance result");
			expect(knowledgeArg).not.toContain("Low relevance result");
		});

		it("should continue if RAG search fails", async () => {
			mockRAGSearch.mockRejectedValue(new Error("RAG unavailable"));

			const decision = createMockDecision();
			const result = await pmDecide(decision);

			// Should still return a valid result
			expect(result).toBeDefined();
			expect(result.decision).toBeDefined();
			expect(mockMakeDecisionAx).toHaveBeenCalled();
		});

		it("should handle empty RAG results gracefully", async () => {
			mockRAGSearch.mockResolvedValue([]);

			const decision = createMockDecision();
			await pmDecide(decision);

			const knowledgeArg = mockMakeDecisionAx.mock.calls[0][4];
			expect(knowledgeArg).not.toContain("Semantically Related");
		});

		it("should handle null source in RAG results", async () => {
			mockRAGSearch.mockResolvedValue([
				{
					chunk: { content: "Content without source" },
					document: null,
					score: 0.7,
				},
			]);

			const decision = createMockDecision();
			await pmDecide(decision);

			const knowledgeArg = mockMakeDecisionAx.mock.calls[0][4];
			expect(knowledgeArg).toContain("[unknown] Content without source");
		});
	});

	describe("precedent-based decisions", () => {
		it("should skip RAG when strong precedent exists", async () => {
			// Set up strong precedent (3+ similar successful decisions)
			mockFindSimilarDecisions.mockReturnValue([
				{ question: "Similar Q1", resolution: { decision: "Use DB", outcome: "success" } },
				{ question: "Similar Q2", resolution: { decision: "Use DB", outcome: "success" } },
				{ question: "Similar Q3", resolution: { decision: "Use DB", outcome: "success" } },
			]);

			const decision = createMockDecision();
			const result = await pmDecide(decision);

			// Should follow precedent without calling Ax
			expect(result.decision).toBe("Use DB");
			expect(result.reasoning).toContain("similar successful decisions");
			expect(result.tokensUsed).toBe(0);
			expect(mockMakeDecisionAx).not.toHaveBeenCalled();
		});
	});

	describe("RAG context formatting", () => {
		it("should combine knowledge base and RAG results", async () => {
			// Mock both knowledge base and RAG results
			const { findRelevantLearnings } = await import("../knowledge.js");
			(findRelevantLearnings as ReturnType<typeof vi.fn>).mockReturnValue([
				{ content: "Knowledge base fact about storage" },
			]);

			mockRAGSearch.mockResolvedValue([
				{
					chunk: { content: "RAG semantic result about databases" },
					document: { source: "learnings" },
					score: 0.75,
				},
			]);

			const decision = createMockDecision();
			await pmDecide(decision);

			const knowledgeArg = mockMakeDecisionAx.mock.calls[0][4];
			expect(knowledgeArg).toContain("Knowledge base fact about storage");
			expect(knowledgeArg).toContain("RAG semantic result about databases");
		});

		it("should format RAG results with source labels", async () => {
			mockRAGSearch.mockResolvedValue([
				{
					chunk: { content: "Decision from RAG" },
					document: { source: "decisions" },
					score: 0.9,
				},
				{
					chunk: { content: "Learning from RAG" },
					document: { source: "learnings" },
					score: 0.8,
				},
			]);

			const decision = createMockDecision();
			await pmDecide(decision);

			const knowledgeArg = mockMakeDecisionAx.mock.calls[0][4];
			expect(knowledgeArg).toContain("[decisions] Decision from RAG");
			expect(knowledgeArg).toContain("[learnings] Learning from RAG");
		});
	});
});
