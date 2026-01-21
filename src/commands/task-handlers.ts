/**
 * Command handlers for task-related commands
 * Extracted from task.ts for maintainability
 */
import { readFileSync } from "node:fs";
import * as readline from "node:readline";
import chalk from "chalk";
import {
	type IntentPredictionResult,
	isAmbiguous,
	predictFullIntent,
	shouldSkipIntentCompletion,
} from "../intent-completion.js";
import { Orchestrator } from "../orchestrator.js";
import {
	generateTaskContext,
	getPlanProgress,
	getTasksByPriority,
	markTaskCompleted,
	type ParsedPlan,
	parsePlanFile,
	planToTasks,
} from "../plan-parser.js";
import {
	addTask,
	addTasks,
	getAllTasks,
	getNextTask,
	getReadyTasksForBatch,
	getTaskBoardAnalytics,
	getTaskBoardSummary,
	getTaskById,
	type HandoffContext,
	markTaskComplete,
	markTaskFailed,
	markTaskInProgress,
	removeTasks,
	updateTaskFields,
} from "../task.js";
import { TaskBoardAnalyzer } from "../task-board-analyzer.js";

// Type definitions for command options
export interface AddOptions {
	priority?: string;
	/** Path to JSON file containing handoff context */
	context?: string;
	/** Files the caller already read (comma-separated) */
	filesRead?: string;
	/** Notes to pass to the worker */
	notes?: string;
	/** Comma-separated task IDs this task depends on */
	dependsOn?: string;
	/** Skip intent completion even for ambiguous objectives */
	skipIntentCompletion?: boolean;
}

export interface ImportPlanOptions {
	dryRun?: boolean;
	byPriority?: boolean;
}

export interface PlanOptions {
	stream?: boolean;
	continuous?: boolean;
	steps?: string;
	legacy?: boolean;
}

export interface WorkOptions {
	count?: string;
	stream?: boolean;
}

export interface TaskAnalyzeOptions {
	compatibility?: boolean;
	suggestions?: boolean;
}

export interface ReconcileOptions {
	dryRun?: boolean;
	lookback?: string;
}

export interface TasksOptions {
	status?: "pending" | "in_progress" | "complete" | "failed";
	tag?: string;
	all?: boolean;
	count?: string;
}

/**
 * Handle the tasks command - show task board
 */
export function handleTasks(options: TasksOptions = {}): void {
	const items = getAllTasks();
	const summary = getTaskBoardSummary();

	console.log(chalk.bold("Task Board"));
	console.log(
		`  ${chalk.yellow(summary.pending)} pending, ${chalk.cyan(summary.inProgress)} in progress, ${chalk.green(summary.complete)} complete, ${chalk.red(summary.failed)} failed`,
	);
	console.log();

	if (items.length === 0) {
		console.log(chalk.gray("No tasks on the board"));
		console.log("Add tasks with: undercity add <task>");
		return;
	}

	// Filter by status if specified
	let filtered = items;
	if (options.status) {
		filtered = filtered.filter((i) => i.status === options.status);
	}

	// Filter by tag if specified
	if (options.tag) {
		filtered = filtered.filter((i) => i.tags?.includes(options.tag as string));
	}

	// Determine display limit
	const limit = options.all ? filtered.length : options.count ? Number.parseInt(options.count, 10) : 10;

	// If status filter specified, show all matching items up to limit
	if (options.status || options.tag) {
		const statusEmoji: Record<string, string> = {
			pending: chalk.gray("○"),
			in_progress: chalk.cyan("🏃"),
			complete: chalk.green("✓"),
			failed: chalk.red("✗"),
			blocked: chalk.yellow("⏸"),
			duplicate: chalk.magenta("≡"),
			canceled: chalk.gray("⨯"),
			obsolete: chalk.gray("~"),
		};

		const statusLabel = options.status || (options.tag ? `[${options.tag}]` : "Filtered");
		console.log(chalk.bold(`${statusLabel} (${filtered.length} total)`));

		for (const item of filtered.slice(0, limit)) {
			const emoji = statusEmoji[item.status] || chalk.gray("○");
			const tags = item.tags?.length ? chalk.gray(` [${item.tags.join(", ")}]`) : "";
			console.log(`  ${emoji} ${item.objective.substring(0, 55)}${item.objective.length > 55 ? "..." : ""}${tags}`);
		}

		if (filtered.length > limit) {
			console.log(chalk.gray(`  ... and ${filtered.length - limit} more (use --all to show all)`));
		}
		return;
	}

	// Default view: show in_progress and pending
	const pending = filtered.filter((i) => i.status === "pending");
	const inProgress = filtered.filter((i) => i.status === "in_progress");

	if (inProgress.length > 0) {
		console.log(chalk.bold("In Progress"));
		for (const item of inProgress) {
			console.log(`  ${chalk.cyan("🏃")} ${item.objective.substring(0, 60)}${item.objective.length > 60 ? "..." : ""}`);
		}
		console.log();
	}

	if (pending.length > 0) {
		console.log(chalk.bold("Pending"));
		for (const item of pending.slice(0, limit)) {
			console.log(`  ${chalk.gray("○")} ${item.objective.substring(0, 60)}${item.objective.length > 60 ? "..." : ""}`);
		}
		if (pending.length > limit) {
			console.log(chalk.gray(`  ... and ${pending.length - limit} more (use --all or --count N)`));
		}
	}
}

/**
 * Prompt user for confirmation of intent prediction
 * Returns the chosen objective (predicted, custom, or original)
 */
async function promptIntentConfirmation(prediction: IntentPredictionResult): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		// Display the prediction
		console.log();
		console.log(chalk.cyan("Intent Completion Suggestion"));
		console.log(chalk.gray("".padEnd(50, "-")));
		console.log();
		console.log(`Original: ${chalk.yellow(`"${prediction.originalObjective}"`)}`);
		console.log(`Predicted: ${chalk.green(`"${prediction.predictedObjective}"`)}`);
		console.log();
		console.log(`Confidence: ${chalk.cyan(prediction.confidence)}`);
		console.log(`Reasoning: ${chalk.gray(prediction.reasoning)}`);
		console.log();

		if (prediction.similarTasks.length > 0) {
			console.log(chalk.bold("Similar historical tasks:"));
			for (const task of prediction.similarTasks.slice(0, 3)) {
				const status = task.success ? chalk.green("[OK]") : chalk.red("[FAIL]");
				console.log(`  ${status} ${task.objective.slice(0, 60)}${task.objective.length > 60 ? "..." : ""}`);
			}
			console.log();
		}

		console.log(chalk.bold("Options:"));
		console.log("  [1] Use predicted objective (recommended)");
		console.log("  [2] Use original objective");
		console.log("  [3] Enter custom objective");
		console.log();

		rl.question(chalk.cyan("Choose [1/2/3]: "), (answer) => {
			const choice = answer.trim();

			if (choice === "1" || choice === "") {
				rl.close();
				resolve(prediction.predictedObjective);
			} else if (choice === "2") {
				rl.close();
				resolve(prediction.originalObjective);
			} else if (choice === "3") {
				rl.question(chalk.cyan("Enter custom objective: "), (custom) => {
					rl.close();
					resolve(custom.trim() || prediction.originalObjective);
				});
			} else {
				// Invalid choice, default to predicted
				rl.close();
				resolve(prediction.predictedObjective);
			}
		});
	});
}

/**
 * Handle the add command - add a task
 */
export async function handleAdd(goal: string, options: AddOptions = {}): Promise<void> {
	let priority: number | undefined;

	if (options.priority) {
		const parsedPriority = Number.parseInt(options.priority, 10);
		if (Number.isNaN(parsedPriority)) {
			console.error(chalk.red(`Error: Priority must be a number (1-1000), got: ${options.priority}`));
			process.exit(1);
		}
		if (parsedPriority < 1 || parsedPriority > 1000) {
			console.error(chalk.red(`Error: Priority must be between 1 and 1000, got: ${parsedPriority}`));
			process.exit(1);
		}
		priority = parsedPriority;
	}

	// Build handoff context from options
	let handoffContext: HandoffContext | undefined;

	// Read context from JSON file if provided
	if (options.context) {
		try {
			const content = readFileSync(options.context, "utf-8");
			handoffContext = JSON.parse(content) as HandoffContext;
		} catch (error) {
			console.error(chalk.red(`Error reading context file: ${error instanceof Error ? error.message : error}`));
			process.exit(1);
		}
	}

	// Build context from individual options (merge with file context if both provided)
	if (options.filesRead || options.notes) {
		handoffContext = handoffContext ?? {};
		if (options.filesRead) {
			handoffContext.filesRead = options.filesRead.split(",").map((f) => f.trim());
		}
		if (options.notes) {
			handoffContext.notes = options.notes;
		}
	}

	// Intent completion: predict full intent for ambiguous objectives
	let finalObjective = goal;
	const shouldSkip = options.skipIntentCompletion || shouldSkipIntentCompletion(goal);

	if (!shouldSkip && isAmbiguous(goal)) {
		const prediction = predictFullIntent(goal);

		// Only prompt if prediction differs from original
		if (prediction.predictedObjective !== goal) {
			// Check if running in TTY (interactive mode)
			if (process.stdin.isTTY) {
				finalObjective = await promptIntentConfirmation(prediction);
			} else {
				// Non-interactive mode: show warning and use original
				console.log(chalk.yellow("Intent completion suggestion (non-interactive mode):"));
				console.log(`  Original: "${goal}"`);
				console.log(`  Suggested: "${prediction.predictedObjective}"`);
				console.log(chalk.gray("  Use --skip-intent-completion to suppress this warning"));
				console.log();
			}
		}
	}

	const item = addTask(finalObjective, { priority, handoffContext });
	console.log(chalk.green(`Added: ${finalObjective}`));
	console.log(chalk.gray(`  ID: ${item.id}`));
	if (priority !== undefined) {
		console.log(chalk.gray(`  Priority: ${priority}`));
	}
	if (handoffContext) {
		console.log(chalk.gray(`  Handoff context: ${Object.keys(handoffContext).join(", ")}`));
	}
	if (finalObjective !== goal) {
		console.log(chalk.cyan(`  Intent completed from: "${goal}"`));
	}
}

/**
 * Handle the load command - load tasks from file
 */
export function handleLoad(file: string): void {
	try {
		const content = readFileSync(file, "utf-8");
		const goals = content
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"));

		if (goals.length === 0) {
			console.log(chalk.yellow("No goals found in file"));
			return;
		}

		const items = addTasks(goals);
		console.log(chalk.green(`Loaded ${items.length} goals from ${file}`));
	} catch (error) {
		console.error(chalk.red(`Error loading file: ${error instanceof Error ? error.message : error}`));
		process.exit(1);
	}
}

/**
 * Handle the import-plan command - parse plan files into tasks
 */
export function handleImportPlan(file: string, options: ImportPlanOptions): void {
	try {
		const content = readFileSync(file, "utf-8");
		const plan = parsePlanFile(content, file);
		const progress = getPlanProgress(plan);

		console.log(chalk.cyan("Parsing plan file..."));
		console.log(chalk.dim(`  File: ${file}`));
		if (plan.title) {
			console.log(chalk.dim(`  Title: ${plan.title}`));
		}
		console.log(chalk.dim(`  Sections: ${plan.sections.length}`));
		console.log(
			chalk.dim(`  Tasks: ${progress.total} (${progress.pending} pending, ${progress.completed} marked complete)`),
		);
		console.log();

		// Show section breakdown
		if (progress.bySections.length > 0) {
			console.log(chalk.cyan("Section breakdown:"));
			for (const section of progress.bySections) {
				const status = section.completed === section.total ? chalk.green("✓") : chalk.yellow("○");
				console.log(`  ${status} ${section.section}: ${section.completed}/${section.total}`);
			}
			console.log();
		}

		// Get steps to import
		const tasks = planToTasks(plan);

		if (tasks.length === 0) {
			console.log(chalk.yellow("No pending steps found in plan"));
			return;
		}

		// Sort by priority if requested
		if (options.byPriority) {
			// tasks are already sorted by priority from planToTasks
			console.log(chalk.dim("Tasks sorted by section priority"));
		}

		if (options.dryRun) {
			console.log(chalk.cyan(`Would import ${tasks.length} steps:`));
			for (let i = 0; i < Math.min(tasks.length, 20); i++) {
				const task = tasks[i];
				const sectionTag = task.section ? chalk.dim(` [${task.section}]`) : "";
				console.log(
					`  ${i + 1}. ${task.objective.substring(0, 70)}${task.objective.length > 70 ? "..." : ""}${sectionTag}`,
				);
			}
			if (tasks.length > 20) {
				console.log(chalk.dim(`  ... and ${tasks.length - 20} more`));
			}
		} else {
			// Import as tasks
			const objectives = tasks.map((q) => q.objective);
			const imported = addTasks(objectives);
			console.log(chalk.green(`✓ Imported ${imported.length} steps as tasks`));
			if (imported.length < tasks.length) {
				console.log(chalk.yellow(`  (${tasks.length - imported.length} duplicates skipped)`));
			}
			console.log(chalk.dim(`\nRun "undercity work" to start processing tasks`));
		}
	} catch (error) {
		console.error(chalk.red(`Error parsing plan: ${error instanceof Error ? error.message : error}`));
		process.exit(1);
	}
}

/**
 * Handle the plan command - execute a plan file intelligently
 */
export async function handlePlan(file: string, options: PlanOptions): Promise<void> {
	try {
		const planContent = readFileSync(file, "utf-8");
		const maxSteps = options.steps ? Number.parseInt(options.steps, 10) : options.continuous ? 100 : 1;

		// Parse plan upfront into discrete steps (unless legacy mode)
		let parsedPlan: ParsedPlan | null = null;
		if (!options.legacy) {
			parsedPlan = parsePlanFile(planContent, file);
			const progress = getPlanProgress(parsedPlan);

			console.log(chalk.cyan("Parsing plan file..."));
			console.log(chalk.dim(`  File: ${file}`));
			if (parsedPlan.title) {
				console.log(chalk.dim(`  Title: ${parsedPlan.title}`));
			}
			console.log(chalk.dim(`  Sections: ${parsedPlan.sections.length}`));
			console.log(chalk.dim(`  Tasks: ${progress.total} (${progress.pending} pending)`));
			if (options.continuous) {
				console.log(chalk.dim(`  Mode: Continuous (up to ${maxSteps} steps)`));
			}
			console.log();

			// Get steps sorted by priority
			const tasksByPriority = getTasksByPriority(parsedPlan).filter((t) => !t.completed);

			if (tasksByPriority.length === 0) {
				console.log(chalk.green("✓ All steps already marked complete in plan!"));
				return;
			}

			// Show upcoming steps
			console.log(chalk.cyan("Queued steps (by priority):"));
			for (let i = 0; i < Math.min(tasksByPriority.length, 5); i++) {
				const step = tasksByPriority[i];
				const sectionTag = step.section ? chalk.dim(` [${step.section}]`) : "";
				console.log(
					`  ${i + 1}. ${step.content.substring(0, 60)}${step.content.length > 60 ? "..." : ""}${sectionTag}`,
				);
			}
			if (tasksByPriority.length > 5) {
				console.log(chalk.dim(`  ... and ${tasksByPriority.length - 5} more`));
			}
			console.log();
		} else {
			console.log(chalk.cyan("Loading plan file (legacy mode)..."));
			console.log(chalk.dim(`  File: ${file}`));
			if (options.continuous) {
				console.log(chalk.dim(`  Mode: Continuous (up to ${maxSteps} steps)`));
			}
			console.log();
		}

		let step = 0;

		while (step < maxSteps) {
			step++;

			// Create fresh orchestrator for each step
			const orchestrator = new Orchestrator({
				startingModel: "sonnet",
				maxConcurrent: 1,
				autoCommit: true,
				stream: options.stream ?? false,
				verbose: true,
			});

			let goal: string;

			if (parsedPlan && !options.legacy) {
				// New mode: use parsed steps with focused context
				const tasksByPriority = getTasksByPriority(parsedPlan).filter((t) => !t.completed);
				const currentTask = tasksByPriority[0];

				if (!currentTask) {
					console.log(chalk.green("\n✓ All plan steps complete!"));
					break;
				}

				// Generate focused context for the current step
				const taskContext = generateTaskContext(parsedPlan, currentTask.id);
				const progress = getPlanProgress(parsedPlan);

				goal = `Implement this specific step:

${currentTask.content}

${taskContext}

After completing this step, summarize what you did. If this step is impossible or already done, explain why and say "TASK SKIPPED".`;

				console.log(chalk.cyan(`\n━━━ Step ${step}/${progress.total}: ${currentTask.content.substring(0, 50)}... ━━━`));
				if (currentTask.section) {
					console.log(chalk.dim(`    Section: ${currentTask.section}`));
				}
			} else {
				// Legacy mode: pass whole plan each iteration
				const stepContext = step > 1 ? `\n\nThis is step ${step}. Continue with the next logical step.` : "";

				goal = `Execute this implementation plan with good judgment. Read the plan, determine the next logical step that hasn't been done yet, and implement it. If something is already complete, skip it. If the plan is fully complete, respond with "PLAN COMPLETE".

PLAN FILE CONTENTS:
${planContent.substring(0, 12000)}${planContent.length > 12000 ? "\n\n[Plan truncated]" : ""}${stepContext}`;

				console.log(chalk.cyan(`\n━━━ Step ${step} ━━━`));
			}

			const result = await orchestrator.runParallel([goal]);
			const taskResult = result.results[0]?.result;
			const taskSucceeded = taskResult?.status === "complete";

			// Mark current step as completed in parsed plan (for new mode)
			if (parsedPlan && !options.legacy) {
				const tasksByPriority = getTasksByPriority(parsedPlan).filter((t) => !t.completed);
				const currentTask = tasksByPriority[0];

				if (currentTask && taskSucceeded) {
					parsedPlan = markTaskCompleted(parsedPlan, currentTask.id);
					const progress = getPlanProgress(parsedPlan);
					console.log(chalk.green(`  ✓ Step complete (${progress.completed}/${progress.total})`));
				} else if (currentTask && !taskSucceeded) {
					// Task failed - mark as skipped and continue
					parsedPlan = markTaskCompleted(parsedPlan, currentTask.id);
					console.log(chalk.yellow(`  ⊘ Step failed: ${taskResult?.error || "Unknown error"}`));
				}
			}

			if (!options.continuous) {
				console.log(chalk.dim("\nRun with -c to continue automatically"));
				break;
			}
		}

		// Show final progress for new mode
		if (parsedPlan && !options.legacy) {
			const progress = getPlanProgress(parsedPlan);
			console.log(
				chalk.cyan(`\nFinal progress: ${progress.completed}/${progress.total} steps (${progress.percentComplete}%)`),
			);
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
		process.exit(1);
	}
}

/**
 * Handle the work command - process backlog continuously
 */
export async function handleWork(options: WorkOptions): Promise<void> {
	const maxCount = Number.parseInt(options.count || "0", 10);
	let processed = 0;

	console.log(chalk.cyan("Starting backlog worker..."));
	if (maxCount > 0) {
		console.log(chalk.dim(`  Will process ${maxCount} task(s) then stop`));
	} else {
		console.log(chalk.dim("  Will process all pending goals"));
	}
	console.log();

	while (true) {
		const nextGoal = getNextTask();

		if (!nextGoal) {
			console.log(chalk.green("\n✓ Backlog empty - all tasks processed"));
			break;
		}

		if (maxCount > 0 && processed >= maxCount) {
			console.log(chalk.yellow(`\n✓ Processed ${maxCount} task(s) - stopping`));
			break;
		}

		console.log(chalk.cyan(`\n━━━ Task ${processed + 1}: ${nextGoal.objective.substring(0, 50)}... ━━━`));

		const orchestrator = new Orchestrator({
			startingModel: "sonnet",
			maxConcurrent: 1,
			autoCommit: true,
			stream: options.stream ?? false,
			verbose: true,
		});

		markTaskInProgress(nextGoal.id, `grind-${Date.now()}`);

		try {
			const result = await orchestrator.runParallel([nextGoal.objective]);
			const taskResult = result.results[0]?.result;

			if (taskResult?.status === "complete") {
				markTaskComplete(nextGoal.id);
				console.log(chalk.green(`✓ Task complete: ${nextGoal.objective.substring(0, 40)}...`));
			} else {
				const errorMsg = taskResult?.error || "Unknown error";
				markTaskFailed(nextGoal.id, errorMsg);
				console.log(chalk.red(`✗ Task failed: ${nextGoal.objective.substring(0, 40)}...`));
				if (taskResult?.error) {
					console.log(chalk.dim(`  Error: ${taskResult.error.substring(0, 100)}`));
				}
			}

			processed++;
		} catch (error) {
			markTaskFailed(nextGoal.id, error instanceof Error ? error.message : String(error));
			console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
		}
	}

	const summary = getTaskBoardSummary();
	console.log(
		`\nFinal: ${chalk.green(summary.complete)} complete, ${chalk.red(summary.failed)} failed, ${chalk.yellow(summary.pending)} pending`,
	);
}

/**
 * Handle the task-analyze command - analyze task board
 */
export async function handleTaskAnalyze(options: TaskAnalyzeOptions): Promise<void> {
	const analyzer = new TaskBoardAnalyzer();

	console.log(chalk.bold("Task Board Analysis"));
	console.log();

	try {
		const insights = await analyzer.analyzeTaskBoard();

		// Basic insights
		console.log(chalk.cyan("Overview:"));
		console.log(`  Total tasks: ${insights.totalTasks}`);
		console.log(`  Pending tasks: ${insights.pendingTasks}`);
		console.log(`  Ready for parallelization: ${insights.readyForParallelization}`);
		console.log(`  Average complexity: ${insights.averageComplexity}`);
		console.log();

		// Parallelization opportunities
		if (insights.parallelizationOpportunities.length > 0) {
			console.log(chalk.bold("Parallelization Opportunities:"));
			for (const opp of insights.parallelizationOpportunities.slice(0, 3)) {
				const benefitColor =
					opp.benefit === "high" ? chalk.green : opp.benefit === "medium" ? chalk.yellow : chalk.gray;
				console.log(`  ${benefitColor("●")} ${opp.description}`);
				console.log(`    Benefit: ${benefitColor(opp.benefit)}, Time savings: ${opp.estimatedTimesSaving}%`);
			}
			console.log();
		} else {
			console.log(chalk.gray("No parallelization opportunities found"));
			console.log();
		}

		// Top conflicting packages
		if (insights.topConflictingPackages.length > 0) {
			console.log(chalk.bold("Frequently Modified Packages:"));
			for (const pkg of insights.topConflictingPackages.slice(0, 5)) {
				console.log(`  • ${pkg}`);
			}
			console.log();
		}

		// Recommendations
		if (insights.recommendations.length > 0) {
			console.log(chalk.bold("Recommendations:"));
			for (const rec of insights.recommendations) {
				console.log(`  💡 ${rec}`);
			}
			console.log();
		}

		// Compatibility matrix
		if (options.compatibility) {
			console.log(chalk.bold("Compatibility Matrix:"));
			const matrix = await analyzer.generateCompatibilityMatrix();

			if (matrix.tasks.length > 0) {
				console.log(`  ${matrix.summary.compatiblePairs}/${matrix.summary.totalPairs} pairs are compatible`);
				console.log(`  Average compatibility: ${(matrix.summary.averageCompatibilityScore * 100).toFixed(1)}%`);

				// Show a simplified matrix for first few tasks
				const maxShow = Math.min(5, matrix.tasks.length);
				console.log();
				console.log("  Task compatibility (✓ = compatible, ✗ = conflict):");
				for (let i = 0; i < maxShow; i++) {
					const task = matrix.tasks[i];
					const row = matrix.matrix[i];
					let line = `  ${task.id.substring(0, 8)}: `;
					for (let j = 0; j < maxShow; j++) {
						if (i === j) {
							line += "  -";
						} else {
							const compat = row[j];
							line += compat.compatible ? chalk.green("  ✓") : chalk.red("  ✗");
						}
					}
					console.log(line);
				}

				if (matrix.tasks.length > maxShow) {
					console.log(chalk.dim(`  ... and ${matrix.tasks.length - maxShow} more tasks`));
				}
			} else {
				console.log("  No tasks available for analysis");
			}
			console.log();
		}

		// Optimization suggestions
		if (options.suggestions) {
			console.log(chalk.bold("Optimization Suggestions:"));
			const suggestions = await analyzer.getOptimizationSuggestions();
			for (const suggestion of suggestions) {
				console.log(`  🔧 ${suggestion}`);
			}
			console.log();
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
		process.exit(1);
	}
}

/**
 * Handle the task-status command - show detailed task board status
 */
export function handleTaskStatus(): void {
	console.log(chalk.bold("Task Board Status"));
	console.log();

	// Basic task board summary
	const summary = getTaskBoardSummary();
	const analytics = getTaskBoardAnalytics();

	console.log(chalk.cyan("Current Status:"));
	console.log(`  ${chalk.green("Complete:")} ${summary.complete}`);
	console.log(`  ${chalk.yellow("Pending:")} ${summary.pending}`);
	console.log(`  ${chalk.cyan("In Progress:")} ${summary.inProgress}`);
	console.log(`  ${chalk.red("Failed:")} ${summary.failed}`);
	console.log();

	console.log(chalk.cyan("Analytics:"));
	console.log(`  Total tasks: ${analytics.totalTasks}`);
	console.log(`  Average completion time: ${Math.round(analytics.averageCompletionTime / 60000)} minutes`);
	console.log(`  Parallelization opportunities: ${analytics.parallelizationOpportunities}`);
	console.log();

	if (analytics.topConflictingPackages.length > 0) {
		console.log(chalk.cyan("Top Conflicting Packages:"));
		for (const pkg of analytics.topConflictingPackages.slice(0, 3)) {
			console.log(`  • ${pkg}`);
		}
		console.log();
	}

	// Show next few ready tasks
	const readyTasks = getReadyTasksForBatch(5);
	if (readyTasks.length > 0) {
		console.log(chalk.cyan("Next Ready Tasks:"));
		for (let i = 0; i < Math.min(3, readyTasks.length); i++) {
			const task = readyTasks[i];
			console.log(`  ${i + 1}. ${task.objective.substring(0, 60)}${task.objective.length > 60 ? "..." : ""}`);
		}
		if (readyTasks.length > 3) {
			console.log(chalk.dim(`  ... and ${readyTasks.length - 3} more`));
		}
		console.log();
	}

	console.log(chalk.dim("Run 'undercity task-analyze' for detailed parallelization analysis"));
	console.log(chalk.dim("Run 'undercity grind --parallel 3' to process tasks in parallel"));
}

/**
 * Handle the reconcile command - detect duplicate tasks from git history
 */
export async function handleReconcile(options: ReconcileOptions): Promise<void> {
	const { reconcileTasks } = await import("../task.js");

	console.log(chalk.bold("Reconciling tasks with git history..."));
	console.log();

	try {
		const result = await reconcileTasks({
			lookbackCommits: Number.parseInt(options.lookback || "100", 10),
			dryRun: options.dryRun,
		});

		if (result.duplicatesFound === 0) {
			console.log(chalk.green("✓ No duplicates found. All tasks are up to date."));
		} else {
			console.log(chalk.yellow(`Found ${result.duplicatesFound} duplicate task(s):`));
			console.log();

			for (const marked of result.tasksMarked) {
				console.log(chalk.cyan(`  ${marked.taskId}`));
				console.log(chalk.gray(`    ${marked.commitSha}: ${marked.message}`));
			}

			console.log();

			if (options.dryRun) {
				console.log(chalk.dim("(Dry run - no changes made. Run without --dry-run to apply)"));
			} else {
				console.log(chalk.green(`✓ Marked ${result.duplicatesFound} task(s) as duplicate`));
			}
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
		process.exit(1);
	}
}

export interface TriageOptions {
	json?: boolean;
}

export interface PruneOptions {
	dryRun?: boolean;
	force?: boolean;
}

export interface CompleteOptions {
	resolution?: string;
	reason?: string; // Alias for resolution, useful for marking obsolete/deferred
}

interface TriageIssue {
	type:
		| "test_cruft"
		| "duplicate"
		| "stale"
		| "status_bug"
		| "overly_granular"
		| "vague"
		| "orphaned"
		| "over_decomposed"
		| "research_no_output"
		| "generic_error_handling";
	taskId: string;
	objective: string;
	reason: string;
	action: "remove" | "merge" | "fix" | "review";
	relatedTaskIds?: string[];
}

interface TriageReport {
	totalTasks: number;
	pendingTasks: number;
	issues: TriageIssue[];
	healthScore: number;
	recommendations: string[];
}

/**
 * Analyze task board for issues
 */
function analyzeTaskBoard(): TriageReport {
	// Import synchronously from task module (already imported at top)
	const items = getAllTasks();
	const issues: TriageIssue[] = [];

	// Test task patterns
	const testPatterns = [
		/^test task/i,
		/^testing /i,
		/^final test/i,
		/test with (priority|invalid|valid|minimum|maximum)/i,
	];

	// Vague task patterns
	const vaguePatterns = [/^improve /i, /^fix /i, /^update /i, /^better /i];

	// Research/analysis patterns (no code output)
	const researchPatterns = [
		/^identify\b/i,
		/^analyze\b/i,
		/^review\s+and\b/i,
		/^establish\b/i,
		/^determine\b/i,
		/^clarify\b/i,
		/^decide\b/i,
		/^research\b/i,
		/^examine\b/i,
		/^compile\b/i,
		/^conduct\b/i,
	];

	// Generic error handling patterns
	const genericErrorPatterns = [/^implement\s+error\s+handling/i, /^add\s+try-catch/i, /^error\s+recovery/i];

	// Build parent status map for orphan detection
	const parentStatus = new Map<string, string>();
	for (const task of items) {
		parentStatus.set(task.id, task.status);
	}

	// Count subtasks per parent for over-decomposition detection
	const subtaskCountByParent = new Map<string, number>();
	for (const task of items) {
		if (task.parentId && task.status === "pending") {
			subtaskCountByParent.set(task.parentId, (subtaskCountByParent.get(task.parentId) || 0) + 1);
		}
	}

	for (const task of items) {
		if (task.status !== "pending") continue;

		// Check for test cruft
		for (const pattern of testPatterns) {
			if (pattern.test(task.objective)) {
				issues.push({
					type: "test_cruft",
					taskId: task.id,
					objective: task.objective,
					reason: "Matches test task pattern",
					action: "remove",
				});
				break;
			}
		}

		// Check for orphaned subtasks (parent completed)
		if (task.parentId) {
			const parentTaskStatus = parentStatus.get(task.parentId);
			if (parentTaskStatus === "complete") {
				issues.push({
					type: "orphaned",
					taskId: task.id,
					objective: task.objective,
					reason: "Parent task is complete but subtask remains pending",
					action: "remove",
				});
				continue; // Skip other checks for orphaned tasks
			}
		}

		// Check for research/analysis tasks (no code output)
		const hasFileRef = task.objective.includes(".ts") || task.objective.includes("/src/");
		if (!hasFileRef) {
			for (const pattern of researchPatterns) {
				if (pattern.test(task.objective)) {
					issues.push({
						type: "research_no_output",
						taskId: task.id,
						objective: task.objective,
						reason: "Research/analysis task without file target - unlikely to produce code",
						action: "review",
					});
					break;
				}
			}

			// Check for generic error handling tasks
			for (const pattern of genericErrorPatterns) {
				if (pattern.test(task.objective) && task.objective.length < 100) {
					issues.push({
						type: "generic_error_handling",
						taskId: task.id,
						objective: task.objective,
						reason: "Generic error handling task without specific file target",
						action: "review",
					});
					break;
				}
			}
		}

		// Check for status bugs (pending with completedAt)
		if (task.completedAt) {
			issues.push({
				type: "status_bug",
				taskId: task.id,
				objective: task.objective,
				reason: "Status is pending but has completedAt timestamp",
				action: "fix",
			});
		}

		// Check for vague tasks without tags or context
		for (const pattern of vaguePatterns) {
			if (pattern.test(task.objective) && task.objective.length < 50 && !task.tags?.length) {
				issues.push({
					type: "vague",
					taskId: task.id,
					objective: task.objective,
					reason: "Vague objective without specific context",
					action: "review",
				});
				break;
			}
		}
	}

	// Check for over-decomposed parents (>5 pending subtasks)
	for (const [parentId, count] of subtaskCountByParent) {
		if (count > 5) {
			const parent = items.find((t: { id: string }) => t.id === parentId);
			if (parent) {
				issues.push({
					type: "over_decomposed",
					taskId: parentId,
					objective: parent.objective,
					reason: `Has ${count} pending subtasks - likely over-decomposed`,
					action: "review",
				});
			}
		}
	}

	// Check for duplicates (similar objectives)
	const pendingTasks = items.filter((t: { status: string }) => t.status === "pending");
	for (let i = 0; i < pendingTasks.length; i++) {
		for (let j = i + 1; j < pendingTasks.length; j++) {
			const similarity = calculateSimilarity(pendingTasks[i].objective, pendingTasks[j].objective);
			if (similarity > 0.7) {
				// Only add if not already flagged
				const alreadyFlagged = issues.some(
					(issue) =>
						issue.type === "duplicate" &&
						(issue.taskId === pendingTasks[j].id || issue.relatedTaskIds?.includes(pendingTasks[j].id)),
				);
				if (!alreadyFlagged) {
					issues.push({
						type: "duplicate",
						taskId: pendingTasks[j].id,
						objective: pendingTasks[j].objective,
						reason: `${Math.round(similarity * 100)}% similar to: ${pendingTasks[i].objective.substring(0, 50)}...`,
						action: "merge",
						relatedTaskIds: [pendingTasks[i].id],
					});
				}
			}
		}
	}

	// Check for overly granular decomposed tasks (same prefix, too many tasks)
	const prefixGroups = new Map<string, typeof items>();
	for (const task of pendingTasks) {
		const prefix = task.objective.substring(0, 30);
		if (!prefixGroups.has(prefix)) {
			prefixGroups.set(prefix, []);
		}
		prefixGroups.get(prefix)!.push(task);
	}
	for (const [_prefix, tasks] of prefixGroups) {
		if (tasks.length >= 5) {
			issues.push({
				type: "overly_granular",
				taskId: tasks[0].id,
				objective: `${tasks[0].objective.substring(0, 30)}... (${tasks.length} tasks)`,
				reason: `${tasks.length} tasks share similar prefix - may be over-decomposed`,
				action: "review",
				relatedTaskIds: tasks.slice(1).map((t: { id: string }) => t.id),
			});
		}
	}

	// Calculate health score
	const issueWeight: Record<string, number> = {
		test_cruft: 3,
		orphaned: 3,
		over_decomposed: 3,
		duplicate: 2,
		status_bug: 2,
		research_no_output: 2,
		generic_error_handling: 2,
		overly_granular: 1,
		vague: 1,
		stale: 1,
	};
	const totalWeight = issues.reduce((sum, issue) => sum + (issueWeight[issue.type] || 1), 0);
	const maxWeight = items.length * 3;
	const healthScore = Math.max(0, Math.round(100 - (totalWeight / maxWeight) * 100));

	// Generate recommendations
	const recommendations: string[] = [];
	const testCruft = issues.filter((i) => i.type === "test_cruft").length;
	const duplicates = issues.filter((i) => i.type === "duplicate").length;
	const statusBugs = issues.filter((i) => i.type === "status_bug").length;
	const orphaned = issues.filter((i) => i.type === "orphaned").length;
	const overDecomposed = issues.filter((i) => i.type === "over_decomposed").length;
	const researchTasks = issues.filter((i) => i.type === "research_no_output").length;

	if (orphaned > 0) {
		recommendations.push(`Cancel ${orphaned} orphaned subtask(s) - parent tasks completed without them`);
	}
	if (overDecomposed > 0) {
		recommendations.push(`Review ${overDecomposed} over-decomposed parent(s) - consider collapsing subtasks`);
	}
	if (researchTasks > 0) {
		recommendations.push(`Review ${researchTasks} research task(s) - may not produce mergeable code`);
	}
	if (testCruft > 0) {
		recommendations.push(`Remove ${testCruft} test task(s) with: undercity prune`);
	}
	if (duplicates > 0) {
		recommendations.push(`Review ${duplicates} potential duplicate(s) - consider merging`);
	}
	if (statusBugs > 0) {
		recommendations.push(`Fix ${statusBugs} task(s) with incorrect status`);
	}
	if (pendingTasks.length > 50) {
		recommendations.push(`Consider prioritizing - ${pendingTasks.length} pending tasks is a lot`);
	}

	return {
		totalTasks: items.length,
		pendingTasks: pendingTasks.length,
		issues,
		healthScore,
		recommendations,
	};
}

/**
 * Calculate similarity between two strings (Jaccard on words)
 */
function calculateSimilarity(a: string, b: string): number {
	const wordsA = new Set(a.toLowerCase().split(/\s+/));
	const wordsB = new Set(b.toLowerCase().split(/\s+/));
	const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
	const union = new Set([...wordsA, ...wordsB]);
	return intersection.size / union.size;
}

/**
 * Handle the triage command - analyze task list health
 */
export function handleTriage(options: TriageOptions): void {
	const report = analyzeTaskBoard();

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	console.log(chalk.bold("Task Board Triage"));
	console.log();

	// Health score with color
	const healthColor = report.healthScore >= 80 ? chalk.green : report.healthScore >= 50 ? chalk.yellow : chalk.red;
	console.log(`Health Score: ${healthColor(`${report.healthScore}%`)}`);
	console.log(`Total Tasks: ${report.totalTasks} (${report.pendingTasks} pending)`);
	console.log();

	if (report.issues.length === 0) {
		console.log(chalk.green("No issues found. Task board is healthy!"));
		return;
	}

	console.log(chalk.bold(`Issues Found: ${report.issues.length}`));
	console.log();

	// Group by type
	const byType = new Map<string, TriageIssue[]>();
	for (const issue of report.issues) {
		if (!byType.has(issue.type)) {
			byType.set(issue.type, []);
		}
		byType.get(issue.type)!.push(issue);
	}

	const typeLabels: Record<string, string> = {
		test_cruft: "Test Cruft",
		orphaned: "Orphaned Subtasks",
		over_decomposed: "Over-Decomposed",
		research_no_output: "Research (No Code)",
		generic_error_handling: "Generic Error Handling",
		duplicate: "Duplicates",
		status_bug: "Status Bugs",
		overly_granular: "Overly Granular",
		vague: "Vague Tasks",
		stale: "Stale Tasks",
	};

	for (const [type, issues] of byType) {
		console.log(`${chalk.bold(typeLabels[type] || type)} (${issues.length})`);
		for (const issue of issues.slice(0, 5)) {
			console.log(chalk.gray(`  ${issue.taskId}`));
			console.log(`    ${issue.objective.substring(0, 60)}...`);
			console.log(chalk.dim(`    ${issue.reason}`));
		}
		if (issues.length > 5) {
			console.log(chalk.gray(`  ... and ${issues.length - 5} more`));
		}
		console.log();
	}

	if (report.recommendations.length > 0) {
		console.log(chalk.bold("Recommendations:"));
		for (const rec of report.recommendations) {
			console.log(`  - ${rec}`);
		}
	}
}

/**
 * Handle the prune command - remove stale/test/duplicate tasks
 */
export function handlePrune(options: PruneOptions): void {
	const report = analyzeTaskBoard();

	// Collect tasks to remove (only auto-removable types)
	const toRemove = report.issues
		.filter((issue) => issue.action === "remove" || issue.type === "test_cruft")
		.map((issue) => issue.taskId);

	// Collect tasks to fix
	const toFix = report.issues.filter((issue) => issue.type === "status_bug");

	if (toRemove.length === 0 && toFix.length === 0) {
		console.log(chalk.green("Nothing to prune. Task board is clean!"));
		return;
	}

	console.log(chalk.bold("Prune Preview"));
	console.log();

	if (toRemove.length > 0) {
		console.log(chalk.red(`Will remove ${toRemove.length} task(s):`));
		for (const id of toRemove.slice(0, 10)) {
			const issue = report.issues.find((i) => i.taskId === id);
			console.log(chalk.gray(`  - ${id}: ${issue?.objective.substring(0, 50)}...`));
		}
		if (toRemove.length > 10) {
			console.log(chalk.gray(`  ... and ${toRemove.length - 10} more`));
		}
		console.log();
	}

	if (toFix.length > 0) {
		console.log(chalk.yellow(`Will fix ${toFix.length} task(s) with status bugs`));
		console.log();
	}

	if (options.dryRun) {
		console.log(chalk.dim("(Dry run - no changes made. Run without --dry-run to apply)"));
		return;
	}

	// Apply changes
	if (toRemove.length > 0) {
		const removed = removeTasks(toRemove);
		console.log(chalk.green(`Removed ${removed} task(s)`));
	}

	if (toFix.length > 0) {
		let fixed = 0;
		for (const issue of toFix) {
			const task = getTaskById(issue.taskId);
			if (task && task.status === "pending" && task.completedAt) {
				markTaskComplete(issue.taskId);
				fixed++;
			}
		}
		if (fixed > 0) {
			console.log(chalk.green(`Fixed ${fixed} task status(es)`));
		}
	}
}

/**
 * Handle the complete command - mark a task as complete
 */
export function handleComplete(taskId: string, options: CompleteOptions): void {
	const task = getTaskById(taskId);

	if (!task) {
		console.log(chalk.red(`Task not found: ${taskId}`));
		console.log(chalk.dim("Use 'undercity tasks --all' to see all task IDs"));
		process.exit(1);
	}

	if (task.status === "complete") {
		console.log(chalk.yellow(`Task already complete: ${taskId}`));
		return;
	}

	markTaskComplete(taskId);

	console.log(chalk.green(`Marked complete: ${task.objective.slice(0, 60)}...`));
}

export interface UpdateOptions {
	objective?: string;
	priority?: string;
	tags?: string;
	status?: string;
}

/**
 * Handle the update command - update task fields
 */
export function handleUpdate(taskId: string, options: UpdateOptions): void {
	const existingTask = getTaskById(taskId);

	if (!existingTask) {
		console.log(chalk.red(`Task not found: ${taskId}`));
		console.log(chalk.dim("Use 'undercity tasks --all' to see all task IDs"));
		process.exit(1);
	}

	// Validate and parse options
	let priority: number | undefined;
	if (options.priority) {
		const parsedPriority = Number.parseInt(options.priority, 10);
		if (Number.isNaN(parsedPriority)) {
			console.error(chalk.red(`Error: Priority must be a number, got: ${options.priority}`));
			process.exit(1);
		}
		if (parsedPriority < 1 || parsedPriority > 1000) {
			console.error(chalk.red(`Error: Priority must be between 1 and 1000, got: ${parsedPriority}`));
			process.exit(1);
		}
		priority = parsedPriority;
	}

	let tags: string[] | undefined;
	if (options.tags) {
		tags = options.tags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const validStatuses = [
		"pending",
		"in_progress",
		"complete",
		"failed",
		"blocked",
		"duplicate",
		"canceled",
		"obsolete",
	];
	let status:
		| "pending"
		| "in_progress"
		| "complete"
		| "failed"
		| "blocked"
		| "duplicate"
		| "canceled"
		| "obsolete"
		| undefined;
	if (options.status) {
		if (!validStatuses.includes(options.status)) {
			console.error(chalk.red(`Error: Invalid status '${options.status}'`));
			console.error(chalk.dim(`Valid statuses: ${validStatuses.join(", ")}`));
			process.exit(1);
		}
		status = options.status as typeof status;
	}

	// Check if any updates were provided
	if (!options.objective && priority === undefined && tags === undefined && status === undefined) {
		console.log(chalk.yellow("No updates provided. Use --objective, --priority, --tags, or --status"));
		console.log(chalk.dim("Example: undercity update <task-id> --priority 5 --tags feature,urgent"));
		process.exit(1);
	}

	const updatedTask = updateTaskFields({
		id: taskId,
		objective: options.objective,
		priority,
		tags,
		status,
	});

	if (!updatedTask) {
		console.log(chalk.red(`Failed to update task: ${taskId}`));
		process.exit(1);
	}

	console.log(chalk.green(`Updated task: ${taskId}`));

	// Show what was updated
	const updates: string[] = [];
	if (options.objective) {
		updates.push(`objective: "${options.objective.substring(0, 50)}${options.objective.length > 50 ? "..." : ""}"`);
	}
	if (priority !== undefined) {
		updates.push(`priority: ${priority}`);
	}
	if (tags !== undefined) {
		updates.push(`tags: [${tags.join(", ")}]`);
	}
	if (status !== undefined) {
		updates.push(`status: ${status}`);
	}

	for (const update of updates) {
		console.log(chalk.gray(`  ${update}`));
	}
}

export function handleRemove(taskId: string): void {
	const existingTask = getTaskById(taskId);

	if (!existingTask) {
		console.log(chalk.red(`Task not found: ${taskId}`));
		console.log(chalk.dim("Use 'undercity tasks --all' to see all task IDs"));
		process.exit(1);
	}

	const removed = removeTasks([taskId]);
	if (removed > 0) {
		console.log(chalk.green(`Removed: ${existingTask.objective.substring(0, 60)}...`));
	} else {
		console.log(chalk.red(`Failed to remove task: ${taskId}`));
		process.exit(1);
	}
}
