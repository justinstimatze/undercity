/**
 * Effectiveness Analysis Module
 *
 * Analyzes the effectiveness of undercity's learning systems:
 * - File prediction accuracy (precision/recall)
 * - Knowledge injection correlation with success
 * - Review ROI (tokens per issue fixed)
 * - AST index token savings
 *
 * Uses metrics from .undercity/metrics.jsonl to compute statistics.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskMetrics } from "./types.js";

const DEFAULT_STATE_DIR = ".undercity";
const METRICS_FILE = "metrics.jsonl";

/**
 * File prediction effectiveness metrics
 */
export interface FilePredictionMetrics {
	/** Total tasks with file predictions */
	tasksWithPredictions: number;
	/** Average precision (predicted files that were actually modified) */
	avgPrecision: number;
	/** Average recall (actual modified files that were predicted) */
	avgRecall: number;
	/** F1 score (harmonic mean of precision and recall) */
	f1Score: number;
	/** Top predicted files with highest accuracy */
	topAccurateFiles: Array<{ file: string; precision: number; count: number }>;
}

/**
 * Knowledge injection effectiveness metrics
 */
export interface KnowledgeInjectionMetrics {
	/** Tasks with knowledge injection */
	tasksWithKnowledge: number;
	/** Tasks without knowledge injection */
	tasksWithoutKnowledge: number;
	/** Success rate with knowledge injection */
	successRateWithKnowledge: number;
	/** Success rate without knowledge injection */
	successRateWithoutKnowledge: number;
	/** Difference in success rate (positive = knowledge helps) */
	successRateDelta: number;
	/** Average tokens used with knowledge */
	avgTokensWithKnowledge: number;
	/** Average tokens used without knowledge */
	avgTokensWithoutKnowledge: number;
	/** Most effective learning IDs */
	mostEffectiveLearnings: Array<{ learningId: string; successRate: number; usedCount: number }>;
}

/**
 * Review effectiveness metrics
 */
export interface ReviewEffectivenessMetrics {
	/** Total tasks with review data */
	tasksWithReview: number;
	/** Total issues found by review */
	totalIssuesFound: number;
	/** Total tokens spent on review */
	totalReviewTokens: number;
	/** Average tokens per issue found */
	tokensPerIssue: number;
	/** Average review passes per task */
	avgReviewPasses: number;
	/** Review ROI: issues found / tokens spent (higher is better) */
	reviewROI: number;
}

/**
 * Combined effectiveness report
 */
export interface EffectivenessReport {
	/** Analysis timestamp */
	analyzedAt: string;
	/** Total tasks analyzed */
	totalTasksAnalyzed: number;
	/** File prediction metrics */
	filePrediction: FilePredictionMetrics;
	/** Knowledge injection metrics */
	knowledgeInjection: KnowledgeInjectionMetrics;
	/** Review effectiveness metrics */
	review: ReviewEffectivenessMetrics;
	/** Recommendations based on analysis */
	recommendations: string[];
}

/**
 * Load metrics from JSONL file
 */
function loadMetrics(stateDir: string = DEFAULT_STATE_DIR): TaskMetrics[] {
	const metricsPath = join(stateDir, METRICS_FILE);

	if (!existsSync(metricsPath)) {
		return [];
	}

	try {
		const content = readFileSync(metricsPath, "utf-8");
		const lines = content.split("\n").filter((line) => line.trim());

		return lines.map((line) => {
			const parsed = JSON.parse(line);
			// Convert date strings to Date objects
			if (parsed.startedAt) parsed.startedAt = new Date(parsed.startedAt);
			if (parsed.completedAt) parsed.completedAt = new Date(parsed.completedAt);
			return parsed as TaskMetrics;
		});
	} catch {
		return [];
	}
}

/**
 * Calculate file prediction metrics
 */
function calculateFilePredictionMetrics(metrics: TaskMetrics[]): FilePredictionMetrics {
	const tasksWithPredictions = metrics.filter(
		(m) => m.predictedFiles && m.predictedFiles.length > 0 && m.actualFilesModified && m.actualFilesModified.length > 0,
	);

	if (tasksWithPredictions.length === 0) {
		return {
			tasksWithPredictions: 0,
			avgPrecision: 0,
			avgRecall: 0,
			f1Score: 0,
			topAccurateFiles: [],
		};
	}

	// Calculate precision and recall for each task
	let totalPrecision = 0;
	let totalRecall = 0;
	const fileAccuracy: Record<string, { correct: number; total: number }> = {};

	for (const task of tasksWithPredictions) {
		const predicted = new Set(task.predictedFiles || []);
		const actual = new Set(task.actualFilesModified || []);

		// Precision: what % of predicted files were actually modified
		const correctPredictions = [...predicted].filter((f) => actual.has(f)).length;
		const precision = predicted.size > 0 ? correctPredictions / predicted.size : 0;
		totalPrecision += precision;

		// Recall: what % of actual files were predicted
		const recall = actual.size > 0 ? correctPredictions / actual.size : 0;
		totalRecall += recall;

		// Track per-file accuracy
		for (const file of predicted) {
			if (!fileAccuracy[file]) {
				fileAccuracy[file] = { correct: 0, total: 0 };
			}
			fileAccuracy[file].total++;
			if (actual.has(file)) {
				fileAccuracy[file].correct++;
			}
		}
	}

	const avgPrecision = totalPrecision / tasksWithPredictions.length;
	const avgRecall = totalRecall / tasksWithPredictions.length;
	const f1Score = avgPrecision + avgRecall > 0 ? (2 * avgPrecision * avgRecall) / (avgPrecision + avgRecall) : 0;

	// Top accurate files
	const topAccurateFiles = Object.entries(fileAccuracy)
		.filter(([, data]) => data.total >= 3) // Only files predicted 3+ times
		.map(([file, data]) => ({
			file,
			precision: data.correct / data.total,
			count: data.total,
		}))
		.sort((a, b) => b.precision - a.precision)
		.slice(0, 10);

	return {
		tasksWithPredictions: tasksWithPredictions.length,
		avgPrecision,
		avgRecall,
		f1Score,
		topAccurateFiles,
	};
}

/**
 * Calculate knowledge injection metrics
 */
function calculateKnowledgeInjectionMetrics(metrics: TaskMetrics[]): KnowledgeInjectionMetrics {
	const tasksWithKnowledge = metrics.filter((m) => m.injectedLearningIds && m.injectedLearningIds.length > 0);
	const tasksWithoutKnowledge = metrics.filter((m) => !m.injectedLearningIds || m.injectedLearningIds.length === 0);

	const successRateWithKnowledge =
		tasksWithKnowledge.length > 0 ? tasksWithKnowledge.filter((m) => m.success).length / tasksWithKnowledge.length : 0;

	const successRateWithoutKnowledge =
		tasksWithoutKnowledge.length > 0
			? tasksWithoutKnowledge.filter((m) => m.success).length / tasksWithoutKnowledge.length
			: 0;

	const avgTokensWithKnowledge =
		tasksWithKnowledge.length > 0
			? tasksWithKnowledge.reduce((sum, m) => sum + m.totalTokens, 0) / tasksWithKnowledge.length
			: 0;

	const avgTokensWithoutKnowledge =
		tasksWithoutKnowledge.length > 0
			? tasksWithoutKnowledge.reduce((sum, m) => sum + m.totalTokens, 0) / tasksWithoutKnowledge.length
			: 0;

	// Track effectiveness of individual learnings
	const learningEffectiveness: Record<string, { success: number; total: number }> = {};

	for (const task of tasksWithKnowledge) {
		for (const learningId of task.injectedLearningIds || []) {
			if (!learningEffectiveness[learningId]) {
				learningEffectiveness[learningId] = { success: 0, total: 0 };
			}
			learningEffectiveness[learningId].total++;
			if (task.success) {
				learningEffectiveness[learningId].success++;
			}
		}
	}

	const mostEffectiveLearnings = Object.entries(learningEffectiveness)
		.filter(([, data]) => data.total >= 3) // Only learnings used 3+ times
		.map(([learningId, data]) => ({
			learningId,
			successRate: data.success / data.total,
			usedCount: data.total,
		}))
		.sort((a, b) => b.successRate - a.successRate)
		.slice(0, 10);

	return {
		tasksWithKnowledge: tasksWithKnowledge.length,
		tasksWithoutKnowledge: tasksWithoutKnowledge.length,
		successRateWithKnowledge,
		successRateWithoutKnowledge,
		successRateDelta: successRateWithKnowledge - successRateWithoutKnowledge,
		avgTokensWithKnowledge,
		avgTokensWithoutKnowledge,
		mostEffectiveLearnings,
	};
}

/**
 * Calculate review effectiveness metrics
 */
function calculateReviewEffectivenessMetrics(metrics: TaskMetrics[]): ReviewEffectivenessMetrics {
	const tasksWithReview = metrics.filter((m) => m.reviewStats && m.reviewStats.reviewPasses > 0);

	if (tasksWithReview.length === 0) {
		return {
			tasksWithReview: 0,
			totalIssuesFound: 0,
			totalReviewTokens: 0,
			tokensPerIssue: 0,
			avgReviewPasses: 0,
			reviewROI: 0,
		};
	}

	const totalIssuesFound = tasksWithReview.reduce((sum, m) => sum + (m.reviewStats?.issuesFound || 0), 0);
	const totalReviewTokens = tasksWithReview.reduce((sum, m) => sum + (m.reviewStats?.reviewTokens || 0), 0);
	const totalReviewPasses = tasksWithReview.reduce((sum, m) => sum + (m.reviewStats?.reviewPasses || 0), 0);

	const tokensPerIssue = totalIssuesFound > 0 ? totalReviewTokens / totalIssuesFound : 0;
	const avgReviewPasses = totalReviewPasses / tasksWithReview.length;
	// ROI: issues per 1000 tokens (higher is better)
	const reviewROI = totalReviewTokens > 0 ? (totalIssuesFound / totalReviewTokens) * 1000 : 0;

	return {
		tasksWithReview: tasksWithReview.length,
		totalIssuesFound,
		totalReviewTokens,
		tokensPerIssue,
		avgReviewPasses,
		reviewROI,
	};
}

/**
 * Generate recommendations based on analysis
 */
function generateRecommendations(
	filePrediction: FilePredictionMetrics,
	knowledgeInjection: KnowledgeInjectionMetrics,
	review: ReviewEffectivenessMetrics,
): string[] {
	const recommendations: string[] = [];

	// File prediction recommendations
	if (filePrediction.avgPrecision < 0.5 && filePrediction.tasksWithPredictions > 10) {
		recommendations.push(
			"File prediction precision is low (<50%). Consider tuning keyword extraction or adding more task-file pattern data.",
		);
	}

	if (filePrediction.avgRecall < 0.5 && filePrediction.tasksWithPredictions > 10) {
		recommendations.push(
			"File prediction recall is low (<50%). The system is missing relevant files. Consider expanding keyword coverage.",
		);
	}

	// Knowledge injection recommendations
	if (knowledgeInjection.successRateDelta > 0.1) {
		recommendations.push(
			`Knowledge injection improves success rate by ${(knowledgeInjection.successRateDelta * 100).toFixed(1)}%. Continue using knowledge compounding.`,
		);
	} else if (knowledgeInjection.successRateDelta < -0.05 && knowledgeInjection.tasksWithKnowledge > 20) {
		recommendations.push(
			"Knowledge injection may be adding noise. Consider filtering learnings with higher confidence thresholds.",
		);
	}

	if (knowledgeInjection.avgTokensWithKnowledge > knowledgeInjection.avgTokensWithoutKnowledge * 1.2) {
		recommendations.push(
			"Knowledge injection is increasing token usage significantly. Consider more compact learning formats.",
		);
	}

	// Review recommendations
	if (review.tokensPerIssue > 5000 && review.tasksWithReview > 10) {
		recommendations.push(
			`Review is expensive (${review.tokensPerIssue.toFixed(0)} tokens/issue). Consider lighter review for simple tasks.`,
		);
	}

	if (review.reviewROI < 0.1 && review.tasksWithReview > 10) {
		recommendations.push(
			"Review ROI is low. Consider skipping review for trivial/simple complexity tasks to save tokens.",
		);
	}

	if (review.avgReviewPasses > 2 && review.tasksWithReview > 10) {
		recommendations.push(
			"Average review passes is high (>2). Tasks may need better initial planning or clearer requirements.",
		);
	}

	if (recommendations.length === 0) {
		recommendations.push("All effectiveness metrics look healthy. Continue monitoring as more data accumulates.");
	}

	return recommendations;
}

/**
 * Generate complete effectiveness report
 */
export function analyzeEffectiveness(stateDir: string = DEFAULT_STATE_DIR): EffectivenessReport {
	const metrics = loadMetrics(stateDir);

	const filePrediction = calculateFilePredictionMetrics(metrics);
	const knowledgeInjection = calculateKnowledgeInjectionMetrics(metrics);
	const review = calculateReviewEffectivenessMetrics(metrics);

	const recommendations = generateRecommendations(filePrediction, knowledgeInjection, review);

	return {
		analyzedAt: new Date().toISOString(),
		totalTasksAnalyzed: metrics.length,
		filePrediction,
		knowledgeInjection,
		review,
		recommendations,
	};
}

/**
 * Format effectiveness report for human-readable output
 */
export function formatEffectivenessReport(report: EffectivenessReport): string {
	const lines: string[] = [];

	lines.push("Effectiveness Analysis Report");
	lines.push("=".repeat(40));
	lines.push(`Analyzed: ${report.totalTasksAnalyzed} tasks`);
	lines.push(`Generated: ${report.analyzedAt}`);
	lines.push("");

	// File Prediction
	lines.push("FILE PREDICTION ACCURACY");
	lines.push("-".repeat(40));
	if (report.filePrediction.tasksWithPredictions > 0) {
		lines.push(`Tasks with predictions: ${report.filePrediction.tasksWithPredictions}`);
		lines.push(`Precision: ${(report.filePrediction.avgPrecision * 100).toFixed(1)}%`);
		lines.push(`Recall: ${(report.filePrediction.avgRecall * 100).toFixed(1)}%`);
		lines.push(`F1 Score: ${(report.filePrediction.f1Score * 100).toFixed(1)}%`);

		if (report.filePrediction.topAccurateFiles.length > 0) {
			lines.push("\nTop accurate file predictions:");
			for (const f of report.filePrediction.topAccurateFiles.slice(0, 5)) {
				lines.push(`  ${f.file}: ${(f.precision * 100).toFixed(0)}% (${f.count} predictions)`);
			}
		}
	} else {
		lines.push("No file prediction data available yet.");
	}
	lines.push("");

	// Knowledge Injection
	lines.push("KNOWLEDGE INJECTION CORRELATION");
	lines.push("-".repeat(40));
	if (report.knowledgeInjection.tasksWithKnowledge > 0 || report.knowledgeInjection.tasksWithoutKnowledge > 0) {
		lines.push(`Tasks with knowledge: ${report.knowledgeInjection.tasksWithKnowledge}`);
		lines.push(`Tasks without knowledge: ${report.knowledgeInjection.tasksWithoutKnowledge}`);
		lines.push(`Success rate with knowledge: ${(report.knowledgeInjection.successRateWithKnowledge * 100).toFixed(1)}%`);
		lines.push(
			`Success rate without knowledge: ${(report.knowledgeInjection.successRateWithoutKnowledge * 100).toFixed(1)}%`,
		);

		const deltaSign = report.knowledgeInjection.successRateDelta >= 0 ? "+" : "";
		lines.push(`Success rate delta: ${deltaSign}${(report.knowledgeInjection.successRateDelta * 100).toFixed(1)}%`);

		if (report.knowledgeInjection.mostEffectiveLearnings.length > 0) {
			lines.push("\nMost effective learnings:");
			for (const l of report.knowledgeInjection.mostEffectiveLearnings.slice(0, 5)) {
				lines.push(`  ${l.learningId}: ${(l.successRate * 100).toFixed(0)}% success (${l.usedCount} uses)`);
			}
		}
	} else {
		lines.push("No knowledge injection data available yet.");
	}
	lines.push("");

	// Review Effectiveness
	lines.push("REVIEW EFFECTIVENESS");
	lines.push("-".repeat(40));
	if (report.review.tasksWithReview > 0) {
		lines.push(`Tasks with review: ${report.review.tasksWithReview}`);
		lines.push(`Total issues found: ${report.review.totalIssuesFound}`);
		lines.push(`Total review tokens: ${report.review.totalReviewTokens.toLocaleString()}`);
		lines.push(`Tokens per issue: ${report.review.tokensPerIssue.toFixed(0)}`);
		lines.push(`Avg review passes: ${report.review.avgReviewPasses.toFixed(1)}`);
		lines.push(`Review ROI: ${report.review.reviewROI.toFixed(2)} issues/1000 tokens`);
	} else {
		lines.push("No review data available yet.");
	}
	lines.push("");

	// Recommendations
	lines.push("RECOMMENDATIONS");
	lines.push("-".repeat(40));
	for (const rec of report.recommendations) {
		lines.push(`• ${rec}`);
	}

	return lines.join("\n");
}
