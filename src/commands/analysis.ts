/**
 * Analysis and metrics commands
 */
import chalk from "chalk";
import { ParallelSoloOrchestrator } from "../parallel-solo.js";
import type { CommandModule } from "./types.js";

export const analysisCommands: CommandModule = {
	register(program) {
		// Metrics command
		program
			.command("metrics")
			.description("Show performance metrics and analytics")
			.action(async () => {
				const { getMetricsCollector } = await import("../metrics-collector.js");
				const metricsCollector = getMetricsCollector();
				const metrics = metricsCollector.getMetricsSummary();

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

		// Complexity-based success rate analysis
		program
			.command("complexity-metrics")
			.description("Show success rates by complexity level and escalation guidance")
			.option("--json", "Output as JSON")
			.action(async (options) => {
				const { generateEfficiencyAnalytics } = await import("../metrics.js");
				const analytics = await generateEfficiencyAnalytics();

				if (options.json) {
					console.log(JSON.stringify(analytics, null, 2));
					return;
				}

				console.log(chalk.bold("Success Rate by Complexity Level"));
				console.log(chalk.dim("Identify which tasks need escalation most\n"));

				// Sort complexity levels by escalation need (lowest success rate first)
				const complexityLevels = Object.entries(analytics.successRateByComplexity).sort(
					([, a], [, b]) => a.rate - b.rate,
				);

				for (const [level, data] of complexityLevels) {
					const statusColor = data.rate >= 80 ? chalk.green : data.rate >= 60 ? chalk.yellow : chalk.red;
					const escalationColor = data.rate < data.escalationTrigger * 100 ? chalk.red : chalk.white;

					console.log(
						`${chalk.cyan(level.toUpperCase().padEnd(10))} ${statusColor(`${data.rate.toFixed(1)}%`)} success rate`,
					);
					console.log(`  ${chalk.dim(`Total quests: ${data.totalQuests}`)}`);
					console.log(`  ${chalk.dim(`Avg tokens: ${data.avgTokensPerQuest.toFixed(0)}`)}`);
					console.log(`  ${escalationColor(`Escalation threshold: ${(data.escalationTrigger * 100).toFixed(0)}%`)}`);

					// Show escalation data if any escalations occurred
					if (data.escalatedCount > 0) {
						const escColor =
							data.escalationSuccessRate >= 80
								? chalk.green
								: data.escalationSuccessRate >= 60
									? chalk.yellow
									: chalk.red;
						console.log(
							`  ${chalk.dim(`Escalated: ${data.escalatedCount} quests (${escColor(`${data.escalationSuccessRate.toFixed(1)}%`)} success)`)}`,
						);
						if (data.escalationTokenOverhead > 0) {
							console.log(
								`  ${chalk.dim(`Escalation token overhead: +${data.escalationTokenOverhead.toFixed(0)} tokens/quest`)}`,
							);
						}
					}

					if (data.rate < data.escalationTrigger * 100) {
						console.log(`  ${chalk.red.bold("⚠ ESCALATION RECOMMENDED")}`);
					}
					console.log();
				}

				console.log(chalk.cyan("Overall Analytics:"));
				console.log(`  Total quests analyzed: ${analytics.totalQuests}`);
				console.log(`  Overall success rate: ${analytics.successRate.toFixed(1)}%`);
				console.log(`  Average tokens per completion: ${analytics.avgTokensPerCompletion.toFixed(0)}`);

				if (analytics.mostEfficientAgentType) {
					console.log(`  Most efficient agent: ${analytics.mostEfficientAgentType}`);
				}

				// Show which complexity levels need attention
				const needsEscalation = complexityLevels.filter(([, data]) => data.rate < data.escalationTrigger * 100);
				if (needsEscalation.length > 0) {
					console.log(`\n${chalk.red.bold("Complexity levels requiring escalation:")}`);
					for (const [level, data] of needsEscalation) {
						const escInfo =
							data.escalatedCount > 0
								? ` (${data.escalatedCount} already escalated, ${data.escalationSuccessRate.toFixed(0)}% success)`
								: "";
						console.log(`  • ${level} - Consider routing to higher-tier agents${escInfo}`);
					}
				} else {
					console.log(`\n${chalk.green("All complexity levels are performing adequately")}`);
				}

				// Summary of escalation patterns
				const totalEscalated = complexityLevels.reduce((sum, [, data]) => sum + data.escalatedCount, 0);
				if (totalEscalated > 0) {
					console.log(`\n${chalk.cyan("Escalation Summary:")}`);
					console.log(`  Total escalated quests: ${totalEscalated}`);

					// Find which complexity levels escalate most frequently
					const escalationByLevel = complexityLevels
						.filter(([, data]) => data.escalatedCount > 0 && data.totalQuests > 0)
						.map(([level, data]) => ({
							level,
							escalationRate: (data.escalatedCount / data.totalQuests) * 100,
							successAfterEscalation: data.escalationSuccessRate,
							count: data.escalatedCount,
						}))
						.sort((a, b) => b.escalationRate - a.escalationRate);

					if (escalationByLevel.length > 0) {
						console.log(
							`  Highest escalation rate: ${escalationByLevel[0].level} (${escalationByLevel[0].escalationRate.toFixed(1)}%)`,
						);

						// Identify if escalation is effective
						const effectiveEscalations = escalationByLevel.filter((e) => e.successAfterEscalation >= 70);
						const ineffectiveEscalations = escalationByLevel.filter(
							(e) => e.successAfterEscalation < 50 && e.count >= 3,
						);

						if (effectiveEscalations.length > 0) {
							console.log(
								`  ${chalk.green("Effective escalation:")} ${effectiveEscalations.map((e) => e.level).join(", ")}`,
							);
						}
						if (ineffectiveEscalations.length > 0) {
							console.log(
								`  ${chalk.red("Ineffective escalation:")} ${ineffectiveEscalations.map((e) => e.level).join(", ")} - consider different approaches`,
							);
						}
					}
				}
			});

		// Enhanced metrics command for detailed tracking
		program
			.command("enhanced-metrics")
			.description("Show detailed metrics with escalation and token usage analysis")
			.option("--days <days>", "Days of history to analyze", "30")
			.option("--json", "Output as JSON")
			.action(async (options) => {
				const { EnhancedMetricsQuery } = await import("../enhanced-metrics.js");

				const days = parseInt(options.days, 10);
				const tokenTrends = await EnhancedMetricsQuery.getTokenUsageTrends(days);
				const escalationAnalysis = await EnhancedMetricsQuery.getEscalationAnalysis();

				if (options.json) {
					console.log(JSON.stringify({ tokenTrends, escalationAnalysis }, null, 2));
					return;
				}

				console.log(chalk.bold("Enhanced Metrics Analysis"));
				console.log(chalk.dim(`Analysis period: Last ${days} days\n`));

				// Token Usage Overview
				console.log(chalk.cyan("📊 Token Usage Overview"));
				console.log(`Total tokens used: ${tokenTrends.totalTokens.toLocaleString()}`);
				console.log(`Average efficiency ratio: ${(tokenTrends.averageEfficiencyRatio * 100).toFixed(1)}%`);
				console.log();

				// Token distribution by model
				console.log(chalk.cyan("🤖 Token Distribution by Model"));
				const modelTotal = Object.values(tokenTrends.tokensByModel).reduce((sum, count) => sum + count, 0);
				for (const [model, tokens] of Object.entries(tokenTrends.tokensByModel)) {
					const percentage = modelTotal > 0 ? ((tokens / modelTotal) * 100).toFixed(1) : "0.0";
					const modelColor = model === "opus" ? chalk.red : model === "sonnet" ? chalk.yellow : chalk.green;
					console.log(
						`  ${modelColor(model.padEnd(8))}: ${tokens.toLocaleString().padStart(10)} tokens (${percentage}%)`,
					);
				}
				console.log();

				// Token distribution by phase
				console.log(chalk.cyan("⚡ Token Distribution by Phase"));
				const phaseTotal = Object.values(tokenTrends.tokensByPhase).reduce((sum, count) => sum + count, 0);
				for (const [phase, tokens] of Object.entries(tokenTrends.tokensByPhase)) {
					const percentage = phaseTotal > 0 ? ((tokens / phaseTotal) * 100).toFixed(1) : "0.0";
					console.log(`  ${phase.padEnd(12)}: ${tokens.toLocaleString().padStart(10)} tokens (${percentage}%)`);
				}
				console.log();

				// Model Escalation Analysis
				console.log(chalk.cyan("🔄 Model Escalation Analysis"));
				console.log(`Total escalations: ${escalationAnalysis.totalEscalations}`);
				console.log(`Escalation success rate: ${(escalationAnalysis.escalationSuccessRate * 100).toFixed(1)}%`);
				console.log(`Average tokens saved per escalation: ${escalationAnalysis.averageTokensSaved.toFixed(0)}`);
				console.log();

				if (Object.keys(escalationAnalysis.escalationsByModel).length > 0) {
					console.log("Most common escalation paths:");
					for (const [path, count] of Object.entries(escalationAnalysis.escalationsByModel)) {
						console.log(`  ${path}: ${count} times`);
					}
					console.log();
				}

				if (escalationAnalysis.commonEscalationReasons.length > 0) {
					console.log("Top escalation reasons:");
					for (const { reason, count } of escalationAnalysis.commonEscalationReasons.slice(0, 5)) {
						console.log(`  ${reason}: ${count} times`);
					}
					console.log();
				}

				// Daily usage trends
				if (tokenTrends.dailyUsage.length > 0) {
					console.log(chalk.cyan("📈 Recent Usage Trends"));
					const recent = tokenTrends.dailyUsage.slice(-7); // Last 7 days
					for (const day of recent) {
						const date = new Date(day.date).toLocaleDateString();
						console.log(`  ${date}: ${day.tokens.toLocaleString()} tokens, ${day.quests} quests`);
					}
				}
			});

		// Escalation patterns command
		program
			.command("escalation-patterns")
			.description("Analyze model escalation patterns and effectiveness")
			.action(async () => {
				const { EnhancedMetricsQuery } = await import("../enhanced-metrics.js");
				const analysis = await EnhancedMetricsQuery.getEscalationAnalysis();

				console.log(chalk.bold("🔄 Model Escalation Patterns Analysis\n"));

				if (analysis.totalEscalations === 0) {
					console.log(chalk.yellow("No escalation data found in metrics history."));
					console.log(chalk.dim("Enhanced metrics tracking may need to be integrated into the orchestrator."));
					return;
				}

				// Success rate analysis
				const successColor =
					analysis.escalationSuccessRate >= 0.8
						? chalk.green
						: analysis.escalationSuccessRate >= 0.6
							? chalk.yellow
							: chalk.red;

				console.log(chalk.cyan("Overall Escalation Performance"));
				console.log(`Total escalations: ${analysis.totalEscalations}`);
				console.log(`Success rate: ${successColor(`${(analysis.escalationSuccessRate * 100).toFixed(1)}%`)}`);
				console.log(`Average tokens saved: ${analysis.averageTokensSaved.toFixed(0)}`);
				console.log();

				// Escalation path effectiveness
				console.log(chalk.cyan("Escalation Path Effectiveness"));
				const sortedPaths = Object.entries(analysis.escalationsByModel).sort(([, a], [, b]) => b - a);

				for (const [path, count] of sortedPaths) {
					console.log(`  ${path}: ${count} escalations`);
				}
				console.log();

				// Common reasons
				if (analysis.commonEscalationReasons.length > 0) {
					console.log(chalk.cyan("Most Common Escalation Triggers"));
					for (const { reason, count } of analysis.commonEscalationReasons.slice(0, 10)) {
						console.log(`  ${count.toString().padStart(3)}x ${reason}`);
					}
					console.log();
				}

				// Recommendations
				console.log(chalk.cyan("💡 Recommendations"));

				if (analysis.escalationSuccessRate < 0.6) {
					console.log(chalk.red("  • Low escalation success rate - review escalation triggers"));
				}

				if (analysis.averageTokensSaved < 0) {
					console.log(chalk.red("  • Escalations are increasing token usage - review efficiency"));
				} else if (analysis.averageTokensSaved > 100) {
					console.log(chalk.green("  • Escalations are saving tokens effectively"));
				}

				// Look for patterns in the escalation paths
				const hasHaikuToOpus = analysis.escalationsByModel["haiku → opus"] > 0;
				const hasHaikuToSonnet = analysis.escalationsByModel["haiku → sonnet"] > 0;
				const _hasSonnetToOpus = analysis.escalationsByModel["sonnet → opus"] > 0;

				if (hasHaikuToOpus && !hasHaikuToSonnet) {
					console.log(chalk.yellow("  • Consider using Sonnet as intermediate step instead of jumping to Opus"));
				}

				if (analysis.totalEscalations > 50) {
					console.log(chalk.blue("  • High escalation volume - consider adjusting initial model selection"));
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
					console.error(chalk.red("Benchmark error:"), error);
					process.exit(1);
				}
			});
	},
};

async function runBenchmark(): Promise<void> {
	const { getMetricsCollector } = await import("../metrics-collector.js");
	const metricsCollector = getMetricsCollector();

	const benchmarkTasks = [
		"Type generation: Create complex TypeScript type definitions",
		"Zod schema: Define a multi-layer validation schema",
		"Performance test: Measure array processing speed",
		"Error handling: Create a robust error handling module",
		"Logging: Implement structured logging with detailed tracing",
	];

	console.log(chalk.cyan("🚀 Starting Undercity Benchmark"));
	console.log(chalk.dim("Running standard set of performance tasks"));

	const orchestrator = new ParallelSoloOrchestrator({
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
					console.error(chalk.red(`Task failed: ${task}`));
					if (taskResult?.error) {
						console.error(chalk.dim(taskResult.error));
					}
				}
			} catch (taskError) {
				failCount++;
				console.error(chalk.red(`Task failed: ${task}`));
				console.error(chalk.dim(String(taskError)));
			}
		}

		const endTime = Date.now();
		const totalDuration = endTime - startTime;

		console.log(chalk.green("\n✅ Benchmark Completed"));
		console.log(chalk.dim(`Total Duration: ${(totalDuration / 1000).toFixed(2)} seconds`));

		const metrics = metricsCollector.getMetricsSummary(new Date(startTime), new Date(endTime));
		console.log(chalk.bold("\nBenchmark Summary:"));
		console.log(`Total Tasks: ${benchmarkTasks.length}`);
		console.log(`Success: ${successCount}, Failed: ${failCount}`);
		console.log(`Success Rate: ${((successCount / benchmarkTasks.length) * 100).toFixed(2)}%`);
		if (metrics.totalTasks > 0) {
			console.log(`Average Tokens Used: ${metrics.avgTokens.toFixed(2)}`);
			console.log(`Average Task Duration: ${(metrics.avgTimeTakenMs / 1000).toFixed(2)} seconds`);
		}
	} catch (error) {
		console.error(chalk.red("Benchmark failed:"), error);
		process.exit(1);
	}
}
