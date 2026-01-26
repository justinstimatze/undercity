/**
 * Extraction Benchmark Module
 *
 * Parallel test harness for comparing pattern-matching vs model-based extraction.
 * Executes both methods concurrently and collects comprehensive metrics including
 * precision, recall, F1 score, latency, and cost.
 *
 * @module extraction-benchmark
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { sessionLogger } from "./logger.js";
import type { ExtractionSample, ExtractionType, GroundTruthItem } from "./test-data/extraction-samples.js";
import { MODEL_NAMES } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * A single extracted item from an extraction method
 */
export interface ExtractedItem {
	/** Type of extraction */
	type: ExtractionType;
	/** Extracted value */
	value: string;
}

/**
 * Result from a single extraction run
 */
export interface ExtractionResult {
	/** Sample ID that was processed */
	sampleId: string;
	/** Items extracted from the input */
	extracted: ExtractedItem[];
	/** Execution latency in milliseconds */
	latencyMs: number;
	/** Estimated cost in USD (for model-based only) */
	costUsd: number;
	/** Token usage (for model-based only) */
	tokens?: {
		input: number;
		output: number;
	};
	/** Any error that occurred */
	error?: string;
}

/**
 * Precision, recall, and F1 metrics for a single sample
 */
export interface SampleMetrics {
	/** Sample ID */
	sampleId: string;
	/** True positives (correct extractions) */
	truePositives: number;
	/** False positives (incorrect extractions) */
	falsePositives: number;
	/** False negatives (missed extractions) */
	falseNegatives: number;
	/** Precision: TP / (TP + FP) */
	precision: number;
	/** Recall: TP / (TP + FN) */
	recall: number;
	/** F1 Score: 2 * P * R / (P + R) */
	f1: number;
}

/**
 * Aggregated metrics across all samples for one extraction method
 */
export interface AggregatedMetrics {
	/** Method name */
	method: "pattern_matching" | "model_based";
	/** Number of samples processed */
	sampleCount: number;
	/** Micro-averaged precision (sum TP / sum(TP + FP)) */
	precision: number;
	/** Micro-averaged recall (sum TP / sum(TP + FN)) */
	recall: number;
	/** Micro-averaged F1 score */
	f1: number;
	/** Average latency in milliseconds */
	avgLatencyMs: number;
	/** Median latency in milliseconds */
	medianLatencyMs: number;
	/** P95 latency in milliseconds */
	p95LatencyMs: number;
	/** Total cost in USD */
	totalCostUsd: number;
	/** Average cost per extraction in USD */
	avgCostUsd: number;
	/** Per-sample metrics */
	perSampleMetrics: SampleMetrics[];
	/** Total true positives */
	totalTruePositives: number;
	/** Total false positives */
	totalFalsePositives: number;
	/** Total false negatives */
	totalFalseNegatives: number;
}

/**
 * Complete benchmark comparison result
 */
export interface BenchmarkResult {
	/** Pattern matching metrics */
	patternMatching: AggregatedMetrics;
	/** Model-based metrics */
	modelBased: AggregatedMetrics;
	/** Timestamp when benchmark was run */
	timestamp: Date;
	/** Total benchmark duration in milliseconds */
	totalDurationMs: number;
	/** Number of samples processed */
	sampleCount: number;
}

/**
 * Configuration for the benchmark harness
 */
export interface BenchmarkConfig {
	/** Whether to run model-based extraction (default: true) */
	runModelBased: boolean;
	/** Whether to run pattern matching (default: true) */
	runPatternMatching: boolean;
	/** Cost per 1M input tokens in USD */
	inputTokenCostPer1M: number;
	/** Cost per 1M output tokens in USD */
	outputTokenCostPer1M: number;
	/** Model to use for model-based extraction */
	model: "sonnet" | "opus";
}

/**
 * Default benchmark configuration
 */
export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
	runModelBased: true,
	runPatternMatching: true,
	inputTokenCostPer1M: 3.0, // Sonnet input cost
	outputTokenCostPer1M: 15.0, // Sonnet output cost
	model: "sonnet",
};

// ============================================================================
// Pattern-Based Extraction
// ============================================================================

/**
 * Pattern definitions for different extraction types
 */
const EXTRACTION_PATTERNS: Record<ExtractionType, RegExp[]> = {
	file_path: [
		// Unix-style paths with extensions
		/(?:^|[\s"'`(])([./]?(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z]+)/gm,
		// Windows-style paths
		/([A-Z]:\\(?:[a-zA-Z0-9_.-]+\\)+[a-zA-Z0-9_.-]+\.[a-zA-Z]+)/gm,
		// Path in parentheses like (file.ts:10:5)
		/\(([a-zA-Z0-9_./-]+\.[a-zA-Z]+)(?::\d+){0,2}\)/gm,
		// Path before line:col like src/file.ts:10:5
		/(?:^|[\s])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,4})(?::\d+|\(\d+)/gm,
	],
	error_code: [
		// TypeScript errors (TS1234)
		/\b(TS\d{4,5})\b/g,
		// ESLint rules (@scope/rule-name or rule-name)
		/\((@[a-z-]+\/[a-z-]+|[a-z-]+\/[a-z-]+)\)/g,
		// CVE codes
		/(CVE-\d{4}-\d{4,})/g,
		// Error codes like ENOENT, ECONNREFUSED
		/\b(E[A-Z]{4,})\b/g,
	],
	line_number: [
		// Line number after colon (file.ts:123)
		/:(\d+)(?::\d+)?(?:\)|$|\s)/gm,
		// Line in parentheses (123,45)
		/\((\d+),\d+\)/g,
		// "line X" pattern
		/\bline\s+(\d+)\b/gi,
	],
	variable_name: [
		// Quoted variable names
		/'([a-zA-Z_$][a-zA-Z0-9_$]*)'/g,
		// Property names after "Property"
		/Property\s+['"]?([a-zA-Z_$][a-zA-Z0-9_$]*)['"]?/g,
	],
	function_name: [
		// Function name in stack trace (at functionName)
		/at\s+(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$.]*)\s*\(/gm,
		// Function definitions
		/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
		// Method references like obj.method
		/\b([a-zA-Z_$][a-zA-Z0-9_$]*\.[a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
		// Function name before ">"
		/>\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s+>/g,
	],
	type_name: [
		// Type after colon (param: Type)
		/:\s*([A-Z][a-zA-Z0-9_]*)/g,
		// Generic types like Promise<T>
		/\b([A-Z][a-zA-Z0-9_]*)<[^>]+>/g,
		// Type in quotes from error messages
		/type\s+'([A-Z]?[a-zA-Z0-9_]+)'/gi,
	],
	module_name: [
		// npm package names with @ scope
		/(@[a-z0-9-]+\/[a-z0-9-]+)/g,
		// Package name with version
		/([a-z0-9-]+)@[\d.^~]+/g,
		// Relative imports
		/from\s+['"]([./][^'"]+)['"]/g,
		// Module in quotes
		/module\s+['"]([^'"]+)['"]/g,
		// Cannot find module
		/Cannot find module\s+['"]([^'"]+)['"]/g,
		// Can't resolve
		/Can't resolve\s+['"]([^'"]+)['"]/g,
	],
	error_message: [
		// Error message after colon
		/Error:\s*(.+?)(?:\n|$)/g,
	],
	command: [
		// Shell commands after "Running:" or similar
		/(?:Running|Executing|run):\s*([a-z]+ [^\n]+)/gi,
		// npm/pnpm/yarn commands
		/((?:npm|pnpm|yarn|npx)\s+[a-z]+(?:\s+[^\s]+)*)/g,
	],
	url: [
		// HTTP(S) URLs
		/(https?:\/\/[^\s"'<>]+)/g,
		// Email addresses
		/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
	],
	version: [
		// Semver with optional prefix
		/[@]?([\d]+\.[\d]+\.[\d]+(?:-[a-zA-Z0-9.]+)?)/g,
		// Version with caret/tilde
		/([\^~]?[\d]+\.[\d]+\.[\d]+)/g,
	],
};

/**
 * Extract items from text using pattern matching.
 * Fast, deterministic approach using regex patterns.
 *
 * @param input - The text to extract from
 * @returns Array of extracted items
 *
 * @example
 * ```typescript
 * const items = patternMatchingExtract("Error in src/file.ts:42");
 * // Returns: [
 * //   { type: "file_path", value: "src/file.ts" },
 * //   { type: "line_number", value: "42" }
 * // ]
 * ```
 */
export function patternMatchingExtract(input: string): ExtractedItem[] {
	const extracted: ExtractedItem[] = [];
	const seen = new Set<string>();

	for (const [type, patterns] of Object.entries(EXTRACTION_PATTERNS)) {
		for (const pattern of patterns) {
			// Reset regex state for global patterns
			pattern.lastIndex = 0;

			let match = pattern.exec(input);
			while (match !== null) {
				const value = match[1];
				if (value) {
					const key = `${type}:${value}`;
					if (!seen.has(key)) {
						seen.add(key);
						extracted.push({
							type: type as ExtractionType,
							value: value.trim(),
						});
					}
				}
				match = pattern.exec(input);
			}
		}
	}

	return extracted;
}

// ============================================================================
// Model-Based Extraction
// ============================================================================

/**
 * Prompt for model-based extraction
 */
const MODEL_EXTRACTION_PROMPT = `Extract structured information from the following text.

Return a JSON array of extractions. Each extraction should have:
- type: One of "file_path", "error_code", "line_number", "variable_name", "function_name", "type_name", "module_name", "error_message", "command", "url", "version"
- value: The extracted value (exact text from input)

Focus on extracting:
1. File paths (relative or absolute paths to files)
2. Error codes (TS errors, CVE, etc.)
3. Line numbers (from error locations)
4. Variable and function names (from errors or code)
5. Type names (TypeScript types)
6. Module names (npm packages, imports)
7. Commands (shell commands)
8. URLs and email addresses
9. Version numbers

Return ONLY the JSON array, no other text. If nothing to extract, return [].

TEXT:
`;

/**
 * Schema for model extraction response
 */
interface ModelExtractionResponse {
	type: ExtractionType;
	value: string;
}

/**
 * Extract items from text using Claude model.
 * More accurate, handles nuance, but slower and costs money.
 *
 * @param input - The text to extract from
 * @param config - Benchmark configuration
 * @returns Extraction result with items, latency, and cost
 *
 * @example
 * ```typescript
 * const result = await modelBasedExtract("Error in src/file.ts:42", config);
 * console.log(`Extracted ${result.extracted.length} items in ${result.latencyMs}ms`);
 * console.log(`Cost: $${result.costUsd.toFixed(4)}`);
 * ```
 */
export async function modelBasedExtract(
	input: string,
	config: BenchmarkConfig = DEFAULT_BENCHMARK_CONFIG,
): Promise<ExtractionResult> {
	const startTime = performance.now();
	const prompt = MODEL_EXTRACTION_PROMPT + input;

	try {
		let result = "";
		let inputTokens = 0;
		let outputTokens = 0;

		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES[config.model],
				maxTurns: 1,
				permissionMode: "bypassPermissions",
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
			// Estimate tokens from message content
			// In real usage, these would come from API response
			if (message.type === "assistant") {
				outputTokens += Math.ceil((result?.length ?? 0) / 4);
			}
		}

		// Estimate input tokens (rough approximation)
		inputTokens = Math.ceil(prompt.length / 4);

		const latencyMs = performance.now() - startTime;

		// Parse JSON response
		const jsonMatch = result.match(/\[[\s\S]*\]/);
		if (!jsonMatch) {
			return {
				sampleId: "",
				extracted: [],
				latencyMs,
				costUsd: calculateCost(inputTokens, outputTokens, config),
				tokens: { input: inputTokens, output: outputTokens },
			};
		}

		const parsed = JSON.parse(jsonMatch[0]) as ModelExtractionResponse[];
		const extracted: ExtractedItem[] = parsed
			.filter((item) => item.type && item.value)
			.map((item) => ({
				type: item.type,
				value: item.value.trim(),
			}));

		return {
			sampleId: "",
			extracted,
			latencyMs,
			costUsd: calculateCost(inputTokens, outputTokens, config),
			tokens: { input: inputTokens, output: outputTokens },
		};
	} catch (error) {
		const latencyMs = performance.now() - startTime;
		return {
			sampleId: "",
			extracted: [],
			latencyMs,
			costUsd: 0,
			error: String(error),
		};
	}
}

/**
 * Calculate cost based on token usage
 *
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param config - Benchmark configuration with costs
 * @returns Cost in USD
 */
function calculateCost(inputTokens: number, outputTokens: number, config: BenchmarkConfig): number {
	const inputCost = (inputTokens / 1_000_000) * config.inputTokenCostPer1M;
	const outputCost = (outputTokens / 1_000_000) * config.outputTokenCostPer1M;
	return inputCost + outputCost;
}

// ============================================================================
// Metrics Calculation
// ============================================================================

/**
 * Calculate precision, recall, and F1 for a single sample by comparing
 * extracted items against ground truth.
 *
 * Uses exact match on (type, value) pairs. A match occurs when both the
 * extraction type and value match exactly.
 *
 * @param extracted - Items extracted by the method
 * @param groundTruth - Expected items from the test sample
 * @returns Metrics including TP, FP, FN, precision, recall, F1
 *
 * @example
 * ```typescript
 * const metrics = calculateSampleMetrics(
 *   [{ type: "file_path", value: "src/file.ts" }],
 *   [{ type: "file_path", value: "src/file.ts" }, { type: "line_number", value: "42" }]
 * );
 * console.log(`Precision: ${metrics.precision}, Recall: ${metrics.recall}, F1: ${metrics.f1}`);
 * // Output: Precision: 1.0, Recall: 0.5, F1: 0.667
 * ```
 */
export function calculateSampleMetrics(extracted: ExtractedItem[], groundTruth: GroundTruthItem[]): SampleMetrics {
	// Create sets for comparison
	const extractedSet = new Set(extracted.map((e) => `${e.type}:${e.value}`));
	const groundTruthSet = new Set(groundTruth.map((g) => `${g.type}:${g.value}`));

	// Calculate TP, FP, FN
	let truePositives = 0;
	let falsePositives = 0;
	let falseNegatives = 0;

	// TP: extracted items that are in ground truth
	// FP: extracted items not in ground truth
	for (const key of extractedSet) {
		if (groundTruthSet.has(key)) {
			truePositives++;
		} else {
			falsePositives++;
		}
	}

	// FN: ground truth items not extracted
	for (const key of groundTruthSet) {
		if (!extractedSet.has(key)) {
			falseNegatives++;
		}
	}

	// Calculate metrics
	const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;

	const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;

	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

	return {
		sampleId: "",
		truePositives,
		falsePositives,
		falseNegatives,
		precision,
		recall,
		f1,
	};
}

/**
 * Calculate aggregated metrics across multiple samples.
 * Uses micro-averaging (sums across all samples).
 *
 * @param results - Array of extraction results
 * @param samples - Original samples with ground truth
 * @param method - Name of the extraction method
 * @returns Aggregated metrics including precision, recall, F1, latency stats, costs
 *
 * @example
 * ```typescript
 * const aggregated = aggregateMetrics(patternResults, samples, "pattern_matching");
 * console.log(`F1: ${aggregated.f1.toFixed(3)}, Avg Latency: ${aggregated.avgLatencyMs.toFixed(1)}ms`);
 * ```
 */
export function aggregateMetrics(
	results: ExtractionResult[],
	samples: ExtractionSample[],
	method: "pattern_matching" | "model_based",
): AggregatedMetrics {
	const perSampleMetrics: SampleMetrics[] = [];
	let totalTP = 0;
	let totalFP = 0;
	let totalFN = 0;
	const latencies: number[] = [];
	let totalCost = 0;

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const sample = samples.find((s) => s.id === result.sampleId);
		if (!sample) continue;

		const metrics = calculateSampleMetrics(result.extracted, sample.groundTruth);
		metrics.sampleId = sample.id;

		perSampleMetrics.push(metrics);
		totalTP += metrics.truePositives;
		totalFP += metrics.falsePositives;
		totalFN += metrics.falseNegatives;
		latencies.push(result.latencyMs);
		totalCost += result.costUsd;
	}

	// Sort latencies for percentile calculation
	latencies.sort((a, b) => a - b);

	const precision = totalTP + totalFP > 0 ? totalTP / (totalTP + totalFP) : 0;
	const recall = totalTP + totalFN > 0 ? totalTP / (totalTP + totalFN) : 0;
	const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

	const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
	const medianLatency = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : 0;
	const p95Index = Math.ceil(latencies.length * 0.95) - 1;
	const p95Latency = latencies.length > 0 ? latencies[Math.max(0, p95Index)] : 0;

	return {
		method,
		sampleCount: results.length,
		precision,
		recall,
		f1,
		avgLatencyMs: avgLatency,
		medianLatencyMs: medianLatency,
		p95LatencyMs: p95Latency,
		totalCostUsd: totalCost,
		avgCostUsd: results.length > 0 ? totalCost / results.length : 0,
		perSampleMetrics,
		totalTruePositives: totalTP,
		totalFalsePositives: totalFP,
		totalFalseNegatives: totalFN,
	};
}

// ============================================================================
// Benchmark Harness
// ============================================================================

/**
 * Run the parallel benchmark comparing pattern-matching and model-based extraction.
 *
 * Executes both methods concurrently on the same input dataset and collects
 * comprehensive metrics including precision, recall, F1 score, latency, and cost.
 *
 * @param samples - Test samples with ground truth labels
 * @param config - Benchmark configuration (optional)
 * @returns Complete benchmark comparison result
 *
 * @example
 * ```typescript
 * import { EXTRACTION_SAMPLES } from "./test-data/extraction-samples.js";
 * import { runBenchmark, formatBenchmarkReport } from "./extraction-benchmark.js";
 *
 * const result = await runBenchmark(EXTRACTION_SAMPLES);
 * console.log(formatBenchmarkReport(result));
 * ```
 */
export async function runBenchmark(
	samples: ExtractionSample[],
	config: BenchmarkConfig = DEFAULT_BENCHMARK_CONFIG,
): Promise<BenchmarkResult> {
	const startTime = performance.now();
	sessionLogger.info({ sampleCount: samples.length }, "Starting extraction benchmark");

	// Run pattern matching (synchronous, fast)
	const patternResults: ExtractionResult[] = [];
	if (config.runPatternMatching) {
		for (const sample of samples) {
			const startMs = performance.now();
			const extracted = patternMatchingExtract(sample.input);
			const latencyMs = performance.now() - startMs;

			patternResults.push({
				sampleId: sample.id,
				extracted,
				latencyMs,
				costUsd: 0, // Pattern matching has no API cost
			});
		}
	}

	// Run model-based extraction (async, parallel across samples)
	const modelResults: ExtractionResult[] = [];
	if (config.runModelBased) {
		// Process samples in parallel using Promise.all
		const modelPromises = samples.map(async (sample) => {
			const result = await modelBasedExtract(sample.input, config);
			result.sampleId = sample.id;
			return result;
		});

		const results = await Promise.all(modelPromises);
		modelResults.push(...results);
	}

	// Aggregate metrics
	const patternMetrics = aggregateMetrics(patternResults, samples, "pattern_matching");
	const modelMetrics = aggregateMetrics(modelResults, samples, "model_based");

	const totalDurationMs = performance.now() - startTime;

	sessionLogger.info(
		{
			totalDurationMs: Math.round(totalDurationMs),
			patternF1: patternMetrics.f1.toFixed(3),
			modelF1: modelMetrics.f1.toFixed(3),
		},
		"Extraction benchmark complete",
	);

	return {
		patternMatching: patternMetrics,
		modelBased: modelMetrics,
		timestamp: new Date(),
		totalDurationMs,
		sampleCount: samples.length,
	};
}

/**
 * Format benchmark results as a human-readable report.
 *
 * @param result - Benchmark result to format
 * @returns Formatted string report
 *
 * @example
 * ```typescript
 * const report = formatBenchmarkReport(benchmarkResult);
 * console.log(report);
 * ```
 */
export function formatBenchmarkReport(result: BenchmarkResult): string {
	const lines: string[] = [];

	lines.push("=".repeat(70));
	lines.push("EXTRACTION BENCHMARK REPORT");
	lines.push("=".repeat(70));
	lines.push(`Timestamp: ${result.timestamp.toISOString()}`);
	lines.push(`Samples: ${result.sampleCount}`);
	lines.push(`Total Duration: ${result.totalDurationMs.toFixed(0)}ms`);
	lines.push("");

	lines.push("-".repeat(70));
	lines.push("COMPARISON SUMMARY");
	lines.push("-".repeat(70));
	lines.push("");
	lines.push(`${"Metric".padEnd(20)} ${"Pattern Matching".padEnd(20)} ${"Model-Based".padEnd(20)}`);
	lines.push("-".repeat(60));
	lines.push(
		`${"Precision".padEnd(20)} ${result.patternMatching.precision.toFixed(3).padEnd(20)} ${result.modelBased.precision.toFixed(3).padEnd(20)}`,
	);
	lines.push(
		`${"Recall".padEnd(20)} ${result.patternMatching.recall.toFixed(3).padEnd(20)} ${result.modelBased.recall.toFixed(3).padEnd(20)}`,
	);
	lines.push(
		`${"F1 Score".padEnd(20)} ${result.patternMatching.f1.toFixed(3).padEnd(20)} ${result.modelBased.f1.toFixed(3).padEnd(20)}`,
	);
	lines.push(
		`${"Avg Latency (ms)".padEnd(20)} ${result.patternMatching.avgLatencyMs.toFixed(1).padEnd(20)} ${result.modelBased.avgLatencyMs.toFixed(1).padEnd(20)}`,
	);
	lines.push(
		`${"P95 Latency (ms)".padEnd(20)} ${result.patternMatching.p95LatencyMs.toFixed(1).padEnd(20)} ${result.modelBased.p95LatencyMs.toFixed(1).padEnd(20)}`,
	);
	lines.push(
		`${"Total Cost ($)".padEnd(20)} ${result.patternMatching.totalCostUsd.toFixed(4).padEnd(20)} ${result.modelBased.totalCostUsd.toFixed(4).padEnd(20)}`,
	);
	lines.push("");

	lines.push("-".repeat(70));
	lines.push("CONFUSION MATRIX (Aggregated)");
	lines.push("-".repeat(70));
	lines.push("");
	lines.push("Pattern Matching:");
	lines.push(`  True Positives:  ${result.patternMatching.totalTruePositives}`);
	lines.push(`  False Positives: ${result.patternMatching.totalFalsePositives}`);
	lines.push(`  False Negatives: ${result.patternMatching.totalFalseNegatives}`);
	lines.push("");
	lines.push("Model-Based:");
	lines.push(`  True Positives:  ${result.modelBased.totalTruePositives}`);
	lines.push(`  False Positives: ${result.modelBased.totalFalsePositives}`);
	lines.push(`  False Negatives: ${result.modelBased.totalFalseNegatives}`);
	lines.push("");

	lines.push("=".repeat(70));

	return lines.join("\n");
}

/**
 * Format benchmark results as JSON for programmatic consumption.
 *
 * @param result - Benchmark result to format
 * @returns JSON string with benchmark data
 *
 * @example
 * ```typescript
 * const json = formatBenchmarkJson(benchmarkResult);
 * fs.writeFileSync("benchmark-results.json", json);
 * ```
 */
export function formatBenchmarkJson(result: BenchmarkResult): string {
	return JSON.stringify(
		{
			timestamp: result.timestamp.toISOString(),
			sampleCount: result.sampleCount,
			totalDurationMs: result.totalDurationMs,
			comparison: {
				patternMatching: {
					precision: result.patternMatching.precision,
					recall: result.patternMatching.recall,
					f1: result.patternMatching.f1,
					avgLatencyMs: result.patternMatching.avgLatencyMs,
					medianLatencyMs: result.patternMatching.medianLatencyMs,
					p95LatencyMs: result.patternMatching.p95LatencyMs,
					totalCostUsd: result.patternMatching.totalCostUsd,
					truePositives: result.patternMatching.totalTruePositives,
					falsePositives: result.patternMatching.totalFalsePositives,
					falseNegatives: result.patternMatching.totalFalseNegatives,
				},
				modelBased: {
					precision: result.modelBased.precision,
					recall: result.modelBased.recall,
					f1: result.modelBased.f1,
					avgLatencyMs: result.modelBased.avgLatencyMs,
					medianLatencyMs: result.modelBased.medianLatencyMs,
					p95LatencyMs: result.modelBased.p95LatencyMs,
					totalCostUsd: result.modelBased.totalCostUsd,
					truePositives: result.modelBased.totalTruePositives,
					falsePositives: result.modelBased.totalFalsePositives,
					falseNegatives: result.modelBased.totalFalseNegatives,
				},
			},
			perSampleMetrics: {
				patternMatching: result.patternMatching.perSampleMetrics,
				modelBased: result.modelBased.perSampleMetrics,
			},
		},
		null,
		2,
	);
}
