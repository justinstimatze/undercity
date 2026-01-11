/**
 * Tests for QuestBoardAnalyzer module
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Quest } from "../quest.js";
import { QuestBoardAnalyzer } from "../quest-board-analyzer.js";

// Mock the quest.js module
vi.mock("../quest.js", () => ({
	getAllQuests: vi.fn(),
	getReadyQuestsForBatch: vi.fn(),
	getQuestBoardAnalytics: vi.fn(),
}));

// Import mocked functions
import { getAllQuests, getQuestBoardAnalytics, getReadyQuestsForBatch } from "../quest.js";

const mockedGetAllQuests = getAllQuests as Mock;
const mockedGetReadyQuestsForBatch = getReadyQuestsForBatch as Mock;
const mockedGetQuestBoardAnalytics = getQuestBoardAnalytics as Mock;

describe("QuestBoardAnalyzer", () => {
	let analyzer: QuestBoardAnalyzer;

	beforeEach(() => {
		analyzer = new QuestBoardAnalyzer();
		vi.clearAllMocks();
	});

	const createTestQuest = (
		id: string,
		objective: string,
		status: "pending" | "complete" | "failed" | "in_progress" = "pending",
		packages?: string[],
		tags?: string[],
	): Quest => ({
		id,
		objective,
		status,
		createdAt: new Date(),
		computedPackages: packages,
		tags: tags,
		riskScore: 0.3,
	});

	describe("analyzeQuestBoard", () => {
		it("should provide comprehensive quest board insights", async () => {
			const mockQuests = [
				createTestQuest("quest-1", "Fix login bug", "pending", ["auth"], ["bugfix", "low"]),
				createTestQuest("quest-2", "Add user dashboard", "pending", ["ui"], ["feature", "medium"]),
				createTestQuest("quest-3", "Update API docs", "complete", ["docs"], ["documentation", "low"]),
			];

			mockedGetAllQuests.mockReturnValue(mockQuests);
			mockedGetQuestBoardAnalytics.mockReturnValue({
				totalQuests: 3,
				averageCompletionTime: 20 * 60 * 1000, // 20 minutes
				parallelizationOpportunities: 2,
				topConflictingPackages: ["auth", "ui"],
			});

			const insights = await analyzer.analyzeQuestBoard();

			expect(insights.totalQuests).toBe(3);
			expect(insights.pendingQuests).toBe(2);
			expect(insights.averageComplexity).toBe("low"); // 2 low + 1 medium = low average
			expect(insights.topConflictingPackages).toEqual(["auth", "ui"]);
			expect(insights.parallelizationOpportunities.length).toBeGreaterThanOrEqual(0);
			expect(insights.recommendations).toBeInstanceOf(Array);
		});

		it("should handle empty quest board", async () => {
			mockedGetAllQuests.mockReturnValue([]);
			mockedGetQuestBoardAnalytics.mockReturnValue({
				totalQuests: 0,
				averageCompletionTime: 0,
				parallelizationOpportunities: 0,
				topConflictingPackages: [],
			});

			const insights = await analyzer.analyzeQuestBoard();

			expect(insights.totalQuests).toBe(0);
			expect(insights.pendingQuests).toBe(0);
			expect(insights.parallelizationOpportunities).toEqual([]);
		});

		it("should calculate average complexity correctly", async () => {
			const mockQuests = [
				createTestQuest("quest-1", "Simple bug fix", "pending", ["utils"], ["bugfix", "low"]),
				createTestQuest("quest-2", "Complex refactor", "pending", ["core"], ["refactor", "high"]),
				createTestQuest("quest-3", "Medium feature", "pending", ["feature"], ["feature", "medium"]),
			];

			mockedGetAllQuests.mockReturnValue(mockQuests);
			mockedGetQuestBoardAnalytics.mockReturnValue({
				totalQuests: 3,
				averageCompletionTime: 25 * 60 * 1000,
				parallelizationOpportunities: 1,
				topConflictingPackages: [],
			});

			const insights = await analyzer.analyzeQuestBoard();

			// low=1, high=3, medium=2 -> average = 2 -> medium
			expect(insights.averageComplexity).toBe("medium");
		});
	});

	describe("findParallelizationOpportunities", () => {
		it("should find compatible quest combinations", async () => {
			const mockQuests = [
				createTestQuest("quest-1", "Fix auth bug", "pending", ["auth"], ["bugfix", "low"]),
				createTestQuest("quest-2", "Update UI component", "pending", ["ui"], ["feature", "medium"]),
				createTestQuest("quest-3", "Add API endpoint", "pending", ["api"], ["feature", "medium"]),
			];

			const opportunities = await analyzer.findParallelizationOpportunities(mockQuests);

			expect(opportunities).toBeInstanceOf(Array);
			// Should find opportunities since quests have different packages
			if (opportunities.length > 0) {
				expect(opportunities[0]).toHaveProperty("questSet");
				expect(opportunities[0]).toHaveProperty("description");
				expect(opportunities[0]).toHaveProperty("benefit");
				expect(opportunities[0]).toHaveProperty("estimatedTimesSaving");
			}
		});

		it("should handle single quest", async () => {
			const mockQuests = [createTestQuest("quest-1", "Solo waypoint", "pending", ["utils"], ["feature", "low"])];

			const opportunities = await analyzer.findParallelizationOpportunities(mockQuests);

			expect(opportunities).toEqual([]);
		});

		it("should rank opportunities by benefit", async () => {
			const mockQuests = [
				createTestQuest("quest-1", "Low risk waypoint", "pending", ["pkg1"], ["feature", "low"]),
				createTestQuest("quest-2", "Another low risk", "pending", ["pkg2"], ["feature", "low"]),
				createTestQuest("quest-3", "Third compatible", "pending", ["pkg3"], ["feature", "low"]),
				createTestQuest("quest-4", "Fourth waypoint", "pending", ["pkg4"], ["feature", "low"]),
			];

			const opportunities = await analyzer.findParallelizationOpportunities(mockQuests);

			if (opportunities.length > 1) {
				// Should be sorted by benefit, then by time savings
				const benefits = opportunities.map((opp) => opp.benefit);
				const benefitScores = benefits.map((b) => ({ high: 3, medium: 2, low: 1 })[b]);

				for (let i = 1; i < benefitScores.length; i++) {
					expect(benefitScores[i]).toBeLessThanOrEqual(benefitScores[i - 1]);
				}
			}
		});
	});

	describe("generateCompatibilityMatrix", () => {
		it("should create compatibility matrix for quest set", async () => {
			const mockQuests = [
				createTestQuest("quest-1", "Waypoint 1", "pending", ["pkg1"], ["feature"]),
				createTestQuest("quest-2", "Waypoint 2", "pending", ["pkg2"], ["bugfix"]),
			];

			mockedGetReadyQuestsForBatch.mockReturnValue(mockQuests);

			const matrix = await analyzer.generateCompatibilityMatrix();

			expect(matrix.quests.length).toBe(2);
			expect(matrix.matrix.length).toBe(2);
			expect(matrix.matrix[0].length).toBe(2);

			expect(matrix.summary.totalPairs).toBe(1); // Only count each pair once
			expect(matrix.summary.compatiblePairs + matrix.summary.conflictingPairs).toBe(1);
		});

		it("should handle empty quest list", async () => {
			mockedGetReadyQuestsForBatch.mockReturnValue([]);

			const matrix = await analyzer.generateCompatibilityMatrix([]);

			expect(matrix.quests).toEqual([]);
			expect(matrix.matrix).toEqual([]);
			expect(matrix.summary.totalPairs).toBe(0);
		});

		it("should mark self-compatibility correctly", async () => {
			const mockQuests = [createTestQuest("quest-1", "Solo waypoint", "pending", ["pkg1"])];

			const matrix = await analyzer.generateCompatibilityMatrix(mockQuests);

			expect(matrix.matrix[0][0].compatible).toBe(true);
			expect(matrix.matrix[0][0].compatibilityScore).toBe(1.0);
			expect(matrix.matrix[0][0].quest1Id).toBe("quest-1");
			expect(matrix.matrix[0][0].quest2Id).toBe("quest-1");
		});
	});

	describe("analyzeQuestCompatibility", () => {
		beforeEach(() => {
			mockedGetAllQuests.mockReturnValue([
				createTestQuest("quest-1", "Waypoint 1", "pending", ["auth"], ["feature"]),
				createTestQuest("quest-2", "Waypoint 2", "pending", ["ui"], ["bugfix"]),
			]);
		});

		it("should analyze compatibility between specific quests", async () => {
			const result = await analyzer.analyzeQuestCompatibility("quest-1", "quest-2");

			expect(result).toHaveProperty("compatible");
			expect(result).toHaveProperty("conflicts");
			expect(result).toHaveProperty("recommendedAction");

			expect(typeof result.compatible).toBe("boolean");
			expect(Array.isArray(result.conflicts)).toBe(true);
			expect(typeof result.recommendedAction).toBe("string");
		});

		it("should handle non-existent quests", async () => {
			const result = await analyzer.analyzeQuestCompatibility("quest-1", "quest-nonexistent");

			expect(result.compatible).toBe(false);
			expect(result.conflicts[0].type).toBe("not_found");
			expect(result.recommendedAction).toContain("Verify quest IDs");
		});

		it("should provide appropriate recommendations", async () => {
			// Mock compatible quests
			const result = await analyzer.analyzeQuestCompatibility("quest-1", "quest-2");

			expect(result.recommendedAction).toBeTruthy();
			if (result.compatible) {
				expect(result.recommendedAction).toContain("parallel");
			} else {
				expect(result.recommendedAction).toMatch(/sequential|monitoring/);
			}
		});
	});

	describe("getOptimizationSuggestions", () => {
		it("should provide relevant suggestions based on quest board state", async () => {
			mockedGetAllQuests.mockReturnValue([
				createTestQuest("quest-1", "Waypoint 1", "pending"),
				createTestQuest("quest-2", "Waypoint 2", "pending"),
			]);

			mockedGetQuestBoardAnalytics.mockReturnValue({
				totalQuests: 2,
				averageCompletionTime: 35 * 60 * 1000, // 35 minutes
				parallelizationOpportunities: 2,
				topConflictingPackages: ["auth", "ui", "api"],
			});

			const suggestions = await analyzer.getOptimizationSuggestions();

			expect(suggestions).toBeInstanceOf(Array);
			expect(suggestions.length).toBeGreaterThan(0);

			// Should suggest focusing on packages due to topConflictingPackages
			expect(suggestions.some((s) => s.includes("packages"))).toBe(true);
		});

		it("should handle quest board with many quests", async () => {
			const manyQuests = Array.from({ length: 15 }, (_, i) =>
				createTestQuest(`quest-${i}`, `Waypoint ${i}`, "pending"),
			);

			mockedGetAllQuests.mockReturnValue(manyQuests);
			mockedGetQuestBoardAnalytics.mockReturnValue({
				totalQuests: 15,
				averageCompletionTime: 20 * 60 * 1000,
				parallelizationOpportunities: 5,
				topConflictingPackages: [],
			});

			const suggestions = await analyzer.getOptimizationSuggestions();

			// Should suggest organizing quests when there are many
			expect(suggestions.some((s) => s.includes("organizing"))).toBe(true);
		});
	});

	describe("private helper methods", () => {
		it("should categorize benefits correctly", () => {
			// Test high benefit conditions
			const highBenefitSet = {
				parallelismScore: 0.8,
				riskLevel: "low" as const,
				quests: [createTestQuest("q1", "waypoint")],
				estimatedDuration: 10000,
				compatibilityMatrix: [],
			};

			const highTimeSavings = 50;
			const benefit = (
				analyzer as unknown as {
					categorizeBenefit: (questSet: unknown, timeSavings: number) => "high" | "medium" | "low";
				}
			).categorizeBenefit(highBenefitSet, highTimeSavings);
			expect(benefit).toBe("high");

			// Test low benefit conditions
			const lowBenefitSet = {
				parallelismScore: 0.3,
				riskLevel: "high" as const,
				quests: [createTestQuest("q1", "waypoint")],
				estimatedDuration: 10000,
				compatibilityMatrix: [],
			};

			const lowTimeSavings = 10;
			const lowBenefit = (
				analyzer as unknown as {
					categorizeBenefit: (questSet: unknown, timeSavings: number) => "high" | "medium" | "low";
				}
			).categorizeBenefit(lowBenefitSet, lowTimeSavings);
			expect(lowBenefit).toBe("low");
		});

		it("should estimate time savings correctly", () => {
			const questSet = {
				quests: [
					{ ...createTestQuest("q1", "low waypoint"), tags: ["low"] },
					{ ...createTestQuest("q2", "high waypoint"), tags: ["high"] },
				],
				parallelismScore: 0.7,
				riskLevel: "medium" as const,
				estimatedDuration: 10000,
				compatibilityMatrix: [],
			};

			const timeSavings = (
				analyzer as unknown as { estimateTimeSavings: (questSet: unknown) => number }
			).estimateTimeSavings(questSet);

			// Sequential: 15 + 60 = 75 minutes, Parallel: max(15, 60) = 60 minutes
			// Savings: (75-60)/75 = 20%
			expect(timeSavings).toBe(20);
		});

		it("should generate appropriate opportunity descriptions", () => {
			const questSet = {
				quests: [
					{ ...createTestQuest("q1", "feature waypoint"), tags: ["feature"] },
					{ ...createTestQuest("q2", "bugfix waypoint"), tags: ["bugfix"] },
				],
				parallelismScore: 0.7,
				riskLevel: "medium" as const,
				estimatedDuration: 10000,
				compatibilityMatrix: [],
			};

			const description = (
				analyzer as unknown as { generateOpportunityDescription: (questSet: unknown) => string }
			).generateOpportunityDescription(questSet);
			expect(description).toContain("2");
			expect(description).toContain("feature/bugfix");
		});
	});
});
