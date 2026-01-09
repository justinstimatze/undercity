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
import {
	addGoal,
	addGoals,
	clearCompleted,
	getAllItems,
	getBacklogSummary,
	getNextGoal,
	markComplete,
	markFailed,
	markInProgress,
} from "./backlog.js";
import { Persistence } from "./persistence.js";
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
	.action(
		async (
			goal: string | undefined,
			options: { autoApprove?: boolean; yes?: boolean; verbose?: boolean; stream?: boolean; maxSquad?: string },
		) => {
			const fullAuto = options.yes || false;
			const orchestrator = new RaidOrchestrator({
				autoApprove: options.autoApprove || fullAuto,
				verbose: options.verbose || fullAuto,
				streamOutput: options.stream ?? options.verbose ?? fullAuto,
				maxSquadSize: Number.parseInt(options.maxSquad || "5", 10),
				autoCommit: fullAuto,
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
				if (fullAuto) {
					console.log(chalk.dim("  Mode: Full auto (will complete without intervention)"));
				}
				console.log();

				try {
					const raid = await orchestrator.start(goal);
					const finalRaid = orchestrator.getCurrentRaid();

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
		// Note: In real implementation, we'd need to persist the merge queue
		console.log(chalk.gray("Merge queue is empty"));
		console.log("Branches are merged serially: rebase → test → merge");
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
				console.log(`  ${chalk.cyan("⚡")} ${item.goal.substring(0, 60)}${item.goal.length > 60 ? "..." : ""}`);
			}
			console.log();
		}

		if (pending.length > 0) {
			console.log(chalk.bold("Pending"));
			for (const item of pending.slice(0, 10)) {
				console.log(`  ${chalk.gray("○")} ${item.goal.substring(0, 60)}${item.goal.length > 60 ? "..." : ""}`);
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

// Plan command - execute a plan file intelligently
program
	.command("plan <file>")
	.description("Execute a plan file with good judgment (uses planner to determine next steps)")
	.option("-s, --stream", "Stream agent activity")
	.option("-c, --continuous", "Keep executing until plan is complete")
	.option("-n, --steps <n>", "Max steps to execute (default: unlimited in continuous mode)")
	.action(async (file: string, options: { stream?: boolean; continuous?: boolean; steps?: string }) => {
		try {
			const planContent = readFileSync(file, "utf-8");
			const maxSteps = options.steps ? Number.parseInt(options.steps, 10) : options.continuous ? 100 : 1;

			console.log(chalk.cyan("Loading plan file..."));
			console.log(chalk.dim(`  File: ${file}`));
			if (options.continuous) {
				console.log(chalk.dim(`  Mode: Continuous (up to ${maxSteps} steps)`));
			}
			console.log();

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

				// Build context-aware goal
				const progressContext =
					step > 1
						? `\n\nPREVIOUS STEP RESULT:\n${lastResult.substring(0, 2000)}\n\nContinue with the next logical step.`
						: "";

				const goal = `Execute this implementation plan with good judgment. Read the plan, determine the next logical step that hasn't been done yet, and implement it. If something is already complete, skip it. If the plan is fully complete, respond with "PLAN COMPLETE".

PLAN FILE CONTENTS:
${planContent.substring(0, 12000)}${planContent.length > 12000 ? "\n\n[Plan truncated]" : ""}${progressContext}`;

				console.log(chalk.cyan(`\n━━━ Step ${step} ━━━`));

				const raid = await orchestrator.start(goal);
				const finalRaid = orchestrator.getCurrentRaid();

				// Get the result for context
				const tasks = orchestrator.getStatus().tasks;
				const fabricatorTask = tasks.find((t) => t.type === "fabricator");
				lastResult = fabricatorTask?.result || "";

				// Check if plan is complete
				if (lastResult.toLowerCase().includes("plan complete")) {
					console.log(chalk.green("\n✓ Plan execution complete!"));
					break;
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
			console.log(chalk.dim(`  Will process ${maxCount} goal(s) then stop`));
		} else {
			console.log(chalk.dim("  Will process all pending goals"));
		}
		console.log();

		while (true) {
			const nextGoal = getNextGoal();

			if (!nextGoal) {
				console.log(chalk.green("\n✓ Backlog empty - all goals processed"));
				break;
			}

			if (maxCount > 0 && processed >= maxCount) {
				console.log(chalk.yellow(`\n✓ Processed ${maxCount} goal(s) - stopping`));
				break;
			}

			console.log(chalk.cyan(`\n━━━ Goal ${processed + 1}: ${nextGoal.goal.substring(0, 50)}... ━━━`));

			const orchestrator = new RaidOrchestrator({
				autoApprove: true,
				autoCommit: true,
				verbose: true,
				streamOutput: options.stream,
			});

			markInProgress(nextGoal.id, "");

			try {
				const raid = await orchestrator.start(nextGoal.goal);
				markInProgress(nextGoal.id, raid.id);

				const finalRaid = orchestrator.getCurrentRaid();

				if (finalRaid?.status === "complete") {
					markComplete(nextGoal.id);
					console.log(chalk.green(`✓ Goal complete: ${nextGoal.goal.substring(0, 40)}...`));
				} else if (finalRaid?.status === "failed") {
					markFailed(nextGoal.id, "Raid failed");
					console.log(chalk.red(`✗ Goal failed: ${nextGoal.goal.substring(0, 40)}...`));
				} else {
					// Raid didn't fully complete (maybe awaiting something)
					markComplete(nextGoal.id); // Consider it done for now
					console.log(chalk.yellow(`⚠ Goal processed: ${nextGoal.goal.substring(0, 40)}...`));
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

// Parse and run
program.parse();
