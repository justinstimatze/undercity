/**
 * Quest-related commands
 */
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { ParallelSoloOrchestrator } from "../parallel-solo.js";
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
	addGoal,
	addGoals,
	addTasks,
	getAllItems,
	getBacklogSummary,
	getNextGoal,
	getReadyTasksForBatch,
	getTaskBoardAnalytics,
	markComplete,
	markFailed,
	markInProgress,
} from "../task.js";
import { TaskBoardAnalyzer } from "../task-board-analyzer.js";
import type { CommandModule } from "./types.js";

export const taskCommands: CommandModule = {
	register(program) {
		// Backlog command - show/manage the goal queue
		program
			.command("tasks")
			.description("Show the task board")
			.action(() => {
				const items = getAllItems();
				const summary = getBacklogSummary();

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

				const pending = items.filter((i) => i.status === "pending");
				const inProgress = items.filter((i) => i.status === "in_progress");

				if (inProgress.length > 0) {
					console.log(chalk.bold("In Progress"));
					for (const item of inProgress) {
						console.log(
							`  ${chalk.cyan("🏃")} ${item.objective.substring(0, 60)}${item.objective.length > 60 ? "..." : ""}`,
						);
					}
					console.log();
				}

				if (pending.length > 0) {
					console.log(chalk.bold("Pending"));
					for (const item of pending.slice(0, 10)) {
						console.log(
							`  ${chalk.gray("○")} ${item.objective.substring(0, 60)}${item.objective.length > 60 ? "..." : ""}`,
						);
					}
					if (pending.length > 10) {
						console.log(chalk.gray(`  ... and ${pending.length - 10} more`));
					}
				}
			});

		// Add command - add a goal to the backlog
		program
			.command("add <goal>")
			.description("Add a goal to the backlog")
			.action((goal: string) => {
				const item = addGoal(goal);
				console.log(chalk.green(`Added: ${goal}`));
				console.log(chalk.gray(`  ID: ${item.id}`));
			});

		// Load command - load goals from a file (one per line)
		program
			.command("load <file>")
			.description("Load goals from a file (one per line)")
			.action((file: string) => {
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

					const items = addGoals(goals);
					console.log(chalk.green(`Loaded ${items.length} goals from ${file}`));
				} catch (error) {
					console.error(chalk.red(`Error loading file: ${error instanceof Error ? error.message : error}`));
					process.exit(1);
				}
			});

		// Import-plan command - parse plan files into discrete tasks
		program
			.command("import-plan <file>")
			.description("Import a plan file as discrete tasks (extracts steps from markdown plans)")
			.option("--dry-run", "Show what would be imported without adding to task board")
			.option("--by-priority", "Sort steps by section priority (default: by file order)")
			.action((file: string, options: { dryRun?: boolean; byPriority?: boolean }) => {
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
						chalk.dim(
							`  Tasks: ${progress.total} (${progress.pending} pending, ${progress.completed} marked complete)`,
						),
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
			});

		// Plan command - execute a plan file intelligently
		program
			.command("plan <file>")
			.description("Execute a plan file with good judgment (uses logistics to determine next steps)")
			.option("-s, --stream", "Stream agent activity")
			.option("-c, --continuous", "Keep executing until plan is complete")
			.option("-n, --steps <n>", "Max steps to execute (default: unlimited in continuous mode)")
			.option("--legacy", "Use legacy mode (re-read whole plan each iteration)")
			.action(
				async (file: string, options: { stream?: boolean; continuous?: boolean; steps?: string; legacy?: boolean }) => {
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
							const orchestrator = new ParallelSoloOrchestrator({
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

								console.log(
									chalk.cyan(`\n━━━ Step ${step}/${progress.total}: ${currentTask.content.substring(0, 50)}... ━━━`),
								);
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
								chalk.cyan(
									`\nFinal progress: ${progress.completed}/${progress.total} steps (${progress.percentComplete}%)`,
								),
							);
						}
					} catch (error) {
						console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
						process.exit(1);
					}
				},
			);

		// Work command - process the backlog continuously
		program
			.command("work")
			.description("Process the backlog continuously (run in separate terminal)")
			.option("-n, --count <n>", "Process only N goals then stop", "0")
			.option("-s, --stream", "Stream agent activity")
			.action(async (options: { count?: string; stream?: boolean }) => {
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
					const nextGoal = getNextGoal();

					if (!nextGoal) {
						console.log(chalk.green("\n✓ Backlog empty - all tasks processed"));
						break;
					}

					if (maxCount > 0 && processed >= maxCount) {
						console.log(chalk.yellow(`\n✓ Processed ${maxCount} task(s) - stopping`));
						break;
					}

					console.log(chalk.cyan(`\n━━━ Task ${processed + 1}: ${nextGoal.objective.substring(0, 50)}... ━━━`));

					const orchestrator = new ParallelSoloOrchestrator({
						startingModel: "sonnet",
						maxConcurrent: 1,
						autoCommit: true,
						stream: options.stream ?? false,
						verbose: true,
					});

					markInProgress(nextGoal.id, `grind-${Date.now()}`);

					try {
						const result = await orchestrator.runParallel([nextGoal.objective]);
						const taskResult = result.results[0]?.result;

						if (taskResult?.status === "complete") {
							markComplete(nextGoal.id);
							console.log(chalk.green(`✓ Task complete: ${nextGoal.objective.substring(0, 40)}...`));
						} else {
							const errorMsg = taskResult?.error || "Unknown error";
							markFailed(nextGoal.id, errorMsg);
							console.log(chalk.red(`✗ Task failed: ${nextGoal.objective.substring(0, 40)}...`));
							if (taskResult?.error) {
								console.log(chalk.dim(`  Error: ${taskResult.error.substring(0, 100)}`));
							}
						}

						processed++;
					} catch (error) {
						markFailed(nextGoal.id, error instanceof Error ? error.message : String(error));
						console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
					}
				}

				const summary = getBacklogSummary();
				console.log(
					`\nFinal: ${chalk.green(summary.complete)} complete, ${chalk.red(summary.failed)} failed, ${chalk.yellow(summary.pending)} pending`,
				);
			});

		// Task analyze command - analyze task board for parallelization opportunities
		program
			.command("task-analyze")
			.description("Analyze task board for parallelization opportunities")
			.option("--compatibility", "Show compatibility matrix")
			.option("--suggestions", "Show optimization suggestions")
			.action(async (options: { compatibility?: boolean; suggestions?: boolean }) => {
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
			});

		// Task status command - show detailed task board status
		program
			.command("task-status")
			.description("Show detailed task board status and analytics")
			.action(() => {
				console.log(chalk.bold("Task Board Status"));
				console.log();

				// Basic task board summary
				const summary = getBacklogSummary();
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
			});

		// Reconcile command - detect duplicate tasks from git history
		program
			.command("reconcile")
			.description("Detect and mark tasks that are already completed in git history")
			.option("--dry-run", "Show what would be marked without making changes")
			.option("--lookback <number>", "Number of commits to search (default: 100)", "100")
			.action(async (options) => {
				const { reconcileTasks } = await import("../task.js");

				console.log(chalk.bold("Reconciling tasks with git history..."));
				console.log();

				try {
					const result = await reconcileTasks({
						lookbackCommits: Number.parseInt(options.lookback),
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
			});
	},
};
