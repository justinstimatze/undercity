/**
 * Orchestrator Recovery Helpers
 *
 * Extracted helpers for batch recovery to reduce complexity
 * and eliminate duplicate code.
 */

import * as output from "../output.js";
import { readTaskAssignment } from "../persistence.js";
import type { TaskCheckpoint } from "../types.js";

/**
 * Task data needed for checkpoint recovery
 */
export interface RecoveryTask {
	task: string;
	taskId: string;
	status: string;
	worktreePath?: string;
}

/**
 * Extract checkpoints and cleanup worktrees for running tasks
 *
 * @param tasks - Tasks from recovery state
 * @param checkpointStore - Map to store recovered checkpoints (keyed by task objective)
 * @param removeWorktree - Function to remove a worktree
 * @returns Number of checkpoints recovered
 */
export function extractCheckpointsAndCleanup(
	tasks: RecoveryTask[],
	checkpointStore: Map<string, TaskCheckpoint>,
	removeWorktree: (taskId: string, force: boolean) => void,
): number {
	let checkpointsRecovered = 0;

	for (const task of tasks) {
		if (task.status === "running" && task.worktreePath) {
			// Try to recover checkpoint
			const checkpoint = tryRecoverCheckpoint(task.task, task.worktreePath);
			if (checkpoint) {
				checkpointStore.set(task.task, checkpoint);
				checkpointsRecovered++;
				output.debug(`Recovered checkpoint for: ${task.task.substring(0, 40)}...`);
			}

			// Clean up the stale worktree
			tryCleanupWorktree(task.taskId, removeWorktree);
		}
	}

	return checkpointsRecovered;
}

/**
 * Try to recover checkpoint from worktree assignment file
 * Returns null if checkpoint can't be recovered (best-effort)
 */
function tryRecoverCheckpoint(taskObjective: string, worktreePath: string): TaskCheckpoint | null {
	try {
		const assignment = readTaskAssignment(worktreePath);
		return assignment?.checkpoint ?? null;
	} catch {
		// Ignore read errors - checkpoint recovery is best-effort
		return null;
	}
}

/**
 * Try to clean up a stale worktree
 * Silently ignores cleanup errors
 */
function tryCleanupWorktree(taskId: string, removeWorktree: (taskId: string, force: boolean) => void): void {
	try {
		removeWorktree(taskId, true);
		output.debug(`Cleaned up stale worktree: ${taskId}`);
	} catch {
		// Ignore cleanup errors
	}
}

/**
 * Format resume message with optional checkpoint count
 */
export function formatResumeMessage(taskCount: number, checkpointsRecovered: number): string {
	return `${taskCount} tasks to resume${checkpointsRecovered > 0 ? ` (${checkpointsRecovered} with checkpoints)` : ""}`;
}
