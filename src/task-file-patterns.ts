/**
 * Task-File Pattern Learning
 *
 * Correlates task descriptions with files modified, enabling:
 * - "Tasks mentioning X typically touch files Y, Z"
 * - "When file A changes, file B usually needs updating too"
 *
 * Storage: .undercity/task-file-patterns.json
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_STATE_DIR = ".undercity";
const PATTERNS_FILE = "task-file-patterns.json";

/**
 * A record of a completed task and its files
 */
interface TaskFileRecord {
	/** Task ID */
	taskId: string;
	/** Keywords extracted from task */
	keywords: string[];
	/** Files that were modified */
	filesModified: string[];
	/** Whether the task succeeded */
	success: boolean;
	/** When recorded */
	recordedAt: string;
}

/**
 * Keyword to files correlation
 */
interface KeywordFileCorrelation {
	/** The keyword */
	keyword: string;
	/** Files modified when this keyword appears, with counts */
	files: Record<string, number>;
	/** Total tasks with this keyword */
	taskCount: number;
	/** Successful tasks with this keyword */
	successCount: number;
}

/**
 * Co-modification pattern - files that change together
 */
interface CoModificationPattern {
	/** Primary file */
	file: string;
	/** Files that often change alongside, with counts */
	coModified: Record<string, number>;
	/** Total modifications of this file */
	modificationCount: number;
}

/**
 * The full pattern store
 */
export interface TaskFileStore {
	/** Recent task records (for analysis) */
	recentTasks: TaskFileRecord[];
	/** Keyword to file correlations */
	keywordCorrelations: Record<string, KeywordFileCorrelation>;
	/** Co-modification patterns */
	coModificationPatterns: Record<string, CoModificationPattern>;
	/** Version */
	version: string;
	/** Last updated */
	lastUpdated: string;
}

// Common stop words to filter from task descriptions
const STOP_WORDS = new Set([
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
	"add",
	"create",
	"update",
	"fix",
	"remove",
	"delete",
	"change",
	"modify",
	"implement",
	"make",
	"new",
	"file",
	"code",
]);

/**
 * Get the store file path
 */
function getStorePath(stateDir: string = DEFAULT_STATE_DIR): string {
	return join(stateDir, PATTERNS_FILE);
}

/**
 * Extract meaningful keywords from a task description
 */
export function extractTaskKeywords(task: string): string[] {
	const words = task
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 2 && !STOP_WORDS.has(word));

	// Deduplicate
	return [...new Set(words)];
}

/**
 * Normalize a file path (remove leading ./ or src/)
 */
function normalizeFilePath(filePath: string): string {
	return filePath.replace(/^\.\//, "").replace(/^src\//, "src/"); // Keep src/ prefix consistent
}

/**
 * Load the store from disk
 */
export function loadTaskFileStore(stateDir: string = DEFAULT_STATE_DIR): TaskFileStore {
	const path = getStorePath(stateDir);

	if (!existsSync(path)) {
		return {
			recentTasks: [],
			keywordCorrelations: {},
			coModificationPatterns: {},
			version: "1.0",
			lastUpdated: new Date().toISOString(),
		};
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as TaskFileStore;
		if (!parsed.keywordCorrelations || typeof parsed.keywordCorrelations !== "object") {
			return {
				recentTasks: [],
				keywordCorrelations: {},
				coModificationPatterns: {},
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
		}
		return parsed;
	} catch {
		return {
			recentTasks: [],
			keywordCorrelations: {},
			coModificationPatterns: {},
			version: "1.0",
			lastUpdated: new Date().toISOString(),
		};
	}
}

/**
 * Save the store to disk
 */
function saveTaskFileStore(store: TaskFileStore, stateDir: string = DEFAULT_STATE_DIR): void {
	const path = getStorePath(stateDir);
	const tempPath = `${path}.tmp`;
	const dir = dirname(path);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	store.lastUpdated = new Date().toISOString();

	try {
		writeFileSync(tempPath, JSON.stringify(store, null, 2), {
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
 * Record a completed task and its file modifications
 */
export function recordTaskFiles(
	taskId: string,
	taskDescription: string,
	filesModified: string[],
	success: boolean,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	const store = loadTaskFileStore(stateDir);
	const keywords = extractTaskKeywords(taskDescription);
	const normalizedFiles = filesModified.map(normalizeFilePath);

	// Record the task
	const record: TaskFileRecord = {
		taskId,
		keywords,
		filesModified: normalizedFiles,
		success,
		recordedAt: new Date().toISOString(),
	};

	store.recentTasks.push(record);

	// Keep only last 100 tasks
	if (store.recentTasks.length > 100) {
		store.recentTasks = store.recentTasks.slice(-100);
	}

	// Update keyword correlations (track all tasks for success rate)
	for (const keyword of keywords) {
		if (!store.keywordCorrelations[keyword]) {
			store.keywordCorrelations[keyword] = {
				keyword,
				files: {},
				taskCount: 0,
				successCount: 0,
			};
		}

		const correlation = store.keywordCorrelations[keyword];
		correlation.taskCount++;
		if (success) {
			correlation.successCount++;
		}

		// Only associate files with keywords for successful tasks
		if (success && normalizedFiles.length > 0) {
			for (const file of normalizedFiles) {
				correlation.files[file] = (correlation.files[file] || 0) + 1;
			}
		}
	}

	// Update co-modification patterns (only for successful tasks)
	if (success && normalizedFiles.length > 0) {
		for (const file of normalizedFiles) {
			if (!store.coModificationPatterns[file]) {
				store.coModificationPatterns[file] = {
					file,
					coModified: {},
					modificationCount: 0,
				};
			}

			const pattern = store.coModificationPatterns[file];
			pattern.modificationCount++;

			// Record co-modifications (other files changed in same task)
			for (const otherFile of normalizedFiles) {
				if (otherFile !== file) {
					pattern.coModified[otherFile] = (pattern.coModified[otherFile] || 0) + 1;
				}
			}
		}
	}

	saveTaskFileStore(store, stateDir);
}

/**
 * Find files likely relevant to a task based on keyword correlations
 */
export function findRelevantFiles(
	taskDescription: string,
	maxResults: number = 5,
	stateDir: string = DEFAULT_STATE_DIR,
): Array<{ file: string; score: number; keywords: string[] }> {
	const store = loadTaskFileStore(stateDir);
	const keywords = extractTaskKeywords(taskDescription);

	// Score each file by keyword overlap
	const fileScores: Record<string, { score: number; keywords: string[] }> = {};

	for (const keyword of keywords) {
		const correlation = store.keywordCorrelations[keyword];
		if (!correlation) continue;

		// Weight by how often this keyword leads to these files
		const keywordWeight = correlation.successCount / Math.max(correlation.taskCount, 1);

		for (const [file, count] of Object.entries(correlation.files)) {
			if (!fileScores[file]) {
				fileScores[file] = { score: 0, keywords: [] };
			}

			// Score = count * keyword success rate
			fileScores[file].score += count * keywordWeight;
			if (!fileScores[file].keywords.includes(keyword)) {
				fileScores[file].keywords.push(keyword);
			}
		}
	}

	// Sort by score and return top results
	return Object.entries(fileScores)
		.map(([file, data]) => ({ file, ...data }))
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults);
}

/**
 * Find files that often change together with a given file
 */
export function findCoModifiedFiles(
	file: string,
	minCoModifications: number = 2,
	stateDir: string = DEFAULT_STATE_DIR,
): Array<{ file: string; count: number; probability: number }> {
	const store = loadTaskFileStore(stateDir);
	const normalizedFile = normalizeFilePath(file);
	const pattern = store.coModificationPatterns[normalizedFile];

	if (!pattern || pattern.modificationCount === 0) {
		return [];
	}

	return Object.entries(pattern.coModified)
		.filter(([, count]) => count >= minCoModifications)
		.map(([coFile, count]) => ({
			file: coFile,
			count,
			probability: count / pattern.modificationCount,
		}))
		.sort((a, b) => b.probability - a.probability);
}

/**
 * Format file suggestions for injection into prompt
 */
export function formatFileSuggestionsForPrompt(taskDescription: string, stateDir: string = DEFAULT_STATE_DIR): string {
	const store = loadTaskFileStore(stateDir);
	const taskKeywords = extractTaskKeywords(taskDescription);
	const relevant = findRelevantFiles(taskDescription, 5, stateDir);

	const lines: string[] = [];

	// Check for risky keywords (low success rate)
	const riskyFound: Array<{ keyword: string; successRate: number }> = [];
	for (const keyword of taskKeywords) {
		const correlation = store.keywordCorrelations[keyword];
		if (correlation && correlation.taskCount >= 3) {
			const successRate = correlation.successCount / correlation.taskCount;
			if (successRate < 0.7) {
				riskyFound.push({ keyword, successRate });
			}
		}
	}

	if (riskyFound.length > 0) {
		lines.push("⚠ CAUTION - This task involves keywords with historically low success rates:");
		for (const { keyword, successRate } of riskyFound.slice(0, 3)) {
			lines.push(`- "${keyword}" (${Math.round(successRate * 100)}% success rate)`);
		}
		lines.push("Take extra care with verification and consider breaking into smaller steps.");
		lines.push("");
	}

	if (relevant.length > 0) {
		lines.push("FILES TYPICALLY MODIFIED FOR SIMILAR TASKS:");
		for (const { file, keywords } of relevant) {
			const keywordHint = keywords.slice(0, 3).join(", ");
			lines.push(`- ${file} (keywords: ${keywordHint})`);
		}
		lines.push("");
		lines.push("Consider these files as starting points for your implementation.");
	}

	return lines.join("\n");
}

/**
 * Format co-modification hints for a set of files
 */
export function formatCoModificationHints(filesBeingModified: string[], stateDir: string = DEFAULT_STATE_DIR): string {
	const hints: Array<{ primary: string; coModified: string; probability: number }> = [];

	for (const file of filesBeingModified) {
		const coModified = findCoModifiedFiles(file, 2, stateDir);
		for (const cm of coModified) {
			// Only suggest files not already being modified
			if (!filesBeingModified.includes(cm.file) && cm.probability >= 0.3) {
				hints.push({
					primary: file,
					coModified: cm.file,
					probability: cm.probability,
				});
			}
		}
	}

	if (hints.length === 0) {
		return "";
	}

	// Deduplicate by coModified file
	const seen = new Set<string>();
	const uniqueHints = hints.filter((h) => {
		if (seen.has(h.coModified)) return false;
		seen.add(h.coModified);
		return true;
	});

	if (uniqueHints.length === 0) {
		return "";
	}

	const lines: string[] = ["FILES OFTEN MODIFIED TOGETHER:"];

	for (const hint of uniqueHints.slice(0, 3)) {
		const pct = Math.round(hint.probability * 100);
		lines.push(`- ${hint.coModified} (changes with ${hint.primary} ${pct}% of the time)`);
	}

	lines.push("");
	lines.push("Consider if these files also need updates.");

	return lines.join("\n");
}

/**
 * Get statistics about task-file patterns
 */
export function getTaskFileStats(stateDir: string = DEFAULT_STATE_DIR): {
	totalTasks: number;
	successfulTasks: number;
	failedTasks: number;
	uniqueKeywords: number;
	uniqueFiles: number;
	topKeywords: Array<{ keyword: string; taskCount: number; successRate: number }>;
	topFiles: Array<{ file: string; modCount: number }>;
	riskyKeywords: Array<{ keyword: string; taskCount: number; successRate: number }>;
} {
	const store = loadTaskFileStore(stateDir);

	const successfulTasks = store.recentTasks.filter((t) => t.success).length;
	const failedTasks = store.recentTasks.filter((t) => !t.success).length;

	const topKeywords = Object.values(store.keywordCorrelations)
		.sort((a, b) => b.taskCount - a.taskCount)
		.slice(0, 5)
		.map((k) => ({
			keyword: k.keyword,
			taskCount: k.taskCount,
			successRate: k.taskCount > 0 ? k.successCount / k.taskCount : 0,
		}));

	// Keywords with low success rate (at least 3 tasks, <70% success)
	const riskyKeywords = Object.values(store.keywordCorrelations)
		.filter((k) => k.taskCount >= 3 && k.successCount / k.taskCount < 0.7)
		.sort((a, b) => a.successCount / a.taskCount - b.successCount / b.taskCount)
		.slice(0, 5)
		.map((k) => ({
			keyword: k.keyword,
			taskCount: k.taskCount,
			successRate: k.successCount / k.taskCount,
		}));

	const topFiles = Object.values(store.coModificationPatterns)
		.sort((a, b) => b.modificationCount - a.modificationCount)
		.slice(0, 5)
		.map((p) => ({ file: p.file, modCount: p.modificationCount }));

	return {
		totalTasks: store.recentTasks.length,
		successfulTasks,
		failedTasks,
		uniqueKeywords: Object.keys(store.keywordCorrelations).length,
		uniqueFiles: Object.keys(store.coModificationPatterns).length,
		topKeywords,
		topFiles,
		riskyKeywords,
	};
}

/**
 * Prune stale patterns that haven't been seen recently
 */
export function pruneStalePatterns(
	minTaskCount: number = 2,
	stateDir: string = DEFAULT_STATE_DIR,
): { prunedKeywords: number; prunedFiles: number } {
	const store = loadTaskFileStore(stateDir);
	let prunedKeywords = 0;
	let prunedFiles = 0;

	// Prune keywords with very low task counts
	for (const [keyword, correlation] of Object.entries(store.keywordCorrelations)) {
		if (correlation.taskCount < minTaskCount) {
			delete store.keywordCorrelations[keyword];
			prunedKeywords++;
		}
	}

	// Prune files with very low modification counts
	for (const [file, pattern] of Object.entries(store.coModificationPatterns)) {
		if (pattern.modificationCount < minTaskCount) {
			delete store.coModificationPatterns[file];
			prunedFiles++;
		}
	}

	if (prunedKeywords > 0 || prunedFiles > 0) {
		saveTaskFileStore(store, stateDir);
	}

	return { prunedKeywords, prunedFiles };
}

/**
 * Prime patterns from git history
 * Analyzes recent commits to seed task-file and co-modification patterns
 */
export async function primeFromGitHistory(
	maxCommits: number = 50,
	stateDir: string = DEFAULT_STATE_DIR,
): Promise<{ commitsProcessed: number; patternsAdded: number }> {
	const { execSync } = await import("node:child_process");

	const store = loadTaskFileStore(stateDir);
	let patternsAdded = 0;

	try {
		// Get recent commits with files changed
		const logOutput = execSync(`git log --oneline --name-only --no-merges -n ${maxCommits} 2>/dev/null`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		});

		const lines = logOutput.trim().split("\n");
		let currentCommit: { hash: string; message: string; files: string[] } | null = null;
		const commits: Array<{ hash: string; message: string; files: string[] }> = [];

		for (const line of lines) {
			if (line.match(/^[a-f0-9]{7,} /)) {
				// New commit line
				if (currentCommit && currentCommit.files.length > 0) {
					commits.push(currentCommit);
				}
				const [hash, ...messageParts] = line.split(" ");
				currentCommit = { hash, message: messageParts.join(" "), files: [] };
			} else if (line.trim() && currentCommit) {
				// File line
				const file = line.trim();
				if (file.match(/\.(ts|js|tsx|jsx|py|go|rs|java|rb)$/)) {
					currentCommit.files.push(file);
				}
			}
		}
		if (currentCommit && currentCommit.files.length > 0) {
			commits.push(currentCommit);
		}

		// Process commits to extract patterns
		for (const commit of commits) {
			const keywords = extractTaskKeywords(commit.message);
			const files = commit.files.map(normalizeFilePath);

			if (keywords.length === 0 || files.length === 0) continue;

			// Update keyword correlations
			for (const keyword of keywords) {
				if (!store.keywordCorrelations[keyword]) {
					store.keywordCorrelations[keyword] = {
						keyword,
						files: {},
						taskCount: 0,
						successCount: 0,
					};
				}
				const correlation = store.keywordCorrelations[keyword];
				correlation.taskCount++;
				correlation.successCount++;
				for (const file of files) {
					correlation.files[file] = (correlation.files[file] || 0) + 1;
					patternsAdded++;
				}
			}

			// Update co-modification patterns
			for (const file of files) {
				if (!store.coModificationPatterns[file]) {
					store.coModificationPatterns[file] = {
						file,
						coModified: {},
						modificationCount: 0,
					};
				}
				const pattern = store.coModificationPatterns[file];
				pattern.modificationCount++;
				for (const otherFile of files) {
					if (otherFile !== file) {
						pattern.coModified[otherFile] = (pattern.coModified[otherFile] || 0) + 1;
					}
				}
			}
		}

		saveTaskFileStore(store, stateDir);
		return { commitsProcessed: commits.length, patternsAdded };
	} catch {
		return { commitsProcessed: 0, patternsAdded: 0 };
	}
}
