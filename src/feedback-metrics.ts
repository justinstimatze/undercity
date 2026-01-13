/**
 * Feedback Metrics Reader
 *
 * Reads metrics.jsonl for data-driven routing decisions.
 *
 * | Output               | Description                              |
 * |----------------------|------------------------------------------|
 * | Success rates        | By model tier, complexity, combinations  |
 * | Escalation stats     | Paths, costs, success after escalation   |
 * | Error patterns       | Categorized failure modes                |
 * | Recommendations      | Actionable routing adjustments           |
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComplexityLevel } from "./complexity.js";
import type { AttemptRecord } from "./types.js";

const METRICS_FILE = ".undercity/metrics.jsonl";

/**
 * Model tier for routing
 */
export type ModelTier = "haiku" | "sonnet" | "opus";

/**
 * Success rate statistics for a group
 */
export interface SuccessStats {
	total: number;
	successful: number;
	failed: number;
	rate: number;
	avgDurationMs: number;
	avgTokens: number;
}

/**
 * Escalation statistics
 */
export interface EscalationStats {
	totalEscalated: number;
	escalationRate: number;
	successAfterEscalation: number;
	successRateAfterEscalation: number;
	avgEscalationCost: number; // extra tokens used due to escalation
	byPath: Record<string, { count: number; successCount: number }>; // e.g., "haiku->sonnet"
}

/**
 * Error pattern statistics
 */
export interface ErrorPatternStats {
	category: string;
	count: number;
	percentage: number;
}

/**
 * Complete metrics analysis result
 */
export interface MetricsAnalysis {
	totalTasks: number;
	overallSuccessRate: number;
	byModel: Record<ModelTier, SuccessStats>;
	byComplexity: Record<ComplexityLevel, SuccessStats>;
	byModelAndComplexity: Record<string, SuccessStats>; // "haiku:simple"
	escalation: EscalationStats;
	errorPatterns: ErrorPatternStats[];
	routingAccuracy: {
		correctTier: number; // task succeeded at starting tier
		needsEscalation: number; // task needed escalation
		overProvisioned: number; // task succeeded but could have used lower tier (estimated)
	};
	recommendations: string[];
	analyzedAt: Date;
	oldestRecord: Date | null;
	newestRecord: Date | null;
}

/**
 * Parsed metrics record from JSONL
 * Supports both old format (questId) and new format (taskId)
 */
interface ParsedMetricsRecord {
	taskId: string;
	objective: string;
	success: boolean;
	durationMs: number;
	totalTokens: number;
	startedAt: Date;
	completedAt: Date;
	finalModel?: ModelTier;
	startingModel?: ModelTier;
	complexityLevel?: ComplexityLevel;
	wasEscalated?: boolean;
	attempts?: AttemptRecord[];
	error?: string;
}

/**
 * Options for loading metrics
 */
export interface LoadMetricsOptions {
	path?: string;
	since?: Date; // Only include records after this date
	limit?: number; // Only include last N records
}

/**
 * Load and parse metrics from the JSONL file
 */
export function loadMetrics(options?: LoadMetricsOptions | string): ParsedMetricsRecord[] {
	// Handle backward compatibility with string path
	const opts: LoadMetricsOptions = typeof options === "string" ? { path: options } : (options ?? {});
	const metricsPath = opts.path ?? join(process.cwd(), METRICS_FILE);

	if (!existsSync(metricsPath)) {
		return [];
	}

	const content = readFileSync(metricsPath, "utf-8");
	const lines = content.split("\n").filter((line) => line.trim());
	let records: ParsedMetricsRecord[] = [];

	for (const line of lines) {
		try {
			const raw = JSON.parse(line) as Record<string, unknown>;

			// Handle both old format (questId) and new format (taskId)
			const taskId = (raw.taskId as string) || (raw.questId as string) || "unknown";

			const record: ParsedMetricsRecord = {
				taskId,
				objective: (raw.objective as string) || "",
				success: Boolean(raw.success),
				durationMs: (raw.durationMs as number) || 0,
				totalTokens: (raw.totalTokens as number) || 0,
				startedAt: raw.startedAt ? new Date(raw.startedAt as string) : new Date(),
				completedAt: raw.completedAt ? new Date(raw.completedAt as string) : new Date(),
				finalModel: raw.finalModel as ModelTier | undefined,
				startingModel: raw.startingModel as ModelTier | undefined,
				complexityLevel: raw.complexityLevel as ComplexityLevel | undefined,
				wasEscalated: raw.wasEscalated as boolean | undefined,
				attempts: raw.attempts as AttemptRecord[] | undefined,
				error: raw.error as string | undefined,
			};

			records.push(record);
		} catch {
			// Skip malformed lines
		}
	}

	// Apply date filter
	if (opts.since) {
		records = records.filter((r) => r.startedAt >= opts.since!);
	}

	// Apply limit (most recent N)
	if (opts.limit && records.length > opts.limit) {
		records = records.slice(-opts.limit);
	}

	return records;
}

/**
 * Create empty success stats
 */
function emptyStats(): SuccessStats {
	return {
		total: 0,
		successful: 0,
		failed: 0,
		rate: 0,
		avgDurationMs: 0,
		avgTokens: 0,
	};
}

/**
 * Finalize stats by computing averages
 */
function finalizeStats(stats: SuccessStats, durations: number[], tokens: number[]): void {
	stats.rate = stats.total > 0 ? stats.successful / stats.total : 0;
	stats.avgDurationMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
	stats.avgTokens = tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0;
}

/**
 * Analyze metrics and compute success rates
 */
export function analyzeMetrics(records: ParsedMetricsRecord[]): MetricsAnalysis {
	const analysis: MetricsAnalysis = {
		totalTasks: records.length,
		overallSuccessRate: 0,
		byModel: {
			haiku: emptyStats(),
			sonnet: emptyStats(),
			opus: emptyStats(),
		},
		byComplexity: {
			trivial: emptyStats(),
			simple: emptyStats(),
			standard: emptyStats(),
			complex: emptyStats(),
			critical: emptyStats(),
		},
		byModelAndComplexity: {},
		escalation: {
			totalEscalated: 0,
			escalationRate: 0,
			successAfterEscalation: 0,
			successRateAfterEscalation: 0,
			avgEscalationCost: 0,
			byPath: {},
		},
		errorPatterns: [],
		routingAccuracy: {
			correctTier: 0,
			needsEscalation: 0,
			overProvisioned: 0,
		},
		recommendations: [],
		analyzedAt: new Date(),
		oldestRecord: null,
		newestRecord: null,
	};

	if (records.length === 0) {
		return analysis;
	}

	// Track data for aggregation
	const modelDurations: Record<ModelTier, number[]> = { haiku: [], sonnet: [], opus: [] };
	const modelTokens: Record<ModelTier, number[]> = { haiku: [], sonnet: [], opus: [] };
	const complexityDurations: Record<ComplexityLevel, number[]> = {
		trivial: [],
		simple: [],
		standard: [],
		complex: [],
		critical: [],
	};
	const complexityTokens: Record<ComplexityLevel, number[]> = {
		trivial: [],
		simple: [],
		standard: [],
		complex: [],
		critical: [],
	};
	const combinedDurations: Record<string, number[]> = {};
	const combinedTokens: Record<string, number[]> = {};
	const errorCounts: Record<string, number> = {};
	const escalationCosts: number[] = [];
	let totalSuccessful = 0;

	for (const record of records) {
		// Track date range
		if (!analysis.oldestRecord || record.startedAt < analysis.oldestRecord) {
			analysis.oldestRecord = record.startedAt;
		}
		if (!analysis.newestRecord || record.completedAt > analysis.newestRecord) {
			analysis.newestRecord = record.completedAt;
		}

		// Overall success
		if (record.success) totalSuccessful++;

		// By final model
		const model = record.finalModel || "sonnet";
		analysis.byModel[model].total++;
		if (record.success) analysis.byModel[model].successful++;
		else analysis.byModel[model].failed++;
		modelDurations[model].push(record.durationMs);
		modelTokens[model].push(record.totalTokens);

		// By complexity
		const complexity = record.complexityLevel || "standard";
		analysis.byComplexity[complexity].total++;
		if (record.success) analysis.byComplexity[complexity].successful++;
		else analysis.byComplexity[complexity].failed++;
		complexityDurations[complexity].push(record.durationMs);
		complexityTokens[complexity].push(record.totalTokens);

		// By model+complexity combination
		const comboKey = `${model}:${complexity}`;
		if (!analysis.byModelAndComplexity[comboKey]) {
			analysis.byModelAndComplexity[comboKey] = emptyStats();
			combinedDurations[comboKey] = [];
			combinedTokens[comboKey] = [];
		}
		analysis.byModelAndComplexity[comboKey].total++;
		if (record.success) analysis.byModelAndComplexity[comboKey].successful++;
		else analysis.byModelAndComplexity[comboKey].failed++;
		combinedDurations[comboKey].push(record.durationMs);
		combinedTokens[comboKey].push(record.totalTokens);

		// Escalation tracking
		if (record.wasEscalated) {
			analysis.escalation.totalEscalated++;
			if (record.success) analysis.escalation.successAfterEscalation++;

			// Track escalation path
			if (record.startingModel && record.finalModel && record.startingModel !== record.finalModel) {
				const path = `${record.startingModel}->${record.finalModel}`;
				if (!analysis.escalation.byPath[path]) {
					analysis.escalation.byPath[path] = { count: 0, successCount: 0 };
				}
				analysis.escalation.byPath[path].count++;
				if (record.success) analysis.escalation.byPath[path].successCount++;
			}

			// Estimate escalation cost (extra tokens from failed attempts)
			if (record.attempts && record.attempts.length > 1) {
				const failedAttemptTokens = record.attempts
					.slice(0, -1)
					.filter((a) => !a.success)
					.reduce((sum, a) => sum + (a.durationMs > 0 ? record.totalTokens / record.attempts!.length : 0), 0);
				escalationCosts.push(failedAttemptTokens);
			}
		}

		// Routing accuracy
		if (!record.wasEscalated && record.success) {
			analysis.routingAccuracy.correctTier++;
		} else if (record.wasEscalated) {
			analysis.routingAccuracy.needsEscalation++;
		}

		// Error patterns from attempts
		if (record.attempts) {
			for (const attempt of record.attempts) {
				if (attempt.errorCategories) {
					for (const category of attempt.errorCategories) {
						errorCounts[category] = (errorCounts[category] || 0) + 1;
					}
				}
			}
		}
	}

	// Finalize stats
	analysis.overallSuccessRate = records.length > 0 ? totalSuccessful / records.length : 0;

	for (const model of ["haiku", "sonnet", "opus"] as ModelTier[]) {
		finalizeStats(analysis.byModel[model], modelDurations[model], modelTokens[model]);
	}

	for (const complexity of ["trivial", "simple", "standard", "complex", "critical"] as ComplexityLevel[]) {
		finalizeStats(analysis.byComplexity[complexity], complexityDurations[complexity], complexityTokens[complexity]);
	}

	for (const key of Object.keys(analysis.byModelAndComplexity)) {
		finalizeStats(analysis.byModelAndComplexity[key], combinedDurations[key], combinedTokens[key]);
	}

	// Escalation stats
	analysis.escalation.escalationRate = records.length > 0 ? analysis.escalation.totalEscalated / records.length : 0;
	analysis.escalation.successRateAfterEscalation =
		analysis.escalation.totalEscalated > 0
			? analysis.escalation.successAfterEscalation / analysis.escalation.totalEscalated
			: 0;
	analysis.escalation.avgEscalationCost =
		escalationCosts.length > 0 ? escalationCosts.reduce((a, b) => a + b, 0) / escalationCosts.length : 0;

	// Error patterns
	const totalErrors = Object.values(errorCounts).reduce((a, b) => a + b, 0);
	analysis.errorPatterns = Object.entries(errorCounts)
		.map(([category, count]) => ({
			category,
			count,
			percentage: totalErrors > 0 ? count / totalErrors : 0,
		}))
		.sort((a, b) => b.count - a.count);

	// Generate recommendations
	analysis.recommendations = generateRecommendations(analysis);

	return analysis;
}

/**
 * Generate actionable recommendations based on metrics analysis
 */
function generateRecommendations(analysis: MetricsAnalysis): string[] {
	const recommendations: string[] = [];

	// Check for model tier issues
	for (const model of ["haiku", "sonnet", "opus"] as ModelTier[]) {
		const stats = analysis.byModel[model];
		if (stats.total >= 5 && stats.rate < 0.5) {
			recommendations.push(
				`${model} has low success rate (${(stats.rate * 100).toFixed(0)}%). Consider escalating more tasks from ${model}.`,
			);
		}
	}

	// Check for high escalation rate
	if (analysis.escalation.escalationRate > 0.3 && analysis.totalTasks >= 10) {
		recommendations.push(
			`High escalation rate (${(analysis.escalation.escalationRate * 100).toFixed(0)}%). Routing may be too aggressive.`,
		);
	}

	// Check for low escalation success rate
	if (analysis.escalation.totalEscalated >= 5 && analysis.escalation.successRateAfterEscalation < 0.6) {
		recommendations.push(
			`Escalation success rate is low (${(analysis.escalation.successRateAfterEscalation * 100).toFixed(0)}%). Tasks may be fundamentally difficult.`,
		);
	}

	// Check for complexity-specific issues
	for (const complexity of ["trivial", "simple"] as ComplexityLevel[]) {
		const stats = analysis.byComplexity[complexity];
		if (stats.total >= 5 && stats.rate < 0.7) {
			recommendations.push(
				`${complexity} tasks have unexpectedly low success (${(stats.rate * 100).toFixed(0)}%). Review complexity assessment.`,
			);
		}
	}

	// Check for common error patterns
	const topError = analysis.errorPatterns[0];
	if (topError && topError.percentage > 0.3) {
		recommendations.push(
			`"${topError.category}" errors account for ${(topError.percentage * 100).toFixed(0)}% of failures. Address this pattern.`,
		);
	}

	return recommendations;
}

/**
 * Get success rate for a specific model and complexity combination
 * Returns null if insufficient data
 */
export function getSuccessRate(
	analysis: MetricsAnalysis,
	model: ModelTier,
	complexity: ComplexityLevel,
	minSamples = 3,
): number | null {
	const key = `${model}:${complexity}`;
	const stats = analysis.byModelAndComplexity[key];

	if (!stats || stats.total < minSamples) {
		return null;
	}

	return stats.rate;
}

/**
 * Suggest optimal model tier based on historical success rates
 */
export function suggestModelTier(
	analysis: MetricsAnalysis,
	complexity: ComplexityLevel,
	minSuccessRate = 0.7,
): ModelTier {
	const tiers: ModelTier[] = ["haiku", "sonnet", "opus"];

	for (const tier of tiers) {
		const rate = getSuccessRate(analysis, tier, complexity);
		if (rate !== null && rate >= minSuccessRate) {
			return tier;
		}
	}

	// Default to opus if no tier meets threshold
	return "opus";
}

/**
 * Load metrics and return full analysis
 */
export function getMetricsAnalysis(options?: LoadMetricsOptions | string): MetricsAnalysis {
	const records = loadMetrics(options);
	return analyzeMetrics(records);
}

/**
 * Format analysis as human-readable summary
 */
export function formatAnalysisSummary(analysis: MetricsAnalysis): string {
	const lines: string[] = [];

	lines.push(`Metrics Analysis (${analysis.totalTasks} tasks)`);
	lines.push(
		`Period: ${analysis.oldestRecord?.toLocaleDateString() || "N/A"} - ${analysis.newestRecord?.toLocaleDateString() || "N/A"}`,
	);
	lines.push("");

	lines.push(`Overall Success Rate: ${(analysis.overallSuccessRate * 100).toFixed(1)}%`);
	lines.push("");

	lines.push("By Model Tier:");
	for (const model of ["haiku", "sonnet", "opus"] as ModelTier[]) {
		const stats = analysis.byModel[model];
		if (stats.total > 0) {
			lines.push(
				`  ${model}: ${(stats.rate * 100).toFixed(0)}% (${stats.successful}/${stats.total}) avg ${Math.round(stats.avgDurationMs / 1000)}s`,
			);
		}
	}
	lines.push("");

	lines.push("By Complexity:");
	for (const complexity of ["trivial", "simple", "standard", "complex", "critical"] as ComplexityLevel[]) {
		const stats = analysis.byComplexity[complexity];
		if (stats.total > 0) {
			lines.push(`  ${complexity}: ${(stats.rate * 100).toFixed(0)}% (${stats.successful}/${stats.total})`);
		}
	}
	lines.push("");

	lines.push(`Escalation: ${(analysis.escalation.escalationRate * 100).toFixed(0)}% of tasks`);
	if (analysis.escalation.totalEscalated > 0) {
		lines.push(`  Success after escalation: ${(analysis.escalation.successRateAfterEscalation * 100).toFixed(0)}%`);
	}
	lines.push("");

	if (analysis.errorPatterns.length > 0) {
		lines.push("Top Error Patterns:");
		for (const pattern of analysis.errorPatterns.slice(0, 5)) {
			lines.push(`  ${pattern.category}: ${pattern.count} (${(pattern.percentage * 100).toFixed(0)}%)`);
		}
		lines.push("");
	}

	if (analysis.recommendations.length > 0) {
		lines.push("Recommendations:");
		for (const rec of analysis.recommendations) {
			lines.push(`  - ${rec}`);
		}
	}

	return lines.join("\n");
}

// ============================================================================
// Pattern Learning - Cluster similar tasks by objective keywords
// ============================================================================

/**
 * Common stop words to ignore when extracting keywords
 */
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"must",
	"can",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"if",
	"then",
	"else",
	"when",
	"where",
	"which",
	"who",
	"what",
	"how",
	"why",
	"all",
	"each",
	"every",
	"both",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"not",
	"only",
	"same",
	"so",
	"than",
	"too",
	"very",
	"just",
	"also",
]);

/**
 * Task cluster with related tasks and success stats
 */
export interface TaskCluster {
	keyword: string;
	count: number;
	successCount: number;
	failCount: number;
	successRate: number;
	avgDurationMs: number;
	avgTokens: number;
	examples: string[]; // Sample objectives
}

/**
 * Pattern learning analysis result
 */
export interface PatternAnalysis {
	clusters: TaskCluster[];
	topSuccessfulPatterns: TaskCluster[];
	strugglingPatterns: TaskCluster[];
	recommendations: string[];
}

/**
 * Extract meaningful keywords from task objective
 */
export function extractKeywords(objective: string): string[] {
	// Convert to lowercase and split on non-word characters
	const words = objective
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2); // Min 3 chars

	// Remove stop words
	const keywords = words.filter((w) => !STOP_WORDS.has(w));

	// Return unique keywords
	return [...new Set(keywords)];
}

/**
 * Analyze task patterns and cluster by keywords
 */
export function analyzeTaskPatterns(options?: LoadMetricsOptions): PatternAnalysis {
	const records = loadMetrics(options);

	// Extract keywords from all objectives and build clusters
	const clusterMap = new Map<
		string,
		{
			count: number;
			successCount: number;
			failCount: number;
			durations: number[];
			tokens: number[];
			examples: Set<string>;
		}
	>();

	for (const record of records) {
		const keywords = extractKeywords(record.objective);

		for (const keyword of keywords) {
			if (!clusterMap.has(keyword)) {
				clusterMap.set(keyword, {
					count: 0,
					successCount: 0,
					failCount: 0,
					durations: [],
					tokens: [],
					examples: new Set(),
				});
			}

			const cluster = clusterMap.get(keyword)!;
			cluster.count++;
			if (record.success) cluster.successCount++;
			else cluster.failCount++;
			cluster.durations.push(record.durationMs);
			cluster.tokens.push(record.totalTokens);
			if (cluster.examples.size < 3) {
				cluster.examples.add(record.objective.slice(0, 60));
			}
		}
	}

	// Convert to sorted array (by count descending)
	const clusters: TaskCluster[] = Array.from(clusterMap.entries())
		.map(([keyword, data]) => ({
			keyword,
			count: data.count,
			successCount: data.successCount,
			failCount: data.failCount,
			successRate: data.count > 0 ? data.successCount / data.count : 0,
			avgDurationMs: data.durations.length > 0 ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length : 0,
			avgTokens: data.tokens.length > 0 ? data.tokens.reduce((a, b) => a + b, 0) / data.tokens.length : 0,
			examples: Array.from(data.examples),
		}))
		.filter((c) => c.count >= 2) // Only clusters with 2+ tasks
		.sort((a, b) => b.count - a.count);

	// Find top successful patterns (high success rate, enough samples)
	const topSuccessful = clusters
		.filter((c) => c.count >= 3 && c.successRate >= 0.8)
		.sort((a, b) => b.successRate - a.successRate)
		.slice(0, 5);

	// Find struggling patterns (low success rate, enough samples)
	const struggling = clusters
		.filter((c) => c.count >= 3 && c.successRate < 0.6)
		.sort((a, b) => a.successRate - b.successRate)
		.slice(0, 5);

	// Generate recommendations
	const recommendations: string[] = [];

	if (struggling.length > 0) {
		recommendations.push(
			`Tasks with "${struggling[0].keyword}" keywords have ${(struggling[0].successRate * 100).toFixed(0)}% success. Consider manual review or decomposition.`,
		);
	}

	if (topSuccessful.length > 0) {
		recommendations.push(
			`"${topSuccessful[0].keyword}" tasks succeed ${(topSuccessful[0].successRate * 100).toFixed(0)}% of the time - good candidate for haiku tier.`,
		);
	}

	// Check for high-volume keywords with mixed results
	const highVolumeMixed = clusters.filter((c) => c.count >= 5 && c.successRate > 0.4 && c.successRate < 0.7);
	if (highVolumeMixed.length > 0) {
		recommendations.push(
			`"${highVolumeMixed[0].keyword}" has inconsistent results (${(highVolumeMixed[0].successRate * 100).toFixed(0)}%). May need better task decomposition.`,
		);
	}

	return {
		clusters: clusters.slice(0, 20), // Top 20 clusters
		topSuccessfulPatterns: topSuccessful,
		strugglingPatterns: struggling,
		recommendations,
	};
}

/**
 * Format pattern analysis as human-readable summary
 */
export function formatPatternSummary(analysis: PatternAnalysis): string {
	const lines: string[] = [];

	lines.push("Task Pattern Analysis");
	lines.push("".padEnd(40, "="));
	lines.push("");

	if (analysis.clusters.length === 0) {
		lines.push("No patterns detected yet. Need more task history.");
		return lines.join("\n");
	}

	lines.push("Top Keywords by Frequency:");
	for (const cluster of analysis.clusters.slice(0, 10)) {
		const rate = (cluster.successRate * 100).toFixed(0);
		lines.push(`  ${cluster.keyword}: ${cluster.count} tasks (${rate}% success)`);
	}
	lines.push("");

	if (analysis.topSuccessfulPatterns.length > 0) {
		lines.push("High-Success Patterns:");
		for (const cluster of analysis.topSuccessfulPatterns) {
			lines.push(`  ${cluster.keyword}: ${(cluster.successRate * 100).toFixed(0)}% (${cluster.count} tasks)`);
		}
		lines.push("");
	}

	if (analysis.strugglingPatterns.length > 0) {
		lines.push("Struggling Patterns:");
		for (const cluster of analysis.strugglingPatterns) {
			lines.push(`  ${cluster.keyword}: ${(cluster.successRate * 100).toFixed(0)}% (${cluster.count} tasks)`);
		}
		lines.push("");
	}

	if (analysis.recommendations.length > 0) {
		lines.push("Recommendations:");
		for (const rec of analysis.recommendations) {
			lines.push(`  - ${rec}`);
		}
	}

	return lines.join("\n");
}

/**
 * Find similar tasks based on keyword overlap
 */
export function findSimilarTasks(
	objective: string,
	options?: LoadMetricsOptions,
): Array<{
	objective: string;
	similarity: number;
	success: boolean;
	model: ModelTier;
}> {
	const records = loadMetrics(options);
	const targetKeywords = new Set(extractKeywords(objective));

	if (targetKeywords.size === 0) {
		return [];
	}

	const similarities: Array<{
		objective: string;
		similarity: number;
		success: boolean;
		model: ModelTier;
	}> = [];

	for (const record of records) {
		const recordKeywords = new Set(extractKeywords(record.objective));

		// Calculate Jaccard similarity
		const intersection = [...targetKeywords].filter((k) => recordKeywords.has(k)).length;
		const union = new Set([...targetKeywords, ...recordKeywords]).size;
		const similarity = union > 0 ? intersection / union : 0;

		if (similarity > 0.2) {
			// Only include if at least 20% similar
			similarities.push({
				objective: record.objective,
				similarity,
				success: record.success,
				model: record.finalModel || "sonnet",
			});
		}
	}

	// Sort by similarity descending
	return similarities.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}
