/**
 * Task Decomposition Module
 *
 * Provides lazy complexity checking and task decomposition at pickup time.
 * Uses Haiku for cheap, fast assessment before expensive execution.
 *
 * Flow:
 * 1. Agent picks up task
 * 2. Quick atomicity check (~500 tokens with Haiku)
 * 3. If atomic → proceed with execution
 * 4. If not → decompose into subtasks, add to board
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
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
 * Uses Haiku for cheap, fast assessment (~500 tokens)
 */
export async function checkAtomicity(task: string): Promise<AtomicityCheckResult> {
	try {
		let result = "";

		for await (const message of query({
			prompt: `You are assessing whether a coding task can be completed in a SINGLE focused session.

Task: ${task}

A task is ATOMIC if:
- It can be completed by modifying 1-3 files
- It has a clear, specific objective
- It doesn't require multiple unrelated changes
- It can be tested/verified in one session

A task is NOT ATOMIC if:
- It requires changes across many files or packages
- It combines multiple unrelated objectives
- It's vague or requires significant research first
- It would take multiple sessions to complete properly

Respond with ONLY this JSON, no other text:
{
  "isAtomic": true/false,
  "confidence": 0.0-1.0,
  "estimatedFiles": number,
  "reasoning": "brief explanation"
}`,
			options: {
				model: "claude-3-5-haiku-20241022",
				maxTurns: 1,
				allowedTools: [],
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		// Parse the response
		const jsonMatch = result.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			return {
				isAtomic: Boolean(parsed.isAtomic),
				confidence: Number(parsed.confidence) || 0.5,
				estimatedFiles: Number(parsed.estimatedFiles) || 1,
				reasoning: String(parsed.reasoning || ""),
			};
		}

		// Default to atomic if parsing fails (don't block on assessment failure)
		logger.warn({ task, result }, "Failed to parse atomicity check, defaulting to atomic");
		return {
			isAtomic: true,
			confidence: 0.3,
			estimatedFiles: 1,
			reasoning: "Failed to parse assessment, proceeding with task",
		};
	} catch (error) {
		logger.error({ task, error }, "Atomicity check failed");
		// Don't block execution on assessment failure
		return {
			isAtomic: true,
			confidence: 0.2,
			estimatedFiles: 1,
			reasoning: "Assessment failed, proceeding with task",
		};
	}
}

/**
 * Decompose a complex task into smaller, atomic subtasks
 *
 * Uses Haiku for decomposition (~1000 tokens)
 */
export async function decomposeTask(task: string): Promise<DecompositionResult> {
	try {
		let result = "";

		for await (const message of query({
			prompt: `You are breaking down a complex coding task into smaller, atomic subtasks.

Task to decompose: ${task}

Rules for subtasks:
1. Each subtask should be completable in a single focused session
2. Each subtask should modify at most 1-3 files
3. Subtasks should be independent when possible (can be done in parallel)
4. Subtasks should have clear, specific objectives
5. Create 2-5 subtasks (prefer fewer, well-scoped tasks)
6. Order subtasks by dependency (things that must be done first come first)

Respond with ONLY this JSON, no other text:
{
  "subtasks": [
    {
      "objective": "specific task description",
      "estimatedFiles": ["path/to/file1.ts", "path/to/file2.ts"],
      "order": 1
    }
  ],
  "reasoning": "brief explanation of decomposition strategy"
}`,
			options: {
				model: "claude-3-5-haiku-20241022",
				maxTurns: 1,
				allowedTools: [],
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		// Parse the response
		const jsonMatch = result.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			const subtasks: Subtask[] = (parsed.subtasks || []).map(
				(st: { objective?: string; estimatedFiles?: string[]; order?: number }, idx: number) => ({
					objective: String(st.objective || task),
					estimatedFiles: st.estimatedFiles,
					order: Number(st.order) || idx + 1,
				}),
			);

			if (subtasks.length === 0) {
				// No decomposition possible, return original
				return {
					wasDecomposed: false,
					originalTask: task,
					subtasks: [],
					reasoning: "Could not decompose task",
				};
			}

			return {
				wasDecomposed: true,
				originalTask: task,
				subtasks: subtasks.sort((a, b) => a.order - b.order),
				reasoning: String(parsed.reasoning || "Task decomposed into atomic subtasks"),
			};
		}

		return {
			wasDecomposed: false,
			originalTask: task,
			subtasks: [],
			reasoning: "Failed to parse decomposition response",
		};
	} catch (error) {
		logger.error({ task, error }, "Task decomposition failed");
		return {
			wasDecomposed: false,
			originalTask: task,
			subtasks: [],
			reasoning: `Decomposition failed: ${error}`,
		};
	}
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
		};
	}

	return {
		action: "proceed",
		reasoning: atomicity.reasoning,
	};
}
