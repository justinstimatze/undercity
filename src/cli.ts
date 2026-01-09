#!/usr/bin/env node

/**
 * Undercity CLI
 *
 * Multi-agent orchestrator for Claude Max - Gas Town for budget extraction.
 *
 * Commands:
 *   slingshot <goal>  Launch a new raid via the Tubes (or resume existing)
 *   status            Show current raid status
 *   approve           Approve the current plan
 *   squad             Show active squad members
 *   tasks             Show pending/complete tasks
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
	addGoal,
	addGoals,
	addQuests,
	clearCompleted,
	getAllItems,
	getBacklogSummary,
	getNextGoal,
	markComplete,
	markFailed,
	markInProgress,
} from "./quest.js";
import {
	parsePlanFile,
	getPlanProgress,
	getTasksByPriority,
	generateTaskContext,
	markTaskCompleted,
	planToQuests,
	type ParsedPlan,
} from "./plan-parser.js";
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
		if (status.tasks.length > 0) {
			const completedTasks = status.tasks.filter((t) => t.status === "complete").length;
			const totalTasks = status.tasks.length;
			const progressPercent = Math.round((completedTasks / totalTasks) * 100);
			const progressBar =
				"█".repeat(Math.floor(progressPercent / 5)) + "░".repeat(20 - Math.floor(progressPercent / 5));
			console.log(`  Progress: [${progressBar}] ${progressPercent}% (${completedTasks}/${totalTasks} tasks)`);
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

		if (status.tasks.length > 0) {
			console.log();
			console.log(chalk.bold("Tasks"));
			for (const task of status.tasks) {
				const statusIcon = task.status === "complete" ? "✓" : task.status === "in_progress" ? "⚡" : "○";
				console.log(`  ${statusIcon} [${task.type}] ${task.description.substring(0, 50)}...`);
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
			if (member.task) {
				console.log(`  Task: ${member.task.description.substring(0, 50)}...`);
			}
			console.log();
		}
	});

// Tasks command
program
	.command("tasks")
	.description("Show pending/complete tasks")
	.action(() => {
		const persistence = new Persistence();
		const tasks = persistence.getTasks();

		if (tasks.length === 0) {
			console.log(chalk.gray("No tasks"));
			return;
		}

		const pending = tasks.filter(
			(t) => t.status === "pending" || t.status === "assigned" || t.status === "in_progress",
		);
		const completed = tasks.filter((t) => t.status === "complete");
		const failed = tasks.filter((t) => t.status === "failed" || t.status === "blocked");

		if (pending.length > 0) {
			console.log(chalk.bold("Pending Tasks"));
			for (const task of pending) {
				console.log(`  ○ [${task.type}] ${task.status}: ${task.description.substring(0, 50)}...`);
			}
			console.log();
		}

		if (completed.length > 0) {
			console.log(chalk.bold("Completed Tasks"));
			for (const task of completed) {
				console.log(`  ${chalk.green("✓")} [${task.type}] ${task.description.substring(0, 50)}...`);
			}
			console.log();
		}

		if (failed.length > 0) {
			console.log(chalk.bold("Failed Tasks"));
			for (const task of failed) {
				console.log(`  ${chalk.red("✗")} [${task.type}] ${task.status}: ${task.description.substring(0, 50)}...`);
				if (task.error) {
					console.log(`    Error: ${task.error}`);
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
	.description("Import a plan file as discrete quests (extracts tasks from markdown plans)")
	.option("--dry-run", "Show what would be imported without adding to quest board")
	.option("--by-priority", "Sort tasks by section priority (default: by file order)")
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
			console.log(chalk.dim(`  Tasks: ${progress.total} (${progress.pending} pending, ${progress.completed} marked complete)`));
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

			// Get tasks to import
			const quests = planToQuests(plan);

			if (quests.length === 0) {
				console.log(chalk.yellow("No pending tasks found in plan"));
				return;
			}

			// Sort by priority if requested
			if (options.byPriority) {
				// quests are already sorted by priority from planToQuests
				console.log(chalk.dim("Tasks sorted by section priority"));
			}

			if (options.dryRun) {
				console.log(chalk.cyan(`Would import ${quests.length} tasks:`));
				for (let i = 0; i < Math.min(quests.length, 20); i++) {
					const quest = quests[i];
					const sectionTag = quest.section ? chalk.dim(` [${quest.section}]`) : "";
					console.log(`  ${i + 1}. ${quest.objective.substring(0, 70)}${quest.objective.length > 70 ? "..." : ""}${sectionTag}`);
				}
				if (quests.length > 20) {
					console.log(chalk.dim(`  ... and ${quests.length - 20} more`));
				}
			} else {
				// Import as quests
				const objectives = quests.map((q) => q.objective);
				const imported = addQuests(objectives);
				console.log(chalk.green(`✓ Imported ${imported.length} tasks as quests`));
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
	.description("Execute a plan file with good judgment (uses planner to determine next steps)")
	.option("-s, --stream", "Stream agent activity")
	.option("-c, --continuous", "Keep executing until plan is complete")
	.option("-n, --steps <n>", "Max steps to execute (default: unlimited in continuous mode)")
	.option("--legacy", "Use legacy mode (re-read whole plan each iteration)")
	.action(async (file: string, options: { stream?: boolean; continuous?: boolean; steps?: string; legacy?: boolean }) => {
		try {
			const planContent = readFileSync(file, "utf-8");
			const maxSteps = options.steps ? Number.parseInt(options.steps, 10) : options.continuous ? 100 : 1;

			// Parse plan upfront into discrete tasks (unless legacy mode)
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

				// Get tasks sorted by priority
				const tasksByPriority = getTasksByPriority(parsedPlan).filter((t) => !t.completed);

				if (tasksByPriority.length === 0) {
					console.log(chalk.green("✓ All tasks already marked complete in plan!"));
					return;
				}

				// Show upcoming tasks
				console.log(chalk.cyan("Queued tasks (by priority):"));
				for (let i = 0; i < Math.min(tasksByPriority.length, 5); i++) {
					const task = tasksByPriority[i];
					const sectionTag = task.section ? chalk.dim(` [${task.section}]`) : "";
					console.log(`  ${i + 1}. ${task.content.substring(0, 60)}${task.content.length > 60 ? "..." : ""}${sectionTag}`);
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
					// New mode: use parsed tasks with focused context
					const tasksByPriority = getTasksByPriority(parsedPlan).filter((t) => !t.completed);
					const currentTask = tasksByPriority[0];

					if (!currentTask) {
						console.log(chalk.green("\n✓ All plan tasks complete!"));
						break;
					}

					// Generate focused context for the current task
					const taskContext = generateTaskContext(parsedPlan, currentTask.id);
					const progress = getPlanProgress(parsedPlan);

					// Build progress context from previous result
					const progressNote =
						step > 1
							? `\n\nPREVIOUS STEP RESULT:\n${lastResult.substring(0, 1500)}`
							: "";

					goal = `Implement this specific task:

${currentTask.content}

${taskContext}${progressNote}

After completing this task, summarize what you did. If this task is impossible or already done, explain why and say "TASK SKIPPED".`;

					console.log(chalk.cyan(`\n━━━ Task ${step}/${progress.total}: ${currentTask.content.substring(0, 50)}... ━━━`));
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

				const raid = await orchestrator.start(goal);
				const finalRaid = orchestrator.getCurrentRaid();

				// Get the result for context
				const tasks = orchestrator.getStatus().tasks;
				const fabricatorTask = tasks.find((t) => t.type === "fabricator");
				lastResult = fabricatorTask?.result || "";

				// Check for completion markers
				if (lastResult.toLowerCase().includes("plan complete")) {
					console.log(chalk.green("\n✓ Plan execution complete!"));
					break;
				}

				// Mark current task as completed in parsed plan (for new mode)
				if (parsedPlan && !options.legacy) {
					const tasksByPriority = getTasksByPriority(parsedPlan).filter((t) => !t.completed);
					const currentTask = tasksByPriority[0];

					if (currentTask && !lastResult.toLowerCase().includes("task skipped")) {
						parsedPlan = markTaskCompleted(parsedPlan, currentTask.id);
						const progress = getPlanProgress(parsedPlan);
						console.log(chalk.green(`  ✓ Task complete (${progress.completed}/${progress.total})`));
					} else if (currentTask && lastResult.toLowerCase().includes("task skipped")) {
						// Also mark skipped tasks as completed so we move on
						parsedPlan = markTaskCompleted(parsedPlan, currentTask.id);
						console.log(chalk.yellow("  ⊘ Task skipped"));
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
				console.log(chalk.cyan(`\nFinal progress: ${progress.completed}/${progress.total} tasks (${progress.percentComplete}%)`));
			}
		} catch (error) {
			console.error(chalk.red(`Error: ${error instanceof Error ? error.message : error}`));
			process.exit(1);
		}
	});

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

// ============== Analytics Commands ==============

// Analytics command - show efficiency metrics
program
	.command("analytics")
	.description("Show efficiency metrics and analytics")
	.option("--days <n>", "Show analytics for last N days", "30")
	.option("--export", "Export metrics to JSON file")
	.option("--json", "Output in JSON format")
	.action((options: { days?: string; export?: boolean; json?: boolean }) => {
		const persistence = new Persistence();
		const days = Number.parseInt(options.days || "30", 10);

		// Calculate date range
		const endDate = new Date();
		const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

		const analytics = days === 0 || days > 365
			? persistence.getEfficiencyAnalytics() // All time
			: persistence.getEfficiencyAnalyticsInRange(startDate, endDate);

		if (options.export) {
			const filename = `analytics-${new Date().toISOString().split('T')[0]}.json`;
			const exportData = {
				exportDate: new Date(),
				dateRange: days === 0 ? "all-time" : `${days} days`,
				startDate: days === 0 ? null : startDate,
				endDate,
				analytics,
				questMetrics: days === 0
					? persistence.getQuestMetrics()
					: persistence.getQuestMetricsInRange(startDate, endDate)
			};
			require('fs').writeFileSync(filename, JSON.stringify(exportData, null, 2));
			console.log(chalk.green(`✓ Analytics exported to ${filename}`));
			return;
		}

		if (options.json) {
			console.log(JSON.stringify(analytics, null, 2));
			return;
		}

		// Display analytics in human-readable format
		const dateRangeStr = days === 0 ? "All Time" : `Last ${days} Days`;
		console.log(chalk.bold(`Efficiency Analytics - ${dateRangeStr}`));
		console.log(chalk.gray("─".repeat(50)));
		console.log();

		// Overall stats
		console.log(chalk.bold("📊 Overall Statistics"));
		console.log(`  Total Quests: ${analytics.totalQuests}`);
		console.log(`  Success Rate: ${chalk.green(analytics.successRate.toFixed(1) + "%")} (${analytics.successfulQuests}/${analytics.totalQuests})`);
		if (analytics.failedQuests > 0) {
			console.log(`  Failed Quests: ${chalk.red(analytics.failedQuests.toString())}`);
		}
		console.log();

		// Token efficiency
		console.log(chalk.bold("🪙 Token Efficiency"));
		console.log(`  Avg Tokens per Quest: ${chalk.cyan(Math.round(analytics.avgTokensPerQuest).toLocaleString())}`);
		if (analytics.successfulQuests > 0) {
			console.log(`  Avg Tokens per Success: ${chalk.green(Math.round(analytics.avgTokensPerCompletion).toLocaleString())}`);
		}
		console.log(`  Token Efficiency: ${chalk.yellow(Math.round(analytics.tokenEfficiency).toLocaleString())} tokens/min`);
		console.log(`  Avg Execution Time: ${chalk.magenta(analytics.avgExecutionTimeMinutes.toFixed(1))} minutes`);
		console.log();

		// Extremes
		if (analytics.mostExpensiveQuest) {
			console.log(chalk.bold("💸 Most Expensive Quest"));
			console.log(`  ${analytics.mostExpensiveQuest.objective.substring(0, 50)}${analytics.mostExpensiveQuest.objective.length > 50 ? "..." : ""}`);
			console.log(`  Tokens: ${chalk.red(analytics.mostExpensiveQuest.tokens.toLocaleString())}`);
			console.log(`  Time: ${analytics.mostExpensiveQuest.timeMinutes.toFixed(1)} min`);
			console.log();
		}

		if (analytics.mostEfficientQuest) {
			console.log(chalk.bold("⚡ Most Efficient Quest"));
			console.log(`  ${analytics.mostEfficientQuest.objective.substring(0, 50)}${analytics.mostEfficientQuest.objective.length > 50 ? "..." : ""}`);
			console.log(`  Efficiency: ${chalk.green(Math.round(analytics.mostEfficientQuest.tokensPerMinute).toLocaleString())} tokens/min`);
			console.log();
		}

		// Agent utilization
		console.log(chalk.bold("🤖 Agent Utilization"));
		for (const [agentType, stats] of Object.entries(analytics.agentUtilization)) {
			if (stats.timesUsed > 0) {
				console.log(`  ${agentType.padEnd(10)}: ${stats.timesUsed.toString().padStart(3)} uses, ${Math.round(stats.avgTokens).toLocaleString().padStart(6)} avg tokens, ${stats.successRate.toFixed(1).padStart(5)}% success`);
			}
		}

		console.log();
		console.log(chalk.dim(`Run with --export to save detailed metrics to JSON`));
		console.log(chalk.dim(`Run with --days 0 to see all-time analytics`));
	});

// Metrics command - manage metrics collection
program
	.command("metrics")
	.description("Manage efficiency metrics")
	.option("--clear", "Clear all quest metrics (keep raid history)")
	.option("--stats", "Show metrics collection statistics")
	.action((options: { clear?: boolean; stats?: boolean }) => {
		const persistence = new Persistence();

		if (options.clear) {
			persistence.clearQuestMetrics();
			console.log(chalk.yellow("✓ Cleared all quest metrics"));
			return;
		}

		if (options.stats) {
			const extendedStash = persistence.getExtendedStash();
			const questMetrics = persistence.getQuestMetrics();

			console.log(chalk.bold("Metrics Collection Statistics"));
			console.log(`  Metrics Version: ${extendedStash.metricsVersion}`);
			console.log(`  Collection Started: ${chalk.gray(new Date(extendedStash.metricsStartedAt).toLocaleString())}`);
			console.log(`  Total Quest Metrics: ${questMetrics.length}`);

			if (questMetrics.length > 0) {
				const oldest = new Date(Math.min(...questMetrics.map(m => new Date(m.startedAt).getTime())));
				const newest = new Date(Math.max(...questMetrics.map(m => new Date(m.completedAt).getTime())));
				console.log(`  Date Range: ${chalk.gray(oldest.toLocaleDateString())} to ${chalk.gray(newest.toLocaleDateString())}`);

				const totalTokens = questMetrics.reduce((sum, m) => sum + m.tokenUsage.totalTokens, 0);
				const successful = questMetrics.filter(m => m.success).length;
				console.log(`  Total Tokens Tracked: ${chalk.cyan(totalTokens.toLocaleString())}`);
				console.log(`  Success Rate: ${chalk.green((successful / questMetrics.length * 100).toFixed(1) + "%")}`);
			}

			console.log(`  Last Updated: ${chalk.gray(new Date(extendedStash.lastUpdated).toLocaleString())}`);
			return;
		}

		// Default: show brief stats and usage
		const questMetrics = persistence.getQuestMetrics();
		console.log(chalk.bold("Efficiency Metrics"));
		console.log(`  Quest metrics tracked: ${questMetrics.length}`);

		if (questMetrics.length > 0) {
			const recentMetrics = questMetrics.filter(m => {
				const completedAt = new Date(m.completedAt);
				const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
				return completedAt >= dayAgo;
			});
			console.log(`  Quests in last 24h: ${recentMetrics.length}`);
		}

		console.log();
		console.log("Commands:");
		console.log(`  ${chalk.cyan("undercity analytics")}       Show efficiency analytics`);
		console.log(`  ${chalk.cyan("undercity metrics --stats")} Show collection statistics`);
		console.log(`  ${chalk.cyan("undercity metrics --clear")} Clear all metrics`);
	});

// Parse and run
program.parse();
