/**
 * Verification Handler
 *
 * Handles task verification results and success/failure flow.
 * Extracts the pure verification logic from TaskWorker.
 *
 * Dependencies:
 *   - Verification running is done by caller (uses verifyWork)
 *   - Escalation decisions are made by caller
 *   - State mutations are explicit via returned actions
 */

import { formatFixSuggestionsForPrompt, recordSuccessfulFix } from "../error-fix-patterns.js";
import { formatGuidanceForWorker, markGuidanceUsed } from "../human-input-tracking.js";
import { findRelevantLearnings, formatLearningsForPrompt } from "../knowledge.js";
import { sessionLogger } from "../logger.js";
import * as output from "../output.js";
import { runEscalatingReview } from "../review.js";
import { formatCoModificationHints } from "../task-file-patterns.js";
import type { ErrorCategory, ModelTier } from "../types.js";
import type { VerificationResult } from "../verification.js";
import { verifyWork } from "../verification.js";
import type { TaskResult } from "../worker.js";
import {
	recordAttempt,
	selectTokenUsageSummary,
	type TaskExecutionState,
	type TaskIdentity,
	type WorkerConfig,
} from "./state.js";

/**
 * Review level configuration
 */
export interface ReviewLevel {
	review: boolean;
	multiLens: boolean;
	maxReviewTier: ModelTier;
}

/**
 * Dependencies for verification handling
 */
export interface VerificationDependencies {
	/** Save checkpoint for crash recovery */
	saveCheckpoint: (phase: string, data?: { passed: boolean; errors?: string[] }) => void;
	/** Commit work to git */
	commitWork: (task: string) => Promise<string | undefined>;
	/** Get list of modified files */
	getModifiedFiles: () => string[];
	/** Get files from last commit */
	getFilesFromLastCommit: () => string[];
	/** Record attempts to metrics tracker */
	recordMetricsAttempts: (records: TaskExecutionState["attemptRecords"]) => void;
	/** Mark task complete in metrics */
	completeMetricsTask: (success: boolean) => void;
	/** Record success learnings */
	recordSuccessLearnings: (taskId: string, task: string) => Promise<void>;
	/** Record injected learning IDs for effectiveness tracking */
	recordInjectedLearnings: (learningIds: string[]) => void;
	/** Record predicted files for effectiveness tracking */
	recordPredictedFiles: (files: string[]) => void;
	/** Record actual files modified for effectiveness tracking */
	recordActualFilesModified: (files: string[]) => void;
}

/**
 * Result of verification handling - either complete or needs retry
 */
export type VerificationHandleResult =
	| { done: true; result: TaskResult }
	| { done: false; feedback: string; shouldEscalate?: boolean; errorCategories: ErrorCategory[] };

/**
 * Handle "already complete" case - task doesn't need changes
 */
export function handleAlreadyComplete(
	identity: TaskIdentity,
	state: TaskExecutionState,
	verification: VerificationResult,
	startTime: number,
): TaskResult {
	const reason = state.taskAlreadyCompleteReason || "no-op edits detected";
	output.workerVerification(identity.taskId, true);
	sessionLogger.info({ taskId: identity.taskId, reason, noOpEdits: state.noOpEditCount }, "Task already complete");

	return {
		task: identity.task,
		status: "complete",
		model: state.currentModel,
		attempts: state.attempts,
		verification,
		commitSha: undefined,
		durationMs: Date.now() - startTime,
		tokenUsage: selectTokenUsageSummary(state),
		taskAlreadyComplete: true,
	};
}

/**
 * Run review passes if enabled
 */
export async function runReviewPasses(
	identity: TaskIdentity,
	config: WorkerConfig,
	reviewLevel: ReviewLevel,
	baseCommit: string | undefined,
	deps: Pick<VerificationDependencies, "saveCheckpoint">,
): Promise<{ continue: boolean; verification?: VerificationResult; feedback?: string }> {
	deps.saveCheckpoint("reviewing", { passed: true });
	output.workerPhase(identity.taskId, "reviewing");

	const reviewResult = await runEscalatingReview(identity.task, {
		useMultiLens: reviewLevel.multiLens,
		maxReviewTier: reviewLevel.maxReviewTier,
		maxReviewPassesPerTier: config.maxReviewPassesPerTier,
		maxOpusReviewPasses: config.maxOpusReviewPasses,
		workingDirectory: config.workingDirectory,
		runTypecheck: config.runTypecheck,
		runTests: config.runTests,
		verbose: config.verbose,
	});

	if (!reviewResult.converged) {
		output.warning("Review could not fully resolve issues, retrying task...", { taskId: identity.taskId });
		const feedback = `Review found issues that couldn't be fully resolved: ${reviewResult.issuesFound.join(", ")}`;
		return { continue: false, feedback };
	}

	if (reviewResult.issuesFound.length > 0) {
		const finalVerification = await verifyWork({
			runTypecheck: config.runTypecheck,
			runTests: config.runTests,
			workingDirectory: config.workingDirectory,
			baseCommit,
			skipOptionalChecks: config.skipOptionalVerification,
		});
		if (!finalVerification.passed) {
			output.warning("Final verification failed after reviews", { taskId: identity.taskId });
			return { continue: false, feedback: finalVerification.feedback };
		}
		return { continue: true, verification: finalVerification };
	}

	return { continue: true };
}

/**
 * Handle successful verification - record success and build result
 */
export async function handleVerificationSuccess(
	identity: TaskIdentity,
	state: TaskExecutionState,
	config: WorkerConfig,
	verification: VerificationResult,
	reviewLevel: ReviewLevel,
	errorCategories: ErrorCategory[],
	baseCommit: string | undefined,
	attemptStart: number,
	startTime: number,
	phaseTimings: Record<string, number>,
	deps: VerificationDependencies,
): Promise<VerificationHandleResult> {
	output.workerVerification(identity.taskId, true);

	// Record successful fix if we had a pending error
	if (state.pendingErrorSignature) {
		try {
			const currentFiles = deps.getModifiedFiles();
			const newFiles = currentFiles.filter((f) => !state.filesBeforeAttempt.includes(f));
			const changedFiles = newFiles.length > 0 ? newFiles : currentFiles;
			recordSuccessfulFix({
				taskId: identity.taskId,
				filesChanged: changedFiles,
				editSummary: `Fixed ${errorCategories.join(", ") || "verification"} error`,
				workingDirectory: config.workingDirectory,
				baseCommit,
				stateDir: config.stateDir,
			});
			output.debug("Recorded fix for error pattern", { taskId: identity.taskId, files: changedFiles.length });

			// Mark human guidance as successful if it was used
			try {
				markGuidanceUsed(state.pendingErrorSignature, true, config.stateDir);
			} catch {
				// Non-critical
			}
		} catch {
			// Non-critical
		}
	}

	let finalVerification = verification;
	if (verification.hasWarnings) {
		output.debug("Verification passed with warnings (skipping retry)", {
			taskId: identity.taskId,
			warnings: verification.feedback.slice(0, 200),
		});
	}

	// Run review passes if enabled
	if (reviewLevel.review) {
		const reviewResult = await runReviewPasses(identity, config, reviewLevel, baseCommit, deps);
		if (!reviewResult.continue) {
			return {
				done: false,
				feedback: reviewResult.feedback || "Review failed",
				errorCategories,
			};
		}
		if (reviewResult.verification) {
			finalVerification = reviewResult.verification;
		}
	}

	// Record successful attempt
	recordAttempt(state, true, Date.now() - attemptStart);

	// Commit if enabled
	let commitSha: string | undefined;
	if (config.autoCommit && finalVerification.filesChanged > 0) {
		deps.saveCheckpoint("committing", { passed: true });
		output.workerPhase(identity.taskId, "committing");
		commitSha = await deps.commitWork(identity.task);
	}

	// Update metrics with effectiveness tracking
	deps.recordMetricsAttempts(state.attemptRecords);
	deps.recordInjectedLearnings(state.injectedLearningIds);
	// Record predicted files if available (from context building phase)
	// Note: predictedFiles would need to be passed through state if available
	deps.recordActualFilesModified(deps.getModifiedFiles());
	deps.completeMetricsTask(true);

	// Log phase timings
	const totalMs = Date.now() - startTime;
	const lastAgentTurns = state.lastAgentTurns || 1;
	const msPerTurn =
		lastAgentTurns > 0 && phaseTimings.agentExecution ? Math.round(phaseTimings.agentExecution / lastAgentTurns) : 0;
	output.info(
		`Phase timings: context=${phaseTimings.contextPrep || 0}ms, agent=${phaseTimings.agentExecution || 0}ms (${lastAgentTurns} turns, ${msPerTurn}ms/turn), verify=${phaseTimings.verification || 0}ms, total=${totalMs}ms`,
		{ taskId: identity.taskId, phaseTimings, totalMs, turns: lastAgentTurns, msPerTurn },
	);

	// Record learnings
	await deps.recordSuccessLearnings(identity.taskId, identity.task);

	return {
		done: true,
		result: {
			task: identity.task,
			status: "complete",
			model: state.currentModel,
			attempts: state.attempts,
			verification: finalVerification,
			commitSha,
			durationMs: Date.now() - startTime,
			tokenUsage: selectTokenUsageSummary(state),
		},
	};
}

/**
 * Build enhanced feedback with fix suggestions and hints
 *
 * Integrates multiple learning systems to provide rich context:
 * - Error-fix patterns: Known fixes for similar errors
 * - Knowledge base: Past learnings about similar issues
 * - Human guidance: User-provided hints for this error
 * - Co-modification hints: Files commonly modified together
 */
export function buildEnhancedFeedback(
	taskId: string,
	verification: VerificationResult,
	primaryCategory: string,
	errorMessage: string,
	pendingErrorSignature: string | null,
	modifiedFiles: string[],
	stateDir: string,
): string {
	let enhancedFeedback = verification.feedback;

	// Add fix suggestions from error patterns
	try {
		const fixSuggestion = formatFixSuggestionsForPrompt(primaryCategory, errorMessage);
		if (fixSuggestion) {
			output.debug("Found fix suggestions from previous errors", { taskId });
			enhancedFeedback += `\n\n${fixSuggestion}`;
		}
	} catch {
		// Non-critical
	}

	// Add relevant knowledge about similar errors
	// Query the knowledge base for learnings related to this type of error
	try {
		const errorQuery = `${primaryCategory} error: ${errorMessage.slice(0, 100)}`;
		const learnings = findRelevantLearnings(errorQuery, 3, stateDir);
		if (learnings.length > 0) {
			const knowledgeHints = formatLearningsForPrompt(learnings);
			if (knowledgeHints) {
				output.debug("Found relevant knowledge for error recovery", {
					taskId,
					learningsCount: learnings.length,
				});
				enhancedFeedback += `\n\n## RELEVANT KNOWLEDGE FROM PAST TASKS\n${knowledgeHints}`;
			}
		}
	} catch {
		// Non-critical - knowledge base may not be available
	}

	// Add human guidance if available
	if (pendingErrorSignature) {
		try {
			const humanGuidance = formatGuidanceForWorker(pendingErrorSignature, stateDir);
			if (humanGuidance) {
				output.debug("Found human guidance for error pattern", { taskId });
				enhancedFeedback += `\n\n${humanGuidance}`;
			}
		} catch {
			// Non-critical
		}
	}

	// Add co-modification hints
	if (modifiedFiles.length > 0) {
		try {
			const coModHints = formatCoModificationHints(modifiedFiles);
			if (coModHints) {
				output.debug("Found co-modification hints", { taskId, fileCount: modifiedFiles.length });
				enhancedFeedback += `\n\n${coModHints}`;
			}
		} catch {
			// Non-critical
		}
	}

	return enhancedFeedback;
}

/**
 * Record a verification failure and build feedback
 */
export function recordVerificationFailure(
	identity: TaskIdentity,
	state: TaskExecutionState,
	config: WorkerConfig,
	verification: VerificationResult,
	errorCategories: ErrorCategory[],
	attemptStart: number,
	deps: Pick<VerificationDependencies, "getModifiedFiles" | "saveCheckpoint">,
): { feedback: string; errorSignature: string | null } {
	// Record failed attempt
	recordAttempt(state, false, Date.now() - attemptStart);
	// Also store error categories in the record
	const lastRecord = state.attemptRecords[state.attemptRecords.length - 1];
	if (lastRecord) {
		(lastRecord as { errorCategories?: ErrorCategory[] }).errorCategories = errorCategories;
	}

	// Get primary error info
	const primaryCategory = errorCategories[0] || "unknown";
	const errorMessage = verification.issues[0] || verification.feedback.slice(0, 200);

	// Record error in state history (Ralph-style accumulation)
	state.errorHistory.push({
		category: primaryCategory,
		message: errorMessage,
		attempt: state.attempts,
	});
	state.lastErrorCategory = primaryCategory;
	state.lastErrorMessage = errorMessage;

	// Capture detailed errors
	state.lastDetailedErrors = [
		...verification.issues,
		...verification.feedback
			.split("\n")
			.filter((line) => line.includes("error") || line.includes("Error") || line.includes("FAIL") || line.includes("✗"))
			.slice(0, 10),
	];

	// Record pending error for fix tracking
	let errorSignature: string | null = null;
	try {
		const { recordPendingError } = require("../error-fix-patterns.js");
		errorSignature = recordPendingError(identity.taskId, primaryCategory, errorMessage, deps.getModifiedFiles());
		state.filesBeforeAttempt = deps.getModifiedFiles();
	} catch {
		// Non-critical
	}

	// Build enhanced feedback
	const feedback = buildEnhancedFeedback(
		identity.taskId,
		verification,
		primaryCategory,
		errorMessage,
		errorSignature,
		deps.getModifiedFiles(),
		config.stateDir,
	);

	// Save checkpoint
	deps.saveCheckpoint("verifying", {
		passed: false,
		errors: verification.issues.slice(0, 5),
	});

	// Output
	const errorSummary = errorCategories.length > 0 ? errorCategories.join(", ") : verification.issues.join(", ");
	output.workerVerification(identity.taskId, false, [errorSummary]);

	return { feedback, errorSignature };
}
