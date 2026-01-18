/**
 * Plan command handlers
 *
 * Commands for managing plan-task linkage
 */

import { homedir } from "node:os";
import { join } from "node:path";
import * as output from "../output.js";
import {
	findLinkedPlans,
	findPlanForTask,
	getPlanStatus,
	linkTasksToPlan,
	listPlans,
	markPlanComplete,
	parsePlanFile,
	resolvePlanPath,
	unlinkTasksFromPlan,
} from "../plan-link.js";

const DEFAULT_PLANS_DIR = join(homedir(), ".claude", "plans");

export interface PlanOptions {
	list?: boolean;
	status?: boolean;
	link?: string;
	unlink?: string;
	tasks?: string;
	complete?: boolean;
	project?: boolean;
}

/**
 * Handle plan commands
 */
export async function handlePlan(planPathOrName: string | undefined, options: PlanOptions): Promise<void> {
	const projectRoot = process.cwd();

	// List plans for this project
	if (options.list) {
		await handleListPlans(projectRoot, options.project);
		return;
	}

	// Show status of linked plans
	if (options.status && !planPathOrName) {
		await handlePlanStatus(projectRoot);
		return;
	}

	// Require plan path for other operations
	if (!planPathOrName) {
		output.error("Please specify a plan file or use --list to see available plans");
		return;
	}

	const planPath = resolvePlanPath(planPathOrName);
	const plan = parsePlanFile(planPath);

	if (!plan) {
		output.error(`Plan file not found: ${planPath}`);
		return;
	}

	// Link tasks to plan
	if (options.link) {
		const taskIds = options.link.split(",").map((t) => t.trim());
		await handleLinkTasks(planPath, taskIds, projectRoot);
		return;
	}

	// Unlink tasks from plan
	if (options.unlink) {
		const taskIds = options.unlink.split(",").map((t) => t.trim());
		await handleUnlinkTasks(planPath, taskIds);
		return;
	}

	// Mark plan as complete
	if (options.complete) {
		await handleMarkComplete(planPath);
		return;
	}

	// Show plan status by default
	if (options.status || !options.list) {
		await handleShowPlan(planPath);
		return;
	}
}

/**
 * List plans linked to this project
 */
async function handleListPlans(projectRoot: string, showAll?: boolean): Promise<void> {
	const plans = showAll
		? listPlans(DEFAULT_PLANS_DIR)
		: findLinkedPlans(projectRoot);

	if (plans.length === 0) {
		if (showAll) {
			output.info("No plan files found in ~/.claude/plans/");
		} else {
			output.info("No plans linked to this project");
			output.info("Use 'undercity plan <file> --link <task-ids>' to link tasks to a plan");
		}
		return;
	}

	output.header(showAll ? "All Plans" : "Plans for This Project");

	for (const plan of plans) {
		const statusIcon = plan.metadata?.status === "complete" ? "✓" : "○";
		const taskCount = plan.metadata?.tasks.length || 0;
		const title = plan.title || plan.name;

		output.info(`${statusIcon} ${title}`);
		output.debug(`    File: ${plan.name}`);
		if (taskCount > 0) {
			output.debug(`    Tasks: ${taskCount} linked`);
		}
		if (plan.metadata?.status) {
			output.debug(`    Status: ${plan.metadata.status}`);
		}
	}
}

/**
 * Show status of all linked plans with task completion
 */
async function handlePlanStatus(projectRoot: string): Promise<void> {
	const plans = findLinkedPlans(projectRoot);

	if (plans.length === 0) {
		output.info("No plans linked to this project");
		return;
	}

	output.header("Plan Status");

	for (const plan of plans) {
		const status = await getPlanStatus(plan.path);
		if (!status) continue;

		const title = plan.title || plan.name;
		const progressBar = makeProgressBar(status.completionPercent, 20);

		output.info(`${title}`);
		output.info(`  ${progressBar} ${status.completionPercent}%`);
		output.debug(
			`  Completed: ${status.completedTasks}/${status.totalTasks} | ` +
				`Pending: ${status.pendingTasks} | Failed: ${status.failedTasks}`,
		);
	}
}

/**
 * Link tasks to a plan
 */
async function handleLinkTasks(planPath: string, taskIds: string[], projectRoot: string): Promise<void> {
	// Validate task IDs exist
	const { getTaskById } = await import("../task.js");
	const validIds: string[] = [];
	const invalidIds: string[] = [];

	for (const id of taskIds) {
		const task = getTaskById(id);
		if (task) {
			validIds.push(id);
		} else {
			invalidIds.push(id);
		}
	}

	if (invalidIds.length > 0) {
		output.warning(`Task(s) not found: ${invalidIds.join(", ")}`);
	}

	if (validIds.length === 0) {
		output.error("No valid task IDs to link");
		return;
	}

	const success = linkTasksToPlan(planPath, validIds, projectRoot);

	if (success) {
		output.success(`Linked ${validIds.length} task(s) to plan`);
		for (const id of validIds) {
			output.debug(`  - ${id}`);
		}
	} else {
		output.error("Failed to update plan file");
	}
}

/**
 * Unlink tasks from a plan
 */
async function handleUnlinkTasks(planPath: string, taskIds: string[]): Promise<void> {
	const success = unlinkTasksFromPlan(planPath, taskIds);

	if (success) {
		output.success(`Unlinked ${taskIds.length} task(s) from plan`);
	} else {
		output.error("Failed to update plan file");
	}
}

/**
 * Mark a plan as complete
 */
async function handleMarkComplete(planPath: string): Promise<void> {
	const success = markPlanComplete(planPath);

	if (success) {
		output.success("Plan marked as complete");
	} else {
		output.error("Failed to update plan status");
	}
}

/**
 * Show details of a specific plan
 */
async function handleShowPlan(planPath: string): Promise<void> {
	const status = await getPlanStatus(planPath);

	if (!status) {
		// Plan exists but has no undercity metadata
		const plan = parsePlanFile(planPath);
		if (plan) {
			output.header(plan.title || plan.name);
			output.info("No undercity tasks linked to this plan");
			output.info("Use '--link <task-ids>' to link tasks");
		}
		return;
	}

	const { plan } = status;
	output.header(plan.title || plan.name);

	output.info(`Status: ${plan.metadata?.status || "unknown"}`);
	output.info(`Project: ${plan.metadata?.project || "not set"}`);

	if (status.totalTasks > 0) {
		const progressBar = makeProgressBar(status.completionPercent, 30);
		output.info(`Progress: ${progressBar} ${status.completionPercent}%`);
		output.info(
			`Tasks: ${status.completedTasks} complete, ${status.pendingTasks} pending, ${status.failedTasks} failed`,
		);

		// List linked tasks
		output.info("\nLinked Tasks:");
		const { getTaskById } = await import("../task.js");
		for (const taskId of plan.metadata?.tasks || []) {
			const task = getTaskById(taskId);
			if (task) {
				const icon = task.status === "complete" ? "✓" : task.status === "failed" ? "✗" : "○";
				output.info(`  ${icon} ${taskId}: ${task.objective.substring(0, 60)}...`);
			} else {
				output.info(`  ? ${taskId}: (not found)`);
			}
		}
	} else {
		output.info("No tasks linked");
	}
}

/**
 * Find which plan a task belongs to (for display in task list)
 */
export function getTaskPlanInfo(taskId: string): { planName: string; planPath: string } | null {
	const plan = findPlanForTask(taskId);
	if (!plan) return null;

	return {
		planName: plan.title || plan.name,
		planPath: plan.path,
	};
}

/**
 * Make a text progress bar
 */
function makeProgressBar(percent: number, width: number): string {
	const filled = Math.round((percent / 100) * width);
	const empty = width - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}
