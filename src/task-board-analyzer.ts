/**
 * Task Board Analyzer Module
 *
 * High-level analysis of the task board to find optimal task combinations,
 * provide insights, and support the task matchmaking system.
 */

import { FileTracker } from "./file-tracker.js";
import type { Task } from "./task.js";
import { getAllTasks, getReadyTasksForBatch, getTaskBoardAnalytics } from "./task.js";
import { TaskAnalyzer } from "./task-analyzer.js";
import { type CompatibilityResult, type TaskDependency, TaskScheduler, type TaskSet } from "./task-scheduler.js";

/** Interface for accessing private scheduler methods in analyzer */
interface SchedulerPrivateMethods {
	checkTaskCompatibility(task1: Task, task2: Task): CompatibilityResult;
}

export interface TaskBoardInsights {
	totalTasks: number;
	pendingTasks: number;
	readyForParallelization: number;
	averageComplexity: "low" | "medium" | "high";
	topConflictingPackages: string[];
	parallelizationOpportunities: ParallelizationOpportunity[];
	recommendations: string[];
}

export interface ParallelizationOpportunity {
	taskSet: TaskSet;
	description: string;
	benefit: "high" | "medium" | "low";
	estimatedTimesSaving: number; // Percentage time savings vs sequential
}

export interface CompatibilityMatrix {
	tasks: Task[];
	matrix: CompatibilityResult[][];
	summary: {
		totalPairs: number;
		compatiblePairs: number;
		conflictingPairs: number;
		averageCompatibilityScore: number;
	};
}

export class TaskBoardAnalyzer {
	private analyzer: TaskAnalyzer;
	private scheduler: TaskScheduler;
	private fileTracker: FileTracker;

	constructor() {
		this.analyzer = new TaskAnalyzer();
		this.fileTracker = new FileTracker();
		this.scheduler = new TaskScheduler(this.analyzer, this.fileTracker);
	}

	/**
	 * Analyze the current task board for parallelization insights
	 */
	async analyzeTaskBoard(): Promise<TaskBoardInsights> {
		const allTasks = getAllTasks();
		const pendingTasks = allTasks.filter((q) => q.status === "pending");

		// Get basic analytics
		const analytics = getTaskBoardAnalytics();

		// Analyze task complexities
		const complexities: string[] = [];
		for (const task of pendingTasks) {
			const analysis = await this.analyzer.analyzeTask(task);
			complexities.push(analysis.complexity);
		}

		const averageComplexity = this.calculateAverageComplexity(complexities);

		// Find parallelization opportunities
		const opportunities = await this.findParallelizationOpportunities(pendingTasks);

		// Generate recommendations
		const recommendations = this.generateRecommendations(pendingTasks, opportunities, analytics);

		return {
			totalTasks: allTasks.length,
			pendingTasks: pendingTasks.length,
			readyForParallelization: opportunities.reduce((sum, opp) => sum + opp.taskSet.tasks.length, 0),
			averageComplexity,
			topConflictingPackages: analytics.topConflictingPackages,
			parallelizationOpportunities: opportunities,
			recommendations,
		};
	}

	/**
	 * Find all possible parallelization opportunities in pending tasks
	 */
	async findParallelizationOpportunities(pendingTasks: Task[]): Promise<ParallelizationOpportunity[]> {
		if (pendingTasks.length < 2) return [];

		// Find compatible task sets
		const taskSets = await this.scheduler.findParallelizableSets(pendingTasks);

		// Filter and rank opportunities
		const opportunities: ParallelizationOpportunity[] = [];

		for (const taskSet of taskSets) {
			if (taskSet.tasks.length < 2) continue; // Skip single-task sets

			const timesSaving = this.estimateTimeSavings(taskSet);
			const benefit = this.categorizeBenefit(taskSet, timesSaving);
			const description = this.generateOpportunityDescription(taskSet);

			opportunities.push({
				taskSet,
				description,
				benefit,
				estimatedTimesSaving: timesSaving,
			});
		}

		// Sort by benefit and time savings
		opportunities.sort((a, b) => {
			const benefitScore = { high: 3, medium: 2, low: 1 };
			const aBenefit = benefitScore[a.benefit];
			const bBenefit = benefitScore[b.benefit];

			if (aBenefit !== bBenefit) {
				return bBenefit - aBenefit; // Higher benefit first
			}
			return b.estimatedTimesSaving - a.estimatedTimesSaving; // Higher savings first
		});

		return opportunities.slice(0, 5); // Return top 5 opportunities
	}

	/**
	 * Generate a compatibility matrix showing which tasks can run together
	 */
	async generateCompatibilityMatrix(tasks?: Task[]): Promise<CompatibilityMatrix> {
		const tasksToAnalyze = tasks ?? getReadyTasksForBatch(10);

		if (tasksToAnalyze.length === 0) {
			return {
				tasks: [],
				matrix: [],
				summary: {
					totalPairs: 0,
					compatiblePairs: 0,
					conflictingPairs: 0,
					averageCompatibilityScore: 0,
				},
			};
		}

		// Ensure all tasks are analyzed
		const analyzedTasks = await this.ensureTaskAnalysis(tasksToAnalyze);

		// Build compatibility matrix
		const matrix: CompatibilityResult[][] = [];
		let totalCompatibility = 0;
		let compatiblePairs = 0;
		let conflictingPairs = 0;
		let totalPairs = 0;

		for (let i = 0; i < analyzedTasks.length; i++) {
			const row: CompatibilityResult[] = [];

			for (let j = 0; j < analyzedTasks.length; j++) {
				if (i === j) {
					// Task is always compatible with itself
					row.push({
						task1Id: analyzedTasks[i].id,
						task2Id: analyzedTasks[j].id,
						compatible: true,
						conflicts: [],
						compatibilityScore: 1.0,
					});
				} else {
					const compatibility = await this.checkTaskCompatibility(analyzedTasks[i], analyzedTasks[j]);
					row.push(compatibility);

					// Update statistics (only count each pair once)
					if (i < j) {
						totalCompatibility += compatibility.compatibilityScore;
						totalPairs++;

						if (compatibility.compatible) {
							compatiblePairs++;
						} else {
							conflictingPairs++;
						}
					}
				}
			}
			matrix.push(row);
		}

		const averageCompatibilityScore = totalPairs > 0 ? totalCompatibility / totalPairs : 0;

		return {
			tasks: analyzedTasks,
			matrix,
			summary: {
				totalPairs,
				compatiblePairs,
				conflictingPairs,
				averageCompatibilityScore,
			},
		};
	}

	/**
	 * Get insights about specific task compatibility
	 */
	async analyzeTaskCompatibility(
		task1Id: string,
		task2Id: string,
	): Promise<{
		compatible: boolean;
		conflicts: Array<{
			type: string;
			description: string;
			severity: string;
		}>;
		recommendedAction: string;
	}> {
		const allTasks = getAllTasks();
		const task1 = allTasks.find((q) => q.id === task1Id);
		const task2 = allTasks.find((q) => q.id === task2Id);

		if (!task1 || !task2) {
			return {
				compatible: false,
				conflicts: [{ type: "not_found", description: "One or both tasks not found", severity: "blocking" }],
				recommendedAction: "Verify task IDs are correct",
			};
		}

		const compatibility = await this.checkTaskCompatibility(task1, task2);

		const conflicts = compatibility.conflicts.map((conflict: TaskDependency) => ({
			type: conflict.type,
			description: this.getConflictDescription(conflict),
			severity: conflict.severity,
		}));

		let recommendedAction = "";
		if (compatibility.compatible) {
			recommendedAction = "These tasks can run in parallel safely";
		} else {
			const blockingConflicts = conflicts.filter((c) => c.severity === "blocking");
			if (blockingConflicts.length > 0) {
				recommendedAction = "Run sequentially due to blocking conflicts";
			} else {
				recommendedAction = "Consider running in parallel with monitoring";
			}
		}

		return {
			compatible: compatibility.compatible,
			conflicts,
			recommendedAction,
		};
	}

	/**
	 * Provide optimization suggestions for the task board
	 */
	async getOptimizationSuggestions(): Promise<string[]> {
		const insights = await this.analyzeTaskBoard();
		const suggestions: string[] = [];

		// Task organization suggestions
		if (insights.pendingTasks > 10) {
			suggestions.push("Consider organizing tasks by package/feature to improve parallelization");
		}

		// Parallel execution suggestions
		if (insights.parallelizationOpportunities.length === 0 && insights.pendingTasks > 1) {
			suggestions.push("Add package hints to tasks to improve conflict detection");
			suggestions.push("Break down large tasks into smaller, more focused tasks");
		}

		// Risk management suggestions
		const highRiskOpportunities = insights.parallelizationOpportunities.filter(
			(opp) => opp.taskSet.riskLevel === "high",
		);
		if (highRiskOpportunities.length > 0) {
			suggestions.push("Consider running high-risk tasks sequentially or with extra monitoring");
		}

		// Conflict reduction suggestions
		if (insights.topConflictingPackages.length > 0) {
			suggestions.push(
				`Focus on parallelizing tasks outside of frequently-modified packages: ${insights.topConflictingPackages.slice(0, 3).join(", ")}`,
			);
		}

		// Efficiency suggestions
		const lowBenefitOpportunities = insights.parallelizationOpportunities.filter((opp) => opp.benefit === "low");
		if (lowBenefitOpportunities.length > 2) {
			suggestions.push("Focus on high-benefit parallelization opportunities first");
		}

		return suggestions;
	}

	/**
	 * Ensure all tasks have computed analysis data
	 */
	private async ensureTaskAnalysis(tasks: Task[]): Promise<Task[]> {
		const analyzed: Task[] = [];

		for (const task of tasks) {
			let analyzedTask = { ...task };

			if (!task.computedPackages || task.riskScore === undefined) {
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
	 * Check compatibility between two tasks
	 */
	private async checkTaskCompatibility(task1: Task, task2: Task) {
		// This delegates to the scheduler's compatibility checking logic
		// We create a minimal task set to use the scheduler's method
		const dummyScheduler = new TaskScheduler(this.analyzer, this.fileTracker);
		return (dummyScheduler as unknown as SchedulerPrivateMethods).checkTaskCompatibility(task1, task2);
	}

	/**
	 * Calculate average complexity from complexity array
	 */
	private calculateAverageComplexity(complexities: string[]): "low" | "medium" | "high" {
		if (complexities.length === 0) return "low";

		const scores = complexities.map((c) => ({ low: 1, medium: 2, high: 3 })[c] ?? 1);
		const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;

		if (average >= 2.5) return "high";
		if (average >= 1.5) return "medium";
		return "low";
	}

	/**
	 * Estimate time savings from parallel execution
	 */
	private estimateTimeSavings(taskSet: TaskSet): number {
		if (taskSet.tasks.length <= 1) return 0;

		// Simple model: parallel execution takes max(individual_times) vs sum(individual_times)
		// Assume each task takes similar time based on complexity
		const taskTimes = taskSet.tasks.map((task) => {
			const complexity = task.tags?.includes("high") ? "high" : task.tags?.includes("medium") ? "medium" : "low";
			return { low: 15, medium: 30, high: 60 }[complexity]; // minutes
		});

		const sequentialTime = taskTimes.reduce((sum, time) => sum + time, 0);
		const parallelTime = Math.max(...taskTimes);

		return Math.round(((sequentialTime - parallelTime) / sequentialTime) * 100);
	}

	/**
	 * Categorize the benefit level of a parallelization opportunity
	 */
	private categorizeBenefit(taskSet: TaskSet, timeSavings: number): "high" | "medium" | "low" {
		// High benefit: Good parallelism score, significant time savings, low risk
		if (taskSet.parallelismScore >= 0.7 && timeSavings >= 40 && taskSet.riskLevel === "low") {
			return "high";
		}

		// Medium benefit: Decent parallelism, moderate savings
		if (taskSet.parallelismScore >= 0.5 && timeSavings >= 25) {
			return "medium";
		}

		return "low";
	}

	/**
	 * Generate a description for a parallelization opportunity
	 */
	private generateOpportunityDescription(taskSet: TaskSet): string {
		const taskCount = taskSet.tasks.length;
		const tags = new Set<string>();

		for (const task of taskSet.tasks) {
			if (task.tags) {
				for (const tag of task.tags) {
					tags.add(tag);
				}
			}
		}

		const mainTypes = Array.from(tags).filter((tag) =>
			["feature", "bugfix", "refactor", "testing", "documentation"].includes(tag),
		);

		if (mainTypes.length > 0) {
			return `Run ${taskCount} ${mainTypes.join("/")} tasks in parallel`;
		}

		return `Run ${taskCount} tasks in parallel`;
	}

	/**
	 * Generate recommendations based on analysis
	 */
	private generateRecommendations(
		pendingTasks: Task[],
		opportunities: ParallelizationOpportunity[],
		analytics: ReturnType<typeof getTaskBoardAnalytics>,
	): string[] {
		const recommendations: string[] = [];

		// Basic recommendations
		if (opportunities.length === 0 && pendingTasks.length > 1) {
			recommendations.push("No parallel opportunities found - consider adding package hints to tasks");
		}

		if (opportunities.length > 0) {
			const bestOpportunity = opportunities[0];
			recommendations.push(
				`Best opportunity: ${bestOpportunity.description} (${bestOpportunity.estimatedTimesSaving}% time savings)`,
			);
		}

		// Efficiency recommendations
		if (analytics.averageCompletionTime > 30 * 60 * 1000) {
			// 30 minutes
			recommendations.push("Consider breaking down long-running tasks for better parallelization");
		}

		// Risk management
		const highRiskOpportunities = opportunities.filter((opp) => opp.taskSet.riskLevel === "high");
		if (highRiskOpportunities.length > 0) {
			recommendations.push("Monitor high-risk parallel executions carefully");
		}

		return recommendations;
	}

	/**
	 * Get human-readable description for a conflict
	 */
	private getConflictDescription(conflict: TaskDependency): string {
		switch (conflict.type) {
			case "explicit":
				return "Explicit dependency or conflict defined";
			case "package_overlap":
				return "Tasks modify the same package/module";
			case "file_conflict":
				return "Tasks are likely to modify the same files";
			default:
				return "Unknown conflict type";
		}
	}
}
