/**
 * Human Input Command Helpers
 *
 * Extracted helper functions for the human-input command to reduce complexity.
 */

import chalk from "chalk";

/**
 * Task needing human input
 */
export interface TaskNeedingInput {
	taskId: string;
	objective: string;
	category: string;
	sampleMessage: string;
	failedAttempts: number;
	modelUsed: string;
	errorSignature: string;
	previousGuidance?: string;
}

/**
 * Human guidance entry
 */
export interface HumanGuidance {
	guidance: string;
	timesUsed?: number;
	successful?: boolean;
}

/**
 * Human input stats
 */
export interface HumanInputStats {
	guidanceCount: number;
	successfulGuidance: number;
	tasksNeedingInput: number;
	topPatterns: Array<{
		signature: string;
		timesUsed: number;
		successful: boolean;
	}>;
}

/**
 * Context for human input operations
 */
export interface HumanInputContext {
	getTasksNeedingInput: () => TaskNeedingInput[];
	saveHumanGuidance: (signature: string, guidance: string) => string;
	clearNeedsHumanInput: (taskId: string) => void;
	getHumanInputStats: () => HumanInputStats;
	getHumanGuidance: (signature: string) => HumanGuidance | null;
	addTask: (
		objective: string,
		options: { priority: number; handoffContext: Record<string, unknown> },
	) => { id: string };
	isHuman: boolean;
}

/**
 * Handle --retry subcommand
 */
export async function handleRetrySubcommand(ctx: HumanInputContext): Promise<void> {
	const tasksNeedingInput = ctx.getTasksNeedingInput();

	// Filter to tasks that have guidance available
	const retryableTasks = tasksNeedingInput.filter((task) => {
		const guidance = ctx.getHumanGuidance(task.errorSignature);
		return guidance !== null;
	});

	if (retryableTasks.length === 0) {
		outputNoRetryableTasks(ctx.isHuman, tasksNeedingInput.length);
		return;
	}

	// Re-queue each task with guidance
	const requeued: string[] = [];
	for (const task of retryableTasks) {
		const guidance = ctx.getHumanGuidance(task.errorSignature);
		if (!guidance) continue;

		const newTask = ctx.addTask(task.objective, {
			priority: 50,
			handoffContext: {
				isRetry: true,
				humanGuidance: guidance.guidance,
				previousError: task.sampleMessage,
				previousAttempts: task.failedAttempts,
			},
		});

		ctx.clearNeedsHumanInput(task.taskId);
		requeued.push(newTask.id);
	}

	outputRetryResult(ctx.isHuman, requeued);
}

/**
 * Handle --stats subcommand
 */
export function handleStatsSubcommand(ctx: HumanInputContext): void {
	const stats = ctx.getHumanInputStats();

	if (ctx.isHuman) {
		console.log(chalk.bold("\n📊 Human Input Statistics\n"));
		console.log(`Guidance entries: ${stats.guidanceCount}`);
		console.log(`Successful guidance: ${stats.successfulGuidance}`);
		console.log(`Tasks needing input: ${stats.tasksNeedingInput}`);

		if (stats.topPatterns.length > 0) {
			console.log(chalk.dim("\nTop patterns with guidance:"));
			for (const pattern of stats.topPatterns) {
				const status = pattern.successful ? chalk.green("✓") : chalk.yellow("○");
				console.log(`  ${status} ${pattern.signature.substring(0, 60)}... (used ${pattern.timesUsed}x)`);
			}
		}
	} else {
		console.log(JSON.stringify(stats));
	}
}

/**
 * Handle --provide subcommand
 */
export function handleProvideSubcommand(
	ctx: HumanInputContext,
	signature: string,
	guidance: string | undefined,
): boolean {
	if (!guidance) {
		outputProvideError(ctx.isHuman);
		return false;
	}

	const id = ctx.saveHumanGuidance(signature, guidance);
	const tasksNeedingInput = ctx.getTasksNeedingInput();
	const matchingTasks = tasksNeedingInput.filter((task) => task.errorSignature === signature);

	outputProvideResult(ctx.isHuman, id, matchingTasks.length);
	return true;
}

/**
 * Handle --list subcommand (default)
 */
export function handleListSubcommand(ctx: HumanInputContext): void {
	const tasks = ctx.getTasksNeedingInput();

	if (tasks.length === 0) {
		outputNoTasksNeedingInput(ctx.isHuman);
		return;
	}

	if (ctx.isHuman) {
		outputTaskListHuman(tasks, ctx.getHumanGuidance);
	} else {
		outputTaskListJson(tasks, ctx.getHumanGuidance);
	}
}

// Output helpers

function outputNoRetryableTasks(isHuman: boolean, totalNeedingInput: number): void {
	if (isHuman) {
		if (totalNeedingInput === 0) {
			console.log(chalk.green("\n✓ No tasks need human input"));
		} else {
			console.log(chalk.yellow(`\n⚠ ${totalNeedingInput} task(s) need human input but none have guidance yet`));
			console.log(
				chalk.dim("Provide guidance first with: undercity human-input --provide <signature> --guidance '...'"),
			);
		}
	} else {
		console.log(JSON.stringify({ retried: 0, message: "No tasks with guidance to retry" }));
	}
}

function outputRetryResult(isHuman: boolean, requeued: string[]): void {
	if (isHuman) {
		console.log(chalk.green(`\n✓ Re-queued ${requeued.length} task(s) with human guidance`));
		console.log(chalk.dim("Run 'undercity grind' to process them"));
	} else {
		console.log(JSON.stringify({ retried: requeued.length, taskIds: requeued }));
	}
}

function outputProvideError(isHuman: boolean): void {
	if (isHuman) {
		console.log(chalk.red("Error: --guidance is required when using --provide"));
		console.log(chalk.dim("Usage: undercity human-input --provide <signature> --guidance 'Your guidance here'"));
	} else {
		console.log(JSON.stringify({ error: "--guidance is required when using --provide" }));
	}
	process.exitCode = 1;
}

function outputProvideResult(isHuman: boolean, id: string, matchingTaskCount: number): void {
	if (isHuman) {
		console.log(chalk.green(`\n✓ Guidance saved (${id})`));
		if (matchingTaskCount > 0) {
			console.log(chalk.cyan(`\n${matchingTaskCount} task(s) can now be retried with this guidance.`));
			console.log(chalk.dim("Run: undercity human-input --retry"));
		} else {
			console.log(chalk.dim("This guidance will be applied to future tasks with matching errors."));
		}
	} else {
		console.log(JSON.stringify({ success: true, id, matchingTasks: matchingTaskCount }));
	}
}

function outputNoTasksNeedingInput(isHuman: boolean): void {
	if (isHuman) {
		console.log(chalk.green("\n✓ No tasks currently need human input"));
	} else {
		console.log(JSON.stringify({ tasks: [] }));
	}
}

function outputTaskListHuman(
	tasks: TaskNeedingInput[],
	getHumanGuidance: (signature: string) => HumanGuidance | null,
): void {
	console.log(chalk.bold(`\n🧑 ${tasks.length} Task(s) Need Human Input\n`));

	let withGuidance = 0;
	for (const task of tasks) {
		const guidance = getHumanGuidance(task.errorSignature);
		const hasGuidance = guidance !== null;
		if (hasGuidance) withGuidance++;

		const statusIcon = hasGuidance ? chalk.green("✓") : chalk.yellow("○");
		console.log(`${statusIcon} ${chalk.yellow(`Task: ${task.taskId}`)}`);
		console.log(`  Objective: ${task.objective.substring(0, 80)}${task.objective.length > 80 ? "..." : ""}`);
		console.log(`  Category: ${task.category}`);
		console.log(`  Error: ${task.sampleMessage.substring(0, 100)}${task.sampleMessage.length > 100 ? "..." : ""}`);
		console.log(`  Failed attempts: ${task.failedAttempts} (last model: ${task.modelUsed})`);
		console.log(`  Signature: ${task.errorSignature.substring(0, 60)}...`);
		if (hasGuidance) {
			console.log(chalk.green(`  Has guidance: "${guidance.guidance.substring(0, 50)}..."`));
		} else if (task.previousGuidance) {
			console.log(chalk.dim(`  Previous guidance was tried but didn't help`));
		}
		console.log("");
	}

	// Show next steps
	if (withGuidance > 0) {
		console.log(chalk.cyan(`${withGuidance} task(s) have guidance and can be retried:`));
		console.log(chalk.dim("  undercity human-input --retry"));
		console.log("");
	}
	if (withGuidance < tasks.length) {
		console.log(chalk.dim("To provide guidance for remaining tasks:"));
		console.log(chalk.dim(`  undercity human-input --provide "<signature>" --guidance "Your guidance here"`));
	}
}

function outputTaskListJson(
	tasks: TaskNeedingInput[],
	getHumanGuidance: (signature: string) => HumanGuidance | null,
): void {
	const tasksWithStatus = tasks.map((task) => ({
		...task,
		hasGuidance: getHumanGuidance(task.errorSignature) !== null,
	}));
	console.log(JSON.stringify({ tasks: tasksWithStatus }));
}
