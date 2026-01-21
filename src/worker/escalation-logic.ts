/**
 * Worker Escalation Logic Helpers
 *
 * Extracted escalation decision logic from shouldEscalate.
 */

import { sessionLogger } from "../logger.js";
import { isTestTask } from "../task-planner.js";
import type { ErrorCategory } from "../types.js";

/**
 * Result of an escalation check
 */
export interface EscalationResult {
	shouldEscalate: boolean;
	reason: string;
	forceFailure?: boolean;
}

/**
 * Context for escalation checks
 */
export interface EscalationContext {
	errorHistory: Array<{ message: string }>;
	writesPerFile: Map<string, number>;
	maxWritesPerFile: number;
	noOpEditCount: number;
	consecutiveNoWriteAttempts: number;
	currentModel: string;
	maxTier: string;
	sameModelRetries: number;
	maxRetriesPerTier: number;
	maxOpusRetries: number;
}

/**
 * Check for Ralph-style repeated error loop
 */
export function checkRepeatedErrorLoop(
	errorMessage: string,
	errorHistory: Array<{ message: string }>,
): EscalationResult | null {
	const sameErrorCount = errorHistory.filter(
		(e) => e.message.slice(0, 80) === errorMessage.slice(0, 80),
	).length;

	if (sameErrorCount >= 3) {
		sessionLogger.warn(
			{
				errorMessage: errorMessage.slice(0, 100),
				occurrences: sameErrorCount,
			},
			"Ralph loop detection: same error 3+ times - failing fast",
		);
		return {
			shouldEscalate: false,
			reason: `same error repeated ${sameErrorCount}x - agent stuck in loop, task needs different approach`,
			forceFailure: true,
		};
	}
	return null;
}

/**
 * Check for file thrashing
 */
export function checkFileThrashing(
	writesPerFile: Map<string, number>,
	maxWritesPerFile: number,
): EscalationResult | null {
	for (const [filePath, count] of writesPerFile) {
		if (count >= maxWritesPerFile) {
			return {
				shouldEscalate: false,
				reason: `file thrashing: ${filePath} edited ${count} times without verification passing`,
				forceFailure: true,
			};
		}
	}
	return null;
}

/**
 * Check for no changes scenario
 */
export function checkNoChanges(
	filesChanged: number,
	noOpEditCount: number,
	consecutiveNoWriteAttempts: number,
	currentModel: string,
): EscalationResult | null {
	if (filesChanged !== 0) return null;

	// No-op edits detected means task may be complete
	if (noOpEditCount > 0) {
		return { shouldEscalate: false, reason: "task may already be complete (no-op edits detected)" };
	}

	// NO_CHANGES strategy: allow 1 retry, then fail fast
	const maxNoChangeRetries = 2;

	if (consecutiveNoWriteAttempts < maxNoChangeRetries) {
		return {
			shouldEscalate: false,
			reason: `no changes made, retry ${consecutiveNoWriteAttempts + 1}/${maxNoChangeRetries} at ${currentModel}`,
		};
	}

	sessionLogger.warn(
		{ consecutiveNoWrites: consecutiveNoWriteAttempts, model: currentModel },
		"No changes after retries - failing fast (task likely needs clarification, not escalation)",
	);
	return {
		shouldEscalate: false,
		reason: `${consecutiveNoWriteAttempts} consecutive no-change attempts - task may need decomposition or clarification`,
		forceFailure: true,
	};
}

/**
 * Check if at final model tier
 */
export function checkFinalTier(
	currentModel: string,
	maxTier: string,
	sameModelRetries: number,
	maxOpusRetries: number,
): EscalationResult | null {
	const isAtFinalTier = currentModel === "opus" || currentModel === maxTier;
	if (!isAtFinalTier) return null;

	if (sameModelRetries < maxOpusRetries) {
		const remaining = maxOpusRetries - sameModelRetries;
		const tierLabel = maxTier === "opus" ? "opus tier" : `${currentModel} tier (max-tier cap)`;
		return { shouldEscalate: false, reason: `${tierLabel}, ${remaining} retries left` };
	}
	return { shouldEscalate: true, reason: `max retries at final tier (${maxOpusRetries})` };
}

/**
 * Check for trivial-only errors (lint/spell)
 */
export function checkTrivialErrors(
	errorCategories: ErrorCategory[],
	sameModelRetries: number,
	maxRetriesPerTier: number,
): EscalationResult | null {
	const trivialOnly = errorCategories.every((c) => c === "lint" || c === "spell");
	if (!trivialOnly) return null;

	if (sameModelRetries < maxRetriesPerTier) {
		const remaining = maxRetriesPerTier - sameModelRetries;
		return { shouldEscalate: false, reason: `trivial error, ${remaining} retries left at tier` };
	}
	return { shouldEscalate: true, reason: `trivial errors persist after ${maxRetriesPerTier} retries` };
}

/**
 * Check for serious errors (typecheck/build/test)
 */
export function checkSeriousErrors(
	errorCategories: ErrorCategory[],
	task: string,
	sameModelRetries: number,
	maxRetriesPerTier: number,
): EscalationResult | null {
	const hasSerious = errorCategories.some((c) => c === "typecheck" || c === "build" || c === "test");
	if (!hasSerious) return null;

	// Test-writing tasks get more retries when tests fail
	const isWritingTests = isTestTask(task);
	const hasTestErrors = errorCategories.includes("test");

	let seriousRetryLimit: number;
	if (isWritingTests && hasTestErrors) {
		seriousRetryLimit = maxRetriesPerTier + 1;
		sessionLogger.debug(
			{ retries: sameModelRetries, limit: seriousRetryLimit },
			"Test task - allowing extra retries for test failures",
		);
	} else {
		seriousRetryLimit = Math.max(2, maxRetriesPerTier - 1);
	}

	if (sameModelRetries < seriousRetryLimit) {
		const remaining = seriousRetryLimit - sameModelRetries;
		return { shouldEscalate: false, reason: `serious error, ${remaining} retries left at tier` };
	}
	return { shouldEscalate: true, reason: `serious errors after ${seriousRetryLimit} retries` };
}

/**
 * Check default retry limit
 */
export function checkDefaultRetryLimit(
	sameModelRetries: number,
	maxRetriesPerTier: number,
): EscalationResult {
	if (sameModelRetries >= maxRetriesPerTier) {
		return { shouldEscalate: true, reason: `max retries at tier (${maxRetriesPerTier})` };
	}
	return { shouldEscalate: false, reason: "retrying" };
}
