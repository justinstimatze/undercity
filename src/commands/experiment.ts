/**
 * Experiment Framework CLI Commands
 *
 * CLI commands for A/B testing different model routing strategies.
 * - Create experiments with multiple variants
 * - Activate/deactivate experiments
 * - View results and recommendations
 */
import chalk from "chalk";
import { getExperimentManager } from "../experiment.js";
import type { ExperimentVariant, ModelTier, VariantMetrics } from "../types.js";
import type { CommandModule } from "./types.js";

/**
 * Calculate statistical significance using simplified z-test
 * Returns confidence that variant A is better than variant B
 */
function calculateSignificance(metricsA: VariantMetrics, metricsB: VariantMetrics): number {
	const n1 = metricsA.totalTasks;
	const n2 = metricsB.totalTasks;

	if (n1 < 5 || n2 < 5) {
		return 0; // Not enough data
	}

	const p1 = metricsA.successRate;
	const p2 = metricsB.successRate;

	// Pooled proportion
	const p = (metricsA.successCount + metricsB.successCount) / (n1 + n2);
	const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));

	if (se === 0) return 0;

	const z = (p1 - p2) / se;

	// Convert z-score to confidence (approximation)
	const confidence = 1 - Math.exp(-0.5 * z * z);
	return Math.min(confidence, 0.99);
}

/**
 * Calculate efficiency score combining success rate and token usage
 */
function calculateEfficiencyScore(metrics: VariantMetrics): number {
	if (metrics.totalTasks === 0) return 0;

	// Weight success heavily, penalize token usage
	const successWeight = 0.7;
	const tokenWeight = 0.3;

	const successScore = metrics.successRate * 100;
	// Normalize tokens: lower is better, assume 50k tokens is "average"
	const tokenScore = Math.max(0, 100 - metrics.avgTokensPerTask / 500);

	return successWeight * successScore + tokenWeight * tokenScore;
}

/**
 * Format variant for display
 */
function formatVariant(variant: ExperimentVariant): string {
	const parts = [variant.name];
	if (variant.model) parts.push(`model=${variant.model}`);
	if (variant.reviewEnabled !== undefined) parts.push(`review=${variant.reviewEnabled}`);
	return parts.join(", ");
}

export const experimentCommands: CommandModule = {
	register(program) {
		const experiment = program
			.command("experiment")
			.alias("exp")
			.description("A/B testing framework for model routing strategies");

		// List experiments
		experiment
			.command("list")
			.alias("ls")
			.description("List all experiments")
			.option("--json", "Output as JSON")
			.action((options) => {
				const manager = getExperimentManager();
				const experiments = manager.getAllExperiments();
				const active = manager.getActiveExperiment();

				if (options.json) {
					console.log(
						JSON.stringify(
							{
								experiments: experiments.map((e) => ({
									id: e.id,
									name: e.name,
									isActive: e.isActive,
									variantCount: e.variants.length,
									resultCount: e.results.length,
									createdAt: e.createdAt,
								})),
								activeExperimentId: active?.id,
							},
							null,
							2,
						),
					);
					return;
				}

				if (experiments.length === 0) {
					console.log(chalk.yellow("No experiments found."));
					console.log(chalk.dim("Create one with: undercity experiment create <name>"));
					return;
				}

				console.log(chalk.bold("\nExperiments\n"));

				for (const exp of experiments) {
					const status = exp.isActive ? chalk.green("ACTIVE") : chalk.dim("inactive");
					const resultCount = exp.results.length;

					console.log(`${status} ${chalk.cyan(exp.name)} (${exp.id})`);
					console.log(`  ${chalk.dim(exp.description)}`);
					console.log(`  Variants: ${exp.variants.length}, Results: ${resultCount}`);
					console.log();
				}
			});

		// Create experiment
		experiment
			.command("create <name>")
			.description("Create a new experiment")
			.option("-d, --description <desc>", "Experiment description")
			.option(
				"--variants <variants>",
				'Comma-separated variant specs (e.g., "haiku,sonnet,opus" or "haiku:norev,sonnet:rev")',
			)
			.option("--preset <preset>", "Use preset: model-comparison, review-comparison")
			.action((name, options) => {
				const manager = getExperimentManager();

				let variants: ExperimentVariant[];
				const description = options.description || `A/B test: ${name}`;

				if (options.preset === "model-comparison") {
					// Use built-in model comparison
					const exp = manager.createModelComparisonExperiment();
					console.log(chalk.green(`Created experiment: ${exp.name} (${exp.id})`));
					console.log(chalk.dim("Activate with: undercity experiment activate " + exp.id));
					return;
				}

				if (options.preset === "review-comparison") {
					variants = [
						{ id: "no-review", name: "No Review", model: "sonnet", weight: 1, reviewEnabled: false },
						{ id: "with-review", name: "With Review", model: "sonnet", weight: 1, reviewEnabled: true },
					];
				} else if (options.variants) {
					// Parse variant specs
					variants = options.variants.split(",").map((spec: string, idx: number) => {
						const [model, flags] = spec.trim().split(":");
						const hasReview = flags?.includes("rev") || false;
						return {
							id: `variant-${idx + 1}`,
							name: `${model}${hasReview ? " + review" : ""}`,
							model: model as ModelTier,
							weight: 1,
							reviewEnabled: hasReview,
						};
					});
				} else {
					// Default: compare all models
					variants = [
						{ id: "haiku", name: "Haiku", model: "haiku", weight: 1 },
						{ id: "sonnet", name: "Sonnet", model: "sonnet", weight: 1 },
						{ id: "opus", name: "Opus", model: "opus", weight: 1 },
					];
				}

				const exp = manager.createExperiment(name, description, variants);

				console.log(chalk.green(`Created experiment: ${exp.name} (${exp.id})`));
				console.log(chalk.dim(`Variants: ${variants.map((v) => v.name).join(", ")}`));
				console.log(chalk.dim("Activate with: undercity experiment activate " + exp.id));
			});

		// Activate experiment
		experiment
			.command("activate <experiment-id>")
			.description("Activate an experiment (deactivates any currently active)")
			.action((experimentId) => {
				const manager = getExperimentManager();

				// Support both ID and name lookup
				let exp = manager.getExperiment(experimentId);
				if (!exp) {
					// Try finding by name
					const all = manager.getAllExperiments();
					exp = all.find((e) => e.name.toLowerCase() === experimentId.toLowerCase()) || null;
				}

				if (!exp) {
					console.log(chalk.red(`Experiment not found: ${experimentId}`));
					console.log(chalk.dim("List experiments with: undercity experiment list"));
					return;
				}

				const success = manager.activateExperiment(exp.id);
				if (success) {
					console.log(chalk.green(`Activated experiment: ${exp.name}`));
					console.log(chalk.dim(`Variants: ${exp.variants.map((v) => v.name).join(", ")}`));
					console.log(chalk.dim("Tasks will now be randomly assigned to variants."));
				} else {
					console.log(chalk.red("Failed to activate experiment"));
				}
			});

		// Deactivate experiment
		experiment
			.command("deactivate")
			.description("Deactivate the current experiment")
			.action(() => {
				const manager = getExperimentManager();
				const active = manager.getActiveExperiment();

				if (!active) {
					console.log(chalk.yellow("No experiment is currently active"));
					return;
				}

				manager.deactivateExperiment();
				console.log(chalk.green(`Deactivated experiment: ${active.name}`));
			});

		// Show results
		experiment
			.command("results [experiment-id]")
			.description("Show experiment results")
			.option("--json", "Output as JSON")
			.action((experimentId, options) => {
				const manager = getExperimentManager();

				// Get experiment (active by default)
				let exp = experimentId ? manager.getExperiment(experimentId) : manager.getActiveExperiment();

				if (!exp && experimentId) {
					// Try by name
					const all = manager.getAllExperiments();
					exp = all.find((e) => e.name.toLowerCase() === experimentId.toLowerCase()) || null;
				}

				if (!exp) {
					console.log(chalk.yellow("No experiment found. Specify an ID or activate one."));
					return;
				}

				const metrics = manager.getVariantMetrics(exp.id);

				if (options.json) {
					console.log(
						JSON.stringify(
							{
								experimentId: exp.id,
								experimentName: exp.name,
								totalResults: exp.results.length,
								variants: metrics.map((m) => ({
									...m,
									variant: exp.variants.find((v) => v.id === m.variantId),
								})),
							},
							null,
							2,
						),
					);
					return;
				}

				console.log(chalk.bold(`\nExperiment: ${exp.name}`));
				console.log(chalk.dim(`${exp.description}\n`));

				if (exp.results.length === 0) {
					console.log(chalk.yellow("No results yet. Run some tasks with grind to collect data."));
					return;
				}

				console.log(chalk.cyan("Variant Results:\n"));

				// Sort by success rate descending
				const sorted = [...metrics].sort((a, b) => b.successRate - a.successRate);

				for (const m of sorted) {
					const variant = exp.variants.find((v) => v.id === m.variantId);
					const successColor = m.successRate >= 0.8 ? chalk.green : m.successRate >= 0.6 ? chalk.yellow : chalk.red;

					console.log(chalk.bold(variant?.name || m.variantId));
					console.log(`  Tasks: ${m.totalTasks}`);
					console.log(`  Success Rate: ${successColor(`${(m.successRate * 100).toFixed(1)}%`)}`);
					console.log(`  Avg Tokens: ${m.avgTokensPerTask.toFixed(0)}`);
					console.log(`  Avg Duration: ${(m.avgDurationMs / 1000).toFixed(1)}s`);
					console.log(`  Avg Attempts: ${m.avgAttempts.toFixed(1)}`);
					console.log(`  Efficiency: ${calculateEfficiencyScore(m).toFixed(1)}`);
					console.log();
				}

				console.log(chalk.dim(`Total results: ${exp.results.length}`));
			});

		// Recommend winner
		experiment
			.command("recommend [experiment-id]")
			.description("Get recommendation for winning variant")
			.option("--json", "Output as JSON")
			.action((experimentId, options) => {
				const manager = getExperimentManager();

				// Get experiment (active by default)
				let exp = experimentId ? manager.getExperiment(experimentId) : manager.getActiveExperiment();

				if (!exp && experimentId) {
					const all = manager.getAllExperiments();
					exp = all.find((e) => e.name.toLowerCase() === experimentId.toLowerCase()) || null;
				}

				if (!exp) {
					console.log(chalk.yellow("No experiment found. Specify an ID or activate one."));
					return;
				}

				const metrics = manager.getVariantMetrics(exp.id);
				const totalTasks = metrics.reduce((sum, m) => sum + m.totalTasks, 0);

				if (totalTasks < 10) {
					const msg = `Need more data. Only ${totalTasks}/10 minimum tasks collected.`;
					if (options.json) {
						console.log(JSON.stringify({ recommendation: null, reason: msg }));
					} else {
						console.log(chalk.yellow(msg));
					}
					return;
				}

				// Find best variant by efficiency score
				const scored = metrics
					.map((m) => ({
						metrics: m,
						variant: exp.variants.find((v) => v.id === m.variantId),
						efficiency: calculateEfficiencyScore(m),
					}))
					.sort((a, b) => b.efficiency - a.efficiency);

				const best = scored[0];
				const second = scored[1];

				// Calculate confidence
				let confidence = 0;
				let recommendation = "inconclusive";

				if (best && second && best.metrics.totalTasks >= 5 && second.metrics.totalTasks >= 5) {
					confidence = calculateSignificance(best.metrics, second.metrics);

					if (confidence >= 0.95) {
						recommendation = "strong";
					} else if (confidence >= 0.8) {
						recommendation = "moderate";
					} else if (confidence >= 0.6) {
						recommendation = "weak";
					}
				}

				if (options.json) {
					console.log(
						JSON.stringify({
							experimentId: exp.id,
							recommendation: {
								variantId: best.variant?.id,
								variantName: best.variant?.name,
								confidence,
								strength: recommendation,
								metrics: best.metrics,
							},
							runnerUp: second
								? {
										variantId: second.variant?.id,
										variantName: second.variant?.name,
										metrics: second.metrics,
									}
								: null,
						}),
					);
					return;
				}

				console.log(chalk.bold(`\nRecommendation for: ${exp.name}\n`));

				if (recommendation === "inconclusive") {
					console.log(chalk.yellow("Results are inconclusive. Need more data or clearer signal."));
					console.log(chalk.dim("Continue running tasks to collect more data."));
				} else {
					const strengthColor =
						recommendation === "strong" ? chalk.green : recommendation === "moderate" ? chalk.yellow : chalk.dim;

					console.log(`${strengthColor(recommendation.toUpperCase())} recommendation:`);
					console.log(chalk.cyan.bold(`\n  Winner: ${best.variant?.name || best.metrics.variantId}`));
					console.log(`  Success Rate: ${(best.metrics.successRate * 100).toFixed(1)}%`);
					console.log(`  Efficiency Score: ${best.efficiency.toFixed(1)}`);
					console.log(`  Confidence: ${(confidence * 100).toFixed(0)}%`);

					if (second) {
						console.log(chalk.dim(`\n  Runner-up: ${second.variant?.name}`));
						console.log(chalk.dim(`  Success Rate: ${(second.metrics.successRate * 100).toFixed(1)}%`));
					}

					if (best.variant) {
						console.log(chalk.cyan("\n  Recommended configuration:"));
						console.log(chalk.dim(`    Model: ${best.variant.model}`));
						if (best.variant.reviewEnabled !== undefined) {
							console.log(chalk.dim(`    Review: ${best.variant.reviewEnabled}`));
						}
					}
				}

				console.log();
			});

		// Delete experiment
		experiment
			.command("delete <experiment-id>")
			.description("Delete an experiment")
			.action((experimentId) => {
				const manager = getExperimentManager();

				let exp = manager.getExperiment(experimentId);
				if (!exp) {
					const all = manager.getAllExperiments();
					exp = all.find((e) => e.name.toLowerCase() === experimentId.toLowerCase()) || null;
				}

				if (!exp) {
					console.log(chalk.red(`Experiment not found: ${experimentId}`));
					return;
				}

				const success = manager.deleteExperiment(exp.id);
				if (success) {
					console.log(chalk.green(`Deleted experiment: ${exp.name}`));
				} else {
					console.log(chalk.red("Failed to delete experiment"));
				}
			});
	},
};
