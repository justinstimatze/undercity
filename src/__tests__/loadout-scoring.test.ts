/**
 * Tests for the loadout scoring system
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	calculateCompositeScore,
	classifyQuestType,
	DEFAULT_LOADOUTS,
	estimateCost,
	estimateQuestComplexity,
	generateLoadoutRecommendations,
	getBestLoadoutForQuest,
	recordLoadoutPerformance,
	updateLoadoutScores,
} from "../loadout-scoring.js";
import type { Quest } from "../quest.js";
import type {
	EfficiencyMetrics,
	LoadoutConfiguration,
	LoadoutScore,
	Raid,
} from "../types.js";

// Mock data for testing
const mockLoadoutConfig: LoadoutConfiguration = {
	id: "test-loadout",
	name: "Test Loadout",
	description: "Test loadout for unit tests",
	maxSquadSize: 4,
	enabledAgentTypes: ["scout", "planner", "fabricator", "auditor"],
	modelChoices: {
		scout: "haiku",
		planner: "sonnet",
		fabricator: "sonnet",
		auditor: "opus",
	},
	contextSize: "medium",
	parallelismLevel: "limited",
	autoApprove: false,
	lastUpdated: new Date(),
};

const mockQuest: Quest = {
	id: "quest-123",
	objective: "Fix bug in authentication system",
	status: "complete",
	createdAt: new Date(),
};

const mockRaid: Raid = {
	id: "raid-456",
	goal: "Fix bug in authentication system",
	status: "complete",
	startedAt: new Date("2024-01-01T10:00:00Z"),
	completedAt: new Date("2024-01-01T10:30:00Z"),
	planApproved: true,
};

describe("Quest Type Classification", () => {
	it("should classify debug quests correctly", () => {
		expect(classifyQuestType("Fix bug in payment system")).toBe("debug");
		expect(classifyQuestType("Debug error in authentication")).toBe("debug");
		expect(classifyQuestType("Resolve crash on startup")).toBe("debug");
		expect(classifyQuestType("Issue with data loading")).toBe("debug");
	});

	it("should classify feature quests correctly", () => {
		expect(classifyQuestType("Add user profile page")).toBe("feature");
		expect(classifyQuestType("Implement new dashboard")).toBe("feature");
		expect(classifyQuestType("Create payment integration")).toBe("feature");
		expect(classifyQuestType("Build notification system")).toBe("feature");
	});

	it("should classify refactor quests correctly", () => {
		expect(classifyQuestType("Refactor authentication module")).toBe("refactor");
		expect(classifyQuestType("Restructure database layer")).toBe("refactor");
		expect(classifyQuestType("Clean up legacy code")).toBe("refactor");
		expect(classifyQuestType("Improve structure of API")).toBe("refactor");
	});

	it("should classify documentation quests correctly", () => {
		expect(classifyQuestType("Document API endpoints")).toBe("documentation");
		expect(classifyQuestType("Write docs for setup process")).toBe("documentation");
		expect(classifyQuestType("Update README file")).toBe("documentation");
		expect(classifyQuestType("Add comments to complex functions")).toBe("documentation");
	});

	it("should classify test quests correctly", () => {
		expect(classifyQuestType("Add unit tests for user service")).toBe("test");
		expect(classifyQuestType("Increase test coverage")).toBe("test");
		expect(classifyQuestType("Write integration tests")).toBe("test");
		expect(classifyQuestType("Create test specs for API")).toBe("test");
	});

	it("should classify performance quests correctly", () => {
		expect(classifyQuestType("Optimize database queries")).toBe("performance");
		expect(classifyQuestType("Improve page load speed")).toBe("performance");
		expect(classifyQuestType("Reduce memory usage")).toBe("performance");
		expect(classifyQuestType("Enhance efficiency of algorithms")).toBe("performance");
	});

	it("should classify security quests correctly", () => {
		expect(classifyQuestType("Fix security vulnerability")).toBe("security");
		expect(classifyQuestType("Add authentication security")).toBe("security");
		expect(classifyQuestType("Add permission checks")).toBe("security");
		expect(classifyQuestType("Secure API endpoints")).toBe("security");
	});

	it("should classify research quests correctly", () => {
		expect(classifyQuestType("Analyze performance bottlenecks")).toBe("research");
		expect(classifyQuestType("Research best practices for caching")).toBe("research");
		expect(classifyQuestType("Investigate memory leaks")).toBe("research");
		expect(classifyQuestType("Study user behavior patterns")).toBe("research");
	});

	it("should default to feature for unclear objectives", () => {
		expect(classifyQuestType("Do something with the system")).toBe("feature");
		expect(classifyQuestType("Update the application")).toBe("feature");
	});
});

describe("Quest Complexity Estimation", () => {
	it("should estimate high complexity for complex tasks", () => {
		expect(estimateQuestComplexity("Refactor entire authentication and authorization system with database migration")).toBeGreaterThan(7);
		expect(estimateQuestComplexity("Security audit of API with performance optimization")).toBeGreaterThan(6);
		expect(estimateQuestComplexity("Integration with multiple external APIs and services")).toBeGreaterThan(5);
	});

	it("should estimate medium complexity for moderate tasks", () => {
		const complexity = estimateQuestComplexity("Add user profile editing feature");
		expect(complexity).toBeGreaterThanOrEqual(4);
		expect(complexity).toBeLessThanOrEqual(6);
	});

	it("should estimate low complexity for simple tasks", () => {
		expect(estimateQuestComplexity("Fix typo in error message")).toBeLessThan(4);
		expect(estimateQuestComplexity("Add simple comment to function")).toBeLessThan(4);
		expect(estimateQuestComplexity("Quick one line change")).toBeLessThan(4);
	});

	it("should handle empty or minimal descriptions", () => {
		expect(estimateQuestComplexity("")).toBeGreaterThan(0);
		expect(estimateQuestComplexity("Fix")).toBeGreaterThan(0);
		expect(estimateQuestComplexity("Simple")).toBeLessThan(6);
	});
});

describe("Cost Estimation", () => {
	it("should calculate correct costs for different models", () => {
		const tokens = 1000000; // 1M tokens

		expect(estimateCost(tokens, "haiku", true)).toBe(25); // $0.25 input
		expect(estimateCost(tokens, "haiku", false)).toBe(125); // $1.25 output

		expect(estimateCost(tokens, "sonnet", true)).toBe(300); // $3.00 input
		expect(estimateCost(tokens, "sonnet", false)).toBe(1500); // $15.00 output

		expect(estimateCost(tokens, "opus", true)).toBe(1500); // $15.00 input
		expect(estimateCost(tokens, "opus", false)).toBe(7500); // $75.00 output
	});

	it("should scale correctly for smaller token amounts", () => {
		const tokens = 50000; // 50k tokens

		expect(estimateCost(tokens, "haiku", true)).toBe(1.25); // $0.0125
		expect(estimateCost(tokens, "sonnet", true)).toBe(15); // $0.15
	});
});

describe("Composite Score Calculation", () => {
	it("should calculate perfect score for ideal metrics", () => {
		const perfectMetrics: EfficiencyMetrics = {
			timeToComplete: 1000, // 1 second
			totalTokens: 1000,
			costInCents: 1,
			qualityScore: 100,
			retryCount: 0,
			success: true,
		};

		const score = calculateCompositeScore(perfectMetrics);
		expect(score).toBeGreaterThan(95);
	});

	it("should calculate low score for poor metrics", () => {
		const poorMetrics: EfficiencyMetrics = {
			timeToComplete: 300000, // 5 minutes
			totalTokens: 1000000,
			costInCents: 100,
			qualityScore: 20,
			retryCount: 5,
			success: false,
		};

		const score = calculateCompositeScore(poorMetrics);
		expect(score).toBeLessThan(50);
	});

	it("should weight quality score heavily", () => {
		const highQualityMetrics: EfficiencyMetrics = {
			timeToComplete: 60000, // 1 minute
			totalTokens: 100000,
			costInCents: 50,
			qualityScore: 95,
			retryCount: 1,
			success: true,
		};

		const lowQualityMetrics: EfficiencyMetrics = {
			timeToComplete: 60000, // Same time
			totalTokens: 100000, // Same tokens
			costInCents: 50, // Same cost
			qualityScore: 30, // Much lower quality
			retryCount: 1,
			success: true,
		};

		const highScore = calculateCompositeScore(highQualityMetrics);
		const lowScore = calculateCompositeScore(lowQualityMetrics);

		expect(highScore - lowScore).toBeGreaterThan(20); // Quality heavily weighted
	});
});

describe("Performance Recording", () => {
	it("should create valid performance record", () => {
		const metrics: EfficiencyMetrics = {
			timeToComplete: 30000,
			totalTokens: 50000,
			costInCents: 25,
			qualityScore: 85,
			retryCount: 0,
			success: true,
		};

		const performance = recordLoadoutPerformance(
			mockLoadoutConfig,
			mockQuest,
			mockRaid,
			metrics
		);

		expect(performance).toBeDefined();
		expect(performance.loadoutConfigId).toBe(mockLoadoutConfig.id);
		expect(performance.questId).toBe(mockQuest.id);
		expect(performance.raidId).toBe(mockRaid.id);
		expect(performance.questType).toBe("debug"); // Based on quest objective
		expect(performance.metrics).toBe(metrics);
		expect(performance.questComplexity).toBeGreaterThan(0);
	});

	it("should include agent metrics when provided", () => {
		const metrics: EfficiencyMetrics = {
			timeToComplete: 30000,
			totalTokens: 50000,
			costInCents: 25,
			qualityScore: 85,
			retryCount: 0,
			success: true,
		};

		const agentMetrics = {
			"scout-1": { tokensUsed: 10000, timeSpent: 5000, taskSuccess: true },
			"fabricator-1": { tokensUsed: 30000, timeSpent: 20000, taskSuccess: true },
		};

		const performance = recordLoadoutPerformance(
			mockLoadoutConfig,
			mockQuest,
			mockRaid,
			metrics,
			agentMetrics
		);

		expect(performance.agentMetrics).toBeDefined();
		expect(performance.agentMetrics!["scout-1"]).toEqual(agentMetrics["scout-1"]);
		expect(performance.agentMetrics!["fabricator-1"]).toEqual(agentMetrics["fabricator-1"]);
	});
});

describe("Loadout Recommendations", () => {
	const mockPerformances = [
		{
			id: "perf-1",
			loadoutConfigId: "speed-demon",
			questId: "q1",
			questType: "debug" as const,
			questComplexity: 5,
			raidId: "r1",
			metrics: {
				timeToComplete: 15000,
				totalTokens: 20000,
				costInCents: 10,
				qualityScore: 75,
				retryCount: 0,
				success: true,
			},
			timestamp: new Date(),
		},
		{
			id: "perf-2",
			loadoutConfigId: "balanced-performer",
			questId: "q2",
			questType: "debug" as const,
			questComplexity: 6,
			raidId: "r2",
			metrics: {
				timeToComplete: 25000,
				totalTokens: 30000,
				costInCents: 20,
				qualityScore: 90,
				retryCount: 0,
				success: true,
			},
			timestamp: new Date(),
		},
	];

	it("should generate recommendations when performance data is available", () => {
		const scores = updateLoadoutScores(mockPerformances, []);
		const recommendation = generateLoadoutRecommendations(
			"debug",
			DEFAULT_LOADOUTS,
			scores
		);

		expect(recommendation).toBeDefined();
		expect(recommendation!.questType).toBe("debug");
		expect(recommendation!.recommendedLoadout).toBeDefined();
		expect(recommendation!.confidence).toBeGreaterThan(0);
		expect(recommendation!.reasoning).toContain("debug");
	});

	it("should return null when no performance data is available", () => {
		const recommendation = generateLoadoutRecommendations(
			"documentation",
			DEFAULT_LOADOUTS,
			[]
		);

		expect(recommendation).toBeNull();
	});

	it("should rank loadouts by composite score", () => {
		const scores = updateLoadoutScores(mockPerformances, []);
		const recommendation = generateLoadoutRecommendations(
			"debug",
			DEFAULT_LOADOUTS,
			scores
		);

		expect(recommendation).toBeDefined();

		// The balanced performer should win due to higher quality score
		const recommendedLoadout = recommendation!.recommendedLoadout;
		expect(recommendedLoadout.id).toBe("balanced-performer");
	});
});

describe("Best Loadout Selection", () => {
	it("should select optimal loadout when performance data exists", () => {
		const mockPerformances = [
			{
				id: "perf-1",
				loadoutConfigId: "quality-focused",
				questId: "q1",
				questType: "feature" as const,
				questComplexity: 7,
				raidId: "r1",
				metrics: {
					timeToComplete: 45000,
					totalTokens: 80000,
					costInCents: 60,
					qualityScore: 95,
					retryCount: 0,
					success: true,
				},
				timestamp: new Date(),
			},
		];

		const scores = updateLoadoutScores(mockPerformances, []);
		const quest = { id: "new-quest", objective: "Add new user dashboard feature" } as Quest;

		const bestLoadout = getBestLoadoutForQuest(quest, DEFAULT_LOADOUTS, scores);
		expect(bestLoadout).toBeDefined();
		expect(bestLoadout?.id).toBe("quality-focused");
	});

	it("should fallback to default when no performance data exists", () => {
		const quest = { id: "new-quest", objective: "Debug authentication error" } as Quest;

		const bestLoadout = getBestLoadoutForQuest(quest, DEFAULT_LOADOUTS, []);
		expect(bestLoadout).toBeDefined();
		expect(bestLoadout?.id).toBe("debug-specialist"); // Default for debug quests
	});

	it("should use balanced performer as ultimate fallback", () => {
		const quest = { id: "new-quest", objective: "Some unknown task type" } as Quest;

		const bestLoadout = getBestLoadoutForQuest(quest, DEFAULT_LOADOUTS, []);
		expect(bestLoadout).toBeDefined();
		expect(bestLoadout?.id).toBe("balanced-performer"); // Default fallback
	});
});

describe("Default Loadouts", () => {
	it("should include all required default loadouts", () => {
		const loadoutIds = DEFAULT_LOADOUTS.map(l => l.id);
		expect(loadoutIds).toContain("speed-demon");
		expect(loadoutIds).toContain("balanced-performer");
		expect(loadoutIds).toContain("quality-focused");
		expect(loadoutIds).toContain("debug-specialist");
		expect(loadoutIds).toContain("research-mode");
	});

	it("should have valid configurations for all defaults", () => {
		for (const loadout of DEFAULT_LOADOUTS) {
			expect(loadout.id).toBeTruthy();
			expect(loadout.name).toBeTruthy();
			expect(loadout.maxSquadSize).toBeGreaterThan(0);
			expect(loadout.enabledAgentTypes.length).toBeGreaterThan(0);
			expect(Object.keys(loadout.modelChoices).length).toBeGreaterThan(0);
			expect(["small", "medium", "large"]).toContain(loadout.contextSize);
			expect(["sequential", "limited", "maximum"]).toContain(loadout.parallelismLevel);
		}
	});

	it("should have appropriate model choices for different loadout types", () => {
		const speedDemon = DEFAULT_LOADOUTS.find(l => l.id === "speed-demon")!;
		expect(speedDemon.modelChoices.scout).toBe("haiku"); // Speed focus

		const qualityFocused = DEFAULT_LOADOUTS.find(l => l.id === "quality-focused")!;
		expect(qualityFocused.modelChoices.auditor).toBe("opus"); // Quality focus

		const debugSpecialist = DEFAULT_LOADOUTS.find(l => l.id === "debug-specialist")!;
		expect(debugSpecialist.modelChoices.auditor).toBe("opus"); // Thorough review for bugs
	});
});