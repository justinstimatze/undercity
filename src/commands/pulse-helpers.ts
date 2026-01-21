/**
 * Pulse Command Helpers
 *
 * Extracted helper functions for the pulse command to reduce complexity.
 */

import chalk from "chalk";
import type { DecisionPoint } from "../decision-tracker.js";
import type { RateLimitTracker } from "../rate-limit.js";
import type { Task } from "../task.js";

/**
 * Active worker information
 */
export interface ActiveWorker {
	taskId: string;
	objective: string;
	elapsed: string;
	elapsedMs: number;
	worktreePath: string;
}

/**
 * Attention item requiring user action
 */
export interface AttentionItem {
	type: "decision" | "rate_limit" | "failure";
	message: string;
	id?: string;
}

/**
 * Pacing information for sustainable task execution
 */
export interface PacingInfo {
	tokenBudget: number;
	tokensUsed: number;
	remaining: number;
	percentUsed: number;
	queueSize: number;
	estimatedTokensPerTask: number;
	sustainablePaceTasksPerHour: number;
}

/**
 * Worktree information from persistence
 */
interface WorktreeInfo {
	sessionId: string;
	path: string;
	createdAt: Date;
}

/**
 * Build list of active workers with elapsed time
 */
export function buildActiveWorkersList(activeWorktrees: WorktreeInfo[], allTasks: Task[]): ActiveWorker[] {
	const now = Date.now();
	return activeWorktrees.map((w) => {
		const task = allTasks.find((t) => t.sessionId === w.sessionId);
		const elapsedMs = now - w.createdAt.getTime();
		const elapsedMin = Math.floor(elapsedMs / 60000);
		return {
			taskId: w.sessionId.split("-").slice(0, 2).join("-"),
			objective: task?.objective?.substring(0, 50) || "Unknown task",
			elapsed: `${elapsedMin}m`,
			elapsedMs,
			worktreePath: w.path,
		};
	});
}

/**
 * Build attention items requiring user action
 */
export function buildAttentionItems(
	humanRequiredDecisions: DecisionPoint[],
	pendingDecisions: DecisionPoint[],
	tracker: RateLimitTracker,
	usage: { percentages: { fiveHour: number } },
	recentFailures: Task[],
): AttentionItem[] {
	const attention: AttentionItem[] = [];

	// Add human-required decisions
	for (const dec of humanRequiredDecisions.slice(0, 3)) {
		attention.push({
			type: "decision",
			message: dec.question.substring(0, 60),
			id: dec.id,
		});
	}

	// Add PM-decidable decisions if there are many
	if (pendingDecisions.length > 3) {
		attention.push({
			type: "decision",
			message: `${pendingDecisions.length} pending decisions`,
		});
	}

	// Add rate limit warning
	if (tracker.isPaused()) {
		const pauseState = tracker.getPauseState();
		const resumeTime = pauseState.resumeAt ? new Date(pauseState.resumeAt).toLocaleTimeString() : "unknown";
		attention.push({
			type: "rate_limit",
			message: `Rate limited - resume at ${resumeTime}`,
		});
	} else if (usage.percentages.fiveHour >= 0.8) {
		attention.push({
			type: "rate_limit",
			message: `Rate limit warning: ${Math.round(usage.percentages.fiveHour * 100)}% of 5hr budget used`,
		});
	}

	// Add recent failures
	if (recentFailures.length > 0) {
		attention.push({
			type: "failure",
			message: `${recentFailures.length} task(s) failed in last hour`,
		});
	}

	return attention;
}

/**
 * Pulse data structure for output
 */
export interface PulseData {
	timestamp: string;
	active: ActiveWorker[];
	queue: {
		pending: number;
		inProgress: number;
		completed: number;
		failed: number;
		blocked: number;
	};
	health: {
		rateLimit: {
			fiveHourPercent: number;
			weeklyPercent: number;
			isPaused: boolean;
			resumeAt?: string;
		};
		liveUsage?: {
			fiveHourPercent?: number;
			weeklyPercent?: number;
			observedAt?: string;
			extraUsageEnabled?: boolean;
			extraUsageSpend?: string;
		};
		recentActivity: {
			completedLastHour: number;
			failedLastHour: number;
		};
	};
	pacing: PacingInfo;
	attention: AttentionItem[];
}

/**
 * Format pulse data for human-readable output
 */
export function formatPulseHuman(
	pulseData: PulseData,
	allTasks: Task[],
	usage: { percentages: { fiveHour: number } },
): void {
	console.log(chalk.bold.cyan("\n⚡ Undercity Pulse\n"));

	// Active workers section
	if (pulseData.active.length > 0) {
		console.log(chalk.bold(`ACTIVE (${pulseData.active.length} workers)`));
		for (const w of pulseData.active) {
			console.log(
				chalk.green(`  🔄 ${w.taskId}: "${w.objective}${w.objective.length >= 50 ? "..." : ""}" (${w.elapsed})`),
			);
		}
	} else {
		console.log(chalk.bold("ACTIVE"));
		console.log(chalk.dim("  No workers running"));
	}
	console.log();

	// Queue section
	console.log(chalk.bold(`QUEUE (${pulseData.queue.pending} pending)`));
	const queueTasks = allTasks.filter((t) => t.status === "pending" && !t.isDecomposed).slice(0, 3);
	for (const t of queueTasks) {
		const priority = t.priority !== undefined ? `#${t.priority}` : "";
		console.log(chalk.dim(`  ${priority} "${t.objective.substring(0, 50)}${t.objective.length >= 50 ? "..." : ""}"`));
	}
	if (pulseData.queue.pending > 3) {
		console.log(chalk.dim(`  ... and ${pulseData.queue.pending - 3} more`));
	}
	console.log();

	// Health section
	console.log(chalk.bold("HEALTH"));
	const liveUsage = pulseData.health.liveUsage;
	if (liveUsage?.fiveHourPercent !== undefined) {
		const fiveHrColor =
			liveUsage.fiveHourPercent >= 80 ? chalk.red : liveUsage.fiveHourPercent >= 50 ? chalk.yellow : chalk.green;
		console.log(`  Claude Max: ${fiveHrColor(`${liveUsage.fiveHourPercent}%`)} of 5hr budget`);
		if (liveUsage.weeklyPercent !== undefined) {
			console.log(`  Weekly: ${liveUsage.weeklyPercent}%`);
		}
	} else {
		const fiveHrColor =
			usage.percentages.fiveHour >= 0.8 ? chalk.red : usage.percentages.fiveHour >= 0.5 ? chalk.yellow : chalk.green;
		console.log(
			`  Rate limit: ${fiveHrColor(`${Math.round(usage.percentages.fiveHour * 100)}%`)} used (local tracking)`,
		);
	}
	console.log(
		`  Last hour: ${pulseData.health.recentActivity.completedLastHour} completed, ${pulseData.health.recentActivity.failedLastHour} failed`,
	);
	console.log();

	// Pacing section
	console.log(chalk.bold("PACING"));
	console.log(`  Budget: ${(pulseData.pacing.tokenBudget / 1000000).toFixed(1)}M tokens/5hr window`);
	console.log(`  Used: ${(pulseData.pacing.tokensUsed / 1000).toFixed(0)}K (${pulseData.pacing.percentUsed}%)`);
	console.log(`  Sustainable pace: ~${pulseData.pacing.sustainablePaceTasksPerHour} tasks/hour to last 5 hours`);
	console.log();

	// Attention section
	if (pulseData.attention.length > 0) {
		console.log(chalk.bold.yellow(`ATTENTION (${pulseData.attention.length})`));
		for (const item of pulseData.attention) {
			const icon = item.type === "decision" ? "⚠️" : item.type === "rate_limit" ? "🚨" : "❌";
			console.log(chalk.yellow(`  ${icon} ${item.message}`));
		}
		console.log();
	}

	console.log(chalk.dim("Run 'undercity brief' for detailed report, 'undercity decide' to handle pending decisions."));
}

/**
 * Calculate pacing information for sustainable task execution
 */
export function calculatePacing(
	liveUsage: { fiveHourPercent?: number } | null,
	usage: {
		percentages: { fiveHour: number };
		current: { last5HoursSonnet: number };
		modelBreakdown: Record<string, { totalTasks: number; sonnetEquivalentTokens: number }>;
	},
	config: { maxTokensPer5Hours: number },
	pendingCount: number,
): PacingInfo {
	const tokenBudget = config.maxTokensPer5Hours;

	// Use live percentages if available, otherwise fall back to local tracking
	const fiveHourPercentUsed =
		liveUsage?.fiveHourPercent ?? Math.round((usage.current.last5HoursSonnet / tokenBudget) * 100);
	const tokensUsed = Math.round((fiveHourPercentUsed / 100) * tokenBudget);
	const remaining = tokenBudget - tokensUsed;

	// Estimate tokens per task from historical data (default 50k if no data)
	const totalTasks = Object.values(usage.modelBreakdown).reduce((sum, m) => sum + m.totalTasks, 0);
	const totalTokens = Object.values(usage.modelBreakdown).reduce((sum, m) => sum + m.sonnetEquivalentTokens, 0);
	const estimatedTokensPerTask = totalTasks > 0 ? Math.round(totalTokens / totalTasks) : 50000;

	// Calculate sustainable pace (tasks per hour to last 5 hours)
	const sustainablePace = estimatedTokensPerTask > 0 ? Math.floor(remaining / estimatedTokensPerTask / 5) : 0;

	return {
		tokenBudget,
		tokensUsed,
		remaining,
		percentUsed: Math.round((tokensUsed / tokenBudget) * 100),
		queueSize: pendingCount,
		estimatedTokensPerTask,
		sustainablePaceTasksPerHour: sustainablePace,
	};
}
