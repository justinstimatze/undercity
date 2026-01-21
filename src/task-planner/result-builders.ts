/**
 * Task Planner Result Builders
 *
 * Pure functions for constructing TieredPlanResult objects.
 * Extracted for testability - no LLM calls, no side effects.
 */

import type { ExecutionPlan, PlanReview, TieredPlanResult } from "../task-planner.js";
import type { ModelTier } from "../types.js";

/**
 * Validation result for plan specificity check
 */
export interface PlanSpecificityResult {
	isSpecific: boolean;
	issues: string[];
}

/**
 * Non-specific plan patterns that indicate retry is needed
 */
const NON_SPECIFIC_STEP_PATTERNS = [
	/^execute the task/i,
	/^do the task/i,
	/^complete the task/i,
	/^implement as described/i,
	/^follow the instructions/i,
	/^proceed with/i,
];

/**
 * Check if a plan is too non-specific to execute.
 * Pure function - suitable for unit testing.
 *
 * @param plan - The execution plan to validate
 * @returns Validation result with specificity flag and issues list
 */
export function validatePlanSpecificity(plan: ExecutionPlan): PlanSpecificityResult {
	const issues: string[] = [];

	// Check for non-specific steps
	const hasNonSpecificSteps = plan.steps.some((step) =>
		NON_SPECIFIC_STEP_PATTERNS.some((pattern) => pattern.test(step)),
	);
	if (hasNonSpecificSteps) {
		issues.push("Plan contains non-specific steps like 'Execute the task as described'");
	}

	// Check for missing file targets (unless it's a research task)
	const isResearchTask =
		plan.objective.toLowerCase().includes("[research]") ||
		plan.objective.toLowerCase().includes("research") ||
		plan.objective.toLowerCase().includes("analyze") ||
		plan.objective.toLowerCase().includes("review");

	if (!isResearchTask && plan.filesToModify.length === 0 && plan.filesToCreate.length === 0) {
		issues.push("No files to modify or create - plan needs specific targets");
	}

	// Check for overly short steps
	const tooShortSteps = plan.steps.filter((s) => s.length < 15);
	if (tooShortSteps.length > plan.steps.length / 2) {
		issues.push("Most steps are too short to be actionable");
	}

	// Check for steps that are just file names
	const fileOnlySteps = plan.steps.filter((s) => /^\s*[\w/.-]+\.(ts|js|tsx|jsx|json|md)\s*$/i.test(s));
	if (fileOnlySteps.length > 0) {
		issues.push("Steps should describe actions, not just list files");
	}

	return {
		isSpecific: issues.length === 0,
		issues,
	};
}

/**
 * Determine if the planner model should be escalated based on plan quality.
 * Pure function - suitable for unit testing.
 *
 * @param specificity - Result of plan specificity validation
 * @param parsingFailed - Whether the plan JSON parsing failed
 * @returns Whether to escalate the planner model
 */
export function shouldEscalatePlanner(specificity: PlanSpecificityResult, parsingFailed: boolean): boolean {
	return !specificity.isSpecific || parsingFailed;
}

/**
 * Build result for "already complete" early exit.
 * Pure function - suitable for unit testing.
 *
 * @param plan - The execution plan indicating already complete
 * @param plannerModel - Model that created the plan
 * @param reviewerModel - Model that would review
 * @returns TieredPlanResult configured for skip
 */
export function buildAlreadyCompleteResult(
	plan: ExecutionPlan,
	plannerModel: ModelTier,
	reviewerModel: ModelTier,
): TieredPlanResult {
	return {
		success: true,
		plan,
		review: {
			approved: true,
			issues: [],
			suggestions: [],
			skipExecution: { skip: true, reason: plan.alreadyComplete?.reason },
		},
		plannerModel,
		reviewerModel,
		proceedWithExecution: false,
		skipReason: `Task already complete: ${plan.alreadyComplete?.reason}`,
	};
}

/**
 * Build result for "needs decomposition" early exit.
 * Pure function - suitable for unit testing.
 *
 * @param plan - The execution plan needing decomposition
 * @param subtasks - Suggested subtasks (may be empty)
 * @param plannerModel - Model that created the plan
 * @param reviewerModel - Model that would review
 * @param reason - Reason for decomposition (for skip message)
 * @returns TieredPlanResult configured for decomposition
 */
export function buildDecompositionResult(
	plan: ExecutionPlan,
	subtasks: string[],
	plannerModel: ModelTier,
	reviewerModel: ModelTier,
	reason = "Task needs decomposition into smaller subtasks",
): TieredPlanResult {
	return {
		success: true,
		plan: {
			...plan,
			needsDecomposition: {
				needed: true,
				suggestedSubtasks: subtasks,
			},
		},
		review: {
			approved: false,
			issues: ["Task requires decomposition"],
			suggestions: subtasks,
		},
		plannerModel,
		reviewerModel,
		proceedWithExecution: false,
		skipReason: reason,
	};
}

/**
 * Build the final result after review iterations complete.
 * Pure function - suitable for unit testing.
 *
 * @param currentPlan - The current (possibly revised) plan
 * @param review - The final review result
 * @param plannerModel - Model that created the plan
 * @param reviewerModel - Model that reviewed
 * @param iterations - Number of plan-review iterations
 * @returns Final TieredPlanResult
 */
export function buildFinalPlanResult(
	currentPlan: ExecutionPlan,
	review: PlanReview,
	plannerModel: ModelTier,
	reviewerModel: ModelTier,
	iterations: number,
): TieredPlanResult {
	// Apply any direct revisions from reviewer
	const finalPlan: ExecutionPlan = review.revisedPlan ? { ...currentPlan, ...review.revisedPlan } : currentPlan;

	const shouldSkip = review.skipExecution?.skip || false;
	const proceedWithExecution = review.approved && !shouldSkip;

	return {
		success: true,
		plan: finalPlan,
		review,
		plannerModel,
		reviewerModel,
		proceedWithExecution,
		skipReason: shouldSkip ? review.skipExecution?.reason : undefined,
		iterations,
	};
}

/**
 * Check if review loop should continue.
 * Pure function - suitable for unit testing.
 *
 * @param review - Current review result
 * @param iteration - Current iteration number
 * @param maxIterations - Maximum allowed iterations
 * @returns Object with continue flag and reason
 */
export function shouldContinueReviewLoop(
	review: PlanReview,
	iteration: number,
	maxIterations: number,
): { continue: boolean; reason?: string } {
	// If approved or should skip, we're done
	if (review.approved || review.skipExecution?.skip) {
		return { continue: false, reason: review.approved ? "approved" : "skip" };
	}

	// Not approved - check if we have feedback to act on
	const hasFeedback = review.issues.length > 0 || review.suggestions.length > 0;

	if (!hasFeedback) {
		// Rejected without feedback - can't improve
		return { continue: false, reason: "no_feedback" };
	}

	// Check if this is the last iteration
	if (iteration >= maxIterations) {
		return { continue: false, reason: "max_iterations" };
	}

	return { continue: true };
}

/**
 * Result of parsing a plan review response
 */
export type ParseReviewResult =
	| { success: true; review: PlanReview }
	| { success: false; reason: "empty" | "parse_failed" | "rejection_signal" };

/**
 * Parse a plan review response from LLM output.
 * Pure function - suitable for unit testing.
 *
 * Tries multiple parsing strategies in order:
 * 1. Extract JSON from markdown code block (```json ... ```)
 * 2. Extract JSON from generic code block (``` ... ```)
 * 3. Find JSON object anywhere in response
 * 4. Parse entire response as JSON
 *
 * @param response - Raw response string from LLM
 * @returns Parsed PlanReview or failure reason
 */
export function parsePlanReview(response: string): ParseReviewResult {
	// Handle empty response
	if (!response || response.trim() === "") {
		return { success: false, reason: "empty" };
	}

	// Define parsing strategies
	const parseAttempts: Array<() => PlanReview | null> = [
		// 1. Extract JSON from markdown code block
		() => {
			const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
			if (jsonMatch) {
				return JSON.parse(jsonMatch[1]) as PlanReview;
			}
			return null;
		},
		// 2. Extract JSON from generic code block
		() => {
			const codeMatch = response.match(/```\s*([\s\S]*?)\s*```/);
			if (codeMatch?.[1].trim().startsWith("{")) {
				return JSON.parse(codeMatch[1]) as PlanReview;
			}
			return null;
		},
		// 3. Find JSON object anywhere in response
		() => {
			const jsonObjMatch = response.match(/\{[\s\S]*"approved"[\s\S]*\}/);
			if (jsonObjMatch) {
				return JSON.parse(jsonObjMatch[0]) as PlanReview;
			}
			return null;
		},
		// 4. Parse entire response as JSON
		() => JSON.parse(response) as PlanReview,
	];

	// Try each parsing strategy
	for (const attempt of parseAttempts) {
		try {
			const result = attempt();
			if (result && typeof result.approved === "boolean") {
				return { success: true, review: result };
			}
		} catch {
			// Continue to next attempt
		}
	}

	// Check for rejection signals in unparseable response
	const lowerResponse = response.toLowerCase();
	if (
		lowerResponse.includes("reject") ||
		lowerResponse.includes("not approved") ||
		lowerResponse.includes("cannot approve")
	) {
		return { success: false, reason: "rejection_signal" };
	}

	return { success: false, reason: "parse_failed" };
}

/**
 * Build a default rejection review for parsing failures.
 * Pure function - suitable for unit testing.
 *
 * @param reason - The reason for rejection
 * @returns PlanReview configured as rejection
 */
export function buildParseFailureReview(reason: string): PlanReview {
	return {
		approved: false,
		issues: [reason],
		suggestions: [],
	};
}
