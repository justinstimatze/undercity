/**
 * Worker Failure Recording Helpers
 *
 * Extracted learning/recording operations for task failures.
 */

import { recordPlanCreationOutcome } from "../ax-programs.js";
import type { ComplexityAssessment } from "../complexity.js";
import type { ContextBriefing } from "../context.js";
import { updateDecisionOutcome } from "../decision-tracker.js";
import { clearPendingError, recordPermanentFailure } from "../error-fix-patterns.js";
import { flagNeedsHumanInput, getHumanGuidance, shouldRequestHumanInput } from "../human-input-tracking.js";
import { addLearning, markLearningsUsed } from "../knowledge.js";
import { sessionLogger } from "../logger.js";
import * as output from "../output.js";
import { recordTaskFiles } from "../task-file-patterns.js";
import type { TieredPlanResult } from "../task-planner.js";
import type { ModelTier } from "../types.js";

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
		const taskDecisions = store.resolved.filter((d) => d.taskId === taskId && d.resolution.outcome === undefined);
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

// =============================================================================
// Failure-Specific Learning Capture
// =============================================================================

const logger = sessionLogger.child({ module: "failure-recording" });

/**
 * Context for decomposition failure learning
 */
export interface DecompositionFailureContext {
	taskId: string;
	task: string;
	attempts: number;
	currentModel: ModelTier;
	complexityAssessment?: ComplexityAssessment | null;
	stateDir: string;
}

/**
 * Record learning from decomposition/turn exhaustion failures
 *
 * These failures indicate the task was too complex for single-pass execution.
 * Records patterns to help future complexity assessment and task decomposition.
 */
export function recordDecompositionFailureLearning(ctx: DecompositionFailureContext): void {
	const { taskId, task, attempts, currentModel, complexityAssessment, stateDir } = ctx;

	try {
		// Extract complexity signals from the task
		const complexitySignals: string[] = [];

		if (task.toLowerCase().includes("refactor")) complexitySignals.push("refactor");
		if (task.toLowerCase().includes("across") || task.toLowerCase().includes("all files"))
			complexitySignals.push("multi-file");
		if (task.toLowerCase().includes("and") && task.split(" and ").length > 2) complexitySignals.push("compound-task");
		if (task.length > 200) complexitySignals.push("long-description");

		const assessedLevel = complexityAssessment?.level || "unknown";
		const assessedScope = complexityAssessment?.estimatedScope || "unknown";

		addLearning(
			{
				taskId,
				category: "gotcha",
				keywords: ["decomposition-failure", "complexity-mismatch", ...extractTaskKeywords(task), ...complexitySignals],
				content:
					`Task exhausted ${attempts} attempts with ${currentModel} model without completing. ` +
					`Complexity was assessed as "${assessedLevel}" with scope "${assessedScope}". ` +
					`Signals: ${complexitySignals.join(", ") || "none detected"}. ` +
					`Consider: (1) decomposing into smaller subtasks, (2) adding specific file paths, ` +
					`(3) reducing scope to single concern.`,
			},
			stateDir,
		);

		logger.info(
			{ taskId, attempts, model: currentModel, signals: complexitySignals },
			"Recorded decomposition failure learning",
		);
	} catch (err) {
		logger.warn({ err, taskId }, "Failed to record decomposition failure learning");
	}
}

/**
 * Context for plan rejection failure learning
 */
export interface PlanRejectionFailureContext {
	taskId: string;
	task: string;
	rejectionReason: string;
	planDetails?: {
		filesToModify?: string[];
		steps?: string[];
		risks?: string[];
	};
	stateDir: string;
}

/**
 * Record learning from plan rejection failures
 *
 * These failures indicate the planning phase identified issues before execution.
 * Records the rejection patterns to improve future planning.
 */
export function recordPlanRejectionLearning(ctx: PlanRejectionFailureContext): void {
	const { taskId, task, rejectionReason, planDetails, stateDir } = ctx;

	try {
		const fileCount = planDetails?.filesToModify?.length || 0;
		const stepCount = planDetails?.steps?.length || 0;
		const riskCount = planDetails?.risks?.length || 0;

		addLearning(
			{
				taskId,
				category: "gotcha",
				keywords: ["plan-rejection", "planning-failure", ...extractTaskKeywords(task)],
				content:
					`Plan was rejected during review: "${rejectionReason}". ` +
					`Plan scope: ${fileCount} files, ${stepCount} steps, ${riskCount} risks identified. ` +
					`Task pattern to avoid or reformulate for clearer scope.`,
			},
			stateDir,
		);

		logger.info({ taskId, rejectionReason, fileCount, stepCount }, "Recorded plan rejection learning");
	} catch (err) {
		logger.warn({ err, taskId }, "Failed to record plan rejection learning");
	}
}

/**
 * Context for no-changes failure learning
 */
export interface NoChangesFailureContext {
	taskId: string;
	task: string;
	attempts: number;
	currentModel: ModelTier;
	stateDir: string;
}

/**
 * Record learning from no-changes failures
 *
 * These failures indicate the agent couldn't identify what to modify.
 * Usually means the task is too vague or already complete.
 */
export function recordNoChangesFailureLearning(ctx: NoChangesFailureContext): void {
	const { taskId, task, attempts, currentModel, stateDir } = ctx;

	try {
		// Detect vagueness patterns
		const vaguePatterns: string[] = [];

		if (!task.includes("/") && !task.includes(".ts") && !task.includes(".js")) vaguePatterns.push("no-file-reference");
		if (task.split(" ").length < 5) vaguePatterns.push("too-short");
		if (/\b(improve|enhance|optimize|better)\b/i.test(task) && !/\b(by|using|with|in)\b/i.test(task))
			vaguePatterns.push("vague-verb-no-method");
		if (/\b(the|all|every|any)\s+(code|codebase|project)\b/i.test(task)) vaguePatterns.push("overly-broad-scope");

		addLearning(
			{
				taskId,
				category: "gotcha",
				keywords: ["no-changes", "vague-task", ...extractTaskKeywords(task), ...vaguePatterns],
				content:
					`Agent made no changes after ${attempts} attempts with ${currentModel}. ` +
					`Vagueness indicators: ${vaguePatterns.join(", ") || "none detected"}. ` +
					`Task may be: (1) too vague - add specific files/functions, ` +
					`(2) already complete - verify current state, ` +
					`(3) impossible - check if the described change is feasible.`,
			},
			stateDir,
		);

		logger.info({ taskId, attempts, model: currentModel, vaguePatterns }, "Recorded no-changes failure learning");
	} catch (err) {
		logger.warn({ err, taskId }, "Failed to record no-changes failure learning");
	}
}

/**
 * Extract keywords from task objective for learning correlation
 */
function extractTaskKeywords(task: string): string[] {
	const actionVerbs = [
		"add",
		"fix",
		"refactor",
		"update",
		"remove",
		"create",
		"implement",
		"modify",
		"migrate",
		"optimize",
		"improve",
		"test",
		"document",
	];

	const words = task.toLowerCase().split(/\s+/);
	const keywords: string[] = [];

	for (const word of words) {
		const cleaned = word.replace(/[^a-z]/g, "");
		if (cleaned.length > 2 && actionVerbs.includes(cleaned)) {
			keywords.push(cleaned);
		}
	}

	// Also extract potential file/module references
	const fileMatches = task.match(/[\w-]+\.(?:ts|js|json|md)/gi);
	if (fileMatches) {
		keywords.push(...fileMatches.map((f) => f.toLowerCase()));
	}

	return [...new Set(keywords)];
}
