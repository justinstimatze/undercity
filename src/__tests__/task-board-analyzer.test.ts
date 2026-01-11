/**
 * Tests for TaskBoardAnalyzer module
 */

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Task } from "../task.js";
import { TaskBoardAnalyzer } from "../task-board-analyzer.js";

// Mock the task.js module
vi.mock("../task.js", () => ({
	getAllTasks: vi.fn(),
	getReadyTasksForBatch: vi.fn(),
	getTaskBoardAnalytics: vi.fn(),
}));

// Import mocked functions
import { getAllTasks, getReadyTasksForBatch, getTaskBoardAnalytics } from "../task.js";

const mockedGetAllTasks = getAllTasks as Mock;
const mockedGetReadyTasksForBatch = getReadyTasksForBatch as Mock;
const mockedGetTaskBoardAnalytics = getTaskBoardAnalytics as Mock;

describe("TaskBoardAnalyzer", () => {
	let analyzer: TaskBoardAnalyzer;

	beforeEach(() => {
		analyzer = new TaskBoardAnalyzer();
		vi.clearAllMocks();
	});

	const createTestTask = (
		id: string,
		objective: string,
		status: "pending" | "complete" | "failed" | "in_progress" = "pending",
		packages?: string[],
		tags?: string[],
	): Task => ({
		id,
		objective,
		status,
		createdAt: new Date(),
		computedPackages: packages,
		tags: tags,
		riskScore: 0.3,
	});

	describe("analyzeTaskBoard", () => {
		it("should provide comprehensive task board insights", async () => {
			const mockTasks = [
				createTestTask("task-1", "Fix login bug", "pending", ["auth"], ["bugfix", "low"]),
				createTestTask("task-2", "Add user dashboard", "pending", ["ui"], ["feature", "medium"]),
				createTestTask("task-3", "Update API docs", "complete", ["docs"], ["documentation", "low"]),
			];

			mockedGetAllTasks.mockReturnValue(mockTasks);
			mockedGetTaskBoardAnalytics.mockReturnValue({
				totalTasks: 3,
				averageCompletionTime: 20 * 60 * 1000, // 20 minutes
				parallelizationOpportunities: 2,
				topConflictingPackages: ["auth", "ui"],
			});

			const insights = await analyzer.analyzeTaskBoard();

			expect(insights.totalTasks).toBe(3);
			expect(insights.pendingTasks).toBe(2);
			expect(insights.averageComplexity).toBe("low"); // 2 low + 1 medium = low average
			expect(insights.topConflictingPackages).toEqual(["auth", "ui"]);
			expect(insights.parallelizationOpportunities.length).toBeGreaterThanOrEqual(0);
			expect(insights.recommendations).toBeInstanceOf(Array);
		});

		it("should handle empty task board", async () => {
			mockedGetAllTasks.mockReturnValue([]);
			mockedGetTaskBoardAnalytics.mockReturnValue({
				totalTasks: 0,
				averageCompletionTime: 0,
				parallelizationOpportunities: 0,
				topConflictingPackages: [],
			});

			const insights = await analyzer.analyzeTaskBoard();

			expect(insights.totalTasks).toBe(0);
			expect(insights.pendingTasks).toBe(0);
			expect(insights.parallelizationOpportunities).toEqual([]);
		});

		it("should calculate average complexity correctly", async () => {
			const mockTasks = [
				createTestTask("task-1", "Simple bug fix", "pending", ["utils"], ["bugfix", "low"]),
				createTestTask("task-2", "Complex refactor", "pending", ["core"], ["refactor", "high"]),
				createTestTask("task-3", "Medium feature", "pending", ["feature"], ["feature", "medium"]),
			];

			mockedGetAllTasks.mockReturnValue(mockTasks);
			mockedGetTaskBoardAnalytics.mockReturnValue({
				totalTasks: 3,
				averageCompletionTime: 25 * 60 * 1000,
				parallelizationOpportunities: 1,
				topConflictingPackages: [],
			});

			const insights = await analyzer.analyzeTaskBoard();

			// low=1, high=3, medium=2 -> average = 2 -> medium
			expect(insights.averageComplexity).toBe("medium");
		});
	});

	describe("findParallelizationOpportunities", () => {
		it("should find compatible task combinations", async () => {
			const mockTasks = [
				createTestTask("task-1", "Fix auth bug", "pending", ["auth"], ["bugfix", "low"]),
				createTestTask("task-2", "Update UI component", "pending", ["ui"], ["feature", "medium"]),
				createTestTask("task-3", "Add API endpoint", "pending", ["api"], ["feature", "medium"]),
			];

			const opportunities = await analyzer.findParallelizationOpportunities(mockTasks);

			expect(opportunities).toBeInstanceOf(Array);
			// Should find opportunities since tasks have different packages
			if (opportunities.length > 0) {
				expect(opportunities[0]).toHaveProperty("taskSet");
				expect(opportunities[0]).toHaveProperty("description");
				expect(opportunities[0]).toHaveProperty("benefit");
				expect(opportunities[0]).toHaveProperty("estimatedTimesSaving");
			}
		});

		it("should handle single task", async () => {
			const mockTasks = [createTestTask("task-1", "Solo step", "pending", ["utils"], ["feature", "low"])];

			const opportunities = await analyzer.findParallelizationOpportunities(mockTasks);

			expect(opportunities).toEqual([]);
		});

		it("should rank opportunities by benefit", async () => {
			const mockTasks = [
				createTestTask("task-1", "Low risk step", "pending", ["pkg1"], ["feature", "low"]),
				createTestTask("task-2", "Another low risk", "pending", ["pkg2"], ["feature", "low"]),
				createTestTask("task-3", "Third compatible", "pending", ["pkg3"], ["feature", "low"]),
				createTestTask("task-4", "Fourth step", "pending", ["pkg4"], ["feature", "low"]),
			];

			const opportunities = await analyzer.findParallelizationOpportunities(mockTasks);

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
		it("should create compatibility matrix for task set", async () => {
			const mockTasks = [
				createTestTask("task-1", "Step 1", "pending", ["pkg1"], ["feature"]),
				createTestTask("task-2", "Step 2", "pending", ["pkg2"], ["bugfix"]),
			];

			mockedGetReadyTasksForBatch.mockReturnValue(mockTasks);

			const matrix = await analyzer.generateCompatibilityMatrix();

			expect(matrix.tasks.length).toBe(2);
			expect(matrix.matrix.length).toBe(2);
			expect(matrix.matrix[0].length).toBe(2);

			expect(matrix.summary.totalPairs).toBe(1); // Only count each pair once
			expect(matrix.summary.compatiblePairs + matrix.summary.conflictingPairs).toBe(1);
		});

		it("should handle empty task list", async () => {
			mockedGetReadyTasksForBatch.mockReturnValue([]);

			const matrix = await analyzer.generateCompatibilityMatrix([]);

			expect(matrix.tasks).toEqual([]);
			expect(matrix.matrix).toEqual([]);
			expect(matrix.summary.totalPairs).toBe(0);
		});

		it("should mark self-compatibility correctly", async () => {
			const mockTasks = [createTestTask("task-1", "Solo step", "pending", ["pkg1"])];

			const matrix = await analyzer.generateCompatibilityMatrix(mockTasks);

			expect(matrix.matrix[0][0].compatible).toBe(true);
			expect(matrix.matrix[0][0].compatibilityScore).toBe(1.0);
			expect(matrix.matrix[0][0].task1Id).toBe("task-1");
			expect(matrix.matrix[0][0].task2Id).toBe("task-1");
		});
	});

	describe("analyzeTaskCompatibility", () => {
		beforeEach(() => {
			mockedGetAllTasks.mockReturnValue([
				createTestTask("task-1", "Step 1", "pending", ["auth"], ["feature"]),
				createTestTask("task-2", "Step 2", "pending", ["ui"], ["bugfix"]),
			]);
		});

		it("should analyze compatibility between specific tasks", async () => {
			const result = await analyzer.analyzeTaskCompatibility("task-1", "task-2");

			expect(result).toHaveProperty("compatible");
			expect(result).toHaveProperty("conflicts");
			expect(result).toHaveProperty("recommendedAction");

			expect(typeof result.compatible).toBe("boolean");
			expect(Array.isArray(result.conflicts)).toBe(true);
			expect(typeof result.recommendedAction).toBe("string");
		});

		it("should handle non-existent tasks", async () => {
			const result = await analyzer.analyzeTaskCompatibility("task-1", "task-nonexistent");

			expect(result.compatible).toBe(false);
			expect(result.conflicts[0].type).toBe("not_found");
			expect(result.recommendedAction).toContain("Verify task IDs");
		});

		it("should provide appropriate recommendations", async () => {
			// Mock compatible tasks
			const result = await analyzer.analyzeTaskCompatibility("task-1", "task-2");

			expect(result.recommendedAction).toBeTruthy();
			if (result.compatible) {
				expect(result.recommendedAction).toContain("parallel");
			} else {
				expect(result.recommendedAction).toMatch(/sequential|monitoring/);
			}
		});
	});

	describe("getOptimizationSuggestions", () => {
		it("should provide relevant suggestions based on task board state", async () => {
			mockedGetAllTasks.mockReturnValue([
				createTestTask("task-1", "Step 1", "pending"),
				createTestTask("task-2", "Step 2", "pending"),
			]);

			mockedGetTaskBoardAnalytics.mockReturnValue({
				totalTasks: 2,
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

		it("should handle task board with many tasks", async () => {
			const manyTasks = Array.from({ length: 15 }, (_, i) => createTestTask(`task-${i}`, `Step ${i}`, "pending"));

			mockedGetAllTasks.mockReturnValue(manyTasks);
			mockedGetTaskBoardAnalytics.mockReturnValue({
				totalTasks: 15,
				averageCompletionTime: 20 * 60 * 1000,
				parallelizationOpportunities: 5,
				topConflictingPackages: [],
			});

			const suggestions = await analyzer.getOptimizationSuggestions();

			// Should suggest organizing tasks when there are many
			expect(suggestions.some((s) => s.includes("organizing"))).toBe(true);
		});
	});

	describe("private helper methods", () => {
		it("should categorize benefits correctly", () => {
			// Test high benefit conditions
			const highBenefitSet = {
				parallelismScore: 0.8,
				riskLevel: "low" as const,
				tasks: [createTestTask("q1", "step")],
				estimatedDuration: 10000,
				compatibilityMatrix: [],
			};

			const highTimeSavings = 50;
			const benefit = (
				analyzer as unknown as {
					categorizeBenefit: (taskSet: unknown, timeSavings: number) => "high" | "medium" | "low";
				}
			).categorizeBenefit(highBenefitSet, highTimeSavings);
			expect(benefit).toBe("high");

			// Test low benefit conditions
			const lowBenefitSet = {
				parallelismScore: 0.3,
				riskLevel: "high" as const,
				tasks: [createTestTask("q1", "step")],
				estimatedDuration: 10000,
				compatibilityMatrix: [],
			};

			const lowTimeSavings = 10;
			const lowBenefit = (
				analyzer as unknown as {
					categorizeBenefit: (taskSet: unknown, timeSavings: number) => "high" | "medium" | "low";
				}
			).categorizeBenefit(lowBenefitSet, lowTimeSavings);
			expect(lowBenefit).toBe("low");
		});

		it("should estimate time savings correctly", () => {
			const taskSet = {
				tasks: [
					{ ...createTestTask("q1", "low step"), tags: ["low"] },
					{ ...createTestTask("q2", "high step"), tags: ["high"] },
				],
				parallelismScore: 0.7,
				riskLevel: "medium" as const,
				estimatedDuration: 10000,
				compatibilityMatrix: [],
			};

			const timeSavings = (
				analyzer as unknown as { estimateTimeSavings: (taskSet: unknown) => number }
			).estimateTimeSavings(taskSet);

			// Sequential: 15 + 60 = 75 minutes, Parallel: max(15, 60) = 60 minutes
			// Savings: (75-60)/75 = 20%
			expect(timeSavings).toBe(20);
		});

		it("should generate appropriate opportunity descriptions", () => {
			const taskSet = {
				tasks: [
					{ ...createTestTask("q1", "feature step"), tags: ["feature"] },
					{ ...createTestTask("q2", "bugfix step"), tags: ["bugfix"] },
				],
				parallelismScore: 0.7,
				riskLevel: "medium" as const,
				estimatedDuration: 10000,
				compatibilityMatrix: [],
			};

			const description = (
				analyzer as unknown as { generateOpportunityDescription: (taskSet: unknown) => string }
			).generateOpportunityDescription(taskSet);
			expect(description).toContain("2");
			expect(description).toContain("feature/bugfix");
		});
	});
});
