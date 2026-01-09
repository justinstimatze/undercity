/**
 * Tests for QuestScheduler module
 */

import { FileTracker } from "../file-tracker.js";
import type { Quest } from "../quest.js";
import { QuestAnalyzer } from "../quest-analyzer.js";
import { QuestScheduler } from "../quest-scheduler.js";

describe("QuestScheduler", () => {
	let scheduler: QuestScheduler;
	let analyzer: QuestAnalyzer;
	let fileTracker: FileTracker;

	beforeEach(() => {
		analyzer = new QuestAnalyzer();
		fileTracker = new FileTracker();
		scheduler = new QuestScheduler(analyzer, fileTracker, 3);
	});

	const createTestQuest = (id: string, objective: string, packages?: string[], estimatedFiles?: string[]): Quest => ({
		id,
		objective,
		status: "pending",
		priority: 1,
		createdAt: new Date(),
		computedPackages: packages,
		estimatedFiles: estimatedFiles,
		riskScore: 0.3,
		tags: ["medium"],
	});

	describe("findParallelizableSets", () => {
		it("should find compatible quest sets", async () => {
			const quests = [
				createTestQuest("quest-1", "Fix bug in auth module", ["auth"], ["src/auth/login.ts"]),
				createTestQuest("quest-2", "Update UI components", ["components"], ["src/components/Button.tsx"]),
				createTestQuest("quest-3", "Add API endpoint", ["api"], ["src/api/users.ts"]),
			];

			const questSets = await scheduler.findParallelizableSets(quests);

			expect(questSets.length).toBeGreaterThan(0);

			// Should find combinations that don't conflict
			const largestSet = questSets.reduce(
				(max, set) => (set.quests.length > max.quests.length ? set : max),
				questSets[0],
			);

			expect(largestSet.quests.length).toBeGreaterThanOrEqual(2);
		});

		it("should handle empty quest list", async () => {
			const questSets = await scheduler.findParallelizableSets([]);
			expect(questSets).toEqual([]);
		});

		it("should handle single quest", async () => {
			const quests = [createTestQuest("quest-1", "Fix single bug", ["auth"], ["src/auth/login.ts"])];

			const questSets = await scheduler.findParallelizableSets(quests);
			expect(questSets.length).toBe(1);
			expect(questSets[0].quests.length).toBe(1);
		});

		it("should detect file conflicts", async () => {
			const quests = [
				createTestQuest("quest-1", "Update login form", ["auth"], ["src/auth/LoginForm.tsx"]),
				createTestQuest("quest-2", "Fix login validation", ["auth"], ["src/auth/LoginForm.tsx"]),
			];

			const questSets = await scheduler.findParallelizableSets(quests);

			// Should not create sets with both quests together due to file conflict
			const combinedSet = questSets.find((set) => set.quests.length === 2);
			expect(combinedSet).toBeUndefined();
		});

		it("should detect package conflicts", async () => {
			// Use higher-risk quests (riskScore > 0.5) to get non-low risk level
			const quests = [
				{ ...createTestQuest("quest-1", "Refactor auth system", ["auth", "security"], []), riskScore: 0.6 },
				{ ...createTestQuest("quest-2", "Update auth middleware", ["auth", "middleware"], []), riskScore: 0.6 },
			];

			const questSets = await scheduler.findParallelizableSets(quests);

			// Should still allow these as package overlap is warning, not blocking
			// With riskScore 0.6, avgRisk > 0.3 triggers "medium" risk level
			const hasWarningSet = questSets.some((set) => set.quests.length === 2 && set.riskLevel !== "low");
			expect(hasWarningSet).toBeTruthy();
		});
	});

	describe("buildDependencyGraph", () => {
		it("should handle explicit dependencies", () => {
			const quests = [
				{ ...createTestQuest("quest-1", "Setup database", ["db"]), dependsOn: [] },
				{ ...createTestQuest("quest-2", "Add user table", ["db"]), dependsOn: ["quest-1"] },
				createTestQuest("quest-3", "Add UI form", ["ui"]),
			];

			const graph = scheduler.buildDependencyGraph(quests);

			expect(graph.nodes.length).toBe(3);
			expect(graph.readyQuests.length).toBe(2); // quest-1 and quest-3 are ready
			expect(graph.readyQuests.map((q) => q.id)).toContain("quest-1");
			expect(graph.readyQuests.map((q) => q.id)).toContain("quest-3");
			expect(graph.readyQuests.map((q) => q.id)).not.toContain("quest-2");

			const dependency = graph.edges.find((e) => e.fromQuestId === "quest-1" && e.toQuestId === "quest-2");
			expect(dependency).toBeDefined();
			expect(dependency?.type).toBe("explicit");
		});

		it("should handle explicit conflicts", () => {
			const quests = [
				{ ...createTestQuest("quest-1", "Feature A", ["feature"]), conflicts: ["quest-2"] },
				createTestQuest("quest-2", "Feature B", ["feature"]),
			];

			const graph = scheduler.buildDependencyGraph(quests);

			const conflict = graph.edges.find(
				(e) => e.fromQuestId === "quest-1" && e.toQuestId === "quest-2" && e.type === "explicit",
			);
			expect(conflict).toBeDefined();
		});

		it("should detect implicit file conflicts", () => {
			const quests = [
				createTestQuest("quest-1", "Update component", ["ui"], ["src/components/Button.tsx"]),
				createTestQuest("quest-2", "Style component", ["ui"], ["src/components/Button.tsx"]),
			];

			const graph = scheduler.buildDependencyGraph(quests);

			const conflict = graph.edges.find((e) => e.type === "file_conflict");
			expect(conflict).toBeDefined();
			expect(conflict?.severity).toBe("blocking");
		});
	});

	describe("selectOptimalQuestSet", () => {
		it("should select the set with highest parallelism score", () => {
			const questSets = [
				{
					quests: [createTestQuest("quest-1", "Waypoint 1", ["pkg1"])],
					estimatedDuration: 10000,
					riskLevel: "low" as const,
					parallelismScore: 0.3,
					compatibilityMatrix: [],
				},
				{
					quests: [
						createTestQuest("quest-2", "Waypoint 2", ["pkg2"]),
						createTestQuest("quest-3", "Waypoint 3", ["pkg3"]),
					],
					estimatedDuration: 12000,
					riskLevel: "medium" as const,
					parallelismScore: 0.8,
					compatibilityMatrix: [],
				},
			];

			const optimal = scheduler.selectOptimalQuestSet(questSets);

			expect(optimal).toBeDefined();
			expect(optimal?.parallelismScore).toBe(0.8);
			expect(optimal?.quests.length).toBe(2);
		});

		it("should respect max count constraint", () => {
			const questSets = [
				{
					quests: [
						createTestQuest("quest-1", "Waypoint 1", ["pkg1"]),
						createTestQuest("quest-2", "Waypoint 2", ["pkg2"]),
						createTestQuest("quest-3", "Waypoint 3", ["pkg3"]),
						createTestQuest("quest-4", "Waypoint 4", ["pkg4"]),
					],
					estimatedDuration: 15000,
					riskLevel: "high" as const,
					parallelismScore: 0.9,
					compatibilityMatrix: [],
				},
				{
					quests: [
						createTestQuest("quest-5", "Waypoint 5", ["pkg5"]),
						createTestQuest("quest-6", "Waypoint 6", ["pkg6"]),
					],
					estimatedDuration: 12000,
					riskLevel: "medium" as const,
					parallelismScore: 0.7,
					compatibilityMatrix: [],
				},
			];

			const optimal = scheduler.selectOptimalQuestSet(questSets, 3);

			// Should select the 2-quest set because the 4-quest set exceeds maxCount
			expect(optimal?.quests.length).toBe(2);
		});

		it("should return null for empty quest sets", () => {
			const optimal = scheduler.selectOptimalQuestSet([]);
			expect(optimal).toBeNull();
		});
	});

	describe("compatibility checking", () => {
		it("should mark explicit dependencies as incompatible", () => {
			const quest1 = { ...createTestQuest("quest-1", "Waypoint 1", ["pkg1"]), dependsOn: ["quest-2"] };
			const quest2 = createTestQuest("quest-2", "Waypoint 2", ["pkg2"]);

			// We need to access private method for testing
			const compatibility = (scheduler as any).checkQuestCompatibility(quest1, quest2);

			expect(compatibility.compatible).toBeFalsy();
			expect(compatibility.conflicts).toContainEqual(
				expect.objectContaining({ type: "explicit", severity: "blocking" }),
			);
		});

		it("should allow package overlap with reduced score", () => {
			const quest1 = createTestQuest("quest-1", "Waypoint 1", ["auth", "utils"], []);
			const quest2 = createTestQuest("quest-2", "Waypoint 2", ["auth", "components"], []);

			const compatibility = (scheduler as any).checkQuestCompatibility(quest1, quest2);

			expect(compatibility.compatible).toBeTruthy();
			expect(compatibility.compatibilityScore).toBeLessThan(1.0);
			expect(compatibility.conflicts).toContainEqual(
				expect.objectContaining({ type: "package_overlap", severity: "warning" }),
			);
		});

		it("should block file conflicts", () => {
			const quest1 = createTestQuest("quest-1", "Waypoint 1", ["pkg1"], ["src/shared.ts"]);
			const quest2 = createTestQuest("quest-2", "Waypoint 2", ["pkg2"], ["src/shared.ts"]);

			const compatibility = (scheduler as any).checkQuestCompatibility(quest1, quest2);

			expect(compatibility.compatible).toBeFalsy();
			expect(compatibility.conflicts).toContainEqual(
				expect.objectContaining({ type: "file_conflict", severity: "blocking" }),
			);
		});

		it("should penalize high-risk quest combinations", () => {
			const quest1 = { ...createTestQuest("quest-1", "Waypoint 1", ["pkg1"]), riskScore: 0.8 };
			const quest2 = { ...createTestQuest("quest-2", "Waypoint 2", ["pkg2"]), riskScore: 0.9 };

			const compatibility = (scheduler as any).checkQuestCompatibility(quest1, quest2);

			expect(compatibility.compatibilityScore).toBeLessThan(0.7);
		});

		it("should handle quests with no computed data", () => {
			const quest1: Quest = {
				id: "quest-1",
				objective: "Waypoint without analysis",
				status: "pending",
				createdAt: new Date(),
			};
			const quest2: Quest = {
				id: "quest-2",
				objective: "Another waypoint",
				status: "pending",
				createdAt: new Date(),
			};

			const compatibility = (scheduler as any).checkQuestCompatibility(quest1, quest2);

			// Should be compatible with perfect score when no conflicts detected
			expect(compatibility.compatible).toBeTruthy();
			expect(compatibility.compatibilityScore).toBe(1.0);
		});
	});

	describe("quest set evaluation", () => {
		it("should calculate parallelism score correctly", () => {
			// Test the parallelism score calculation
			const questSet = [
				createTestQuest("quest-1", "Independent waypoint 1", ["pkg1"], ["file1.ts"]),
				createTestQuest("quest-2", "Independent waypoint 2", ["pkg2"], ["file2.ts"]),
				createTestQuest("quest-3", "Independent waypoint 3", ["pkg3"], ["file3.ts"]),
			];

			// Create a minimal compatibility matrix
			const compatibilityMatrix = questSet.map((q1, i) =>
				questSet.map((q2, j) => ({
					quest1Id: q1.id,
					quest2Id: q2.id,
					compatible: true,
					conflicts: [],
					compatibilityScore: i === j ? 1.0 : 0.9, // High compatibility for different quests
				})),
			);

			const score = (scheduler as any).calculateParallelismScore(questSet, compatibilityMatrix);

			expect(score).toBeGreaterThan(0.5); // Should get good parallelism score
			expect(score).toBeLessThanOrEqual(1.0);
		});

		it("should estimate duration correctly", () => {
			const questSet = [
				{ ...createTestQuest("quest-1", "Low complexity", ["pkg1"]), tags: ["low"] },
				{ ...createTestQuest("quest-2", "High complexity", ["pkg2"]), tags: ["high"] },
			];

			const duration = (scheduler as any).estimateSetDuration(questSet);

			// Should take the maximum duration (high complexity = 45 minutes)
			expect(duration).toBe(45 * 60 * 1000);
		});

		it("should calculate risk level correctly", () => {
			const lowRiskSet = [
				{ ...createTestQuest("quest-1", "Safe waypoint", ["pkg1"]), riskScore: 0.2 },
				{ ...createTestQuest("quest-2", "Another safe waypoint", ["pkg2"]), riskScore: 0.3 },
			];

			const highRiskSet = [
				{ ...createTestQuest("quest-3", "Risky waypoint", ["pkg3"]), riskScore: 0.9 },
				{ ...createTestQuest("quest-4", "Another risky waypoint", ["pkg4"]), riskScore: 0.8 },
			];

			const lowRisk = (scheduler as any).calculateSetRiskLevel(lowRiskSet);
			const highRisk = (scheduler as any).calculateSetRiskLevel(highRiskSet);

			expect(lowRisk).toBe("low");
			expect(highRisk).toBe("high");
		});
	});
});
