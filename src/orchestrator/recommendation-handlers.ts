/**
 * Orchestrator Recommendation Handlers
 *
 * Extracted handlers for meta-task recommendations to reduce switch complexity.
 */

import * as output from "../output.js";
import {
	addTask,
	getTaskById,
	markTaskBlocked,
	markTaskComplete,
	removeTasks,
	type Task,
	unblockTask,
	updateTaskFields,
} from "../task.js";
import type { MetaTaskRecommendation } from "../types.js";

/**
 * Context for recommendation handlers
 */
export interface RecommendationContext {
	verbose: boolean;
}

/**
 * Handler function signature for recommendations
 */
type RecommendationHandler = (rec: MetaTaskRecommendation, ctx: RecommendationContext) => void;

/**
 * Handle "remove" recommendation
 */
const handleRemove: RecommendationHandler = (rec, ctx) => {
	if (rec.taskId) {
		const removed = removeTasks([rec.taskId]);
		if (removed > 0 && ctx.verbose) {
			output.debug(`Removed task ${rec.taskId}: ${rec.reason}`);
		}
	}
};

/**
 * Handle "add" recommendation
 */
const handleAdd: RecommendationHandler = (rec, ctx) => {
	if (rec.newTask) {
		const task = addTask(rec.newTask.objective, rec.newTask.priority);
		if (ctx.verbose) {
			output.debug(`Added task ${task.id}: ${rec.newTask.objective.substring(0, 50)}...`);
		}
	}
};

/**
 * Handle "complete" and "fix_status" recommendations
 */
const handleComplete: RecommendationHandler = (rec, ctx) => {
	if (rec.taskId) {
		const task = getTaskById(rec.taskId);
		if (task) {
			markTaskComplete(rec.taskId);
			if (ctx.verbose) {
				output.debug(`Marked ${rec.taskId} complete: ${rec.reason}`);
			}
		}
	}
};

/**
 * Handle "prioritize" recommendation
 */
const handlePrioritize: RecommendationHandler = (rec, ctx) => {
	if (rec.taskId && rec.updates?.priority !== undefined) {
		const task = getTaskById(rec.taskId);
		if (task) {
			updateTaskFields(rec.taskId, { priority: rec.updates.priority });
			if (ctx.verbose) {
				output.debug(`Updated priority for ${rec.taskId} to ${rec.updates.priority}`);
			}
		}
	}
};

/**
 * Handle "update" recommendation
 */
const handleUpdate: RecommendationHandler = (rec, ctx) => {
	if (rec.taskId && rec.updates) {
		const task = getTaskById(rec.taskId);
		if (task) {
			updateTaskFields(rec.taskId, {
				objective: rec.updates.objective,
				priority: rec.updates.priority,
				tags: rec.updates.tags,
			});
			if (ctx.verbose) {
				output.debug(`Updated task ${rec.taskId}`);
			}
		}
	}
};

/**
 * Handle "block" recommendation
 */
const handleBlock: RecommendationHandler = (rec) => {
	if (rec.taskId) {
		const task = getTaskById(rec.taskId);
		if (task) {
			markTaskBlocked({ id: rec.taskId, reason: rec.reason ?? "Blocked by triage" });
		}
	}
};

/**
 * Handle "unblock" recommendation
 */
const handleUnblock: RecommendationHandler = (rec) => {
	if (rec.taskId) {
		const task = getTaskById(rec.taskId);
		if (task?.status === "blocked") {
			unblockTask(rec.taskId);
		}
	}
};

/**
 * Handle complex recommendations that require manual review
 */
const handleManualReview: RecommendationHandler = (rec) => {
	output.info(`Recommendation requires manual review: ${rec.action}`, {
		taskId: rec.taskId,
		relatedTaskIds: rec.relatedTaskIds,
		reason: rec.reason,
	});
};

/**
 * Map of action types to their handlers
 */
const handlerMap: Record<string, RecommendationHandler> = {
	remove: handleRemove,
	add: handleAdd,
	complete: handleComplete,
	fix_status: handleComplete,
	prioritize: handlePrioritize,
	update: handleUpdate,
	block: handleBlock,
	unblock: handleUnblock,
	merge: handleManualReview,
	decompose: handleManualReview,
};

/**
 * Apply a recommendation using the appropriate handler
 */
export function applyRecommendation(rec: MetaTaskRecommendation, ctx: RecommendationContext): void {
	const handler = handlerMap[rec.action];
	if (handler) {
		handler(rec, ctx);
	} else {
		output.warning(`Unknown recommendation action: ${rec.action}`);
	}
}

/**
 * Validation result for recommendations
 */
export interface ValidationResult {
	valid: boolean;
	reason?: string;
}

/**
 * Actions that require an existing task to operate on
 */
const ACTIONS_REQUIRING_EXISTING_TASK = [
	"remove",
	"complete",
	"fix_status",
	"prioritize",
	"update",
	"block",
	"unblock",
];

/**
 * Validate a recommendation against the actual task board state.
 *
 * This is a pure function suitable for unit testing - it takes all required
 * state as parameters and returns a validation result without side effects.
 *
 * @param rec - The recommendation to validate
 * @param tasks - Current task board state
 * @param taskIds - Set of valid task IDs for fast lookup
 * @param metaTaskId - ID of the meta-task making recommendations (for self-protection)
 * @returns Validation result with valid flag and optional reason
 */
export function validateRecommendation(
	rec: MetaTaskRecommendation,
	tasks: Task[],
	taskIds: Set<string>,
	metaTaskId: string,
): ValidationResult {
	// Self-protection: don't let meta-task modify itself
	if (rec.taskId === metaTaskId) {
		return { valid: false, reason: "cannot modify self" };
	}

	if (ACTIONS_REQUIRING_EXISTING_TASK.includes(rec.action)) {
		const result = validateExistingTaskAction(rec, tasks, taskIds);
		if (!result.valid) {
			return result;
		}
	}

	// Validate "add" action
	if (rec.action === "add") {
		return validateAddAction(rec, tasks);
	}

	// Validate "merge" action
	if (rec.action === "merge") {
		return validateMergeAction(rec, taskIds);
	}

	return { valid: true };
}

/**
 * Validate actions that require an existing task
 */
function validateExistingTaskAction(
	rec: MetaTaskRecommendation,
	tasks: Task[],
	taskIds: Set<string>,
): ValidationResult {
	if (!rec.taskId) {
		return { valid: false, reason: "missing taskId" };
	}

	if (!taskIds.has(rec.taskId)) {
		return { valid: false, reason: "task does not exist" };
	}

	const task = tasks.find((t) => t.id === rec.taskId);
	if (!task) {
		return { valid: false, reason: "task not found" };
	}

	// State transition validation
	return validateStateTransition(rec.action, task);
}

/**
 * Validate state transitions for task actions
 */
function validateStateTransition(action: string, task: Task): ValidationResult {
	switch (action) {
		case "complete":
		case "fix_status":
			if (task.status === "complete") {
				return { valid: false, reason: "task already complete" };
			}
			break;

		case "unblock":
			if (task.status !== "blocked") {
				return { valid: false, reason: "task is not blocked" };
			}
			break;

		case "block":
			if (task.status === "blocked") {
				return { valid: false, reason: "task already blocked" };
			}
			if (task.status === "complete") {
				return { valid: false, reason: "cannot block completed task" };
			}
			break;
	}

	return { valid: true };
}

/**
 * Validate "add" action
 */
function validateAddAction(rec: MetaTaskRecommendation, tasks: Task[]): ValidationResult {
	if (!rec.newTask?.objective) {
		return { valid: false, reason: "missing objective for new task" };
	}

	// Check for obvious duplicates (exact match)
	const isDuplicate = tasks.some((t) => t.objective.toLowerCase() === rec.newTask!.objective.toLowerCase());
	if (isDuplicate) {
		return { valid: false, reason: "duplicate objective" };
	}

	return { valid: true };
}

/**
 * Validate "merge" action
 */
function validateMergeAction(rec: MetaTaskRecommendation, taskIds: Set<string>): ValidationResult {
	if (!rec.relatedTaskIds || rec.relatedTaskIds.length === 0) {
		return { valid: false, reason: "merge requires relatedTaskIds" };
	}

	for (const relatedId of rec.relatedTaskIds) {
		if (!taskIds.has(relatedId)) {
			return { valid: false, reason: `related task ${relatedId} does not exist` };
		}
	}

	return { valid: true };
}
