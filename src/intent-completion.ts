/**
 * Intent Completion Module
 *
 * Intercepts ambiguous/partial task objectives at command intake,
 * predicts full intent using historical task patterns and decision data,
 * and presents predictions to users for confirmation.
 *
 * Operates PRE-PLANNING (distinct from task-planner's resolveOpenQuestions
 * which handles mid-planning decisions).
 */

import { extractKeywords, findSimilarTasks } from "./feedback-metrics.js";
import { findRelevantFiles } from "./task-file-patterns.js";
import type { ModelTier } from "./types.js";

/**
 * Confidence level for intent predictions
 */
export type IntentConfidence = "high" | "medium" | "low";

/**
 * Detail inferred from historical patterns
 */
export interface InferredDetail {
	/** What was inferred */
	detail: string;
	/** How many historical tasks support this */
	supportCount: number;
	/** Percentage of similar tasks that used this */
	prevalence: number;
}

/**
 * Result of intent prediction
 */
export interface IntentPredictionResult {
	/** Original user-provided objective */
	originalObjective: string;
	/** Predicted complete objective */
	predictedObjective: string;
	/** Confidence level of prediction */
	confidence: IntentConfidence;
	/** Details inferred from historical patterns */
	inferredDetails: InferredDetail[];
	/** Reasoning for the prediction */
	reasoning: string;
	/** Similar historical tasks used as evidence */
	similarTasks: Array<{
		objective: string;
		success: boolean;
		model: ModelTier;
		similarity: number;
	}>;
	/** Whether the objective was flagged as ambiguous */
	isAmbiguous: boolean;
}

/**
 * Stop words to filter when analyzing objectives
 */
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"to",
	"in",
	"on",
	"at",
	"for",
	"of",
	"and",
	"or",
	"is",
	"it",
	"be",
	"as",
	"with",
	"that",
	"this",
	"from",
]);

/**
 * Vague action verbs that need more context
 */
const VAGUE_VERBS = new Set([
	"add",
	"improve",
	"fix",
	"enhance",
	"update",
	"better",
	"refactor",
	"change",
	"modify",
	"optimize",
	"handle",
	"support",
	"implement",
]);

/**
 * Single-word keywords that are commonly ambiguous without context
 */
const AMBIGUOUS_SINGLE_KEYWORDS = new Set([
	"auth",
	"authentication",
	"authorization",
	"performance",
	"testing",
	"tests",
	"refactor",
	"refactoring",
	"security",
	"logging",
	"caching",
	"cache",
	"validation",
	"error",
	"errors",
	"bug",
	"bugs",
	"docs",
	"documentation",
	"config",
	"configuration",
	"types",
	"typing",
	"lint",
	"linting",
	"format",
	"formatting",
	"style",
	"styling",
	"api",
	"database",
	"db",
	"ui",
	"ux",
]);

/**
 * Domain-specific keywords that indicate specificity
 */
const DOMAIN_KEYWORDS = new Set([
	"jwt",
	"oauth",
	"token",
	"session",
	"cookie",
	"redis",
	"postgres",
	"mongodb",
	"react",
	"vue",
	"angular",
	"typescript",
	"zod",
	"vitest",
	"jest",
	"pnpm",
	"npm",
	"webpack",
	"vite",
	"esbuild",
	"docker",
	"kubernetes",
	"aws",
	"gcp",
	"azure",
	"graphql",
	"rest",
	"websocket",
	"grpc",
]);

/**
 * Extract meaningful words from an objective, filtering stop words
 */
function extractMeaningfulWords(objective: string): string[] {
	return objective
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Check if objective contains domain-specific keywords
 */
function hasDomainKeywords(objective: string): boolean {
	const words = extractMeaningfulWords(objective);
	return words.some((w) => DOMAIN_KEYWORDS.has(w));
}

/**
 * Check if objective starts with a vague verb
 */
function startsWithVagueVerb(objective: string): boolean {
	const firstWord = objective.toLowerCase().split(/\s+/)[0] ?? "";
	return VAGUE_VERBS.has(firstWord);
}

/**
 * Check if objective is a single ambiguous keyword
 */
function isSingleAmbiguousKeyword(objective: string): boolean {
	const words = extractMeaningfulWords(objective);
	if (words.length !== 1) return false;
	return AMBIGUOUS_SINGLE_KEYWORDS.has(words[0]);
}

/**
 * Detect if an objective is ambiguous and needs intent completion
 *
 * Criteria for ambiguity:
 * 1. Single keyword without context (auth, performance, testing)
 * 2. Vague verb without specific target/method
 * 3. Very short (<10 chars) AND lacks domain-specific keywords
 * 4. Contains only stop words (unlikely but handled)
 */
export function isAmbiguous(objective: string): boolean {
	const trimmed = objective.trim();

	// Empty or trivially short
	if (trimmed.length === 0) return true;

	// Single ambiguous keyword
	if (isSingleAmbiguousKeyword(trimmed)) return true;

	const words = extractMeaningfulWords(trimmed);

	// All words filtered out = only stop words
	if (words.length === 0) return true;

	// Short objective (<10 chars) without domain keywords
	if (trimmed.length < 10 && !hasDomainKeywords(trimmed)) return true;

	// Vague verb + short objective without specifics
	if (startsWithVagueVerb(trimmed) && trimmed.length < 25 && !hasDomainKeywords(trimmed)) {
		return true;
	}

	return false;
}

/**
 * Extract partial intent details that ARE present in the objective
 */
export function extractPartialIntent(objective: string): {
	keywords: string[];
	hasVerb: boolean;
	verb: string | null;
	hasTarget: boolean;
	target: string | null;
} {
	const words = extractMeaningfulWords(objective);
	const firstWord = objective.toLowerCase().split(/\s+/)[0] ?? "";
	const hasVerb = VAGUE_VERBS.has(firstWord);

	// Extract potential target (first noun-like word after verb)
	let target: string | null = null;
	if (hasVerb && words.length > 1) {
		target = words.find((w) => !VAGUE_VERBS.has(w)) ?? null;
	}

	return {
		keywords: words,
		hasVerb,
		verb: hasVerb ? firstWord : null,
		hasTarget: target !== null,
		target,
	};
}

/**
 * Find similar historical tasks from metrics
 */
export function findSimilarHistoricalTasks(
	keywords: string[],
	maxAge?: Date,
): Array<{
	objective: string;
	similarity: number;
	success: boolean;
	model: ModelTier;
}> {
	// Build query from keywords
	const query = keywords.join(" ");

	// Get similar tasks from feedback-metrics
	const similar = findSimilarTasks(query, maxAge ? { since: maxAge } : undefined);

	// Filter out very old tasks (>12 months) for inference
	const twelveMonthsAgo = new Date();
	twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

	return similar.filter((t) => t.similarity >= 0.2);
}

/**
 * Infer missing context from similar historical tasks
 */
export function inferMissingContext(
	_objective: string,
	similarTasks: Array<{
		objective: string;
		similarity: number;
		success: boolean;
		model: ModelTier;
	}>,
): InferredDetail[] {
	if (similarTasks.length === 0) return [];

	// Extract patterns from successful similar tasks
	const successfulTasks = similarTasks.filter((t) => t.success);
	if (successfulTasks.length === 0) return [];

	// Count keyword occurrences in successful task objectives
	const keywordCounts = new Map<string, number>();
	for (const task of successfulTasks) {
		const taskKeywords = extractKeywords(task.objective);
		for (const keyword of taskKeywords) {
			keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
		}
	}

	// Find high-prevalence patterns (appear in >50% of similar tasks)
	const totalSuccessful = successfulTasks.length;
	const inferredDetails: InferredDetail[] = [];

	for (const [keyword, count] of keywordCounts) {
		const prevalence = count / totalSuccessful;
		if (prevalence >= 0.5 && count >= 2) {
			// Skip generic words
			if (STOP_WORDS.has(keyword) || VAGUE_VERBS.has(keyword)) continue;

			inferredDetails.push({
				detail: keyword,
				supportCount: count,
				prevalence,
			});
		}
	}

	// Sort by prevalence descending
	return inferredDetails.sort((a, b) => b.prevalence - a.prevalence).slice(0, 5);
}

/**
 * Calculate confidence level based on similar task count and keyword overlap
 */
function calculateConfidence(
	similarTasks: Array<{ similarity: number }>,
	inferredDetails: InferredDetail[],
): IntentConfidence {
	const highSimilarityCount = similarTasks.filter((t) => t.similarity >= 0.6).length;
	const hasStrongInference = inferredDetails.some((d) => d.prevalence >= 0.7 && d.supportCount >= 3);

	// High: 3+ similar tasks with 60%+ overlap, or strong inference
	if (highSimilarityCount >= 3 || hasStrongInference) {
		return "high";
	}

	// Medium: 1-2 similar tasks
	if (similarTasks.length >= 1) {
		return "medium";
	}

	// Low: no similar tasks
	return "low";
}

/**
 * Build predicted objective from partial intent and inferences
 */
function buildPredictedObjective(
	originalObjective: string,
	_partialIntent: ReturnType<typeof extractPartialIntent>,
	inferredDetails: InferredDetail[],
	similarTasks: Array<{ objective: string; success: boolean }>,
): string {
	// If we have successful similar tasks, use the most similar successful one as a template
	const bestSuccessful = similarTasks.find((t) => t.success);
	if (bestSuccessful) {
		// Use similar task's objective as base, but this might be too different
		// Instead, enhance the original with inferred details
	}

	// Build enhanced objective
	let predicted = originalObjective;

	// If we have inferred details, append them
	if (inferredDetails.length > 0) {
		// Get relevant file suggestions to add specificity
		const relevantFiles = findRelevantFiles(originalObjective, 3);

		// Build suggestion list from inferences
		const suggestions = inferredDetails
			.slice(0, 3)
			.map((d) => d.detail)
			.join(", ");

		// If original is very short, expand it significantly
		if (originalObjective.length < 15) {
			// Use best successful task as template if available
			if (bestSuccessful) {
				predicted = bestSuccessful.objective;
			} else {
				predicted = `${originalObjective} with ${suggestions}`;
			}
		} else {
			// Append relevant details
			predicted = `${originalObjective} (consider: ${suggestions})`;
		}

		// Add file hints if available
		if (relevantFiles.length > 0) {
			const fileHints = relevantFiles
				.slice(0, 2)
				.map((f) => f.file)
				.join(", ");
			predicted = `${predicted} - likely files: ${fileHints}`;
		}
	}

	return predicted;
}

/**
 * Build reasoning string explaining the prediction
 */
function buildReasoning(
	similarTasks: Array<{ objective: string; success: boolean; similarity: number }>,
	inferredDetails: InferredDetail[],
	confidence: IntentConfidence,
): string {
	const parts: string[] = [];

	// Historical task evidence
	if (similarTasks.length > 0) {
		const successCount = similarTasks.filter((t) => t.success).length;
		const avgSimilarity = Math.round((similarTasks.reduce((s, t) => s + t.similarity, 0) / similarTasks.length) * 100);
		parts.push(
			`Found ${similarTasks.length} similar past tasks (${successCount} successful, ${avgSimilarity}% avg similarity)`,
		);
	} else {
		parts.push("No similar historical tasks found");
	}

	// Inference evidence
	if (inferredDetails.length > 0) {
		const topDetail = inferredDetails[0];
		parts.push(`"${topDetail.detail}" appeared in ${Math.round(topDetail.prevalence * 100)}% of similar tasks`);
	}

	// Confidence note
	if (confidence === "low") {
		parts.push("Low confidence - please provide more details");
	} else if (confidence === "medium") {
		parts.push("Medium confidence - review suggested prediction");
	}

	return parts.join(". ");
}

/**
 * Predict full intent from partial/ambiguous objective
 *
 * Main entry point for intent completion
 */
export function predictFullIntent(objective: string): IntentPredictionResult {
	const isAmb = isAmbiguous(objective);
	const partialIntent = extractPartialIntent(objective);

	// Find similar historical tasks
	const similarTasks = findSimilarHistoricalTasks(partialIntent.keywords);

	// Infer missing context from similar tasks
	const inferredDetails = inferMissingContext(objective, similarTasks);

	// Calculate confidence
	const confidence = calculateConfidence(similarTasks, inferredDetails);

	// Build predicted objective
	const predictedObjective = isAmb
		? buildPredictedObjective(objective, partialIntent, inferredDetails, similarTasks)
		: objective;

	// Build reasoning
	const reasoning = buildReasoning(similarTasks, inferredDetails, confidence);

	return {
		originalObjective: objective,
		predictedObjective,
		confidence,
		inferredDetails,
		reasoning,
		similarTasks,
		isAmbiguous: isAmb,
	};
}

/**
 * Format prediction result for display to user
 */
export function formatPredictionDisplay(result: IntentPredictionResult): string {
	const lines: string[] = [];

	if (!result.isAmbiguous) {
		return ""; // No display needed for non-ambiguous objectives
	}

	lines.push("Intent Completion Suggestion");
	lines.push("".padEnd(40, "-"));
	lines.push("");
	lines.push(`Original: "${result.originalObjective}"`);
	lines.push(`Predicted: "${result.predictedObjective}"`);
	lines.push("");
	lines.push(`Confidence: ${result.confidence}`);
	lines.push("");
	lines.push("Reasoning:");
	lines.push(`  ${result.reasoning}`);
	lines.push("");

	if (result.similarTasks.length > 0) {
		lines.push("Similar historical tasks:");
		for (const task of result.similarTasks.slice(0, 3)) {
			const status = task.success ? "[OK]" : "[FAIL]";
			lines.push(`  ${status} ${task.objective.slice(0, 60)}...`);
		}
		lines.push("");
	}

	if (result.inferredDetails.length > 0) {
		lines.push("Inferred patterns:");
		for (const detail of result.inferredDetails.slice(0, 3)) {
			lines.push(`  - "${detail.detail}" (${Math.round(detail.prevalence * 100)}% of similar tasks)`);
		}
	}

	return lines.join("\n");
}

/**
 * Check if intent completion should be skipped for this objective
 * Used to bypass intent completion for clearly specific objectives
 */
export function shouldSkipIntentCompletion(objective: string): boolean {
	// Skip if objective is long and detailed (>60 chars with domain keywords)
	if (objective.length > 60 && hasDomainKeywords(objective)) {
		return true;
	}

	// Skip if objective contains file paths
	// Use bounded quantifiers to prevent ReDoS (catastrophic backtracking)
	if (objective.match(/[\w-]{1,50}\/[\w.-]{1,100}\.[\w]{1,10}/)) {
		return true;
	}

	// Skip if objective has explicit task prefixes like [meta:*], [plan], etc.
	if (objective.match(/^\[[\w:]+\]/)) {
		return true;
	}

	return false;
}
