/**
 * Worker Model Selection Logic
 *
 * Pure functions for determining which model tier to use for tasks.
 * Extracted from TaskWorker for testability.
 */

import type { ComplexityAssessment } from "../complexity.js";
import type { ModelTier } from "../types.js";

/**
 * Model tier order from least to most capable
 */
export const MODEL_TIERS: ModelTier[] = ["sonnet", "opus"];

/**
 * Cap a model tier at the configured maximum
 *
 * @param tier - The requested tier
 * @param maxTier - The maximum allowed tier
 * @returns The tier, capped at maxTier
 */
export function capAtMaxTier(tier: ModelTier, maxTier: ModelTier): ModelTier {
	const tierIndex = MODEL_TIERS.indexOf(tier);
	const maxTierIndex = MODEL_TIERS.indexOf(maxTier);
	return tierIndex > maxTierIndex ? maxTier : tier;
}

/**
 * Configuration for starting model determination
 */
export interface StartingModelConfig {
	/** User's configured starting model preference */
	startingModelOverride: ModelTier;
	/** Maximum tier allowed */
	maxTier: ModelTier;
	/** Whether this is a test-writing task */
	isTestTask: boolean;
}

/**
 * Determine starting model based on complexity assessment
 *
 * Special handling for test-writing tasks: Always use sonnet minimum.
 * Test tasks are inherently harder (need understanding of code + test patterns),
 * and failures are expensive (verification loops on the tests themselves).
 *
 * Respects maxTier cap - will not start at a tier higher than configured maximum.
 *
 * @param assessment - Complexity assessment of the task
 * @param config - Configuration for model selection
 * @returns The starting model tier
 */
export function determineStartingModel(assessment: ComplexityAssessment, config: StartingModelConfig): ModelTier {
	// Override with user preference if set (not default sonnet)
	if (config.startingModelOverride !== "sonnet") {
		return capAtMaxTier(config.startingModelOverride, config.maxTier);
	}

	// Test-writing tasks: minimum sonnet (skip haiku)
	// Test tasks have higher failure rates with haiku due to complexity
	if (config.isTestTask) {
		if (assessment.level === "trivial" || assessment.level === "simple") {
			return capAtMaxTier("sonnet", config.maxTier);
		}
	}

	// Use assessment to pick model, capped at maxTier
	// Note: We skip haiku entirely - sonnet requires less steering and has
	// higher first-attempt success rates, making it cheaper overall despite
	// higher per-token cost. Opus reserved for critical tasks only.
	switch (assessment.level) {
		case "trivial":
		case "simple":
		case "standard":
		case "complex":
			return capAtMaxTier("sonnet", config.maxTier);
		case "critical":
			return capAtMaxTier("opus", config.maxTier); // Critical tasks go straight to opus (capped at maxTier)
		default:
			return capAtMaxTier("sonnet", config.maxTier);
	}
}

/**
 * Configuration for review level determination
 */
export interface ReviewLevelConfig {
	/** Whether user explicitly enabled multi-lens review */
	multiLensAtOpus: boolean;
	/** Whether review passes are enabled */
	reviewPassesEnabled: boolean;
	/** Maximum tier allowed */
	maxTier: ModelTier;
}

/**
 * Result of review level determination
 */
export interface ReviewLevelResult {
	/** Whether to run review passes */
	review: boolean;
	/** Whether to use multi-lens review at opus */
	multiLens: boolean;
	/** Maximum tier for review escalation */
	maxReviewTier: ModelTier;
}

/**
 * Determine review level based on complexity assessment
 *
 * Review escalation is capped by task complexity to save opus tokens:
 * - trivial/simple/standard: haiku → sonnet only (no opus review)
 * - complex/critical: haiku → sonnet → opus (full escalation + multi-lens)
 *
 * Also respects maxTier cap - review tier will not exceed configured maximum.
 *
 * Rationale: 95% of tasks are trivial/simple/standard and don't benefit from
 * opus review. The token cost isn't justified when sonnet can catch most issues.
 *
 * @param assessment - Complexity assessment of the task
 * @param config - Configuration for review determination
 * @returns Review configuration
 */
export function determineReviewLevel(assessment: ComplexityAssessment, config: ReviewLevelConfig): ReviewLevelResult {
	// If user explicitly set multi-lens, respect it (full escalation, capped at maxTier)
	if (config.multiLensAtOpus) {
		const cappedTier = capAtMaxTier("opus", config.maxTier);
		// Disable multi-lens if we can't reach opus
		const canMultiLens = cappedTier === "opus";
		return { review: true, multiLens: canMultiLens, maxReviewTier: cappedTier };
	}

	// If user explicitly disabled reviews, respect that
	if (!config.reviewPassesEnabled) {
		return { review: false, multiLens: false, maxReviewTier: capAtMaxTier("sonnet", config.maxTier) };
	}

	// Reviews are enabled - determine escalation cap based on complexity
	// Note: Complex tasks now start on sonnet, so review should match
	switch (assessment.level) {
		case "trivial":
		case "simple":
		case "standard":
		case "complex":
			// Simple and complex tasks get capped review: haiku → sonnet only
			// Complex tasks execution was demoted from opus to sonnet, review follows
			return { review: true, multiLens: false, maxReviewTier: capAtMaxTier("sonnet", config.maxTier) };
		case "critical": {
			// Only critical tasks get opus review + multi-lens (capped at maxTier)
			const cappedTier = capAtMaxTier("opus", config.maxTier);
			const canMultiLens = cappedTier === "opus";
			return { review: true, multiLens: canMultiLens, maxReviewTier: cappedTier };
		}
		default:
			// Default to capped review
			return { review: true, multiLens: false, maxReviewTier: capAtMaxTier("sonnet", config.maxTier) };
	}
}

/**
 * Get the next model tier in escalation path
 *
 * @param currentTier - Current model tier
 * @param maxTier - Maximum allowed tier
 * @returns Next tier and whether escalation is possible
 */
export function getNextModelTier(
	currentTier: ModelTier,
	maxTier: ModelTier,
): { canEscalate: boolean; nextTier: ModelTier } {
	const currentIndex = MODEL_TIERS.indexOf(currentTier);
	const maxIndex = MODEL_TIERS.indexOf(maxTier);

	// Already at or past max tier
	if (currentIndex >= maxIndex) {
		return { canEscalate: false, nextTier: currentTier };
	}

	// Already at opus (absolute max)
	if (currentIndex >= MODEL_TIERS.length - 1) {
		return { canEscalate: false, nextTier: currentTier };
	}

	const nextTier = MODEL_TIERS[currentIndex + 1];
	return { canEscalate: true, nextTier };
}
