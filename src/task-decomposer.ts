/**
 * Task Decomposition Module
 *
 * Provides lazy complexity checking and task decomposition at pickup time.
 * Uses Ax/DSPy programs for self-improving prompts.
 *
 * Flow:
 * 1. Agent picks up task
 * 2. Quick atomicity check via Ax program
 * 3. If atomic → proceed with execution
 * 4. If not → decompose into subtasks, add to board
 *
 * Training data collected in .undercity/ax-examples/ for prompt optimization.
 */

import { checkAtomicityAx, decomposeTaskAx } from "./ax-programs.js";
import { sessionLogger } from "./logger.js";

const logger = sessionLogger.child({ module: "task-decomposer" });

/**
 * Result of atomicity check
 */
export interface AtomicityCheckResult {
	/** Whether the task can be completed in a single focused session */
	isAtomic: boolean;
	/** Confidence in the assessment (0-1) */
	confidence: number;
	/** Estimated number of files to modify */
	estimatedFiles: number;
	/** Brief reasoning */
	reasoning: string;
	/** Recommended starting model based on task complexity */
	recommendedModel: "haiku" | "sonnet" | "opus";
}

/**
 * A subtask decomposed from a larger task
 */
export interface Subtask {
	/** The subtask objective */
	objective: string;
	/** Estimated files this subtask will touch */
	estimatedFiles?: string[];
	/** Order/priority within the decomposition */
	order: number;
}

/**
 * Result of task decomposition
 */
export interface DecompositionResult {
	/** Whether decomposition was needed */
	wasDecomposed: boolean;
	/** Original task objective */
	originalTask: string;
	/** Subtasks if decomposed */
	subtasks: Subtask[];
	/** Why decomposition was needed (or why it wasn't) */
	reasoning: string;
}

/**
 * Check if a task is atomic (can be completed in a single focused session)
 *
 * Uses Ax/DSPy program for self-improving assessment
 */
export async function checkAtomicity(task: string): Promise<AtomicityCheckResult> {
	logger.debug({ task: task.substring(0, 50) }, "Running Ax atomicity check");
	return checkAtomicityAx(task);
}

/**
 * Decompose a complex task into smaller, atomic subtasks
 *
 * Uses Ax/DSPy program for self-improving decomposition
 */
export async function decomposeTask(task: string): Promise<DecompositionResult> {
	logger.debug({ task: task.substring(0, 50) }, "Running Ax decomposition");

	const result = await decomposeTaskAx(task);

	if (result.subtasks.length === 0) {
		return {
			wasDecomposed: false,
			originalTask: task,
			subtasks: [],
			reasoning: result.reasoning || "Could not decompose task",
		};
	}

	// Transform string subtasks to Subtask objects
	// Extract file paths from objectives like "In src/file.ts, do something"
	const subtasks: Subtask[] = result.subtasks.map((objective, idx) => {
		const fileMatch = objective.match(/(?:In |in )([\w/./-]+\.\w+)/);
		const estimatedFiles = fileMatch ? [fileMatch[1]] : undefined;

		return {
			objective,
			estimatedFiles,
			order: idx + 1,
		};
	});

	return {
		wasDecomposed: true,
		originalTask: task,
		subtasks,
		reasoning: result.reasoning,
	};
}

/**
 * Check and potentially decompose a task before execution
 *
 * This is the main entry point for the lazy decomposition flow:
 * 1. Check atomicity (cheap)
 * 2. If not atomic, decompose
 * 3. Return result indicating what happened
 */
export async function checkAndDecompose(
	task: string,
	options: {
		/** Skip check for tasks with certain tags */
		skipTags?: string[];
		/** Force decomposition regardless of check */
		forceDecompose?: boolean;
		/** Minimum confidence to trust atomicity check */
		minConfidence?: number;
	} = {},
): Promise<{
	action: "proceed" | "decomposed" | "skip";
	subtasks?: Subtask[];
	reasoning: string;
	/** Recommended model for task execution */
	recommendedModel?: "haiku" | "sonnet" | "opus";
}> {
	const { forceDecompose = false, minConfidence = 0.6 } = options;

	// Force decomposition if requested
	if (forceDecompose) {
		const decomposition = await decomposeTask(task);
		if (decomposition.wasDecomposed && decomposition.subtasks.length > 0) {
			return {
				action: "decomposed",
				subtasks: decomposition.subtasks,
				reasoning: `Force decomposed: ${decomposition.reasoning}`,
			};
		}
		return {
			action: "proceed",
			reasoning: "Force decompose requested but decomposition failed, proceeding with original task",
		};
	}

	// Check atomicity
	const atomicity = await checkAtomicity(task);

	logger.info(
		{
			task: task.substring(0, 100),
			isAtomic: atomicity.isAtomic,
			confidence: atomicity.confidence,
			estimatedFiles: atomicity.estimatedFiles,
		},
		"Atomicity check complete",
	);

	// If atomic with sufficient confidence, proceed
	if (atomicity.isAtomic && atomicity.confidence >= minConfidence) {
		return {
			action: "proceed",
			reasoning: atomicity.reasoning,
			recommendedModel: atomicity.recommendedModel,
		};
	}

	// If not atomic or low confidence, decompose
	if (!atomicity.isAtomic || atomicity.confidence < minConfidence) {
		const decomposition = await decomposeTask(task);

		if (decomposition.wasDecomposed && decomposition.subtasks.length > 0) {
			logger.info(
				{
					originalTask: task.substring(0, 100),
					subtaskCount: decomposition.subtasks.length,
				},
				"Task decomposed into subtasks",
			);

			return {
				action: "decomposed",
				subtasks: decomposition.subtasks,
				reasoning: decomposition.reasoning,
			};
		}

		// Decomposition failed, proceed with original (better to try than block)
		return {
			action: "proceed",
			reasoning: `Decomposition attempted but failed: ${decomposition.reasoning}. Proceeding with original task.`,
			recommendedModel: atomicity.recommendedModel,
		};
	}

	return {
		action: "proceed",
		reasoning: atomicity.reasoning,
		recommendedModel: atomicity.recommendedModel,
	};
}
