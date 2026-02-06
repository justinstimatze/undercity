/**
 * Knowledge Compounding Module
 *
 * Extracts learnings from completed tasks and injects relevant knowledge
 * into future task prompts. Each task completion deposits knowledge that
 * makes subsequent tasks easier.
 *
 * Storage: .undercity/knowledge.json
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withFileLock } from "./file-lock.js";
import { validateKnowledgeBase } from "./knowledge-validator.js";
import { sessionLogger } from "./logger.js";

const DEFAULT_STATE_DIR = ".undercity";
const KNOWLEDGE_FILE = "knowledge.json";

/**
 * Maximum number of learnings before consolidation triggers.
 * When exceeded, similar low-value learnings are merged together
 * rather than deleted, preserving knowledge that may still be relevant.
 */
const MAX_LEARNINGS = 500;

/**
 * Categories of learnings
 */
export type LearningCategory = "pattern" | "gotcha" | "preference" | "fact";

/**
 * A single learning extracted from task completion
 */
export interface Learning {
	/** Unique identifier */
	id: string;
	/** Task that produced this learning */
	taskId: string;
	/** Category of learning */
	category: LearningCategory;
	/** Natural language description */
	content: string;
	/** Keywords for retrieval */
	keywords: string[];
	/** Structured data if available */
	structured?: {
		file?: string;
		pattern?: string;
		approach?: string;
	};
	/** Confidence score (0-1), starts at 0.5, increases with successful reuse */
	confidence: number;
	/** Number of times this learning was injected into a task */
	usedCount: number;
	/** Number of times use led to task success */
	successCount: number;
	/** When this learning was created */
	createdAt: string;
	/** When this learning was last used */
	lastUsedAt?: string;
}

/**
 * The full knowledge base
 */
export interface KnowledgeBase {
	/** All learnings */
	learnings: Learning[];
	/** Version for future migrations */
	version: string;
	/** Last updated timestamp */
	lastUpdated: string;
}

/**
 * Get the knowledge file path
 */
function getKnowledgePath(stateDir: string = DEFAULT_STATE_DIR): string {
	return join(stateDir, KNOWLEDGE_FILE);
}

/**
 * Generate a unique learning ID
 *
 * Creates a unique identifier for each learning by combining:
 * - A base36 encoded timestamp (compact representation of current time)
 * - A random 6-character base36 string (prevents collisions)
 *
 * Example output: 'learn-xxxxxx-xxxxxx'
 *
 * @returns A unique, URL-safe learning identifier
 */
function generateLearningId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `learn-${timestamp}-${random}`;
}

/**
 * Load the knowledge base from disk
 */
export function loadKnowledge(stateDir: string = DEFAULT_STATE_DIR): KnowledgeBase {
	const path = getKnowledgePath(stateDir);

	if (!existsSync(path)) {
		return {
			learnings: [],
			version: "1.0",
			lastUpdated: new Date().toISOString(),
		};
	}

	try {
		const content = readFileSync(path, "utf-8");

		// Nested try-catch for JSON.parse errors specifically
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (parseError) {
			// Log parse failure with file path and error details
			sessionLogger.warn(
				{
					path,
					error: parseError instanceof Error ? parseError.message : String(parseError),
				},
				"Failed to parse knowledge.json, returning default knowledge base",
			);
			return {
				learnings: [],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
		}

		// Validate structure using validator
		const validationResult = validateKnowledgeBase(parsed);

		if (!validationResult.valid) {
			// Log validation issues but continue with default KB
			sessionLogger.warn(
				{
					path,
					issue: validationResult.issues[0]?.message,
				},
				"Knowledge base validation failed, using default",
			);
			return {
				learnings: [],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
		}

		// After validation passes, we know it's a valid KnowledgeBase structure
		const kb = parsed as KnowledgeBase;

		// Ensure version and lastUpdated exist for backward compatibility
		if (!kb.version) {
			kb.version = "1.0";
		}
		if (!kb.lastUpdated) {
			kb.lastUpdated = new Date().toISOString();
		}

		return kb;
	} catch (fileError) {
		// Handle file read errors (ENOENT, EACCES, etc.)
		sessionLogger.warn(
			{
				path,
				error: fileError instanceof Error ? fileError.message : String(fileError),
			},
			"Failed to read knowledge file, returning default knowledge base",
		);
		return {
			learnings: [],
			version: "1.0",
			lastUpdated: new Date().toISOString(),
		};
	}
}

/**
 * Save the knowledge base to disk
 */
function saveKnowledge(kb: KnowledgeBase, stateDir: string = DEFAULT_STATE_DIR): void {
	const path = getKnowledgePath(stateDir);
	const tempPath = `${path}.tmp`;
	const dir = dirname(path);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	kb.lastUpdated = new Date().toISOString();

	// Validate before saving
	const validationResult = validateKnowledgeBase(kb);
	if (!validationResult.valid) {
		const errorMessage = validationResult.issues
			.filter((i) => i.severity === "error")
			.map((i) => `${i.path}: ${i.message}`)
			.join("; ");
		throw new Error(`Cannot save invalid knowledge base: ${errorMessage}`);
	}

	try {
		writeFileSync(tempPath, JSON.stringify(kb, null, 2), {
			encoding: "utf-8",
			flag: "w",
		});
		renameSync(tempPath, path);
	} catch (error) {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
		throw error;
	}
}

/**
 * Extract keywords from text for retrieval
 *
 * Processes natural language text to extract meaningful keywords that can be used
 * for learning retrieval. Filters out common stop words and punctuation, then
 * returns the top 20 unique keywords for efficient matching against stored learnings.
 *
 * Used by findRelevantLearnings() to match task objectives against stored knowledge.
 * The extracted keywords enable fast similarity scoring between new tasks and existing
 * learnings to surface relevant past experience.
 *
 * @param text - The input text to extract keywords from (typically a task objective)
 * @returns Array of up to 20 unique, meaningful keywords (lowercase, deduplicated)
 */
function extractKeywords(text: string): string[] {
	// Common words to filter out
	const stopWords = new Set([
		"the",
		"a",
		"an",
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
		"shall",
		"can",
		"need",
		"dare",
		"ought",
		"used",
		"to",
		"of",
		"in",
		"for",
		"on",
		"with",
		"at",
		"by",
		"from",
		"as",
		"into",
		"through",
		"during",
		"before",
		"after",
		"above",
		"below",
		"between",
		"under",
		"again",
		"further",
		"then",
		"once",
		"here",
		"there",
		"when",
		"where",
		"why",
		"how",
		"all",
		"each",
		"few",
		"more",
		"most",
		"other",
		"some",
		"such",
		"no",
		"nor",
		"not",
		"only",
		"own",
		"same",
		"so",
		"than",
		"too",
		"very",
		"just",
		"and",
		"but",
		"if",
		"or",
		"because",
		"until",
		"while",
		"although",
		"though",
		"this",
		"that",
		"these",
		"those",
		"it",
		"its",
		"i",
		"you",
		"he",
		"she",
		"we",
		"they",
		"what",
		"which",
		"who",
		"whom",
	]);

	const words = text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 2 && !stopWords.has(word));

	// Deduplicate and return top keywords
	return [...new Set(words)].slice(0, 20);
}

/**
 * Consolidate knowledge base when it exceeds MAX_LEARNINGS.
 *
 * Strategy: merge the most similar low-value learnings together rather than
 * deleting by age, since old knowledge can still be valuable. Preserves
 * high-confidence and frequently-used learnings untouched.
 *
 * A "low-value" learning is one with confidence < 0.7 AND usedCount < 3.
 * Among those, find pairs with >0.5 similarity and merge them: keep the
 * higher-confidence one, append the other's unique keywords, and bump its
 * confidence slightly to reflect the consolidation.
 */
function consolidateKnowledge(kb: KnowledgeBase): void {
	const target = Math.floor(MAX_LEARNINGS * 0.8); // Consolidate down to 80% of cap

	// Phase 1: Identify low-value learnings eligible for consolidation
	const highValue: Learning[] = [];
	const lowValue: Learning[] = [];

	for (const l of kb.learnings) {
		if (l.confidence >= 0.7 || l.usedCount >= 3) {
			highValue.push(l);
		} else {
			lowValue.push(l);
		}
	}

	// If high-value alone fits, just drop the lowest-confidence low-value entries
	if (highValue.length >= target) {
		// Keep all high-value, keep best low-value up to target
		lowValue.sort((a, b) => b.confidence - a.confidence);
		const keepCount = Math.max(0, target - highValue.length);
		kb.learnings = [...highValue, ...lowValue.slice(0, keepCount)];
		sessionLogger.info(
			{ before: highValue.length + lowValue.length, after: kb.learnings.length },
			"Consolidated knowledge (trimmed low-value entries)",
		);
		return;
	}

	// Phase 2: Merge similar low-value learnings
	// Sort by confidence ascending so we merge the weakest first
	lowValue.sort((a, b) => a.confidence - b.confidence);
	const merged = new Set<string>();
	const survivors: Learning[] = [];

	for (let i = 0; i < lowValue.length; i++) {
		if (merged.has(lowValue[i].id)) continue;

		let current = lowValue[i];

		// Try to find a merge partner among remaining low-value learnings
		for (let j = i + 1; j < lowValue.length; j++) {
			if (merged.has(lowValue[j].id)) continue;

			const similarity = calculateSimilarity(current.content, lowValue[j].content);
			if (similarity > 0.5) {
				// Merge: keep current, absorb the other's unique keywords
				const otherKeywords = lowValue[j].keywords.filter((k) => !current.keywords.includes(k));
				current = {
					...current,
					keywords: [...current.keywords, ...otherKeywords].slice(0, 20),
					usedCount: current.usedCount + lowValue[j].usedCount,
					successCount: current.successCount + lowValue[j].successCount,
					confidence: Math.min(0.7, current.confidence + 0.05),
				};
				merged.add(lowValue[j].id);
			}
		}

		survivors.push(current);
	}

	kb.learnings = [...highValue, ...survivors];

	// If still over target, trim the weakest survivors
	if (kb.learnings.length > target) {
		kb.learnings.sort((a, b) => {
			// Score: confidence * 0.5 + (usedCount > 0 ? 0.3 : 0) + (successCount > 0 ? 0.2 : 0)
			const scoreA = a.confidence * 0.5 + (a.usedCount > 0 ? 0.3 : 0) + (a.successCount > 0 ? 0.2 : 0);
			const scoreB = b.confidence * 0.5 + (b.usedCount > 0 ? 0.3 : 0) + (b.successCount > 0 ? 0.2 : 0);
			return scoreB - scoreA;
		});
		kb.learnings = kb.learnings.slice(0, target);
	}

	sessionLogger.info(
		{ before: highValue.length + lowValue.length, after: kb.learnings.length, mergedCount: merged.size },
		"Consolidated knowledge (merged similar entries)",
	);
}

/**
 * Result of adding a learning to the knowledge base
 */
export interface AddLearningResult {
	/** The learning that was added (or the existing similar one) */
	learning: Learning;
	/** Whether a new learning was actually added */
	added: boolean;
	/** Novelty score (0 = duplicate, 1 = completely new) */
	noveltyScore: number;
	/** IDs of similar existing learnings if not added */
	similarTo?: string[];
}

/**
 * Add a new learning to the knowledge base
 * Returns novelty information for ROI assessment
 */
export function addLearning(
	learning: Omit<Learning, "id" | "createdAt" | "usedCount" | "successCount" | "confidence">,
	stateDir: string = DEFAULT_STATE_DIR,
): AddLearningResult {
	const knowledgePath = getKnowledgePath(stateDir);

	return withFileLock(knowledgePath, () => {
		// Re-read inside lock to get fresh state
		const kb = loadKnowledge(stateDir);

		const newLearning: Learning = {
			...learning,
			id: generateLearningId(),
			confidence: 0.5, // Start at 50% confidence
			usedCount: 0,
			successCount: 0,
			createdAt: new Date().toISOString(),
		};

		// Check for duplicates (similar content) and calculate novelty
		const similarities: { id: string; score: number }[] = [];
		for (const existing of kb.learnings) {
			const similarity = calculateSimilarity(existing.content, newLearning.content);
			if (similarity > 0.5) {
				// Track moderately similar learnings
				similarities.push({ id: existing.id, score: similarity });
			}
		}

		// Sort by similarity descending
		similarities.sort((a, b) => b.score - a.score);

		// Check if there's a high-similarity match (duplicate)
		const highSimilarity = similarities.filter((s) => s.score > 0.8);
		if (highSimilarity.length > 0) {
			// This is a duplicate - don't add
			const maxSimilarity = highSimilarity[0].score;
			const existingLearning = kb.learnings.find((l) => l.id === highSimilarity[0].id);
			return {
				learning: existingLearning || newLearning,
				added: false,
				noveltyScore: 1 - maxSimilarity,
				similarTo: highSimilarity.map((s) => s.id),
			};
		}

		// Calculate novelty score based on how different this is from existing learnings
		const noveltyScore = similarities.length > 0 ? 1 - similarities[0].score : 1.0;

		// Add the new learning
		kb.learnings.push(newLearning);

		// Consolidate if over cap to prevent unbounded growth
		if (kb.learnings.length > MAX_LEARNINGS) {
			consolidateKnowledge(kb);
		}

		saveKnowledge(kb, stateDir);

		return {
			learning: newLearning,
			added: true,
			noveltyScore,
			similarTo: similarities.length > 0 ? similarities.slice(0, 3).map((s) => s.id) : undefined,
		};
	});
}

/**
 * Simple similarity calculation between two strings
 */
function calculateSimilarity(a: string, b: string): number {
	const aWords = new Set(a.toLowerCase().split(/\s+/));
	const bWords = new Set(b.toLowerCase().split(/\s+/));

	const intersection = new Set([...aWords].filter((word) => bWords.has(word)));
	const union = new Set([...aWords, ...bWords]);

	return intersection.size / union.size;
}

/**
 * Configuration for learning quality filtering.
 * Learnings that don't meet these thresholds are not injected.
 */
export interface LearningQualityThresholds {
	/** Minimum confidence score (0-1) required for injection. Default: 0.7 */
	minConfidence: number;
	/** Minimum successful uses required. Default: 0 (allow new learnings) */
	minSuccessfulUses: number;
	/** Minimum success rate (successCount/usedCount) when usedCount > minUsesForRateCheck. Default: 0.3 */
	minSuccessRate: number;
	/** Minimum uses before success rate is checked. Default: 5 */
	minUsesForRateCheck: number;
}

/**
 * Default thresholds for learning quality.
 * These are tuned based on effectiveness analysis showing that
 * low-confidence learnings hurt more than they help.
 */
export const DEFAULT_QUALITY_THRESHOLDS: LearningQualityThresholds = {
	minConfidence: 0.7,
	minSuccessfulUses: 0, // Allow new learnings to prove themselves
	minSuccessRate: 0.3, // Prune learnings that fail >70% of the time
	minUsesForRateCheck: 5, // Only check rate after enough uses
};

/**
 * Thresholds that allow all learnings through without quality filtering.
 * Use for MCP tools and other contexts where external callers want full access.
 */
export const NO_QUALITY_THRESHOLDS: LearningQualityThresholds = {
	minConfidence: 0,
	minSuccessfulUses: 0,
	minSuccessRate: 0,
	minUsesForRateCheck: Number.MAX_SAFE_INTEGER, // Never check rate
};

/**
 * Check if a learning meets quality thresholds for injection.
 *
 * @param learning - The learning to check
 * @param thresholds - Quality thresholds (defaults to DEFAULT_QUALITY_THRESHOLDS)
 * @returns true if learning should be injected
 */
export function meetsQualityThreshold(
	learning: Learning,
	thresholds: LearningQualityThresholds = DEFAULT_QUALITY_THRESHOLDS,
): boolean {
	// Check minimum confidence
	if (learning.confidence < thresholds.minConfidence) {
		return false;
	}

	// Check minimum successful uses (allows new learnings by default)
	if (learning.successCount < thresholds.minSuccessfulUses) {
		return false;
	}

	// Check success rate only if learning has been used enough times
	if (learning.usedCount >= thresholds.minUsesForRateCheck) {
		const successRate = learning.successCount / learning.usedCount;
		if (successRate < thresholds.minSuccessRate) {
			return false;
		}
	}

	return true;
}

/**
 * Find relevant learnings for a task objective.
 *
 * Called from:
 * - worker.ts:2483 (context building before execution)
 * - task-planner.ts:373 (planning context gathering)
 * - automated-pm.ts:92 (PM decision context)
 *
 * @param objective - Task objective to find relevant learnings for
 * @param maxResults - Maximum number of learnings to return (default: 5)
 * @param stateDir - State directory (default: ".undercity")
 * @param thresholds - Quality thresholds for filtering (default: DEFAULT_QUALITY_THRESHOLDS)
 */
export function findRelevantLearnings(
	objective: string,
	maxResults: number = 5,
	stateDir: string = DEFAULT_STATE_DIR,
	thresholds: LearningQualityThresholds = DEFAULT_QUALITY_THRESHOLDS,
): Learning[] {
	const kb = loadKnowledge(stateDir);

	// Pre-filter learnings by quality threshold to avoid injecting harmful learnings
	const qualityLearnings = kb.learnings.filter((l) => meetsQualityThreshold(l, thresholds));

	// Try hybrid search (keyword + semantic) if embeddings module available
	try {
		// Dynamic import to avoid circular dependencies
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { hybridSearch, getEmbeddingStats } = require("./embeddings.js") as typeof import("./embeddings.js");
		const stats = getEmbeddingStats(stateDir);

		// Only use semantic search if we have enough embeddings
		if (stats.embeddedCount >= 3) {
			const results = hybridSearch(
				objective,
				{
					limit: maxResults * 2, // Get more, then filter
					keywordWeight: 0.4,
					semanticWeight: 0.6,
					minScore: 0.05,
				},
				stateDir,
			);

			if (results.length > 0) {
				// Map back to Learning objects, filtering by quality
				const learningMap = new Map(qualityLearnings.map((l) => [l.id, l]));
				const found = results
					.map((r) => learningMap.get(r.learningId))
					.filter((l): l is Learning => l !== undefined)
					.slice(0, maxResults);

				if (found.length > 0) {
					return found;
				}
			}
		}
	} catch {
		// Embeddings not available, fall back to keyword-only
	}

	// Fallback: keyword-only scoring (on quality-filtered learnings)
	const objectiveKeywords = new Set(extractKeywords(objective));

	// Score each learning by keyword overlap and confidence
	const scored = qualityLearnings.map((learning) => {
		const learningKeywords = new Set(learning.keywords);
		const overlap = [...objectiveKeywords].filter((kw) => learningKeywords.has(kw)).length;
		const keywordScore = overlap / Math.max(objectiveKeywords.size, 1);

		// Combined score: 70% keyword match, 30% confidence
		const score = keywordScore * 0.7 + learning.confidence * 0.3;

		return { learning, score };
	});

	// Filter to minimum score and sort by score
	return scored
		.filter((item) => item.score > 0.1)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults)
		.map((item) => item.learning);
}

/**
 * Mark learnings as used for a task.
 * Updates usage count and adjusts confidence based on task success.
 * Also prunes learnings that have consistently low success rates.
 *
 * This implements the learning quality feedback mechanism:
 * - Boost confidence on success (+0.02, max 0.95)
 * - Reduce confidence on failure (-0.05, min 0.1)
 * - Prune learnings with <30% success rate after 5+ uses
 *
 * Called from:
 * - worker.ts:1720 (after task completion)
 */
export function markLearningsUsed(
	learningIds: string[],
	taskSuccess: boolean,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	if (learningIds.length === 0) return;

	const knowledgePath = getKnowledgePath(stateDir);

	withFileLock(knowledgePath, () => {
		// Re-read inside lock to get fresh state
		const kb = loadKnowledge(stateDir);
		const now = new Date().toISOString();
		const prunedIds: string[] = [];

		for (const learning of kb.learnings) {
			if (learningIds.includes(learning.id)) {
				learning.usedCount++;
				learning.lastUsedAt = now;

				if (taskSuccess) {
					learning.successCount++;
					// Increase confidence on successful use (max 0.95)
					learning.confidence = Math.min(0.95, learning.confidence + 0.02);
				} else {
					// Decrease confidence on failed use (min 0.1)
					learning.confidence = Math.max(0.1, learning.confidence - 0.05);
				}

				// Check if learning should be pruned (low success rate after enough uses)
				if (learning.usedCount >= DEFAULT_QUALITY_THRESHOLDS.minUsesForRateCheck) {
					const successRate = learning.successCount / learning.usedCount;
					if (successRate < DEFAULT_QUALITY_THRESHOLDS.minSuccessRate) {
						prunedIds.push(learning.id);
						sessionLogger.info(
							{
								learningId: learning.id,
								successRate: Math.round(successRate * 100),
								usedCount: learning.usedCount,
								content: learning.content.substring(0, 50),
							},
							"Pruning learning due to low success rate",
						);
					}
				}
			}
		}

		// Remove pruned learnings
		if (prunedIds.length > 0) {
			kb.learnings = kb.learnings.filter((l) => !prunedIds.includes(l.id));
		}

		saveKnowledge(kb, stateDir);
	});
}

/**
 * Format learnings for injection into a prompt.
 *
 * Called from:
 * - worker.ts:2485 (context building)
 * - task-planner.ts:386 (planning context)
 */
export function formatLearningsForPrompt(learnings: Learning[]): string {
	if (learnings.length === 0) return "";

	const formatted = learnings.map((l) => `- ${l.content}`).join("\n");

	return `RELEVANT LEARNINGS FROM PREVIOUS TASKS:
${formatted}

Use these insights if applicable to your current task.`;
}

/**
 * 3-Layer Token-Efficient Retrieval (inspired by claude-mem)
 *
 * Layer 1: Compact index with IDs and truncated previews (~50 tokens per learning)
 * Layer 2: Timeline context around relevant learnings
 * Layer 3: Full content for selected IDs (~500-1000 tokens)
 *
 * This approach saves ~10x tokens by filtering before fetching details.
 */

/** Truncate text to a maximum length with ellipsis */
function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Layer 1: Format learnings as compact index (IDs + previews)
 * Use this for initial context injection to save tokens.
 *
 * Returns ~50 tokens per learning vs ~200+ for full content.
 */
export function formatLearningsCompact(learnings: Learning[]): string {
	if (learnings.length === 0) return "";

	const indexed = learnings.map((l, idx) => {
		const preview = truncateText(l.content, 80);
		const confidence = Math.round(l.confidence * 100);
		return `[${idx + 1}] ${l.category} (${confidence}%): ${preview}`;
	});

	return `KNOWLEDGE INDEX (${learnings.length} relevant learnings):
${indexed.join("\n")}

To use a learning, reference it by number. Full details available on request.`;
}

/**
 * Layer 2: Get timeline context around a learning
 * Returns learnings created before/after for temporal context.
 */
export function getLearningTimeline(
	learningId: string,
	windowSize: number = 2,
	stateDir: string = DEFAULT_STATE_DIR,
): { before: Learning[]; target: Learning | null; after: Learning[] } {
	const kb = loadKnowledge(stateDir);

	// Sort by creation time
	const sorted = [...kb.learnings].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

	const targetIdx = sorted.findIndex((l) => l.id === learningId);
	if (targetIdx === -1) {
		return { before: [], target: null, after: [] };
	}

	return {
		before: sorted.slice(Math.max(0, targetIdx - windowSize), targetIdx),
		target: sorted[targetIdx],
		after: sorted.slice(targetIdx + 1, targetIdx + 1 + windowSize),
	};
}

/**
 * Layer 3: Get full details for specific learning IDs
 * Use this to fetch complete content for learnings the agent needs.
 */
export function getLearningsByIds(ids: string[], stateDir: string = DEFAULT_STATE_DIR): Learning[] {
	const kb = loadKnowledge(stateDir);
	const idSet = new Set(ids);
	return kb.learnings.filter((l) => idSet.has(l.id));
}

/**
 * Get learnings by index numbers (1-based, as shown in compact format)
 * Convenience function for when agent references learnings by number.
 */
export function getLearningsByIndex(indices: number[], learnings: Learning[]): Learning[] {
	return indices.filter((idx) => idx >= 1 && idx <= learnings.length).map((idx) => learnings[idx - 1]);
}

/**
 * Format full details for selected learnings
 * Use after agent has identified which learnings are relevant.
 */
export function formatLearningDetails(learnings: Learning[]): string {
	if (learnings.length === 0) return "";

	const details = learnings.map((l) => {
		const meta = [
			`Category: ${l.category}`,
			`Confidence: ${Math.round(l.confidence * 100)}%`,
			`Used: ${l.usedCount} times (${l.successCount} successes)`,
			l.structured?.file ? `File: ${l.structured.file}` : null,
			l.structured?.pattern ? `Pattern: ${l.structured.pattern}` : null,
		]
			.filter(Boolean)
			.join(" | ");

		return `### Learning: ${l.id}
${meta}

${l.content}

Keywords: ${l.keywords.join(", ")}`;
	});

	return `LEARNING DETAILS:

${details.join("\n\n---\n\n")}`;
}

/**
 * Get knowledge base statistics
 */
export function getKnowledgeStats(stateDir: string = DEFAULT_STATE_DIR): {
	totalLearnings: number;
	byCategory: Record<LearningCategory, number>;
	avgConfidence: number;
	mostUsed: Array<{ content: string; usedCount: number }>;
} {
	const kb = loadKnowledge(stateDir);

	const byCategory: Record<LearningCategory, number> = {
		pattern: 0,
		gotcha: 0,
		preference: 0,
		fact: 0,
	};

	let totalConfidence = 0;

	for (const learning of kb.learnings) {
		byCategory[learning.category]++;
		totalConfidence += learning.confidence;
	}

	const avgConfidence = kb.learnings.length > 0 ? totalConfidence / kb.learnings.length : 0;

	const mostUsed = [...kb.learnings]
		.sort((a, b) => b.usedCount - a.usedCount)
		.slice(0, 5)
		.map((l) => ({ content: `${l.content.substring(0, 50)}...`, usedCount: l.usedCount }));

	return {
		totalLearnings: kb.learnings.length,
		byCategory,
		avgConfidence,
		mostUsed,
	};
}

/**
 * Prune low-confidence learnings that haven't been used
 */
export function pruneUnusedLearnings(
	maxAge: number = 30 * 24 * 60 * 60 * 1000, // 30 days
	stateDir: string = DEFAULT_STATE_DIR,
): number {
	const kb = loadKnowledge(stateDir);
	const now = Date.now();
	const originalCount = kb.learnings.length;

	kb.learnings = kb.learnings.filter((learning) => {
		const age = now - new Date(learning.createdAt).getTime();
		// Keep if: used at least once, OR high confidence, OR young
		return learning.usedCount > 0 || learning.confidence >= 0.7 || age < maxAge;
	});

	const prunedCount = originalCount - kb.learnings.length;

	if (prunedCount > 0) {
		saveKnowledge(kb, stateDir);
	}

	return prunedCount;
}
