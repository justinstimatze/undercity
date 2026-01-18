/**
 * Analysis and metrics commands
 */
import chalk from "chalk";
import { launchMetricsDashboard } from "../metrics-dashboard.js";
import { Orchestrator } from "../orchestrator.js";
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
					console.log(`  ${chalk.dim(`Total tasks: ${data.totalTasks}`)}`);
					console.log(`  ${chalk.dim(`Avg tokens: ${data.avgTokensPerTask.toFixed(0)}`)}`);
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
							`  ${chalk.dim(`Escalated: ${data.escalatedCount} tasks (${escColor(`${data.escalationSuccessRate.toFixed(1)}%`)} success)`)}`,
						);
						if (data.escalationTokenOverhead > 0) {
							console.log(
								`  ${chalk.dim(`Escalation token overhead: +${data.escalationTokenOverhead.toFixed(0)} tokens/task`)}`,
							);
						}
					}

					if (data.rate < data.escalationTrigger * 100) {
						console.log(`  ${chalk.red.bold("⚠ ESCALATION RECOMMENDED")}`);
					}
					console.log();
				}

				console.log(chalk.cyan("Overall Analytics:"));
				console.log(`  Total tasks analyzed: ${analytics.totalTasks}`);
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
					console.log(`  Total escalated tasks: ${totalEscalated}`);

					// Find which complexity levels escalate most frequently
					const escalationByLevel = complexityLevels
						.filter(([, data]) => data.escalatedCount > 0 && data.totalTasks > 0)
						.map(([level, data]) => ({
							level,
							escalationRate: (data.escalatedCount / data.totalTasks) * 100,
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
				const { getTokenUsageTrends, getEscalationAnalysis } = await import("../metrics.js");

				const days = parseInt(options.days, 10);
				const tokenTrends = await getTokenUsageTrends(days);
				const escalationAnalysis = await getEscalationAnalysis();

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
						console.log(`  ${date}: ${day.tokens.toLocaleString()} tokens, ${day.tasks} tasks`);
					}
				}
			});

		// Escalation patterns command
		program
			.command("escalation-patterns")
			.description("Analyze model escalation patterns and effectiveness")
			.action(async () => {
				const { getEscalationAnalysis } = await import("../metrics.js");
				const analysis = await getEscalationAnalysis();

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
					console.error(chalk.red("Benchmark error:"), error);
					process.exit(1);
				}
			});

		// Semantic check command
		program
			.command("semantic-check")
			.description("Analyze semantic density and code efficiency")
			.option("--fix", "Auto-fix issues")
			.option("--summary", "Compact summary (default for agents)")
			.option("--human", "Human-readable output")
			.option("--output <file>", "Save full report to file")
			.action(async (options) => {
				const { runSemanticCheck } = await import("../semantic-analyzer/index.js");
				const { SemanticFixer } = await import("../semantic-analyzer/index.js");

				const report = await runSemanticCheck({
					rootDir: process.cwd(),
					summary: options.summary ?? true,
					human: options.human,
					output: options.output,
				});

				if (options.fix) {
					const fixer = new SemanticFixer();
					fixer.applyFixes(report, process.cwd());
					console.log(chalk.green("\n✓ Fixes applied"));
				}

				// Exit with error code if high priority issues found
				const highPriorityCount = report.actions.filter((a) => a.priority === "high").length;
				if (highPriorityCount > 0 && !options.fix) {
					process.exit(1);
				}
			});

		// Metrics dashboard command - comprehensive metrics TUI
		program
			.command("metrics-dashboard")
			.alias("md")
			.description("Launch interactive metrics dashboard with token usage, success rates, and cost tracking")
			.action(() => {
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

		// Ax/DSPy training stats
		program
			.command("ax")
			.description("View Ax/DSPy training data stats for self-improving prompts")
			.action(async () => {
				const { getAxProgramStats } = await import("../ax-programs.js");
				const stats = getAxProgramStats();

				console.log(chalk.cyan.bold("\n📊 Ax Training Data Stats\n"));

				const programs = [
					{ name: "Atomicity Checker", key: "atomicity" as const },
					{ name: "Task Decomposer", key: "decomposition" as const },
					{ name: "Decision Maker", key: "decision" as const },
				];

				for (const prog of programs) {
					const s = stats[prog.key];
					const successRate = s.total > 0 ? ((s.successful / s.total) * 100).toFixed(1) : "N/A";
					console.log(chalk.bold(prog.name));
					console.log(`  Examples: ${s.total}`);
					console.log(`  Successful: ${s.successful}`);
					console.log(`  Success Rate: ${successRate}%`);
					console.log();
				}

				const totalExamples = stats.atomicity.total + stats.decomposition.total + stats.decision.total;
				if (totalExamples === 0) {
					console.log(chalk.dim("No training data yet. Run some tasks to collect examples."));
				} else {
					console.log(chalk.dim(`Total: ${totalExamples} examples across all programs`));
					console.log(chalk.dim("Examples are used as few-shot demos to improve prompt performance."));
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

	console.log(chalk.cyan("🚀 Starting Undercity Benchmark"));
	console.log(chalk.dim("Running standard set of performance tasks"));

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

		console.log(chalk.bold("\nBenchmark Summary:"));
		console.log(`Total Tasks: ${benchmarkTasks.length}`);
		console.log(`Success: ${successCount}, Failed: ${failCount}`);
		console.log(`Success Rate: ${((successCount / benchmarkTasks.length) * 100).toFixed(2)}%`);
	} catch (error) {
		console.error(chalk.red("Benchmark failed:"), error);
		process.exit(1);
	}
}
