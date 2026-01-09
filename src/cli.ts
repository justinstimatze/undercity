#!/usr/bin/env node

/**
 * Undercity CLI
 *
 * Multi-agent orchestrator for Claude Max - Gas Town for normal people.
 *
 * Commands:
 *   slingshot <goal>  Launch a new raid via the Tubes (or resume existing)
 *   status            Show current raid status
 *   approve           Approve the current plan
 *   squad             Show active squad members
 *   waypoints             Show pending/complete waypoints
 *   merges            Show merge queue status
 *   extract           Complete the current raid
 *   surrender         Surrender the current raid
 *   clear             Clear all state
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { Command } from "commander";
import { Persistence } from "./persistence.js";
import {
	generateTaskContext,
	getPlanProgress,
	getTasksByPriority,
	markTaskCompleted,
	type ParsedPlan,
	parsePlanFile,
	planToQuests,
} from "./plan-parser.js";
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
} from "./quest.js";
import { QuestBatchOrchestrator } from "./quest-batch-orchestrator.js";
import { QuestBoardAnalyzer } from "./quest-board-analyzer.js";
import { RaidOrchestrator } from "./raid.js";
import type { RaidStatus } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Get version from package.json
function getVersion(): string {
	try {
		const pkgPath = join(__dirname, "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return pkg.version || "0.1.0";
	} catch {
		return "0.1.0";
	}
}

// Status color mapping
function statusColor(status: RaidStatus): string {
	switch (status) {
		case "planning":
			return chalk.blue(status);
		case "awaiting_approval":
			return chalk.yellow(status);
		case "executing":
			return chalk.cyan(status);
		case "reviewing":
			return chalk.magenta(status);
		case "merging":
			return chalk.blue(status);
		case "extracting":
			return chalk.green(status);
		case "complete":
			return chalk.green(status);
		case "failed":
			return chalk.red(status);
		default:
			return status;
	}
}

// Create the CLI program
const program = new Command();

program
	.name("undercity")
	.description("Multi-agent orchestrator for Claude Max - Gas Town for budget extraction")
	.version(getVersion());

// Slingshot command - launch a raid via the Tubes
program
	.command("slingshot [goal]")
	.description("Launch a new raid (or resume existing)")
	.option("-a, --auto-approve", "Auto-approve plans without human review")
	.option("-y, --yes", "Full auto mode: auto-approve and auto-commit (walk away)")
	.option("-v, --verbose", "Enable verbose logging")
	.option("-s, --stream", "Stream agent activity to console")
	.option("-m, --max-squad <n>", "Maximum squad size", "5")
	.option("-p, --parallel <n>", "Maximum concurrent raiders (1-5)", "3")
	.option("-d, --dry-run", "Show the plan but don't execute (planning phase only)")
	.option("--max-retries <n>", "Maximum merge retry attempts (default: 3)", "3")
	.option("--no-retry", "Disable merge queue retry functionality")
	.action(
		async (
			goal: string | undefined,
			options: {
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
			const fullAuto = options.yes || false;
			// Parse and validate parallel option (default 3, max 5)
			const parallelValue = Math.min(5, Math.max(1, Number.parseInt(options.parallel || "3", 10)));
			const orchestrator = new RaidOrchestrator({
				autoApprove: options.autoApprove || fullAuto,
				verbose: options.verbose || fullAuto,
				streamOutput: options.stream ?? options.verbose ?? fullAuto,
				maxSquadSize: Number.parseInt(options.maxSquad || "5", 10),
				maxParallel: parallelValue,
				autoCommit: fullAuto,
				retryConfig: {
					enabled: options.retry !== false,
					maxRetries: Number.parseInt(options.maxRetries || "3", 10),
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

		// Calculate and display progress percentage
		if (status.waypoints.length > 0) {
			const completedTasks = status.waypoints.filter((t) => t.status === "complete").length;
			const totalTasks = status.waypoints.length;
			const progressPercent = Math.round((completedTasks / totalTasks) * 100);
			const progressBar =
				"█".repeat(Math.floor(progressPercent / 5)) + "░".repeat(20 - Math.floor(progressPercent / 5));
			console.log(`  Progress: [${progressBar}] ${progressPercent}% (${completedTasks}/${totalTasks} waypoints)`);
		}

		if (status.raid.planSummary && status.raid.status === "awaiting_approval") {
			console.log();
			console.log(chalk.yellow("Plan Summary:"));
			console.log(status.raid.planSummary.substring(0, 500) + (status.raid.planSummary.length > 500 ? "..." : ""));
		}

		if (status.squad.length > 0) {
			console.log();
			console.log(chalk.bold("Squad"));
			for (const member of status.squad) {
				const statusIcon = member.status === "working" ? "⚡" : member.status === "done" ? "✓" : "○";
				console.log(`  ${statusIcon} ${member.type} (${member.id}): ${member.status}`);
			}
		}

		if (status.waypoints.length > 0) {
			console.log();
			console.log(chalk.bold("Tasks"));
			for (const waypoint of status.waypoints) {
				const statusIcon = waypoint.status === "complete" ? "✓" : waypoint.status === "in_progress" ? "⚡" : "○";
				console.log(`  ${statusIcon} [${waypoint.type}] ${waypoint.description.substring(0, 50)}...`);
			}
		}

		if (status.mergeQueue.length > 0) {
			console.log();
			console.log(chalk.bold("Merge Queue"));
			for (const item of status.mergeQueue) {
				console.log(`  ${item.status}: ${item.branch}`);
			}
		}
	});

// Approve command
program
	.command("approve")
	.description("Approve the current plan and start execution")
	.option("-s, --stream", "Stream agent activity to console")
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
		const persistence = new Persistence();
		const squad = persistence.getSquad();

		if (squad.length === 0) {
			console.log(chalk.gray("No active squad members"));
			return;
		}

		console.log(chalk.bold("Squad Members"));
		console.log();

		for (const member of squad) {
			console.log(`${chalk.cyan(member.type)} (${member.id})`);
			console.log(`  Status: ${member.status}`);
			console.log(`  Spawned: ${member.spawnedAt}`);
			console.log(`  Last Activity: ${member.lastActivityAt}`);
			if (member.waypoint) {
				console.log(`  Waypoint: ${member.waypoint.description.substring(0, 50)}...`);
			}
			console.log();
		}
	});

// Tasks command
program
	.command("waypoints")
	.description("Show pending/complete waypoints")
	.action(() => {
		const persistence = new Persistence();
		const waypoints = persistence.getTasks();

		if (waypoints.length === 0) {
			console.log(chalk.gray("No waypoints"));
			return;
		}

		const pending = waypoints.filter(
			(t) => t.status === "pending" || t.status === "assigned" || t.status === "in_progress",
		);
		const completed = waypoints.filter((t) => t.status === "complete");
		const failed = waypoints.filter((t) => t.status === "failed" || t.status === "blocked");

		if (pending.length > 0) {
			console.log(chalk.bold("Pending Tasks"));
			for (const waypoint of pending) {
				console.log(`  ○ [${waypoint.type}] ${waypoint.status}: ${waypoint.description.substring(0, 50)}...`);
			}
			console.log();
		}

		if (completed.length > 0) {
			console.log(chalk.bold("Completed Tasks"));
			for (const waypoint of completed) {
				console.log(`  ${chalk.green("✓")} [${waypoint.type}] ${waypoint.description.substring(0, 50)}...`);
			}
			console.log();
		}

		if (failed.length > 0) {
			console.log(chalk.bold("Failed Tasks"));
			for (const waypoint of failed) {
				console.log(
					`  ${chalk.red("✗")} [${waypoint.type}] ${waypoint.status}: ${waypoint.description.substring(0, 50)}...`,
				);
				if (waypoint.error) {
					console.log(`    Error: ${waypoint.error}`);
				}
			}
		}
	});

// Merges command
program
	.command("merges")
	.description("Show merge queue status")
	.action(() => {
		const orchestrator = new RaidOrchestrator({ verbose: false });
		const status = orchestrator.getStatus();

		if (status.mergeQueue.length === 0) {
			console.log(chalk.gray("Merge queue is empty"));
			console.log("Branches are merged serially: rebase → test → merge");
			console.log(chalk.dim("Failed merges are automatically retried after successful merges (conflicts may resolve)"));
			return;
		}

		console.log(chalk.bold("Merge Queue"));
		console.log();

		for (const item of status.mergeQueue) {
			const statusIcon =
				item.status === "complete"
					? chalk.green("✓")
					: item.status === "pending"
						? chalk.gray("○")
						: item.status === "conflict" || item.status === "test_failed"
							? chalk.red("✗")
							: chalk.yellow("⚡");

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

// Clear command
program
	.command("clear")
	.description("Clear all state (use with caution)")
	.action(() => {
		const persistence = new Persistence();
		persistence.clearAll();
		console.log(chalk.yellow("All state cleared"));
	});

// Setup command
program
	.command("setup")
	.description("Check authentication setup for Claude Max")
	.action(() => {
		console.log(chalk.bold("Undercity Authentication Setup"));
		console.log();

		// Check for OAuth token (Claude Max)
		const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		const apiKey = process.env.ANTHROPIC_API_KEY;

		if (oauthToken) {
			console.log(chalk.green("✓ CLAUDE_CODE_OAUTH_TOKEN is set"));
			console.log("  Using Claude Max subscription");
		} else if (apiKey) {
			console.log(chalk.yellow("⚠ ANTHROPIC_API_KEY is set"));
			console.log("  This will use API tokens (costs money!)");
			console.log();
			console.log("To use Claude Max instead:");
			console.log("  1. Run: claude setup-token");
			console.log('  2. Set: export CLAUDE_CODE_OAUTH_TOKEN="your-token"');
		} else {
			console.log(chalk.red("✗ No authentication configured"));
			console.log();
			console.log("To set up Claude Max authentication:");
			console.log("  1. Run: claude setup-token");
			console.log('  2. Set: export CLAUDE_CODE_OAUTH_TOKEN="your-token"');
			console.log();
			console.log("Or for API tokens (costs money):");
			console.log('  Set: export ANTHROPIC_API_KEY="your-key"');
		}
	});

// History command - show completed raids from stash
program
	.command("history")
	.description("Show completed raids from the stash")
	.option("-n, --count <n>", "Number of raids to show", "10")
	.action((options: { count?: string }) => {
		const persistence = new Persistence();
		const stash = persistence.getStash();
		const maxCount = Number.parseInt(options.count || "10", 10);

		if (stash.completedRaids.length === 0) {
			console.log(chalk.gray("No completed raids in history"));
			console.log("Complete a raid to see it here.");
			return;
		}

		console.log(chalk.bold("Raid History"));
		console.log();

		// Show most recent first
		const raids = [...stash.completedRaids].reverse().slice(0, maxCount);

		for (const raid of raids) {
			const statusIcon = raid.success ? chalk.green("✓") : chalk.red("✗");
			const statusText = raid.success ? chalk.green("success") : chalk.red("failed");
			const completedAt = raid.completedAt ? new Date(raid.completedAt).toLocaleString() : "unknown";

			console.log(`${statusIcon} ${chalk.bold(raid.id)}`);
			console.log(`  Goal: ${raid.goal.substring(0, 60)}${raid.goal.length > 60 ? "..." : ""}`);
			console.log(`  Status: ${statusText}`);
			console.log(`  Completed: ${chalk.gray(completedAt)}`);
			console.log();
		}

		if (stash.completedRaids.length > maxCount) {
			console.log(chalk.gray(`... and ${stash.completedRaids.length - maxCount} more raids`));
		}
	});

// ============== Backlog Commands ==============

// Backlog command - show/manage the goal queue
program
	.command("backlog")
	.description("Show the goal backlog")
	.action(() => {
		const items = getAllItems();
		const summary = getBacklogSummary();

		console.log(chalk.bold("Goal Backlog"));
		console.log(
			`  ${chalk.yellow(summary.pending)} pending, ${chalk.cyan(summary.inProgress)} in progress, ${chalk.green(summary.complete)} complete, ${chalk.red(summary.failed)} failed`,
		);
		console.log();

		if (items.length === 0) {
			console.log(chalk.gray("No goals in backlog"));
			console.log("Add goals with: undercity add <goal>");
			return;
		}

		const pending = items.filter((i) => i.status === "pending");
		const inProgress = items.filter((i) => i.status === "in_progress");

		if (inProgress.length > 0) {
			console.log(chalk.bold("In Progress"));
			for (const item of inProgress) {
				console.log(
					`  ${chalk.cyan("⚡")} ${item.objective.substring(0, 60)}${item.objective.length > 60 ? "..." : ""}`,
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
	.option("-s, --stream", "Stream agent activity")
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
	.option("-s, --stream", "Stream agent activity")
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
				} else if (finalRaid?.status === "failed") {
					markFailed(nextGoal.id, "Raid failed");
					console.log(chalk.red(`✗ Quest failed: ${nextGoal.objective.substring(0, 40)}...`));
				} else {
					// Raid didn't fully complete (maybe awaiting something)
					markComplete(nextGoal.id); // Consider it done for now
					console.log(chalk.yellow(`⚠ Quest processed: ${nextGoal.objective.substring(0, 40)}...`));
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

// Quest batch command - process multiple quests in parallel
program
	.command("quest-batch")
	.description("Process multiple quests in parallel batches")
	.option("-n, --max-quests <n>", "Maximum concurrent quests (1-5)", "3")
	.option("--dry-run", "Show quest matchmaking without executing")
	.option("--analyze-only", "Analyze quests and show compatibility matrix")
	.option("-a, --auto-approve", "Auto-approve plans without human review")
	.option("-y, --yes", "Auto-approve and auto-commit")
	.option("-s, --stream", "Stream agent activity")
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

// Parse and run
program.parse();
