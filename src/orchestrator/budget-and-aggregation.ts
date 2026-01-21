/**
 * Orchestrator Budget and Aggregation Logic
 *
 * Pure functions for opus budget checking and task result aggregation.
 * Extracted from Orchestrator for testability.
 */

import type { ModelTier, TokenUsage } from "../types.js";

/**
 * Simplified TaskResult interface for aggregation purposes.
 * Only the fields we need for counting success/failure status.
 */
export interface TaskResultForAggregation {
	task: string;
	status: "complete" | "failed" | "escalated";
	model: ModelTier;
	attempts: number;
	durationMs: number;
	tokenUsage?: {
		attempts: TokenUsage[];
		total: number;
	};
}

/**
 * Result from a parallel task execution
 */
export interface ParallelTaskResult {
	task: string;
	taskId: string;
	result: TaskResultForAggregation | null;
	branch?: string;
	worktreePath?: string;
	merged?: boolean;
	mergeSkipped?: boolean;
	decomposed?: boolean;
	modifiedFiles?: string[];
}

/**
 * Aggregated task result counts
 */
export interface TaskAggregates {
	/** Successfully completed tasks (excludes decomposed) */
	successful: number;
	/** Failed tasks (excludes decomposed) */
	failed: number;
	/** Successfully merged tasks */
	merged: number;
	/** Tasks that were decomposed instead of executed */
	decomposed: number;
	/** Successful tasks that failed to merge */
	mergeFailed: number;
	/** Total tasks processed */
	total: number;
}

/**
 * Check if opus budget allows another opus task
 *
 * Maintains target ratio of ~10% opus usage for optimal Max plan efficiency.
 * Always allows at least one opus task.
 *
 * @param opusTasksUsed - Number of opus tasks used so far
 * @param totalTasksProcessed - Total tasks processed so far
 * @param opusBudgetPercent - Target opus percentage (default 10%)
 * @returns Whether opus can be used for the next task
 */
export function canUseOpusBudget(
	opusTasksUsed: number,
	totalTasksProcessed: number,
	opusBudgetPercent: number = 10,
): boolean {
	// Always allow at least one opus task
	if (opusTasksUsed === 0) {
		return true;
	}

	// Allow more opus if under budget
	// Formula: allow opus if current opus% < target budget%
	const currentOpusPercent = (opusTasksUsed / Math.max(1, totalTasksProcessed)) * 100;
	return currentOpusPercent < opusBudgetPercent;
}

/**
 * Calculate current opus usage percentage
 *
 * @param opusTasksUsed - Number of opus tasks used
 * @param totalTasksProcessed - Total tasks processed
 * @returns Current opus usage as percentage (0-100)
 */
export function calculateOpusUsagePercent(opusTasksUsed: number, totalTasksProcessed: number): number {
	if (totalTasksProcessed === 0) {
		return 0;
	}
	return (opusTasksUsed / totalTasksProcessed) * 100;
}

/**
 * Aggregate task results into summary counts
 *
 * This eliminates duplicated filtering logic that was spread across
 * displaySummary() and buildBatchResult().
 *
 * @param results - Array of parallel task results
 * @returns Aggregated counts
 */
export function aggregateTaskResults(results: ParallelTaskResult[]): TaskAggregates {
	// Decomposed tasks are tracked separately (they weren't actually executed)
	const decomposed = results.filter((r) => r.decomposed).length;

	// Successful = executed and completed (excludes decomposed)
	const successful = results.filter((r) => r.result?.status === "complete" && !r.decomposed).length;

	// Failed = failed or null result (excludes decomposed - they're not real failures)
	const failed = results.filter((r) => (r.result?.status === "failed" || r.result === null) && !r.decomposed).length;

	// Merged = successfully merged
	const merged = results.filter((r) => r.merged).length;

	// Successful tasks with a branch that weren't merged = merge failed
	const successfulWithBranch = results.filter((r) => r.result?.status === "complete" && r.branch && !r.decomposed);
	const mergeFailed = successfulWithBranch.length - merged;

	return {
		successful,
		failed,
		merged,
		decomposed,
		mergeFailed,
		total: results.length,
	};
}

/**
 * Summary item for display
 */
export interface SummaryItem {
	label: string;
	value: string | number;
	status?: "good" | "bad" | "neutral";
}

/**
 * Build summary display items from aggregates
 *
 * @param aggregates - Task result aggregates
 * @param durationMs - Total duration in milliseconds
 * @returns Array of summary items for display
 */
export function buildSummaryItems(aggregates: TaskAggregates, durationMs: number): SummaryItem[] {
	const items: SummaryItem[] = [
		{ label: "Executed", value: aggregates.successful, status: aggregates.successful > 0 ? "good" : "neutral" },
		{ label: "Failed", value: aggregates.failed, status: aggregates.failed > 0 ? "bad" : "neutral" },
		{ label: "Merged", value: aggregates.merged },
		{ label: "Duration", value: `${Math.round(durationMs / 1000)}s` },
	];

	if (aggregates.decomposed > 0) {
		items.push({ label: "Decomposed", value: aggregates.decomposed, status: "neutral" });
	}

	if (aggregates.mergeFailed > 0) {
		items.push({ label: "Merge failed", value: aggregates.mergeFailed, status: "bad" });
	}

	return items;
}

/**
 * Calculate success rate from aggregates
 *
 * @param aggregates - Task result aggregates
 * @returns Success rate as percentage (0-100)
 */
export function calculateSuccessRate(aggregates: TaskAggregates): number {
	const executed = aggregates.successful + aggregates.failed;
	if (executed === 0) {
		return 100; // No failures if nothing executed
	}
	return (aggregates.successful / executed) * 100;
}

/**
 * Check if batch should be considered successful
 *
 * A batch is successful if:
 * - At least one task was executed
 * - Success rate is above threshold (default 50%)
 *
 * @param aggregates - Task result aggregates
 * @param minSuccessRate - Minimum success rate to consider batch successful (default 50%)
 * @returns Whether batch is considered successful
 */
export function isBatchSuccessful(aggregates: TaskAggregates, minSuccessRate: number = 50): boolean {
	const executed = aggregates.successful + aggregates.failed;

	// No tasks executed (all decomposed?) - consider successful
	if (executed === 0) {
		return true;
	}

	return calculateSuccessRate(aggregates) >= minSuccessRate;
}

/**
 * Batch processing decision
 */
export interface BatchDecision {
	/** Whether to continue processing more batches */
	continueProcessing: boolean;
	/** Reason for the decision */
	reason: string;
}

/**
 * Decide whether to continue batch processing after draining signal
 *
 * @param draining - Whether drain signal has been received
 * @param tasksRemaining - Number of tasks remaining to process
 * @returns Decision on whether to continue
 */
export function shouldContinueBatchProcessing(draining: boolean, tasksRemaining: number): BatchDecision {
	if (draining) {
		return {
			continueProcessing: false,
			reason: `Drain: skipping ${tasksRemaining} remaining tasks`,
		};
	}

	if (tasksRemaining <= 0) {
		return {
			continueProcessing: false,
			reason: "All tasks processed",
		};
	}

	return {
		continueProcessing: true,
		reason: `${tasksRemaining} tasks remaining`,
	};
}

/**
 * Generate task batches for parallel processing
 *
 * @param tasks - Array of task objectives
 * @param maxPerBatch - Maximum tasks per batch
 * @returns Array of task batches
 */
export function generateTaskBatches(tasks: string[], maxPerBatch: number): string[][] {
	const batches: string[][] = [];

	for (let i = 0; i < tasks.length; i += maxPerBatch) {
		const batch = tasks.slice(i, i + maxPerBatch);
		batches.push(batch);
	}

	return batches;
}
