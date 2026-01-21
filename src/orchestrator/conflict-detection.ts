/**
 * Orchestrator Conflict Detection
 *
 * Pure functions for detecting file conflicts between parallel tasks.
 * These are side-effect-free and easily unit testable.
 */

/**
 * Task result with modified files for conflict detection
 */
export interface TaskWithModifiedFiles {
	taskId: string;
	modifiedFiles?: string[];
}

/**
 * Detect actual file conflicts from completed task results.
 *
 * Pure function: takes task results, returns a map of files to task IDs
 * that modified them. Files with only one modifier are not conflicts.
 *
 * @param tasks - Array of task results with their modified files
 * @returns Map of file paths to array of task IDs that modified them (only files with 2+ modifiers)
 */
export function detectFileConflicts(tasks: TaskWithModifiedFiles[]): Map<string, string[]> {
	const fileToTasks = new Map<string, string[]>();

	for (const task of tasks) {
		if (!task.modifiedFiles) continue;

		for (const file of task.modifiedFiles) {
			const existing = fileToTasks.get(file) || [];
			existing.push(task.taskId);
			fileToTasks.set(file, existing);
		}
	}

	// Filter to only files with multiple tasks (actual conflicts)
	const conflicts = new Map<string, string[]>();
	for (const [file, taskIds] of fileToTasks) {
		if (taskIds.length > 1) {
			conflicts.set(file, taskIds);
		}
	}

	return conflicts;
}

/**
 * Paths that are prone to merge conflicts when modified in parallel.
 * Documentation and rules files often have semantic conflicts even
 * without textual overlap.
 */
export const CONFLICT_PRONE_PATHS = [".claude/rules/", ".claude/", "docs/", "ARCHITECTURE.md", "README.md"];

/**
 * Predicted conflict with severity level
 */
export interface PredictedConflict {
	file: string;
	tasks: string[];
	severity: "warning" | "error";
}

/**
 * Check if a file path is in a conflict-prone location
 */
export function isConflictPronePath(file: string): boolean {
	return CONFLICT_PRONE_PATHS.some((path) => file.includes(path));
}

/**
 * Build a map of files to tasks that are predicted to modify them.
 *
 * Pure function: takes task predictions, returns file-to-tasks map.
 *
 * @param taskPredictions - Map of task IDs to predicted files they'll modify
 * @param taskObjectives - Map of task IDs to their objective strings (for display)
 * @returns Array of predicted conflicts with severity
 */
export function buildPredictedConflicts(
	taskPredictions: Map<string, string[]>,
	taskObjectives: Map<string, string>,
): PredictedConflict[] {
	const fileToTasks = new Map<string, string[]>();

	// Build file -> tasks map
	for (const [taskId, files] of taskPredictions) {
		for (const file of files) {
			const existing = fileToTasks.get(file) || [];
			existing.push(taskId);
			fileToTasks.set(file, existing);
		}
	}

	// Find files with multiple tasks (potential conflicts)
	const predictedConflicts: PredictedConflict[] = [];
	for (const [file, taskIds] of fileToTasks) {
		if (taskIds.length > 1) {
			const severity = isConflictPronePath(file) ? "error" : "warning";
			// Use task objectives for display (truncated)
			const taskDisplayNames = taskIds.map((id) => {
				const objective = taskObjectives.get(id) || id;
				return objective.substring(0, 50);
			});
			predictedConflicts.push({
				file,
				tasks: taskDisplayNames,
				severity,
			});
		}
	}

	return predictedConflicts;
}
