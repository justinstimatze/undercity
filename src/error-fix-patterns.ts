/**
 * Error-Fix Pattern Learning
 *
 * Records correlations between verification errors and successful fixes.
 * When similar errors occur, suggests fixes that worked before.
 *
 * Storage: SQLite (.undercity/undercity.db)
 * Legacy: .undercity/error-fix-patterns.json (migration only)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	addErrorFix,
	addPendingErrorDB,
	getPendingErrorDB,
	hasErrorFixData,
	incrementFixSuccessDB,
	loadErrorFixStoreFromDB,
	pruneOldErrorPatternsDB,
	pruneOldPendingErrorsDB,
	recordPermanentFailureDB,
	removePendingErrorDB,
	updateFixAutoApplyStatsDB,
	upsertErrorPattern,
} from "./storage.js";

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
	/** Git-style unified diff that can be applied with git apply (for auto-remediation) */
	patchData?: string;
	/** Success rate when this fix was auto-applied (0-1) */
	autoApplySuccessRate?: number;
	/** Number of times this fix was auto-applied */
	autoApplyCount?: number;
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
	/** Files being worked on at time of failure */
	filesAttempted: string[];
	/** When this failure was recorded */
	recordedAt: string;
	/** Detailed error output (actual lint/typecheck/test messages) */
	detailedErrors?: string[];
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
 * Load the error-fix store from JSON (for migration only)
 */
function loadErrorFixStoreFromJSON(stateDir: string = DEFAULT_STATE_DIR): ErrorFixStore | null {
	const path = getStorePath(stateDir);

	if (!existsSync(path)) {
		return null;
	}

	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as ErrorFixStore;
		if (!parsed.patterns || typeof parsed.patterns !== "object") {
			return null;
		}
		// Handle legacy stores without failures field
		if (!parsed.failures) {
			parsed.failures = [];
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Migrate JSON data to SQLite (one-time migration)
 */
function migrateErrorFixStoreToSQLite(store: ErrorFixStore, stateDir: string): void {
	// Migrate patterns and fixes
	for (const pattern of Object.values(store.patterns)) {
		upsertErrorPattern(pattern.signature, pattern.category, pattern.sampleMessage, stateDir);
		for (const fix of pattern.fixes) {
			addErrorFix(
				pattern.signature,
				{
					description: fix.editSummary,
					diff: fix.patchData,
					filesChanged: fix.filesChanged,
				},
				stateDir,
			);
		}
	}

	// Migrate pending errors
	for (const pending of store.pending) {
		addPendingErrorDB(
			{
				signature: pending.signature,
				category: pending.category,
				message: pending.message,
				taskId: pending.taskId,
				filesBeforeFix: pending.filesBeforeFix,
				recordedAt: pending.recordedAt,
			},
			stateDir,
		);
	}

	// Migrate failures
	for (const failure of store.failures) {
		recordPermanentFailureDB(
			{
				signature: failure.signature,
				category: failure.category,
				sampleMessage: failure.sampleMessage,
				taskObjective: failure.taskObjective,
				modelUsed: failure.modelUsed,
				attemptsCount: failure.attemptsCount,
				filesAttempted: failure.filesAttempted,
				detailedErrors: failure.detailedErrors,
				recordedAt: failure.recordedAt,
			},
			stateDir,
		);
	}
}

/**
 * Load the error-fix store (SQLite primary, JSON migration fallback)
 */
export function loadErrorFixStore(stateDir: string = DEFAULT_STATE_DIR): ErrorFixStore {
	try {
		// Check if SQLite has data
		if (hasErrorFixData(stateDir)) {
			// Load from SQLite
			const dbStore = loadErrorFixStoreFromDB(stateDir);
			return {
				patterns: dbStore.patterns,
				pending: dbStore.pending.map((p) => ({
					signature: p.signature,
					category: p.category,
					message: p.message,
					taskId: p.taskId,
					filesBeforeFix: p.filesBeforeFix,
					recordedAt: p.recordedAt,
				})),
				failures: dbStore.failures,
				version: dbStore.version,
				lastUpdated: dbStore.lastUpdated,
			};
		}

		// Try to migrate from JSON
		const jsonStore = loadErrorFixStoreFromJSON(stateDir);
		if (jsonStore && Object.keys(jsonStore.patterns).length > 0) {
			migrateErrorFixStoreToSQLite(jsonStore, stateDir);
			return jsonStore;
		}
	} catch {
		// SQLite not available, try JSON fallback
		const jsonStore = loadErrorFixStoreFromJSON(stateDir);
		if (jsonStore) {
			return jsonStore;
		}
	}

	// Return empty store
	return {
		patterns: {},
		pending: [],
		failures: [],
		version: "1.0",
		lastUpdated: new Date().toISOString(),
	};
}

/**
 * Record a verification error (before fix attempt).
 * Call this when verification fails.
 *
 * INVARIANT: Error states follow a three-state lifecycle:
 *   pending (this fn) -> recordSuccessfulFix() OR recordPermanentFailure()
 * Transitions are one-way. Success stores the fix patch for future reuse.
 * See: .claude/adrs/0007-three-state-error-learning.md
 *
 * Called from:
 * - worker.ts:1815 (handleVerificationFailure)
 */
export function recordPendingError(
	taskId: string,
	category: string,
	message: string,
	currentFiles: string[],
	stateDir: string = DEFAULT_STATE_DIR,
): string {
	const signature = generateErrorSignature(category, message);

	// Write to SQLite
	upsertErrorPattern(signature, category, message.slice(0, 500), stateDir);
	addPendingErrorDB(
		{
			signature,
			category,
			message: message.slice(0, 500),
			taskId,
			filesBeforeFix: currentFiles,
			recordedAt: new Date().toISOString(),
		},
		stateDir,
	);
	pruneOldPendingErrorsDB(10, stateDir);

	return signature;
}

/**
 * Options for recording a successful fix
 */
export interface RecordSuccessfulFixOptions {
	taskId: string;
	filesChanged: string[];
	editSummary: string;
	/** Working directory to capture git diff from (enables auto-remediation) */
	workingDirectory?: string;
	/** Base commit to diff against (defaults to HEAD~1) */
	baseCommit?: string;
	stateDir?: string;
}

/**
 * Capture git diff for changed files (for auto-remediation)
 */
function captureGitDiff(files: string[], workingDirectory: string, baseCommit?: string): string | undefined {
	if (files.length === 0) return undefined;

	try {
		// Get diff for specific files
		const base = baseCommit || "HEAD~1";
		const args = ["diff", base, "HEAD", "--", ...files];
		const diff = execFileSync("git", args, {
			encoding: "utf-8",
			cwd: workingDirectory,
			timeout: 10000,
		});

		// Limit diff size to prevent bloated storage (max 10KB)
		if (diff.length > 10240) {
			return undefined; // Too large to store
		}

		return diff.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Record a successful fix for a pending error.
 * Call this when verification passes after a previous failure.
 *
 * Called from:
 * - worker.ts:1757 (after verification succeeds post-failure)
 */
export function recordSuccessfulFix(
	taskIdOrOptions: string | RecordSuccessfulFixOptions,
	filesChanged?: string[],
	editSummary?: string,
	stateDir: string = DEFAULT_STATE_DIR,
): void {
	// Support both positional args (legacy) and options object
	let opts: RecordSuccessfulFixOptions;
	if (typeof taskIdOrOptions === "object") {
		opts = taskIdOrOptions;
	} else {
		opts = {
			taskId: taskIdOrOptions,
			filesChanged: filesChanged!,
			editSummary: editSummary!,
			stateDir,
		};
	}

	const actualStateDir = opts.stateDir ?? DEFAULT_STATE_DIR;

	// Find pending error for this task
	const pending = getPendingErrorDB(opts.taskId, actualStateDir);
	if (!pending) {
		return; // No pending error to resolve
	}

	// Determine which files were actually changed to fix the error
	const newFiles = opts.filesChanged.filter((f) => !pending.filesBeforeFix.includes(f));
	const relevantFiles = newFiles.length > 0 ? newFiles : opts.filesChanged.slice(0, 5);

	// Capture git diff if working directory provided (enables auto-remediation)
	let patchData: string | undefined;
	if (opts.workingDirectory && relevantFiles.length > 0) {
		patchData = captureGitDiff(relevantFiles, opts.workingDirectory, opts.baseCommit);
	}

	// Add the fix to SQLite
	addErrorFix(
		pending.signature,
		{
			description: opts.editSummary.slice(0, 200),
			diff: patchData,
			filesChanged: relevantFiles,
		},
		actualStateDir,
	);

	// Remove from pending
	removePendingErrorDB(opts.taskId, actualStateDir);
}

/**
 * Mark that a suggested fix was successful
 * Call this when a fix suggestion led to success
 */
export function markFixSuccessful(signature: string, stateDir: string = DEFAULT_STATE_DIR): void {
	incrementFixSuccessDB(signature, stateDir);
}

/**
 * Clear pending error for a task (e.g., on task failure/abort)
 */
export function clearPendingError(taskId: string, stateDir: string = DEFAULT_STATE_DIR): void {
	removePendingErrorDB(taskId, stateDir);
}

/**
 * Options for recording a permanent failure
 */
export interface RecordPermanentFailureOptions {
	taskId: string;
	category: string;
	message: string;
	taskObjective: string;
	modelUsed: string;
	attemptCount: number;
	currentFiles: string[];
	/** Actual error output (lint messages, typecheck errors, test failures) */
	detailedErrors?: string[];
	stateDir?: string;
}

/**
 * Record a permanent failure when verification error cannot be fixed after max retries.
 * Call this when a task fails after exhausting all retry attempts.
 *
 * Called from:
 * - worker.ts:2021 (buildFailureResult, after max retries exhausted)
 */
export function recordPermanentFailure(
	taskIdOrOptions: string | RecordPermanentFailureOptions,
	category?: string,
	message?: string,
	taskObjective?: string,
	modelUsed?: string,
	attemptCount?: number,
	currentFiles?: string[],
	stateDir: string = DEFAULT_STATE_DIR,
): string {
	// Support both old positional args and new options object
	let opts: RecordPermanentFailureOptions;
	if (typeof taskIdOrOptions === "object") {
		opts = taskIdOrOptions;
	} else {
		opts = {
			taskId: taskIdOrOptions,
			category: category!,
			message: message!,
			taskObjective: taskObjective!,
			modelUsed: modelUsed!,
			attemptCount: attemptCount!,
			currentFiles: currentFiles!,
			stateDir,
		};
	}

	const actualStateDir = opts.stateDir ?? DEFAULT_STATE_DIR;
	const signature = generateErrorSignature(opts.category, opts.message);

	// Prepare detailed errors (truncate each to 300 chars, keep max 10)
	const detailedErrors = opts.detailedErrors?.slice(0, 10).map((e) => e.slice(0, 300));

	// Write to SQLite
	upsertErrorPattern(signature, opts.category, opts.message.slice(0, 500), actualStateDir);
	recordPermanentFailureDB(
		{
			signature,
			category: opts.category,
			sampleMessage: opts.message.slice(0, 500),
			taskObjective: opts.taskObjective.slice(0, 200),
			modelUsed: opts.modelUsed,
			attemptsCount: opts.attemptCount,
			filesAttempted: opts.currentFiles.slice(0, 10),
			detailedErrors,
			recordedAt: new Date().toISOString(),
		},
		actualStateDir,
	);
	removePendingErrorDB(opts.taskId, actualStateDir);

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
 * Result of attempting auto-remediation
 */
export interface AutoRemediationResult {
	/** Whether remediation was attempted (had matching pattern with patch) */
	attempted: boolean;
	/** Whether the patch was successfully applied */
	applied: boolean;
	/** Error signature that was matched */
	signature?: string;
	/** Files that were patched */
	patchedFiles?: string[];
	/** Error message if application failed */
	error?: string;
}

/**
 * Try to auto-remediate an error using learned fix patterns.
 *
 * Looks up the error signature, finds fixes with patch data,
 * and attempts to apply the patch. Only patches with good
 * track records (high autoApplySuccessRate) are attempted.
 *
 * Called from:
 * - worker.ts:1483 (after verification failure, before re-invoking agent)
 *
 * @param category - Error category (typecheck, lint, test, build)
 * @param message - Error message
 * @param workingDirectory - Directory to apply patches in
 * @param stateDir - State directory for error-fix patterns
 * @returns Result indicating whether remediation was attempted/successful
 */
export function tryAutoRemediate(
	category: string,
	message: string,
	workingDirectory: string,
	stateDir: string = DEFAULT_STATE_DIR,
): AutoRemediationResult {
	const store = loadErrorFixStore(stateDir);
	const signature = generateErrorSignature(category, message);
	const pattern = store.patterns[signature];

	// No pattern or no fixes
	if (!pattern || pattern.fixes.length === 0) {
		return { attempted: false, applied: false };
	}

	// Find fixes with patch data, sorted by success rate then recency
	const fixesWithPatches = pattern.fixes
		.filter((f) => f.patchData)
		.sort((a, b) => {
			// Prefer higher success rate
			const rateA = a.autoApplySuccessRate ?? 0.5;
			const rateB = b.autoApplySuccessRate ?? 0.5;
			if (rateB !== rateA) return rateB - rateA;
			// Then prefer more recent
			return new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime();
		});

	if (fixesWithPatches.length === 0) {
		return { attempted: false, applied: false };
	}

	// Only attempt if success rate is reasonable (> 30%) or never tried
	const bestFix = fixesWithPatches[0];
	const successRate = bestFix.autoApplySuccessRate ?? 0.5;
	if (bestFix.autoApplyCount && bestFix.autoApplyCount > 2 && successRate < 0.3) {
		// This patch has failed too often, skip auto-remediation
		return { attempted: false, applied: false, signature };
	}

	// Attempt to apply the patch
	try {
		// First, check if the patch would apply cleanly
		execFileSync("git", ["apply", "--check", "-"], {
			input: bestFix.patchData,
			cwd: workingDirectory,
			encoding: "utf-8",
			timeout: 10000,
		});

		// Patch would apply cleanly, so apply it for real
		execFileSync("git", ["apply", "-"], {
			input: bestFix.patchData,
			cwd: workingDirectory,
			encoding: "utf-8",
			timeout: 10000,
		});

		// Update success tracking
		updateAutoApplyStats(signature, true, stateDir);

		return {
			attempted: true,
			applied: true,
			signature,
			patchedFiles: bestFix.filesChanged,
		};
	} catch (error) {
		// Patch failed to apply (code has diverged)
		updateAutoApplyStats(signature, false, stateDir);

		return {
			attempted: true,
			applied: false,
			signature,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Update auto-apply statistics for a pattern
 */
function updateAutoApplyStats(signature: string, success: boolean, stateDir: string = DEFAULT_STATE_DIR): void {
	try {
		updateFixAutoApplyStatsDB(signature, success, stateDir);
	} catch {
		// Silent failure - stats update is non-critical
	}
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
 * Get failure warnings relevant to a task objective.
 * These are "signs for Ralph" - warnings about past failures to avoid repeating them.
 *
 * Returns formatted text to inject into worker prompts when:
 * - The task objective matches keywords from previous failures
 * - There are repeated failures (N >= 2) of the same error type
 *
 * Called from:
 * - worker.ts:2496 (context building before execution)
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

	for (const [_signature, data] of failureCounts) {
		if (data.count < minOccurrences) continue;

		const failure = data.failures[0];

		// Check if task objective has keyword overlap
		const failureWords = new Set(
			`${failure.taskObjective} ${failure.sampleMessage}`
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
export function pruneOldPatterns(maxAgeDays: number = 30, stateDir: string = DEFAULT_STATE_DIR): number {
	return pruneOldErrorPatternsDB(maxAgeDays, 5, stateDir);
}

/**
 * Ralph-style rule for prompt injection
 */
export interface ErrorRule {
	/** The rule directive (MUST NEVER, ALWAYS, etc.) */
	directive: "MUST_NEVER" | "ALWAYS" | "AVOID";
	/** The rule content */
	rule: string;
	/** Why this rule exists (evidence) */
	reason: string;
	/** How many times this error occurred */
	occurrences: number;
}

/**
 * Format error patterns and failures as imperative RULES for Ralph-style prompts.
 *
 * Unlike suggestions ("consider this fix"), RULES are imperative directives
 * that become permanent "signs" in the prompt - teaching the agent what NOT to do.
 *
 * @param taskObjective - The current task (for relevance filtering)
 * @param errorHistory - Errors from current retry loop (for accumulation)
 * @param stateDir - State directory path
 * @returns Formatted rules section for prompt injection
 */
export function formatPatternsAsRules(
	taskObjective: string,
	errorHistory: Array<{ category: string; message: string }> = [],
	stateDir: string = DEFAULT_STATE_DIR,
): string {
	const rules: ErrorRule[] = [];
	const store = loadErrorFixStore(stateDir);

	// Extract keywords from task for relevance matching
	const taskWords = new Set(
		taskObjective
			.toLowerCase()
			.split(/[\s,./\-_()[\]{}]+/)
			.filter((w) => w.length > 3),
	);

	// 1. Add rules from permanent failures (highest priority - these NEVER worked)
	if (store.failures && store.failures.length > 0) {
		// Group failures by signature to count occurrences
		const failureGroups = new Map<string, PermanentFailure[]>();
		for (const failure of store.failures) {
			const existing = failureGroups.get(failure.signature) || [];
			existing.push(failure);
			failureGroups.set(failure.signature, existing);
		}

		for (const [_sig, failures] of failureGroups) {
			if (failures.length < 2) continue; // Only rules from repeated failures

			const sample = failures[0];

			// Check relevance to current task
			const failureWords = new Set(
				`${sample.taskObjective} ${sample.sampleMessage}`
					.toLowerCase()
					.split(/[\s,./\-_()[\]{}]+/)
					.filter((w) => w.length > 3),
			);
			const overlap = [...taskWords].filter((w) => failureWords.has(w));

			if (overlap.length >= 2 || failures.length >= 3) {
				rules.push({
					directive: "MUST_NEVER",
					rule: extractRuleFromError(sample.category, sample.sampleMessage),
					reason: `Failed ${failures.length}x on similar tasks, never succeeded`,
					occurrences: failures.length,
				});
			}
		}
	}

	// 2. Add rules from error patterns with known fixes
	const patterns = Object.values(store.patterns);
	for (const pattern of patterns) {
		if (pattern.occurrences < 3) continue; // Only frequent errors become rules

		const fixRate = pattern.fixSuccesses / pattern.occurrences;
		if (fixRate < 0.5) continue; // Only include patterns where fix worked >50%

		// Get the most successful fix
		const bestFix = pattern.fixes.sort((a, b) => (b.autoApplySuccessRate || 0) - (a.autoApplySuccessRate || 0))[0];

		if (bestFix) {
			rules.push({
				directive: "ALWAYS",
				rule: `When encountering ${pattern.category} error "${pattern.sampleMessage.slice(0, 60)}...", fix by: ${bestFix.editSummary}`,
				reason: `This fix worked ${Math.round(fixRate * 100)}% of the time (${pattern.occurrences} occurrences)`,
				occurrences: pattern.occurrences,
			});
		}
	}

	// 3. Add rules from current retry loop errors (accumulate across attempts)
	for (const error of errorHistory) {
		// Check if we already have a rule for this error
		const existingRule = rules.find((r) => r.rule.includes(error.message.slice(0, 30)));
		if (!existingRule) {
			rules.push({
				directive: "AVOID",
				rule: extractRuleFromError(error.category, error.message),
				reason: "Failed in previous attempt this session",
				occurrences: 1,
			});
		}
	}

	if (rules.length === 0) {
		return "";
	}

	// Sort by importance: MUST_NEVER > ALWAYS > AVOID, then by occurrences
	const directiveOrder = { MUST_NEVER: 0, ALWAYS: 1, AVOID: 2 };
	rules.sort((a, b) => {
		const orderDiff = directiveOrder[a.directive] - directiveOrder[b.directive];
		if (orderDiff !== 0) return orderDiff;
		return b.occurrences - a.occurrences;
	});

	// Format as prompt rules
	const lines: string[] = [
		"## LEARNED RULES (from previous failures)",
		"These rules are derived from past failures. Follow them strictly:",
		"",
	];

	for (const rule of rules.slice(0, 8)) {
		// Limit to top 8 rules
		const prefix =
			rule.directive === "MUST_NEVER" ? "🚫 MUST NEVER:" : rule.directive === "ALWAYS" ? "✅ ALWAYS:" : "⚠️ AVOID:";

		lines.push(`${prefix} ${rule.rule}`);
		lines.push(`   (${rule.reason})`);
		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Extract an actionable rule from an error category and message
 */
function extractRuleFromError(category: string, message: string): string {
	// Try to extract the actionable part of the error
	const messageLower = message.toLowerCase();

	// Type errors
	if (category === "typecheck" || messageLower.includes("type")) {
		if (messageLower.includes("not assignable")) {
			return `Check type compatibility before assignment (${message.slice(0, 80)}...)`;
		}
		if (messageLower.includes("property") && messageLower.includes("does not exist")) {
			return `Verify property exists on type before accessing (${message.slice(0, 60)}...)`;
		}
		if (messageLower.includes("cannot find")) {
			return `Ensure imports and declarations exist (${message.slice(0, 60)}...)`;
		}
	}

	// Test errors
	if (category === "test" || messageLower.includes("test") || messageLower.includes("expect")) {
		if (messageLower.includes("mock")) {
			return `Properly configure mocks before test execution`;
		}
		if (messageLower.includes("undefined") || messageLower.includes("null")) {
			return `Handle null/undefined in test setup and assertions`;
		}
	}

	// Lint errors
	if (category === "lint") {
		if (messageLower.includes("unused")) {
			return `Remove unused variables/imports or mark them intentionally`;
		}
		if (messageLower.includes("import")) {
			return `Check import statements for correctness`;
		}
	}

	// Build errors
	if (category === "build") {
		if (messageLower.includes("module not found")) {
			return `Verify all imported modules are installed and paths are correct`;
		}
	}

	// Default: quote the first part of the error
	return `Avoid causing: ${message.slice(0, 100)}...`;
}
