/**
 * Worker Escalation Logic Helpers
 *
 * Extracted escalation decision logic from shouldEscalate.
 * Now integrates with learning systems:
 * - capability-ledger: Historical model performance for similar tasks
 * - error-fix-patterns: Known fixes for specific errors
 */

import { getRecommendedModel, type ModelRecommendation } from "../capability-ledger.js";
import { type ErrorFix, type ErrorFixPattern, findFixSuggestions } from "../error-fix-patterns.js";
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
	const sameErrorCount = errorHistory.filter((e) => e.message.slice(0, 80) === errorMessage.slice(0, 80)).length;

	if (sameErrorCount >= 2) {
		sessionLogger.warn(
			{
				errorMessage: errorMessage.slice(0, 100),
				occurrences: sameErrorCount,
			},
			"Ralph loop detection: same error 2+ times - failing fast",
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
export function checkDefaultRetryLimit(sameModelRetries: number, maxRetriesPerTier: number): EscalationResult {
	if (sameModelRetries >= maxRetriesPerTier) {
		return { shouldEscalate: true, reason: `max retries at tier (${maxRetriesPerTier})` };
	}
	return { shouldEscalate: false, reason: "retrying" };
}

// =============================================================================
// Learning System Integration
// =============================================================================

/**
 * Result of checking capability ledger for model recommendation
 */
export interface LedgerCheckResult {
	/** Recommended model based on historical data */
	recommendedModel: "sonnet" | "opus";
	/** Confidence in recommendation (0-1) */
	confidence: number;
	/** Reason for recommendation */
	reason: string;
	/** Whether we should escalate based on ledger data */
	suggestEscalate: boolean;
}

/**
 * Check capability ledger for historical model performance on similar tasks.
 *
 * The ledger tracks success rates per model for different task patterns.
 * If the ledger shows that opus consistently succeeds where sonnet fails
 * for similar tasks, this can inform early escalation decisions.
 *
 * @param objective - Task objective to check
 * @param currentModel - Current model tier
 * @param stateDir - State directory for ledger data
 * @returns Ledger check result with recommendation
 */
export function checkCapabilityLedger(
	objective: string,
	currentModel: string,
	stateDir: string = ".undercity",
): LedgerCheckResult {
	try {
		const recommendation: ModelRecommendation = getRecommendedModel(objective, stateDir);

		// Default result - no strong signal
		const result: LedgerCheckResult = {
			recommendedModel: recommendation.model,
			confidence: recommendation.confidence,
			reason: recommendation.reason,
			suggestEscalate: false,
		};

		// If ledger strongly recommends opus (>70% confidence) and we're on sonnet,
		// suggest escalation after fewer retries
		if (recommendation.model === "opus" && currentModel === "sonnet" && recommendation.confidence >= 0.7) {
			result.suggestEscalate = true;
			sessionLogger.debug(
				{
					objective: objective.slice(0, 50),
					recommendedModel: recommendation.model,
					confidence: recommendation.confidence,
				},
				"Capability ledger suggests escalation to opus",
			);
		}

		// If ledger shows sonnet works well and we're already on sonnet,
		// don't suggest escalation
		if (recommendation.model === "sonnet" && currentModel === "sonnet" && recommendation.confidence >= 0.7) {
			result.suggestEscalate = false;
			sessionLogger.debug(
				{ objective: objective.slice(0, 50), confidence: recommendation.confidence },
				"Capability ledger confirms sonnet is appropriate",
			);
		}

		return result;
	} catch {
		// Ledger not available or error - return neutral result
		return {
			recommendedModel: "sonnet",
			confidence: 0,
			reason: "Ledger unavailable",
			suggestEscalate: false,
		};
	}
}

/**
 * Result of checking error-fix patterns
 */
export interface ErrorFixCheckResult {
	/** Whether a known fix exists for this error */
	hasKnownFix: boolean;
	/** The pattern that matched */
	pattern?: ErrorFixPattern;
	/** Suggested fixes */
	fixes?: ErrorFix[];
	/** Whether to suggest more retries (a known fix exists) */
	suggestRetry: boolean;
	/** Reason for suggestion */
	reason: string;
}

/**
 * Check error-fix patterns for known solutions to an error.
 *
 * If we've seen this exact error before and successfully fixed it,
 * this informs whether to retry (with fix hints) rather than escalate.
 *
 * @param category - Error category (typecheck, test, lint, build)
 * @param message - Error message
 * @param stateDir - State directory for patterns
 * @returns Error fix check result
 */
export function checkErrorFixPatterns(
	category: string,
	message: string,
	stateDir: string = ".undercity",
): ErrorFixCheckResult {
	try {
		const result = findFixSuggestions(category, message, stateDir);

		if (!result || result.suggestions.length === 0) {
			return {
				hasKnownFix: false,
				suggestRetry: false,
				reason: "No known fix for this error",
			};
		}

		const successRate = result.pattern.occurrences > 0 ? result.pattern.fixSuccesses / result.pattern.occurrences : 0;

		// If we have a fix that worked >50% of the time, suggest retry
		const suggestRetry = successRate >= 0.5;

		sessionLogger.debug(
			{
				category,
				signature: result.pattern.signature,
				successRate,
				fixCount: result.suggestions.length,
			},
			suggestRetry ? "Known fix found - suggesting retry" : "Fix pattern found but low success rate",
		);

		return {
			hasKnownFix: true,
			pattern: result.pattern,
			fixes: result.suggestions,
			suggestRetry,
			reason: suggestRetry
				? `Known fix exists (${Math.round(successRate * 100)}% success rate)`
				: `Fix pattern found but only ${Math.round(successRate * 100)}% success rate`,
		};
	} catch {
		return {
			hasKnownFix: false,
			suggestRetry: false,
			reason: "Error fix patterns unavailable",
		};
	}
}

/**
 * Combined learning system check for escalation decisions.
 *
 * This is the main entry point for integrating learning systems into
 * escalation decisions. It combines signals from:
 * - Capability ledger (historical model performance)
 * - Error-fix patterns (known solutions)
 *
 * @param objective - Task objective
 * @param currentModel - Current model tier
 * @param errorCategory - Current error category (if any)
 * @param errorMessage - Current error message (if any)
 * @param sameModelRetries - Number of retries at current tier
 * @param stateDir - State directory
 * @returns Combined recommendation
 */
export function checkLearningSystemsForEscalation(
	objective: string,
	currentModel: string,
	errorCategory: string | undefined,
	errorMessage: string | undefined,
	_sameModelRetries: number,
	stateDir: string = ".undercity",
): {
	modifyRetryLimit: number;
	reason: string;
	hasKnownFix: boolean;
	ledgerSuggestsEscalation: boolean;
} {
	// Check capability ledger
	const ledgerResult = checkCapabilityLedger(objective, currentModel, stateDir);

	// Check error-fix patterns if we have an error
	let errorFixResult: ErrorFixCheckResult = {
		hasKnownFix: false,
		suggestRetry: false,
		reason: "No error to check",
	};
	if (errorCategory && errorMessage) {
		errorFixResult = checkErrorFixPatterns(errorCategory, errorMessage, stateDir);
	}

	// Determine retry limit modification
	let modifyRetryLimit = 0;
	const reasons: string[] = [];

	// If ledger strongly suggests opus, reduce retries before escalation
	if (ledgerResult.suggestEscalate && currentModel === "sonnet") {
		modifyRetryLimit = -1; // Escalate one retry sooner
		reasons.push(`ledger: ${ledgerResult.reason}`);
	}

	// If we have a known fix, add an extra retry to try it
	if (errorFixResult.hasKnownFix && errorFixResult.suggestRetry) {
		modifyRetryLimit = Math.max(modifyRetryLimit, 1); // At least one extra retry
		reasons.push(`known fix: ${errorFixResult.reason}`);
	}

	return {
		modifyRetryLimit,
		reason: reasons.length > 0 ? reasons.join("; ") : "No learning signals",
		hasKnownFix: errorFixResult.hasKnownFix,
		ledgerSuggestsEscalation: ledgerResult.suggestEscalate,
	};
}
