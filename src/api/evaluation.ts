/**
 * Evaluation API Module
 *
 * Provides functions to access extraction benchmark data including
 * confusion matrices, quality metrics (precision, recall, F1), and
 * latency/cost statistics for the evaluation dashboard.
 *
 * @module api/evaluation
 */

import type { AggregatedMetrics, BenchmarkResult, SampleMetrics } from "../extraction-benchmark.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Confusion matrix data for a single extraction method
 */
export interface ConfusionMatrixData {
	/** Extraction method name */
	method: "pattern_matching" | "model_based";
	/** True positives (correct extractions) */
	truePositives: number;
	/** False positives (incorrect extractions) */
	falsePositives: number;
	/** False negatives (missed extractions) */
	falseNegatives: number;
}

/**
 * Complete confusion matrix response for both methods
 */
export interface ConfusionMatrixResponse {
	/** Pattern matching confusion matrix */
	patternMatching: ConfusionMatrixData;
	/** Model-based confusion matrix */
	modelBased: ConfusionMatrixData;
	/** Timestamp when benchmark was run */
	timestamp: string;
	/** Number of samples in the benchmark */
	sampleCount: number;
}

/**
 * Quality metrics for a single extraction method
 */
export interface QualityMetrics {
	/** Extraction method name */
	method: "pattern_matching" | "model_based";
	/** Precision: TP / (TP + FP) */
	precision: number;
	/** Recall: TP / (TP + FN) */
	recall: number;
	/** F1 Score: harmonic mean of precision and recall */
	f1: number;
	/** Number of samples processed */
	sampleCount: number;
}

/**
 * Latency statistics for a single extraction method
 */
export interface LatencyMetrics {
	/** Extraction method name */
	method: "pattern_matching" | "model_based";
	/** Average latency in milliseconds */
	avgLatencyMs: number;
	/** Median latency in milliseconds */
	medianLatencyMs: number;
	/** P95 latency in milliseconds */
	p95LatencyMs: number;
}

/**
 * Cost metrics for a single extraction method
 */
export interface CostMetrics {
	/** Extraction method name */
	method: "pattern_matching" | "model_based";
	/** Total cost in USD */
	totalCostUsd: number;
	/** Average cost per extraction in USD */
	avgCostUsd: number;
}

/**
 * Complete metrics response combining quality, latency, and cost
 */
export interface MetricsResponse {
	/** Quality metrics for both methods */
	quality: {
		patternMatching: QualityMetrics;
		modelBased: QualityMetrics;
	};
	/** Latency metrics for both methods */
	latency: {
		patternMatching: LatencyMetrics;
		modelBased: LatencyMetrics;
	};
	/** Cost metrics for both methods */
	cost: {
		patternMatching: CostMetrics;
		modelBased: CostMetrics;
	};
	/** Timestamp when benchmark was run */
	timestamp: string;
	/** Total benchmark duration in milliseconds */
	totalDurationMs: number;
}

/**
 * Per-sample metrics with method comparison
 */
export interface SampleMetricsResponse {
	/** Sample ID */
	sampleId: string;
	/** Pattern matching metrics for this sample */
	patternMatching: SampleMetrics;
	/** Model-based metrics for this sample */
	modelBased: SampleMetrics;
}

/**
 * Complete per-sample metrics response
 */
export interface PerSampleMetricsResponse {
	/** Array of sample-level metrics */
	samples: SampleMetricsResponse[];
	/** Timestamp when benchmark was run */
	timestamp: string;
	/** Number of samples */
	sampleCount: number;
}

// ============================================================================
// In-Memory Cache
// ============================================================================

/**
 * Last benchmark result (cached in memory)
 * In production, this would be persisted to disk or database
 */
let lastBenchmarkResult: BenchmarkResult | null = null;

/**
 * Store benchmark result for API access
 * Called after benchmark completes
 *
 * @param result - Benchmark result to cache
 */
export function setBenchmarkResult(result: BenchmarkResult): void {
	lastBenchmarkResult = result;
}

/**
 * Get cached benchmark result
 *
 * @returns Cached result or null if no benchmark has been run
 */
export function getBenchmarkResult(): BenchmarkResult | null {
	return lastBenchmarkResult;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get confusion matrix data for both extraction methods.
 * Returns TP, FP, FN counts aggregated across all samples.
 *
 * @returns Confusion matrix response or null if no benchmark data available
 *
 * @example
 * ```typescript
 * const matrix = getConfusionMatrix();
 * if (matrix) {
 *   console.log(`Pattern TP: ${matrix.patternMatching.truePositives}`);
 *   console.log(`Model TP: ${matrix.modelBased.truePositives}`);
 * }
 * ```
 */
export function getConfusionMatrix(): ConfusionMatrixResponse | null {
	if (!lastBenchmarkResult) {
		return null;
	}

	return {
		patternMatching: {
			method: "pattern_matching",
			truePositives: lastBenchmarkResult.patternMatching.totalTruePositives,
			falsePositives: lastBenchmarkResult.patternMatching.totalFalsePositives,
			falseNegatives: lastBenchmarkResult.patternMatching.totalFalseNegatives,
		},
		modelBased: {
			method: "model_based",
			truePositives: lastBenchmarkResult.modelBased.totalTruePositives,
			falsePositives: lastBenchmarkResult.modelBased.totalFalsePositives,
			falseNegatives: lastBenchmarkResult.modelBased.totalFalseNegatives,
		},
		timestamp: lastBenchmarkResult.timestamp.toISOString(),
		sampleCount: lastBenchmarkResult.sampleCount,
	};
}

/**
 * Get comprehensive metrics including quality, latency, and cost.
 * Combines precision/recall/F1, latency stats, and cost data.
 *
 * @returns Metrics response or null if no benchmark data available
 *
 * @example
 * ```typescript
 * const metrics = getMetrics();
 * if (metrics) {
 *   console.log(`Pattern F1: ${metrics.quality.patternMatching.f1.toFixed(3)}`);
 *   console.log(`Model Avg Latency: ${metrics.latency.modelBased.avgLatencyMs.toFixed(1)}ms`);
 * }
 * ```
 */
export function getMetrics(): MetricsResponse | null {
	if (!lastBenchmarkResult) {
		return null;
	}

	const pm = lastBenchmarkResult.patternMatching;
	const mb = lastBenchmarkResult.modelBased;

	return {
		quality: {
			patternMatching: {
				method: "pattern_matching",
				precision: pm.precision,
				recall: pm.recall,
				f1: pm.f1,
				sampleCount: pm.sampleCount,
			},
			modelBased: {
				method: "model_based",
				precision: mb.precision,
				recall: mb.recall,
				f1: mb.f1,
				sampleCount: mb.sampleCount,
			},
		},
		latency: {
			patternMatching: {
				method: "pattern_matching",
				avgLatencyMs: pm.avgLatencyMs,
				medianLatencyMs: pm.medianLatencyMs,
				p95LatencyMs: pm.p95LatencyMs,
			},
			modelBased: {
				method: "model_based",
				avgLatencyMs: mb.avgLatencyMs,
				medianLatencyMs: mb.medianLatencyMs,
				p95LatencyMs: mb.p95LatencyMs,
			},
		},
		cost: {
			patternMatching: {
				method: "pattern_matching",
				totalCostUsd: pm.totalCostUsd,
				avgCostUsd: pm.avgCostUsd,
			},
			modelBased: {
				method: "model_based",
				totalCostUsd: mb.totalCostUsd,
				avgCostUsd: mb.avgCostUsd,
			},
		},
		timestamp: lastBenchmarkResult.timestamp.toISOString(),
		totalDurationMs: lastBenchmarkResult.totalDurationMs,
	};
}

/**
 * Get per-sample metrics with method comparison.
 * Returns individual precision/recall/F1 for each sample,
 * enabling detailed analysis of method performance.
 *
 * @returns Per-sample metrics response or null if no benchmark data available
 *
 * @example
 * ```typescript
 * const perSample = getPerSampleMetrics();
 * if (perSample) {
 *   for (const sample of perSample.samples) {
 *     console.log(`Sample ${sample.sampleId}:`);
 *     console.log(`  Pattern F1: ${sample.patternMatching.f1.toFixed(3)}`);
 *     console.log(`  Model F1: ${sample.modelBased.f1.toFixed(3)}`);
 *   }
 * }
 * ```
 */
export function getPerSampleMetrics(): PerSampleMetricsResponse | null {
	if (!lastBenchmarkResult) {
		return null;
	}

	const pm = lastBenchmarkResult.patternMatching.perSampleMetrics;
	const mb = lastBenchmarkResult.modelBased.perSampleMetrics;

	// Create map for quick lookup
	const pmMap = new Map(pm.map((m) => [m.sampleId, m]));
	const mbMap = new Map(mb.map((m) => [m.sampleId, m]));

	// Get all unique sample IDs
	const allSampleIds = new Set([...pm.map((m) => m.sampleId), ...mb.map((m) => m.sampleId)]);

	const samples: SampleMetricsResponse[] = [];
	for (const sampleId of allSampleIds) {
		const pmMetrics = pmMap.get(sampleId);
		const mbMetrics = mbMap.get(sampleId);

		// Both methods should have metrics for the same samples
		// If not, create zero metrics as fallback
		samples.push({
			sampleId,
			patternMatching: pmMetrics ?? {
				sampleId,
				truePositives: 0,
				falsePositives: 0,
				falseNegatives: 0,
				precision: 0,
				recall: 0,
				f1: 0,
			},
			modelBased: mbMetrics ?? {
				sampleId,
				truePositives: 0,
				falsePositives: 0,
				falseNegatives: 0,
				precision: 0,
				recall: 0,
				f1: 0,
			},
		});
	}

	return {
		samples,
		timestamp: lastBenchmarkResult.timestamp.toISOString(),
		sampleCount: samples.length,
	};
}

/**
 * Get method comparison summary.
 * Provides side-by-side comparison of both methods for quick analysis.
 *
 * @returns Comparison data or null if no benchmark data available
 *
 * @example
 * ```typescript
 * const comparison = getMethodComparison();
 * if (comparison) {
 *   console.log('Pattern vs Model:');
 *   console.log(`F1: ${comparison.patternMatching.f1} vs ${comparison.modelBased.f1}`);
 *   console.log(`Cost: $${comparison.patternMatching.totalCost} vs $${comparison.modelBased.totalCost}`);
 * }
 * ```
 */
export function getMethodComparison(): {
	patternMatching: AggregatedMetrics;
	modelBased: AggregatedMetrics;
	timestamp: string;
} | null {
	if (!lastBenchmarkResult) {
		return null;
	}

	return {
		patternMatching: lastBenchmarkResult.patternMatching,
		modelBased: lastBenchmarkResult.modelBased,
		timestamp: lastBenchmarkResult.timestamp.toISOString(),
	};
}
