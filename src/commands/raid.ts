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

				// Additional status information would be shown here
			});

		// Approve command
		program
			.command("approve")
			.description("Approve the current plan and start execution")
			.option("-s, --stream", "Stream raider activity to console")
			.action(async (options: { stream?: boolean }) => {
				const orchestrator = new RaidOrchestrator({ verbose: true, streamOutput: options.stream ?? true });
				const raid = orchestrator.getCurrentRaid();

				if (!raid) {
					console.error(chalk.red("No active raid"));
					process.exit(1);
				}

				if (raid.status !== "awaiting_approval") {
					console.error(chalk.red(`Cannot approve: raid status is ${raid.status}`));
					process.exit(1);
				}

				console.log(chalk.cyan("Approving plan..."));

				try {
					await orchestrator.approvePlan();
					console.log(chalk.green("Plan approved! Execution started."));
				} catch (error) {
					console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
					process.exit(1);
				}
			});

		// Squad command
		program
			.command("squad")
			.description("Show active squad members")
			.action(() => {
				console.log(chalk.bold("Squad Members"));
				console.log(chalk.gray("Squad functionality not yet implemented"));
				console.log(chalk.dim("This will show active raid squad members"));
			});

		// Tasks command
		program
			.command("waypoints")
			.description("Show pending/complete waypoints")
			.action(() => {
				console.log(chalk.bold("Waypoints"));
				console.log(chalk.gray("Waypoints functionality not yet implemented"));
				console.log(chalk.dim("This will show raid task waypoints"));
			});

		// Merges command
		program
			.command("elevator")
			.description("Show elevator queue status")
			.action(() => {
				const orchestrator = new RaidOrchestrator({ verbose: false });
				const status = orchestrator.getStatus();

				if (status.elevator.length === 0) {
					console.log(chalk.gray("Merge queue is empty"));
					console.log("Branches are merged serially: rebase → test → merge");
					console.log(
						chalk.dim(
							"Failed merges in the elevator are automatically retried after successful merges (conflicts may resolve)",
						),
					);
					return;
				}

				console.log(chalk.bold("Elevator"));
				console.log();

				for (const item of status.elevator) {
					const statusIcon =
						item.status === "complete"
							? chalk.green("✓")
							: item.status === "pending"
								? chalk.gray("○")
								: item.status === "conflict" || item.status === "test_failed"
									? chalk.red("✗")
									: chalk.yellow("🏃");

					const retryInfo =
						item.retryCount && item.retryCount > 0 ? chalk.dim(` (retry ${item.retryCount}/${item.maxRetries || 3})`) : "";

					const isRetry = item.isRetry ? chalk.cyan(" [RETRY]") : "";

					console.log(`  ${statusIcon} ${item.branch}${retryInfo}${isRetry}`);
					console.log(`    Status: ${item.status}`);

					if (item.error) {
						console.log(`    Error: ${chalk.red(item.error.substring(0, 60))}${item.error.length > 60 ? "..." : ""}`);
					}

					if (item.originalError && item.originalError !== item.error) {
						console.log(
							`    Original error: ${chalk.dim(item.originalError.substring(0, 60))}${item.originalError.length > 60 ? "..." : ""}`,
						);
					}

					if (item.lastFailedAt) {
						console.log(`    Last failed: ${chalk.dim(new Date(item.lastFailedAt).toLocaleString())}`);
					}

					if (item.nextRetryAfter && new Date(item.nextRetryAfter) > new Date()) {
						console.log(`    Next retry after: ${chalk.dim(new Date(item.nextRetryAfter).toLocaleString())}`);
					}

					console.log();
				}
			});

		// Extract command
		program
			.command("extract")
			.description("Complete the current raid")
			.action(async () => {
				const orchestrator = new RaidOrchestrator({ verbose: true });

				try {
					await orchestrator.extract();
					console.log(chalk.green("Raid extracted successfully!"));
				} catch (error) {
					console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
					process.exit(1);
				}
			});

		// Surrender command
		program
			.command("surrender")
			.description("Surrender the current raid")
			.action(() => {
				const orchestrator = new RaidOrchestrator({ verbose: true });
				orchestrator.surrender();
				console.log(chalk.yellow("Raid surrendered"));
			});
	},
};