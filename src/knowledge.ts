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

const DEFAULT_STATE_DIR = ".undercity";
const KNOWLEDGE_FILE = "knowledge.json";

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
		const parsed = JSON.parse(content) as KnowledgeBase;
		// Validate structure
		if (!Array.isArray(parsed.learnings)) {
			return {
				learnings: [],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
		}
		return parsed;
	} catch {
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
 * Add a new learning to the knowledge base
 */
export function addLearning(
	learning: Omit<Learning, "id" | "createdAt" | "usedCount" | "successCount" | "confidence">,
	stateDir: string = DEFAULT_STATE_DIR,
): Learning {
	const kb = loadKnowledge(stateDir);

	const newLearning: Learning = {
		...learning,
		id: generateLearningId(),
		confidence: 0.5, // Start at 50% confidence
		usedCount: 0,
		successCount: 0,
		createdAt: new Date().toISOString(),
	};

	// Check for duplicates (similar content)
	const isDuplicate = kb.learnings.some((existing) => {
		const similarity = calculateSimilarity(existing.content, newLearning.content);
		return similarity > 0.8; // 80% similarity threshold
	});

	if (!isDuplicate) {
		kb.learnings.push(newLearning);
		saveKnowledge(kb, stateDir);
	}

	return newLearning;
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
 * Find relevant learnings for a task objective
 */
export function findRelevantLearnings(
	objective: string,
	maxResults: number = 5,
	stateDir: string = DEFAULT_STATE_DIR,
): Learning[] {
	const kb = loadKnowledge(stateDir);
	const objectiveKeywords = new Set(extractKeywords(objective));

	// Score each learning by keyword overlap and confidence
	const scored = kb.learnings.map((learning) => {
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
 * Mark learnings as used for a task
 */
export function markLearningsUsed(
	learningIds: string[],
	taskSuccess: boolean,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	const kb = loadKnowledge(stateDir);
	const now = new Date().toISOString();

	for (const learning of kb.learnings) {
		if (learningIds.includes(learning.id)) {
			learning.usedCount++;
			learning.lastUsedAt = now;

			if (taskSuccess) {
				learning.successCount++;
				// Increase confidence on successful use (max 0.95)
				learning.confidence = Math.min(0.95, learning.confidence + 0.05);
			} else {
				// Decrease confidence on failed use (min 0.1)
				learning.confidence = Math.max(0.1, learning.confidence - 0.1);
			}
		}
	}

	saveKnowledge(kb, stateDir);
}

/**
 * Format learnings for injection into a prompt
 */
export function formatLearningsForPrompt(learnings: Learning[]): string {
	if (learnings.length === 0) return "";

	const formatted = learnings.map((l) => `- ${l.content}`).join("\n");

	return `RELEVANT LEARNINGS FROM PREVIOUS TASKS:
${formatted}

Use these insights if applicable to your current task.`;
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
