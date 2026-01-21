/**
 * Worker Task Result Helpers
 *
 * Extracted helpers for building TaskResult objects to reduce complexity.
 */

import { sessionLogger } from "../logger.js";
import type { ModelTier, TokenUsage } from "../types.js";
import type { VerificationResult } from "../verification.js";

/**
 * Task result structure (subset for helpers to avoid circular dep)
 */
export interface TaskResultBase {
	task: string;
	status: "complete" | "failed" | "escalated";
	model: ModelTier;
	attempts: number;
	verification?: VerificationResult;
	error?: string;
	durationMs: number;
	tokenUsage: {
		attempts: TokenUsage[];
		total: number;
	};
	needsDecomposition?: {
		reason: string;
		suggestedSubtasks?: string[];
	};
}

/**
 * Calculate total token usage from array of usages
 */
export function calculateTotalTokens(usages: TokenUsage[]): number {
	return usages.reduce((sum, usage) => sum + usage.totalTokens, 0);
}

/**
 * Build token usage summary for task results
 */
export function buildTokenUsageSummary(attempts: TokenUsage[]): {
	attempts: TokenUsage[];
	total: number;
} {
	return {
		attempts,
		total: calculateTotalTokens(attempts),
	};
}

/**
 * Context for building failure results
 */
export interface FailureResultContext {
	task: string;
	taskId: string;
	model: ModelTier;
	attempts: number;
	verification?: VerificationResult;
	startTime: number;
	tokenUsageThisTask: TokenUsage[];
}

/**
 * Build result for invalid target failure
 */
export function buildInvalidTargetResult(
	ctx: FailureResultContext,
	invalidTargetReason: string,
): TaskResultBase {
	sessionLogger.warn(
		{ taskId: ctx.taskId, reason: invalidTargetReason },
		"Task failed: invalid target (file/function doesn't exist)",
	);

	return {
		task: ctx.task,
		status: "failed",
		model: ctx.model,
		attempts: ctx.attempts,
		verification: ctx.verification,
		error: `INVALID_TARGET: ${invalidTargetReason}`,
		durationMs: Date.now() - ctx.startTime,
		tokenUsage: buildTokenUsageSummary(ctx.tokenUsageThisTask),
	};
}

/**
 * Parse suggested subtasks from decomposition reason
 */
export function parseSuggestedSubtasks(reason: string): string[] | undefined {
	if (!reason.includes(";")) {
		return undefined;
	}
	return reason
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Build result for needs decomposition failure
 */
export function buildNeedsDecompositionResult(
	ctx: FailureResultContext,
	needsDecompositionReason: string,
): TaskResultBase {
	sessionLogger.info(
		{ taskId: ctx.taskId, reason: needsDecompositionReason },
		"Task needs decomposition - returning to orchestrator",
	);

	const suggestedSubtasks = parseSuggestedSubtasks(needsDecompositionReason);

	return {
		task: ctx.task,
		status: "failed",
		model: ctx.model,
		attempts: ctx.attempts,
		verification: ctx.verification,
		error: `NEEDS_DECOMPOSITION: ${needsDecompositionReason}`,
		durationMs: Date.now() - ctx.startTime,
		tokenUsage: buildTokenUsageSummary(ctx.tokenUsageThisTask),
		needsDecomposition: {
			reason: needsDecompositionReason,
			suggestedSubtasks,
		},
	};
}

/**
 * Check if task is already complete based on verification and agent markers
 */
export function isTaskAlreadyComplete(
	verification: VerificationResult,
	taskAlreadyCompleteReason: string | null,
	noOpEditCount: number,
): boolean {
	return (
		verification.passed &&
		verification.filesChanged === 0 &&
		(taskAlreadyCompleteReason !== null || noOpEditCount > 0)
	);
}

/**
 * Check if this is a standard implementation task (not meta, not research)
 */
export function isStandardImplementationTask(isMetaTask: boolean, isResearchTask: boolean): boolean {
	return !isMetaTask && !isResearchTask;
}

/**
 * Build early validation failure result (no token usage yet)
 */
export function buildValidationFailureResult(
	task: string,
	model: ModelTier,
	reason: string,
	startTime: number,
): TaskResultBase {
	return {
		task,
		status: "failed",
		model,
		attempts: 0,
		error: `INVALID_TARGET: ${reason}`,
		durationMs: Date.now() - startTime,
		tokenUsage: { attempts: [], total: 0 },
	};
}
