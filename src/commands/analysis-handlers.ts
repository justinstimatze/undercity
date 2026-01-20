/**
 * Handlers for analysis commands
 */
import chalk from "chalk";
import { type FailureReason, getLastGrindSummary, readRecentEvents } from "../grind-events.js";
import { loadLiveMetrics } from "../live-metrics.js";

interface PostmortemOptions {
	last?: string;
	json?: boolean;
}

interface PostmortemReport {
	summary: {
		batchId?: string;
		duration?: string;
		tasksCompleted: number;
		tasksFailed: number;
		merged: number;
		successRate: string;
		tokens: number;
	};
	failureAnalysis: {
		breakdown: Record<FailureReason, number>;
		topIssues: string[];
	};
	recommendations: string[];
	sessionMetrics?: {
		totalQueries: number;
		successfulQueries: number;
		rateLimited: number;
		modelBreakdown: Record<string, { input: number; output: number; cost: number }>;
	};
}

/**
 * Generate insights from failure breakdown
 */
function generateRecommendations(breakdown: Record<FailureReason, number>, successRate: number): string[] {
	const recommendations: string[] = [];

	// Plan rejection issues
	if (breakdown.planning > 0) {
		recommendations.push(
			`${breakdown.planning} task(s) failed in planning phase. Consider:`,
			"  - Breaking vague tasks into specific subtasks before adding to board",
			"  - Adding file paths and concrete steps to task descriptions",
		);
	}

	// Test failures
	if (breakdown.verification_tests > 0) {
		recommendations.push(
			`${breakdown.verification_tests} task(s) failed test verification. Consider:`,
			"  - Test-writing tasks now route to sonnet minimum (implemented)",
			"  - Review test tasks for overly complex requirements",
		);
	}

	// No changes issues
	if (breakdown.no_changes > 0) {
		recommendations.push(
			`${breakdown.no_changes} task(s) made no changes. These may be:`,
			"  - Already complete (check git history)",
			"  - Too vague to act on (need decomposition)",
			"  - PM routing for vague tasks is now enabled",
		);
	}

	// Type check failures
	if (breakdown.verification_typecheck > 0) {
		recommendations.push(
			`${breakdown.verification_typecheck} task(s) failed type checks. Consider:`,
			"  - Ensuring relevant type definitions are in context",
			"  - Adding type constraint reminders to task descriptions",
		);
	}

	// Max attempts
	if (breakdown.max_attempts > 0) {
		recommendations.push(
			`${breakdown.max_attempts} task(s) exhausted all retry attempts. These likely need:`,
			"  - Human review to understand blockers",
			"  - Task decomposition into simpler subtasks",
		);
	}

	// General success rate advice
	if (successRate < 70) {
		recommendations.push(
			"Overall success rate is below 70%. Consider:",
			"  - Running `undercity triage` to analyze task board quality",
			"  - Decomposing complex tasks before grind",
		);
	} else if (successRate >= 90) {
		recommendations.push("Success rate is excellent (90%+). System is operating well.");
	}

	if (recommendations.length === 0) {
		recommendations.push("No specific issues detected. Grind completed successfully.");
	}

	return recommendations;
}

/**
 * Format duration from timestamps
 */
function formatDuration(startTs?: string, endTs?: string): string {
	if (!startTs) return "unknown";
	const start = new Date(startTs).getTime();
	const end = endTs ? new Date(endTs).getTime() : Date.now();
	const mins = Math.round((end - start) / 60000);
	if (mins < 60) return `${mins} minutes`;
	const hours = Math.floor(mins / 60);
	const remainingMins = mins % 60;
	return `${hours}h ${remainingMins}m`;
}

/**
 * Handle postmortem command
 */
export async function handlePostmortem(options: PostmortemOptions): Promise<void> {
	const summary = getLastGrindSummary();

	if (!summary) {
		console.log(chalk.yellow("No grind session found. Run `undercity grind` first."));
		return;
	}

	const total = summary.ok + summary.fail;
	const successRate = total > 0 ? (summary.ok / total) * 100 : 0;

	// Get top failure issues
	const topIssues: string[] = [];
	const sortedFailures = Object.entries(summary.failureBreakdown)
		.filter(([, count]) => count > 0)
		.sort(([, a], [, b]) => b - a);

	for (const [reason, count] of sortedFailures.slice(0, 3)) {
		topIssues.push(`${reason}: ${count}`);
	}

	// Generate recommendations
	const recommendations = generateRecommendations(summary.failureBreakdown, successRate);

	// Get session metrics if available
	const liveMetrics = loadLiveMetrics();

	const report: PostmortemReport = {
		summary: {
			batchId: summary.batchId,
			duration: formatDuration(summary.startedAt, summary.endedAt),
			tasksCompleted: summary.ok,
			tasksFailed: summary.fail,
			merged: summary.merged,
			successRate: `${successRate.toFixed(1)}%`,
			tokens: summary.tokens,
		},
		failureAnalysis: {
			breakdown: summary.failureBreakdown,
			topIssues,
		},
		recommendations,
	};

	if (liveMetrics) {
		report.sessionMetrics = {
			totalQueries: liveMetrics.queries?.total ?? 0,
			successfulQueries: liveMetrics.queries?.successful ?? 0,
			rateLimited: liveMetrics.queries?.rateLimited ?? 0,
			modelBreakdown: liveMetrics.byModel ?? {},
		};
	}

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}

	// Human-readable output
	console.log(chalk.bold.cyan("\n📊 Grind Post-Mortem\n"));

	console.log(chalk.bold("Summary"));
	console.log(`  Batch: ${chalk.dim(summary.batchId || "unknown")}`);
	console.log(`  Duration: ${report.summary.duration}`);
	console.log(`  Tasks: ${chalk.green(summary.ok + " completed")} / ${chalk.red(summary.fail + " failed")}`);
	console.log(`  Merged: ${summary.merged}`);
	console.log(
		`  Success Rate: ${successRate >= 80 ? chalk.green(report.summary.successRate) : chalk.yellow(report.summary.successRate)}`,
	);
	console.log(`  Tokens: ${summary.tokens.toLocaleString()}`);

	if (topIssues.length > 0) {
		console.log(chalk.bold("\nFailure Breakdown"));
		for (const [reason, count] of sortedFailures) {
			if (count > 0) {
				console.log(`  ${reason}: ${count}`);
			}
		}
	}

	console.log(chalk.bold("\nRecommendations"));
	for (const rec of recommendations) {
		if (rec.startsWith("  ")) {
			console.log(chalk.dim(rec));
		} else {
			console.log(`  ${rec}`);
		}
	}

	if (report.sessionMetrics && report.sessionMetrics.totalQueries > 0) {
		console.log(chalk.bold("\nSession Metrics"));
		console.log(`  Total Queries: ${report.sessionMetrics.totalQueries}`);
		console.log(`  Successful: ${report.sessionMetrics.successfulQueries}`);
		if (report.sessionMetrics.rateLimited > 0) {
			console.log(`  Rate Limited: ${chalk.yellow(report.sessionMetrics.rateLimited)}`);
		}
	}

	console.log();
}
