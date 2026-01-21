/**
 * Grind Decomposition Module
 *
 * Task atomicity checking, decomposition, and model assignment.
 */

import * as output from "../output.js";
import type { Task } from "../task.js";
import type { AtomicityResult, GrindConfig, TasksByModel, TaskWithModel } from "./types.js";

/**
 * Check atomicity and decompose complex tasks
 */
export async function checkAndDecomposeTasks(
	tasks: Task[],
	config: GrindConfig,
): Promise<{
	atomicTasks: TaskWithModel[];
	decomposedTaskIds: string[];
	blockedTaskIds: string[];
	atomicityResults: Map<string, AtomicityResult>;
}> {
	const { checkAndDecompose } = await import("../task-decomposer.js");
	const { decomposeTaskIntoSubtasks, markTaskBlocked } = await import("../task.js");

	const atomicTasks: TaskWithModel[] = [];
	const decomposedTaskIds: string[] = [];
	const blockedTaskIds: string[] = [];
	const atomicityResults = new Map<string, AtomicityResult>();

	output.progress("Checking task atomicity and complexity...");

	for (const task of tasks) {
		// Skip decomposition if task has reached max depth
		const taskDepth = task.decompositionDepth ?? 0;
		if (taskDepth >= config.maxDecompositionDepth) {
			output.debug(
				`Skipping decomposition for "${task.objective.substring(0, 40)}..." (depth ${taskDepth} >= max ${config.maxDecompositionDepth})`,
			);
			atomicTasks.push({
				...task,
				recommendedModel: "sonnet", // Default to sonnet for depth-limited tasks
			});
			continue;
		}

		const result = await checkAndDecompose(task.objective);

		if (result.action === "decomposed") {
			if (result.subtasks && result.subtasks.length > 0) {
				// Task was decomposed - add subtasks to board
				output.info(`Decomposed "${task.objective.substring(0, 50)}..." into ${result.subtasks.length} subtasks`);

				decomposeTaskIntoSubtasks(
					task.id,
					result.subtasks.map((st) => ({
						objective: st.objective,
						estimatedFiles: st.estimatedFiles,
						order: st.order,
					})),
				);

				for (let i = 0; i < result.subtasks.length; i++) {
					output.debug(`  Subtask ${i + 1}: ${result.subtasks[i].objective.substring(0, 60)}`);
				}

				decomposedTaskIds.push(task.id);
			} else {
				// Decomposition attempted but failed to produce subtasks
				output.warning(`Task too vague to decompose: "${task.objective.substring(0, 50)}..."`);
				markTaskBlocked(task.id, "Task too vague - decomposition failed to produce actionable subtasks");
				blockedTaskIds.push(task.id);
			}
		} else {
			// Task is atomic - include with recommended model
			atomicTasks.push({
				...task,
				recommendedModel: result.recommendedModel || "sonnet",
			});
			output.debug(`Task "${task.objective.substring(0, 40)}..." → ${result.recommendedModel || "sonnet"}`);

			// Store atomicity result for outcome recording
			atomicityResults.set(task.objective, {
				isAtomic: true,
				confidence: 0.8,
				estimatedFiles: 1,
				recommendedModel: result.recommendedModel || "sonnet",
				reasoning: result.reasoning,
			});
		}
	}

	return { atomicTasks, decomposedTaskIds, blockedTaskIds, atomicityResults };
}

/**
 * Refetch tasks after decomposition (to get new subtasks)
 */
export async function refetchTasksAfterDecomposition(maxCount: number, tasksProcessed: number): Promise<Task[]> {
	const { getAllTasks } = await import("../task.js");

	output.info("All tasks were decomposed. Fetching subtasks...");
	const refreshedTasks = getAllTasks();
	const newPendingTasks = refreshedTasks
		.filter((q) => (q.status === "pending" || q.status === "in_progress") && !q.isDecomposed)
		.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

	const newRemainingCount = maxCount > 0 ? maxCount - tasksProcessed : newPendingTasks.length;
	return maxCount > 0 ? newPendingTasks.slice(0, newRemainingCount) : newPendingTasks;
}

/**
 * Adjust models based on historical metrics
 */
export async function adjustModelsFromMetrics(tasks: TaskWithModel[]): Promise<void> {
	const { adjustModelFromMetrics } = await import("../complexity.js");

	for (const task of tasks) {
		const complexityLevel = (task as { complexity?: string }).complexity || "standard";
		const adjustedModel = await adjustModelFromMetrics(
			task.recommendedModel || "sonnet",
			complexityLevel as "trivial" | "simple" | "standard" | "complex" | "critical",
		);
		if (adjustedModel !== task.recommendedModel) {
			output.debug(
				`Metrics adjustment: ${task.objective.substring(0, 30)}... ${task.recommendedModel} → ${adjustedModel}`,
			);
			task.recommendedModel = adjustedModel;
		}
	}
}

/**
 * Apply capability ledger recommendations (can downgrade models)
 */
export async function applyLedgerRecommendations(tasks: TaskWithModel[]): Promise<void> {
	const { getRecommendedModel: getLedgerRecommendation } = await import("../capability-ledger.js");

	const modelOrder = ["haiku", "sonnet", "opus"] as const;

	for (const task of tasks) {
		const ledgerRec = getLedgerRecommendation(task.objective);
		const currentIdx = modelOrder.indexOf(task.recommendedModel || "sonnet");
		const ledgerIdx = modelOrder.indexOf(ledgerRec.model);

		// Only apply if high confidence and suggests a CHEAPER model
		if (ledgerRec.confidence >= 0.7 && ledgerIdx < currentIdx) {
			output.debug(
				`Ledger downgrade: ${task.objective.substring(0, 30)}... ${task.recommendedModel} → ${ledgerRec.model} (${(ledgerRec.confidence * 100).toFixed(0)}% confidence)`,
			);
			task.recommendedModel = ledgerRec.model;
		}
	}
}

/**
 * Group tasks by model tier
 */
export function groupTasksByModel(tasks: TaskWithModel[]): TasksByModel {
	const tasksByModel: TasksByModel = {
		haiku: [],
		sonnet: [],
		opus: [],
	};

	for (const task of tasks) {
		const model = task.recommendedModel || "sonnet";
		tasksByModel[model].push(task);
	}

	return tasksByModel;
}

/**
 * Full decomposition and model assignment pipeline
 */
export async function processTasksForExecution(
	tasks: Task[],
	config: GrindConfig,
): Promise<{
	tasksByModel: TasksByModel;
	atomicityResults: Map<string, AtomicityResult>;
	decomposedCount: number;
	blockedCount: number;
}> {
	let tasksWithModels: TaskWithModel[];
	let totalDecomposed = 0;
	let totalBlocked = 0;
	const allAtomicityResults = new Map<string, AtomicityResult>();

	if (config.decompose) {
		const result = await checkAndDecomposeTasks(tasks, config);
		tasksWithModels = result.atomicTasks;
		totalDecomposed = result.decomposedTaskIds.length;
		totalBlocked = result.blockedTaskIds.length;

		// Merge atomicity results
		for (const [key, value] of result.atomicityResults) {
			allAtomicityResults.set(key, value);
		}

		// If all tasks were decomposed, refetch subtasks
		if (tasksWithModels.length === 0 && totalDecomposed > 0) {
			const newTasks = await refetchTasksAfterDecomposition(config.maxCount, 0);

			if (newTasks.length === 0) {
				return {
					tasksByModel: { haiku: [], sonnet: [], opus: [] },
					atomicityResults: allAtomicityResults,
					decomposedCount: totalDecomposed,
					blockedCount: totalBlocked,
				};
			}

			// Re-assess the new subtasks
			const reResult = await checkAndDecomposeTasks(newTasks, config);
			tasksWithModels = reResult.atomicTasks;

			for (const [key, value] of reResult.atomicityResults) {
				allAtomicityResults.set(key, value);
			}
		}
	} else {
		// No decomposition - use default model for all tasks
		tasksWithModels = tasks.map((t) => ({
			...t,
			recommendedModel: config.startingModel,
		}));
	}

	// Adjust models based on historical data (unless model explicitly set)
	if (!config.startingModel || config.startingModel === "sonnet") {
		await adjustModelsFromMetrics(tasksWithModels);
		await applyLedgerRecommendations(tasksWithModels);
	}

	// Group by model
	const tasksByModel = groupTasksByModel(tasksWithModels);

	// Log distribution
	const modelCounts = Object.entries(tasksByModel)
		.filter(([, tasks]) => tasks.length > 0)
		.map(([model, tasks]) => `${model}: ${tasks.length}`)
		.join(", ");
	if (modelCounts) {
		output.info(`Model distribution: ${modelCounts}`);
	}

	return {
		tasksByModel,
		atomicityResults: allAtomicityResults,
		decomposedCount: totalDecomposed,
		blockedCount: totalBlocked,
	};
}
