/**
 * Handlers for analysis commands
 */
import chalk from "chalk";
import { type FailureReason, getLastGrindSummary } from "../grind-events.js";
import { loadLiveMetrics } from "../live-metrics.js";
import { getPhaseTimingSummary, type PhaseTimingSummary } from "../metrics.js";

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
	escalations: {
		total: number;
		tasksWithEscalation: number;
		escalationRate: string;
		byPath: Record<string, number>;
	};
	recommendations: string[];
	sessionMetrics?: {
		totalQueries: number;
		successfulQueries: number;
		rateLimited: number;
		modelBreakdown: Record<string, { input: number; output: number; cost: number }>;
	};
	humanInput?: {
		tasksNeedingInput: number;
		tasksWithGuidance: number;
		tasksNeedingGuidance: number;
	};
	phaseTiming?: PhaseTimingSummary;
}

/**
 * Generate insights from failure breakdown and escalation data
 */
function generateRecommendations(
	breakdown: Record<FailureReason, number>,
	successRate: number,
	escalationRate?: number,
	modelUsage?: Record<string, number>,
): string[] {
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

	// Escalation rate insights (only if there were escalations)
	if (escalationRate !== undefined && escalationRate > 0) {
		if (escalationRate > 30) {
			recommendations.push(
				`High escalation rate (${escalationRate.toFixed(1)}%). Consider:`,
				"  - Improving task context/planning to help sonnet succeed",
				"  - Breaking complex tasks into smaller pieces",
			);
		}
	}

	// Model usage insights
	if (modelUsage) {
		const opusCount = modelUsage.opus ?? 0;
		const sonnetCount = modelUsage.sonnet ?? 0;
		const total = opusCount + sonnetCount;
		if (total > 0 && opusCount === total) {
			recommendations.push("All tasks used opus (via learned routing or direct assignment).");
		} else if (total > 0 && sonnetCount === total && escalationRate === 0) {
			recommendations.push("All tasks completed with sonnet - no escalations needed.");
		}
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
 * Brief lessons learned summary for grind startup
 * Returns null if no previous grind data available
 */
export interface LessonsLearned {
	hasData: boolean;
	successRate: string;
	tasksCompleted: number;
	tasksFailed: number;
	topFailures: Array<{ reason: string; count: number }>;
	topRecommendation: string;
}

export function getLessonsLearned(): LessonsLearned | null {
	const summary = getLastGrindSummary();

	if (!summary) {
		return null;
	}

	const total = summary.ok + summary.fail;
	if (total === 0) {
		return null;
	}

	const successRate = (summary.ok / total) * 100;

	// Get top 2 failures
	const topFailures = Object.entries(summary.failureBreakdown)
		.filter(([, count]) => count > 0)
		.sort(([, a], [, b]) => b - a)
		.slice(0, 2)
		.map(([reason, count]) => ({ reason, count }));

	// Generate a single top recommendation
	const escalationRate = total > 0 ? (summary.escalations.tasksWithEscalation / total) * 100 : 0;
	const recommendations = generateRecommendations(
		summary.failureBreakdown,
		successRate,
		escalationRate,
		summary.modelUsage?.byModel,
	);

	// Pick the first non-indented recommendation
	const topRecommendation = recommendations.find((r) => !r.startsWith("  ")) || "No specific issues detected.";

	return {
		hasData: true,
		successRate: `${successRate.toFixed(0)}%`,
		tasksCompleted: summary.ok,
		tasksFailed: summary.fail,
		topFailures,
		topRecommendation,
	};
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
	// Calculate escalation rate
	const escalationRate = total > 0 ? (summary.escalations.tasksWithEscalation / total) * 100 : 0;
	const recommendations = generateRecommendations(
		summary.failureBreakdown,
		successRate,
		escalationRate,
		summary.modelUsage?.byModel,
	);

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
		escalations: {
			total: summary.escalations.total,
			tasksWithEscalation: summary.escalations.tasksWithEscalation,
			escalationRate: `${escalationRate.toFixed(1)}%`,
			byPath: summary.escalations.byPath,
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

	// Add human input status
	try {
		const { getTasksNeedingInput, getHumanGuidance } = await import("../human-input-tracking.js");
		const tasksNeedingInput = getTasksNeedingInput();
		if (tasksNeedingInput.length > 0) {
			const withGuidance = tasksNeedingInput.filter((t) => getHumanGuidance(t.errorSignature) !== null).length;
			report.humanInput = {
				tasksNeedingInput: tasksNeedingInput.length,
				tasksWithGuidance: withGuidance,
				tasksNeedingGuidance: tasksNeedingInput.length - withGuidance,
			};
		}
	} catch {
		// Non-critical
	}

	// Add phase timing analysis
	try {
		const phaseTiming = await getPhaseTimingSummary();
		if (phaseTiming.tasksWithData > 0) {
			report.phaseTiming = phaseTiming;
		}
	} catch {
		// Non-critical
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
	console.log(`  Tasks: ${chalk.green(`${summary.ok} completed`)} / ${chalk.red(`${summary.fail} failed`)}`);
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

	// Show model usage stats
	if (summary.modelUsage && Object.keys(summary.modelUsage.byModel).length > 0) {
		console.log(chalk.bold("\nModel Usage"));
		for (const [model, count] of Object.entries(summary.modelUsage.byModel).sort(([, a], [, b]) => b - a)) {
			console.log(`  ${model}: ${count} task(s)`);
		}

		// Show escalation stats only if there were escalations
		if (report.escalations.total > 0) {
			console.log(chalk.bold("\nModel Escalations"));
			console.log(
				`  Tasks requiring escalation: ${report.escalations.tasksWithEscalation} (${report.escalations.escalationRate})`,
			);
			console.log(`  Total escalations: ${report.escalations.total}`);
			if (Object.keys(report.escalations.byPath).length > 0) {
				console.log("  By path:");
				for (const [path, count] of Object.entries(report.escalations.byPath).sort(([, a], [, b]) => b - a)) {
					console.log(`    ${path}: ${count}`);
				}
			}
		}
	}

	// Show phase timing breakdown
	if (report.phaseTiming && report.phaseTiming.tasksWithData > 0) {
		console.log(chalk.bold("\nPhase Timing"));
		console.log(`  Based on ${report.phaseTiming.tasksWithData} task(s)`);

		const phases = ["planning", "execution", "verification", "review", "merge"] as const;
		for (const phase of phases) {
			const ms = report.phaseTiming.averageMs[phase];
			const pct = report.phaseTiming.percentages[phase];
			if (ms !== undefined && pct !== undefined) {
				const label = phase.charAt(0).toUpperCase() + phase.slice(1);
				const timeStr = ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
				const bar = "=".repeat(Math.max(1, Math.round(pct / 5)));
				console.log(`  ${label.padEnd(12)} ${bar.padEnd(20)} ${timeStr.padStart(6)} (${pct}%)`);
			}
		}

		if (report.phaseTiming.avgTotalMs > 0) {
			const totalStr =
				report.phaseTiming.avgTotalMs >= 60000
					? `${(report.phaseTiming.avgTotalMs / 60000).toFixed(1)}m`
					: `${(report.phaseTiming.avgTotalMs / 1000).toFixed(1)}s`;
			console.log(`  ${"Total".padEnd(12)} ${"".padEnd(20)} ${totalStr.padStart(6)}`);
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

	// Note: Session metrics from live-metrics.json are cumulative across all sessions,
	// not specific to this grind. Omitting to avoid confusion.

	// Check for tasks needing human input
	try {
		const { getTasksNeedingInput, getHumanGuidance } = await import("../human-input-tracking.js");
		const tasksNeedingInput = getTasksNeedingInput();
		if (tasksNeedingInput.length > 0) {
			const withGuidance = tasksNeedingInput.filter((t) => getHumanGuidance(t.errorSignature) !== null).length;
			console.log(chalk.bold("\nHuman Input Needed"));
			console.log(`  ${tasksNeedingInput.length} task(s) blocked on recurring failures`);
			if (withGuidance > 0) {
				console.log(`  ${chalk.green(`${withGuidance} have guidance`)} - run: undercity human-input --retry`);
			}
			if (withGuidance < tasksNeedingInput.length) {
				console.log(
					`  ${chalk.yellow(`${tasksNeedingInput.length - withGuidance} need guidance`)} - run: undercity human-input`,
				);
			}
		}
	} catch {
		// Non-critical
	}

	console.log();
}
