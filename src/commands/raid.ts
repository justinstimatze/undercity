/**
 * Raid-related commands
 */
import chalk from "chalk";
import { mergeWithConfig } from "../config.js";
import { Persistence } from "../persistence.js";
import { RaidOrchestrator } from "../raid.js";
import type { CommandModule } from "./types.js";
import { showDeprecationWarning, statusColor } from "./utils.js";

export const raidCommands: CommandModule = {
	register(program) {
		// Slingshot command - launch a raid via the Tubes (DEPRECATED)
		program
			.command("slingshot [goal]")
			.description("[DEPRECATED] Launch a new raid (use 'solo' or 'grind' instead)")
			.option("-a, --auto-approve", "Auto-approve plans without human review")
			.option("-y, --yes", "Full auto mode: auto-approve and auto-commit (walk away)")
			.option("-v, --verbose", "Enable verbose logging")
			.option("-s, --stream", "Stream raider activity to console")
			.option("-m, --max-squad <n>", "Maximum squad size", "5")
			.option("-p, --parallel <n>", "Maximum concurrent raiders (1-5)", "3")
			.option("-d, --dry-run", "Show the plan but don't execute (planning phase only)")
			.option("--max-retries <n>", "Maximum merge retry attempts (default: 3)", "3")
			.option("--no-retry", "Disable elevator retry functionality")
			.action(
				async (
					goal: string | undefined,
					cliOptions: {
						autoApprove?: boolean;
						yes?: boolean;
						verbose?: boolean;
						stream?: boolean;
						maxSquad?: string;
						parallel?: string;
						dryRun?: boolean;
						maxRetries?: string;
						retry?: boolean;
					},
				) => {
					// Merge CLI options with config file defaults
					const options = mergeWithConfig(cliOptions);

					showDeprecationWarning("slingshot", "undercity solo <goal> --stream");
					const fullAuto = cliOptions.yes || false;
					// Parse and validate parallel option (default 3, max 5)
					const parallelValue = Math.min(
						5,
						Math.max(1, Number.parseInt(cliOptions.parallel || String(options.parallel), 10)),
					);
					const orchestrator = new RaidOrchestrator({
						autoApprove: cliOptions.autoApprove || options.autoApprove || fullAuto,
						verbose: cliOptions.verbose || options.verbose || fullAuto,
						streamOutput: cliOptions.stream ?? options.stream ?? cliOptions.verbose ?? options.verbose ?? fullAuto,
						maxSquadSize: Number.parseInt(cliOptions.maxSquad || String(options.maxSquad), 10),
						maxParallel: parallelValue,
						autoCommit: fullAuto || options.autoCommit,
						retryConfig: {
							enabled: cliOptions.retry !== false,
							maxRetries: Number.parseInt(cliOptions.maxRetries || String(options.maxRetries), 10),
						},
					});

					// Check for existing raid (GUPP)
					if (orchestrator.hasActiveRaid()) {
						const existing = orchestrator.getCurrentRaid();
						if (existing) {
							console.log(chalk.yellow("Active raid found:"));
							console.log(`  ID: ${chalk.bold(existing.id)}`);
							console.log(`  Goal: ${existing.goal}`);
							console.log(`  Status: ${statusColor(existing.status)}`);
							console.log();
							console.log("Resuming...");

							// If awaiting approval and no auto-approve, prompt
							if (existing.status === "awaiting_approval" && !fullAuto && !options.autoApprove) {
								console.log(chalk.yellow("\nPlan awaiting approval. Use 'undercity approve' to continue."));
								return;
							}

							// In full auto mode, auto-approve and continue
							if (existing.status === "awaiting_approval" && fullAuto) {
								console.log(chalk.cyan("Auto-approving plan..."));
								await orchestrator.approvePlan();
							}
						}
					}

					if (!goal && !orchestrator.hasActiveRaid()) {
						console.error(chalk.red("Error: Goal is required to launch a new raid"));
						console.log("Usage: undercity slingshot <goal>");
						process.exit(1);
					}

					if (goal) {
						console.log(chalk.cyan("Launching raid via the Tubes..."));
						console.log(`  Goal: ${goal}`);
						if (options.dryRun) {
							console.log(chalk.dim("  Mode: Dry run (planning only, no execution)"));
						} else if (fullAuto) {
							console.log(chalk.dim("  Mode: Full auto (will complete without intervention)"));
						}
						console.log();

						try {
							const raid = await orchestrator.start(goal);
							const finalRaid = orchestrator.getCurrentRaid();

							// In dry-run mode, show the plan and exit after planning phase
							if (options.dryRun) {
								if (finalRaid?.status === "awaiting_approval" && finalRaid?.planSummary) {
									console.log(chalk.bold("\n📋 Plan Summary (dry run):"));
									console.log(chalk.gray("─".repeat(60)));
									console.log(finalRaid.planSummary);
									console.log(chalk.gray("─".repeat(60)));
									console.log();
									console.log(chalk.yellow("Dry run complete. Plan was NOT executed."));
									console.log(`To execute this plan, run: ${chalk.cyan("undercity approve")}`);
									console.log(`To start fresh, run: ${chalk.cyan("undercity clear")}`);
								} else {
									console.log(chalk.yellow(`Raid is in ${finalRaid?.status || raid.status} status`));
									console.log("Plan not yet available for review.");
								}
								return;
							}

							if (finalRaid?.status === "complete") {
								console.log(chalk.green(`\n✓ Raid complete: ${raid.id}`));
							} else if (finalRaid?.status === "failed") {
								console.log(chalk.red(`\n✗ Raid failed: ${raid.id}`));
							} else {
								console.log(chalk.green(`Raid started: ${raid.id}`));
								console.log(`Status: ${statusColor(finalRaid?.status || raid.status)}`);
							}
						} catch (error) {
							console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
							process.exit(1);
						}
					}
				},
			);

		// Status command
		program
			.command("status")
			.description("Show current raid status")
			.action(() => {
				const orchestrator = new RaidOrchestrator({ verbose: false });
				const status = orchestrator.getStatus();

				if (!status.raid) {
					console.log(chalk.gray("No active raid"));
					console.log("Launch one with: undercity slingshot <goal>");
					return;
				}

				console.log(chalk.bold("Current Raid"));
				console.log(`  ID: ${status.raid.id}`);
				console.log(`  Goal: ${status.raid.goal}`);
				console.log(`  Status: ${statusColor(status.raid.status)}`);
				console.log(`  Started: ${status.raid.startedAt}`);

				if (status.raid.planSummary) {
					console.log();
					console.log(chalk.bold("Plan Summary"));
					console.log(chalk.gray("─".repeat(60)));
					console.log(status.raid.planSummary);
					console.log(chalk.gray("─".repeat(60)));
				}

				if (status.squad && status.squad.length > 0) {
					console.log();
					console.log(chalk.bold("Active Squad"));
					for (const raider of status.squad) {
						console.log(`  ${raider.id}: ${chalk.cyan(raider.status)} (${raider.role})`);
					}
				}

				if (status.waypoints && status.waypoints.length > 0) {
					console.log();
					console.log(chalk.bold("Progress"));
					const completed = status.waypoints.filter((w) => w.status === "completed").length;
					console.log(`  ${completed}/${status.waypoints.length} waypoints complete`);

					const inProgress = status.waypoints.filter((w) => w.status === "in_progress");
					if (inProgress.length > 0) {
						console.log();
						console.log(chalk.bold("Active Work"));
						for (const wp of inProgress) {
							console.log(`  ${chalk.cyan("→")} ${wp.goal}`);
						}
					}
				}
			});
	},
};