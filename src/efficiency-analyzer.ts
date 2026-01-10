/**
 * Efficiency Analyzer
 *
 * Performs statistical analysis and regression modeling on efficiency outcomes
 * to build empirical models comparing linear vs swarm execution modes.
 */

import type { EfficiencyComparison, EfficiencyOutcome } from "./types.js";

/**
 * Statistical analysis utilities
 */

/**
 * Calculate mean of an array
 */
function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, val) => sum + val, 0) / values.length;
}

/**
 * Calculate standard deviation
 */
function standardDeviation(values: number[]): number {
	if (values.length <= 1) return 0;
	const meanValue = mean(values);
	const squaredDiffs = values.map((val) => (val - meanValue) ** 2);
	const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / squaredDiffs.length;
	return Math.sqrt(variance);
}

/**
 * Calculate degrees of freedom for Welch's t-test
 */
function welchDegreesOfFreedom(var1: number, n1: number, var2: number, n2: number): number {
	const numerator = (var1 / n1 + var2 / n2) ** 2;
	const denominator = (var1 / n1) ** 2 / (n1 - 1) + (var2 / n2) ** 2 / (n2 - 1);
	return denominator === 0 ? 1 : numerator / denominator;
}

/**
 * Approximate cumulative normal distribution
 */
function cumulativeNormal(z: number): number {
	// Abramowitz and Stegun approximation
	const t = 1.0 / (1.0 + 0.2316419 * Math.abs(z));
	const d = 0.3989423 * Math.exp((-z * z) / 2.0);
	const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
	return z > 0 ? 1.0 - prob : prob;
}

/**
 * Approximate cumulative t-distribution
 */
function cumulativeT(t: number, df: number): number {
	// Simple approximation - for more accuracy, use a proper t-distribution library
	if (df >= 30) {
		return cumulativeNormal(t);
	}
	// For small df, use a rough approximation
	const x = t / Math.sqrt(df);
	return cumulativeNormal(x);
}

/**
 * Calculate two-proportion z-test p-value
 */
function twoProportionZTest(successes1: number, total1: number, successes2: number, total2: number): number {
	if (total1 === 0 || total2 === 0) return 1.0;

	const p1 = successes1 / total1;
	const p2 = successes2 / total2;
	const pooled = (successes1 + successes2) / (total1 + total2);

	const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / total1 + 1 / total2));
	if (standardError === 0) return 1.0;

	const zScore = Math.abs(p1 - p2) / standardError;
	return 2 * (1 - cumulativeNormal(zScore)); // Two-tailed test
}

/**
 * Calculate two-sample t-test p-value
 */
function twoSampleTTest(values1: number[], values2: number[]): number {
	if (values1.length === 0 || values2.length === 0) return 1.0;

	const mean1 = mean(values1);
	const mean2 = mean(values2);
	const std1 = standardDeviation(values1);
	const std2 = standardDeviation(values2);
	const n1 = values1.length;
	const n2 = values2.length;

	// Welch's t-test (unequal variances)
	const variance1 = std1 ** 2;
	const variance2 = std2 ** 2;
	const pooledVariance = variance1 / n1 + variance2 / n2;

	if (pooledVariance === 0) return 1.0;

	const tScore = Math.abs(mean1 - mean2) / Math.sqrt(pooledVariance);
	const df = welchDegreesOfFreedom(variance1, n1, variance2, n2);

	return 2 * (1 - cumulativeT(tScore, df)); // Two-tailed test
}

/**
 * Analyzer for efficiency outcomes and A/B comparisons
 */
export class EfficiencyAnalyzer {
	/**
	 * Group outcomes by parallelism level
	 */
	private groupByParallelism(outcomes: EfficiencyOutcome[]): {
		linear: EfficiencyOutcome[];
		swarm: EfficiencyOutcome[];
	} {
		const linear = outcomes.filter((o) => o.parallelismLevel === "sequential");
		const swarm = outcomes.filter((o) => o.parallelismLevel === "maximum");
		return { linear, swarm };
	}

	/**
	 * Calculate aggregated metrics for a set of outcomes
	 */
	private calculateAggregatedMetrics(outcomes: EfficiencyOutcome[]) {
		if (outcomes.length === 0) {
			return {
				sampleSize: 0,
				avgFirstOrderTokens: 0,
				avgSecondOrderTokens: 0,
				avgReworkRate: 0,
				avgTimeToStable: 0,
				avgUserInterventions: 0,
				successRate: 0,
			};
		}

		const successfulOutcomes = outcomes.filter((o) => o.finalSuccess);
		const firstOrderTokens = outcomes.map((o) => o.firstOrder.tokensUsed);
		const secondOrderTokens = outcomes.map((o) => o.secondOrder.totalTokens);
		const reworkRates = outcomes.map((o) => o.secondOrder.reworkAttempts);
		const timesToStable = outcomes.map((o) => o.secondOrder.timeToStableCompletion);
		const userInterventions = outcomes.map((o) => o.secondOrder.userInterventions);

		return {
			sampleSize: outcomes.length,
			avgFirstOrderTokens: mean(firstOrderTokens),
			avgSecondOrderTokens: mean(secondOrderTokens),
			avgReworkRate: mean(reworkRates),
			avgTimeToStable: mean(timesToStable),
			avgUserInterventions: mean(userInterventions),
			successRate: successfulOutcomes.length / outcomes.length,
		};
	}

	/**
	 * Perform statistical significance testing
	 */
	private calculateSignificance(linearOutcomes: EfficiencyOutcome[], swarmOutcomes: EfficiencyOutcome[]) {
		// Token efficiency comparison (first-order tokens)
		const linearFirstOrder = linearOutcomes.map((o) => o.firstOrder.tokensUsed);
		const swarmFirstOrder = swarmOutcomes.map((o) => o.firstOrder.tokensUsed);
		const tokenEfficiencyPValue = twoSampleTTest(linearFirstOrder, swarmFirstOrder);

		// Rework rate comparison
		const linearRework = linearOutcomes.map((o) => o.secondOrder.reworkAttempts);
		const swarmRework = swarmOutcomes.map((o) => o.secondOrder.reworkAttempts);
		const reworkRatePValue = twoSampleTTest(linearRework, swarmRework);

		// Time efficiency comparison
		const linearTime = linearOutcomes.map((o) => o.secondOrder.timeToStableCompletion);
		const swarmTime = swarmOutcomes.map((o) => o.secondOrder.timeToStableCompletion);
		const timeEfficiencyPValue = twoSampleTTest(linearTime, swarmTime);

		// Success rate comparison
		const linearSuccesses = linearOutcomes.filter((o) => o.finalSuccess).length;
		const swarmSuccesses = swarmOutcomes.filter((o) => o.finalSuccess).length;
		const successRatePValue = twoProportionZTest(
			linearSuccesses,
			linearOutcomes.length,
			swarmSuccesses,
			swarmOutcomes.length,
		);

		const alpha = 0.05;
		const overallSignificant =
			tokenEfficiencyPValue < alpha ||
			reworkRatePValue < alpha ||
			timeEfficiencyPValue < alpha ||
			successRatePValue < alpha;

		return {
			tokenEfficiencyPValue,
			reworkRatePValue,
			timeEfficiencyPValue,
			successRatePValue,
			overallSignificant,
		};
	}

	/**
	 * Build empirical model coefficients
	 */
	private buildEmpiricalModel(linearOutcomes: EfficiencyOutcome[], swarmOutcomes: EfficiencyOutcome[]) {
		const linearMetrics = this.calculateAggregatedMetrics(linearOutcomes);
		const swarmMetrics = this.calculateAggregatedMetrics(swarmOutcomes);

		// Calculate first-order multiplier (how much more first-order costs vs second-order)
		const linearFirstToSecond =
			linearMetrics.avgSecondOrderTokens > 0
				? linearMetrics.avgFirstOrderTokens / linearMetrics.avgSecondOrderTokens
				: 1;
		const swarmFirstToSecond =
			swarmMetrics.avgSecondOrderTokens > 0 ? swarmMetrics.avgFirstOrderTokens / swarmMetrics.avgSecondOrderTokens : 1;
		const firstOrderMultiplier = (linearFirstToSecond + swarmFirstToSecond) / 2;

		// Calculate rework penalty (additional tokens per rework cycle)
		const allOutcomes = [...linearOutcomes, ...swarmOutcomes];
		const reworkPenalties: number[] = [];
		for (const outcome of allOutcomes) {
			if (outcome.secondOrder.reworkAttempts > 0) {
				const penalty =
					(outcome.secondOrder.totalTokens - outcome.firstOrder.tokensUsed) / outcome.secondOrder.reworkAttempts;
				reworkPenalties.push(penalty);
			}
		}
		const reworkPenalty = mean(reworkPenalties);

		// Calculate parallelism bonus (time saved with parallel execution)
		const parallelismBonus =
			linearMetrics.avgTimeToStable > 0 ? 1 - swarmMetrics.avgTimeToStable / linearMetrics.avgTimeToStable : 0;

		// Calculate quality tradeoff (success rate difference)
		const qualityTradeoff = swarmMetrics.successRate - linearMetrics.successRate;

		return {
			firstOrderMultiplier,
			reworkPenalty,
			parallelismBonus,
			qualityTradeoff,
		};
	}

	/**
	 * Analyze efficiency outcomes and generate comparison
	 */
	analyzeEfficiency(
		outcomes: EfficiencyOutcome[],
		comparisonName = "Linear vs Swarm Mode Analysis",
	): EfficiencyComparison {
		const { linear, swarm } = this.groupByParallelism(outcomes);

		const linearMetrics = this.calculateAggregatedMetrics(linear);
		const swarmMetrics = this.calculateAggregatedMetrics(swarm);
		const significance = this.calculateSignificance(linear, swarm);
		const model = this.buildEmpiricalModel(linear, swarm);

		return {
			name: comparisonName,
			linearMode: linearMetrics,
			swarmMode: swarmMetrics,
			significance,
			model,
		};
	}

	/**
	 * Generate efficiency insights and recommendations
	 */
	generateInsights(comparison: EfficiencyComparison): string[] {
		const insights: string[] = [];
		const { linearMode, swarmMode, significance, model } = comparison;

		// Sample size insights
		if (linearMode.sampleSize < 10 || swarmMode.sampleSize < 10) {
			insights.push(
				`⚠️  Small sample sizes (Linear: ${linearMode.sampleSize}, Swarm: ${swarmMode.sampleSize}). Results may not be reliable.`,
			);
		}

		// Token efficiency insights
		const tokenDiff = swarmMode.avgFirstOrderTokens - linearMode.avgFirstOrderTokens;
		const tokenDiffPercent = ((tokenDiff / linearMode.avgFirstOrderTokens) * 100).toFixed(1);
		if (significance.tokenEfficiencyPValue < 0.05) {
			if (tokenDiff > 0) {
				insights.push(
					`🔴 Swarm mode uses significantly more first-order tokens (+${tokenDiffPercent}%, p=${significance.tokenEfficiencyPValue.toFixed(3)})`,
				);
			} else {
				insights.push(
					`🟢 Swarm mode uses significantly fewer first-order tokens (${tokenDiffPercent}%, p=${significance.tokenEfficiencyPValue.toFixed(3)})`,
				);
			}
		}

		// Time efficiency insights
		const timeDiff = swarmMode.avgTimeToStable - linearMode.avgTimeToStable;
		const timeDiffPercent = ((timeDiff / linearMode.avgTimeToStable) * 100).toFixed(1);
		if (significance.timeEfficiencyPValue < 0.05 && model.parallelismBonus !== 0) {
			if (model.parallelismBonus > 0) {
				insights.push(
					`🚀 Swarm mode is significantly faster (${(model.parallelismBonus * 100).toFixed(1)}% time savings, p=${significance.timeEfficiencyPValue.toFixed(3)})`,
				);
			} else {
				insights.push(
					`🐌 Swarm mode is significantly slower (${timeDiffPercent}% increase, p=${significance.timeEfficiencyPValue.toFixed(3)})`,
				);
			}
		}

		// Rework insights
		const reworkDiff = swarmMode.avgReworkRate - linearMode.avgReworkRate;
		if (significance.reworkRatePValue < 0.05) {
			if (reworkDiff > 0) {
				insights.push(
					`🔄 Swarm mode requires significantly more rework (+${reworkDiff.toFixed(2)} attempts, p=${significance.reworkRatePValue.toFixed(3)})`,
				);
			} else {
				insights.push(
					`✅ Swarm mode requires significantly less rework (${reworkDiff.toFixed(2)} attempts, p=${significance.reworkRatePValue.toFixed(3)})`,
				);
			}
		}

		// Quality insights
		const successDiff = swarmMode.successRate - linearMode.successRate;
		const successDiffPercent = (successDiff * 100).toFixed(1);
		if (significance.successRatePValue < 0.05) {
			if (successDiff > 0) {
				insights.push(
					`🎯 Swarm mode has significantly higher success rate (+${successDiffPercent}%, p=${significance.successRatePValue.toFixed(3)})`,
				);
			} else {
				insights.push(
					`❌ Swarm mode has significantly lower success rate (${successDiffPercent}%, p=${significance.successRatePValue.toFixed(3)})`,
				);
			}
		}

		// Empirical model insights
		if (model.reworkPenalty > 0) {
			insights.push(`📊 Each rework cycle costs approximately ${model.reworkPenalty.toFixed(0)} additional tokens`);
		}

		if (Math.abs(model.qualityTradeoff) > 0.1) {
			insights.push(
				`⚖️  Quality tradeoff: ${model.qualityTradeoff > 0 ? "Higher" : "Lower"} success rate with parallel execution`,
			);
		}

		// Overall recommendation
		if (!significance.overallSignificant) {
			insights.push("📊 No statistically significant differences detected between modes");
		} else {
			const pros: string[] = [];
			const cons: string[] = [];

			if (model.parallelismBonus > 0.1) pros.push("faster execution");
			if (successDiff > 0.1) pros.push("higher success rate");
			if (reworkDiff < -0.5) pros.push("less rework required");
			if (tokenDiff < 0) pros.push("lower token usage");

			if (model.parallelismBonus < -0.1) cons.push("slower execution");
			if (successDiff < -0.1) cons.push("lower success rate");
			if (reworkDiff > 0.5) cons.push("more rework required");
			if (tokenDiff > 0) cons.push("higher token usage");

			if (pros.length > cons.length) {
				insights.push(`✅ Recommendation: Consider using swarm mode for ${pros.join(", ")}`);
			} else if (cons.length > pros.length) {
				insights.push(`⚠️  Recommendation: Consider linear mode due to swarm mode's ${cons.join(", ")}`);
			} else {
				insights.push("🤷 Recommendation: Both modes show similar performance characteristics");
			}
		}

		return insights;
	}

	/**
	 * Filter outcomes by experiment
	 */
	filterByExperiment(outcomes: EfficiencyOutcome[], experimentId: string): EfficiencyOutcome[] {
		return outcomes.filter((o) => o.experimentId === experimentId);
	}

	/**
	 * Calculate confidence intervals for key metrics
	 */
	calculateConfidenceIntervals(
		outcomes: EfficiencyOutcome[],
		confidence = 0.95,
	): {
		firstOrderTokens: { lower: number; upper: number; mean: number };
		secondOrderTokens: { lower: number; upper: number; mean: number };
		reworkRate: { lower: number; upper: number; mean: number };
	} {
		const zScore = 1.96; // Approximate for 95% confidence

		const firstOrderTokens = outcomes.map((o) => o.firstOrder.tokensUsed);
		const secondOrderTokens = outcomes.map((o) => o.secondOrder.totalTokens);
		const reworkRates = outcomes.map((o) => o.secondOrder.reworkAttempts);

		const calculateInterval = (values: number[]) => {
			const meanValue = mean(values);
			const std = standardDeviation(values);
			const margin = (zScore * std) / Math.sqrt(values.length);
			return {
				lower: meanValue - margin,
				upper: meanValue + margin,
				mean: meanValue,
			};
		};

		return {
			firstOrderTokens: calculateInterval(firstOrderTokens),
			secondOrderTokens: calculateInterval(secondOrderTokens),
			reworkRate: calculateInterval(reworkRates),
		};
	}
}
