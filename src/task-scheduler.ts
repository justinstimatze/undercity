/**
 * Task Scheduler Module
 *
 * Core matchmaking engine for finding compatible task sets that can run in parallel.
 * Analyzes dependencies, conflicts, and resource requirements to optimize parallel execution.
 */

import type { FileTracker } from "./file-tracker.js";
import type { Task } from "./task.js";
import type { TaskAnalyzer } from "./task-analyzer.js";

export interface TaskSet {
	tasks: Task[];
	estimatedDuration: number;
	riskLevel: "low" | "medium" | "high";
	parallelismScore: number;
	compatibilityMatrix: CompatibilityResult[][];
}

export interface TaskDependencyGraph {
	nodes: Task[];
	edges: TaskDependency[];
	readyTasks: Task[];
}

export interface TaskDependency {
	fromTaskId: string;
	toTaskId: string;
	type: "explicit" | "file_conflict" | "package_overlap";
	severity: "blocking" | "warning";
}

export interface CompatibilityResult {
	task1Id: string;
	task2Id: string;
	compatible: boolean;
	conflicts: TaskDependency[];
	compatibilityScore: number; // 0-1, where 1 is fully compatible
}

export class TaskScheduler {
	private analyzer: TaskAnalyzer;
	private fileTracker: FileTracker;
	private maxParallelTasks: number;

	constructor(analyzer: TaskAnalyzer, fileTracker: FileTracker, maxParallelTasks: number = 3) {
		this.analyzer = analyzer;
		this.fileTracker = fileTracker;
		this.maxParallelTasks = maxParallelTasks;
	}

	/**
	 * Main matchmaking algorithm - find optimal parallelizable task sets
	 */
	async findParallelizableSets(availableTasks: Task[]): Promise<TaskSet[]> {
		if (availableTasks.length === 0) return [];

		// First, analyze all tasks to ensure they have computed analysis
		const analyzedTasks = await this.ensureTaskAnalysis(availableTasks);

		// Build dependency graph to understand relationships
		const dependencyGraph = this.buildDependencyGraph(analyzedTasks);

		// Find all possible task combinations
		const taskSets = this.generateQuestCombinations(dependencyGraph.readyTasks, this.maxParallelTasks);

		// Evaluate each set for compatibility and performance
		const evaluatedSets: TaskSet[] = [];
		for (const taskSet of taskSets) {
			const evaluation = await this.evaluateTaskSet(taskSet);
			if (evaluation) {
				evaluatedSets.push(evaluation);
			}
		}

		// Sort by parallelism score (higher is better)
		evaluatedSets.sort((a, b) => b.parallelismScore - a.parallelismScore);

		return evaluatedSets;
	}

	/**
	 * Ensure all tasks have computed analysis data
	 */
	private async ensureTaskAnalysis(tasks: Task[]): Promise<Task[]> {
		const analyzed: Task[] = [];

		for (const task of tasks) {
			let analyzedTask = { ...task };

			// Skip analysis if already computed
			if (!task.computedPackages || !task.riskScore) {
				const analysis = await this.analyzer.analyzeTask(task);
				analyzedTask = {
					...task,
					computedPackages: analysis.packages,
					riskScore: analysis.riskScore,
					estimatedFiles: analysis.estimatedFiles,
					tags: analysis.tags,
				};
			}

			analyzed.push(analyzedTask);
		}

		return analyzed;
	}

	/**
	 * Build dependency graph and identify ready-to-run tasks
	 */
	buildDependencyGraph(tasks: Task[]): TaskDependencyGraph {
		const edges: TaskDependency[] = [];
		const blockedTasks = new Set<string>();

		// Process explicit dependencies
		for (const task of tasks) {
			if (task.dependsOn) {
				for (const depId of task.dependsOn) {
					edges.push({
						fromTaskId: depId,
						toTaskId: task.id,
						type: "explicit",
						severity: "blocking",
					});
					blockedTasks.add(task.id);
				}
			}

			// Process explicit conflicts
			if (task.conflicts) {
				for (const conflictId of task.conflicts) {
					edges.push({
						fromTaskId: task.id,
						toTaskId: conflictId,
						type: "explicit",
						severity: "blocking",
					});
				}
			}
		}

		// Detect implicit conflicts (package overlap, file conflicts)
		for (let i = 0; i < tasks.length; i++) {
			for (let j = i + 1; j < tasks.length; j++) {
				const task1 = tasks[i];
				const task2 = tasks[j];

				const conflicts = this.detectImplicitConflicts(task1, task2);
				edges.push(...conflicts);

				if (conflicts.some((c) => c.severity === "blocking")) {
					// Mark both tasks as potentially conflicting
					// (actual blocking will be resolved in compatibility check)
				}
			}
		}

		// Identify ready tasks (no blocking dependencies)
		const readyTasks = tasks.filter((task) => !blockedTasks.has(task.id));

		return {
			nodes: tasks,
			edges,
			readyTasks,
		};
	}

	/**
	 * Detect implicit conflicts between two tasks
	 */
	private detectImplicitConflicts(task1: Task, task2: Task): TaskDependency[] {
		const conflicts: TaskDependency[] = [];

		// Check package boundary overlap
		const task1Packages = task1.computedPackages || [];
		const task2Packages = task2.computedPackages || [];

		if (this.hasPackageOverlap(task1Packages, task2Packages)) {
			conflicts.push({
				fromTaskId: task1.id,
				toTaskId: task2.id,
				type: "package_overlap",
				severity: "warning", // Package overlap is warning, not blocking
			});
		}

		// Check estimated file conflicts
		const task1Files = task1.estimatedFiles || [];
		const task2Files = task2.estimatedFiles || [];

		if (this.hasFileOverlap(task1Files, task2Files)) {
			conflicts.push({
				fromTaskId: task1.id,
				toTaskId: task2.id,
				type: "file_conflict",
				severity: "blocking", // File conflicts are blocking
			});
		}

		return conflicts;
	}

	/**
	 * Generate all possible combinations of tasks up to maxSize
	 */
	private generateQuestCombinations(tasks: Task[], maxSize: number): Task[][] {
		const combinations: Task[][] = [];

		// Single task combinations (always valid)
		for (const task of tasks) {
			combinations.push([task]);
		}

		// Multi-task combinations
		for (let size = 2; size <= Math.min(maxSize, tasks.length); size++) {
			const sizeCombinations = this.getCombinations(tasks, size);
			combinations.push(...sizeCombinations);
		}

		return combinations;
	}

	/**
	 * Get all combinations of a specific size
	 */
	private getCombinations<T>(items: T[], size: number): T[][] {
		if (size === 1) {
			return items.map((item) => [item]);
		}

		const combinations: T[][] = [];
		for (let i = 0; i < items.length - size + 1; i++) {
			const head = items[i];
			const tailCombinations = this.getCombinations(items.slice(i + 1), size - 1);
			for (const tail of tailCombinations) {
				combinations.push([head, ...tail]);
			}
		}

		return combinations;
	}

	/**
	 * Evaluate a task set for compatibility and performance
	 */
	private async evaluateTaskSet(taskSet: Task[]): Promise<TaskSet | null> {
		if (taskSet.length === 0) return null;

		// Build compatibility matrix
		const compatibilityMatrix = this.buildCompatibilityMatrix(taskSet);

		// Check if all tasks in the set are compatible
		let _allCompatible = true;
		const allConflicts: TaskDependency[] = [];

		for (const row of compatibilityMatrix) {
			for (const result of row) {
				if (!result.compatible) {
					_allCompatible = false;
				}
				allConflicts.push(...result.conflicts);
			}
		}

		// If any blocking conflicts exist, this set is invalid
		const blockingConflicts = allConflicts.filter((c) => c.severity === "blocking");
		if (blockingConflicts.length > 0) {
			return null;
		}

		// Calculate metrics
		const estimatedDuration = this.estimateSetDuration(taskSet);
		const riskLevel = this.calculateSetRiskLevel(taskSet);
		const parallelismScore = this.calculateParallelismScore(taskSet, compatibilityMatrix);

		return {
			tasks: taskSet,
			estimatedDuration,
			riskLevel,
			parallelismScore,
			compatibilityMatrix,
		};
	}

	/**
	 * Build compatibility matrix for a task set
	 */
	private buildCompatibilityMatrix(taskSet: Task[]): CompatibilityResult[][] {
		const matrix: CompatibilityResult[][] = [];

		for (let i = 0; i < taskSet.length; i++) {
			const row: CompatibilityResult[] = [];
			for (let j = 0; j < taskSet.length; j++) {
				if (i === j) {
					// Task is always compatible with itself
					row.push({
						task1Id: taskSet[i].id,
						task2Id: taskSet[j].id,
						compatible: true,
						conflicts: [],
						compatibilityScore: 1.0,
					});
				} else {
					const compatibility = this.checkTaskCompatibility(taskSet[i], taskSet[j]);
					row.push(compatibility);
				}
			}
			matrix.push(row);
		}

		return matrix;
	}

	/**
	 * Check if two tasks are compatible for parallel execution
	 */
	private checkTaskCompatibility(task1: Task, task2: Task): CompatibilityResult {
		const conflicts: TaskDependency[] = [];
		let score = 1.0;

		// Check explicit dependencies
		if (task1.dependsOn?.includes(task2.id) || task2.dependsOn?.includes(task1.id)) {
			conflicts.push({
				fromTaskId: task1.id,
				toTaskId: task2.id,
				type: "explicit",
				severity: "blocking",
			});
			score = 0;
		}

		// Check explicit conflicts
		if (task1.conflicts?.includes(task2.id) || task2.conflicts?.includes(task1.id)) {
			conflicts.push({
				fromTaskId: task1.id,
				toTaskId: task2.id,
				type: "explicit",
				severity: "blocking",
			});
			score = 0;
		}

		// Check package boundary overlap
		const task1Packages = task1.computedPackages || [];
		const task2Packages = task2.computedPackages || [];
		if (this.hasPackageOverlap(task1Packages, task2Packages)) {
			conflicts.push({
				fromTaskId: task1.id,
				toTaskId: task2.id,
				type: "package_overlap",
				severity: "warning",
			});
			score -= 0.3; // Reduce score but don't block
		}

		// Check estimated file conflicts
		const task1Files = task1.estimatedFiles || [];
		const task2Files = task2.estimatedFiles || [];
		if (this.hasFileOverlap(task1Files, task2Files)) {
			conflicts.push({
				fromTaskId: task1.id,
				toTaskId: task2.id,
				type: "file_conflict",
				severity: "blocking",
			});
			score = 0;
		}

		// Check risk threshold (avoid running multiple high-risk tasks)
		const task1Risk = task1.riskScore || 0;
		const task2Risk = task2.riskScore || 0;
		if (task1Risk > 0.7 && task2Risk > 0.7) {
			score -= 0.4; // Heavy penalty for double high-risk
		}

		const compatible = score > 0 && !conflicts.some((c) => c.severity === "blocking");

		return {
			task1Id: task1.id,
			task2Id: task2.id,
			compatible,
			conflicts,
			compatibilityScore: Math.max(0, score),
		};
	}

	/**
	 * Check if two package arrays have overlapping entries
	 */
	private hasPackageOverlap(packages1: string[], packages2: string[]): boolean {
		const set1 = new Set(packages1);
		return packages2.some((pkg) => set1.has(pkg));
	}

	/**
	 * Check if two file arrays have overlapping patterns
	 */
	private hasFileOverlap(files1: string[], files2: string[]): boolean {
		// Simple exact match check for now
		// In a more sophisticated implementation, this could handle glob patterns
		const set1 = new Set(files1);
		return files2.some((file) => set1.has(file));
	}

	/**
	 * Estimate total duration for a task set (assumes parallel execution)
	 */
	private estimateSetDuration(taskSet: Task[]): number {
		// For parallel execution, duration is the maximum of individual task durations
		// Base estimate: complexity maps to duration
		const durations = taskSet.map((task) => {
			const complexity = task.tags?.includes("high") ? "high" : task.tags?.includes("medium") ? "medium" : "low";
			switch (complexity) {
				case "high":
					return 45 * 60 * 1000; // 45 minutes
				case "medium":
					return 25 * 60 * 1000; // 25 minutes
				case "low":
					return 15 * 60 * 1000; // 15 minutes
				default:
					return 20 * 60 * 1000; // 20 minutes default
			}
		});

		return Math.max(...durations);
	}

	/**
	 * Calculate overall risk level for a task set
	 */
	private calculateSetRiskLevel(taskSet: Task[]): "low" | "medium" | "high" {
		const maxRisk = Math.max(...taskSet.map((q) => q.riskScore || 0));
		const avgRisk = taskSet.reduce((sum, q) => sum + (q.riskScore || 0), 0) / taskSet.length;

		if (maxRisk > 0.8 || avgRisk > 0.6) return "high";
		if (maxRisk > 0.5 || avgRisk > 0.3) return "medium";
		return "low";
	}

	/**
	 * Calculate parallelism score (higher is better for parallel execution)
	 */
	private calculateParallelismScore(taskSet: Task[], compatibilityMatrix: CompatibilityResult[][]): number {
		if (taskSet.length === 1) {
			// Single task gets base score
			return 0.5;
		}

		// Start with base parallelism benefit
		let score = taskSet.length * 0.3; // More tasks = higher parallelism

		// Add compatibility bonus
		let totalCompatibility = 0;
		let pairCount = 0;

		for (let i = 0; i < compatibilityMatrix.length; i++) {
			for (let j = i + 1; j < compatibilityMatrix[i].length; j++) {
				totalCompatibility += compatibilityMatrix[i][j].compatibilityScore;
				pairCount++;
			}
		}

		if (pairCount > 0) {
			const avgCompatibility = totalCompatibility / pairCount;
			score += avgCompatibility * 0.4; // Reward high compatibility
		}

		// Penalty for risk concentration
		const highRiskCount = taskSet.filter((q) => (q.riskScore || 0) > 0.7).length;
		score -= highRiskCount * 0.2;

		// Bonus for diverse task types
		const uniqueTags = new Set<string>();
		for (const task of taskSet) {
			if (task.tags) {
				for (const tag of task.tags) {
					uniqueTags.add(tag);
				}
			}
		}
		score += Math.min(uniqueTags.size * 0.1, 0.3); // Up to 0.3 bonus for diversity

		return Math.max(0, Math.min(1, score)); // Clamp to [0, 1]
	}

	/**
	 * Select the optimal task set from available options
	 */
	selectOptimalTaskSet(taskSets: TaskSet[], maxCount: number = 3): TaskSet | null {
		if (taskSets.length === 0) return null;

		// Filter by size constraint
		const validSets = taskSets.filter((set) => set.tasks.length <= maxCount);
		if (validSets.length === 0) return null;

		// Sort by parallelism score and return the best
		validSets.sort((a, b) => b.parallelismScore - a.parallelismScore);
		return validSets[0];
	}
}
