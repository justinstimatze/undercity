/**
 * Analysis and metrics commands
 *
 * Heavy imports (Orchestrator, metrics-dashboard) are lazy-loaded in
 * action handlers to avoid penalizing startup for unrelated commands.
 */
import chalk from "chalk";
import { analysisLogger } from "../logger.js";
import type { CommandModule } from "./types.js";

export const analysisCommands: CommandModule = {
	register(program) {
		// Metrics command
		program
			.command("metrics")
			.description("Show performance metrics and analytics")
			.action(async () => {
				const { getMetricsSummary } = await import("../metrics.js");
				const metrics = await getMetricsSummary();

				console.log(chalk.bold("Performance Metrics"));
				console.log(`Total Tasks: ${metrics.totalTasks}`);
				console.log(`Success Rate: ${(metrics.successRate * 100).toFixed(2)}%`);
				console.log(`Average Tokens Used: ${metrics.avgTokens.toFixed(2)}`);
				console.log(`Average Time per Task: ${(metrics.avgTimeTakenMs / 1000).toFixed(2)}s`);
				console.log("\nModel Distribution:");
				for (const [model, count] of Object.entries(metrics.modelDistribution)) {
					console.log(
						`  ${model}: ${count as number} tasks (${(((count as number) / metrics.totalTasks) * 100).toFixed(2)}%)`,
					);
				}
				console.log(`\nEscalation Rate: ${(metrics.escalationRate * 100).toFixed(2)}%`);
			});

		// Feedback insights command - uses the feedback metrics reader
		program
			.command("insights")
			.description("Analyze historical metrics and get routing recommendations")
			.option("--json", "Output as JSON for programmatic use")
			.option("--path <file>", "Path to metrics.jsonl file")
			.option("--since <date>", "Only analyze records after this date (ISO format or 'today')")
			.option("--last <n>", "Only analyze the last N records")
			.action(async (options) => {
				const { getMetricsAnalysis, formatAnalysisSummary } = await import("../feedback-metrics.js");

				// Build options
				const analysisOptions: { path?: string; since?: Date; limit?: number } = {};
				if (options.path) analysisOptions.path = options.path;
				if (options.since) {
					if (options.since === "today") {
						const today = new Date();
						today.setHours(0, 0, 0, 0);
						analysisOptions.since = today;
					} else {
						analysisOptions.since = new Date(options.since);
					}
				}
				if (options.last) analysisOptions.limit = parseInt(options.last, 10);

				const analysis = getMetricsAnalysis(analysisOptions);

				if (options.json) {
					console.log(JSON.stringify(analysis, null, 2));
					return;
				}

				// Human-readable output
				console.log(chalk.bold("\n📊 Feedback Metrics Analysis\n"));
				console.log(formatAnalysisSummary(analysis));

				// Highlight key recommendations
				if (analysis.recommendations.length > 0) {
					console.log(chalk.cyan("\n💡 Key Insights:\n"));
					for (const rec of analysis.recommendations) {
						console.log(chalk.yellow(`  → ${rec}`));
					}
				}

				// Show model-complexity matrix for routing decisions
				if (analysis.totalTasks >= 10) {
					console.log(chalk.cyan("\n📈 Success Rate Matrix (model × complexity):\n"));
					const complexities = ["trivial", "simple", "standard", "complex", "critical"] as const;
					const models = ["haiku", "sonnet", "opus"] as const;

					// Header
					process.stdout.write("           ");
					for (const c of complexities) {
						process.stdout.write(c.padEnd(10));
					}
					console.log();

					// Rows
					for (const m of models) {
						process.stdout.write(`  ${m.padEnd(8)} `);
						for (const c of complexities) {
							const key = `${m}:${c}`;
							const stats = analysis.byModelAndComplexity[key];
							if (stats && stats.total >= 2) {
								const rate = (stats.rate * 100).toFixed(0);
								const color = stats.rate >= 0.7 ? chalk.green : stats.rate >= 0.5 ? chalk.yellow : chalk.red;
								process.stdout.write(color(`${rate}%`.padEnd(10)));
							} else {
								process.stdout.write(chalk.dim("-".padEnd(10)));
							}
						}
						console.log();
					}
				}
			});

		// Benchmark command
		program
			.command("benchmark")
			.description("Run a standard set of performance benchmark tasks")
			.action(async () => {
				try {
					await runBenchmark();
				} catch (error) {
					analysisLogger.error({ err: error }, "Benchmark error");
					process.exit(1);
				}
			});

		// Metrics dashboard command - comprehensive metrics TUI
		program
			.command("metrics-dashboard")
			.alias("md")
			.description("Launch interactive metrics dashboard with token usage, success rates, and cost tracking")
			.action(async () => {
				const { launchMetricsDashboard } = await import("../metrics-dashboard.js");
				launchMetricsDashboard();
			});

		// Operational learning patterns command
		program
			.command("patterns")
			.description("Show operational learning patterns (task-file correlations, co-modifications, error fixes)")
			.action(async () => {
				const { getTaskFileStats } = await import("../task-file-patterns.js");
				const { getErrorFixStats } = await import("../error-fix-patterns.js");
				const { getKnowledgeStats } = await import("../knowledge.js");

				console.log(chalk.bold("\n📊 Operational Learning Patterns\n"));

				// Task-File Patterns
				const taskFileStats = getTaskFileStats();
				console.log(chalk.cyan("Task → File Correlations:"));
				console.log(
					`  Tasks recorded: ${taskFileStats.totalTasks} (${taskFileStats.successfulTasks} success, ${taskFileStats.failedTasks} failed)`,
				);
				console.log(`  Unique keywords: ${taskFileStats.uniqueKeywords}`);
				console.log(`  Unique files: ${taskFileStats.uniqueFiles}`);
				if (taskFileStats.topKeywords.length > 0) {
					console.log("  Top keywords:");
					for (const { keyword, taskCount, successRate } of taskFileStats.topKeywords.slice(0, 5)) {
						const rateStr = taskCount > 0 ? ` ${Math.round(successRate * 100)}% success` : "";
						console.log(`    - ${keyword} (${taskCount} tasks${rateStr})`);
					}
				}
				if (taskFileStats.riskyKeywords.length > 0) {
					console.log(chalk.yellow("  ⚠ Risky keywords (low success rate):"));
					for (const { keyword, taskCount, successRate } of taskFileStats.riskyKeywords) {
						console.log(
							chalk.yellow(`    - ${keyword} (${taskCount} tasks, ${Math.round(successRate * 100)}% success)`),
						);
					}
				}
				if (taskFileStats.topFiles.length > 0) {
					console.log("  Most modified files:");
					for (const { file, modCount } of taskFileStats.topFiles.slice(0, 5)) {
						console.log(`    - ${file} (${modCount}x)`);
					}
				}
				// Pattern health (freshness)
				const { fresh, aging, stale } = taskFileStats.patternHealth;
				const total = fresh + aging + stale;
				if (total > 0) {
					const freshPct = Math.round((fresh / total) * 100);
					const agingPct = Math.round((aging / total) * 100);
					const stalePct = Math.round((stale / total) * 100);
					const healthColor = freshPct >= 50 ? chalk.green : freshPct >= 25 ? chalk.yellow : chalk.red;
					console.log(`  Pattern health: ${healthColor(`${fresh} fresh`)} / ${aging} aging / ${stale} stale`);
					console.log(`    (${freshPct}% / ${agingPct}% / ${stalePct}%)`);
				}

				// Error-Fix Patterns
				console.log(chalk.cyan("\nError → Fix Patterns:"));
				const errorStats = getErrorFixStats();
				console.log(`  Patterns recorded: ${errorStats.totalPatterns}`);
				console.log(`  Total occurrences: ${errorStats.totalOccurrences}`);
				console.log(`  Fixes recorded: ${errorStats.totalFixes}`);
				if (Object.keys(errorStats.byCategory).length > 0) {
					console.log("  By category:");
					for (const [cat, count] of Object.entries(errorStats.byCategory)) {
						console.log(`    - ${cat}: ${count}`);
					}
				}

				// Knowledge Learnings
				console.log(chalk.cyan("\nKnowledge Compounding:"));
				const knowledgeStats = getKnowledgeStats();
				console.log(`  Total learnings: ${knowledgeStats.totalLearnings}`);
				console.log(`  Average confidence: ${(knowledgeStats.avgConfidence * 100).toFixed(0)}%`);
				const categories = Object.entries(knowledgeStats.byCategory).filter(([, count]) => count > 0);
				if (categories.length > 0) {
					console.log("  By category:");
					for (const [cat, count] of categories) {
						console.log(`    - ${cat}: ${count}`);
					}
				}
				if (knowledgeStats.mostUsed.length > 0) {
					console.log("  Most used learnings:");
					for (const { content, usedCount } of knowledgeStats.mostUsed.slice(0, 3)) {
						console.log(`    - "${content.slice(0, 50)}..." (${usedCount}x)`);
					}
				}

				console.log(chalk.dim("\nUse patterns to predict relevant files and suggest fixes for errors.\n"));
			});

		// Prime patterns from git history
		program
			.command("prime-patterns")
			.description("Seed operational learning patterns from git history")
			.option("-n, --commits <n>", "Number of commits to analyze", "100")
			.action(async (options) => {
				const { primeFromGitHistory } = await import("../task-file-patterns.js");
				const maxCommits = Number.parseInt(options.commits, 10);

				console.log(chalk.cyan(`Analyzing last ${maxCommits} commits...`));
				const result = await primeFromGitHistory(maxCommits);

				console.log(chalk.green(`✓ Processed ${result.commitsProcessed} commits`));
				console.log(chalk.green(`✓ Added ${result.patternsAdded} pattern entries`));
				console.log(chalk.dim("\nRun 'undercity patterns' to see the results."));
			});

		// Decision tracking stats and pending decisions
		program
			.command("decisions")
			.description("View decision tracking stats and pending decisions needing attention")
			.option("--pending", "Show only pending decisions")
			.option("--process", "Have automated PM process pending PM-decidable decisions")
			.action(async (options) => {
				const { getDecisionStats, getPendingDecisions } = await import("../decision-tracker.js");
				const { processPendingDecisions } = await import("../automated-pm.js");

				if (options.process) {
					console.log(chalk.cyan("Processing pending decisions with automated PM..."));
					const result = await processPendingDecisions();
					console.log(chalk.green(`✓ Processed ${result.processed} decisions`));
					if (result.escalated.length > 0) {
						console.log(chalk.yellow(`⚠ ${result.escalated.length} decisions escalated to human:`));
						for (const d of result.escalated) {
							console.log(chalk.yellow(`  - ${d.question}`));
						}
					}
					return;
				}

				const stats = getDecisionStats();

				console.log(chalk.cyan("\nDecision Tracking Stats:"));
				console.log(`  Pending: ${stats.pending}`);
				console.log(`  Resolved: ${stats.resolved}`);
				console.log(`  Human overrides: ${stats.overrides}`);

				console.log(chalk.cyan("\nBy Category:"));
				console.log(`  Auto-handle: ${stats.byCategory.auto_handle}`);
				console.log(`  PM-decidable: ${stats.byCategory.pm_decidable}`);
				console.log(`  Human-required: ${stats.byCategory.human_required}`);

				console.log(chalk.cyan("\nBy Resolver:"));
				console.log(`  Auto: ${stats.byResolver.auto} (${Math.round(stats.successRate.auto * 100)}% success)`);
				console.log(`  PM: ${stats.byResolver.pm} (${Math.round(stats.successRate.pm * 100)}% success)`);
				console.log(`  Human: ${stats.byResolver.human} (${Math.round(stats.successRate.human * 100)}% success)`);

				if (options.pending || stats.pending > 0) {
					const pending = getPendingDecisions();
					if (pending.length > 0) {
						console.log(chalk.cyan("\nPending Decisions:"));
						for (const d of pending.slice(0, 10)) {
							const categoryColor =
								d.category === "human_required" ? chalk.red : d.category === "pm_decidable" ? chalk.yellow : chalk.dim;
							console.log(`  [${categoryColor(d.category)}] ${d.question.slice(0, 60)}...`);
						}
						if (pending.length > 10) {
							console.log(chalk.dim(`  ... and ${pending.length - 10} more`));
						}
						console.log(chalk.dim("\nRun 'undercity decisions --process' to have PM handle pending decisions."));
					}
				}
			});

		// Visualize command - generate HTML visualization of grind sessions
		program
			.command("visualize")
			.description("Generate static HTML visualization of grind sessions")
			.option("--list", "List available sessions")
			.option("-s, --session <batch-id>", "Visualize specific session by batch ID")
			.option("--open", "Open in browser after generating")
			.option("-o, --output <path>", "Custom output file path")
			.action(async (options) => {
				const { handleVisualize } = await import("./visualize-handlers.js");
				await handleVisualize(options);
			});

		// Post-mortem command for analyzing grind results
		program
			.command("postmortem")
			.description("Analyze last grind session and generate insights")
			.option("-n, --last <n>", "Analyze last N sessions (default: 1)", "1")
			.option("--json", "Output as JSON")
			.action(async (options) => {
				const { handlePostmortem } = await import("./analysis-handlers.js");
				await handlePostmortem(options);
			});

		// Effectiveness analysis command - measures learning systems impact
		program
			.command("effectiveness")
			.description("Analyze effectiveness of learning systems (file prediction, knowledge, review)")
			.option("--json", "Output as JSON")
			.action(async (options) => {
				const { analyzeEffectiveness, formatEffectivenessReport } = await import("../effectiveness-analysis.js");
				const report = analyzeEffectiveness();

				if (options.json) {
					console.log(JSON.stringify(report, null, 2));
					return;
				}

				console.log(`\n${formatEffectivenessReport(report)}`);
			});
	},
};

async function runBenchmark(): Promise<void> {
	const benchmarkTasks = [
		"Type generation: Create complex TypeScript type definitions",
		"Zod schema: Define a multi-layer validation schema",
		"Performance test: Measure array processing speed",
		"Error handling: Create a robust error handling module",
		"Logging: Implement structured logging with detailed tracing",
	];

	console.log(chalk.cyan("Starting Undercity Benchmark"));
	console.log(chalk.dim("Running standard set of performance tasks"));

	const { Orchestrator } = await import("../orchestrator.js");
	const orchestrator = new Orchestrator({
		startingModel: "sonnet",
		maxConcurrent: 2,
		autoCommit: true,
		stream: true,
		verbose: true,
	});

	const startTime = Date.now();
	console.log();

	let successCount = 0;
	let failCount = 0;

	try {
		for (const task of benchmarkTasks) {
			console.log(chalk.blue(`\n📋 Task: ${task}`));

			try {
				const result = await orchestrator.runParallel([task]);
				const taskResult = result.results[0]?.result;
				if (taskResult?.status === "complete") {
					successCount++;
					console.log(chalk.green(`✓ Task completed`));
				} else {
					failCount++;
					analysisLogger.error({ task }, "Task failed");
					if (taskResult?.error) {
						analysisLogger.error({ error: taskResult.error }, "Task error details");
					}
				}
			} catch (taskError) {
				failCount++;
				analysisLogger.error({ task, err: taskError }, "Task failed");
			}
		}

		const endTime = Date.now();
		const totalDuration = endTime - startTime;

		console.log(chalk.green("\n✅ Benchmark Completed"));
		console.log(chalk.dim(`Total Duration: ${(totalDuration / 1000).toFixed(2)} seconds`));

		console.log(chalk.bold("\nBenchmark Summary:"));
		console.log(`Total Tasks: ${benchmarkTasks.length}`);
		console.log(`Success: ${successCount}, Failed: ${failCount}`);
		console.log(`Success Rate: ${((successCount / benchmarkTasks.length) * 100).toFixed(2)}%`);
	} catch (error) {
		analysisLogger.error({ err: error }, "Benchmark failed");
		process.exit(1);
	}
}
