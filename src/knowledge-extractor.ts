/**
 * Knowledge Extractor
 *
 * Extracts learnings from agent conversations using:
 * 1. Model-based extraction (haiku) - more accurate, handles nuance
 * 2. Pattern matching fallback - fast, no API call
 *
 * Runs on task completion to identify reusable insights.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Learning, LearningCategory } from "./knowledge.js";
import { addLearning } from "./knowledge.js";
import { sessionLogger } from "./logger.js";
import { MODEL_NAMES } from "./types.js";

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
	{ pattern: /I noticed (?:that )?(.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /I see (?:that )?(.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /Looking at (?:the )?(?:code|file|function),?\s*(.+?)(?:\.|$)/gi, category: "fact" },

	// Problem resolution patterns
	{ pattern: /The issue was (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /The problem was (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /The fix (?:was|is) to (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /The solution (?:was|is) to (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /This failed because (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /The error (?:was|is) (?:caused by |due to )?(.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /(?:To fix|Fixed) (?:this|it) by (.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /The root cause (?:was|is) (.+?)(?:\.|$)/gi, category: "gotcha" },

	// Codebase patterns - how this project works
	{ pattern: /This codebase uses (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /This project uses (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /The pattern here is (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /The convention (?:here )?is (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /Files in this project (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /This (?:file|module|function) (?:is responsible for|handles) (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /The (?:file|module) exports (.+?)(?:\.|$)/gi, category: "pattern" },
	{ pattern: /(?:It|This) imports (?:from )?(.+?)(?:\.|$)/gi, category: "pattern" },

	// Reasoning patterns - why something works
	{ pattern: /This works because (.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /The reason (?:is|was) (?:that )?(.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /This approach (.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /(?:I|We) need(?:ed)? to (.+?) because (.+?)(?:\.|$)/gi, category: "fact" },

	// Important notes
	{ pattern: /Note: (.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /Important: (.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /Remember: (.+?)(?:\.|$)/gi, category: "fact" },
	{ pattern: /(?:Be )?careful (?:to |about |with )?(.+?)(?:\.|$)/gi, category: "gotcha" },
	{ pattern: /(?:Make sure|Ensure) (?:to |that )?(.+?)(?:\.|$)/gi, category: "gotcha" },

	// Preference patterns - user/project preferences
	{ pattern: /(?:The )?preferred (?:way|approach|method) is (.+?)(?:\.|$)/gi, category: "preference" },
	{ pattern: /(?:This|The) project prefers (.+?)(?:\.|$)/gi, category: "preference" },
	{ pattern: /Always (.+?) in this (?:codebase|project)/gi, category: "preference" },
	{ pattern: /Never (.+?) in this (?:codebase|project)/gi, category: "preference" },
	{ pattern: /(?:Should|Must) (?:always )?(.+?) when (.+?)(?:\.|$)/gi, category: "preference" },
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
 * Configuration for parallel transcript processing
 */
export interface ParallelExtractionConfig {
	/** Enable parallel processing (default: false) */
	enabled: boolean;
	/** Character size for each chunk (default: 5000) */
	chunkSize: number;
	/** Max concurrent LM requests (default: 3) */
	maxConcurrentRequests: number;
	/** Fallback to sequential if transcript < this length (default: 15000) */
	fallbackThreshold: number;
}

/**
 * Split transcript into chunks on sentence boundaries to avoid breaking mid-phrase
 */
function _splitTranscriptIntoChunks(text: string, chunkSize: number = 5000): string[] {
	if (text.length <= chunkSize) {
		return [text];
	}

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= chunkSize) {
			chunks.push(remaining);
			break;
		}

		// Find the last sentence boundary within the chunk
		const chunk = remaining.slice(0, chunkSize);
		const lastPeriod = Math.max(
			chunk.lastIndexOf(". "),
			chunk.lastIndexOf(".\n"),
			chunk.lastIndexOf("?"),
			chunk.lastIndexOf("!"),
		);

		if (lastPeriod > chunkSize * 0.7) {
			// Good boundary found, split there
			chunks.push(remaining.slice(0, lastPeriod + 1));
			remaining = remaining.slice(lastPeriod + 1).trim();
		} else {
			// No good boundary, split at char boundary
			chunks.push(chunk);
			remaining = remaining.slice(chunkSize).trim();
		}
	}

	return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Limit concurrent promises using a simple queue mechanism
 */
async function _pLimit<T>(concurrency: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
	const results: T[] = [];
	let running = 0;
	let index = 0;

	return new Promise((resolve, reject) => {
		const next = async () => {
			if (index >= tasks.length && running === 0) {
				resolve(results);
				return;
			}

			while (running < concurrency && index < tasks.length) {
				running++;
				const currentIndex = index;
				index++;

				try {
					const result = await tasks[currentIndex]();
					results[currentIndex] = result;
				} catch (error) {
					reject(error);
					return;
				}

				running--;
				next();
			}
		};

		next();
	});
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
 * Model-based extraction prompt
 */
const EXTRACTION_PROMPT = `Analyze this agent conversation and extract reusable learnings.

Return a JSON array of learnings. Each learning should have:
- category: "pattern" (codebase conventions), "gotcha" (pitfalls/fixes), "fact" (discoveries), or "preference" (user/project preferences)
- content: The actual insight (15-200 chars, actionable and specific)
- file: Optional file path if the learning is file-specific

Focus on:
1. Codebase patterns discovered (how things work in this project)
2. Gotchas and fixes (problems encountered and how they were resolved)
3. Facts learned (specific discoveries about the code)
4. Preferences (conventions or approaches preferred in this project)

Skip trivial observations. Only extract learnings that would help future tasks.

If there are no meaningful learnings, return an empty array: []

CONVERSATION:
`;

/**
 * Schema for model-extracted learning
 */
interface ModelExtractedLearning {
	category: LearningCategory;
	content: string;
	file?: string;
}

/**
 * Extract learnings using a model (haiku)
 * More accurate than pattern matching, handles nuance better
 */
async function extractLearningsWithModel(text: string): Promise<ExtractedLearning[]> {
	// Skip if text is too short or too long
	if (text.length < 100) {
		return [];
	}

	// Truncate very long texts to avoid token limits
	const truncatedText = text.length > 15000 ? `${text.slice(0, 15000)}\n[truncated]` : text;

	const prompt = EXTRACTION_PROMPT + truncatedText;

	try {
		let result = "";
		for await (const message of query({
			prompt,
			options: {
				model: MODEL_NAMES.haiku,
				maxTurns: 1,
				permissionMode: "bypassPermissions",
			},
		})) {
			if (message.type === "result" && message.subtype === "success") {
				result = message.result;
			}
		}

		// Parse the JSON response
		const jsonMatch = result.match(/\[[\s\S]*\]/);
		if (!jsonMatch) {
			sessionLogger.debug("Model extraction returned no JSON array");
			return [];
		}

		const parsed = JSON.parse(jsonMatch[0]) as ModelExtractedLearning[];
		if (!Array.isArray(parsed)) {
			return [];
		}

		// Convert to ExtractedLearning format
		return parsed
			.filter((l) => l.category && l.content && l.content.length >= MIN_CONTENT_LENGTH)
			.map((l) => ({
				category: l.category,
				content: cleanContent(l.content),
				keywords: extractKeywords(l.content),
				structured: l.file ? { file: l.file } : undefined,
			}));
	} catch (error) {
		sessionLogger.debug({ error: String(error) }, "Model-based extraction failed, falling back to patterns");
		return [];
	}
}

/**
 * Extract and store learnings from a completed task
 * Uses model-based extraction with pattern matching fallback
 */
export async function extractAndStoreLearnings(
	taskId: string,
	conversationText: string,
	stateDir: string = ".undercity",
): Promise<Learning[]> {
	// Try model-based extraction first
	let extracted = await extractLearningsWithModel(conversationText);

	// Fall back to pattern matching if model extraction found nothing
	if (extracted.length === 0) {
		extracted = extractLearnings(conversationText);
	}

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

	if (stored.length > 0) {
		sessionLogger.info({ taskId, count: stored.length }, "Extracted and stored learnings");
	}

	return stored;
}

/**
 * Extract learnings from structured task result
 */
export async function extractFromTaskResult(
	taskId: string,
	result: {
		output?: string;
		error?: string;
		files?: string[];
	},
	stateDir: string = ".undercity",
): Promise<Learning[]> {
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
