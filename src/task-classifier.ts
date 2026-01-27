/**
 * Task Classifier
 *
 * Semantic classification of tasks using RAG embeddings.
 * Replaces brittle keyword matching with embedding-based similarity search
 * to predict task risk and recommend actions based on historical outcomes.
 */

import { sessionLogger } from "./logger.js";
import { getRAGEngine } from "./rag/index.js";

const logger = sessionLogger.child({ module: "task-classifier" });

/**
 * Source identifier for task outcomes in RAG index
 */
export const TASK_OUTCOMES_SOURCE = "task-outcomes";

/**
 * Risk thresholds for classification recommendations
 */
const RISK_THRESHOLD_REVIEW = 0.6;
const RISK_THRESHOLD_REJECT = 0.8;

/**
 * Similar task from historical corpus
 */
export interface SimilarTask {
	taskId: string;
	objective: string;
	similarity: number;
	outcome: "success" | "failure";
	failureReason?: string;
}

/**
 * Task classification result
 */
export interface TaskClassification {
	/** Risk score (0-1), higher = riskier */
	riskScore: number;
	/** Confidence in prediction (0-1), based on corpus size */
	confidence: number;
	/** Top similar tasks from historical corpus */
	similarTasks: SimilarTask[];
	/** Human-readable risk factors */
	riskFactors: string[];
	/** Recommended action */
	recommendation: "proceed" | "review" | "reject";
}

/**
 * Metadata for indexed task outcomes
 */
export interface TaskOutcomeMetadata {
	failureReason?: string;
	failureCategory?: string;
	filesModified?: string[];
	durationMs?: number;
	modelUsed?: string;
}

/**
 * Classify a task by comparing against known historical outcomes.
 *
 * Uses RAG semantic search to find similar past tasks and calculates
 * a risk score based on their success/failure rates.
 *
 * @param objective - The task objective to classify
 * @param stateDir - State directory for RAG index (default: .undercity)
 * @returns Classification result with risk score and recommendation
 */
export async function classifyTask(objective: string, stateDir?: string): Promise<TaskClassification> {
	const ragEngine = getRAGEngine(stateDir);

	// Search for similar past tasks
	let results: Awaited<ReturnType<typeof ragEngine.search>>;
	try {
		results = await ragEngine.search(objective, {
			limit: 5,
			sources: [TASK_OUTCOMES_SOURCE],
		});
	} catch (error) {
		logger.debug({ error: String(error) }, "RAG search failed, returning neutral classification");
		return {
			riskScore: 0.5,
			confidence: 0,
			similarTasks: [],
			riskFactors: ["Classification unavailable (search failed)"],
			recommendation: "proceed",
		};
	}

	if (results.length === 0) {
		// No similar tasks - can't classify, proceed with caution
		return {
			riskScore: 0.5,
			confidence: 0,
			similarTasks: [],
			riskFactors: ["No similar historical tasks found"],
			recommendation: "proceed",
		};
	}

	// Convert search results to SimilarTask format
	const similarTasks: SimilarTask[] = results.map((r) => ({
		taskId: (r.document.metadata?.taskId as string) ?? "unknown",
		objective: r.chunk.content,
		similarity: r.score,
		outcome: (r.document.metadata?.outcome as "success" | "failure") ?? "success",
		failureReason: r.document.metadata?.failureReason as string | undefined,
	}));

	// Calculate risk score from similar task outcomes
	// Weight by similarity - closer matches count more
	let weightedFailures = 0;
	let totalWeight = 0;
	const riskFactors: string[] = [];

	for (const task of similarTasks) {
		const weight = task.similarity;
		totalWeight += weight;
		if (task.outcome === "failure") {
			weightedFailures += weight;
			if (task.similarity > 0.7) {
				const truncatedObjective = task.objective.substring(0, 50);
				const reason = task.failureReason ?? "unknown";
				riskFactors.push(`Similar task failed: "${truncatedObjective}..." (${reason})`);
			}
		}
	}

	const riskScore = totalWeight > 0 ? weightedFailures / totalWeight : 0.5;
	// More matches = higher confidence (capped at 1.0)
	const confidence = Math.min(totalWeight / 3, 1);

	const recommendation =
		riskScore >= RISK_THRESHOLD_REJECT ? "reject" : riskScore >= RISK_THRESHOLD_REVIEW ? "review" : "proceed";

	logger.debug(
		{
			objective: objective.substring(0, 50),
			riskScore,
			confidence,
			recommendation,
			similarCount: similarTasks.length,
		},
		"Task classification complete",
	);

	return { riskScore, confidence, similarTasks, riskFactors, recommendation };
}

/**
 * Index a task outcome for future classification.
 *
 * Call this after task completion (success or failure) to build
 * the historical corpus used for semantic classification.
 *
 * @param taskId - Unique task identifier
 * @param objective - Task objective text
 * @param outcome - Whether task succeeded or failed
 * @param metadata - Additional metadata about the task execution
 * @param stateDir - State directory for RAG index (default: .undercity)
 */
export async function indexTaskOutcome(
	taskId: string,
	objective: string,
	outcome: "success" | "failure",
	metadata: TaskOutcomeMetadata = {},
	stateDir?: string,
): Promise<void> {
	const ragEngine = getRAGEngine(stateDir);

	try {
		await ragEngine.indexContent({
			content: objective,
			source: TASK_OUTCOMES_SOURCE,
			title: `Task ${taskId}`,
			metadata: {
				taskId,
				outcome,
				...metadata,
				indexedAt: new Date().toISOString(),
			},
		});

		logger.debug({ taskId, outcome }, "Indexed task outcome for classification");
	} catch (error) {
		// Silent failure - classification is optional enhancement
		logger.warn({ taskId, error: String(error) }, "Failed to index task outcome");
	}
}

/**
 * Get statistics about the task classification corpus.
 *
 * @param stateDir - State directory for RAG index (default: .undercity)
 * @returns Stats about indexed task outcomes
 */
export function getClassificationStats(stateDir?: string): {
	totalIndexed: number;
	documentsBySource: Record<string, number>;
} {
	const ragEngine = getRAGEngine(stateDir);
	const stats = ragEngine.getStats();

	// Convert sources array to documentsBySource record
	const documentsBySource: Record<string, number> = {};
	for (const source of stats.sources) {
		documentsBySource[source.source] = source.documentCount;
	}

	// Get task-outcomes specific count
	const taskOutcomesCount = documentsBySource[TASK_OUTCOMES_SOURCE] ?? 0;

	return {
		totalIndexed: taskOutcomesCount,
		documentsBySource,
	};
}

/**
 * Check if classification corpus has enough data to be useful.
 *
 * @param stateDir - State directory for RAG index (default: .undercity)
 * @returns true if corpus has >= 5 task outcomes indexed
 */
export function hasClassificationData(stateDir?: string): boolean {
	const stats = getClassificationStats(stateDir);
	return stats.totalIndexed >= 5;
}
