/**
 * Orchestrator Result Handlers
 *
 * Extracted helper functions for processing worker results.
 */

import * as output from "../output.js";
import type { UnresolvedTicket } from "../review.js";
import { addTask, decomposeTaskIntoSubtasks, getAllTasks } from "../task.js";
import type { TaskResult } from "../worker.js";

/**
 * Result of decomposition attempt
 */
export interface DecompositionResult {
	decomposed: boolean;
	earlyReturn?: {
		task: string;
		taskId: string;
		result: TaskResult;
		worktreePath: string;
		branch: string;
		merged: false;
		decomposed: true;
		modifiedFiles: string[];
	};
}

/**
 * Handle task decomposition when agent determines task needs to be broken down
 */
export function handleTaskDecomposition(
	task: string,
	taskId: string,
	worktreePath: string,
	branch: string,
	result: TaskResult,
	modifiedFiles: string[],
	originalTaskIds: Map<string, string>,
): DecompositionResult {
	if (!result.needsDecomposition) {
		return { decomposed: false };
	}

	const { reason, suggestedSubtasks } = result.needsDecomposition;

	if (!suggestedSubtasks || suggestedSubtasks.length === 0) {
		output.warning(`Task needs decomposition but no subtasks suggested: ${reason}`, { taskId });
		return { decomposed: false };
	}

	// Use the original task ID from the board, not the worktree ID
	let originalTaskId = originalTaskIds.get(task);
	if (!originalTaskId) {
		// Fallback: lookup from tasks by objective (handles recovery path)
		const allTasks = getAllTasks();
		const matchingTask = allTasks.find((t) => t.objective === task);
		if (matchingTask) {
			originalTaskId = matchingTask.id;
			// Cache it for future lookups
			originalTaskIds.set(task, originalTaskId);
			output.debug(`Resolved task ID from board fallback lookup`, { taskId: originalTaskId });
		}
	}

	if (!originalTaskId) {
		output.warning(`Cannot decompose task: no board task ID found`, {
			taskId,
			task: task.substring(0, 50),
		});
		return { decomposed: false };
	}

	output.info(`Decomposing task into ${suggestedSubtasks.length} subtasks`, {
		taskId: originalTaskId,
		reason,
	});

	try {
		const subtaskIds = decomposeTaskIntoSubtasks({
			parentTaskId: originalTaskId,
			subtasks: suggestedSubtasks.map((objective: string, i: number) => ({
				objective,
				order: i,
			})),
		});
		output.info(`Created subtasks: ${subtaskIds.join(", ")}`, { taskId: originalTaskId });

		return {
			decomposed: true,
			earlyReturn: {
				task,
				taskId,
				result: { ...result, status: "failed", error: "DECOMPOSED" },
				worktreePath,
				branch,
				merged: false,
				decomposed: true,
				modifiedFiles,
			},
		};
	} catch (decomposeError) {
		output.warning(`Failed to decompose task: ${decomposeError}`, { taskId, originalTaskId });
		return { decomposed: false };
	}
}

/**
 * Report task completion or failure with worker name
 */
export function reportTaskOutcome(
	taskId: string,
	result: TaskResult,
	modifiedFiles: string[],
	workerName: string,
	processMetaTaskResult: (metaResult: NonNullable<TaskResult["metaTaskResult"]>, taskId: string) => void,
): void {
	if (result.status === "complete") {
		output.taskComplete(taskId, "Task completed", { workerName, modifiedFiles: modifiedFiles.length });
		if (result.metaTaskResult) {
			processMetaTaskResult(result.metaTaskResult, taskId);
		}
	} else {
		output.taskFailed(taskId, "Task failed", result.error, { workerName });
	}
}

/**
 * Handle unresolved tickets from review - spawn follow-up tasks
 *
 * When review finds issues it cannot fix, it generates UnresolvedTickets.
 * These are converted to child tasks that will be picked up in the next grind.
 *
 * Unlike decomposition, the parent task is NOT marked as decomposed - it already
 * did work (possibly partial). These are follow-up fixes, not a task breakdown.
 */
export function handleUnresolvedTickets(
	taskId: string,
	task: string,
	tickets: UnresolvedTicket[],
	originalTaskIds: Map<string, string>,
): string[] {
	if (!tickets || tickets.length === 0) {
		return [];
	}

	// Get the original task ID from the board
	let originalTaskId = originalTaskIds.get(task);
	if (!originalTaskId) {
		const allTasks = getAllTasks();
		const matchingTask = allTasks.find((t) => t.objective === task);
		if (matchingTask) {
			originalTaskId = matchingTask.id;
			originalTaskIds.set(task, originalTaskId);
		}
	}

	const createdTaskIds: string[] = [];

	for (const ticket of tickets) {
		try {
			// Build a rich task description from the ticket
			const objective = `[review-fix] ${ticket.title}`;

			// Map ticket priority to task priority (lower number = higher priority)
			const priorityMap = { high: 1, medium: 5, low: 10 };
			const priority = priorityMap[ticket.priority] ?? 5;

			// Create the follow-up task with context
			const newTask = addTask(objective, {
				priority,
				ticket: {
					description: ticket.description,
					acceptanceCriteria: [`Fix the issue: ${ticket.title}`],
					testPlan: ticket.files ? `Verify changes in: ${ticket.files.join(", ")}` : undefined,
					implementationNotes: ticket.context,
				},
				tags: ["review-fix"],
				relatedTo: originalTaskId ? [originalTaskId] : undefined,
			});

			createdTaskIds.push(newTask.id);

			output.info(`Created follow-up task from review: ${ticket.title}`, {
				taskId: newTask.id,
				priority: ticket.priority,
				parentTaskId: originalTaskId,
			});
		} catch (err) {
			output.warning(`Failed to create follow-up task: ${ticket.title}`, {
				error: String(err),
				taskId,
			});
		}
	}

	if (createdTaskIds.length > 0) {
		output.info(`Created ${createdTaskIds.length} follow-up task(s) from review findings`, {
			taskId,
			createdTaskIds,
		});
	}

	return createdTaskIds;
}
