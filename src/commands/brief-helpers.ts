/**
 * Brief Command Helpers
 *
 * Extracted helper functions for the brief command to reduce complexity.
 */

import chalk from "chalk";
import type { DecisionPoint } from "../decision-tracker.js";
import type { RateLimitTracker } from "../rate-limit.js";
import type { Task } from "../task.js";

/**
 * Live usage data from Claude Max
 */
export interface LiveUsage {
	fiveHourPercent?: number;
	weeklyPercent?: number;
	observedAt?: string;
	extraUsageEnabled?: boolean;
	extraUsageSpend?: string;
}

/**
 * Blocker information (matches BriefData["blockers"])
 */
export interface Blocker {
	type: "rate_limit" | "decision_required" | "merge_conflict" | "verification_failed";
	message: string;
	taskId?: string;
}

/**
 * Recommendation information
 */
export interface Recommendation {
	priority: "high" | "medium" | "low";
	action: string;
	reason: string;
}

/**
 * Task analysis results
 */
export interface TaskAnalysis {
	completedInPeriod: Task[];
	failedInPeriod: Task[];
	inProgressTasks: Task[];
	velocity: number;
	trend: "accelerating" | "steady" | "slowing" | "stalled";
	estimatedClearTime?: string;
}

/**
 * Analyze tasks within a time period
 */
export function analyzeTasksInPeriod(
	allTasks: Task[],
	periodStart: Date,
	hours: number,
	pendingCount: number,
): TaskAnalysis {
	const completedInPeriod = allTasks.filter(
		(t) => t.status === "complete" && t.completedAt && new Date(t.completedAt) >= periodStart,
	);
	const failedInPeriod = allTasks.filter(
		(t) => t.status === "failed" && t.completedAt && new Date(t.completedAt) >= periodStart,
	);
	const inProgressTasks = allTasks.filter((t) => t.status === "in_progress");

	// Calculate velocity (tasks per hour over the period)
	const tasksInPeriod = completedInPeriod.length + failedInPeriod.length;
	const velocity = hours > 0 ? tasksInPeriod / hours : 0;

	// Estimate clear time
	let estimatedClearTime: string | undefined;
	if (velocity > 0 && pendingCount > 0) {
		const hoursToComplete = pendingCount / velocity;
		const clearDate = new Date(Date.now() + hoursToComplete * 60 * 60 * 1000);
		estimatedClearTime = clearDate.toISOString();
	}

	// Determine trend
	let trend: TaskAnalysis["trend"] = "steady";
	if (velocity === 0 && inProgressTasks.length === 0) {
		trend = "stalled";
	} else if (failedInPeriod.length > completedInPeriod.length) {
		trend = "slowing";
	}

	return {
		completedInPeriod,
		failedInPeriod,
		inProgressTasks,
		velocity,
		trend,
		estimatedClearTime,
	};
}

/**
 * Build list of blockers preventing progress
 */
export function buildBlockers(
	tracker: RateLimitTracker,
	pendingDecisions: DecisionPoint[],
	liveUsage: LiveUsage | null,
): Blocker[] {
	const blockers: Blocker[] = [];

	// Rate limit blocker
	if (tracker.isPaused()) {
		const pauseState = tracker.getPauseState();
		blockers.push({
			type: "rate_limit",
			message: `Rate limited until ${pauseState.resumeAt ? new Date(pauseState.resumeAt).toLocaleTimeString() : "unknown"}`,
		});
	}

	// Decision blockers
	if (pendingDecisions.length > 0) {
		blockers.push({
			type: "decision_required",
			message: `${pendingDecisions.length} decision(s) awaiting input`,
		});
	}

	// Claude Max weekly budget blocker
	if (liveUsage?.weeklyPercent !== undefined && liveUsage.weeklyPercent >= 95) {
		blockers.push({
			type: "rate_limit",
			message: `Weekly Claude Max budget nearly exhausted (${liveUsage.weeklyPercent}%)`,
		});
	}

	return blockers;
}

/**
 * Build list of recommendations
 */
export function buildRecommendations(
	analysis: TaskAnalysis,
	pendingDecisions: DecisionPoint[],
	liveUsage: LiveUsage | null,
	usage: { percentages: { fiveHour: number } },
	pendingCount: number,
	hours: number,
): Recommendation[] {
	const recommendations: Recommendation[] = [];

	// Recommend addressing failures if many
	if (analysis.failedInPeriod.length >= 3) {
		recommendations.push({
			priority: "high",
			action: "Review failed tasks and consider manual intervention or task revision",
			reason: `${analysis.failedInPeriod.length} tasks failed in the last ${hours}h`,
		});
	}

	// Recommend handling decisions
	if (pendingDecisions.length > 0) {
		recommendations.push({
			priority: pendingDecisions.length > 5 ? "high" : "medium",
			action: "Run 'undercity decide' to handle pending decisions",
			reason: `${pendingDecisions.length} decision(s) blocking progress`,
		});
	}

	// Recommend rate limit awareness (prefer live usage if available)
	if (liveUsage?.weeklyPercent !== undefined && liveUsage.weeklyPercent >= 80) {
		recommendations.push({
			priority: "high",
			action: "Weekly rate limit critical - pause or reduce task volume",
			reason: `${liveUsage.weeklyPercent}% of weekly Claude Max budget used`,
		});
	} else if (liveUsage?.fiveHourPercent !== undefined && liveUsage.fiveHourPercent >= 70) {
		recommendations.push({
			priority: "medium",
			action: "Consider pacing - session budget getting low",
			reason: `${liveUsage.fiveHourPercent}% of 5-hour Claude Max budget used`,
		});
	} else if (usage.percentages.fiveHour >= 0.7) {
		recommendations.push({
			priority: "medium",
			action: "Consider pacing - rate limit budget is getting low",
			reason: `${Math.round(usage.percentages.fiveHour * 100)}% of 5-hour budget used (local tracking)`,
		});
	}

	// Recommend adding tasks if queue is empty
	if (pendingCount === 0 && analysis.completedInPeriod.length > 0) {
		recommendations.push({
			priority: "low",
			action: "Add more tasks to the queue",
			reason: "Queue is empty - Undercity is idle",
		});
	}

	return recommendations;
}

/**
 * Brief data structure for output
 */
export interface BriefData {
	timestamp: string;
	period: {
		hours: number;
		from: string;
		to: string;
	};
	summary: {
		tasksCompleted: number;
		tasksFailed: number;
		tasksInProgress: number;
		tasksPending: number;
		tokensUsed: number;
		estimatedCost: number;
	};
	accomplishments: Array<{
		taskId: string;
		objective: string;
		completedAt: string;
		filesModified?: number;
	}>;
	failures: Array<{
		taskId: string;
		objective: string;
		error: string;
		failedAt: string;
	}>;
	inProgress: Array<{
		taskId: string;
		objective: string;
		startedAt?: string;
		elapsed?: string;
	}>;
	blockers: Blocker[];
	trajectory: {
		velocity: number;
		estimatedClearTime?: string;
		trend: "accelerating" | "steady" | "slowing" | "stalled";
	};
	recommendations: Recommendation[];
}

/**
 * Format brief data for human-readable output
 */
export function formatBriefHuman(briefData: BriefData, analysis: TaskAnalysis, pendingCount: number): void {
	const { completedInPeriod, failedInPeriod } = analysis;

	console.log(chalk.bold.cyan(`\n📋 Undercity Brief (Last ${briefData.period.hours}h)\n`));

	// Summary line
	if (completedInPeriod.length > 0 || failedInPeriod.length > 0) {
		console.log(
			chalk.bold(
				`Completed ${completedInPeriod.length} task(s), ${failedInPeriod.length} failed, ${pendingCount} remaining`,
			),
		);
	} else {
		console.log(chalk.dim("No tasks completed in this period"));
	}
	console.log();

	// Accomplishments
	if (completedInPeriod.length > 0) {
		console.log(chalk.green.bold("Accomplishments:"));
		for (const task of completedInPeriod.slice(0, 5)) {
			console.log(chalk.green(`  ✓ ${task.objective.substring(0, 60)}${task.objective.length > 60 ? "..." : ""}`));
		}
		if (completedInPeriod.length > 5) {
			console.log(chalk.dim(`  ... and ${completedInPeriod.length - 5} more`));
		}
		console.log();
	}

	// Failures
	if (failedInPeriod.length > 0) {
		console.log(chalk.red.bold("Failures:"));
		for (const task of failedInPeriod.slice(0, 3)) {
			console.log(chalk.red(`  ✗ ${task.objective.substring(0, 50)}...`));
			console.log(chalk.dim(`    ${task.error?.substring(0, 60) || "Unknown error"}`));
		}
		if (failedInPeriod.length > 3) {
			console.log(chalk.dim(`  ... and ${failedInPeriod.length - 3} more`));
		}
		console.log();
	}

	// Blockers
	if (briefData.blockers.length > 0) {
		console.log(chalk.yellow.bold("Blockers:"));
		for (const blocker of briefData.blockers) {
			console.log(chalk.yellow(`  ⚠ ${blocker.message}`));
		}
		console.log();
	}

	// Trajectory
	console.log(chalk.bold("Trajectory:"));
	console.log(`  Velocity: ${briefData.trajectory.velocity.toFixed(1)} tasks/hour`);
	console.log(`  Trend: ${briefData.trajectory.trend}`);
	if (briefData.trajectory.estimatedClearTime) {
		console.log(`  Queue clear: ~${new Date(briefData.trajectory.estimatedClearTime).toLocaleString()}`);
	}
	console.log();

	// Recommendations
	if (briefData.recommendations.length > 0) {
		console.log(chalk.bold("Recommendations:"));
		for (const rec of briefData.recommendations) {
			const icon = rec.priority === "high" ? "🔴" : rec.priority === "medium" ? "🟡" : "🟢";
			console.log(`  ${icon} ${rec.action}`);
			console.log(chalk.dim(`     ${rec.reason}`));
		}
	}
}
