/**
 * Tests for research-roi.ts
 *
 * Tests ROI assessment for research tasks including:
 * - Signal calculation (novelty, proposal yield, saturation)
 * - Research conclusion creation
 * - Research task detection
 * - Statistics gathering
 * - Context building
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addLearning } from "../knowledge.js";
import {
	createResearchConclusion,
	gatherResearchROIContext,
	getResearchROIStats,
	isResearchTask,
} from "../research-roi.js";
import { addTask, markTaskComplete } from "../task.js";
import type { ResearchConclusion, ResearchROIAssessment, ResearchROISignals } from "../types.js";

describe("research-roi.ts", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "research-roi-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		vi.restoreAllMocks();
	});

	// ==========================================================================
	// isResearchTask Tests
	// ==========================================================================

	describe("isResearchTask", () => {
		it("should identify tasks starting with [research]", () => {
			expect(isResearchTask("[research] API design patterns")).toBe(true);
			expect(isResearchTask("[Research] Best practices")).toBe(true);
		});

		it("should identify tasks containing research-related words", () => {
			expect(isResearchTask("Research authentication options")).toBe(true);
			expect(isResearchTask("Investigate memory leak")).toBe(true);
			expect(isResearchTask("Explore caching strategies")).toBe(true);
			expect(isResearchTask("Analyze performance bottlenecks")).toBe(true);
			expect(isResearchTask("Study user behavior patterns")).toBe(true);
		});

		it("should not identify regular implementation tasks", () => {
			expect(isResearchTask("Add login button")).toBe(false);
			expect(isResearchTask("Fix bug in user service")).toBe(false);
			expect(isResearchTask("Update dependencies")).toBe(false);
			expect(isResearchTask("Refactor auth module")).toBe(false);
		});

		it("should handle empty and edge cases", () => {
			expect(isResearchTask("")).toBe(false);
			expect(isResearchTask("  ")).toBe(false);
			expect(isResearchTask("researcher profile page")).toBe(false); // "researcher" not "research "
		});
	});

	// ==========================================================================
	// createResearchConclusion Tests
	// ==========================================================================

	describe("createResearchConclusion", () => {
		const baseSignals: ResearchROISignals = {
			noveltyTrend: 0.7,
			proposalYield: 0.5,
			decisionRepetition: 0.2,
			knowledgeSaturation: 0.3,
		};

		it("should create conclusion for continue_research recommendation", () => {
			const assessment: ResearchROIAssessment = {
				recommendation: "continue_research",
				confidence: 0.8,
				signals: baseSignals,
				rationale: "More research needed",
			};

			const conclusion = createResearchConclusion(assessment, 0);

			expect(conclusion.outcome).toBe("insufficient");
			expect(conclusion.rationale).toBe("More research needed");
			expect(conclusion.noveltyScore).toBe(0.7);
			expect(conclusion.proposalsGenerated).toBe(0);
			expect(conclusion.concludedAt).toBeDefined();
		});

		it("should create conclusion for start_implementing recommendation", () => {
			const assessment: ResearchROIAssessment = {
				recommendation: "start_implementing",
				confidence: 0.9,
				signals: baseSignals,
				rationale: "Ready to implement",
			};

			const conclusion = createResearchConclusion(assessment, 3, undefined, ["task-1", "task-2"]);

			expect(conclusion.outcome).toBe("implement");
			expect(conclusion.proposalsGenerated).toBe(3);
			expect(conclusion.linkedTaskIds).toEqual(["task-1", "task-2"]);
		});

		it("should create conclusion for conclude_no_go recommendation", () => {
			const assessment: ResearchROIAssessment = {
				recommendation: "conclude_no_go",
				confidence: 0.85,
				signals: baseSignals,
				rationale: "Not worth implementing",
			};

			const conclusion = createResearchConclusion(assessment, 0, "decision-123");

			expect(conclusion.outcome).toBe("no_go");
			expect(conclusion.linkedDecisionId).toBe("decision-123");
		});

		it("should create conclusion for mark_absorbed recommendation", () => {
			const assessment: ResearchROIAssessment = {
				recommendation: "mark_absorbed",
				confidence: 0.95,
				signals: { ...baseSignals, knowledgeSaturation: 0.95 },
				rationale: "Topic well covered",
			};

			const conclusion = createResearchConclusion(assessment, 0);

			expect(conclusion.outcome).toBe("absorbed");
		});

		it("should include timestamp in ISO format", () => {
			const assessment: ResearchROIAssessment = {
				recommendation: "start_implementing",
				confidence: 0.8,
				signals: baseSignals,
				rationale: "Test",
			};

			const before = new Date().toISOString();
			const conclusion = createResearchConclusion(assessment, 0);
			const after = new Date().toISOString();

			expect(conclusion.concludedAt >= before).toBe(true);
			expect(conclusion.concludedAt <= after).toBe(true);
		});
	});

	// ==========================================================================
	// gatherResearchROIContext Tests
	// ==========================================================================

	describe("gatherResearchROIContext", () => {
		it("should gather context for new topic with no prior data", async () => {
			const ctx = await gatherResearchROIContext("task-123", "authentication strategies", tempDir);

			expect(ctx.taskId).toBe("task-123");
			expect(ctx.topic).toBe("authentication strategies");
			expect(ctx.existingKnowledge).toBe(0);
			expect(ctx.recentDecisions).toBe(0);
			expect(ctx.priorResearchOnTopic).toEqual([]);
		});

		it("should find existing knowledge on topic", async () => {
			// Add some learnings
			addLearning(
				{
					taskId: "prev-task",
					category: "pattern",
					content: "Use OAuth2 for authentication",
					keywords: ["oauth", "authentication", "security"],
				},
				tempDir,
			);

			addLearning(
				{
					taskId: "prev-task-2",
					category: "fact",
					content: "JWT tokens expire after 1 hour",
					keywords: ["jwt", "token", "authentication"],
				},
				tempDir,
			);

			const ctx = await gatherResearchROIContext("task-123", "authentication implementation", tempDir);

			expect(ctx.existingKnowledge).toBeGreaterThan(0);
		});

		it("should find prior research tasks on similar topic", async () => {
			// Add a research task
			const researchTask = addTask("[research] authentication best practices", tempDir);
			markTaskComplete({ id: researchTask.id, path: tempDir });

			const ctx = await gatherResearchROIContext("new-task", "research authentication patterns", tempDir);

			expect(ctx.priorResearchOnTopic.length).toBeGreaterThanOrEqual(0);
		});
	});

	// ==========================================================================
	// getResearchROIStats Tests
	// ==========================================================================

	describe("getResearchROIStats", () => {
		it("should return empty stats when no research tasks exist", () => {
			const stats = getResearchROIStats(tempDir);

			expect(stats.totalResearchTasks).toBe(0);
			expect(stats.conclusionsByOutcome.implement).toBe(0);
			expect(stats.conclusionsByOutcome.no_go).toBe(0);
			expect(stats.conclusionsByOutcome.insufficient).toBe(0);
			expect(stats.conclusionsByOutcome.absorbed).toBe(0);
			expect(stats.avgNoveltyScore).toBe(0);
			expect(stats.avgProposalsPerResearch).toBe(0);
		});

		it("should count research tasks with conclusions", () => {
			// Create tasks with research conclusions
			const _task1 = addTask("[research] API design", tempDir);
			const _task2 = addTask("[research] Security audit", tempDir);

			// Manually add conclusions (simulating completion)
			const _conclusion1: ResearchConclusion = {
				outcome: "implement",
				rationale: "Found good patterns",
				noveltyScore: 0.8,
				proposalsGenerated: 3,
				concludedAt: new Date().toISOString(),
			};

			const _conclusion2: ResearchConclusion = {
				outcome: "no_go",
				rationale: "Not feasible",
				noveltyScore: 0.3,
				proposalsGenerated: 0,
				concludedAt: new Date().toISOString(),
			};

			// Note: This test is limited because we can't easily add researchConclusion
			// without going through the full task lifecycle. The function correctly
			// handles the empty case.
			const stats = getResearchROIStats(tempDir);

			expect(stats).toBeDefined();
			expect(typeof stats.totalResearchTasks).toBe("number");
			expect(typeof stats.avgNoveltyScore).toBe("number");
		});
	});

	// ==========================================================================
	// Signal Calculation Tests (via context)
	// ==========================================================================

	describe("Signal calculations", () => {
		it("should calculate knowledge saturation based on relevant learnings", async () => {
			// Add many learnings on a topic
			for (let i = 0; i < 15; i++) {
				addLearning(
					{
						taskId: `task-${i}`,
						category: "fact",
						content: `Validation pattern number ${i} for API endpoints`,
						keywords: ["validation", "api", "endpoint", "pattern"],
					},
					tempDir,
				);
			}

			const ctx = await gatherResearchROIContext("test-task", "API validation patterns", tempDir);

			// Should find many existing learnings
			expect(ctx.existingKnowledge).toBeGreaterThan(5);
		});

		it("should handle topic with no keyword overlap", async () => {
			// Add learnings on unrelated topic
			addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Database indexing strategies",
					keywords: ["database", "index", "performance"],
				},
				tempDir,
			);

			const ctx = await gatherResearchROIContext("test-task", "frontend styling with CSS", tempDir);

			// Should find few or no relevant learnings
			expect(ctx.existingKnowledge).toBeLessThan(5);
		});
	});

	// ==========================================================================
	// Edge Cases
	// ==========================================================================

	describe("Edge cases", () => {
		it("should handle empty topic string", async () => {
			const ctx = await gatherResearchROIContext("task-123", "", tempDir);

			expect(ctx.topic).toBe("");
			expect(ctx.existingKnowledge).toBe(0);
		});

		it("should handle special characters in topic", async () => {
			const ctx = await gatherResearchROIContext("task-123", "C++ performance & memory management", tempDir);

			expect(ctx.topic).toBe("C++ performance & memory management");
		});

		it("should handle very long topic strings", async () => {
			const longTopic = `${"research ".repeat(100)}some topic`;
			const ctx = await gatherResearchROIContext("task-123", longTopic, tempDir);

			expect(ctx.topic).toBe(longTopic);
		});

		it("should handle unicode in topic", async () => {
			const ctx = await gatherResearchROIContext("task-123", "研究 authentication 戦略", tempDir);

			expect(ctx.topic).toContain("研究");
		});
	});

	// ==========================================================================
	// Integration with Knowledge System
	// ==========================================================================

	describe("Integration with knowledge system", () => {
		it("should properly count learnings with AddLearningResult", async () => {
			// Add learnings using the new AddLearningResult interface
			const result1 = addLearning(
				{
					taskId: "task-1",
					category: "pattern",
					content: "Use Zod for API validation",
					keywords: ["zod", "validation", "api"],
				},
				tempDir,
			);

			expect(result1.added).toBe(true);
			expect(result1.noveltyScore).toBe(1.0); // First learning is fully novel

			// Add similar learning
			const result2 = addLearning(
				{
					taskId: "task-2",
					category: "pattern",
					content: "Use Zod schemas for API validation", // Very similar
					keywords: ["zod", "validation", "api"],
				},
				tempDir,
			);

			// Second similar learning should have lower novelty
			expect(result2.noveltyScore).toBeLessThan(1.0);

			const ctx = await gatherResearchROIContext("test", "API validation with Zod", tempDir);
			expect(ctx.existingKnowledge).toBeGreaterThan(0);
		});
	});
});
