/**
 * Quest-related commands
 */
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { Persistence } from "../persistence.js";
import {
	generateTaskContext,
	getPlanProgress,
	getTasksByPriority,
	markTaskCompleted,
	type ParsedPlan,
	parsePlanFile,
	planToQuests,
} from "../plan-parser.js";
import {
	addGoal,
	addGoals,
	addQuests,
	getAllItems,
	getBacklogSummary,
	getNextGoal,
	getQuestBoardAnalytics,
	getReadyQuestsForBatch,
	markComplete,
	markFailed,
	markInProgress,
} from "../quest.js";
import { QuestBatchOrchestrator } from "../quest-batch-orchestrator.js";
import { QuestBoardAnalyzer } from "../quest-board-analyzer.js";
import { RaidOrchestrator } from "../raid.js";
import type { CommandModule } from "./types.js";
import { showDeprecationWarning } from "./utils.js";

export const questCommands: CommandModule = {
	register(program) {
		// Backlog command - show/manage the goal queue
		program
			.command("quests")
			.description("Show the quest board")
			.action(() => {
				const items = getAllItems();
				const summary = getBacklogSummary();

				console.log(chalk.bold("Quest Board"));
				console.log(
					`  ${chalk.yellow(summary.pending)} pending, ${chalk.cyan(summary.inProgress)} in progress, ${chalk.green(summary.complete)} complete, ${chalk.red(summary.failed)} failed`,
				);
				console.log();

				if (items.length === 0) {
					console.log(chalk.gray("No quests on the board"));
					console.log("Add quests with: undercity add <quest>");
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

		// Import-plan command - parse plan files into discrete quests
		program
			.command("import-plan <file>")
			.description("Import a plan file as discrete quests (extracts waypoints from markdown plans)")
			.option("--dry-run", "Show what would be imported without adding to quest board")
			.option("--by-priority", "Sort waypoints by section priority (default: by file order)")
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

					// Get waypoints to import
					const quests = planToQuests(plan);

					if (quests.length === 0) {
						console.log(chalk.yellow("No pending waypoints found in plan"));
						return;
					}

					// Sort by priority if requested
					if (options.byPriority) {
						// quests are already sorted by priority from planToQuests
						console.log(chalk.dim("Tasks sorted by section priority"));
					}

					if (options.dryRun) {
						console.log(chalk.cyan(`Would import ${quests.length} waypoints:`));
						for (let i = 0; i < Math.min(quests.length, 20); i++) {
							const quest = quests[i];
							const sectionTag = quest.section ? chalk.dim(` [${quest.section}]`) : "";
							console.log(
								`  ${i + 1}. ${quest.objective.substring(0, 70)}${quest.objective.length > 70 ? "..." : ""}${sectionTag}`,
							);
						}
						if (quests.length > 20) {
							console.log(chalk.dim(`  ... and ${quests.length - 20} more`));
						}
					} else {
						// Import as quests
						const objectives = quests.map((q) => q.objective);
						const imported = addQuests(objectives);
						console.log(chalk.green(`✓ Imported ${imported.length} waypoints as quests`));
						if (imported.length < quests.length) {
							console.log(chalk.yellow(`  (${quests.length - imported.length} duplicates skipped)`));
						}
						console.log(chalk.dim(`\nRun "undercity work" to start processing quests`));
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
			.option("-s, --stream", "Stream raider activity")
			.option("-c, --continuous", "Keep executing until plan is complete")
			.option("-n, --steps <n>", "Max steps to execute (default: unlimited in continuous mode)")
			.option("--legacy", "Use legacy mode (re-read whole plan each iteration)")
			.action(
				async (file: string, options: { stream?: boolean; continuous?: boolean; steps?: string; legacy?: boolean }) => {
					try {
						const planContent = readFileSync(file, "utf-8");
						const maxSteps = options.steps ? Number.parseInt(options.steps, 10) : options.continuous ? 100 : 1;

						// Parse plan upfront into discrete waypoints (unless legacy mode)
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

							// Get waypoints sorted by priority
							const tasksByPriority = getTasksByPriority(parsedPlan).filter((t) => !t.completed);

							if (tasksByPriority.length === 0) {
								console.log(chalk.green("✓ All waypoints already marked complete in plan!"));
								return;
							}

							// Show upcoming waypoints
							console.log(chalk.cyan("Queued waypoints (by priority):"));
							for (let i = 0; i < Math.min(tasksByPriority.length, 5); i++) {
								const waypoint = tasksByPriority[i];
								const sectionTag = waypoint.section ? chalk.dim(` [${waypoint.section}]`) : "";
								console.log(
									`  ${i + 1}. ${waypoint.content.substring(0, 60)}${waypoint.content.length > 60 ? "..." : ""}${sectionTag}`,
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
						let lastResult = "";

						while (step < maxSteps) {
							step++;

							// Create fresh orchestrator for each step
							const orchestrator = new RaidOrchestrator({
								autoApprove: true,
								autoCommit: true,
								verbose: true,
								streamOutput: options.stream,
							});

							let goal: string;

							if (parsedPlan && !options.legacy) {
								// New mode: use parsed waypoints with focused context
								const tasksByPriority = getTasksByPriority(parsedPlan).filter((t) => !t.completed);
								const currentTask = tasksByPriority[0];

								if (!currentTask) {
									console.log(chalk.green("\n✓ All plan waypoints complete!"));
									break;
								}

								// Generate focused context for the current waypoint
								const taskContext = generateTaskContext(parsedPlan, currentTask.id);
								const progress = getPlanProgress(parsedPlan);

								// Build progress context from previous result
								const progressNote = step > 1 ? `\n\nPREVIOUS STEP RESULT:\n${lastResult.substring(0, 1500)}` : "";

								goal = `Implement this specific waypoint:

${currentTask.content}

${taskContext}${progressNote}

After completing this waypoint, summarize what you did. If this waypoint is impossible or already done, explain why and say "TASK SKIPPED".`;

								console.log(
									chalk.cyan(`\n━━━ Waypoint ${step}/${progress.total}: ${currentTask.content.substring(0, 50)}... ━━━`),
								);
								if (currentTask.section) {
									console.log(chalk.dim(`    Section: ${currentTask.section}`));
								}
							} else {
								// Legacy mode: pass whole plan each iteration
								const progressContext =
									step > 1
										? `\n\nPREVIOUS STEP RESULT:\n${lastResult.substring(0, 2000)}\n\nContinue with the next logical step.`
										: "";

								goal = `Execute this implementation plan with good judgment. Read the plan, determine the next logical step that hasn't been done yet, and implement it. If something is already complete, skip it. If the plan is fully complete, respond with "PLAN COMPLETE".

PLAN FILE CONTENTS:
${planContent.substring(0, 12000)}${planContent.length > 12000 ? "\n\n[Plan truncated]" : ""}${progressContext}`;

								console.log(chalk.cyan(`\n━━━ Step ${step} ━━━`));
							}

							const _raid = await orchestrator.start(goal);
							const _finalRaid = orchestrator.getCurrentRaid();

							// Get the result for context
							const waypoints = orchestrator.getStatus().waypoints;
							const questerTask = waypoints.find((t) => t.type === "quester");
							lastResult = questerTask?.result || "";

							// Check for completion markers
							if (lastResult.toLowerCase().includes("plan complete")) {
								console.log(chalk.green("\n✓ Plan execution complete!"));
								break;
							}

							// Mark current waypoint as completed in parsed plan (for new mode)
							if (parsedPlan && !options.legacy) {
								const tasksByPriority = getTasksByPriority(parsedPlan).filter((t) => !t.completed);
								const currentTask = tasksByPriority[0];

								if (currentTask && !lastResult.toLowerCase().includes("waypoint skipped")) {
									parsedPlan = markTaskCompleted(parsedPlan, currentTask.id);
									const progress = getPlanProgress(parsedPlan);
									console.log(chalk.green(`  ✓ Waypoint complete (${progress.completed}/${progress.total})`));
								} else if (currentTask && lastResult.toLowerCase().includes("waypoint skipped")) {
									// Also mark skipped waypoints as completed so we move on
									parsedPlan = markTaskCompleted(parsedPlan, currentTask.id);
									console.log(chalk.yellow("  ⊘ Waypoint skipped"));
								}
							}

							// Clear state for next step
							orchestrator.surrender();
							const persistence = new Persistence();
							persistence.clearAll();

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
									`\nFinal progress: ${progress.completed}/${progress.total} waypoints (${progress.percentComplete}%)`,
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
			.option("-s, --stream", "Stream raider activity")
			.action(async (options: { count?: string; stream?: boolean }) => {
				const maxCount = Number.parseInt(options.count || "0", 10);
				let processed = 0;

				console.log(chalk.cyan("Starting backlog worker..."));
				if (maxCount > 0) {
					console.log(chalk.dim(`  Will process ${maxCount} quest(s) then stop`));
				} else {
					console.log(chalk.dim("  Will process all pending goals"));
				}
				console.log();

				while (true) {
					const nextGoal = getNextGoal();

					if (!nextGoal) {
						console.log(chalk.green("\n✓ Backlog empty - all quests processed"));
						break;
					}

					if (maxCount > 0 && processed >= maxCount) {
						console.log(chalk.yellow(`\n✓ Processed ${maxCount} quest(s) - stopping`));
						break;
					}

					console.log(chalk.cyan(`\n━━━ Quest ${processed + 1}: ${nextGoal.objective.substring(0, 50)}... ━━━`));

					const orchestrator = new RaidOrchestrator({
						autoApprove: true,
						autoCommit: true,
						verbose: true,
						streamOutput: options.stream,
					});

					markInProgress(nextGoal.id, "");

					try {
						const raid = await orchestrator.start(nextGoal.objective);
						markInProgress(nextGoal.id, raid.id);

						const finalRaid = orchestrator.getCurrentRaid();

						if (finalRaid?.status === "complete") {
							markComplete(nextGoal.id);
							console.log(chalk.green(`✓ Quest complete: ${nextGoal.objective.substring(0, 40)}...`));
						} else if (finalRaid?.status === "merge_failed") {
							// CRITICAL: Merge failed - branches preserved for recovery
							markFailed(nextGoal.id, "Merge failed - branches preserved for manual recovery");
							console.log(chalk.red(`✗ Quest merge failed: ${nextGoal.objective.substring(0, 40)}...`));
							console.log(chalk.yellow("  Work branches preserved. Use 'git branch' to see them."));
							console.log(chalk.yellow("  Manually merge or cherry-pick to recover the work."));
						} else if (finalRaid?.status === "failed") {
							markFailed(nextGoal.id, "Raid failed");
							console.log(chalk.red(`✗ Quest failed: ${nextGoal.objective.substring(0, 40)}...`));
						} else {
							// Raid didn't complete properly - don't auto-complete, mark as failed
							const status = finalRaid?.status ?? "unknown";
							markFailed(nextGoal.id, `Raid ended with status: ${status}`);
							console.log(chalk.red(`✗ Quest incomplete (status: ${status}): ${nextGoal.objective.substring(0, 40)}...`));
						}

						// Clear raid state for next goal
						orchestrator.surrender();
						const persistence = new Persistence();
						persistence.clearAll();

						processed++;
					} catch (error) {
						markFailed(nextGoal.id, error instanceof Error ? error.message : String(error));
						console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));

						// Clear state and continue with next goal
						const persistence = new Persistence();
						persistence.clearAll();
					}
				}

				const summary = getBacklogSummary();
				console.log(
					`\nFinal: ${chalk.green(summary.complete)} complete, ${chalk.red(summary.failed)} failed, ${chalk.yellow(summary.pending)} pending`,
				);
			});

		// Quest batch command - process multiple quests in parallel (DEPRECATED)
		program
			.command("quest-batch")
			.description("[DEPRECATED] Process multiple quests in parallel (use 'grind --parallel' instead)")
			.option("-n, --max-quests <n>", "Maximum concurrent quests (1-5)", "3")
			.option("--dry-run", "Show quest matchmaking without executing")
			.option("--analyze-only", "Analyze quests and show compatibility matrix")
			.option("-a, --auto-approve", "Auto-approve plans without human review")
			.option("-y, --yes", "Auto-approve and auto-commit")
			.option("-s, --stream", "Stream raider activity")
			.option("-v, --verbose", "Verbose logging")
			.option("--risk-threshold <n>", "Risk threshold for parallel execution (0-1)", "0.7")
			.option("--conflict-resolution <strategy>", "Conflict resolution strategy", "balanced")
			.action(
				async (options: {
					maxQuests?: string;
					dryRun?: boolean;
					analyzeOnly?: boolean;
					autoApprove?: boolean;
					yes?: boolean;
					stream?: boolean;
					verbose?: boolean;
					riskThreshold?: string;
					conflictResolution?: string;
				}) => {
					showDeprecationWarning("quest-batch", "undercity grind --parallel 3");

					const maxQuests = Math.min(5, Math.max(1, Number.parseInt(options.maxQuests || "3", 10)));
					const riskThreshold = Math.min(1, Math.max(0, Number.parseFloat(options.riskThreshold || "0.7")));
					const conflictResolution = (options.conflictResolution || "balanced") as
						| "conservative"
						| "aggressive"
						| "balanced";

					console.log(chalk.bold("Quest Batch Processing"));
					console.log();

					const orchestrator = new QuestBatchOrchestrator({
						maxParallelQuests: maxQuests,
						autoApprove: options.autoApprove || options.yes,
						autoCommit: options.yes,
						verbose: options.verbose,
						streamOutput: options.stream,
						riskThreshold,
						conflictResolution,
					});

					try {
						if (options.analyzeOnly) {
							// Just show compatibility analysis
							const analysis = await orchestrator.analyzeBatch(maxQuests);

							console.log(chalk.cyan(`Available quests: ${analysis.availableQuests.length}`));
							console.log(chalk.cyan(`Quest sets found: ${analysis.questSets.length}`));
							console.log();

							if (analysis.optimalSet) {
								console.log(chalk.bold("Optimal Quest Set:"));
								for (const quest of analysis.optimalSet.quests) {
									console.log(`  • ${quest.objective.substring(0, 60)}${quest.objective.length > 60 ? "..." : ""}`);
								}
								console.log();
								console.log(`Risk Level: ${analysis.optimalSet.riskLevel}`);
								console.log(`Parallelism Score: ${analysis.optimalSet.parallelismScore.toFixed(2)}`);
								console.log(`Estimated Duration: ${Math.round(analysis.optimalSet.estimatedDuration / 60000)} minutes`);
							}

							console.log();
							console.log(chalk.green(analysis.recommendedAction));
							return;
						}

						if (options.dryRun) {
							// Show what would be executed
							const analysis = await orchestrator.analyzeBatch(maxQuests);
							console.log(chalk.cyan("Dry run - no quests will be executed"));
							console.log();
							console.log(chalk.green(analysis.recommendedAction));
							return;
						}

						// Execute the batch
						console.log(chalk.cyan(`Starting parallel quest processing (max: ${maxQuests})`));
						console.log(chalk.dim(`Risk threshold: ${riskThreshold}, Conflict resolution: ${conflictResolution}`));
						console.log();

						const result = await orchestrator.processBatch(maxQuests);

						console.log();
						console.log(chalk.bold("Batch Results:"));
						console.log(`${chalk.green("✓")} Completed: ${result.completedQuests.length}`);
						console.log(`${chalk.red("✗")} Failed: ${result.failedQuests.length}`);
						console.log(`${chalk.yellow("⚡")} Conflicts: ${result.conflicts.length}`);
						console.log(`${chalk.cyan("⏱")} Duration: ${Math.round(result.totalDuration / 60000)} minutes`);

						if (result.conflicts.length > 0) {
							console.log();
							console.log(chalk.yellow("Conflicts detected:"));
							for (const conflict of result.conflicts) {
								console.log(`  • ${conflict.conflictingFiles.join(", ")} (${conflict.severity})`);
							}
						}
					} catch (error) {
						console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
						process.exit(1);
					} finally {
						await orchestrator.shutdown();
					}
				},
			);

		// Quest analyze command - analyze quest board for parallelization opportunities
		program
			.command("quest-analyze")
			.description("Analyze quest board for parallelization opportunities")
			.option("--compatibility", "Show compatibility matrix")
			.option("--suggestions", "Show optimization suggestions")
			.action(async (options: { compatibility?: boolean; suggestions?: boolean }) => {
				const analyzer = new QuestBoardAnalyzer();

				console.log(chalk.bold("Quest Board Analysis"));
				console.log();

				try {
					const insights = await analyzer.analyzeQuestBoard();

					// Basic insights
					console.log(chalk.cyan("Overview:"));
					console.log(`  Total quests: ${insights.totalQuests}`);
					console.log(`  Pending quests: ${insights.pendingQuests}`);
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

						if (matrix.quests.length > 0) {
							console.log(`  ${matrix.summary.compatiblePairs}/${matrix.summary.totalPairs} pairs are compatible`);
							console.log(`  Average compatibility: ${(matrix.summary.averageCompatibilityScore * 100).toFixed(1)}%`);

							// Show a simplified matrix for first few quests
							const maxShow = Math.min(5, matrix.quests.length);
							console.log();
							console.log("  Quest compatibility (✓ = compatible, ✗ = conflict):");
							for (let i = 0; i < maxShow; i++) {
								const quest = matrix.quests[i];
								const row = matrix.matrix[i];
								let line = `  ${quest.id.substring(0, 8)}: `;
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

							if (matrix.quests.length > maxShow) {
								console.log(chalk.dim(`  ... and ${matrix.quests.length - maxShow} more quests`));
							}
						} else {
							console.log("  No quests available for analysis");
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

		// Quest status command - show detailed quest board status
		program
			.command("quest-status")
			.description("Show detailed quest board status and analytics")
			.action(() => {
				console.log(chalk.bold("Quest Board Status"));
				console.log();

				// Basic quest board summary
				const summary = getBacklogSummary();
				const analytics = getQuestBoardAnalytics();

				console.log(chalk.cyan("Current Status:"));
				console.log(`  ${chalk.green("Complete:")} ${summary.complete}`);
				console.log(`  ${chalk.yellow("Pending:")} ${summary.pending}`);
				console.log(`  ${chalk.cyan("In Progress:")} ${summary.inProgress}`);
				console.log(`  ${chalk.red("Failed:")} ${summary.failed}`);
				console.log();

				console.log(chalk.cyan("Analytics:"));
				console.log(`  Total quests: ${analytics.totalQuests}`);
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

				// Show next few ready quests
				const readyQuests = getReadyQuestsForBatch(5);
				if (readyQuests.length > 0) {
					console.log(chalk.cyan("Next Ready Quests:"));
					for (let i = 0; i < Math.min(3, readyQuests.length); i++) {
						const quest = readyQuests[i];
						console.log(`  ${i + 1}. ${quest.objective.substring(0, 60)}${quest.objective.length > 60 ? "..." : ""}`);
					}
					if (readyQuests.length > 3) {
						console.log(chalk.dim(`  ... and ${readyQuests.length - 3} more`));
					}
					console.log();
				}

				console.log(chalk.dim("Run 'undercity quest-analyze' for detailed parallelization analysis"));
				console.log(chalk.dim("Run 'undercity quest-batch' to process quests in parallel"));
			});
	},
};