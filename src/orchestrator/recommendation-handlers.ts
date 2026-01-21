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
