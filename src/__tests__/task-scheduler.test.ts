/**
 * Tests for TaskScheduler module
 */

import { FileTracker } from "../file-tracker.js";
import type { Task } from "../task.js";
import { TaskAnalyzer } from "../task-analyzer.js";
import { TaskScheduler } from "../task-scheduler.js";

// Type for accessing private methods in tests
interface SchedulerTestMethods {
	calculateParallelismScore(taskSet: Task[], compatibilityMatrix: { compatibilityScore: number }[][]): number;
	estimateSetDuration(taskSet: Task[]): number;
}

describe("TaskScheduler", () => {
	let scheduler: TaskScheduler;
	let analyzer: TaskAnalyzer;
	let fileTracker: FileTracker;

	beforeEach(() => {
		analyzer = new TaskAnalyzer();
		fileTracker = new FileTracker();
		scheduler = new TaskScheduler(analyzer, fileTracker, 3);
	});

	const createTestTask = (id: string, objective: string, packages?: string[], estimatedFiles?: string[]): Task => ({
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
		it("should find compatible task sets", async () => {
			const tasks = [
				createTestTask("task-1", "Fix bug in auth module", ["auth"], ["src/auth/login.ts"]),
				createTestTask("task-2", "Update UI components", ["components"], ["src/components/Button.tsx"]),
				createTestTask("task-3", "Add API endpoint", ["api"], ["src/api/users.ts"]),
			];

			const taskSets = await scheduler.findParallelizableSets(tasks);

			expect(taskSets.length).toBeGreaterThan(0);

			// Should find combinations that don't conflict
			const largestSet = taskSets.reduce((max, set) => (set.tasks.length > max.tasks.length ? set : max), taskSets[0]);

			expect(largestSet.tasks.length).toBeGreaterThanOrEqual(2);
		});

		it("should handle empty task list", async () => {
			const taskSets = await scheduler.findParallelizableSets([]);
			expect(taskSets).toEqual([]);
		});

		it("should handle single task", async () => {
			const tasks = [createTestTask("task-1", "Fix single bug", ["auth"], ["src/auth/login.ts"])];

			const taskSets = await scheduler.findParallelizableSets(tasks);
			expect(taskSets.length).toBe(1);
			expect(taskSets[0].tasks.length).toBe(1);
		});

		it("should detect file conflicts", async () => {
			const tasks = [
				createTestTask("task-1", "Update login form", ["auth"], ["src/auth/LoginForm.tsx"]),
				createTestTask("task-2", "Fix login validation", ["auth"], ["src/auth/LoginForm.tsx"]),
			];

			const taskSets = await scheduler.findParallelizableSets(tasks);

			// Should not create sets with both tasks together due to file conflict
			const combinedSet = taskSets.find((set) => set.tasks.length === 2);
			expect(combinedSet).toBeUndefined();
		});

		it("should detect package conflicts", async () => {
			// Use higher-risk tasks (riskScore > 0.5) to get non-low risk level
			const tasks = [
				{ ...createTestTask("task-1", "Refactor auth system", ["auth", "security"], []), riskScore: 0.6 },
				{ ...createTestTask("task-2", "Update auth middleware", ["auth", "middleware"], []), riskScore: 0.6 },
			];

			const taskSets = await scheduler.findParallelizableSets(tasks);

			// Should still allow these as package overlap is warning, not blocking
			// With riskScore 0.6, avgRisk > 0.3 triggers "medium" risk level
			const hasWarningSet = taskSets.some((set) => set.tasks.length === 2 && set.riskLevel !== "low");
			expect(hasWarningSet).toBeTruthy();
		});
	});

	describe("buildDependencyGraph", () => {
		it("should handle explicit dependencies", () => {
			const tasks = [
				{ ...createTestTask("task-1", "Setup database", ["db"]), dependsOn: [] },
				{ ...createTestTask("task-2", "Add user table", ["db"]), dependsOn: ["task-1"] },
				createTestTask("task-3", "Add UI form", ["ui"]),
			];

			const graph = scheduler.buildDependencyGraph(tasks);

			expect(graph.nodes.length).toBe(3);
			expect(graph.readyTasks.length).toBe(2); // task-1 and task-3 are ready
			expect(graph.readyTasks.map((q) => q.id)).toContain("task-1");
			expect(graph.readyTasks.map((q) => q.id)).toContain("task-3");
			expect(graph.readyTasks.map((q) => q.id)).not.toContain("task-2");

			const dependency = graph.edges.find((e) => e.fromTaskId === "task-1" && e.toTaskId === "task-2");
			expect(dependency).toBeDefined();
			expect(dependency?.type).toBe("explicit");
		});

		it("should handle explicit conflicts", () => {
			const tasks = [
				{ ...createTestTask("task-1", "Feature A", ["feature"]), conflicts: ["task-2"] },
				createTestTask("task-2", "Feature B", ["feature"]),
			];

			const graph = scheduler.buildDependencyGraph(tasks);

			const conflict = graph.edges.find(
				(e) => e.fromTaskId === "task-1" && e.toTaskId === "task-2" && e.type === "explicit",
			);
			expect(conflict).toBeDefined();
		});

		it("should detect implicit file conflicts", () => {
			const tasks = [
				createTestTask("task-1", "Update component", ["ui"], ["src/components/Button.tsx"]),
				createTestTask("task-2", "Style component", ["ui"], ["src/components/Button.tsx"]),
			];

			const graph = scheduler.buildDependencyGraph(tasks);

			const conflict = graph.edges.find((e) => e.type === "file_conflict");
			expect(conflict).toBeDefined();
			expect(conflict?.severity).toBe("blocking");
		});
	});

	describe("selectOptimalTaskSet", () => {
		it("should select the set with highest parallelism score", () => {
			const taskSets = [
				{
					tasks: [createTestTask("task-1", "Step 1", ["pkg1"])],
					estimatedDuration: 10000,
					riskLevel: "low" as const,
					parallelismScore: 0.3,
					compatibilityMatrix: [],
				},
				{
					tasks: [createTestTask("task-2", "Step 2", ["pkg2"]), createTestTask("task-3", "Step 3", ["pkg3"])],
					estimatedDuration: 12000,
					riskLevel: "medium" as const,
					parallelismScore: 0.8,
					compatibilityMatrix: [],
				},
			];

			const optimal = scheduler.selectOptimalTaskSet(taskSets);

			expect(optimal).toBeDefined();
			expect(optimal?.parallelismScore).toBe(0.8);
			expect(optimal?.tasks.length).toBe(2);
		});

		it("should respect max count constraint", () => {
			const taskSets = [
				{
					tasks: [
						createTestTask("task-1", "Step 1", ["pkg1"]),
						createTestTask("task-2", "Step 2", ["pkg2"]),
						createTestTask("task-3", "Step 3", ["pkg3"]),
						createTestTask("task-4", "Step 4", ["pkg4"]),
					],
					estimatedDuration: 15000,
					riskLevel: "high" as const,
					parallelismScore: 0.9,
					compatibilityMatrix: [],
				},
				{
					tasks: [createTestTask("task-5", "Step 5", ["pkg5"]), createTestTask("task-6", "Step 6", ["pkg6"])],
					estimatedDuration: 12000,
					riskLevel: "medium" as const,
					parallelismScore: 0.7,
					compatibilityMatrix: [],
				},
			];

			const optimal = scheduler.selectOptimalTaskSet(taskSets, 3);

			// Should select the 2-task set because the 4-task set exceeds maxCount
			expect(optimal?.tasks.length).toBe(2);
		});

		it("should return null for empty task sets", () => {
			const optimal = scheduler.selectOptimalTaskSet([]);
			expect(optimal).toBeNull();
		});
	});

	describe("compatibility checking", () => {
		it("should mark explicit dependencies as incompatible", () => {
			const task1 = { ...createTestTask("task-1", "Step 1", ["pkg1"]), dependsOn: ["task-2"] };
			const task2 = createTestTask("task-2", "Step 2", ["pkg2"]);

			// We need to access private method for testing
			const compatibility = (
				scheduler as unknown as { checkTaskCompatibility: (q1: unknown, q2: unknown) => unknown }
			).checkTaskCompatibility(task1, task2);

			expect(compatibility.compatible).toBeFalsy();
			expect(compatibility.conflicts).toContainEqual(
				expect.objectContaining({ type: "explicit", severity: "blocking" }),
			);
		});

		it("should allow package overlap with reduced score", () => {
			const task1 = createTestTask("task-1", "Step 1", ["auth", "utils"], []);
			const task2 = createTestTask("task-2", "Step 2", ["auth", "components"], []);

			const compatibility = (
				scheduler as unknown as { checkTaskCompatibility: (q1: unknown, q2: unknown) => unknown }
			).checkTaskCompatibility(task1, task2);

			expect(compatibility.compatible).toBeTruthy();
			expect(compatibility.compatibilityScore).toBeLessThan(1.0);
			expect(compatibility.conflicts).toContainEqual(
				expect.objectContaining({ type: "package_overlap", severity: "warning" }),
			);
		});

		it("should block file conflicts", () => {
			const task1 = createTestTask("task-1", "Step 1", ["pkg1"], ["src/shared.ts"]);
			const task2 = createTestTask("task-2", "Step 2", ["pkg2"], ["src/shared.ts"]);

			const compatibility = (
				scheduler as unknown as { checkTaskCompatibility: (q1: unknown, q2: unknown) => unknown }
			).checkTaskCompatibility(task1, task2);

			expect(compatibility.compatible).toBeFalsy();
			expect(compatibility.conflicts).toContainEqual(
				expect.objectContaining({ type: "file_conflict", severity: "blocking" }),
			);
		});

		it("should penalize high-risk task combinations", () => {
			const task1 = { ...createTestTask("task-1", "Step 1", ["pkg1"]), riskScore: 0.8 };
			const task2 = { ...createTestTask("task-2", "Step 2", ["pkg2"]), riskScore: 0.9 };

			const compatibility = (
				scheduler as unknown as { checkTaskCompatibility: (q1: unknown, q2: unknown) => unknown }
			).checkTaskCompatibility(task1, task2);

			expect(compatibility.compatibilityScore).toBeLessThan(0.7);
		});

		it("should handle tasks with no computed data", () => {
			const task1: Task = {
				id: "task-1",
				objective: "Step without analysis",
				status: "pending",
				createdAt: new Date(),
			};
			const task2: Task = {
				id: "task-2",
				objective: "Another step",
				status: "pending",
				createdAt: new Date(),
			};

			const compatibility = (
				scheduler as unknown as { checkTaskCompatibility: (q1: unknown, q2: unknown) => unknown }
			).checkTaskCompatibility(task1, task2);

			// Should be compatible with perfect score when no conflicts detected
			expect(compatibility.compatible).toBeTruthy();
			expect(compatibility.compatibilityScore).toBe(1.0);
		});
	});

	describe("task set evaluation", () => {
		it("should calculate parallelism score correctly", () => {
			// Test the parallelism score calculation
			const taskSet = [
				createTestTask("task-1", "Independent step 1", ["pkg1"], ["file1.ts"]),
				createTestTask("task-2", "Independent step 2", ["pkg2"], ["file2.ts"]),
				createTestTask("task-3", "Independent step 3", ["pkg3"], ["file3.ts"]),
			];

			// Create a minimal compatibility matrix
			const compatibilityMatrix = taskSet.map((q1, i) =>
				taskSet.map((q2, j) => ({
					task1Id: q1.id,
					task2Id: q2.id,
					compatible: true,
					conflicts: [],
					compatibilityScore: i === j ? 1.0 : 0.9, // High compatibility for different tasks
				})),
			);

			const score = (scheduler as unknown as SchedulerTestMethods).calculateParallelismScore(
				taskSet,
				compatibilityMatrix,
			);

			expect(score).toBeGreaterThan(0.5); // Should get good parallelism score
			expect(score).toBeLessThanOrEqual(1.0);
		});

		it("should estimate duration correctly", () => {
			const taskSet = [
				{ ...createTestTask("task-1", "Low complexity", ["pkg1"]), tags: ["low"] },
				{ ...createTestTask("task-2", "High complexity", ["pkg2"]), tags: ["high"] },
			];

			const duration = (scheduler as unknown as SchedulerTestMethods).estimateSetDuration(taskSet);

			// Should take the maximum duration (high complexity = 45 minutes)
			expect(duration).toBe(45 * 60 * 1000);
		});

		it("should calculate risk level correctly", () => {
			const lowRiskSet = [
				{ ...createTestTask("task-1", "Safe step", ["pkg1"]), riskScore: 0.2 },
				{ ...createTestTask("task-2", "Another safe step", ["pkg2"]), riskScore: 0.3 },
			];

			const highRiskSet = [
				{ ...createTestTask("task-3", "Risky step", ["pkg3"]), riskScore: 0.9 },
				{ ...createTestTask("task-4", "Another risky step", ["pkg4"]), riskScore: 0.8 },
			];

			const lowRisk = (
				scheduler as unknown as { calculateSetRiskLevel: (taskSet: unknown) => string }
			).calculateSetRiskLevel(lowRiskSet);
			const highRisk = (
				scheduler as unknown as { calculateSetRiskLevel: (taskSet: unknown) => string }
			).calculateSetRiskLevel(highRiskSet);

			expect(lowRisk).toBe("low");
			expect(highRisk).toBe("high");
		});
	});
});
