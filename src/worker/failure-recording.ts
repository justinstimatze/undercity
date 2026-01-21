/**
 * Worker Failure Recording Helpers
 *
 * Extracted learning/recording operations for task failures.
 */

import { markLearningsUsed } from "../knowledge.js";
import { sessionLogger } from "../logger.js";
import * as output from "../output.js";
import {
	clearPendingError,
	recordPermanentFailure,
} from "../error-fix-patterns.js";
import {
	flagNeedsHumanInput,
	getHumanGuidance,
	shouldRequestHumanInput,
} from "../human-input-tracking.js";
import { recordTaskFiles } from "../task-file-patterns.js";
import { updateDecisionOutcome } from "../decision-tracker.js";
import { recordPlanCreationOutcome } from "../ax-programs.js";
import type { ComplexityAssessment } from "../complexity.js";
import type { ModelTier } from "../types.js";
import type { TieredPlanResult } from "../task-planner.js";
import type { ContextBriefing } from "../context.js";

/**
 * Context for recording a permanent failure
 */
export interface PermanentFailureContext {
	taskId: string;
	task: string;
	pendingErrorSignature: string | null;
	lastErrorCategory: string | null;
	lastErrorMessage: string | null;
	lastDetailedErrors: string[];
	currentModel: ModelTier;
	attempts: number;
	modifiedFiles: string[];
	stateDir: string;
}

/**
 * Record permanent failure and optionally flag for human input
 */
export function recordPermanentFailureWithHumanInput(ctx: PermanentFailureContext): void {
	const {
		taskId,
		task,
		pendingErrorSignature,
		lastErrorCategory,
		lastErrorMessage,
		lastDetailedErrors,
		currentModel,
		attempts,
		modifiedFiles,
		stateDir,
	} = ctx;

	if (!pendingErrorSignature || !lastErrorCategory || !lastErrorMessage) {
		return;
	}

	try {
		recordPermanentFailure({
			taskId,
			category: lastErrorCategory,
			message: lastErrorMessage,
			taskObjective: task,
			modelUsed: currentModel,
			attemptCount: attempts,
			currentFiles: modifiedFiles,
			detailedErrors: lastDetailedErrors,
			stateDir,
		});
		output.debug("Recorded permanent failure for learning", {
			taskId,
			category: lastErrorCategory,
			detailedErrorCount: lastDetailedErrors.length,
		});

		// Check if this failure pattern should request human input
		if (shouldRequestHumanInput(pendingErrorSignature, taskId, stateDir)) {
			const existingGuidance = getHumanGuidance(pendingErrorSignature, stateDir);
			flagNeedsHumanInput(
				taskId,
				task,
				pendingErrorSignature,
				lastErrorCategory,
				lastErrorMessage,
				attempts,
				currentModel,
				existingGuidance?.guidance,
				stateDir,
			);
		}
	} catch {
		// Non-critical - fall back to just clearing
		try {
			clearPendingError(taskId);
		} catch {
			// Ignore
		}
	}
}

/**
 * Mark injected learnings as failed
 */
export function markLearningsAsFailed(learningIds: string[], stateDir: string): void {
	if (learningIds.length === 0) return;
	try {
		markLearningsUsed(learningIds, false, stateDir);
	} catch {
		// Non-critical
	}
}

/**
 * Record failed task file pattern
 */
export function recordFailedTaskPattern(taskId: string, task: string, modifiedFiles: string[]): void {
	try {
		recordTaskFiles(taskId, task, modifiedFiles, false);
		output.debug(`Recorded failed task pattern`, { taskId });
	} catch {
		// Non-critical
	}
}

/**
 * Update decision outcomes to failure
 */
export async function updateDecisionOutcomesToFailure(taskId: string, stateDir: string): Promise<void> {
	try {
		const { loadDecisionStore } = await import("../decision-tracker.js");
		const store = loadDecisionStore(stateDir);
		const taskDecisions = store.resolved.filter(
			(d) => d.taskId === taskId && d.resolution.outcome === undefined,
		);
		for (const decision of taskDecisions) {
			updateDecisionOutcome(decision.id, "failure", stateDir);
		}
	} catch {
		// Non-critical
	}
}

/**
 * Context for recording plan failure
 */
export interface PlanFailureContext {
	task: string;
	executionPlan: TieredPlanResult | null | undefined;
	briefing: ContextBriefing | null | undefined;
	stateDir: string;
}

/**
 * Record plan creation failure for Ax learning
 */
export function recordPlanFailure(ctx: PlanFailureContext): void {
	const { task, executionPlan, briefing, stateDir } = ctx;

	if (!executionPlan?.proceedWithExecution) return;

	try {
		const plan = executionPlan.plan;
		const briefingDoc = briefing?.briefingDoc || "";

		recordPlanCreationOutcome(
			{ task, contextBriefing: briefingDoc },
			{
				filesToRead: plan.filesToRead,
				filesToModify: plan.filesToModify,
				filesToCreate: plan.filesToCreate,
				steps: plan.steps,
				risks: plan.risks,
				expectedOutcome: plan.expectedOutcome,
				alreadyComplete: plan.alreadyComplete?.likely || false,
				needsDecomposition: plan.needsDecomposition?.needed || false,
				reasoning: "",
			},
			false, // Task failed
			stateDir,
		);
	} catch {
		// Non-critical
	}
}

/**
 * Context for recording complexity assessment failure
 */
export interface ComplexityFailureContext {
	task: string;
	complexityAssessment: ComplexityAssessment | null | undefined;
	stateDir: string;
}

/**
 * Record complexity assessment outcome for Ax learning
 */
export function recordComplexityFailure(
	ctx: ComplexityFailureContext,
	recordComplexityOutcome: (
		task: string,
		assessment: { level: string; scope: string; reasoning: string; confidence: number },
		success: boolean,
		stateDir: string,
	) => void,
): void {
	const { task, complexityAssessment, stateDir } = ctx;

	if (!complexityAssessment) return;

	try {
		recordComplexityOutcome(
			task,
			{
				level: complexityAssessment.level,
				scope: complexityAssessment.estimatedScope,
				reasoning: complexityAssessment.signals.join(", "),
				confidence: complexityAssessment.confidence,
			},
			false, // Task failed
			stateDir,
		);
	} catch {
		// Non-critical
	}
}

/**
 * Build actionable error message based on failure type
 */
export function buildFailureErrorMessage(consecutiveNoWriteAttempts: number, attempts: number): string {
	if (consecutiveNoWriteAttempts >= 2) {
		return (
			`NO_CHANGES: Agent couldn't identify what to modify after ${attempts} attempts. ` +
			"Task may be too vague or already complete. Consider: (1) breaking into specific subtasks, " +
			"(2) adding file paths to the task, (3) verifying the task still needs doing."
		);
	}
	return "Max attempts reached without passing verification";
}
