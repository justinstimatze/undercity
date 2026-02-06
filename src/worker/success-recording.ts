/**
 * Worker Success Recording Helpers
 *
 * Extracted learning/recording operations for successful task completion.
 */

import { recordPlanCreationOutcome, recordPlanReviewOutcome } from "../ax-programs.js";
import type { ComplexityAssessment } from "../complexity.js";
import type { ContextBriefing } from "../context.js";
import { updateDecisionOutcome } from "../decision-tracker.js";
import { markLearningsUsed } from "../knowledge.js";
import { extractAndStoreLearnings } from "../knowledge-extractor.js";
import { sessionLogger } from "../logger.js";
import * as output from "../output.js";
import { recordTaskFiles } from "../task-file-patterns.js";
import type { TieredPlanResult } from "../task-planner.js";

/**
 * Extract and store learnings from successful task.
 *
 * INVARIANT: agentOutput contains combined agent + review output for complete
 * learning extraction. Both execution insights and review feedback are captured.
 */
export async function recordKnowledgeLearnings(
	taskId: string,
	agentOutput: string,
	injectedLearningIds: string[],
	stateDir: string,
): Promise<void> {
	try {
		const extracted = await extractAndStoreLearnings(taskId, agentOutput, stateDir);
		if (extracted.length > 0) {
			output.debug(`Extracted ${extracted.length} learnings from task`, { taskId });
		}
		if (injectedLearningIds.length > 0) {
			markLearningsUsed(injectedLearningIds, true, stateDir);
			output.debug(`Marked ${injectedLearningIds.length} learnings as used (success)`, { taskId });
		}
	} catch (error) {
		sessionLogger.debug({ error: String(error) }, "Knowledge extraction failed");
	}
}

/**
 * Record successful task file patterns
 */
export function recordSuccessfulTaskPattern(taskId: string, task: string, modifiedFiles: string[]): void {
	if (modifiedFiles.length === 0) return;
	try {
		recordTaskFiles(taskId, task, modifiedFiles, true);
		output.debug(`Recorded task-file pattern: ${modifiedFiles.length} files`, { taskId });
	} catch {
		// Non-critical
	}
}

/**
 * Update decision outcomes to success
 */
export async function updateDecisionOutcomesToSuccess(taskId: string, stateDir: string): Promise<void> {
	try {
		const { loadDecisionStore } = await import("../decision-tracker.js");
		const store = loadDecisionStore(stateDir);
		const taskDecisions = store.resolved.filter((d) => d.taskId === taskId && d.resolution.outcome === undefined);
		for (const decision of taskDecisions) {
			updateDecisionOutcome(decision.id, "success", stateDir);
		}
		if (taskDecisions.length > 0) {
			output.debug(`Updated ${taskDecisions.length} decision outcomes to success`, { taskId });
		}
	} catch {
		// Non-critical
	}
}

/**
 * Context for recording plan success
 */
export interface PlanSuccessContext {
	task: string;
	taskId: string;
	executionPlan: TieredPlanResult | null | undefined;
	briefing: ContextBriefing | null | undefined;
	stateDir: string;
}

/**
 * Record plan outcomes for Ax learning (success case)
 */
export function recordPlanSuccess(ctx: PlanSuccessContext): void {
	const { task, taskId, executionPlan, briefing, stateDir } = ctx;

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
			true, // Task succeeded
			stateDir,
		);

		recordPlanReviewOutcome(
			{ task, plan: JSON.stringify(plan) },
			{
				approved: executionPlan.review.approved,
				issues: executionPlan.review.issues,
				suggestions: executionPlan.review.suggestions,
				skipExecution: executionPlan.review.skipExecution?.skip || false,
				reasoning: "",
			},
			true, // Review was accurate (task succeeded after approval)
			stateDir,
		);

		output.debug("Recorded plan outcomes for Ax learning", { taskId });
	} catch {
		// Non-critical
	}
}

/**
 * Record complexity assessment success for Ax learning
 */
export function recordComplexitySuccess(
	task: string,
	complexityAssessment: ComplexityAssessment | null | undefined,
	stateDir: string,
	recordComplexityOutcome: (
		task: string,
		assessment: { level: string; scope: string; reasoning: string; confidence: number },
		success: boolean,
		stateDir: string,
	) => void,
): void {
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
			true, // Task succeeded
			stateDir,
		);
	} catch {
		// Non-critical
	}
}
