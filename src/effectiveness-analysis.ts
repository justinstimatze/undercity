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
 * RAG search effectiveness metrics
 */
export interface RagSearchMetrics {
	/** Total tasks with RAG searches */
	tasksWithSearches: number;
	/** Total searches performed */
	totalSearches: number;
	/** Searches that were used in prompts */
	searchesUsed: number;
	/** Search utilization rate */
	utilizationRate: number;
	/** Success rate for tasks with RAG vs without */
	successRateWithRag: number;
	/** Success rate for tasks without RAG */
	successRateWithoutRag: number;
	/** Delta (positive = RAG helps) */
	successRateDelta: number;
	/** Average results per search */
	avgResultsPerSearch: number;
}

/**
 * Self-tuning adoption metrics
 */
export interface SelfTuningMetrics {
	/** Tasks with model recommendations */
	tasksWithRecommendations: number;
	/** Tasks where recommendation was followed */
	recommendationsFollowed: number;
	/** Adoption rate */
	adoptionRate: number;
	/** Success rate when recommendation followed */
	successRateWhenFollowed: number;
	/** Success rate when recommendation ignored */
	successRateWhenIgnored: number;
	/** Delta (positive = following helps) */
	successRateDelta: number;
}

/**
 * Task classifier accuracy metrics
 */
export interface ClassifierMetrics {
	/** Tasks with classifier predictions */
	tasksWithPredictions: number;
	/** Confusion matrix for risk predictions */
	confusionMatrix: {
		/** Predicted low, actually succeeded */
		lowPredictedSuccess: number;
		/** Predicted low, actually failed */
		lowPredictedFailed: number;
		/** Predicted medium, actually succeeded */
		mediumPredictedSuccess: number;
		/** Predicted medium, actually failed */
		mediumPredictedFailed: number;
		/** Predicted high, actually succeeded */
		highPredictedSuccess: number;
		/** Predicted high, actually failed */
		highPredictedFailed: number;
	};
	/** Average confidence score */
	avgConfidence: number;
	/** Calibration: does high confidence correlate with accuracy? */
	confidenceCalibration: number;
}

/**
 * Throughput and efficiency metrics
 */
export interface ThroughputMetrics {
	/** Total tasks completed (success or failure) */
	totalTasksCompleted: number;
	/** Total successful tasks */
	successfulTasks: number;
	/** Tasks per hour (successful only) */
	tasksPerHour: number;
	/** Average task duration in minutes */
	avgTaskDurationMinutes: number;
	/** Total lines changed across all tasks */
	totalLinesChanged: number;
	/** Average lines changed per task */
	avgLinesPerTask: number;
	/** Total files modified across all tasks */
	totalFilesChanged: number;
	/** Average files modified per task */
	avgFilesPerTask: number;
	/** Token efficiency: tokens per line changed */
	tokensPerLineChanged: number;
	/** Token efficiency: tokens per file modified */
	tokensPerFileModified: number;
	/** Breakdown by complexity level */
	byComplexity: Record<
		string,
		{
			count: number;
			avgDuration: number;
			avgLines: number;
			avgTokens: number;
		}
	>;
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
	/** RAG search effectiveness metrics */
	ragSearch: RagSearchMetrics;
	/** Self-tuning adoption metrics */
	selfTuning: SelfTuningMetrics;
	/** Task classifier accuracy metrics */
	classifier: ClassifierMetrics;
	/** Throughput and efficiency metrics */
	throughput: ThroughputMetrics;
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
 * Calculate RAG search effectiveness metrics
 */
function calculateRagSearchMetrics(metrics: TaskMetrics[]): RagSearchMetrics {
	const tasksWithSearches = metrics.filter((m) => m.ragSearches && m.ragSearches.length > 0);
	const tasksWithoutSearches = metrics.filter((m) => !m.ragSearches || m.ragSearches.length === 0);

	if (tasksWithSearches.length === 0) {
		return {
			tasksWithSearches: 0,
			totalSearches: 0,
			searchesUsed: 0,
			utilizationRate: 0,
			successRateWithRag: 0,
			successRateWithoutRag:
				tasksWithoutSearches.length > 0
					? tasksWithoutSearches.filter((m) => m.success).length / tasksWithoutSearches.length
					: 0,
			successRateDelta: 0,
			avgResultsPerSearch: 0,
		};
	}

	let totalSearches = 0;
	let searchesUsed = 0;
	let totalResults = 0;

	for (const task of tasksWithSearches) {
		for (const search of task.ragSearches || []) {
			totalSearches++;
			totalResults += search.resultsCount;
			if (search.wasUsed) {
				searchesUsed++;
			}
		}
	}

	const successRateWithRag = tasksWithSearches.filter((m) => m.success).length / tasksWithSearches.length;
	const successRateWithoutRag =
		tasksWithoutSearches.length > 0
			? tasksWithoutSearches.filter((m) => m.success).length / tasksWithoutSearches.length
			: 0;

	return {
		tasksWithSearches: tasksWithSearches.length,
		totalSearches,
		searchesUsed,
		utilizationRate: totalSearches > 0 ? searchesUsed / totalSearches : 0,
		successRateWithRag,
		successRateWithoutRag,
		successRateDelta: successRateWithRag - successRateWithoutRag,
		avgResultsPerSearch: totalSearches > 0 ? totalResults / totalSearches : 0,
	};
}

/**
 * Calculate self-tuning adoption metrics
 */
function calculateSelfTuningMetrics(metrics: TaskMetrics[]): SelfTuningMetrics {
	const tasksWithRecommendations = metrics.filter((m) => m.recommendedModel);

	if (tasksWithRecommendations.length === 0) {
		return {
			tasksWithRecommendations: 0,
			recommendationsFollowed: 0,
			adoptionRate: 0,
			successRateWhenFollowed: 0,
			successRateWhenIgnored: 0,
			successRateDelta: 0,
		};
	}

	const followed = tasksWithRecommendations.filter((m) => m.recommendedModel === m.finalModel);
	const ignored = tasksWithRecommendations.filter((m) => m.recommendedModel !== m.finalModel);

	const successRateWhenFollowed = followed.length > 0 ? followed.filter((m) => m.success).length / followed.length : 0;
	const successRateWhenIgnored = ignored.length > 0 ? ignored.filter((m) => m.success).length / ignored.length : 0;

	return {
		tasksWithRecommendations: tasksWithRecommendations.length,
		recommendationsFollowed: followed.length,
		adoptionRate: followed.length / tasksWithRecommendations.length,
		successRateWhenFollowed,
		successRateWhenIgnored,
		successRateDelta: successRateWhenFollowed - successRateWhenIgnored,
	};
}

/**
 * Calculate task classifier accuracy metrics
 */
function calculateClassifierMetrics(metrics: TaskMetrics[]): ClassifierMetrics {
	const tasksWithPredictions = metrics.filter((m) => m.classifierPrediction);

	if (tasksWithPredictions.length === 0) {
		return {
			tasksWithPredictions: 0,
			confusionMatrix: {
				lowPredictedSuccess: 0,
				lowPredictedFailed: 0,
				mediumPredictedSuccess: 0,
				mediumPredictedFailed: 0,
				highPredictedSuccess: 0,
				highPredictedFailed: 0,
			},
			avgConfidence: 0,
			confidenceCalibration: 0,
		};
	}

	const confusionMatrix = {
		lowPredictedSuccess: 0,
		lowPredictedFailed: 0,
		mediumPredictedSuccess: 0,
		mediumPredictedFailed: 0,
		highPredictedSuccess: 0,
		highPredictedFailed: 0,
	};

	let totalConfidence = 0;
	let _correctPredictions = 0;
	let highConfidenceCorrect = 0;
	let highConfidenceTotal = 0;

	for (const task of tasksWithPredictions) {
		const prediction = task.classifierPrediction;
		if (!prediction) continue;

		totalConfidence += prediction.confidence;

		// Populate confusion matrix
		if (prediction.riskLevel === "low") {
			if (task.success) confusionMatrix.lowPredictedSuccess++;
			else confusionMatrix.lowPredictedFailed++;
		} else if (prediction.riskLevel === "medium") {
			if (task.success) confusionMatrix.mediumPredictedSuccess++;
			else confusionMatrix.mediumPredictedFailed++;
		} else if (prediction.riskLevel === "high") {
			if (task.success) confusionMatrix.highPredictedSuccess++;
			else confusionMatrix.highPredictedFailed++;
		}

		// Track calibration: low risk should succeed, high risk might fail
		const isCalibrated =
			(prediction.riskLevel === "low" && task.success) || (prediction.riskLevel === "high" && !task.success);
		if (isCalibrated) _correctPredictions++;

		// Track high confidence predictions specifically
		if (prediction.confidence > 0.7) {
			highConfidenceTotal++;
			if (isCalibrated) highConfidenceCorrect++;
		}
	}

	const avgConfidence = totalConfidence / tasksWithPredictions.length;
	// Calibration: how well does high confidence correlate with correctness?
	const confidenceCalibration = highConfidenceTotal > 0 ? highConfidenceCorrect / highConfidenceTotal : 0;

	return {
		tasksWithPredictions: tasksWithPredictions.length,
		confusionMatrix,
		avgConfidence,
		confidenceCalibration,
	};
}

/**
 * Calculate throughput and efficiency metrics
 */
function calculateThroughputMetrics(metrics: TaskMetrics[]): ThroughputMetrics {
	if (metrics.length === 0) {
		return {
			totalTasksCompleted: 0,
			successfulTasks: 0,
			tasksPerHour: 0,
			avgTaskDurationMinutes: 0,
			totalLinesChanged: 0,
			avgLinesPerTask: 0,
			totalFilesChanged: 0,
			avgFilesPerTask: 0,
			tokensPerLineChanged: 0,
			tokensPerFileModified: 0,
			byComplexity: {},
		};
	}

	const successfulTasks = metrics.filter((m) => m.success);
	const tasksWithDuration = metrics.filter((m) => m.durationMs && m.durationMs > 0);

	// Calculate total duration span
	const sortedByTime = [...metrics].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
	const firstStart = new Date(sortedByTime[0].startedAt).getTime();
	const lastEnd = new Date(sortedByTime[sortedByTime.length - 1].completedAt).getTime();
	const totalHours = Math.max((lastEnd - firstStart) / (1000 * 60 * 60), 0.001);

	// Throughput
	const tasksPerHour = successfulTasks.length / totalHours;

	// Duration
	const totalDuration = tasksWithDuration.reduce((sum, m) => sum + (m.durationMs || 0), 0);
	const avgTaskDurationMinutes = tasksWithDuration.length > 0 ? totalDuration / tasksWithDuration.length / 60000 : 0;

	// Lines and files changed
	const tasksWithLines = metrics.filter((m) => typeof m.linesChanged === "number");
	const tasksWithFiles = metrics.filter((m) => typeof m.filesChanged === "number");

	const totalLinesChanged = tasksWithLines.reduce((sum, m) => sum + (m.linesChanged || 0), 0);
	const totalFilesChanged = tasksWithFiles.reduce((sum, m) => sum + (m.filesChanged || 0), 0);

	const avgLinesPerTask = tasksWithLines.length > 0 ? totalLinesChanged / tasksWithLines.length : 0;
	const avgFilesPerTask = tasksWithFiles.length > 0 ? totalFilesChanged / tasksWithFiles.length : 0;

	// Token efficiency
	const totalTokens = metrics.reduce((sum, m) => sum + (m.totalTokens || 0), 0);
	const tokensPerLineChanged = totalLinesChanged > 0 ? totalTokens / totalLinesChanged : 0;
	const tokensPerFileModified = totalFilesChanged > 0 ? totalTokens / totalFilesChanged : 0;

	// Breakdown by complexity
	const byComplexity: ThroughputMetrics["byComplexity"] = {};
	const complexityGroups: Record<string, TaskMetrics[]> = {};

	for (const task of metrics) {
		const level = task.complexityLevel || "unknown";
		if (!complexityGroups[level]) complexityGroups[level] = [];
		complexityGroups[level].push(task);
	}

	for (const [level, tasks] of Object.entries(complexityGroups)) {
		const durations = tasks.filter((t) => t.durationMs).map((t) => t.durationMs!);
		const lines = tasks.filter((t) => typeof t.linesChanged === "number").map((t) => t.linesChanged!);
		const tokens = tasks.map((t) => t.totalTokens || 0);

		byComplexity[level] = {
			count: tasks.length,
			avgDuration: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length / 60000 : 0,
			avgLines: lines.length > 0 ? lines.reduce((a, b) => a + b, 0) / lines.length : 0,
			avgTokens: tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0,
		};
	}

	return {
		totalTasksCompleted: metrics.length,
		successfulTasks: successfulTasks.length,
		tasksPerHour,
		avgTaskDurationMinutes,
		totalLinesChanged,
		avgLinesPerTask,
		totalFilesChanged,
		avgFilesPerTask,
		tokensPerLineChanged,
		tokensPerFileModified,
		byComplexity,
	};
}

/**
 * Generate recommendations based on analysis
 */
function generateRecommendations(
	filePrediction: FilePredictionMetrics,
	knowledgeInjection: KnowledgeInjectionMetrics,
	review: ReviewEffectivenessMetrics,
	ragSearch: RagSearchMetrics,
	selfTuning: SelfTuningMetrics,
	classifier: ClassifierMetrics,
	throughput: ThroughputMetrics,
): string[] {
	const recommendations: string[] = [];

	// File prediction recommendations
	// Check if file prediction is not being tracked at all
	if (filePrediction.tasksWithPredictions === 0 && knowledgeInjection.tasksWithoutKnowledge > 5) {
		recommendations.push(
			"No file prediction data recorded. Check that metrics.ts is recording predictedFiles and actualFilesModified.",
		);
	} else if (filePrediction.avgPrecision < 0.5 && filePrediction.tasksWithPredictions > 10) {
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
	// CRITICAL: Check if knowledge injection is not working at all
	if (knowledgeInjection.tasksWithKnowledge === 0 && knowledgeInjection.tasksWithoutKnowledge > 5) {
		recommendations.push(
			`WARNING: Knowledge injection is not working - 0 of ${knowledgeInjection.tasksWithoutKnowledge} tasks used knowledge. Check that metrics.ts is recording injectedLearningIds.`,
		);
	} else if (knowledgeInjection.successRateDelta > 0.1) {
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

	// RAG search recommendations
	if (ragSearch.tasksWithSearches === 0 && knowledgeInjection.tasksWithoutKnowledge > 5) {
		recommendations.push(
			"No RAG search data recorded. Check that RAG searches are being tracked in metrics during task execution.",
		);
	} else if (ragSearch.utilizationRate < 0.5 && ragSearch.totalSearches > 20) {
		recommendations.push(
			`RAG search utilization is low (${(ragSearch.utilizationRate * 100).toFixed(0)}%). Many searches are not being used. Consider improving search relevance.`,
		);
	}

	if (ragSearch.successRateDelta > 0.1 && ragSearch.tasksWithSearches > 10) {
		recommendations.push(
			`RAG search improves success rate by ${(ragSearch.successRateDelta * 100).toFixed(1)}%. Continue using semantic search.`,
		);
	} else if (ragSearch.successRateDelta < -0.05 && ragSearch.tasksWithSearches > 10) {
		recommendations.push(
			"RAG search may be adding noise. Consider tuning search thresholds or improving index quality.",
		);
	}

	// Self-tuning recommendations
	if (selfTuning.tasksWithRecommendations === 0 && knowledgeInjection.tasksWithoutKnowledge > 5) {
		recommendations.push(
			"No self-tuning data recorded. Check that model recommendations are being tracked during task execution.",
		);
	} else if (selfTuning.adoptionRate < 0.5 && selfTuning.tasksWithRecommendations > 10) {
		recommendations.push(
			`Self-tuning adoption is low (${(selfTuning.adoptionRate * 100).toFixed(0)}%). Recommendations are often overridden.`,
		);
	}

	if (selfTuning.successRateDelta > 0.1 && selfTuning.tasksWithRecommendations > 10) {
		recommendations.push(
			`Following self-tuning recommendations improves success rate by ${(selfTuning.successRateDelta * 100).toFixed(1)}%. Trust the routing profile more.`,
		);
	} else if (selfTuning.successRateDelta < -0.1 && selfTuning.recommendationsFollowed > 10) {
		recommendations.push(
			"Self-tuning recommendations may be suboptimal. Consider retraining the routing profile with recent data.",
		);
	}

	// Classifier recommendations
	if (classifier.tasksWithPredictions === 0 && knowledgeInjection.tasksWithoutKnowledge > 5) {
		recommendations.push(
			"No classifier prediction data recorded. Check that task classifier predictions are being tracked.",
		);
	} else if (classifier.confidenceCalibration < 0.5 && classifier.tasksWithPredictions > 20) {
		recommendations.push(
			`Classifier calibration is poor (${(classifier.confidenceCalibration * 100).toFixed(0)}%). High confidence predictions are not reliable.`,
		);
	}

	// Check confusion matrix for patterns
	if (classifier.tasksWithPredictions > 10) {
		const lowRiskFailRate =
			classifier.confusionMatrix.lowPredictedFailed /
			(classifier.confusionMatrix.lowPredictedSuccess + classifier.confusionMatrix.lowPredictedFailed || 1);
		if (lowRiskFailRate > 0.3) {
			recommendations.push(
				`Low-risk predictions fail ${(lowRiskFailRate * 100).toFixed(0)}% of the time. Classifier may be under-estimating risk.`,
			);
		}
	}

	// Throughput recommendations
	if (throughput.totalTasksCompleted === 0) {
		// No data yet - skip recommendations
	} else if (throughput.totalLinesChanged === 0 && throughput.totalTasksCompleted > 5) {
		recommendations.push(
			"No lines-changed data recorded. Check that recordThroughput is being called in worker verification.",
		);
	} else if (throughput.tokensPerLineChanged > 500 && throughput.totalLinesChanged > 100) {
		recommendations.push(
			`Token efficiency is low (${throughput.tokensPerLineChanged.toFixed(0)} tokens/line). Consider more focused task scopes.`,
		);
	} else if (throughput.tokensPerLineChanged < 50 && throughput.totalLinesChanged > 100) {
		recommendations.push(
			`Token efficiency is excellent (${throughput.tokensPerLineChanged.toFixed(0)} tokens/line). Current approach is cost-effective.`,
		);
	}

	if (throughput.avgTaskDurationMinutes > 30 && throughput.totalTasksCompleted > 10) {
		recommendations.push(
			`Average task duration is high (${throughput.avgTaskDurationMinutes.toFixed(1)} min). Consider decomposing complex tasks.`,
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
	const ragSearch = calculateRagSearchMetrics(metrics);
	const selfTuning = calculateSelfTuningMetrics(metrics);
	const classifier = calculateClassifierMetrics(metrics);
	const throughput = calculateThroughputMetrics(metrics);

	const recommendations = generateRecommendations(
		filePrediction,
		knowledgeInjection,
		review,
		ragSearch,
		selfTuning,
		classifier,
		throughput,
	);

	return {
		analyzedAt: new Date().toISOString(),
		totalTasksAnalyzed: metrics.length,
		filePrediction,
		knowledgeInjection,
		review,
		ragSearch,
		selfTuning,
		classifier,
		throughput,
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
		lines.push(
			`Success rate with knowledge: ${(report.knowledgeInjection.successRateWithKnowledge * 100).toFixed(1)}%`,
		);
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

	// RAG Search Effectiveness
	lines.push("RAG SEARCH EFFECTIVENESS");
	lines.push("-".repeat(40));
	if (report.ragSearch.tasksWithSearches > 0) {
		lines.push(`Tasks with searches: ${report.ragSearch.tasksWithSearches}`);
		lines.push(`Total searches: ${report.ragSearch.totalSearches}`);
		lines.push(`Searches used: ${report.ragSearch.searchesUsed}`);
		lines.push(`Utilization rate: ${(report.ragSearch.utilizationRate * 100).toFixed(1)}%`);
		lines.push(`Success rate with RAG: ${(report.ragSearch.successRateWithRag * 100).toFixed(1)}%`);
		lines.push(`Success rate without RAG: ${(report.ragSearch.successRateWithoutRag * 100).toFixed(1)}%`);
		const ragDeltaSign = report.ragSearch.successRateDelta >= 0 ? "+" : "";
		lines.push(`Success rate delta: ${ragDeltaSign}${(report.ragSearch.successRateDelta * 100).toFixed(1)}%`);
		lines.push(`Avg results per search: ${report.ragSearch.avgResultsPerSearch.toFixed(1)}`);
	} else {
		lines.push("No RAG search data available yet.");
	}
	lines.push("");

	// Self-Tuning Adoption
	lines.push("SELF-TUNING ADOPTION");
	lines.push("-".repeat(40));
	if (report.selfTuning.tasksWithRecommendations > 0) {
		lines.push(`Tasks with recommendations: ${report.selfTuning.tasksWithRecommendations}`);
		lines.push(`Recommendations followed: ${report.selfTuning.recommendationsFollowed}`);
		lines.push(`Adoption rate: ${(report.selfTuning.adoptionRate * 100).toFixed(1)}%`);
		lines.push(`Success rate when followed: ${(report.selfTuning.successRateWhenFollowed * 100).toFixed(1)}%`);
		lines.push(`Success rate when ignored: ${(report.selfTuning.successRateWhenIgnored * 100).toFixed(1)}%`);
		const tuningDeltaSign = report.selfTuning.successRateDelta >= 0 ? "+" : "";
		lines.push(`Success rate delta: ${tuningDeltaSign}${(report.selfTuning.successRateDelta * 100).toFixed(1)}%`);
	} else {
		lines.push("No self-tuning data available yet.");
	}
	lines.push("");

	// Task Classifier Accuracy
	lines.push("TASK CLASSIFIER ACCURACY");
	lines.push("-".repeat(40));
	if (report.classifier.tasksWithPredictions > 0) {
		lines.push(`Tasks with predictions: ${report.classifier.tasksWithPredictions}`);
		lines.push(`Average confidence: ${(report.classifier.avgConfidence * 100).toFixed(1)}%`);
		lines.push(`Confidence calibration: ${(report.classifier.confidenceCalibration * 100).toFixed(1)}%`);
		lines.push("\nConfusion matrix:");
		const cm = report.classifier.confusionMatrix;
		lines.push(`  Low risk:    ${cm.lowPredictedSuccess} succeeded, ${cm.lowPredictedFailed} failed`);
		lines.push(`  Medium risk: ${cm.mediumPredictedSuccess} succeeded, ${cm.mediumPredictedFailed} failed`);
		lines.push(`  High risk:   ${cm.highPredictedSuccess} succeeded, ${cm.highPredictedFailed} failed`);
	} else {
		lines.push("No classifier prediction data available yet.");
	}
	lines.push("");

	// Throughput and Efficiency
	lines.push("THROUGHPUT & EFFICIENCY");
	lines.push("-".repeat(40));
	if (report.throughput.totalTasksCompleted > 0) {
		const successRate = (report.throughput.successfulTasks / report.throughput.totalTasksCompleted) * 100;
		lines.push(`Tasks completed: ${report.throughput.totalTasksCompleted} (${successRate.toFixed(0)}% success)`);
		lines.push(`Tasks per hour: ${report.throughput.tasksPerHour.toFixed(2)}`);
		lines.push(`Avg duration: ${report.throughput.avgTaskDurationMinutes.toFixed(1)} min`);
		lines.push("");
		lines.push(`Total lines changed: ${report.throughput.totalLinesChanged.toLocaleString()}`);
		lines.push(`Avg lines per task: ${report.throughput.avgLinesPerTask.toFixed(1)}`);
		lines.push(`Total files modified: ${report.throughput.totalFilesChanged}`);
		lines.push(`Avg files per task: ${report.throughput.avgFilesPerTask.toFixed(1)}`);
		lines.push("");
		lines.push(`Tokens per line: ${report.throughput.tokensPerLineChanged.toFixed(0)}`);
		lines.push(`Tokens per file: ${report.throughput.tokensPerFileModified.toFixed(0)}`);

		// Breakdown by complexity
		const complexityEntries = Object.entries(report.throughput.byComplexity);
		if (complexityEntries.length > 0) {
			lines.push("\nBy complexity level:");
			for (const [level, data] of complexityEntries.sort((a, b) => b[1].count - a[1].count)) {
				lines.push(
					`  ${level}: ${data.count} tasks, ${data.avgDuration.toFixed(1)} min avg, ${data.avgLines.toFixed(0)} lines avg, ${data.avgTokens.toFixed(0)} tokens avg`,
				);
			}
		}
	} else {
		lines.push("No throughput data available yet.");
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
