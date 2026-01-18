/**
 * Error-Fix Pattern Learning
 *
 * Records correlations between verification errors and successful fixes.
 * When similar errors occur, suggests fixes that worked before.
 *
 * Storage: .undercity/error-fix-patterns.json
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_STATE_DIR = ".undercity";
// Stores error-fix correlations - maps verification failures to successful fixes for learning
const PATTERNS_FILE = "error-fix-patterns.json";

/**
 * A recorded fix for a specific error pattern
 */
export interface ErrorFix {
	/** Files that were modified to fix the error */
	filesChanged: string[];
	/** Brief description of what was changed */
	editSummary: string;
	/** Task that produced this fix */
	taskId: string;
	/** When this fix was recorded */
	recordedAt: string;
}

/**
 * A pattern of errors and their fixes
 */
export interface ErrorFixPattern {
	/** Unique signature for this error type */
	signature: string;
	/** The error category (typecheck, test, lint, build) */
	category: string;
	/** Representative error message (first occurrence) */
	sampleMessage: string;
	/** Successful fixes for this error */
	fixes: ErrorFix[];
	/** Total times this error was encountered */
	occurrences: number;
	/** Times a recorded fix was applied and worked */
	fixSuccesses: number;
	/** When first encountered */
	firstSeen: string;
	/** When last encountered */
	lastSeen: string;
}

/**
 * Pending error awaiting fix
 */
export interface PendingError {
	signature: string;
	category: string;
	message: string;
	taskId: string;
	filesBeforeFix: string[];
	recordedAt: string;
}

/**
 * A permanent failure after max retries exhausted
 */
export interface PermanentFailure {
	/** Unique signature for this error type */
	signature: string;
	/** The error category (typecheck, test, lint, build) */
	category: string;
	/** Representative error message */
	sampleMessage: string;
	/** Task objective that failed */
	taskObjective: string;
	/** Model used during failed attempts */
	modelUsed: string;
	/** Number of attempts before giving up */
	attemptsCount: number;
	/** When this failure was recorded */
	recordedAt: string;
}

/**
 * The full error-fix pattern store
 */
export interface ErrorFixStore {
	patterns: Record<string, ErrorFixPattern>;
	pending: PendingError[];
	failures: PermanentFailure[];
	version: string;
	lastUpdated: string;
}

/**
 * Get the store file path
 */
function getStorePath(stateDir: string = DEFAULT_STATE_DIR): string {
	return join(stateDir, PATTERNS_FILE);
}

/**
 * Generate a signature for an error
 * Groups similar errors together by normalizing variable parts
 */
export function generateErrorSignature(category: string, message: string): string {
	// Normalize the message to group similar errors
	const normalized = message
		// Remove file paths (keep just filename)
		.replace(/[/\\][\w./-]+\.(ts|js|tsx|jsx)/g, "FILE")
		// Remove line:column numbers
		.replace(/:\d+:\d+/g, ":N:N")
		.replace(/line \d+/gi, "line N")
		// Remove specific variable/function names in quotes
		.replace(/'[^']+'/g, "'X'")
		.replace(/"[^"]+"/g, '"X"')
		// Remove hex addresses
		.replace(/0x[a-fA-F0-9]+/g, "0xADDR")
		// Collapse whitespace
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

	const hash = createHash("md5").update(`${category}:${normalized}`).digest("hex").slice(0, 12);
	return `${category}-${hash}`;
}

/**
 * Load the error-fix store from disk
 */
export function loadErrorFixStore(stateDir: string = DEFAULT_STATE_DIR): ErrorFixStore {
	const path = getStorePath(stateDir);

	if (!existsSync(path)) {
		return {
			patterns: {},
			pending: [],
			failures: [],
			version: "1.0",
			lastUpdated: new Date().toISOString(),
		};
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as ErrorFixStore;
		if (!parsed.patterns || typeof parsed.patterns !== "object") {
			return {
				patterns: {},
				pending: [],
				failures: [],
				version: "1.0",
				lastUpdated: new Date().toISOString(),
			};
		}
		// Handle legacy stores without failures field
		if (!parsed.failures) {
			parsed.failures = [];
		}
		return parsed;
	} catch {
		return {
			patterns: {},
			pending: [],
			failures: [],
			version: "1.0",
			lastUpdated: new Date().toISOString(),
		};
	}
}

/**
 * Save the error-fix store to disk
 */
function saveErrorFixStore(store: ErrorFixStore, stateDir: string = DEFAULT_STATE_DIR): void {
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
 * Record a verification error (before fix attempt)
 * Call this when verification fails
 */
export function recordPendingError(
	taskId: string,
	category: string,
	message: string,
	currentFiles: string[],
	stateDir: string = DEFAULT_STATE_DIR,
): string {
	const store = loadErrorFixStore(stateDir);
	const signature = generateErrorSignature(category, message);

	// Update or create the pattern
	if (!store.patterns[signature]) {
		store.patterns[signature] = {
			signature,
			category,
			sampleMessage: message.slice(0, 500),
			fixes: [],
			occurrences: 0,
			fixSuccesses: 0,
			firstSeen: new Date().toISOString(),
			lastSeen: new Date().toISOString(),
		};
	}

	store.patterns[signature].occurrences++;
	store.patterns[signature].lastSeen = new Date().toISOString();

	// Add to pending (for later fix recording)
	store.pending.push({
		signature,
		category,
		message: message.slice(0, 500),
		taskId,
		filesBeforeFix: currentFiles,
		recordedAt: new Date().toISOString(),
	});

	// Keep only recent pending entries (last 10)
	if (store.pending.length > 10) {
		store.pending = store.pending.slice(-10);
	}

	saveErrorFixStore(store, stateDir);
	return signature;
}

/**
 * Record a successful fix for a pending error
 * Call this when verification passes after a previous failure
 */
export function recordSuccessfulFix(
	taskId: string,
	filesChanged: string[],
	editSummary: string,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	const store = loadErrorFixStore(stateDir);

	// Find pending error for this task
	const pendingIndex = store.pending.findIndex((p) => p.taskId === taskId);
	if (pendingIndex === -1) {
		return; // No pending error to resolve
	}

	const pending = store.pending[pendingIndex];
	const pattern = store.patterns[pending.signature];

	if (pattern) {
		// Determine which files were actually changed to fix the error
		const newFiles = filesChanged.filter((f) => !pending.filesBeforeFix.includes(f));
		const relevantFiles = newFiles.length > 0 ? newFiles : filesChanged.slice(0, 5);

		// Add the fix
		pattern.fixes.push({
			filesChanged: relevantFiles,
			editSummary: editSummary.slice(0, 200),
			taskId,
			recordedAt: new Date().toISOString(),
		});

		// Keep only the most recent/successful fixes (max 5)
		if (pattern.fixes.length > 5) {
			pattern.fixes = pattern.fixes.slice(-5);
		}
	}

	// Remove from pending
	store.pending.splice(pendingIndex, 1);

	saveErrorFixStore(store, stateDir);
}

/**
 * Mark that a suggested fix was successful
 * Call this when a fix suggestion led to success
 */
export function markFixSuccessful(signature: string, stateDir: string = DEFAULT_STATE_DIR): void {
	const store = loadErrorFixStore(stateDir);
	const pattern = store.patterns[signature];

	if (pattern) {
		pattern.fixSuccesses++;
		saveErrorFixStore(store, stateDir);
	}
}

/**
 * Clear pending error for a task (e.g., on task failure/abort)
 */
export function clearPendingError(taskId: string, stateDir: string = DEFAULT_STATE_DIR): void {
	const store = loadErrorFixStore(stateDir);
	store.pending = store.pending.filter((p) => p.taskId !== taskId);
	saveErrorFixStore(store, stateDir);
}

/**
 * Record a permanent failure when verification error cannot be fixed after max retries
 * Call this when a task fails after exhausting all retry attempts
 */
export function recordPermanentFailure(
	taskId: string,
	category: string,
	message: string,
	taskObjective: string,
	modelUsed: string,
	attemptCount: number,
	currentFiles: string[],
	stateDir: string = DEFAULT_STATE_DIR,
): string {
	const store = loadErrorFixStore(stateDir);
	const signature = generateErrorSignature(category, message);

	// Update or create the pattern
	if (!store.patterns[signature]) {
		store.patterns[signature] = {
			signature,
			category,
			sampleMessage: message.slice(0, 500),
			fixes: [],
			occurrences: 0,
			fixSuccesses: 0,
			firstSeen: new Date().toISOString(),
			lastSeen: new Date().toISOString(),
		};
	}

	store.patterns[signature].occurrences++;
	store.patterns[signature].lastSeen = new Date().toISOString();

	// Add to failures array
	store.failures.push({
		signature,
		category,
		sampleMessage: message.slice(0, 500),
		taskObjective: taskObjective.slice(0, 200),
		modelUsed,
		attemptsCount: attemptCount,
		recordedAt: new Date().toISOString(),
	});

	// Keep only most recent 10 failures
	if (store.failures.length > 10) {
		store.failures = store.failures.slice(-10);
	}

	// Clear from pending if it exists
	store.pending = store.pending.filter((p) => p.taskId !== taskId);

	saveErrorFixStore(store, stateDir);
	return signature;
}

/**
 * Find fix suggestions for an error
 */
export function findFixSuggestions(
	category: string,
	message: string,
	stateDir: string = DEFAULT_STATE_DIR,
): { pattern: ErrorFixPattern; suggestions: ErrorFix[] } | null {
	const store = loadErrorFixStore(stateDir);
	const signature = generateErrorSignature(category, message);
	const pattern = store.patterns[signature];

	if (!pattern || pattern.fixes.length === 0) {
		return null;
	}

	// Return fixes sorted by recency
	const suggestions = [...pattern.fixes].reverse();

	return { pattern, suggestions };
}

/**
 * Format fix suggestions for injection into prompt
 */
export function formatFixSuggestionsForPrompt(
	category: string,
	message: string,
	stateDir: string = DEFAULT_STATE_DIR,
): string {
	const result = findFixSuggestions(category, message, stateDir);

	if (!result || result.suggestions.length === 0) {
		return "";
	}

	const { pattern, suggestions } = result;
	const successRate = pattern.occurrences > 0 ? Math.round((pattern.fixSuccesses / pattern.occurrences) * 100) : 0;

	const lines: string[] = [
		`SIMILAR ERROR FIXED BEFORE (${pattern.occurrences} occurrences, ${successRate}% fix success rate):`,
	];

	for (const fix of suggestions.slice(0, 3)) {
		lines.push(`- Files changed: ${fix.filesChanged.join(", ")}`);
		if (fix.editSummary) {
			lines.push(`  Fix: ${fix.editSummary}`);
		}
	}

	lines.push("");
	lines.push("Consider similar approaches for this error.");

	return lines.join("\n");
}

/**
 * Get failure warnings relevant to a task objective
 * These are "signs for Ralph" - warnings about past failures to avoid repeating them
 *
 * Returns formatted text to inject into worker prompts when:
 * - The task objective matches keywords from previous failures
 * - There are repeated failures (N >= 2) of the same error type
 *
 * @param taskObjective - The task being planned
 * @param minOccurrences - Minimum failure occurrences to trigger warning (default: 2)
 * @param stateDir - State directory path
 */
export function getFailureWarningsForTask(
	taskObjective: string,
	minOccurrences: number = 2,
	stateDir: string = DEFAULT_STATE_DIR,
): string {
	const store = loadErrorFixStore(stateDir);

	if (!store.failures || store.failures.length === 0) {
		return "";
	}

	// Extract keywords from task objective for matching
	const taskWords = new Set(
		taskObjective
			.toLowerCase()
			.split(/[\s,./\-_()[\]{}]+/)
			.filter((w) => w.length > 3),
	);

	// Count failure occurrences by signature
	const failureCounts = new Map<string, { count: number; failures: PermanentFailure[] }>();
	for (const failure of store.failures) {
		const existing = failureCounts.get(failure.signature) || { count: 0, failures: [] };
		existing.count++;
		existing.failures.push(failure);
		failureCounts.set(failure.signature, existing);
	}

	// Find relevant warnings based on:
	// 1. Repeated failures (same error N+ times)
	// 2. Task objective keyword matches
	const warnings: Array<{
		category: string;
		message: string;
		taskPattern: string;
		occurrences: number;
	}> = [];

	for (const [signature, data] of failureCounts) {
		if (data.count < minOccurrences) continue;

		const failure = data.failures[0];

		// Check if task objective has keyword overlap
		const failureWords = new Set(
			(failure.taskObjective + " " + failure.sampleMessage)
				.toLowerCase()
				.split(/[\s,./\-_()[\]{}]+/)
				.filter((w) => w.length > 3),
		);

		const overlap = [...taskWords].filter((w) => failureWords.has(w));

		// Include if there's significant overlap or many occurrences
		if (overlap.length >= 2 || data.count >= 3) {
			warnings.push({
				category: failure.category,
				message: failure.sampleMessage.slice(0, 150),
				taskPattern: failure.taskObjective.slice(0, 80),
				occurrences: data.count,
			});
		}
	}

	if (warnings.length === 0) {
		return "";
	}

	// Format warnings for prompt injection
	const lines: string[] = [
		"⚠️ FAILURE PATTERNS TO AVOID:",
		"The following errors have occurred multiple times on similar tasks. Take care to avoid them:",
		"",
	];

	for (const warning of warnings.slice(0, 3)) {
		lines.push(`• ${warning.category.toUpperCase()} failure (${warning.occurrences}x):`);
		lines.push(`  Error: ${warning.message}`);
		lines.push(`  On task like: "${warning.taskPattern}..."`);
		lines.push("");
	}

	lines.push("Review your approach to avoid these known failure patterns.");

	return lines.join("\n");
}

/**
 * Get statistics about error-fix patterns
 */
export function getErrorFixStats(stateDir: string = DEFAULT_STATE_DIR): {
	totalPatterns: number;
	totalOccurrences: number;
	totalFixes: number;
	byCategory: Record<string, number>;
	topErrors: Array<{ signature: string; occurrences: number; fixes: number }>;
} {
	const store = loadErrorFixStore(stateDir);
	const patterns = Object.values(store.patterns);

	const byCategory: Record<string, number> = {};
	let totalOccurrences = 0;
	let totalFixes = 0;

	for (const pattern of patterns) {
		byCategory[pattern.category] = (byCategory[pattern.category] || 0) + pattern.occurrences;
		totalOccurrences += pattern.occurrences;
		totalFixes += pattern.fixes.length;
	}

	const topErrors = patterns
		.sort((a, b) => b.occurrences - a.occurrences)
		.slice(0, 5)
		.map((p) => ({
			signature: p.signature,
			occurrences: p.occurrences,
			fixes: p.fixes.length,
		}));

	return {
		totalPatterns: patterns.length,
		totalOccurrences,
		totalFixes,
		byCategory,
		topErrors,
	};
}

/**
 * Prune old patterns that haven't been seen recently
 */
export function pruneOldPatterns(
	maxAge: number = 30 * 24 * 60 * 60 * 1000, // 30 days
	stateDir: string = DEFAULT_STATE_DIR,
): number {
	const store = loadErrorFixStore(stateDir);
	const now = Date.now();
	const originalCount = Object.keys(store.patterns).length;

	for (const [signature, pattern] of Object.entries(store.patterns)) {
		const age = now - new Date(pattern.lastSeen).getTime();
		// Keep if: has fixes, or seen recently, or high occurrence
		if (pattern.fixes.length === 0 && age > maxAge && pattern.occurrences < 5) {
			delete store.patterns[signature];
		}
	}

	const prunedCount = originalCount - Object.keys(store.patterns).length;

	if (prunedCount > 0) {
		saveErrorFixStore(store, stateDir);
	}

	return prunedCount;
}
