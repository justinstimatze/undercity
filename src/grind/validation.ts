/**
 * Grind Validation Module
 *
 * Task validation: path checking, clarity assessment, PM decomposition.
 */

import * as output from "../output.js";
import type { Task } from "../task.js";

/**
 * Validate task references (paths, symbols, etc.) and auto-fix when possible
 */
export async function validateTaskReferences(tasks: Task[]): Promise<{
	validTasks: Task[];
	invalidTaskIds: string[];
	corrections: Array<{ taskId: string; original: string; corrected: string }>;
}> {
	const { validateTask, extractSymbolsFromObjective, validateSymbolReferences } = await import("../task-validator.js");
	const { updateTaskFields } = await import("../task.js");

	const validTasks: Task[] = [];
	const invalidTaskIds: string[] = [];
	const corrections: Array<{ taskId: string; original: string; corrected: string }> = [];

	for (const task of tasks) {
		let currentObjective = task.objective;
		let hasCorrections = false;

		// Step 1: Path validation (synchronous)
		const validation = validateTask(currentObjective);

		// Apply path auto-fixes
		if (validation.correctedObjective) {
			output.info(`Auto-fixed path in task: ${task.id}`);
			for (const issue of validation.issues.filter((i) => i.type === "path_corrected")) {
				output.debug(`  ${issue.autoFix?.originalPath} → ${issue.autoFix?.correctedPath}`);
			}
			currentObjective = validation.correctedObjective;
			hasCorrections = true;
		}

		// Step 2: Symbol validation (async) - only if path validation passed
		if (validation.valid) {
			const symbols = extractSymbolsFromObjective(currentObjective);
			if (symbols.length > 0) {
				const symbolValidation = await validateSymbolReferences(symbols, process.cwd());

				// Apply symbol auto-fixes (wrong file corrections)
				for (const correction of symbolValidation.corrections) {
					output.info(`Symbol "${correction.symbol}" found in different file:`);
					output.info(`  ${correction.originalFile} → ${correction.correctFile}`);

					// Replace the file path in the objective
					currentObjective = currentObjective.replace(correction.originalFile, correction.correctFile);
					hasCorrections = true;
				}

				// Add symbol issues to validation
				for (const issue of symbolValidation.issues) {
					if (issue.severity === "error" && !issue.autoFix) {
						// Only block if we couldn't auto-fix
						validation.issues.push(issue);
					} else if (issue.severity === "warning") {
						output.warning(`Task ${task.id}: ${issue.message}`);
						if (issue.suggestion) {
							output.debug(`  → ${issue.suggestion}`);
						}
					}
				}
			}
		}

		// Record corrections
		if (hasCorrections) {
			corrections.push({
				taskId: task.id,
				original: task.objective,
				corrected: currentObjective,
			});

			// Update the task in the database
			updateTaskFields({ id: task.id, objective: currentObjective });
			task.objective = currentObjective;
		}

		// Flag invalid tasks that can't be auto-fixed
		const unfixedErrors = validation.issues.filter((i) => i.severity === "error" && !i.autoFix);
		if (unfixedErrors.length > 0) {
			output.warning(`Task ${task.id} has validation errors:`);
			for (const issue of unfixedErrors) {
				output.warning(`  ${issue.message}`);
				if (issue.suggestion) {
					output.debug(`  → ${issue.suggestion}`);
				}
			}
			invalidTaskIds.push(task.id);
		} else {
			validTasks.push(task);
		}
	}

	return { validTasks, invalidTaskIds, corrections };
}

/**
 * Assess task clarity and route vague tasks to PM
 */
export async function assessAndRouteVagueTasks(tasks: Task[]): Promise<{
	clearTasks: Task[];
	vagueTaskIds: string[];
	blockedTaskIds: string[];
	decomposedTaskIds: string[];
}> {
	const { assessTaskClarity } = await import("../task-validator.js");
	const { markTaskBlocked, decomposeTaskIntoSubtasks } = await import("../task.js");

	const clearTasks: Task[] = [];
	const vagueTaskIds: string[] = [];
	const blockedTaskIds: string[] = [];
	const decomposedTaskIds: string[] = [];

	for (const task of tasks) {
		const clarity = assessTaskClarity(task.objective);

		if (clarity.tooVague) {
			// Route fundamentally vague tasks to PM for intelligent decomposition
			output.warning(`Task ${task.id} is vague - routing to PM for decomposition:`);
			for (const issue of clarity.issues) {
				output.warning(`  - ${issue}`);
			}

			try {
				const { pmIdeate } = await import("../automated-pm.js");
				output.progress(`PM analyzing: "${task.objective.substring(0, 50)}..."`);

				const ideation = await pmIdeate(task.objective, process.cwd(), ".undercity");

				if (ideation.proposals.length > 0) {
					// PM successfully decomposed the vague task
					output.success(`PM generated ${ideation.proposals.length} specific subtask(s)`);

					const subtasks = ideation.proposals.map((p, idx) => ({
						objective: p.objective,
						order: idx + 1,
					}));
					decomposeTaskIntoSubtasks(task.id, subtasks);

					output.info("Subtasks created:");
					for (const proposal of ideation.proposals) {
						output.info(`  → ${proposal.objective.substring(0, 70)}...`);
					}

					decomposedTaskIds.push(task.id);
				} else {
					// PM couldn't help - fall back to blocking
					output.warning("PM couldn't generate specific subtasks - blocking task");
					markTaskBlocked(task.id, "PM could not decompose vague task into actionable subtasks");
					blockedTaskIds.push(task.id);
				}
			} catch (pmError) {
				// PM failed - fall back to blocking with suggestions
				output.warning(`PM decomposition failed: ${pmError instanceof Error ? pmError.message : String(pmError)}`);
				output.info("Suggestions to fix manually:");
				for (const suggestion of clarity.suggestions) {
					output.info(`  → ${suggestion}`);
				}
				markTaskBlocked(task.id, clarity.tooVagueReason || "Task too vague for autonomous execution");
				blockedTaskIds.push(task.id);
			}
		} else if (clarity.clarity === "vague") {
			// Task is vague but might still work - warn and continue
			output.warning(`Task ${task.id} may be too vague for autonomous execution:`);
			for (const issue of clarity.issues) {
				output.warning(`  - ${issue}`);
			}
			for (const suggestion of clarity.suggestions) {
				output.debug(`  → ${suggestion}`);
			}
			vagueTaskIds.push(task.id);
			clearTasks.push(task);
		} else if (clarity.clarity === "needs_context") {
			// Just log a note, don't skip
			output.debug(
				`Task ${task.id} could benefit from more context (confidence: ${(clarity.confidence * 100).toFixed(0)}%)`,
			);
			clearTasks.push(task);
		} else {
			clearTasks.push(task);
		}
	}

	return { clearTasks, vagueTaskIds, blockedTaskIds, decomposedTaskIds };
}

/**
 * Full validation pipeline: references + clarity
 */
export async function validateTasks(tasks: Task[]): Promise<{
	validTasks: Task[];
	invalidCount: number;
	blockedCount: number;
	decomposedCount: number;
	vagueCount: number;
}> {
	output.progress("Validating task references...");
	const refValidation = await validateTaskReferences(tasks);

	if (refValidation.invalidTaskIds.length > 0) {
		output.warning(`Skipping ${refValidation.invalidTaskIds.length} task(s) with validation errors`);
	}

	if (refValidation.validTasks.length === 0) {
		return {
			validTasks: [],
			invalidCount: refValidation.invalidTaskIds.length,
			blockedCount: 0,
			decomposedCount: 0,
			vagueCount: 0,
		};
	}

	output.progress("Assessing task clarity...");
	const clarityResult = await assessAndRouteVagueTasks(refValidation.validTasks);

	if (clarityResult.blockedTaskIds.length > 0) {
		output.warning(`Blocked ${clarityResult.blockedTaskIds.length} task(s) - could not decompose`);
	}
	if (clarityResult.decomposedTaskIds.length > 0) {
		output.success(`PM decomposed ${clarityResult.decomposedTaskIds.length} vague task(s) into specific subtasks`);
	}
	if (clarityResult.vagueTaskIds.length > 0) {
		output.warning(
			`${clarityResult.vagueTaskIds.length} task(s) are vague and may require decomposition or escalation`,
		);
	}

	return {
		validTasks: clarityResult.clearTasks,
		invalidCount: refValidation.invalidTaskIds.length,
		blockedCount: clarityResult.blockedTaskIds.length,
		decomposedCount: clarityResult.decomposedTaskIds.length,
		vagueCount: clarityResult.vagueTaskIds.length,
	};
}
