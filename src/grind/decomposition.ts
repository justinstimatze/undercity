/**
 * Grind Decomposition Module
 *
 * Task atomicity checking, decomposition, and model assignment.
 */

import { recordAtomicityOutcome, recordDecompositionOutcome } from "../ax-programs.js";
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

		// Build ticket content string for decomposer context
		const ticketContent = task.ticket?.description;

		const result = await checkAndDecompose(task.objective, { ticketContent });

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

				// Record decomposition outcome for Ax learning
				// Note: We assume success since subtasks were generated; actual outcome
				// is only known after subtasks complete (which we can't track here)
				try {
					recordDecompositionOutcome(
						task.objective,
						result.subtasks.map((st) => st.objective),
						result.reasoning || "Task decomposed into subtasks",
						true, // Assume correct since subtasks were generated
					);
				} catch {
					// Non-critical
				}
			} else {
				// Decomposition attempted but failed to produce subtasks
				output.warning(`Task too vague to decompose: "${task.objective.substring(0, 50)}..."`);
				markTaskBlocked(task.id, "Task too vague - decomposition failed to produce actionable subtasks");
				blockedTaskIds.push(task.id);
			}
		} else {
			// Task is atomic - include with recommended model
			const model = result.recommendedModel === "haiku" ? "sonnet" : result.recommendedModel || "sonnet";
			atomicTasks.push({
				...task,
				recommendedModel: model,
			});
			output.debug(`Task "${task.objective.substring(0, 40)}..." → ${model}`);

			// Store atomicity result for outcome recording
			atomicityResults.set(task.objective, {
				isAtomic: true,
				confidence: 0.8,
				estimatedFiles: 1,
				recommendedModel: result.recommendedModel || "sonnet",
				reasoning: result.reasoning,
			});

			// Record atomicity outcome for Ax learning
			// Note: We assume success since task was assessed as atomic; actual outcome
			// is only known after task completes (tracked via atomicityResults map)
			try {
				recordAtomicityOutcome(
					task.objective,
					{
						isAtomic: true,
						confidence: 0.8,
						estimatedFiles: 1,
						recommendedModel: result.recommendedModel || "sonnet",
						reasoning: result.reasoning || "Task assessed as atomic by decomposer",
					},
					true, // Assume correct since we're proceeding with task
				);
			} catch {
				// Non-critical
			}
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
		.sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500)); // Lower number = higher priority

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
		const currentModel = task.recommendedModel || "sonnet";
		const adjustedModel = await adjustModelFromMetrics(
			currentModel,
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

	const modelOrder = ["sonnet", "opus"] as const;

	for (const task of tasks) {
		const ledgerRec = getLedgerRecommendation(task.objective);
		const currentModel = task.recommendedModel || "sonnet";
		const currentIdx = modelOrder.indexOf(currentModel);
		const ledgerIdx = modelOrder.indexOf(ledgerRec.model as "sonnet" | "opus");

		// Only apply if high confidence and suggests a CHEAPER model
		if (ledgerIdx >= 0 && ledgerRec.confidence >= 0.7 && ledgerIdx < currentIdx) {
			output.debug(
				`Ledger downgrade: ${task.objective.substring(0, 30)}... ${task.recommendedModel} → ${ledgerRec.model} (${(ledgerRec.confidence * 100).toFixed(0)}% confidence)`,
			);
			task.recommendedModel = ledgerRec.model as "sonnet" | "opus";
		}
	}
}

/**
 * Group tasks by model tier, preserving priority order within each tier
 * DEPRECATED: Use sortTasksByPriority instead for global priority ordering
 */
export function groupTasksByModel(tasks: TaskWithModel[]): TasksByModel {
	const tasksByModel: TasksByModel = {
		sonnet: [],
		opus: [],
	};

	for (const task of tasks) {
		const model = task.recommendedModel || "sonnet";
		tasksByModel[model].push(task);
	}

	// Sort each group by priority (lower = higher priority)
	tasksByModel.sonnet.sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
	tasksByModel.opus.sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));

	return tasksByModel;
}

/**
 * Sort tasks by global priority (lower number = higher priority)
 */
export function sortTasksByPriority(tasks: TaskWithModel[]): TaskWithModel[] {
	return [...tasks].sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
}

/**
 * Full decomposition and model assignment pipeline
 */
export async function processTasksForExecution(
	tasks: Task[],
	config: GrindConfig,
): Promise<{
	tasksByModel: TasksByModel;
	prioritizedTasks: TaskWithModel[];
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
					tasksByModel: { sonnet: [], opus: [] },
					prioritizedTasks: [],
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

	// Group by model (deprecated, for backward compatibility)
	const tasksByModel = groupTasksByModel(tasksWithModels);

	// Sort by global priority (new approach)
	const prioritizedTasks = sortTasksByPriority(tasksWithModels);

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
		prioritizedTasks,
		atomicityResults: allAtomicityResults,
		decomposedCount: totalDecomposed,
		blockedCount: totalBlocked,
	};
}
