/**
 * Knowledge Extractor
 *
 * Heuristic patterns to extract learnings from agent conversations.
 * Runs on task completion to identify reusable insights.
 */

import type { Learning, LearningCategory } from "./knowledge.js";
import { addLearning } from "./knowledge.js";

/**
 * Pattern definition for extracting learnings
 */
interface ExtractionPattern {
	/** Regex to match learning content */
	pattern: RegExp;
	/** Category to assign */
	category: LearningCategory;
	/** Transform matched content (default: use capture group 1) */
	transform?: (match: RegExpMatchArray) => string;
}

/**
 * Patterns that indicate reusable learnings in agent output
 */
const LEARNING_PATTERNS: ExtractionPattern[] = [
	// Discovery patterns - things the agent found out
	{ pattern: /I found that (.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /I discovered that (.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /It turns out (?:that )?(.+?)(?:\.|$)/gi, category: "fact" },

	// Problem resolution patterns
	{ pattern: /The issue was (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /The problem was (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /The fix (?:was|is) to (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /The solution (?:was|is) to (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /This failed because (.+?)(?:\.|$)/gi, category: "gotcha" },

	// Codebase patterns - how this project works
	{ pattern: /This codebase uses (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /This project uses (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /The pattern here is (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /The convention (?:here )?is (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /Files in this project (.+?)(?:\.|$)/gi, category: "pattern" },

	// Important notes
	{ pattern: /Note: (.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /Important: (.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /Remember: (.+?)(?:\.|$)/gi, category: "fact" },

	// Preference patterns - user/project preferences
	{ pattern: /(?:The )?preferred (?:way|approach|method) is (.+?)(?:\.|$)/gi, category: "preference" },
	{ pattern: /(?:This|The) project prefers (.+?)(?:\.|$)/gi, category: "preference" },
	{ pattern: /Always (.+?) in this (?:codebase|project)/gi, category: "preference" },
	{ pattern: /Never (.+?) in this (?:codebase|project)/gi, category: "preference" },
];

/**
 * Minimum content length to be considered a valid learning
 */
const MIN_CONTENT_LENGTH = 15;

/**
 * Maximum content length (truncate longer content)
 */
const MAX_CONTENT_LENGTH = 500;

/**
 * Extract file references from content
 */
function extractFileReference(content: string): string | undefined {
	// Match common file path patterns
	const filePatterns = [
		/(?:in|from|at)\s+[`"]?([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)[`"]?/i,
		/(?:file|path)\s+[`"]?([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)[`"]?/i,
		/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_\-./]+\.[a-zA-Z]+)/,
	];

	for (const pattern of filePatterns) {
		const match = content.match(pattern);
		if (match?.[1]) {
			return match[1];
		}
	}
	return undefined;
}

/**
 * Extract keywords from learning content
 */
function extractKeywords(content: string): string[] {
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

	const words = content
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 2 && !stopWords.has(word));

	// Deduplicate and return top keywords
	return [...new Set(words)].slice(0, 15);
}

/**
 * Clean and normalize extracted content
 */
function cleanContent(content: string): string {
	return content
		.trim()
		.replace(/\s+/g, " ")
		.replace(/^[,.\s]+/, "")
		.replace(/[,.\s]+$/, "")
		.slice(0, MAX_CONTENT_LENGTH);
}

/**
 * Extracted learning before storage
 */
export interface ExtractedLearning {
	category: LearningCategory;
	content: string;
	keywords: string[];
	structured?: {
		file?: string;
		pattern?: string;
		approach?: string;
	};
}

/**
 * Extract learnings from agent conversation text
 */
export function extractLearnings(text: string): ExtractedLearning[] {
	const learnings: ExtractedLearning[] = [];
	const seen = new Set<string>();

	for (const { pattern, category, transform } of LEARNING_PATTERNS) {
		// Reset regex state for global patterns
		pattern.lastIndex = 0;

		let match = pattern.exec(text);
		while (match !== null) {
			const rawContent = transform ? transform(match) : match[1];

			if (rawContent) {
				const content = cleanContent(rawContent);
				const contentKey = content.toLowerCase();

				// Only add if long enough and not duplicate
				if (content.length >= MIN_CONTENT_LENGTH && !seen.has(contentKey)) {
					seen.add(contentKey);
					const keywords = extractKeywords(content);
					const file = extractFileReference(content);

					learnings.push({
						category,
						content,
						keywords,
						structured: file ? { file } : undefined,
					});
				}
			}

			match = pattern.exec(text);
		}
	}

	return learnings;
}

/**
 * Extract and store learnings from a completed task
 */
export function extractAndStoreLearnings(
	taskId: string,
	conversationText: string,
	stateDir: string = ".undercity",
): Learning[] {
	const extracted = extractLearnings(conversationText);
	const stored: Learning[] = [];

	for (const learning of extracted) {
		const result = addLearning(
			{
				taskId,
				category: learning.category,
				content: learning.content,
				keywords: learning.keywords,
				structured: learning.structured,
			},
			stateDir,
		);
		stored.push(result);
	}

	return stored;
}

/**
 * Extract learnings from structured task result
 */
export function extractFromTaskResult(
	taskId: string,
	result: {
		output?: string;
		error?: string;
		files?: string[];
	},
	stateDir: string = ".undercity",
): Learning[] {
	const textParts: string[] = [];

	if (result.output) {
		textParts.push(result.output);
	}

	if (result.error) {
		// Errors often contain valuable gotchas
		textParts.push(`The issue was ${result.error}`);
	}

	const combinedText = textParts.join("\n\n");
	return extractAndStoreLearnings(taskId, combinedText, stateDir);
}
